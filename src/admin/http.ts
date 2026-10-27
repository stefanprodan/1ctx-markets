// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// /api/v1/admin/*, behind the admin key alone and reachable from the
// internet wherever the server is: arguments are parsed strictly, bodies
// and lists are bounded, and errors are fixed phrases that echo nothing
// sent.

import { failed, json, readBody } from "../api/http.ts";
import type { Db } from "../db/index.ts";
import { type Instrument, readInstrument } from "../instruments.ts";
import { instrumentsOf } from "../rules/format.ts";
import { readRules } from "../rules/store.ts";
import type { Backoff } from "../source.ts";
import { iso } from "../tools/answer.ts";
import type { Markets } from "../tools/markets.ts";
import { trackedIds } from "../tracking.ts";
import {
  PARTS,
  type Part,
  RESEARCH_SECTIONS,
  type ResearchSection,
  refetch,
} from "./refetch.ts";

export const MAX_BODY_BYTES = 16 * 1024;
export const MAX_SYMBOLS = 20;
// an instrument key's characters: market, colon, the source's symbol
const KEY = /^[A-Za-z0-9.^=:_&-]{1,64}$/;

// every table whose rows belong to one instrument, by its instrument
// column; rules are refused instead, and alerts outlive their rules
export const INSTRUMENT_TABLES = [
  "bars",
  "splits",
  "quotes",
  "signals",
  "research",
  "events",
  "news",
  "news_walks",
] as const;

export type SourceState = {
  name: string;
  on: boolean;
  // why it is on or off: the key file, the flag, or always for Yahoo
  why: string;
  backoff(): Backoff | null;
};

export type AdminDeps = {
  m: Markets;
  version: string;
  sources: readonly SourceState[];
};

const bad = (message: string) => failed({ error: "bad_arguments", message });

class ArgError extends Error {}

type Row = {
  source: string;
  job: string;
  scope: string | null;
  startedAt: number;
  endedAt: number | null;
  status: string;
  rows: number;
  error: string | null;
};

// SQLite answers a max() query's other columns from the row holding it
function jobs(db: Db) {
  const last = db
    .query<Row, []>(
      `select source, job, scope, max(started_at) as startedAt,
         ended_at as endedAt, status, rows, error
       from sync_runs group by source, job order by source, job`,
    )
    .all();
  const failing = new Map(
    db
      .query<{ source: string; job: string; n: number }, []>(
        `select source, job, count(*) as n from (
           select source, job, status, max(started_at)
           from sync_runs where status <> 'running'
           group by source, job, scope)
         where status = 'failed' group by source, job`,
      )
      .all()
      .map((r) => [`${r.source}|${r.job}`, r.n]),
  );
  return last.map((r) => ({
    source: r.source,
    job: r.job,
    last: {
      scope: r.scope,
      started_at: iso(r.startedAt),
      ended_at: iso(r.endedAt),
      status: r.status,
      rows: r.rows,
      error: r.error,
    },
    // scopes whose latest ended run failed, which read as stale
    failing_scopes: failing.get(`${r.source}|${r.job}`) ?? 0,
  }));
}

const count = (db: Db, sql: string): number =>
  (db.query(sql).get() as { n: number }).n;

export function adminStatus(d: AdminDeps, url: URL): Response {
  if (url.search !== "") return bad("status takes no arguments");
  const { db, clock } = d.m;
  const now = clock.now();
  return json(
    {
      version: d.version,
      sources: d.sources.map((s) => {
        const b = s.on ? s.backoff() : null;
        return {
          name: s.name,
          state: s.on ? "on" : "off",
          why: s.why,
          backing_off:
            b === null ? null : { until: iso(b.until), after: b.after },
        };
      }),
      jobs: jobs(db),
      instruments: count(db, "select count(*) as n from instruments"),
      tracked: trackedIds(db, now, d.m.trackMs).size,
      database_bytes:
        count(db, "select page_count as n from pragma_page_count()") *
        count(db, "select page_size as n from pragma_page_size()"),
    },
    200,
  );
}

