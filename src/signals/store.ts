// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Signal rows from the stored bars and quotes. Final rows come only
// from final bars and are recomputed from the first stored bar, since
// the seeds depend on where history starts; the live row steps from
// the last final row with one provisional bar built from the quote.
// Every function here runs inside a writer transaction.

import { type Interval, readBars, type Bar as StoredBar } from "../bars.ts";
import { readSession, sessionDate, weekOf } from "../calendars.ts";
import type { Db } from "../db/index.ts";
import type { Instrument } from "../instruments.ts";
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

// The live row reads this many daily bars back: 52 calendar weeks of a
// market trading every day and 200 bars for SMA 200, the rest stepped
// from the last final row's running values.
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

// The bars up to the first one not final: only final bars make final
// rows, and a series never skips a day.
export function finalPrefix<T extends { final: boolean }>(
  bars: readonly T[],
): T[] {
  const k = bars.findIndex((b) => !b.final);
  return k === -1 ? [...bars] : bars.slice(0, k);
}

// Replaces every final row of the instrument from its first stored bar.
export function recomputeSignals(db: Db, instrument: string, now: number) {
  const days = finalPrefix(readBars(db, instrument, "1d"));
  const weeks = finalPrefix(readBars(db, instrument, "1wk"));
  db.query("delete from signals where instrument = ? and kind = 'final'").run(
    instrument,
  );
  insertRows(db, instrument, "1d", "final", dailySeries(days), null, now);
  insertRows(db, instrument, "1wk", "final", weeklySeries(weeks), null, now);
}

type Span = { n: number; last: string | null };

function span(db: Db, sql: string, instrument: string, interval: Interval) {
  return db
    .query<Span, [string, string]>(sql)
    .get(instrument, interval) as Span;
}

// The final rows lag the final bars: a bar turned final or went away
// since the last recompute.
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

// After a bar write: the final rows again when a past bar changed or a
// bar turned final, then the live rows, so at a session's rollover the
// previous bar's final row comes before the new live row.
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

// What the live row is computed from: the stored quote, dated by its
// market's stored session. A quote traded before that session began
// belongs to an earlier one (CL=F's Friday trade under Sunday's
// session), so there is no live row until the session's first trade.
export function liveTarget(
  db: Db,
  instrument: Scoped,
): { date: string; quote: LiveQuote } | null {
  const quote = db
    .query<LiveQuote, [string]>(
      `select price, day_high as dayHigh, day_low as dayLow, volume, time
       from quotes where instrument = ?`,
    )
    .get(instrument.id);
  const session = readSession(db, instrument.market);
  if (quote === null || session === null || quote.time < session.start) {
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

// The stored bars the provisional one joins: every bar final but one
// on the provisional date, and the last final row on the last final
// bar; null while a bar before it waits to turn final.
function liveBase<T>(
  db: Db,
  instrument: string,
  interval: Interval,
  date: string,
  n: number,
): { bars: StoredBar[]; last: T | null; replacesLast: boolean } | null {
  const bars = recent(db, instrument, interval, n);
  if (bars.length === 0) return null;
  const tail = bars.at(-1)!;
  if (tail.date > date) return null;
  const replacesLast = tail.date === date;
  if (replacesLast && tail.final) return null;
  const base = replacesLast ? bars.slice(0, -1) : bars;
  if (base.some((b) => !b.final)) return null;
  const last = lastFinalRow<T>(db, instrument, interval);
  if ((last?.date ?? null) !== (base.at(-1)?.date ?? null)) return null;
  return { bars, last, replacesLast };
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

// The live daily and weekly rows from the stored quote. With no quote
// of the current session there is none; while a bar before the
// session's waits to turn final, the old row stays and reads pending.
export function refreshLive(db: Db, instrument: Scoped, now: number): void {
  const target = liveTarget(db, instrument);
  if (target === null) {
    db.query("delete from signals where instrument = ? and kind = 'live'").run(
      instrument.id,
    );
    return;
  }
  const { date, quote } = target;
  const day = liveBase<DailyRow>(db, instrument.id, "1d", date, LIVE_DAYS + 1);
  if (day !== null) {
    const row = liveDaily(day.bars, day.last, quote, {
      date,
      replacesLast: day.replacesLast,
    });
    replaceLive(db, instrument.id, "1d", row, quote.time, now);
  }
  const monday = weekOf(date);
  const week = liveBase<WeeklyRow>(
    db,
    instrument.id,
    "1wk",
    monday,
    LIVE_WEEKS + 1,
  );
  if (week !== null) {
    const row = liveWeekly(week.bars, week.last, quote.price, {
      date: monday,
      replacesLast: week.replacesLast,
    });
    replaceLive(db, instrument.id, "1wk", row, quote.time, now);
  }
}
