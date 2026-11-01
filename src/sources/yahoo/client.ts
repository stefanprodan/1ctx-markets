// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { type Session, sessionFromChartMeta } from "../../market/calendars.ts";
import type { Point } from "../../market/intraday.ts";
import type { Clock } from "../../runtime/clock.ts";
import { YAHOO } from "../ids.ts";
import { cut } from "../massive/client.ts";
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
// the quote summary's host; its session comes from fc and query1
export const SUMMARY_HOST = "https://query2.finance.yahoo.com";
export const COOKIE_URL = "https://fc.yahoo.com/";
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

// per share of the listing asked, in currency; null when not given
export type Valuation = {
  symbol: string;
  currency: string | null;
  epsTtm: number | null;
  epsForward: number | null;
  peg: number | null;
  fetchedAt: number;
};

// weights are fractions of the fund, as Yahoo gives them
export type FundHolding = {
  symbol: string | null;
  name: string;
  weight: number;
};

export type FundWeight = { key: string; weight: number };

export type FundPositions = {
  stock: number | null;
  bond: number | null;
  cash: number | null;
  other: number | null;
  preferred: number | null;
  convertible: number | null;
};

// fund null: Yahoo has no top holdings for the symbol
export type TopHoldings = {
  symbol: string;
  fund: {
    holdings: FundHolding[];
    positions: FundPositions;
    sectors: FundWeight[];
    ratings: FundWeight[];
    // overlaps the ratings, so never one of them
    government: number | null;
  } | null;
  fetchedAt: number;
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
  // the quote summary, behind a cookie and crumb held in memory only
  valuation(symbol: string): Promise<Valuation>;
  // a fund's ten largest holdings, on the same session
  topHoldings(symbol: string): Promise<TopHoldings>;
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

// the session was refused: the crumb is asked again once
export class Unauthorized extends SourceError {
  constructor() {
    super("source error", "unauthorized");
  }
}

// {raw, fmt}, {} or missing; anything but a finite raw is null, never 0
function raw(v: unknown): number | null {
  if (!isObj(v)) return null;
  return typeof v.raw === "number" && Number.isFinite(v.raw) ? v.raw : null;
}

// the one result of a quote summary, its error read first
function summaryResult(body: unknown): Obj {
  const b = obj(body, "body");
  const summary = isObj(b.quoteSummary) ? b.quoteSummary : b.finance;
  const top = obj(summary, "quote summary");
  if (top.error !== null && top.error !== undefined) {
    const code = isObj(top.error) ? top.error.code : undefined;
    if (code === "Unauthorized") throw new Unauthorized();
    throw code === "Not Found"
      ? new SourceError("not found")
      : new SourceError("source error", "quote summary error");
  }
  if (!Array.isArray(top.result) || top.result.length !== 1) {
    throw malformed("not one quote summary result");
  }
  return obj(top.result[0], "quote summary result");
}

export function parseSummary(body: unknown, fetchedAt: number): Valuation {
  const result = summaryResult(body);
  const price = obj(result.price, "price");
  const stats =
    result.defaultKeyStatistics === undefined ||
    result.defaultKeyStatistics === null
      ? {}
      : obj(result.defaultKeyStatistics, "key statistics");
  return {
    symbol: text(price.symbol, "symbol"),
    currency: optionalText(price.currency),
    epsTtm: raw(stats.trailingEps),
    epsForward: raw(stats.forwardEps),
    peg: raw(stats.pegRatio),
    fetchedAt,
  };
}

// a fund holds at most this much of one name, sector or rating; past it
// the figure is not a fraction
const MAX_WEIGHT = 1.05;
// cash can be short and stock past 100%, as a fund borrows
const MIN_POSITION = -0.5;
const MAX_POSITION = 1.5;
export const HOLDING_NAME_MAX = 120;
// Yahoo lists a fund's ten largest, never more
export const TOP_HOLDINGS = 10;
const WEIGHT_KEY = /^[a-z_]{1,32}$/;
// a bare number names a listing on an exchange Yahoo does not say
const BARE_CODE = /^\d+$/;
const YAHOO_SYMBOL = /^[A-Za-z0-9.^=&-]{1,32}$/;
const GOVERNMENT = "us_government";

const weightOf = (v: unknown): number | null => {
  const w = raw(v);
  return w !== null && w >= 0 && w <= MAX_WEIGHT ? w : null;
};

const positionOf = (v: unknown): number | null => {
  const p = raw(v);
  return p !== null && p >= MIN_POSITION && p <= MAX_POSITION ? p : null;
};

// one line for an agent: no control characters, no runs of spaces
export function cleanName(v: string): string {
  const one = v
    .replaceAll(/\p{Cc}/gu, " ")
    .replaceAll(/\s+/g, " ")
    .trim();
  return cut(one, HOLDING_NAME_MAX);
}

function holdingSymbol(v: unknown): string | null {
  const s = optionalText(v);
  return s === null || BARE_CODE.test(s) || !YAHOO_SYMBOL.test(s) ? null : s;
}

// missing is none; anything else that is not a list is no answer, so it
// never replaces stored rows as an empty one
function rowsOf(v: unknown, what: string): unknown[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) throw malformed(`${what} is not a list`);
  return v;
}

