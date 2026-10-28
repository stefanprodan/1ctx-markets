// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// May face the internet: admin key only, strict input, errors echo nothing.

import { failed, json, queryArgs, readBody } from "../api/http.ts";
import { iso } from "../market/format.ts";
import { type Instrument, readInstrument } from "../market/instruments.ts";
import { trackedIds } from "../market/tracking.ts";
import { ArgError as QueryError } from "../operations/args.ts";
import type { Markets } from "../operations/markets.ts";
import { parseQuote, quoteRows } from "../operations/quote.ts";
import type { TrackState } from "../operations/track.ts";
import { instrumentsOf } from "../rules/format.ts";
import { readRules, ruleInstruments } from "../rules/store.ts";
import { sourceFile } from "../runtime/keys.ts";
import { YAHOO } from "../sources/ids.ts";
import type { Backoff } from "../sources/source.ts";
import { BACKFILL_JOB } from "../sources/yahoo/jobs.ts";
import type { Db } from "../storage/db/index.ts";
import { failedRun, type Run } from "../storage/runs.ts";
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

// names for people, sent only to a signed-in page so the public bundle
// names no source
const SOURCE_LABELS: Record<string, string> = {
  yahoo: "Yahoo Finance",
  bvb: "Bucharest Stock Exchange",
  fred: "FRED",
  finnhub: "Finnhub",
  massive: "Massive",
};

const SOURCE_SHORT: Record<string, string> = {
  yahoo: "Yahoo",
  bvb: "BVB",
  fred: "FRED",
  finnhub: "Finnhub",
  massive: "Massive",
};

// letters in a tile, since no free logo set holds these sources
const SOURCE_MARKS: Record<string, string> = {
  yahoo: "Y",
  bvb: "BVB",
  fred: "FR",
  finnhub: "FH",
  massive: "M",
};

// how an operator turns on a source that needs a key
const SOURCE_KEYS: Record<string, { adds: string; signup: string }> = {
  fred: {
    adds: "Treasury yields, credit spreads, oil and other daily economic series.",
    signup: "https://fred.stlouisfed.org/docs/api/api_key.html",
  },
  finnhub: {
    adds: "Key figures, analyst ratings, earnings and insider trades for US shares.",
    signup: "https://finnhub.io/register",
  },
  massive: {
    adds: "News for US shares and ETFs.",
    signup: "https://massive.com/dashboard/signup?redirect=%2Fdashboard%2Fkeys",
  },
};

const JOB_LABELS: Record<string, string> = {
  quotes: "Live prices",
  bars: "Daily prices",
  "fred/bars": "Daily series",
  backfill: "History",
  check: "Market hours",
  owed: "Missing closes",
  metric: "Key figures",
  analysts: "Analyst ratings",
  earnings: "Earnings",
  insider: "Insider trades",
  calendar: "Next earnings",
  "market-calendar": "Earnings calendar",
  news: "News",
  switch: "Source change",
};

const JOB_ABOUT: Record<string, string> = {
  quotes: "Quotes each open market, every 5 minutes by default.",
  bars: "Fetches the last 30 days of daily prices for each market once its next session has started, and an instrument's whole history after a split or rescale.",
  "fred/bars": "Fetches each series' daily values once a day, after 23:00 UTC.",
  backfill:
    "Fetches ten years of daily prices for a tracked instrument that has none.",
  check:
    "Asks whether a closed market has opened, at its usual opening time and hourly after.",
  owed: "Marks a finished day whose close the source had not sent yet, for Daily prices to ask again.",
  metric: "Refreshes each US share's key figures once a day, after 23:00 UTC.",
  analysts:
    "Refreshes each US share's analyst ratings once a day, after 23:00 UTC.",
  earnings:
    "Refreshes each US share's earnings results once a day, after 23:00 UTC, and when it reports.",
  insider:
    "Refreshes each US share's insider trades once a day, after 23:00 UTC.",
  calendar:
    "Refreshes each US share's next earnings date once a day, after 23:00 UTC.",
  "market-calendar":
    "Checks the US earnings calendar hourly while a tracked share reports today or yesterday.",
  news: "Fetches news for each tracked US share and ETF every 30 minutes.",
  switch:
    "Moves a market's instruments to another source when the start options change.",
};

export const jobAbout = (source: string, job: string): string | null =>
  JOB_ABOUT[`${source}/${job}`] ?? JOB_ABOUT[job] ?? null;

