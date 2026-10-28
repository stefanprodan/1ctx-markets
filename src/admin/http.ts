// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// May face the internet: admin key only, strict input, errors echo nothing.

import { failed, json, queryArgs, readBody } from "../api/http.ts";
import { iso } from "../market/format.ts";
import { type Instrument, readInstrument } from "../market/instruments.ts";
import { trackedIds } from "../market/tracking.ts";
import { ArgError as QueryError } from "../operations/args.ts";
import type { Markets } from "../operations/markets.ts";
import type { TrackState } from "../operations/track.ts";
import { instrumentsOf } from "../rules/format.ts";
import { readRules, ruleInstruments } from "../rules/store.ts";
import type { Backoff } from "../sources/source.ts";
import type { Db } from "../storage/db/index.ts";
import {
  PARTS,
  type Part,
  RESEARCH_SECTIONS,
  type ResearchSection,
  refetch,
} from "./refetch.ts";

export const MAX_BODY_BYTES = 16 * 1024;
export const MAX_SYMBOLS = 20;
// a page of the stored list: a screen of rows, quoted a page at a time
export const DEFAULT_PAGE = 50;
export const MAX_PAGE = 200;
const MAX_QUERY = 64;
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
  // each --track value and what it resolved to
  track: () => readonly TrackState[];
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
      tracked: trackedIds(db, now, d.m.tracking).size,
      track: d.track(),
      database_bytes:
        count(db, "select page_count as n from pragma_page_count()") *
        count(db, "select page_size as n from pragma_page_size()"),
    },
    200,
  );
}

type Stored = {
  id: string;
  name: string | null;
  market: string;
  exchange: string;
  currency: string | null;
  type: string;
  unit: string;
  source: string;
  readAt: number | null;
};

function parseList(url: URL) {
  const q = queryArgs(url, { query: "text", after: "text", limit: "number" });
  const query = q.query === undefined ? "" : String(q.query).trim();
  if (query.length > MAX_QUERY) {
    throw new QueryError(`query is at most ${MAX_QUERY} characters`);
  }
  let after: string | null = null;
  if (q.after !== undefined) {
    if (!KEY.test(String(q.after))) {
      throw new QueryError("after is a stored instrument id");
    }
    after = String(q.after).toUpperCase();
  }
  const limit = (q.limit as number | undefined) ?? DEFAULT_PAGE;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE) {
    throw new QueryError(`limit is a whole number from 1 to ${MAX_PAGE}`);
  }
  return { query, after, limit };
}

// by id, after the last one a page answered, so a delete never skips a row
export function adminInstruments(d: AdminDeps, url: URL): Response {
  const { query, after, limit } = parseList(url);
  const { db, clock, tracking } = d.m;
  const now = clock.now();
  const where =
    "(?1 = '' or instr(lower(id), lower(?1)) > 0 or instr(lower(coalesce(name, '')), lower(?1)) > 0)";
  const total = (
    db
      .query<{ n: number }, [string]>(
        `select count(*) as n from instruments where ${where}`,
      )
      .get(query) as { n: number }
  ).n;
  const rows = db
    .query<Stored, [string, string, number]>(
      `select id, name, market, exchange, currency, type, unit, source,
         last_read_at as readAt
       from instruments where ${where} and id > ?2 order by id limit ?3`,
    )
    .all(query, after ?? "", limit + 1);
  const ruled = ruleInstruments(db);
  const page = rows.slice(0, limit);
  return json({
    total,
    more: rows.length > limit,
    instruments: page.map((r) => {
      const read = r.readAt !== null && r.readAt > now - tracking.readMs;
      const by = [
        ...(ruled.has(r.id) ? ["rule"] : []),
        ...(read ? ["read"] : []),
        ...(tracking.flagged.has(r.id) ? ["track"] : []),
      ];
      return {
        id: r.id,
        name: r.name,
        market: r.market,
        exchange: r.exchange,
        currency: r.currency,
        kind: r.type,
        unit: r.unit,
        source: r.source,
        tracked: by.length > 0,
        tracked_by: by,
        read_at: iso(r.readAt),
        read_until: read ? iso(r.readAt! + tracking.readMs) : null,
      };
    }),
  });
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
