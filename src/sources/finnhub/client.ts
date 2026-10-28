// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// the key only in a header; a 403 or empty answer is no data, not an error

import { wallOfDate } from "../../market/zone.ts";
import type { Clock } from "../../runtime/clock.ts";
import { FINNHUB } from "../ids.ts";
import {
  type Backoff,
  type Fetch,
  limiter,
  type RunOptions,
  SourceError,
  Unreadable,
} from "../source.ts";

export const SOURCE = FINNHUB;
export const HOST = "https://finnhub.io/api/v1";
// the free key allows 60 a minute; one start every 1.1 s stays under it
export const SPACING_MS = 1_100;
const TIMEOUT_MS = 30_000;

// one per kept metric column, from Finnhub's own field names
export const METRIC_FIELDS = {
  forwardPE: "forwardPE",
  forwardPEG: "forwardPEG",
  peTTM: "peTTM",
  psTTM: "psTTM",
  pb: "pb",
  epsGrowthTTMYoy: "epsGrowthTTMYoy",
  revenueGrowthTTMYoy: "revenueGrowthTTMYoy",
  netMarginTTM: "netProfitMarginTTM",
  roeTTM: "roeTTM",
  currentRatioQuarterly: "currentRatioQuarterly",
  debtToEquityQuarterly: "totalDebt/totalEquityQuarterly",
  dividendYieldTTM: "currentDividendYieldTTM",
  beta: "beta",
} as const;

export type Metric = {
  -readonly [K in keyof typeof METRIC_FIELDS]: number | null;
};

export type Analysts = {
  period: string;
  strongBuy: number;
  buy: number;
  hold: number;
  sell: number;
  strongSell: number;
};

export type Earnings = {
  period: string;
  estimate: number | null;
  actual: number | null;
  surprise: number | null;
  surprisePercent: number | null;
};

export type Insider = {
  // the month's first day
  period: string;
  change: number;
  mspr: number;
};

export type CalendarEvent = {
  fiscalYear: number;
  fiscalQuarter: number;
  date: string;
  // amc, bmo, dmh or empty
  hour: string;
  epsEstimate: number | null;
  epsActual: number | null;
  revenueEstimate: number | null;
  revenueActual: number | null;
  // an actual was answered, kept or not
  reported: boolean;
};

// null is no data: a 403, or an answer with nothing in it; listing is
// the other listing that answered, null for the asked symbol's own
export type Parsed<T> = { data: T | null; listing: string | null };
export type Answer<T> = Parsed<T> & { fetchedAt: number };

export type Finnhub = {
  metric(symbol: string): Promise<Answer<Metric>>;
  analysts(symbol: string): Promise<Answer<Analysts[]>>;
  earnings(symbol: string): Promise<Answer<Earnings[]>>;
  insider(symbol: string, from: string, to: string): Promise<Answer<Insider[]>>;
  calendar(
    symbol: string,
    from: string,
    to: string,
  ): Promise<Answer<CalendarEvent[]>>;
  // every US listing reporting in the range, by symbol
  marketCalendar(
    from: string,
    to: string,
  ): Promise<Answer<Map<string, CalendarEvent[]>>>;
  // fails at once while the queue backs off, for a tool
  failFast(): Finnhub;
  // failing fast, and starting no call once live() is false
  within(live: () => boolean): Finnhub;
  // at shutdown: fails waiting calls, so none goes out after
  close(): void;
  // when the next waiting call may go, for a test stepping its clock
  due(): number | null;
  backoff(): Backoff | null;
};

export type FinnhubOptions = {
  clock: Clock;
  key: string;
  fetch?: Fetch;
  host?: string;
};

const malformed = (detail: string) =>
  new SourceError("malformed answer", detail);

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function obj(v: unknown, what: string): Obj {
  if (!isObj(v)) throw malformed(`no ${what}`);
  return v;
}

function list(v: unknown, what: string): unknown[] {
  if (!Array.isArray(v)) throw malformed(`no ${what}`);
  return v;
}

function num(v: unknown, what: string): number {
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw malformed(`no ${what}`);
  }
  return v;
}

