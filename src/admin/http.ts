// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// May face the internet: strict input, errors echo nothing a source said.

import {
  json,
  NO_STORE,
  noQuery,
  pathSymbol,
  problem,
  problemOf,
  queryArgs,
  readBody,
} from "../api/http.ts";
import { iso } from "../market/format.ts";
import { readInstrument } from "../market/instruments.ts";
import { dashboardInstruments, trackedIds } from "../market/tracking.ts";
import { ArgError, fields } from "../operations/args.ts";
import { hasIntraday } from "../operations/intraday.ts";
import type { Markets } from "../operations/markets.ts";
import { parseQuote, quoteRows, sessionOf } from "../operations/quote.ts";
import { type ErrorItem, restStored } from "../operations/targets.ts";
import type { TrackState } from "../operations/track.ts";
import { portfolioHolds, portfolioInstruments } from "../portfolios/store.ts";
import { instrumentsOf } from "../rules/format.ts";
import { readRules, ruleInstruments } from "../rules/store.ts";
import { sourceFile } from "../runtime/keys.ts";
import { ATTRIBUTION } from "../sources/fred/sync.ts";
import { FRED, FUND_SOURCE, YAHOO } from "../sources/ids.ts";
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
  "intraday",
  "signals",
  "research",
  "events",
  "news",
  "news_walks",
  "filings",
  "edgar_filers",
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
  // false with --no-sync, so old runs read as paused, not broken
  sync: boolean;
};

// names for people, sent only to a signed-in page so the public bundle
// names no source
const SOURCE_LABELS: Record<string, string> = {
  yahoo: "Yahoo Finance",
  bvb: "Bucharest Stock Exchange",
  fred: "FRED",
  finnhub: "Finnhub",
  massive: "Massive",
  edgar: "SEC EDGAR",
};

const SOURCE_SHORT: Record<string, string> = {
  yahoo: "Yahoo",
  bvb: "BVB",
  fred: "FRED",
  finnhub: "Finnhub",
  massive: "Massive",
  edgar: "EDGAR",
};

// the price sources' own sites, for the instrument page's credit
const SOURCE_SITES: Record<string, string> = {
  yahoo: "https://finance.yahoo.com/",
  bvb: "https://www.bvb.ro/",
  fred: "https://fred.stlouisfed.org/",
};

// who the instrument's prices are from, named and linked on its page
const creditOf = (source: string) => {
  const url = SOURCE_SITES[source];
  return url === undefined ? null : { name: SOURCE_SHORT[source]!, url };
};

