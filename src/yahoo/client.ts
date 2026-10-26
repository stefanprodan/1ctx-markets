// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Yahoo's chart, v7 spark and search answers, read without a cookie or
// crumb. Every call goes through one queue, and an answer that does not
// have the expected shape is an error, never empty rows.

import { type Session, sessionFromChartMeta } from "../calendars.ts";
import type { Clock } from "../clock.ts";
import {
  type Fetch,
  type Phrase,
  type Queue,
  queue,
  type RunOptions,
  SourceError,
  Unreadable,
} from "../source.ts";

export const SOURCE = "yahoo";
export const HOST = "https://query1.finance.yahoo.com";
// a full browser User-Agent was answered 429
const USER_AGENT = "Mozilla/5.0";
// 21 symbols is a 400
export const SPARK_MAX = 20;
const CONCURRENCY = 2;
const TIMEOUT_MS = 30_000;

export type ChartMeta = {
  // Yahoo's own symbol, suffix included
  symbol: string;
  exchange: string;
  type: string;
  currency: string | null;
  name: string | null;
  session: Session;
  price: number;
  // UTC epoch ms of the last trade
  time: number;
  previousClose: number | null;
  chartPreviousClose: number | null;
  // 0 means none: ^TNX's meta reads 0 while its bars do not
  dayHigh: number | null;
  dayLow: number | null;
  volume: number | null;
};

export type ChartRow = {
  at: number;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
  volume: number | null;
};

export type SplitEvent = {
  at: number;
  numerator: number;
  denominator: number;
  ratio: string;
};

export type ChartAnswer = ChartMeta & {
  // UTC epoch ms of the listing's first trade, when Yahoo gives it
  firstTrade: number | null;
  rows: ChartRow[];
  splits: SplitEvent[];
  fetchedAt: number;
};

export type SparkAnswer = {
  quotes: ChartMeta[];
  skipped: { symbol: string | null; phrase: Phrase }[];
  fetchedAt: number;
};

export type SparkBatch = {
  symbols: string[];
  answer?: SparkAnswer;
  error?: unknown;
};

export type Listing = {
  sourceSymbol: string;
  exchange: string;
  type: string | null;
  name: string | null;
};

export type Yahoo = {
  // daily bars with split events, from and to in UTC epoch ms
  chart(symbol: string, from: number, to: number): Promise<ChartAnswer>;
  // at most SPARK_MAX symbols
  spark(symbols: readonly string[]): Promise<SparkAnswer>;
  // in calls of SPARK_MAX; a failed call keeps the others' answers
  sparkAll(symbols: readonly string[]): Promise<SparkBatch[]>;
  search(query: string): Promise<Listing[]>;
  // fails at once while the queue backs off, for a tool
  failFast(): Yahoo;
  // failing fast, and starting no call once live() is false
  within(live: () => boolean): Yahoo;
};

export type YahooOptions = {
  clock: Clock;
  fetch?: Fetch;
  host?: string;
  // shared with every other caller of the same source
  queue?: Queue;
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

function finite(v: unknown, what: string): number {
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw malformed(`no ${what}`);
  }
  return v;
}

function optionalNumber(v: unknown, what: string): number | null {
  return v === undefined || v === null ? null : finite(v, what);
}

function text(v: unknown, what: string): string {
  if (typeof v !== "string" || v === "") throw malformed(`no ${what}`);
  return v;
}

const optionalText = (v: unknown): string | null =>
  typeof v === "string" && v.trim() !== "" ? v.trim() : null;

const seconds = (v: unknown, what: string): number => {
  const s = finite(v, what);
  if (!Number.isSafeInteger(s)) throw malformed(`${what} is not whole seconds`);
  return s * 1000;
};

function parseMeta(v: unknown): ChartMeta {
  const m = obj(v, "meta");
  let session: Session;
  try {
    session = sessionFromChartMeta(m);
  } catch (error) {
    throw malformed(error instanceof Error ? error.message : "no session");
  }
  return {
    symbol: text(m.symbol, "symbol"),
    exchange: text(m.exchangeName, "exchange"),
    type: text(m.instrumentType, "instrument type"),
    currency: optionalText(m.currency),
    name: optionalText(m.longName) ?? optionalText(m.shortName),
    session,
    price: finite(m.regularMarketPrice, "price"),
    time: seconds(m.regularMarketTime, "price time"),
    previousClose: optionalNumber(m.previousClose, "previous close"),
    chartPreviousClose: optionalNumber(
      m.chartPreviousClose,
      "chart previous close",
    ),
    dayHigh: optionalNumber(m.regularMarketDayHigh, "day high") || null,
    dayLow: optionalNumber(m.regularMarketDayLow, "day low") || null,
    volume: optionalNumber(m.regularMarketVolume, "volume"),
  };
}