// [{key: {raw}}], each key once, weights above 0
function weights(
  v: unknown,
  what: string,
): {
  kept: FundWeight[];
  government: number | null;
} {
  const kept: FundWeight[] = [];
  let government: number | null = null;
  const seen = new Set<string>();
  for (const entry of rowsOf(v, what)) {
    if (!isObj(entry)) continue;
    for (const [key, value] of Object.entries(entry)) {
      const weight = weightOf(value);
      if (key === GOVERNMENT) {
        if (weight !== null && weight > 0) government = weight;
        continue;
      }
      if (!WEIGHT_KEY.test(key) || seen.has(key)) continue;
      if (weight === null || weight === 0) continue;
      seen.add(key);
      kept.push({ key, weight });
    }
  }
  return { kept, government };
}

export function parseTopHoldings(
  body: unknown,
  fetchedAt: number,
): TopHoldings {
  const result = summaryResult(body);
  const symbol = text(obj(result.price, "price").symbol, "symbol");
  // a share, or a fund Yahoo describes no holdings of
  if (result.topHoldings === undefined || result.topHoldings === null) {
    return { symbol, fund: null, fetchedAt };
  }
  const t = obj(result.topHoldings, "top holdings");
  const holdings: FundHolding[] = [];
  for (const h of rowsOf(t.holdings, "holdings")) {
    if (holdings.length === TOP_HOLDINGS) break;
    if (!isObj(h)) continue;
    const weight = weightOf(h.holdingPercent);
    const own = holdingSymbol(h.symbol);
    const given =
      typeof h.holdingName === "string" ? cleanName(h.holdingName) : "";
    const name = given === "" ? own : given;
    if (weight === null || name === null) continue;
    holdings.push({ symbol: own, name, weight });
  }
  const sectors = weights(t.sectorWeightings, "sectorWeightings").kept;
  const ratings = weights(t.bondRatings, "bondRatings");
  const positions: FundPositions = {
    stock: positionOf(t.stockPosition),
    bond: positionOf(t.bondPosition),
    cash: positionOf(t.cashPosition),
    other: positionOf(t.otherPosition),
    preferred: positionOf(t.preferredPosition),
    convertible: positionOf(t.convertiblePosition),
  };
  // a module with nothing in it says no more than a missing one
  if (
    holdings.length === 0 &&
    sectors.length === 0 &&
    ratings.kept.length === 0 &&
    ratings.government === null &&
    Object.values(positions).every((p) => p === null)
  ) {
    return { symbol, fund: null, fetchedAt };
  }
  return {
    symbol,
    fund: {
      holdings,
      positions,
      sectors,
      ratings: ratings.kept,
      government: ratings.government,
    },
    fetchedAt,
  };
}

type Crumb = { cookie: string; crumb: string };