function optionalNum(v: unknown, what: string): number | null {
  return v === null || v === undefined ? null : num(v, what);
}

function count(v: unknown, what: string): number {
  const n = num(v, what);
  if (!Number.isSafeInteger(n) || n < 0) throw malformed(`no ${what}`);
  return n;
}

function day(v: unknown, what: string): string {
  if (typeof v === "string") {
    try {
      wallOfDate(v);
      return v;
    } catch {}
  }
  throw malformed(`no ${what}`);
}

const LISTING = /^[A-Za-z0-9.-]{1,20}$/;

// the fields of a company, the same whichever listing answers
export const COMPANY_METRICS = [
  "epsGrowthTTMYoy",
  "revenueGrowthTTMYoy",
  "netMarginTTM",
  "roeTTM",
  "currentRatioQuarterly",
  "debtToEquityQuarterly",
] as const satisfies readonly (keyof Metric)[];

// an ADR answers as its home listing (TSM as 2330.TW, EPS in TWD): a part
// naming one other symbol is that listing, two is no data, none is the asked
function listingOf(parts: readonly Obj[], symbol: string): string | null {
  const named = new Set(
    parts.map((p) => (p.symbol === undefined ? symbol : p.symbol)),
  );
  for (const n of named) {
    if (n !== symbol && (typeof n !== "string" || !LISTING.test(n))) {
      throw malformed("no listing");
    }
  }
  if (named.size > 1) throw new Mixed();
  const [only] = named;
  return only === undefined || only === symbol ? null : (only as string);
}

class Mixed extends Error {}

const NONE = { data: null, listing: null };

function parsed<T>(parse: () => Parsed<T>): Parsed<T> {
  try {
    return parse();
  } catch (error) {
    if (error instanceof Mixed) return NONE;
    throw error;
  }
}

// a key answered twice with the same values is one row (NVDA's quarter under
// two fiscal labels); with other values it is refused, as either may be wrong
export function collapse<T>(rows: readonly T[], key: (row: T) => string): T[] {
  const byKey = new Map<string, { row: T; json: string }>();
  for (const row of rows) {
    const k = key(row);
    const json = JSON.stringify(row);
    const seen = byKey.get(k);
    if (seen === undefined) byKey.set(k, { row, json });
    else if (seen.json !== json) throw malformed(`${k} answered twice`);
  }
  return [...byKey.values()].map((v) => v.row);
}

export const parseMetric = (body: unknown, symbol: string): Parsed<Metric> =>
  parsed(() => metricOf(body, symbol));

function metricOf(body: unknown, symbol: string): Parsed<Metric> {
  const b = obj(body, "body");
  const listing = listingOf([b], symbol);
  const m = obj(b.metric, "metric");
  const kept: readonly string[] =
    listing === null ? Object.keys(METRIC_FIELDS) : COMPANY_METRICS;
  const out = {} as Metric;
  let any = false;
  for (const [column, field] of Object.entries(METRIC_FIELDS)) {
    const v = kept.includes(column) ? optionalNum(m[field], field) : null;
    out[column as keyof Metric] = v;
    if (v !== null) any = true;
  }
  // TLV.RO's answer holds price fields only: nothing this server keeps
  return { data: any ? out : null, listing };
}

export const parseAnalysts = (
  body: unknown,
  symbol: string,
): Parsed<Analysts[]> => parsed(() => analystsOf(body, symbol));

// counts of analysts hold for every listing
function analystsOf(body: unknown, symbol: string): Parsed<Analysts[]> {
  const entries = list(body, "recommendations").map((entry) =>
    obj(entry, "recommendation"),
  );
  const listing = listingOf(entries, symbol);
  const rows = entries.map((r): Analysts => {
    return {
      period: day(r.period, "period"),
      strongBuy: count(r.strongBuy, "strongBuy"),
      buy: count(r.buy, "buy"),
      hold: count(r.hold, "hold"),
      sell: count(r.sell, "sell"),
      strongSell: count(r.strongSell, "strongSell"),
    };
  });
  return {
    data: rows.length === 0 ? null : collapse(rows, (r) => r.period),
    listing,
  };
}

