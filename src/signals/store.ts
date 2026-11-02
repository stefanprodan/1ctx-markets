// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// every write here runs inside a writer transaction

import {
  type Interval,
  readBars,
  type Bar as StoredBar,
} from "../market/bars.ts";
import { weekOf } from "../market/calendars.ts";
import { readInstrument } from "../market/instruments.ts";
import { BVB } from "../sources/ids.ts";
import type { Db } from "../storage/db/index.ts";
import { finalPrefix, instrumentSide, returnsOf } from "./closes.ts";
import { type DailyRow, dailySeries, liveDaily } from "./daily.ts";
import { earliestStart } from "./relative.ts";
import { liveTarget, type Scoped } from "./target.ts";
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
  storeReturns(db, instrument);
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
  liveRows(db, instrument, now);
  storeReturns(db, instrument.id);
}

function liveRows(db: Db, instrument: Scoped, now: number): void {
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

// The live row, else the last final: 'live' sorts after 'final', so the
// primary key read backwards finds it at its first row.
const latestOf = (id: string) => `(select kind, date from signals x
  where x.instrument = ${id} and x.interval = '1d'
  order by x.kind desc, x.date desc limit 1)`;

// joins s to instrument i's latest daily row
export const LATEST_DAILY = `s.instrument = i.id and s.interval = '1d'
  and (s.kind, s.date) = ${latestOf("i.id")}`;

// On the newest daily row only, the one a list reads, through returnsOf,
// so they equal the quote tool's.
function storeReturns(db: Db, id: string): void {
  const i = readInstrument(db, id);
  if (i === null) return;
  const r = returnsOf(instrumentSide(db, i, null, earliestStart));
  db.query(
    `update signals set return_1m = ?2, return_1y = ?3
     where instrument = ?1 and interval = '1d'
       and (kind, date) = ${latestOf("?1")}`,
  ).run(id, r?.["1m"] ?? null, r?.["1y"] ?? null);
}

// Rows written before the returns were stored get theirs at start, not
// at the next pass, which for a closed market is the next day's. Driven
// by instrument, so a start reads one row of each.
export function fillReturns(db: Db): void {
  const ids = db
    .query<{ id: string }, []>(
      `select i.id from instruments i
       where (select x.return_1m is null and x.return_1y is null
         from signals x where x.instrument = i.id and x.interval = '1d'
         order by x.kind desc, x.date desc limit 1)`,
    )
    .all();
  for (const { id } of ids) storeReturns(db, id);
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
