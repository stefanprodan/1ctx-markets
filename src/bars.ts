// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Daily bars as the source gives them, and weekly bars built from the
// stored daily ones, never fetched: an open crypto week from Yahoo
// holds Monday to Saturday only.

import { isWeekFinal, type Session, weekOf } from "./calendars.ts";
import type { Db } from "./db/index.ts";

export type Interval = "1d" | "1wk";

export type Bar = {
  // the exchange's date; a week's Monday
  date: string;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number;
  volume: number | null;
  final: boolean;
};

type Row = Omit<Bar, "final"> & { final: number };

export function readBars(
  db: Db,
  instrument: string,
  interval: Interval,
  from = "",
): Bar[] {
  return db
    .query<Row, [string, string, string]>(
      `select date, open, high, low, close, volume, final from bars
       where instrument = ? and interval = ? and date >= ? order by date`,
    )
    .all(instrument, interval, from)
    .map((r) => ({ ...r, final: r.final === 1 }));
}

export function dailyRange(
  db: Db,
  instrument: string,
): { first: string; last: string; lastFinal: string | null } | null {
  const row = db
    .query<
      { first: string | null; last: string; lastFinal: string | null },
      [string]
    >(
      `select min(date) as first, max(date) as last,
         max(case when final = 1 then date end) as lastFinal
       from bars where instrument = ? and interval = '1d'`,
    )
    .get(instrument);
  return row?.first
    ? { first: row.first, last: row.last, lastFinal: row.lastFinal }
    : null;
}

const volumeOf = (v: number | null): number | null =>
  v === null ? null : Math.round(v);

// what a write did: the rows it was given, and the earliest date whose
// stored values changed, for whatever is computed from past bars
export type Written = { rows: number; changedFrom: string | null };

export const earliest = (a: string | null, b: string | null) =>
  a === null ? b : b === null ? a : a < b ? a : b;

type Stored = Omit<Bar, "final"> & { final: number };

const sameValues = (a: Stored, b: Bar) =>
  a.open === b.open &&
  a.high === b.high &&
  a.low === b.low &&
  a.close === b.close &&
  a.volume === volumeOf(b.volume);

// The source's values replace the stored ones, corrections included; a
// row is written only when it changes, and a final row stays final.
export function upsertBars(
  db: Db,
  instrument: string,
  interval: Interval,
  bars: readonly Bar[],
  fetchedAt: number,
): Written {
  const read = db.query<Stored, [string, string, string]>(
    `select date, open, high, low, close, volume, final from bars
     where instrument = ? and interval = ? and date = ?`,
  );
  const insert = db.query(
    `insert into bars (instrument, interval, date, open, high, low, close,
       volume, final, fetched_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const update = db.query(
    `update bars set open = ?, high = ?, low = ?, close = ?, volume = ?,
       final = ?, fetched_at = ?
     where instrument = ? and interval = ? and date = ?`,
  );
  let changedFrom: string | null = null;
  for (const b of bars) {
    const stored = read.get(instrument, interval, b.date);
    const final = b.final || stored?.final === 1 ? 1 : 0;
    const values = [b.open, b.high, b.low, b.close, volumeOf(b.volume)];
    if (stored === null) {
      insert.run(instrument, interval, b.date, ...values, final, fetchedAt);
      changedFrom = earliest(changedFrom, b.date);
    } else if (!sameValues(stored, b)) {
      update.run(...values, final, fetchedAt, instrument, interval, b.date);
      changedFrom = earliest(changedFrom, b.date);
    } else if (final !== stored.final) {
      update.run(...values, final, fetchedAt, instrument, interval, b.date);
    }
  }
  return { rows: bars.length, changedFrom };
}

// Deletes the daily bars from from to to, both included, that are not
// in keep: a day the source has no bar for had no trading. Answers the
// earliest date deleted.
export function deleteDailyBars(
  db: Db,
  instrument: string,
  from: string,
  to: string,
  keep: ReadonlySet<string>,
): string | null {
  const gone = db
    .query<{ date: string }, [string, string, string]>(
      `select date from bars where instrument = ? and interval = '1d'
       and date >= ? and date <= ? order by date`,
    )
    .all(instrument, from, to)
    .filter((r) => !keep.has(r.date));
  const del = db.query(
    "delete from bars where instrument = ? and interval = '1d' and date = ?",
  );
  for (const r of gone) del.run(instrument, r.date);
  return gone[0]?.date ?? null;
}

// Monday to Sunday by the exchange's date; final once the week's Sunday
// has ended in its zone and its last daily bar is final.
export function weeksOf(
  days: readonly Bar[],
  latest: Session | null,
  now: number,
): Bar[] {
  const weeks = new Map<string, Bar[]>();
  for (const day of days) {
    const monday = weekOf(day.date);
    const week = weeks.get(monday);
    if (week) week.push(day);
    else weeks.set(monday, [day]);
  }
  const out: Bar[] = [];
  for (const [monday, list] of weeks) {
    list.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    const last = list[list.length - 1]!;
    const highs = list.flatMap((d) => (d.high === null ? [] : [d.high]));
    const lows = list.flatMap((d) => (d.low === null ? [] : [d.low]));
    const volumes = list.flatMap((d) => (d.volume === null ? [] : [d.volume]));
    out.push({
      date: monday,
      open: list[0]!.open,
      high: highs.length > 0 ? Math.max(...highs) : null,
      low: lows.length > 0 ? Math.min(...lows) : null,
      close: last.close,
      volume: volumes.length > 0 ? volumes.reduce((a, b) => a + b, 0) : null,
      final:
        latest !== null &&
        list.every((d) => d.final) &&
        isWeekFinal(monday, last.date, latest, now),
    });
  }
  return out.sort((a, b) => (a.date < b.date ? -1 : 1));
}

// Rebuilds the weeks from the one holding from, or all of them; a week
// whose days are gone goes too.
export function rebuildWeeks(
  db: Db,
  instrument: string,
  latest: Session | null,
  now: number,
  from = "",
): number {
  const monday = from === "" ? "" : weekOf(from);
  const weeks = weeksOf(readBars(db, instrument, "1d", monday), latest, now);
  db.query(
    "delete from bars where instrument = ? and interval = '1wk' and date >= ?",
  ).run(instrument, monday);
  return upsertBars(db, instrument, "1wk", weeks, now).rows;
}
