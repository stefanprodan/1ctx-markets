// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Yahoo's answers into instruments, bars, splits and quotes. Each call
// fetches first and then queues one write; the jobs that call these on
// a schedule live in jobs.ts.

import {
  type Bar,
  dailyRange,
  deleteDailyBars,
  earliest,
  rebuildWeeks,
  upsertBars,
  type Written,
} from "../bars.ts";
import {
  barDate,
  isBarFinal,
  readSession,
  recordSession,
  type Session,
  sessionDate,
  weekOf,
} from "../calendars.ts";
import { type Clock, DAY_MS } from "../clock.ts";
import type { Db } from "../db/index.ts";
import {
  type Instrument,
  readBySourceSymbol,
  type Unit,
  upsertInstrument,
} from "../instruments.ts";
import { type Phrase, SourceError } from "../source.ts";
import type { Writer } from "../writer.ts";
import { addDays, dateOfWall, startOfDate, wallTime } from "../zone.ts";
import {
  type ChartAnswer,
  type ChartMeta,
  type ChartRow,
  SOURCE,
  type SparkAnswer,
  type SplitEvent,
  type Yahoo,
} from "./client.ts";
import { keyOf, marketOf, symbolOf } from "./resolve.ts";

// db is for reads; every write goes through writer
export type YahooContext = {
  db: Db;
  clock: Clock;
  yahoo: Yahoo;
  writer: Writer;
};

export const BACKFILL_YEARS = 10;
export const REFETCH_DAYS = 30;
// a history starting this much later than asked, and later than the
// stored one, is cut short, not a listing that began then
const SHORT_HISTORY_DAYS = 10;

const timeOfDay = (zone: string, at: number) =>
  ((wallTime(zone, at) % DAY_MS) + DAY_MS) % DAY_MS;

type Read = {
  bars: Bar[];
  // the dates of the source's regular rows, null closes included, which
  // bound the span a write reconciles; only bars are kept in it
  days: Set<string>;
};

// Daily bars dated in the exchange's zone. Yahoo ends some answers with
// a row off the bar grid at the last trade; it merges into the regular
// bar of the answer's session date, a closing auction after the end
// included, and never makes a bar of its own (EURUSD=X traded on Sunday
// while its session was Friday's). Null closes are no bar.
function read(answer: ChartAnswer, latest: Session | null): Read {
  const zone = answer.session.zone;
  const rows = answer.rows;
  let trailing: ChartRow | null = null;
  let regular = rows;
  const last = rows.at(-1);
  if (last !== undefined) {
    const grid =
      rows.length > 1
        ? timeOfDay(zone, rows.at(-2)!.at)
        : timeOfDay(zone, answer.session.start);
    if (timeOfDay(zone, last.at) !== grid) {
      trailing = last;
      regular = rows.slice(0, -1);
    }
  }
  const byDate = new Map<string, Bar>();
  const days = new Set<string>();
  for (const row of regular) {
    const date = barDate(zone, row.at);
    days.add(date);
    if (row.close === null) continue;
    const bar = byDate.get(date);
    if (bar === undefined) {
      byDate.set(date, {
        date,
        open: row.open,
        high: row.high,
        low: row.low,
        close: row.close,
        volume: row.volume,
        final: latest !== null && isBarFinal(date, latest),
      });
    } else {
      merge(bar, row);
    }
  }
  if (trailing !== null && trailing.close !== null) {
    const date = barDate(zone, trailing.at);
    const bar = byDate.get(date);
    if (date === sessionDate(answer.session) && bar !== undefined) {
      merge(bar, trailing);
    }
  }
  return { bars: [...byDate.values()], days };
}

function merge(bar: Bar, row: ChartRow): void {
  bar.open ??= row.open;
  bar.high = maxOf(bar.high, row.high);
  bar.low = minOf(bar.low, row.low);
  bar.close = row.close!;
  // both are the day's volume, one later than the other
  bar.volume = maxOf(bar.volume, row.volume);
}

