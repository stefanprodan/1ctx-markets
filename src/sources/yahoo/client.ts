// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { type Session, sessionFromChartMeta } from "../../market/calendars.ts";
import type { Point } from "../../market/intraday.ts";
import type { Clock } from "../../runtime/clock.ts";
import { YAHOO } from "../ids.ts";
import {
  type Backoff,
  DeadlinePassed,
  type Fetch,
  Paused,
  type Phrase,
  type Queue,
  QueueClosed,
  queue,
  type RunOptions,
  SourceError,
  Unreadable,
} from "../source.ts";

export const SOURCE = YAHOO;
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
  // hasPrePostMarketData: whether the listing trades before and after
  // its regular session; null when the answer does not say
  prePost: boolean | null;
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

// UTC epoch ms, end exclusive
export type Window = { start: number; end: number };

// one day's minutes with pre- and post-market bars and their windows
export type IntradayAnswer = ChartAnswer & {
  windows: { pre: Window[]; regular: Window[]; post: Window[] };
};

// two days: before the pre window a one-day answer can hold no bar in
// its windows, while two keep the last post bars until the next open
export const INTRADAY_RANGE = "2d";

export type SparkQuote = ChartMeta & { points: Point[] };

export type PointsAnswer = ChartMeta & { points: Point[]; fetchedAt: number };

export type SparkAnswer = {
  quotes: SparkQuote[];
  skipped: { symbol: string | null; phrase: Phrase }[];
  fetchedAt: number;
};

export type SparkBatch = {
  symbols: string[];
  answer?: SparkAnswer;
  error?: unknown;
  // one symbol that failed on its own while the rest of its call answered
  alone?: boolean;
};

export type Listing = {
  sourceSymbol: string;
  exchange: string;
  // the exchange as Yahoo writes it for people (Milan, XETRA), when given
  exchangeName?: string;
  type: string | null;
  name: string | null;
};

export type Yahoo = {
  // from and to in UTC epoch ms
  chart(symbol: string, from: number, to: number): Promise<ChartAnswer>;
  intraday(symbol: string): Promise<IntradayAnswer>;
  points(symbol: string): Promise<PointsAnswer>;
  // the listing's hasPrePostMarketData from the last answer naming it
  prePost(symbol: string): boolean | undefined;
  spark(symbols: readonly string[]): Promise<SparkAnswer>;
  // in calls of SPARK_MAX; a failed call keeps the others' answers, and
  // one a single symbol may have broken is split to find it
  sparkAll(symbols: readonly string[]): Promise<SparkBatch[]>;
  search(query: string): Promise<Listing[]>;
  failFast(): Yahoo;
  within(live: () => boolean): Yahoo;
  backoff(): Backoff | null;
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

// some pairs answer "" (EURRON=X); AAABBB=X and USD-based BBB=X quote in BBB
const PAIR = /^(?:[A-Z]{3})?([A-Z]{3})=X$/;

function currencyOf(m: Obj, symbol: string, type: string): string | null {
  const stated = optionalText(m.currency);
  if (stated !== null || type.toUpperCase() !== "CURRENCY") return stated;
  return PAIR.exec(symbol.toUpperCase())?.[1] ?? null;
}

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
  const symbol = text(m.symbol, "symbol");
  const type = text(m.instrumentType, "instrument type");
  return {
    symbol,
    exchange: text(m.exchangeName, "exchange"),
    type,
    currency: currencyOf(m, symbol, type),
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
    prePost:
      typeof m.hasPrePostMarketData === "boolean"
        ? m.hasPrePostMarketData
        : null,
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

function window(v: unknown, what: string): Window {
  const w = obj(v, what);
  const start = seconds(w.start, `${what} start`);
  const end = seconds(w.end, `${what} end`);
  // a market without the window answers it empty (TLV.RO's pre)
  if (end < start) throw malformed(`${what} ends before it starts`);
  return { start, end };
}

// currentTradingPeriod's window and each day's in tradingPeriods, which
// a range of more than one day carries
function windows(meta: Obj, name: "pre" | "regular" | "post"): Window[] {
  const out: Window[] = [];
  const current = isObj(meta.currentTradingPeriod)
    ? meta.currentTradingPeriod[name]
    : undefined;
  if (current !== undefined) out.push(window(current, `${name} period`));
  const days = isObj(meta.tradingPeriods)
    ? meta.tradingPeriods[name]
    : undefined;
  if (days !== undefined) {
    if (!Array.isArray(days)) throw malformed(`${name} periods`);
    for (const day of days) {
      for (const w of Array.isArray(day) ? day : [day]) {
        out.push(window(w, `${name} period`));
      }
    }
  }
  return out;
}

export function parseIntraday(
  body: unknown,
  fetchedAt: number,
): IntradayAnswer {
  const answer = parseChart(body, fetchedAt);
  // parseChart checked there is one result with a meta
  const result = (obj(body, "body").chart as Obj).result as unknown[];
  const meta = obj(obj(result[0], "chart result").meta, "meta");
  return {
    ...answer,
    windows: {
      pre: windows(meta, "pre"),
      regular: windows(meta, "regular"),
      post: windows(meta, "post"),
    },
  };
}

// a stamp outside these years cannot be dated in a zone
const FIRST_POINT = Date.UTC(1970, 0, 1);
const LAST_POINT = Date.UTC(2200, 0, 1);

function closesOf(rows: readonly ChartRow[]): Point[] {
  const out: Point[] = [];
  for (const row of rows) {
    if (row.at < FIRST_POINT || row.at >= LAST_POINT) {
      throw malformed("timestamp out of range");
    }
    if (row.close !== null) out.push({ at: row.at, close: row.close });
  }
  return out;
}

// a bad series never costs the price: it gives no points
function sparkPoints(response: Obj): Point[] {
  try {
    return closesOf(parseRows(response));
  } catch (error) {
    if (error instanceof SourceError) return [];
    throw error;
  }
}

export function parsePoints(body: unknown, fetchedAt: number): PointsAnswer {
  const { rows, splits, firstTrade, ...meta } = parseChart(body, fetchedAt);
  return { ...meta, points: closesOf(rows) };
}

// Yahoo's own answer about the symbols asked, as for one it has no spark
// for while its chart answers; never a sign the source is down
class SparkRefused extends SourceError {
  constructor() {
    super("source error", "spark error");
  }
}

// Each entry is read on its own, so one bad symbol skips only itself;
// a symbol without data comes back without a response.
export function parseSpark(body: unknown, fetchedAt: number): SparkAnswer {
  const spark = obj(obj(body, "body").spark, "spark");
  if (spark.error !== null && spark.error !== undefined) {
    throw new SparkRefused();
  }
  if (!Array.isArray(spark.result)) throw malformed("no spark results");
  const quotes: SparkQuote[] = [];
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
      const first = obj(response[0], "spark response");
      quotes.push({ ...parseMeta(first.meta), points: sparkPoints(first) });
    } catch (error) {
      if (!(error instanceof SourceError)) throw error;
      skipped.push({ symbol, phrase: error.phrase });
    }
  }
  return { quotes, skipped, fetchedAt };
}

