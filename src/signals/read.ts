// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// What the tools read: the latest signal rows with why they may be
// behind, and relative return, computed on read for the benchmark the
// caller names rather than stored for every pair.

import { type Interval, readBars } from "../bars.ts";
import { weekOf } from "../calendars.ts";
import type { Db } from "../db/index.ts";
import { SOURCE as FRED } from "../fred/client.ts";
import { seriesStale } from "../fred/jobs.ts";
import { readInstrument } from "../instruments.ts";
import { barsStale, quoteStale, STALE, type StaleReason } from "../stale.ts";
import type { DailyRow } from "./daily.ts";
import {
  type Listing,
  type RelativeReturn,
  relativeReturn,
} from "./relative.ts";
import {
  finalPending,
  finalPrefix,
  type Kind,
  liveTarget,
  selectList,
} from "./store.ts";
import type { WeeklyRow } from "./weekly.ts";

export type FinalRow<T> = T & { computedAt: number };
// quoteTime is the trade time of the quote the row was computed from
export type LiveRow<T> = T & { computedAt: number; quoteTime: number };

export type InstrumentSignals = {
  instrument: string;
  daily: { final: FinalRow<DailyRow> | null; live: LiveRow<DailyRow> | null };
  weekly: {
    final: FinalRow<WeeklyRow> | null;
    live: LiveRow<WeeklyRow> | null;
  };
  // empty when current; live rows also follow the quote
  stale: { final: StaleReason[]; live: StaleReason[] };
};

function latest<T>(
  db: Db,
  instrument: string,
  interval: Interval,
  kind: Kind,
): T | null {
  return (
    db
      .query<T, [string, string, string]>(
        `select date, ${selectList(interval)}, computed_at as computedAt
           ${kind === "live" ? ", quote_time as quoteTime" : ""}
         from signals where instrument = ? and interval = ? and kind = ?
         order by date desc limit 1`,
      )
      .get(instrument, interval, kind) ?? null
  );
}

// Null for an instrument never stored.
export function readSignals(
  db: Db,
  instrument: string,
  now: number,
): InstrumentSignals | null {
  const i = readInstrument(db, instrument);
  if (i === null) return null;
  const daily = {
    final: latest<FinalRow<DailyRow>>(db, i.id, "1d", "final"),
    live: latest<LiveRow<DailyRow>>(db, i.id, "1d", "live"),
  };
  const weekly = {
    final: latest<FinalRow<WeeklyRow>>(db, i.id, "1wk", "final"),
    live: latest<LiveRow<WeeklyRow>>(db, i.id, "1wk", "live"),
  };
  // a FRED series is fetched by its own nightly pass, run per series
  const final =
    i.source === FRED ? seriesStale(db, i, now) : barsStale(db, i, now);
  if (finalPending(db, i.id)) {
    final.push(STALE.signalsPending);
  }
  const live = [...new Set([...final, ...quoteStale(db, i)])];
  const unfinished = (interval: Interval, row: { date: string } | null) =>
    row !== null &&
    db
      .query<{ n: number }, [string, string, string]>(
        `select count(*) as n from bars where instrument = ? and interval = ?
           and final = 0 and date < ?`,
      )
      .get(i.id, interval, row.date)!.n > 0;
  if (unfinished("1d", daily.live) || unfinished("1wk", weekly.live)) {
    live.push(STALE.previousDayNotFinal);
  }
  const target = liveTarget(db, i);
  if (target !== null && !live.includes(STALE.noHistory)) {
    const behind = (
      row: { date: string; quoteTime: number } | null,
      date: string,
    ) =>
      row === null || row.date !== date || row.quoteTime !== target.quote.time;
    if (
      (behind(daily.live, target.date) ||
        behind(weekly.live, weekOf(target.date))) &&
      !live.includes(STALE.signalsPending)
    ) {
      live.push(STALE.signalsPending);
    }
  }
  return { instrument: i.id, daily, weekly, stale: { final, live } };
}

// an index such as the DAX is unit unknown and a decided benchmark
export const UNKNOWN_UNITS_NOTE = "units unknown, treated as prices";

export type RelativeRead = Omit<RelativeReturn, "note"> & {
  // the maths' note, and when a unit is unknown, that it was read as a price
  note: string;
  // both listings ended on a live price of the same session date
  live: boolean;
};

// The instrument's return less the benchmark's over 1 or 3 months, on
// final daily closes, ending on live prices when both have a quote of
// the same session date. A percent series changes in level. Null when
// either is unknown or relativeReturn has no answer.
export function readRelativeReturn(
  db: Db,
  instrument: string,
  benchmark: string,
  months: 1 | 3,
): RelativeRead | null {
  const a = readInstrument(db, instrument);
  const b = readInstrument(db, benchmark);
  if (a === null || b === null) return null;
  const closes = (id: string) =>
    finalPrefix(readBars(db, id, "1d")).map((x) => ({
      date: x.date,
      close: x.close,
    }));
  const ia = closes(a.id);
  const ib = closes(b.id);
  const ta = liveTarget(db, a);
  const tb = liveTarget(db, b);
  const after = (rows: readonly { date: string }[], date: string) =>
    (rows.at(-1)?.date ?? "") < date;
  const live =
    ta !== null &&
    tb !== null &&
    ta.date === tb.date &&
    after(ia, ta.date) &&
    after(ib, tb.date);
  const listing = (
    bars: Listing["bars"],
    i: typeof a,
    t: typeof ta,
  ): Listing => ({
    bars,
    currency: i.currency ?? "unknown",
    ...(i.unit === "percent" ? { level: true as const } : {}),
    ...(live && t !== null
      ? { live: { date: t.date, price: t.quote.price } }
      : {}),
  });
  const r = relativeReturn(listing(ia, a, ta), listing(ib, b, tb), months);
  if (r === null) return null;
  const unknown = a.unit === "unknown" || b.unit === "unknown";
  return {
    ...r,
    note: unknown ? `${r.note}; ${UNKNOWN_UNITS_NOTE}` : r.note,
    live,
  };
}
