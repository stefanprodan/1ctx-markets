// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Yahoo's answers into instruments, bars, splits and quotes. The jobs
// that call these on a schedule live elsewhere.

import {
  type Bar,
  dailyRange,
  rebuildWeeks,
  replaceDailyBars,
  upsertBars,
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
import { SourceError } from "../source.ts";
import { addDays, dateOfWall, startOfDate } from "../zone.ts";
import {
  type ChartAnswer,
  type ChartMeta,
  SOURCE,
  type SparkAnswer,
  type Yahoo,
} from "./client.ts";
import { keyOf, marketOf, symbolOf } from "./resolve.ts";

export type YahooContext = { db: Db; clock: Clock; yahoo: Yahoo };

export const BACKFILL_YEARS = 10;
export const REFETCH_DAYS = 30;

// Daily bars dated in the exchange's zone. The row Yahoo ends some
// answers with, stamped at the last trade, merges into the bar of its
// local date when that is the answer's session date, a closing auction
// after the end included; otherwise it moves the quote only (EURUSD=X
// on Sunday while its session is Friday's). Null closes are no bar.
export function dailyBars(answer: ChartAnswer, latest: Session | null): Bar[] {
  const zone = answer.session.zone;
  const current = sessionDate(answer.session);
  const byDate = new Map<string, Bar>();
  answer.rows.forEach((row, i) => {
    const date = barDate(zone, row.at);
    const trailing = i === answer.rows.length - 1 && row.at === answer.time;
    if (trailing && date !== current) return;
    if (row.close === null) return;
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
      return;
    }
    bar.open ??= row.open;
    bar.high = maxOf(bar.high, row.high);
    bar.low = minOf(bar.low, row.low);
    bar.close = row.close;
    // both are the day's volume, one later than the other
    bar.volume = maxOf(bar.volume, row.volume);
  });
  return [...byDate.values()];
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
// replaces every daily bar, so none keeps a scale from before a split.
function store(
  ctx: YahooContext,
  instrument: Instrument,
  answer: ChartAnswer,
  whole: { since: string; splits: readonly ChartAnswer[] } | null,
): number {
  const { db, clock } = ctx;
  return db.transaction(() => {
    recordSession(db, instrument.market, answer.session, answer.fetchedAt);
    const latest = readSession(db, instrument.market);
    let bars = dailyBars(answer, latest);
    let rows: number;
    if (whole) {
      bars = bars.filter((b) => b.date >= whole.since);
      // an empty answer never wipes a stored history
      if (bars.length === 0 && dailyRange(db, instrument.id) !== null) {
        throw new SourceError("malformed answer", "a history without bars");
      }
      rows = replaceDailyBars(db, instrument.id, bars, answer.fetchedAt);
      recordSplits(db, instrument, whole.splits, clock.now());
      rebuildWeeks(db, instrument.id, latest, clock.now());
    } else {
      rows = upsertBars(db, instrument.id, "1d", bars, answer.fetchedAt);
      const first = bars[0]?.date;
      if (first !== undefined) {
        rebuildWeeks(db, instrument.id, latest, clock.now(), first);
      }
    }
    return rows;
  })();
}

// Adds an instrument by Yahoo's symbol with ten years of daily bars;
// the chart answer names its key, which must match one resolved first.
export async function addInstrument(
  ctx: YahooContext,
  sourceSymbol: string,
  expected: string | null = null,
): Promise<{ instrument: Instrument; rows: number }> {
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
    return { instrument, rows: await backfill(ctx, instrument, [answer]) };
  }
  const rows = store(ctx, instrument, answer, {
    since: monday,
    splits: [answer],
  });
  return { instrument, rows };
}

// Ten years of daily bars again, or from the first stored bar if that
// is older, so after a split no stored bar keeps its old scale.
export async function backfill(
  ctx: YahooContext,
  instrument: Instrument,
  triggers: readonly ChartAnswer[] = [],
): Promise<number> {
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
): Promise<number> {
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
): Promise<{ quotes: QuoteRow[]; errors: unknown[] }> {
  const batches = await ctx.yahoo.sparkAll(
    instruments.map((i) => i.sourceSymbol),
  );
  const quotes: QuoteRow[] = [];
  const errors: unknown[] = [];
  for (const batch of batches) {
    if (batch.answer) quotes.push(...storeQuotes(ctx.db, batch.answer));
    else errors.push(batch.error);
  }
  return { quotes, errors };
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