const keyOf = (value: unknown): string => {
  if (typeof value !== "string" || !KEY.test(value)) {
    throw new ArgError(
      "a symbol is a stored instrument id of at most 64 letters, digits and . ^ = : _ & -",
    );
  }
  return value.toUpperCase();
};

function list<T extends string>(
  value: unknown,
  known: readonly T[],
  name: string,
): T[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > known.length ||
    !value.every((v) => (known as readonly unknown[]).includes(v))
  ) {
    throw new ArgError(`${name} is a list of ${known.join(", ")}`);
  }
  // in the known order, each once
  return known.filter((k) => value.includes(k));
}

type RefetchArgs = {
  symbols: string[];
  parts: Part[];
  sections: ResearchSection[];
};

function parseRefetch(body: unknown): RefetchArgs {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new ArgError("the body is a JSON object");
  }
  const b = body as Record<string, unknown>;
  for (const k of Object.keys(b)) {
    if (!["symbols", "fetch", "sections"].includes(k)) {
      throw new ArgError("the body takes symbols, fetch and sections only");
    }
  }
  if (
    !Array.isArray(b.symbols) ||
    b.symbols.length === 0 ||
    b.symbols.length > MAX_SYMBOLS
  ) {
    throw new ArgError(`symbols is a list of 1 to ${MAX_SYMBOLS} ids`);
  }
  const symbols = [...new Set(b.symbols.map(keyOf))];
  const parts = list(b.fetch, PARTS, "fetch");
  let sections: ResearchSection[] = [...RESEARCH_SECTIONS];
  if (b.sections !== undefined) {
    if (!parts.includes("research")) {
      throw new ArgError("sections goes with research only");
    }
    sections = list(b.sections, RESEARCH_SECTIONS, "sections");
  }
  return { symbols, parts, sections };
}

export async function adminRefetch(
  d: AdminDeps,
  req: Request,
  url: URL,
): Promise<Response> {
  if (url.search !== "") return bad("refetch takes its arguments in the body");
  const read = await readBody(req, MAX_BODY_BYTES);
  if (read instanceof Response) return read;
  let args: RefetchArgs;
  try {
    args = parseRefetch(read.body);
  } catch (error) {
    if (error instanceof ArgError) return bad(error.message);
    throw error;
  }
  const found: Instrument[] = [];
  const missing: string[] = [];
  for (const id of args.symbols) {
    const i = readInstrument(d.m.db, id);
    if (i === null) missing.push(id);
    else found.push(i);
  }
  const results = await refetch(d.m, found, {
    parts: args.parts,
    sections: args.sections,
  });
  return json(
    {
      results: [
        ...missing.map((symbol) => ({ symbol, status: "not found" })),
        ...results,
      ],
    },
    200,
  );
}

// every row of one instrument in one write, never another's; a rule
// reading it holds it, as tracking does
export async function adminDelete(
  d: AdminDeps,
  url: URL,
  raw: string,
): Promise<Response> {
  if (url.search !== "") return bad("delete takes no arguments");
  let id: string;
  try {
    id = keyOf(decodeURIComponent(raw));
  } catch {
    return bad("the path ends with a stored instrument id");
  }
  const done = await d.m.writer.write((db) => {
    if (readInstrument(db, id) === null) return null;
    const rules = readRules(db)
      .filter((r) => r.instrument === id || instrumentsOf(r.condition).has(id))
      .map((r) => r.id);
    if (rules.length > 0) return { rules };
    const rows: Record<string, number> = {};
    for (const table of INSTRUMENT_TABLES) {
      rows[table] = db
        .query(`delete from ${table} where instrument = ?`)
        .run(id).changes;
    }
    // the instrument's own runs, so a key added again starts unfetched
    rows.sync_runs = db
      .query("delete from sync_runs where scope = ?")
      .run(id).changes;
    db.query("delete from instruments where id = ?").run(id);
    return { rows };
  });
  if (done === null) {
    return failed({ error: "not_found", message: "no such instrument" });
  }
  if ("rules" in done) {
    return failed({
      error: "conflict",
      message: "rules read this instrument; delete them first",
      rules: done.rules,
    });
  }
  return json({ deleted: id, rows: done.rows }, 200);
}