export const parseEarnings = (
  body: unknown,
  symbol: string,
): Parsed<Earnings[]> => parsed(() => earningsOf(body, symbol));

// Another listing's EPS is in its currency per its share, and its rows
// can disagree with each other: nothing of it is kept.
function earningsOf(body: unknown, symbol: string): Parsed<Earnings[]> {
  const entries = list(body, "earnings").map((entry) =>
    obj(entry, "earnings row"),
  );
  const listing = listingOf(entries, symbol);
  if (listing !== null) return { data: null, listing };
  const rows = entries.map((r): Earnings => {
    // the fiscal labels are not kept: they disagree for one period
    return {
      period: day(r.period, "period"),
      estimate: optionalNum(r.estimate, "estimate"),
      actual: optionalNum(r.actual, "actual"),
      surprise: optionalNum(r.surprise, "surprise"),
      surprisePercent: optionalNum(r.surprisePercent, "surprisePercent"),
    };
  });
  return {
    data: rows.length === 0 ? null : collapse(rows, (r) => r.period),
    listing,
  };
}

export const parseInsider = (
  body: unknown,
  symbol: string,
): Parsed<Insider[]> => parsed(() => insiderOf(body, symbol));

// another listing's share counts are of its shares: nothing is kept
function insiderOf(body: unknown, symbol: string): Parsed<Insider[]> {
  const b = obj(body, "body");
  const entries = list(b.data, "insider data").map((entry) =>
    obj(entry, "insider month"),
  );
  const listing = listingOf([b, ...entries], symbol);
  if (listing !== null) return { data: null, listing };
  const rows = entries.map((r): Insider => {
    const year = count(r.year, "year");
    const month = count(r.month, "month");
    if (month < 1 || month > 12) throw malformed("no month");
    return {
      period: day(
        `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-01`,
        "year",
      ),
      change: num(r.change, "change"),
      mspr: num(r.mspr, "mspr"),
    };
  });
  return {
    data: rows.length === 0 ? null : collapse(rows, (r) => r.period),
    listing,
  };
}

const HOUR = /^[a-z]{0,8}$/;

export const parseCalendar = (
  body: unknown,
  symbol: string,
): Parsed<CalendarEvent[]> => parsed(() => calendarOf(body, symbol));

// Another listing's dates are the company's; its estimates and actuals
// are in its currency per its share, so only whether actuals came is kept.
function calendarOf(body: unknown, symbol: string): Parsed<CalendarEvent[]> {
  const b = obj(body, "body");
  const entries = calendarEntries(b);
  const listing = listingOf(entries, symbol);
  const own = listing === null;
  const rows = entries.map((r) => calendarRow(r, own));
  return {
    data: rows.length === 0 ? null : collapseQuarters(rows),
    listing,
  };
}

function calendarEntries(b: Obj): Obj[] {
  return list(b.earningsCalendar, "earnings calendar").map((entry) => {
    const r = obj(entry, "calendar row");
    // a calendar row always names its symbol
    if (r.symbol === undefined) throw malformed("no symbol");
    return r;
  });
}

const collapseQuarters = (rows: readonly CalendarEvent[]) =>
  collapse(rows, (r) => `${r.fiscalYear} Q${r.fiscalQuarter}`);

function calendarRow(r: Obj, own: boolean): CalendarEvent {
  const quarter = count(r.quarter, "quarter");
  if (quarter < 1 || quarter > 4) throw malformed("no quarter");
  const hour = r.hour ?? "";
  if (typeof hour !== "string" || !HOUR.test(hour)) {
    throw malformed("no hour");
  }
  const epsActual = optionalNum(r.epsActual, "epsActual");
  const revenueActual = optionalNum(r.revenueActual, "revenueActual");
  return {
    fiscalYear: count(r.year, "year"),
    fiscalQuarter: quarter,
    date: day(r.date, "date"),
    hour,
    epsEstimate: own ? optionalNum(r.epsEstimate, "epsEstimate") : null,
    epsActual: own ? epsActual : null,
    revenueEstimate: own
      ? optionalNum(r.revenueEstimate, "revenueEstimate")
      : null,
    revenueActual: own ? revenueActual : null,
    reported: epsActual !== null || revenueActual !== null,
  };
}