export function dailyBars(answer: ChartAnswer, latest: Session | null): Bar[] {
  return read(answer, latest).bars;
}

const maxOf = (a: number | null, b: number | null) =>
  a === null ? b : b === null ? a : Math.max(a, b);
const minOf = (a: number | null, b: number | null) =>
  a === null ? b : b === null ? a : Math.min(a, b);

// The Monday on or before ten years back, so the first week is whole.
// The UTC date is a day off at most; the day before it covers any zone,
// and bars before the Monday are dropped.
export function backfillStart(now: number): { monday: string; from: number } {
  const today = dateOfWall(now);
  const back = `${Number(today.slice(0, 4)) - BACKFILL_YEARS}${today.slice(4)}`;
  const monday = weekOf(back.endsWith("-02-29") ? addDays(back, -1) : back);
  return { monday, from: Date.parse(`${monday}T00:00:00Z`) - DAY_MS };
}

function checkAnswer(instrument: Instrument, answer: ChartMeta): void {
  const id = keyOf(answer.exchange, answer.symbol);
  if (id !== instrument.id) {
    throw new SourceError(
      "malformed answer",
      `${instrument.id} answered as ${id}`,
    );
  }
}

// Yahoo's INDEX holds both ^VIX's points and ^TNX's percent, and
// FUTURE both per-barrel and per-bond prices, so neither is guessed.
export function unitOf(type: string): Unit {
  switch (type.toUpperCase()) {
    case "EQUITY":
    case "ETF":
    case "MUTUALFUND":
      return "per_share";
    case "CRYPTOCURRENCY":
    case "CURRENCY":
      return "per_unit";
    default:
      return "unknown";
  }
}

function fields(answer: ChartMeta) {
  return {
    market: marketOf(answer.exchange),
    symbol: symbolOf(answer.symbol),
    source: SOURCE,
    sourceSymbol: answer.symbol,
    exchange: answer.exchange,
    name: answer.name,
    type: answer.type,
    currency: answer.currency,
    unit: unitOf(answer.type),
    zone: answer.session.zone,
  };
}

type Split = SplitEvent & { date: string };

// The answers' splits not stored with the same date and ratio: a
// corrected ratio rescales the history as a new split does. A later
// answer's ratio wins.
function unapplied(
  db: Db,
  instrument: Instrument,
  answers: readonly ChartAnswer[],
): Split[] {
  const stored = new Map(
    db
      .query<
        { date: string; numerator: number; denominator: number },
        [string]
      >("select date, numerator, denominator from splits where instrument = ?")
      .all(instrument.id)
      .map((r) => [r.date, r]),
  );
  const out = new Map<string, Split>();
  for (const answer of answers) {
    for (const s of answer.splits) {
      const date = barDate(instrument.zone, s.at);
      const old = stored.get(date);
      if (
        old === undefined ||
        old.numerator !== s.numerator ||
        old.denominator !== s.denominator
      ) {
        out.set(date, { ...s, date });
      }
    }
  }
  return [...out.values()];
}

function recordSplits(
  db: Db,
  instrument: Instrument,
  splits: Split[],
  now: number,
): void {
  const upsert = db.query(
    `insert into splits (instrument, date, numerator, denominator, ratio,
       applied_at)
     values (?, ?, ?, ?, ?, ?)
     on conflict (instrument, date) do update set
       numerator = excluded.numerator,
       denominator = excluded.denominator,
       ratio = excluded.ratio,
       applied_at = excluded.applied_at`,
  );
  for (const s of splits) {
    upsert.run(instrument.id, s.date, s.numerator, s.denominator, s.ratio, now);
  }
}

// An initial history begins near the later of the start asked for and
// the listing's first trade, or it was cut short; with no first trade
// date a late start cannot be told from a recent listing.
function startsShort(answer: ChartAnswer, since: string): boolean {
  if (answer.firstTrade === null) return false;
  const first = read(answer, null).bars.find((b) => b.date >= since)?.date;
  if (first === undefined) return false;
  const listed = barDate(answer.session.zone, answer.firstTrade);
  const floor = listed > since ? listed : since;
  return first > addDays(floor, SHORT_HISTORY_DAYS);
}

