// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Yahoo's answers into instruments, bars, splits and quotes. The jobs
// that call these on a schedule live elsewhere.

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
  upsertInstrument,
} from "../instruments.ts";
import { type Phrase, SourceError } from "../source.ts";
import { addDays, dateOfWall, startOfDate, wallTime } from "../zone.ts";
import {
  type ChartAnswer,
  type ChartMeta,
  type ChartRow,
  SOURCE,
  type SparkAnswer,
  type Yahoo,
} from "./client.ts";
import { keyOf, marketOf, symbolOf } from "./resolve.ts";

export type YahooContext = { db: Db; clock: Clock; yahoo: Yahoo };

export const BACKFILL_YEARS = 10;
export const REFETCH_DAYS = 30;
// a history starting this much later than asked, and later than the
// stored one, is cut short, not a listing that began then
const SHORT_HISTORY_DAYS = 10;

const timeOfDay = (zone: string, at: number) =>
  ((wallTime(zone, at) % DAY_MS) + DAY_MS) % DAY_MS;

type Read = {
  bars: Bar[];
  // the dates of the source's regular rows, null closes included
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
    zone: answer.session.zone,
  };
}

const storedSplits = (db: Db, instrument: string): Set<string> =>
  new Set(
    db
      .query<{ date: string }, [string]>(
        "select date from splits where instrument = ?",
      )
      .all(instrument)
      .map((r) => r.date),
  );

function recordSplits(
  db: Db,
  instrument: Instrument,
  answers: readonly ChartAnswer[],
  now: number,
): void {
  const insert = db.query(
    `insert into splits (instrument, date, numerator, denominator, ratio,
       applied_at)
     values (?, ?, ?, ?, ?, ?)
     on conflict (instrument, date) do nothing`,
  );
  for (const answer of answers) {
    for (const s of answer.splits) {
      insert.run(
        instrument.id,
        barDate(instrument.zone, s.at),
        s.numerator,
        s.denominator,
        s.ratio,
        now,
      );
    }
  }
}

// Writes one chart answer's session, bars and weeks. A whole history
// replaces every daily bar, so none keeps a scale from before a split,
// unless it is cut short against the stored one; then nothing is
// written, the splits stay unapplied, and the next run asks again. A
// window drops the stored days inside its span that the source no
// longer has.
function store(
  ctx: YahooContext,
  instrument: Instrument,
  answer: ChartAnswer,
  whole: { since: string; splits: readonly ChartAnswer[] } | null,
): Written {
  const { db, clock } = ctx;
  return db.transaction((): Written => {
    recordSession(db, instrument.market, answer.session, answer.fetchedAt);
    const latest = readSession(db, instrument.market);
    const { bars, days } = read(answer, latest);
    if (whole) {
      const kept = bars.filter((b) => b.date >= whole.since);
      const range = dailyRange(db, instrument.id);
      if (range !== null) {
        const first = kept[0]?.date;
        if (
          first === undefined ||
          (first > addDays(whole.since, SHORT_HISTORY_DAYS) &&
            range.first < addDays(first, -SHORT_HISTORY_DAYS))
        ) {
          throw new SourceError("malformed answer", "a history cut short");
        }
      }
      const keep = new Set([...days].filter((d) => d >= whole.since));
      const deleted = deleteDailyBars(
        db,
        instrument.id,
        "0000-01-01",
        "9999-12-31",
        keep,
      );
      const written = upsertBars(
        db,
        instrument.id,
        "1d",
        kept,
        answer.fetchedAt,
      );
      recordSplits(db, instrument, whole.splits, clock.now());
      rebuildWeeks(db, instrument.id, latest, clock.now());
      return {
        rows: written.rows,
        changedFrom: earliest(deleted, written.changedFrom),
      };
    }
    const written = upsertBars(db, instrument.id, "1d", bars, answer.fetchedAt);
    const span = [...days].sort();
    let deleted: string | null = null;
    if (span.length > 0) {
      deleted = deleteDailyBars(
        db,
        instrument.id,
        span[0]!,
        span.at(-1)!,
        days,
      );
      rebuildWeeks(db, instrument.id, latest, clock.now(), span[0]!);
    }
    return {
      rows: written.rows,
      changedFrom: earliest(deleted, written.changedFrom),
    };
  })();
}

// Adds an instrument by Yahoo's symbol with ten years of daily bars;
// the chart answer names its key, which must match one resolved first.
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
  const range = dailyRange(ctx.db, id);
  const instrument = upsertInstrument(ctx.db, fields(answer), ctx.clock.now());
  // a history older than ten years is kept, so it is fetched whole
  if (range !== null && range.first < monday) {
    return { instrument, ...(await backfill(ctx, instrument, [answer])) };
  }
  const written = store(ctx, instrument, answer, {
    since: monday,
    splits: [answer],
  });
  return { instrument, ...written };
}

// Ten years of daily bars again, or from the first stored bar if that
// is older, so after a split no stored bar keeps its old scale.
export async function backfill(
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
  return store(ctx, instrument, answer, {
    since: monday,
    splits: [answer, ...triggers],
  });
}

// The last 30 days, or from the last final bar after a longer gap. A
// split not applied yet refetches the whole history once; one already
// applied, still inside the window for a month, does nothing more.
export async function refetch(
  ctx: YahooContext,
  instrument: Instrument,
): Promise<Written> {
  const { db, clock } = ctx;
  const range = dailyRange(db, instrument.id);
  if (range === null) return backfill(ctx, instrument);
  const now = clock.now();
  const since = range.lastFinal ?? range.first;
  const from = Math.min(
    now - REFETCH_DAYS * DAY_MS,
    startOfDate(instrument.zone, since),
  );
  const answer = await ctx.yahoo.chart(instrument.sourceSymbol, from, now);
  checkAnswer(instrument, answer);
  const applied = storedSplits(db, instrument.id);
  const fresh = answer.splits.some(
    (s) => !applied.has(barDate(instrument.zone, s.at)),
  );
  if (fresh) return backfill(ctx, instrument, [answer]);
  return store(ctx, instrument, answer, null);
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
// a quote older than the stored one is kept out.
export function storeQuotes(db: Db, answer: SparkAnswer): QuoteRow[] {
  return db.transaction(() => {
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
       where excluded.time >= quotes.time`,
    );
    for (const meta of answer.quotes) {
      recordSession(
        db,
        marketOf(meta.exchange),
        meta.session,
        answer.fetchedAt,
      );
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
  })();
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
  const quotes: QuoteRow[] = [];
  const skipped: { symbol: string | null; phrase: Phrase }[] = [];
  const errors: unknown[] = [];
  for (const batch of batches) {
    if (batch.answer) {
      quotes.push(...storeQuotes(ctx.db, batch.answer));
      skipped.push(...batch.answer.skipped);
    } else {
      errors.push(batch.error);
    }
  }
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
