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
): { first: string; lastFinal: string | null } | null {
  const row = db
    .query<{ first: string | null; lastFinal: string | null }, [string]>(
      `select min(date) as first,
         max(case when final = 1 then date end) as lastFinal
       from bars where instrument = ? and interval = '1d'`,
    )
    .get(instrument);
  return row?.first ? { first: row.first, lastFinal: row.lastFinal } : null;
}

const volumeOf = (v: number | null): number | null =>
  v === null ? null : Math.round(v);

// The source's values replace the stored ones, corrections included;
// a final row stays final.
export function upsertBars(
  db: Db,
  instrument: string,
  interval: Interval,
  bars: readonly Bar[],
  fetchedAt: number,
): number {
  const upsert = db.query(
    `insert into bars (instrument, interval, date, open, high, low, close,
       volume, final, fetched_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     on conflict (instrument, interval, date) do update set
       open = excluded.open,
       high = excluded.high,
       low = excluded.low,
       close = excluded.close,
       volume = excluded.volume,
       final = max(bars.final, excluded.final),
       fetched_at = excluded.fetched_at`,
  );
  for (const b of bars) {
    upsert.run(
      instrument,
      interval,
      b.date,
      b.open,
      b.high,
      b.low,
      b.close,
      volumeOf(b.volume),
      b.final ? 1 : 0,
      fetchedAt,
    );
  }
  return bars.length;
}

// for a whole history after a split, so no bar keeps its old scale
export function replaceDailyBars(
  db: Db,
  instrument: string,
  bars: readonly Bar[],
  fetchedAt: number,
): number {
  db.query("delete from bars where instrument = ? and interval = '1d'").run(
    instrument,
  );
  return upsertBars(db, instrument, "1d", bars, fetchedAt);
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
  return upsertBars(db, instrument, "1wk", weeks, now);
}