const cutShort = () =>
  new SourceError("malformed answer", "a history cut short");

// One fetch-and-store per instrument and database at a time, held
// across the call and its write, so an answer fetched before a split's
// rewrite never lands after it.
const held = new WeakMap<Db, Map<string, Promise<void>>>();

async function exclusive<T>(
  db: Db,
  id: string,
  fn: () => Promise<T>,
): Promise<T> {
  let locks = held.get(db);
  if (locks === undefined) {
    locks = new Map();
    held.set(db, locks);
  }
  const run = (locks.get(id) ?? Promise.resolve()).then(fn);
  const tail = run.then(
    () => {},
    () => {},
  );
  locks.set(id, tail);
  try {
    return await run;
  } finally {
    if (locks.get(id) === tail) locks.delete(id);
  }
}

// Writes one chart answer's session, bars and weeks, inside a writer
// transaction. A whole history rewrites every daily bar, so none keeps
// a scale from before a split, unless it starts or stops well short of
// the stored one, or applies a split without reaching the stored last
// day; then nothing is written, the splits stay unapplied, and the next
// run asks again. Either answer drops the stored days inside its own
// span that the source no longer prices, and a split's whole history
// every stored day before it too.
function store(
  db: Db,
  now: number,
  instrument: Instrument,
  answer: ChartAnswer,
  whole: { since: string; splits: readonly ChartAnswer[] } | null,
): Written {
  recordSession(db, instrument.market, answer.session, answer.fetchedAt);
  const latest = readSession(db, instrument.market);
  const { bars, days } = read(answer, latest);
  if (whole) {
    const kept = bars.filter((b) => b.date >= whole.since);
    const span = [...days].filter((d) => d >= whole.since).sort();
    const splits = unapplied(db, instrument, whole.splits);
    const range = dailyRange(db, instrument.id);
    if (range === null) {
      if (startsShort(answer, whole.since)) throw cutShort();
    } else {
      const first = kept[0]?.date;
      const last = kept.at(-1)?.date;
      if (
        first === undefined ||
        last === undefined ||
        (first > addDays(whole.since, SHORT_HISTORY_DAYS) &&
          range.first < addDays(first, -SHORT_HISTORY_DAYS)) ||
        last < addDays(range.last, -SHORT_HISTORY_DAYS) ||
        (splits.length > 0 && span.at(-1)! < range.last)
      ) {
        throw cutShort();
      }
    }
    const keep = new Set(kept.map((b) => b.date));
    const from = splits.length > 0 ? whole.since : span[0];
    const deleted =
      from === undefined || span.length === 0
        ? null
        : deleteDailyBars(db, instrument.id, from, span.at(-1)!, keep);
    const written = upsertBars(db, instrument.id, "1d", kept, answer.fetchedAt);
    recordSplits(db, instrument, splits, now);
    rebuildWeeks(db, instrument.id, latest, now);
    return {
      rows: written.rows,
      changedFrom: earliest(deleted, written.changedFrom),
    };
  }
  const written = upsertBars(db, instrument.id, "1d", bars, answer.fetchedAt);
  const span = [...days].sort();
  let deleted: string | null = null;
  if (span.length > 0) {
    const keep = new Set(bars.map((b) => b.date));
    deleted = deleteDailyBars(db, instrument.id, span[0]!, span.at(-1)!, keep);
    rebuildWeeks(db, instrument.id, latest, now, span[0]!);
  }
  return {
    rows: written.rows,
    changedFrom: earliest(deleted, written.changedFrom),
  };
}