// a one-day chart is one spark entry, for a symbol spark failed on
export function parseQuoteChart(body: unknown, fetchedAt: number): SparkAnswer {
  const { rows, splits, firstTrade, ...meta } = parseChart(body, fetchedAt);
  let points: Point[];
  try {
    points = closesOf(rows);
  } catch (error) {
    if (!(error instanceof SourceError)) throw error;
    points = [];
  }
  return { quotes: [{ ...meta, points }], skipped: [], fetchedAt };
}

// an answer one bad symbol in the call can cause; a rate limit, a timeout,
// a network failure or a page that is not JSON says the source is unwell
const brokenBy = (error: unknown): boolean =>
  error instanceof SourceError &&
  !(error instanceof Unreadable) &&
  !(error instanceof Paused) &&
  (error.phrase === "source error" ||
    error.phrase === "malformed answer" ||
    error.phrase === "bad request");

// an answer about the symbols asked, so the split goes on past it
const ownError = (error: unknown): boolean =>
  brokenBy(error) ||
  (error instanceof SourceError &&
    !(error instanceof Paused) &&
    error.phrase === "not found");

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
    const shown = optionalText(q.exchDisp);
    listings.push({
      sourceSymbol: symbol,
      exchange,
      ...(shown === null ? {} : { exchangeName: shown }),
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
  // kept from every answer, so a quote asking for extended prices skips
  // a listing without them; a restart empties it
  const prePost = new Map<string, boolean>();
  const seen = <T extends ChartMeta>(meta: T): T => {
    if (meta.prePost !== null) prePost.set(meta.symbol, meta.prePost);
    return meta;
  };

  const call = async <T>(
    url: string,
    parse: (body: unknown, fetchedAt: number) => T,
  ): Promise<T> => {
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
      if (!res.ok) throw new SourceError("source error", `HTTP ${res.status}`);
      if (body === undefined) throw new Unreadable();
      return parse(body, fetchedAt);
    } finally {
      cancel();
    }
  };

  // parsed inside the queued task, so a body that is not JSON backs the
  // queue off
  const get = <T>(
    url: string,
    run: RunOptions,
    parse: (body: unknown, fetchedAt: number) => T,
  ): Promise<T> => calls.run(() => call(url, parse), run);

  // a cached answer freezes the price for minutes; _ makes each URL new
  const sparkUrl = (symbols: readonly string[]) =>
    `${host}/v7/finance/spark?symbols=${symbols.map(encodeURIComponent).join(",")}&range=1d&interval=5m&_=${clock.now()}`;

  const quoteChartUrl = (symbol: string) =>
    `${host}/v8/finance/chart/${encodeURIComponent(symbol)}?${new URLSearchParams({ range: "1d", interval: "5m" })}`;

  const seenAll = (answer: SparkAnswer): SparkAnswer => {
    for (const quote of answer.quotes) seen(quote);
    return answer;
  };

  // one queued task, so only a failure the split cannot narrow backs off
  const sparkSplit = (batch: string[], run: RunOptions) =>
    calls
      .run(async (): Promise<SparkBatch[]> => {
        const next = <T>(url: string, parse: (b: unknown, at: number) => T) => {
          if (calls.isClosed()) throw new QueueClosed();
          if (run.live !== undefined && !run.live()) throw new DeadlinePassed();
          // another call's back-off holds the split too
          const paused = calls.backoff();
          if (paused !== null) throw new Paused(paused.after);
          return call(url, parse);
        };
        const ask = async (
          symbols: string[],
        ): Promise<{ answer?: SparkAnswer; error?: unknown }> => {
          try {
            return { answer: await next(sparkUrl(symbols), parseSpark) };
          } catch (error) {
            if (!ownError(error)) throw error;
            return { error };
          }
        };
        // the symbol that broke its calls, asked once on the chart
        const alone = async (symbol: string, error: unknown) => {
          if (!brokenBy(error)) return { error };
          try {
            return {
              answer: await next(quoteChartUrl(symbol), parseQuoteChart),
            };
          } catch (e) {
            if (!ownError(e)) throw e;
            return { error };
          }
        };
        const out: SparkBatch[] = [];
        // both halves failing as a broken call would is the source, so
        // that batch fails whole; Yahoo's answer about a half is its own
        const narrow = async (symbols: string[]) => {
          const mid = Math.ceil(symbols.length / 2);
          const halves = [symbols.slice(0, mid), symbols.slice(mid)];
          const tries = [];
          for (const half of halves) tries.push(await ask(half));
          const down = (e: unknown) =>
            brokenBy(e) && !(e instanceof SparkRefused);
          if (tries.every((t) => t.answer === undefined && down(t.error))) {
            return false;
          }
          for (const [k, half] of halves.entries()) {
            const t = tries[k]!;
            if (t.answer !== undefined) {
              out.push({ symbols: half, answer: t.answer });
            } else if (half.length > 1 && brokenBy(t.error)) {
              if (!(await narrow(half))) {
                out.push({ symbols: half, error: t.error });
              }
            } else if (half.length === 1) {
              const one = await alone(half[0]!, t.error);
              out.push({
                symbols: half,
                ...one,
                ...(one.answer === undefined ? { alone: true } : {}),
              });
            } else out.push({ symbols: half, error: t.error });
          }
          return true;
        };
        const first = await ask(batch);
        if (first.answer !== undefined) return [{ symbols: batch, ...first }];
        if (!brokenBy(first.error)) throw first.error;
        if (batch.length === 1) {
          const one = await alone(batch[0]!, first.error);
          if (one.answer === undefined) throw first.error;
          return [{ symbols: batch, ...one }];
        }
        if (!(await narrow(batch))) throw first.error;
        return out;
      }, run)
      .then((batches) => {
        for (const b of batches) if (b.answer) seenAll(b.answer);
        return batches;
      });

  const client = (run: RunOptions): Yahoo => {
    const spark = async (symbols: readonly string[]): Promise<SparkAnswer> => {
      if (symbols.length === 0 || symbols.length > SPARK_MAX) {
        throw new Error(`a spark call takes 1 to ${SPARK_MAX} symbols`);
      }
      return seenAll(await get(sparkUrl(symbols), run, parseSpark));
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
        return seen(await get(url, run, parseChart));
      },
      async intraday(symbol) {
        const params = new URLSearchParams({
          interval: "1m",
          range: INTRADAY_RANGE,
          includePrePost: "true",
        });
        const url = `${host}/v8/finance/chart/${encodeURIComponent(symbol)}?${params}`;
        return seen(await get(url, run, parseIntraday));
      },
      async points(symbol) {
        const params = new URLSearchParams({
          range: "5d",
          interval: "5m",
          includePrePost: "false",
        });
        const url = `${host}/v8/finance/chart/${encodeURIComponent(symbol)}?${params}`;
        return seen(await get(url, run, parsePoints));
      },
      prePost: (symbol) => prePost.get(symbol),
      spark,
      async sparkAll(symbols) {
        const batches: string[][] = [];
        for (let i = 0; i < symbols.length; i += SPARK_MAX) {
          batches.push(symbols.slice(i, i + SPARK_MAX));
        }
        const answered = await Promise.all(
          batches.map((batch) =>
            sparkSplit(batch, run).catch((error: unknown): SparkBatch[] => [
              { symbols: batch, error },
            ]),
          ),
        );
        return answered.flat();
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
      backoff: () => calls.backoff(),
    };
  };
  return client({});
}