// letters in a tile, since no free logo set holds these sources
const SOURCE_MARKS: Record<string, string> = {
  yahoo: "Y",
  bvb: "BVB",
  fred: "FR",
  finnhub: "FH",
  massive: "M",
  edgar: "SEC",
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
  // no key to sign up for: the file holds a name and an email for SEC
  edgar: {
    adds: "SEC filings for US shares: results releases, late filings, restatements and new securities registered or offered.",
    signup:
      "https://www.sec.gov/search-filings/edgar-search-assistance/accessing-edgar-data",
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
  filings: "Filings",
  tickers: "SEC tickers",
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
  filings:
    "Refreshes each US share's SEC filings once a day, two hours after the US market closes.",
  tickers: "Refreshes SEC's list of tickers and company numbers once a week.",
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

export function status(d: AdminDeps, url: URL): Response {
  noQuery(url);
  const { db, clock } = d.m;
  const now = clock.now();
  return json({
    version: d.version,
    sync: d.sync,
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
    instruments: count(
      db,
      `select count(*) as n from instruments where source <> '${FUND_SOURCE}'`,
    ),
    tracked: trackedIds(db, now, d.m.tracking).size,
    database_bytes:
      count(db, "select page_count as n from pragma_page_count()") *
      count(db, "select page_size as n from pragma_page_size()"),
  });
}

export type Stored = {
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
  const q = queryArgs(url, {
    query: "text",
    page_size: "number",
    page_token: "text",
  });
  const query = q.query === undefined ? "" : String(q.query).trim();
  if (query.length > MAX_QUERY) {
    throw new ArgError(`query is at most ${MAX_QUERY} characters`);
  }
  let after: string | null = null;
  if (q.page_token !== undefined) {
    if (!KEY.test(String(q.page_token))) {
      throw new ArgError("page_token is a next_page_token answered before");
    }
    after = String(q.page_token).toUpperCase();
  }
  const size = (q.page_size as number | undefined) ?? DEFAULT_PAGE;
  if (!Number.isInteger(size) || size < 1 || size > MAX_PAGE) {
    throw new ArgError(`page_size is a whole number from 1 to ${MAX_PAGE}`);
  }
  return { query, after, size };
}

// by id, after the last one a page answered, so a delete never skips a row
export function instruments(m: Markets, url: URL): Response {
  const { query, after, size } = parseList(url);
  const { db, clock } = m;
  const now = clock.now();
  // a fund the owner prices is a holding, private to portfolio access
  const where =
    `i.source <> '${FUND_SOURCE}' and ` +
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
    .all(query, after ?? "", size + 1);
  const row = listRow(m, now);
  const page = rows.slice(0, size);
  return json({
    // FRED's terms, wherever a page shows one of its values
    ...(page.some((r) => r.source === FRED)
      ? { attribution: ATTRIBUTION }
      : {}),
    total,
    instruments: page.map(row),
    ...(rows.length > size ? { next_page_token: page.at(-1)!.id } : {}),
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

export const storedRow = (db: Db, id: string): Stored | null =>
  db.query<Stored, [string]>(`${STORED} where i.id = ?1`).get(id);

export const listRow = (m: Markets, now: number) => {
  const ruled = ruleInstruments(m.db);
  const faved = dashboardInstruments(m.db);
  // tracked, never named: a key without portfolio access reads this row
  const held = portfolioInstruments(m.db);
  return (r: Stored) => {
    const { tracking } = m;
    const read = r.readAt !== null && r.readAt > now - tracking.readMs;
    const by = [
      ...(ruled.has(r.id) ? ["rule"] : []),
      ...(faved.has(r.id) ? ["dashboard"] : []),
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
      tracked: by.length > 0 || held.has(r.id),
      tracked_by: by,
      read_at: iso(r.readAt),
      read_until: read ? iso(r.readAt! + tracking.readMs) : null,
      price: r.price,
      change: r.change,
      change_percent: r.changePercent,
      fetched_at: iso(r.fetchedAt),
    };
  };
};

// a read, as any client's: an unknown symbol is fetched
export async function instrument(m: Markets, url: URL, raw: string) {
  noQuery(url);
  const input = pathSymbol(raw);
  // pre or post trading beside the close, as a chart site shows it
  const { rows } = await quoteRows(
    m,
    parseQuote({ symbols: [input], extended: true }),
  );
  const item = rows[0]!.item as Record<string, unknown>;
  const failure = "error" in item ? (item as ErrorItem) : null;
  // only the row this input names, so a failure never shows another listing
  const id =
    failure === null
      ? (item.id as string)
      : failure.error === "candidates"
        ? null
        : (restStored(m.db, input, m.bvb !== null, false)?.id ?? null);
  const stored = id === null ? null : storedRow(m.db, id);
  if (stored === null) {
    return failure === null
      ? problem("not_found", "no such instrument", { input })
      : problemOf(failure);
  }
  return json({
    input,
    ...(stored.source === FRED ? { attribution: ATTRIBUTION } : {}),
    credit: creditOf(stored.source),
    instrument: listRow(m, m.clock.now())(stored),
    quote: failure === null ? item : null,
    error:
      failure === null
        ? null
        : { code: failure.error, detail: failure.message },
  });
}

// no read: a read stamp would keep a value dropped from the flag tracked
export function watchlist(
  m: Markets,
  track: () => readonly TrackState[],
  url: URL,
): Response {
  noQuery(url);
  const now = m.clock.now();
  const row = listRow(m, now);
  const entries = track().map((t) => ({
    t,
    stored: t.id === null ? null : storedRow(m.db, t.id),
    i: t.id === null ? null : readInstrument(m.db, t.id),
  }));
  return json({
    ...(entries.some((e) => e.stored?.source === FRED)
      ? { attribution: ATTRIBUTION }
      : {}),
    entries: entries.map(({ t, stored, i }) => ({
      value: t.value,
      id: t.id,
      state: t.state,
      instrument: stored === null ? null : row(stored),
      session: i === null ? null : sessionOf(m, i, now),
      intraday: stored !== null && hasIntraday(stored),
    })),
  });
}

// a stored instrument only, so nothing is resolved, fetched or added
function storedOf(m: Markets, raw: string) {
  const input = pathSymbol(raw);
  if (!KEY.test(input)) {
    throw new ArgError(
      "the path names a symbol or id of at most 64 letters, digits and . ^ = : _ & -",
    );
  }
  return {
    input,
    instrument: restStored(m.db, input, m.bvb !== null, true),
  };
}

const noInstrument = (input: string) =>
  problem("not_found", "no such instrument", { input });

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

type RefetchArgs = { parts: Part[]; sections: ResearchSection[] };

function parseRefetch(body: unknown): RefetchArgs {
  const b = fields(body, ["parts", "sections"]);
  const parts = list(b.parts, PARTS, "parts");
  let sections: ResearchSection[] = [...RESEARCH_SECTIONS];
  if (b.sections !== undefined) {
    if (!parts.includes("research")) {
      throw new ArgError("sections goes with research only");
    }
    sections = list(b.sections, RESEARCH_SECTIONS, "sections");
  }
  return { parts, sections };
}

export async function refetchOne(
  d: AdminDeps,
  req: Request,
  url: URL,
  raw: string,
): Promise<Response> {
  noQuery(url);
  const { input, instrument } = storedOf(d.m, raw);
  const read = await readBody(req, MAX_BODY_BYTES);
  if (read instanceof Response) return read;
  const args = parseRefetch(read.body);
  if (instrument === null) return noInstrument(input);
  const results = await refetch(d.m, [instrument], args);
  return json({
    input,
    id: instrument.id,
    parts: results.map(({ symbol: _, ...r }) => r),
  });
}

// every row of one instrument in one write, never another's; a rule
// reading it holds it, as tracking does
export async function deleteOne(
  d: AdminDeps,
  url: URL,
  raw: string,
): Promise<Response> {
  noQuery(url);
  const { input, instrument } = storedOf(d.m, raw);
  if (instrument === null) return noInstrument(input);
  const id = instrument.id;
  const done = await d.m.writer.write((db) => {
    if (readInstrument(db, id) === null) return null;
    const rules = readRules(db)
      .filter((r) => r.instrument === id || instrumentsOf(r.condition).has(id))
      .map((r) => r.id);
    if (rules.length > 0) return { rules };
    if (portfolioHolds(db, id)) return { held: true as const };
    // a tab still holding the card reloads at its next save
    db.query(
      `update dashboards set revision = revision + 1, updated_at = ?1
       where owner in (select owner from dashboard_items where instrument = ?2)`,
    ).run(d.m.clock.now(), id);
    for (const table of INSTRUMENT_TABLES) {
      db.query(`delete from ${table} where instrument = ?`).run(id);
    }
    // the instrument's own runs, so a key added again starts unfetched
    db.query("delete from sync_runs where scope = ?").run(id);
    db.query("delete from instruments where id = ?").run(id);
    return { rules: [] };
  });
  if (done === null) return noInstrument(input);
  if ("held" in done) {
    return problem(
      "conflict",
      "a portfolio's trades or positions name this instrument",
      { input, rules: [] },
    );
  }
  if (done.rules.length > 0) {
    return problem(
      "conflict",
      "rules read this instrument; delete them first",
      { input, rules: done.rules },
    );
  }
  return new Response(null, { status: 204, headers: NO_STORE });
}
