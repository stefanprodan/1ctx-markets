// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Finnhub's free-key answers: basic financials, analyst counts, earnings
// surprises, insider sentiment and the earnings calendar. The key goes
// only in a header, never in a URL; errors hold a fixed phrase and
// nothing Finnhub or fetch said. A 403 or an empty answer is no data for
// that section, never an error, and an answer of any other shape is.

import type { Clock } from "../clock.ts";
import {
  DeadlinePassed,
  type Fetch,
  type Queue,
  QueueClosed,
  queue,
  type RunOptions,
  SourceError,
} from "../source.ts";
import { wallOfDate } from "../zone.ts";

export const SOURCE = "finnhub";
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
};

// null is no data: a 403, or an answer with nothing in it
export type Answer<T> = { data: T | null; fetchedAt: number };

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
  // the same client and limiter, failing at once while the queue is
  // paused, for a tool answering a caller
  failFast(): Finnhub;
  // failing fast, and starting no call once live() is false
  within(live: () => boolean): Finnhub;
  // At shutdown: closes the queue and fails a call waiting for its
  // slot, so no call goes out after.
  close(): void;
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

// rows are for the symbol asked, or the answer is someone else's
function sameSymbol(row: Obj, symbol: string): void {
  if (row.symbol !== undefined && row.symbol !== symbol) {
    throw malformed("another symbol answered");
  }
}

// A key answered twice with the same values is one row, as NVDA's
// quarter listed under two fiscal labels; with other values the
// section is refused, since either could be wrong.
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

export function parseMetric(body: unknown, symbol: string): Metric | null {
  const b = obj(body, "body");
  sameSymbol(b, symbol);
  const m = obj(b.metric, "metric");
  const out = {} as Metric;
  let any = false;
  for (const [column, field] of Object.entries(METRIC_FIELDS)) {
    const v = optionalNum(m[field], field);
    out[column as keyof Metric] = v;
    if (v !== null) any = true;
  }
  // TLV.RO's answer holds price fields only: nothing this server keeps
  return any ? out : null;
}

export function parseAnalysts(
  body: unknown,
  symbol: string,
): Analysts[] | null {
  const rows = list(body, "recommendations").map((entry): Analysts => {
    const r = obj(entry, "recommendation");
    sameSymbol(r, symbol);
    return {
      period: day(r.period, "period"),
      strongBuy: count(r.strongBuy, "strongBuy"),
      buy: count(r.buy, "buy"),
      hold: count(r.hold, "hold"),
      sell: count(r.sell, "sell"),
      strongSell: count(r.strongSell, "strongSell"),
    };
  });
  return rows.length === 0 ? null : collapse(rows, (r) => r.period);
}

export function parseEarnings(
  body: unknown,
  symbol: string,
): Earnings[] | null {
  const rows = list(body, "earnings").map((entry): Earnings => {
    const r = obj(entry, "earnings row");
    sameSymbol(r, symbol);
    // the fiscal labels are not kept: they disagree for one period
    return {
      period: day(r.period, "period"),
      estimate: optionalNum(r.estimate, "estimate"),
      actual: optionalNum(r.actual, "actual"),
      surprise: optionalNum(r.surprise, "surprise"),
      surprisePercent: optionalNum(r.surprisePercent, "surprisePercent"),
    };
  });
  return rows.length === 0 ? null : collapse(rows, (r) => r.period);
}

export function parseInsider(body: unknown, symbol: string): Insider[] | null {
  const b = obj(body, "body");
  sameSymbol(b, symbol);
  const rows = list(b.data, "insider data").map((entry): Insider => {
    const r = obj(entry, "insider month");
    sameSymbol(r, symbol);
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
  return rows.length === 0 ? null : collapse(rows, (r) => r.period);
}

const HOUR = /^[a-z]{0,8}$/;

export function parseCalendar(
  body: unknown,
  symbol: string,
): CalendarEvent[] | null {
  const b = obj(body, "body");
  const rows = list(b.earningsCalendar, "earnings calendar").map(
    (entry): CalendarEvent => {
      const r = obj(entry, "calendar row");
      // a calendar row always names its symbol
      if (r.symbol !== symbol) throw malformed("another symbol answered");
      const quarter = count(r.quarter, "quarter");
      if (quarter < 1 || quarter > 4) throw malformed("no quarter");
      const hour = r.hour ?? "";
      if (typeof hour !== "string" || !HOUR.test(hour)) {
        throw malformed("no hour");
      }
      return {
        fiscalYear: count(r.year, "year"),
        fiscalQuarter: quarter,
        date: day(r.date, "date"),
        hour,
        epsEstimate: optionalNum(r.epsEstimate, "epsEstimate"),
        epsActual: optionalNum(r.epsActual, "epsActual"),
        revenueEstimate: optionalNum(r.revenueEstimate, "revenueEstimate"),
        revenueActual: optionalNum(r.revenueActual, "revenueActual"),
      };
    },
  );
  return rows.length === 0
    ? null
    : collapse(rows, (r) => `${r.fiscalYear} Q${r.fiscalQuarter}`);
}

export function finnhub(options: FinnhubOptions): Finnhub {
  const { clock, key } = options;
  const host = options.host ?? HOST;
  const doFetch: Fetch = options.fetch ?? ((url, init) => fetch(url, init));
  // one call at a time, so the spacing below holds across jobs and tools
  const calls: Queue = queue(clock, 1);
  let lastStart = Number.NEGATIVE_INFINITY;
  let closed = false;
  const waits = new Set<{ cancel: () => void; reject: (e: unknown) => void }>();

  // waits, holding the queue, until the spacing since the last start
  const slot = async (): Promise<void> => {
    const until = lastStart + SPACING_MS;
    if (clock.now() < until) {
      await new Promise<void>((resolve, reject) => {
        const wait = { cancel: () => {}, reject };
        wait.cancel = clock.at(until, () => {
          waits.delete(wait);
          resolve();
        });
        waits.add(wait);
      });
    }
    lastStart = clock.now();
  };

  const get = <T>(
    path: string,
    params: Record<string, string>,
    run: RunOptions,
    parse: (body: unknown) => T | null,
  ): Promise<Answer<T>> =>
    calls.run(async () => {
      if (closed) throw new QueueClosed();
      if (run.live !== undefined && !run.live()) throw new DeadlinePassed();
      await slot();
      // closed, or past the caller's deadline, while it waited
      if (closed) throw new QueueClosed();
      if (run.live !== undefined && !run.live()) throw new DeadlinePassed();
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
        if (res.status === 403) return { data: null, fetchedAt };
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
          throw malformed("not JSON");
        }
        return { data: parse(body), fetchedAt };
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
    failFast: () => client({ failFast: true }),
    within: (live) => client({ failFast: true, live }),
    close() {
      closed = true;
      calls.close();
      for (const wait of waits) {
        wait.cancel();
        wait.reject(new QueueClosed());
      }
      waits.clear();
    },
  });
  return client({});
}