// a crumb is a short token; anything else is a page, not a crumb
const CRUMB = /^[A-Za-z0-9./_-]{1,64}$/;

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

  // the URL and headers can hold the session, so no error repeats them
  const send = async (
    url: string,
    headers: Record<string, string>,
    redirect: RequestRedirect = "follow",
  ): Promise<{ res: Response; raw: string; fetchedAt: number }> => {
    const abort = new AbortController();
    let timedOut = false;
    const cancel = clock.at(clock.now() + TIMEOUT_MS, () => {
      timedOut = true;
      abort.abort();
    });
    try {
      const res = await doFetch(url, {
        headers: { "User-Agent": USER_AGENT, ...headers },
        signal: abort.signal,
        redirect,
      });
      const raw = await res.text();
      return { res, raw, fetchedAt: clock.now() };
    } catch {
      throw new SourceError(timedOut ? "timed out" : "network error");
    } finally {
      cancel();
    }
  };

  const call = async <T>(
    url: string,
    parse: (body: unknown, fetchedAt: number) => T,
    headers: Record<string, string> = {},
  ): Promise<T> => {
    const { res, raw, fetchedAt } = await send(url, {
      Accept: "application/json",
      ...headers,
    });
    if (res.status === 429) throw new SourceError("rate limited");
    if (res.status === 400) throw new SourceError("bad request");
    if (res.status === 401) throw new Unauthorized();
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
  };

  // memory only: never stored, logged or put in an error
  let session: Crumb | null = null;

  // before each request of a task that makes several: shutdown, the
  // caller's deadline and a back-off another call set all hold it
  const ready = (run: RunOptions) => {
    if (calls.isClosed()) throw new QueueClosed();
    if (run.live !== undefined && !run.live()) throw new DeadlinePassed();
    const paused = calls.backoff();
    if (paused !== null) throw new Paused(paused.after);
  };

  // fc.yahoo.com sets the cookie whatever its status, often a 404
  const newSession = async (run: RunOptions): Promise<Crumb> => {
    ready(run);
    const fc = await send(COOKIE_URL, {}, "manual");
    if (fc.res.status === 429) throw new SourceError("rate limited");
    const cookie = fc.res.headers
      .getSetCookie()
      .map((c) => c.split(";")[0]!.trim())
      .filter((c) => c.includes("="))
      .join("; ");
    if (cookie === "") throw new SourceError("source error", "no cookie");
    ready(run);
    const answer = await send(`${host}/v1/test/getcrumb`, { Cookie: cookie });
    if (answer.res.status === 429) throw new SourceError("rate limited");
    const crumb = answer.raw.trim();
    if (!answer.res.ok || !CRUMB.test(crumb)) {
      throw new SourceError("source error", "no crumb");
    }
    return { cookie, crumb };
  };

  const summaryUrl = (symbol: string, modules: string, crumb: string) =>
    `${SUMMARY_HOST}/v10/finance/quoteSummary/${encodeURIComponent(symbol)}?modules=${modules}&crumb=${encodeURIComponent(crumb)}`;

  // A refused session is asked again once. One queued task whose failure
  // comes back as a value, so it never backs off the queue prices share.
  const summary = <T extends { symbol: string }>(
    symbol: string,
    modules: string,
    parse: (body: unknown, fetchedAt: number) => T,
    run: RunOptions,
  ) =>
    calls
      .run(async (): Promise<{ answer: T } | { error: unknown }> => {
        const ask = async (): Promise<T> => {
          const s = session ?? (await newSession(run));
          session = s;
          ready(run);
          try {
            return await call(summaryUrl(symbol, modules, s.crumb), parse, {
              Cookie: s.cookie,
            });
          } catch (error) {
            if (error instanceof Unauthorized && session === s) session = null;
            throw error;
          }
        };
        try {
          let answer: T;
          try {
            answer = await ask();
          } catch (error) {
            if (!(error instanceof Unauthorized)) throw error;
            answer = await ask();
          }
          // an answer naming another listing is not this one's
          if (answer.symbol.toUpperCase() !== symbol.toUpperCase()) {
            throw malformed("another symbol");
          }
          return { answer };
        } catch (error) {
          return { error };
        }
      }, run)
      .then((r) => {
        if ("error" in r) throw r.error;
        return r.answer;
      });

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
        // that batch fails whole; Yahoo refusing one lone symbol is about
        // that symbol, but refusing a whole half is the source again
        const narrow = async (symbols: string[]) => {
          const mid = Math.ceil(symbols.length / 2);
          const halves = [symbols.slice(0, mid), symbols.slice(mid)];
          const tries = [];
          for (const half of halves) tries.push(await ask(half));
          const down = (e: unknown, half: string[]) =>
            brokenBy(e) && !(e instanceof SparkRefused && half.length === 1);
          if (
            tries.every(
              (t, k) => t.answer === undefined && down(t.error, halves[k]!),
            )
          ) {
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
      valuation: (symbol) =>
        summary(symbol, "defaultKeyStatistics,price", parseSummary, run),
      topHoldings: (symbol) =>
        summary(symbol, "topHoldings,price", parseTopHoldings, run),
      failFast: () => client({ failFast: true }),
      within: (live) => client({ failFast: true, live }),
      backoff: () => calls.backoff(),
    };
  };
  return client({});
}
