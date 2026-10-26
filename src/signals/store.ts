// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// every write here runs inside a writer transaction

import { type Interval, readBars, type Bar as StoredBar } from "../bars.ts";
import { SOURCE as BVB } from "../bvb/client.ts";
import { CRYPTO, readSession, sessionDate, weekOf } from "../calendars.ts";
import { MINUTE_MS } from "../clock.ts";
import type { Db } from "../db/index.ts";
import type { Instrument } from "../instruments.ts";
import { localDate } from "../zone.ts";
import { type DailyRow, dailySeries, liveDaily } from "./daily.ts";
import { liveWeekly, type WeeklyRow, weeklySeries } from "./weekly.ts";

type DailyKey = Exclude<keyof DailyRow, "date">;
type WeeklyKey = Exclude<keyof WeeklyRow, "date">;

// every row field's column, so a field added to the maths fails here
export const DAILY_COLUMNS: { readonly [K in DailyKey]: string } = {
  sma50: "sma50",
  sma200: "sma200",
  cross: "cross",
  crossEdge: "cross_edge",
  ema20: "ema20",
  rsi14: "rsi14",
  macd: "macd",
  macdSignal: "macd_signal",
  macdHistogram: "macd_histogram",
  macdTurn: "macd_turn",
  atr14: "atr14",
  moveAtr: "move_atr",
  volatility20: "volatility20",
  bollingerLower: "bollinger_lower",
  high52w: "high52w",
  low52w: "low52w",
  drawdown: "drawdown",
  fromLow: "from_low",
  daysSinceHigh: "days_since_high",
  volumeRatio: "volume_ratio",
  ema12: "ema12",
  ema26: "ema26",
  rsiGain: "rsi_gain",
  rsiLoss: "rsi_loss",
  prevHistogram: "prev_histogram",
};

export const WEEKLY_COLUMNS: { readonly [K in WeeklyKey]: string } = {
  sma50: "sma50",
  sma200: "sma200",
  cross: "cross",
  crossEdge: "cross_edge",
};

export type Kind = "final" | "live";

const columnsOf = (interval: Interval): [string, string][] =>
  Object.entries(interval === "1d" ? DAILY_COLUMNS : WEEKLY_COLUMNS);

// the select list naming each column by its row field
export const selectList = (interval: Interval): string =>
  columnsOf(interval)
    .map(([key, column]) => `${column} as ${key}`)
    .join(", ");

// 52 calendar weeks of a market trading daily, and 200 bars for SMA 200
export const LIVE_DAYS = 400;
// SMA 200 on weeks
export const LIVE_WEEKS = 200;

function insertRows(
  db: Db,
  instrument: string,
  interval: Interval,
  kind: Kind,
  rows: readonly ({ date: string } & Partial<Record<DailyKey, unknown>>)[],
  quoteTime: number | null,
  now: number,
): void {
  const cols = columnsOf(interval);
  const insert = db.query(
    `insert into signals (instrument, interval, date, kind,
       ${cols.map(([, c]) => c).join(", ")}, quote_time, computed_at)
     values (${Array(cols.length + 6)
       .fill("?")
       .join(", ")})`,
  );
  for (const row of rows) {
    const values = cols.map(
      ([key]) => (row[key as DailyKey] ?? null) as number | null,
    );
    insert.run(instrument, interval, row.date, kind, ...values, quoteTime, now);
  }
}

// only final bars make final rows, and a series never skips a day
export function finalPrefix<T extends { final: boolean }>(
  bars: readonly T[],
): T[] {
  const k = bars.findIndex((b) => !b.final);
  return k === -1 ? [...bars] : bars.slice(0, k);
}

// the dates the Bucharest feed's volumes change scale on: its splits,
// since it keeps volumes raw beside adjusted prices
function volumeBreaks(db: Db, instrument: string): string[] {
  return db
    .query<{ date: string }, [string, string]>(
      `select s.date from splits s join instruments i on i.id = s.instrument
       where s.instrument = ? and i.source = ? order by s.date`,
    )
    .all(instrument, BVB)
    .map((r) => r.date);
}