export const parseMarketCalendar = (
  body: unknown,
): Parsed<Map<string, CalendarEvent[]>> => {
  const entries = calendarEntries(obj(body, "body"));
  const bySymbol = new Map<string, Obj[]>();
  for (const r of entries) {
    if (typeof r.symbol !== "string") throw malformed("no symbol");
    const rows = bySymbol.get(r.symbol) ?? [];
    rows.push(r);
    bySymbol.set(r.symbol, rows);
  }
  // a symbol whose rows are malformed or conflict is left out alone, as a
  // missing row is: one company's bad row says nothing of the others'
  const data = new Map<string, CalendarEvent[]>();
  for (const [symbol, rows] of bySymbol) {
    try {
      data.set(symbol, collapseQuarters(rows.map((r) => calendarRow(r, true))));
    } catch (error) {
      if (!(error instanceof SourceError)) throw error;
    }
  }
  return { data: data.size === 0 ? null : data, listing: null };
};

export function finnhub(options: FinnhubOptions): Finnhub {
  const { clock, key } = options;
  const host = options.host ?? HOST;
  const doFetch: Fetch = options.fetch ?? ((url, init) => fetch(url, init));
  const calls = limiter(clock, SPACING_MS);

  const get = <T>(
    path: string,
    params: Record<string, string>,
    run: RunOptions,
    parse: (body: unknown) => Parsed<T>,
  ): Promise<Answer<T>> =>
    calls.run(async () => {
      const abort = new AbortController();
      let timedOut = false;
      const cancel = clock.at(clock.now() + TIMEOUT_MS, () => {
        timedOut = true;
        abort.abort();
      });
      try {
        let res: Response;
        let raw: string;
        try {
          res = await doFetch(
            `${host}/${path}?${new URLSearchParams(params)}`,
            {
              headers: { Accept: "application/json", "X-Finnhub-Token": key },
              signal: abort.signal,
            },
          );
          raw = await res.text();
        } catch {
          throw new SourceError(timedOut ? "timed out" : "network error");
        }
        const fetchedAt = clock.now();
        // the free key's answer for a listing it does not cover
        if (res.status === 403) return { ...NONE, fetchedAt };
        if (res.status === 429) throw new SourceError("rate limited");
        if (res.status === 401) throw new SourceError("key refused");
        if (res.status === 404) throw new SourceError("not found");
        if (!res.ok) {
          throw new SourceError("source error", `HTTP ${res.status}`);
        }
        let body: unknown;
        try {
          body = JSON.parse(raw);
        } catch {
          throw new Unreadable();
        }
        return { ...parse(body), fetchedAt };
      } finally {
        cancel();
      }
    }, run);

  const client = (run: RunOptions): Finnhub => ({
    metric: (symbol) =>
      get("stock/metric", { symbol, metric: "all" }, run, (b) =>
        parseMetric(b, symbol),
      ),
    analysts: (symbol) =>
      get("stock/recommendation", { symbol }, run, (b) =>
        parseAnalysts(b, symbol),
      ),
    earnings: (symbol) =>
      get("stock/earnings", { symbol }, run, (b) => parseEarnings(b, symbol)),
    insider: (symbol, from, to) =>
      get("stock/insider-sentiment", { symbol, from, to }, run, (b) =>
        parseInsider(b, symbol),
      ),
    calendar: (symbol, from, to) =>
      get("calendar/earnings", { symbol, from, to }, run, (b) =>
        parseCalendar(b, symbol),
      ),
    marketCalendar: (from, to) =>
      get("calendar/earnings", { from, to }, run, parseMarketCalendar),
    failFast: () => client({ failFast: true }),
    within: (live) => client({ failFast: true, live }),
    close: () => calls.close(),
    due: () => calls.due(),
    backoff: () => calls.backoff(),
  });
  return client({});
}