function column(
  quote: Obj,
  name: string,
  length: number,
): (number | null)[] | null {
  const values = quote[name];
  if (values === undefined) return null;
  if (!Array.isArray(values) || values.length !== length) {
    throw malformed(`${name} does not match the timestamps`);
  }
  return values.map((x) => (x === null ? null : finite(x, `${name} value`)));
}

function parseRows(result: Obj): ChartRow[] {
  const indicators = obj(result.indicators, "indicators");
  if (!Array.isArray(indicators.quote) || indicators.quote.length !== 1) {
    throw malformed("no quote indicators");
  }
  const quote = obj(indicators.quote[0], "quote indicators");
  const stamps = result.timestamp;
  if (stamps === undefined) {
    // a range without trading answers no timestamps and an empty quote
    if (Object.keys(quote).length > 0)
      throw malformed("rows without timestamps");
    return [];
  }
  if (!Array.isArray(stamps)) throw malformed("timestamps are not a list");
  const n = stamps.length;
  const close = column(quote, "close", n);
  if (close === null) throw malformed("no closes");
  const open = column(quote, "open", n);
  const high = column(quote, "high", n);
  const low = column(quote, "low", n);
  const volume = column(quote, "volume", n);
  return stamps.map((s, i) => ({
    at: seconds(s, "timestamp"),
    open: open?.[i] ?? null,
    high: high?.[i] ?? null,
    low: low?.[i] ?? null,
    close: close[i] ?? null,
    volume: volume?.[i] ?? null,
  }));
}

function parseSplits(result: Obj): SplitEvent[] {
  const events = result.events;
  if (events === undefined || events === null) return [];
  const splits = obj(events, "events").splits;
  if (splits === undefined || splits === null) return [];
  return Object.values(obj(splits, "splits"))
    .map((v) => {
      const s = obj(v, "split");
      const numerator = finite(s.numerator, "split numerator");
      const denominator = finite(s.denominator, "split denominator");
      if (numerator <= 0 || denominator <= 0) throw malformed("split ratio");
      return {
        at: seconds(s.date, "split date"),
        numerator,
        denominator,
        ratio: optionalText(s.splitRatio) ?? `${numerator}:${denominator}`,
      };
    })
    .sort((a, b) => a.at - b.at);
}

export function parseChart(body: unknown, fetchedAt: number): ChartAnswer {
  const chart = obj(obj(body, "body").chart, "chart");
  if (chart.error !== null && chart.error !== undefined) {
    const code = isObj(chart.error) ? chart.error.code : undefined;
    throw code === "Not Found"
      ? new SourceError("not found")
      : new SourceError("source error", String(code ?? "chart error"));
  }
  if (!Array.isArray(chart.result) || chart.result.length !== 1) {
    throw malformed("not one chart result");
  }
  const result = obj(chart.result[0], "chart result");
  const meta = obj(result.meta, "meta");
  return {
    ...parseMeta(meta),
    firstTrade:
      meta.firstTradeDate === undefined || meta.firstTradeDate === null
        ? null
        : seconds(meta.firstTradeDate, "first trade date"),
    rows: parseRows(result),
    splits: parseSplits(result),
    fetchedAt,
  };
}

// Each entry is read on its own, so one bad symbol skips only itself;
// a symbol without data comes back without a response.
export function parseSpark(body: unknown, fetchedAt: number): SparkAnswer {
  const spark = obj(obj(body, "body").spark, "spark");
  if (spark.error !== null && spark.error !== undefined) {
    throw new SourceError("source error", "spark error");
  }
  if (!Array.isArray(spark.result)) throw malformed("no spark results");
  const quotes: ChartMeta[] = [];
  const skipped: SparkAnswer["skipped"] = [];
  for (const entry of spark.result) {
    const symbol = isObj(entry) ? optionalText(entry.symbol) : null;
    const response = isObj(entry) ? entry.response : undefined;
    if (
      response === null ||
      (Array.isArray(response) && response.length === 0)
    ) {
      skipped.push({ symbol, phrase: "not found" });
      continue;
    }
    try {
      if (!Array.isArray(response)) throw malformed("spark response");
      quotes.push(parseMeta(obj(response[0], "spark response").meta));
    } catch (error) {
      if (!(error instanceof SourceError)) throw error;
      skipped.push({ symbol, phrase: error.phrase });
    }
  }
  return { quotes, skipped, fetchedAt };
}