// from the first bar: an incremental patch would drift from the seeds
export function recomputeSignals(db: Db, instrument: string, now: number) {
  const days = finalPrefix(readBars(db, instrument, "1d"));
  const weeks = finalPrefix(readBars(db, instrument, "1wk"));
  db.query("delete from signals where instrument = ? and kind = 'final'").run(
    instrument,
  );
  const breaks = volumeBreaks(db, instrument);
  insertRows(
    db,
    instrument,
    "1d",
    "final",
    dailySeries(days, breaks),
    null,
    now,
  );
  insertRows(db, instrument, "1wk", "final", weeklySeries(weeks), null, now);
}

type Span = { n: number; last: string | null };

function span(db: Db, sql: string, instrument: string, interval: Interval) {
  return db
    .query<Span, [string, string]>(sql)
    .get(instrument, interval) as Span;
}

export function finalPending(db: Db, instrument: string): boolean {
  for (const interval of ["1d", "1wk"] as const) {
    const bars = span(
      db,
      `select count(*) as n, max(date) as last from bars
       where instrument = ? and interval = ? and final = 1`,
      instrument,
      interval,
    );
    const rows = span(
      db,
      `select count(*) as n, max(date) as last from signals
       where instrument = ? and interval = ? and kind = 'final'`,
      instrument,
      interval,
    );
    if (bars.n !== rows.n || bars.last !== rows.last) return true;
  }
  return false;
}

function lastFinalDate(
  db: Db,
  instrument: string,
  interval: Interval,
): string | null {
  return span(
    db,
    `select count(*) as n, max(date) as last from signals
     where instrument = ? and interval = ? and kind = 'final'`,
    instrument,
    interval,
  ).last;
}

type Scoped = Pick<Instrument, "id" | "market">;

// final rows first, so at a rollover the live row steps from yesterday's
export function signalsAfterBars(
  db: Db,
  instrument: Scoped,
  changedFrom: string | null,
  now: number,
): void {
  const last = lastFinalDate(db, instrument.id, "1d");
  const changed = changedFrom !== null && last !== null && changedFrom <= last;
  if (changed || finalPending(db, instrument.id)) {
    recomputeSignals(db, instrument.id, now);
  }
  refreshLive(db, instrument, now);
}

export type LiveQuote = {
  price: number;
  dayHigh: number | null;
  dayLow: number | null;
  volume: number | null;
  time: number;
};

// a closing auction prints late; keep it covering closeQuoteAt's 15 minutes
export const LIVE_AFTER_END_MS = 15 * MINUTE_MS;

// dated by the market's stored session, never UTC hours; crypto's by UTC day
export function liveTarget(
  db: Db,
  instrument: Scoped,
): { date: string; quote: LiveQuote } | null {
  const row = db
    .query<
      Omit<LiveQuote, "time"> & { time: number | null; fetchedAt: number },
      [string]
    >(
      `select price, day_high as dayHigh, day_low as dayLow, volume, time,
         fetched_at as fetchedAt
       from quotes where instrument = ?`,
    )
    .get(instrument.id);
  if (row === null) return null;
  const session =
    instrument.market === CRYPTO ? null : readSession(db, instrument.market);
  // an index page gives no trade time and is current while its market
  // trades, so its fetch, at most the session's end, dates the live row;
  // the quote keeps no time
  const { fetchedAt, ...rest } = row;
  const quote: LiveQuote = {
    ...rest,
    time:
      row.time ??
      (session === null ? fetchedAt : Math.min(fetchedAt, session.end)),
  };
  if (instrument.market === CRYPTO) {
    return { date: localDate("UTC", quote.time), quote };
  }
  if (
    session === null ||
    quote.time < session.start ||
    quote.time > session.end + LIVE_AFTER_END_MS
  ) {
    return null;
  }
  return { date: sessionDate(session), quote };
}