export function jobLabel(source: string, job: string): string {
  const known = JOB_LABELS[`${source}/${job}`] ?? JOB_LABELS[job];
  if (known !== undefined) return known;
  const words = job.replaceAll(/[-_]/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

// a page shows a few; the count says how many more
export const MAX_FAILING = 5;

type Failed = {
  scope: string | null;
  error: string | null;
  endedAt: number | null;
};

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
  // each scope's latest ended run, over the runs kept
  type Counts = {
    instruments: number;
    markets: number;
    failing_instruments: number;
    failing_markets: number;
  };
  const scopes = new Map<string, Counts>();
  const failing = new Map<string, Failed[]>();
  const hasBars = db.query<{ n: number }, [string]>(
    "select 1 as n from bars where instrument = ? and interval = '1d' limit 1",
  );
  for (const r of db
    .query<Failed & { source: string; job: string; status: Run["status"] }, []>(
      `select source, job, scope, status, error,
         ended_at as endedAt, max(started_at)
       from sync_runs where status <> 'running'
       group by source, job, scope
       order by source, job, endedAt desc`,
    )
    .all()) {
    // a run from before backfill runs had a scope names nothing
    if (r.scope === null) continue;
    // a read fetches a history without a backfill run, which settles it
    const settled =
      r.status === "failed" &&
      r.source === YAHOO &&
      r.job === BACKFILL_JOB &&
      hasBars.get(r.scope) !== null;
    const key = `${r.source}|${r.job}`;
    const n = scopes.get(key) ?? {
      instruments: 0,
      markets: 0,
      failing_instruments: 0,
      failing_markets: 0,
    };
    const instrument = r.scope.includes(":");
    if (instrument) n.instruments++;
    else n.markets++;
    scopes.set(key, n);
    if (!failedRun(r) || settled) continue;
    if (instrument) n.failing_instruments++;
    else n.failing_markets++;
    const list = failing.get(key) ?? [];
    list.push(r);
    failing.set(key, list);
  }
  return last.map((r) => ({
    source: r.source,
    job: r.job,
    label: jobLabel(r.source, r.job),
    about: jobAbout(r.source, r.job),
    last: {
      scope: r.scope,
      started_at: iso(r.startedAt),
      ended_at: iso(r.endedAt),
      status: r.status,
      rows: r.rows,
      error: r.error,
    },
    // a bars job runs per market and per instrument: the page counts each
    ...(scopes.get(`${r.source}|${r.job}`) ?? {
      instruments: 0,
      markets: 0,
      failing_instruments: 0,
      failing_markets: 0,
    }),
    // scopes whose latest ended run failed, which read as stale
    failing_scopes: (failing.get(`${r.source}|${r.job}`) ?? []).length,
    failing: (failing.get(`${r.source}|${r.job}`) ?? [])
      .slice(0, MAX_FAILING)
      .map((x) => ({ scope: x.scope, error: x.error, at: iso(x.endedAt) })),
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
          label: SOURCE_LABELS[s.name] ?? s.name,
          short: SOURCE_SHORT[s.name] ?? s.name,
          mark: SOURCE_MARKS[s.name] ?? s.name.slice(0, 2).toUpperCase(),
          key:
            s.name in SOURCE_KEYS
              ? {
                  file: `secrets/${sourceFile(s.name)}`,
                  ...SOURCE_KEYS[s.name],
                }
              : null,
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
  price: number | null;
  change: number | null;
  changePercent: number | null;
  fetchedAt: number | null;
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
  const { db, clock } = d.m;
  const now = clock.now();
  const where =
    "(?1 = '' or instr(lower(i.id), lower(?1)) > 0 or instr(lower(coalesce(i.name, '')), lower(?1)) > 0)";
  const total = (
    db
      .query<{ n: number }, [string]>(
        `select count(*) as n from instruments i where ${where}`,
      )
      .get(query) as { n: number }
  ).n;
  const rows = db
    .query<Stored, [string, string, number]>(
      `${STORED} where ${where} and i.id > ?2 order by i.id limit ?3`,
    )
    .all(query, after ?? "", limit + 1);
  const row = listRow(d.m, ruleInstruments(db), now);
  return json({
    total,
    more: rows.length > limit,
    instruments: rows.slice(0, limit).map(row),
  });
}

// the stored quote, else the newest daily close (a FRED series has no
// quote): a list is no read, so it never fetches
const STORED = `select i.id, i.name, i.market, i.exchange, i.currency,
    i.type, i.unit, i.source, i.last_read_at as readAt,
    coalesce(q.price, b.close) as price,
    q.change, q.change_percent as changePercent,
    coalesce(q.fetched_at, b.fetched_at) as fetchedAt
  from instruments i
  left join quotes q on q.instrument = i.id
  left join bars b on b.instrument = i.id and b.interval = '1d'
    and b.date = (select max(date) from bars
      where instrument = i.id and interval = '1d')`;

const listRow =
  (m: Markets, ruled: ReadonlySet<string>, now: number) => (r: Stored) => {
    const { tracking } = m;
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
      price: r.price,
      change: r.change,
      change_percent: r.changePercent,
      fetched_at: iso(r.fetchedAt),
    };
  };

// one stored instrument and its quote as the tools give it, returns and
// session included: opening it is a read, so it fetches when due and
// keeps it tracked, as any client's read does
export async function adminInstrument(
  d: AdminDeps,
  url: URL,
  raw: string,
): Promise<Response> {
  if (url.search !== "") return bad("an instrument takes no arguments");
  let id: string;
  try {
    id = keyOf(decodeURIComponent(raw));
  } catch {
    return bad("the path ends with a stored instrument id");
  }
  if (readInstrument(d.m.db, id) === null) {
    return failed({ error: "not_found", message: "no such instrument" });
  }
  const { rows } = await quoteRows(d.m, parseQuote({ symbols: [id] }));
  const now = d.m.clock.now();
  const stored = d.m.db
    .query<Stored, [string]>(`${STORED} where i.id = ?1`)
    .get(id);
  // deleted while the quote was read
  if (stored === null) {
    return failed({ error: "not_found", message: "no such instrument" });
  }
  return json({
    instrument: listRow(d.m, ruleInstruments(d.m.db), now)(stored),
    quote: rows[0]!.item,
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