// Adds an instrument by Yahoo's symbol with ten years of daily bars;
// the chart answer names its key, which must match one resolved first.
// A history cut short adds the instrument alone, for backfill to retry.
export async function addInstrument(
  ctx: YahooContext,
  sourceSymbol: string,
  expected: string | null = null,
): Promise<{ instrument: Instrument } & Written> {
  const { monday, from } = backfillStart(ctx.clock.now());
  const answer = await ctx.yahoo.chart(sourceSymbol, from, ctx.clock.now());
  const id = keyOf(answer.exchange, answer.symbol);
  if (expected !== null && expected !== id) {
    throw new SourceError("malformed answer", `${expected} answered as ${id}`);
  }
  return exclusive(ctx.db, id, async () => {
    // stored bars may be newer than this answer, so they are fetched
    // again under the lock
    if (dailyRange(ctx.db, id) !== null) {
      const instrument = await ctx.writer.write((db) =>
        upsertInstrument(db, fields(answer), ctx.clock.now()),
      );
      return { instrument, ...(await backfillHeld(ctx, instrument)) };
    }
    const short = startsShort(answer, monday);
    // the instrument and its bars land together, or neither does
    return ctx.writer.write((db) => {
      const now = ctx.clock.now();
      const instrument = upsertInstrument(db, fields(answer), now);
      if (short) return { instrument, rows: 0, changedFrom: null };
      const written = store(db, now, instrument, answer, {
        since: monday,
        splits: [answer],
      });
      return { instrument, ...written };
    });
  });
}

// Ten years of daily bars again, or from the first stored bar if that
// is older, so after a split no stored bar keeps its old scale.
export function backfill(
  ctx: YahooContext,
  instrument: Instrument,
): Promise<Written> {
  return exclusive(ctx.db, instrument.id, () => backfillHeld(ctx, instrument));
}

async function backfillHeld(
  ctx: YahooContext,
  instrument: Instrument,
  triggers: readonly ChartAnswer[] = [],
): Promise<Written> {
  const range = dailyRange(ctx.db, instrument.id);
  let { monday, from } = backfillStart(ctx.clock.now());
  if (range !== null && range.first < monday) {
    monday = weekOf(range.first);
    from = startOfDate(instrument.zone, monday);
  }
  const answer = await ctx.yahoo.chart(
    instrument.sourceSymbol,
    from,
    ctx.clock.now(),
  );
  checkAnswer(instrument, answer);
  return ctx.writer.write((db) =>
    store(db, ctx.clock.now(), instrument, answer, {
      since: monday,
      splits: [...triggers, answer],
    }),
  );
}

// The last 30 days, or from the last final bar after a longer gap. A
// split not applied yet, or applied with another ratio, refetches the
// whole history once; one already applied, still inside the window for
// a month, does nothing more.
export function refetch(
  ctx: YahooContext,
  instrument: Instrument,
): Promise<Written> {
  return exclusive(ctx.db, instrument.id, () => refetchHeld(ctx, instrument));
}

async function refetchHeld(
  ctx: YahooContext,
  instrument: Instrument,
): Promise<Written> {
  const { db, clock } = ctx;
  const range = dailyRange(db, instrument.id);
  if (range === null) return backfillHeld(ctx, instrument);
  const now = clock.now();
  const since = range.lastFinal ?? range.first;
  const from = Math.min(
    now - REFETCH_DAYS * DAY_MS,
    startOfDate(instrument.zone, since),
  );
  const answer = await ctx.yahoo.chart(instrument.sourceSymbol, from, now);
  checkAnswer(instrument, answer);
  if (unapplied(db, instrument, [answer]).length > 0) {
    return backfillHeld(ctx, instrument, [answer]);
  }
  return ctx.writer.write((db) =>
    store(db, ctx.clock.now(), instrument, answer, null),
  );
}

export type QuoteRow = {
  instrument: string;
  price: number;
  previousClose: number | null;
  previousCloseField: "previousClose" | "chartPreviousClose" | null;
  change: number | null;
  changePercent: number | null;
  dayHigh: number | null;
  dayLow: number | null;
  volume: number | null;
  time: number;
  source: string;
  fetchedAt: number;
};