function recent(
  db: Db,
  instrument: string,
  interval: Interval,
  n: number,
): StoredBar[] {
  return db
    .query<
      Omit<StoredBar, "final"> & { final: number },
      [string, string, number]
    >(
      `select date, open, high, low, close, volume, final from bars
       where instrument = ? and interval = ? order by date desc limit ?`,
    )
    .all(instrument, interval, n)
    .reverse()
    .map((b) => ({ ...b, final: b.final === 1 }));
}

function lastFinalRow<T>(
  db: Db,
  instrument: string,
  interval: Interval,
): (T & { date: string }) | null {
  return (
    db
      .query<T & { date: string }, [string, string]>(
        `select date, ${selectList(interval)} from signals
         where instrument = ? and interval = ? and kind = 'final'
         order by date desc limit 1`,
      )
      .get(instrument, interval) ?? null
  );
}

// an earlier bar not final runs the series as stored: live never waits on bars
function liveBase<T extends { date: string }>(
  db: Db,
  instrument: string,
  interval: Interval,
  date: string,
  n: number,
  series: (bars: StoredBar[]) => T[],
): { bars: StoredBar[]; last: T | null; replacesLast: boolean } | null {
  const bars = recent(db, instrument, interval, n);
  if (bars.length === 0) return null;
  const tail = bars.at(-1)!;
  if (tail.date > date) return null;
  const replacesLast = tail.date === date;
  if (replacesLast && tail.final) return null;
  const base = replacesLast ? bars.slice(0, -1) : bars;
  const last = lastFinalRow<T>(db, instrument, interval);
  if (
    base.every((b) => b.final) &&
    (last?.date ?? null) === (base.at(-1)?.date ?? null)
  ) {
    return { bars, last, replacesLast };
  }
  const all = readBars(db, instrument, interval);
  const rows = series(replacesLast ? all.slice(0, -1) : all);
  return { bars: all, last: rows.at(-1) ?? null, replacesLast };
}

function replaceLive(
  db: Db,
  instrument: string,
  interval: Interval,
  row: { date: string } | null,
  quoteTime: number,
  now: number,
): void {
  db.query(
    "delete from signals where instrument = ? and interval = ? and kind = 'live'",
  ).run(instrument, interval);
  if (row !== null) {
    insertRows(db, instrument, interval, "live", [row], quoteTime, now);
  }
}

export function refreshLive(db: Db, instrument: Scoped, now: number): void {
  const target = liveTarget(db, instrument);
  if (target === null) {
    db.query("delete from signals where instrument = ? and kind = 'live'").run(
      instrument.id,
    );
    return;
  }
  const { date, quote } = target;
  const breaks = volumeBreaks(db, instrument.id);
  const day = liveBase<DailyRow>(
    db,
    instrument.id,
    "1d",
    date,
    LIVE_DAYS + 1,
    (bars) => dailySeries(bars, breaks),
  );
  const dayRow =
    day === null
      ? null
      : liveDaily(
          day.bars,
          day.last,
          quote,
          { date, replacesLast: day.replacesLast },
          breaks,
        );
  replaceLive(db, instrument.id, "1d", dayRow, quote.time, now);
  const monday = weekOf(date);
  const week = liveBase<WeeklyRow>(
    db,
    instrument.id,
    "1wk",
    monday,
    LIVE_WEEKS + 1,
    weeklySeries,
  );
  const weekRow =
    week === null
      ? null
      : liveWeekly(week.bars, week.last, quote.price, {
          date: monday,
          replacesLast: week.replacesLast,
        });
  replaceLive(db, instrument.id, "1wk", weekRow, quote.time, now);
}

export function pruneLive(db: Db, instrument: Scoped, now: number): void {
  const target = liveTarget(db, instrument);
  const dates = db
    .query<{ date: string }, [string]>(
      `select date from signals where instrument = ? and kind = 'live'
       and interval = '1d'`,
    )
    .all(instrument.id)
    .map((r) => r.date);
  if (target === null ? dates.length > 0 : !dates.includes(target.date)) {
    refreshLive(db, instrument, now);
  }
}