export function parseSearch(body: unknown): Listing[] {
  const quotes = obj(body, "body").quotes;
  if (!Array.isArray(quotes)) throw malformed("no search quotes");
  const listings: Listing[] = [];
  for (const q of quotes) {
    if (!isObj(q) || q.isYahooFinance === false) continue;
    const symbol = optionalText(q.symbol);
    const exchange = optionalText(q.exchange);
    // entries without a listing, such as private companies
    if (symbol === null || exchange === null) continue;
    listings.push({
      sourceSymbol: symbol,
      exchange,
      type: optionalText(q.quoteType),
      name: optionalText(q.longname) ?? optionalText(q.shortname),
    });
  }
  return listings;
}

export function yahoo(options: YahooOptions): Yahoo {
  const { clock } = options;
  const host = options.host ?? HOST;
  const doFetch: Fetch = options.fetch ?? ((url, init) => fetch(url, init));
  const calls = options.queue ?? queue(clock, CONCURRENCY);

  // parsed inside the queued task, so a body that is not JSON backs the
  // queue off
  const get = <T>(
    url: string,
    run: RunOptions,
    parse: (body: unknown, fetchedAt: number) => T,
  ): Promise<T> =>
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
          res = await doFetch(url, {
            headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
            signal: abort.signal,
          });
          raw = await res.text();
        } catch {
          throw new SourceError(timedOut ? "timed out" : "network error");
        }
        const fetchedAt = clock.now();
        if (res.status === 429) throw new SourceError("rate limited");
        if (res.status === 400) throw new SourceError("bad request");
        let body: unknown;
        try {
          body = JSON.parse(raw);
        } catch {
          body = undefined;
        }
        // an unknown symbol is a 404 with a chart error in the body
        if (res.status === 404) throw new SourceError("not found");
        if (!res.ok)
          throw new SourceError("source error", `HTTP ${res.status}`);
        if (body === undefined) throw new Unreadable();
        return parse(body, fetchedAt);
      } finally {
        cancel();
      }
    }, run);

  const client = (run: RunOptions): Yahoo => {
    const spark = async (symbols: readonly string[]): Promise<SparkAnswer> => {
      if (symbols.length === 0 || symbols.length > SPARK_MAX) {
        throw new Error(`a spark call takes 1 to ${SPARK_MAX} symbols`);
      }
      // a cached answer freezes the price for minutes; _ makes each URL new
      const list = symbols.map(encodeURIComponent).join(",");
      const url = `${host}/v7/finance/spark?symbols=${list}&range=1d&interval=5m&_=${clock.now()}`;
      return get(url, run, parseSpark);
    };

    return {
      async chart(symbol, from, to) {
        const params = new URLSearchParams({
          period1: String(Math.floor(from / 1000)),
          period2: String(Math.ceil(to / 1000)),
          interval: "1d",
          events: "div,split",
        });
        const url = `${host}/v8/finance/chart/${encodeURIComponent(symbol)}?${params}`;
        return get(url, run, parseChart);
      },
      spark,
      async sparkAll(symbols) {
        const batches: string[][] = [];
        for (let i = 0; i < symbols.length; i += SPARK_MAX) {
          batches.push(symbols.slice(i, i + SPARK_MAX));
        }
        return Promise.all(
          batches.map((batch) =>
            spark(batch).then(
              (answer): SparkBatch => ({ symbols: batch, answer }),
              (error: unknown): SparkBatch => ({ symbols: batch, error }),
            ),
          ),
        );
      },
      async search(query) {
        const params = new URLSearchParams({
          q: query,
          quotesCount: "10",
          newsCount: "0",
          listsCount: "0",
        });
        return get(`${host}/v1/finance/search?${params}`, run, parseSearch);
      },
      failFast: () => client({ failFast: true }),
      within: (live) => client({ failFast: true, live }),
    };
  };
  return client({});
}