// The day change is worked out from price and previous close, never
// Yahoo's own change field, which disagreed with both for SOL-USD.
export function quoteOf(
  instrument: string,
  meta: ChartMeta,
  fetchedAt: number,
): QuoteRow {
  const field =
    meta.previousClose !== null
      ? "previousClose"
      : meta.chartPreviousClose !== null
        ? "chartPreviousClose"
        : null;
  const previousClose = meta.previousClose ?? meta.chartPreviousClose;
  const change = previousClose === null ? null : meta.price - previousClose;
  return {
    instrument,
    price: meta.price,
    previousClose,
    previousCloseField: field,
    change,
    changePercent:
      change === null || previousClose === 0
        ? null
        : (change / previousClose!) * 100,
    dayHigh: meta.dayHigh,
    dayLow: meta.dayLow,
    volume: meta.volume === null ? null : Math.round(meta.volume),
    time: meta.time,
    source: SOURCE,
    fetchedAt,
  };
}

// Each answer's session goes to its market, known instrument or not;
// a quote older than the stored one is kept out, and one as old only
// replaces it when fetched later. Runs inside a writer transaction.
export function storeQuotes(db: Db, answer: SparkAnswer): QuoteRow[] {
  const written: QuoteRow[] = [];
  const upsert = db.query(
    `insert into quotes (instrument, price, previous_close,
       previous_close_field, change, change_percent, day_high, day_low,
       volume, time, source, fetched_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     on conflict (instrument) do update set
       price = excluded.price,
       previous_close = excluded.previous_close,
       previous_close_field = excluded.previous_close_field,
       change = excluded.change,
       change_percent = excluded.change_percent,
       day_high = excluded.day_high,
       day_low = excluded.day_low,
       volume = excluded.volume,
       time = excluded.time,
       source = excluded.source,
       fetched_at = excluded.fetched_at
     where excluded.time > quotes.time
       or (excluded.time = quotes.time
         and excluded.fetched_at > quotes.fetched_at)`,
  );
  for (const meta of answer.quotes) {
    recordSession(db, marketOf(meta.exchange), meta.session, answer.fetchedAt);
    const instrument = readBySourceSymbol(db, SOURCE, meta.symbol);
    if (instrument === null) continue;
    const q = quoteOf(instrument.id, meta, answer.fetchedAt);
    const { changes } = upsert.run(
      q.instrument,
      q.price,
      q.previousClose,
      q.previousCloseField,
      q.change,
      q.changePercent,
      q.dayHigh,
      q.dayLow,
      q.volume,
      q.time,
      q.source,
      q.fetchedAt,
    );
    if (changes > 0) written.push(q);
  }
  return written;
}

// Quotes for these instruments in spark calls of 20; a failed call
// keeps the others' quotes and is answered back.
export async function fetchQuotes(
  ctx: YahooContext,
  instruments: readonly Instrument[],
): Promise<{
  quotes: QuoteRow[];
  skipped: { symbol: string | null; phrase: Phrase }[];
  errors: unknown[];
}> {
  const batches = await ctx.yahoo.sparkAll(
    instruments.map((i) => i.sourceSymbol),
  );
  const skipped: { symbol: string | null; phrase: Phrase }[] = [];
  const errors: unknown[] = [];
  const answers: SparkAnswer[] = [];
  for (const batch of batches) {
    if (batch.answer) {
      answers.push(batch.answer);
      skipped.push(...batch.answer.skipped);
    } else {
      errors.push(batch.error);
    }
  }
  const quotes = await ctx.writer.write((db) =>
    answers.flatMap((answer) => storeQuotes(db, answer)),
  );
  return { quotes, skipped, errors };
}

export function readQuote(db: Db, instrument: string): QuoteRow | null {
  return (
    db
      .query<QuoteRow, [string]>(
        `select instrument, price, previous_close as previousClose,
           previous_close_field as previousCloseField, change,
           change_percent as changePercent, day_high as dayHigh,
           day_low as dayLow, volume, time, source, fetched_at as fetchedAt
         from quotes where instrument = ?`,
      )
      .get(instrument) ?? null
  );
}
