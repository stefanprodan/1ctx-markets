// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// Relative return is computed on read, not stored for every benchmark pair.

import type { Interval } from "../market/bars.ts";
import { weekOf } from "../market/calendars.ts";
import { readInstrument } from "../market/instruments.ts";
import {
  barsStale,
  quoteStale,
  STALE,
  type StaleReason,
} from "../market/stale.ts";
import { seriesStale } from "../sources/fred/jobs.ts";
import { FRED } from "../sources/ids.ts";
import type { Db } from "../storage/db/index.ts";
import { benchmarkSide, instrumentSide, type Side } from "./closes.ts";
import type { DailyRow } from "./daily.ts";
import {
  type Listing,
  type RelativeReturn,
  relativeReturn,
} from "./relative.ts";
import { finalPending, type Kind, selectList } from "./store.ts";
import { liveTarget } from "./target.ts";
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

// Null for an instrument never stored. With quoteEveryMs, a quote no
// pass kept up with is stale too.
export function readSignals(
  db: Db,
  instrument: string,
  now: number,
  quoteEveryMs: number | null = null,
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
  const live = [
    ...new Set([
      ...final,
      ...quoteStale(
        db,
        i,
        quoteEveryMs === null ? null : { now, everyMs: quoteEveryMs },
      ),
    ]),
  ];
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
    // a quote dated a bar already final has no live row by design (liveBase)
    const final = (interval: Interval, date: string) =>
      db
        .query<{ n: number }, [string, string, string]>(
          `select count(*) as n from bars where instrument = ? and interval = ?
             and date = ? and final = 1`,
        )
        .get(i.id, interval, date)!.n > 0;
    const behind = (
      interval: Interval,
      row: { date: string; quoteTime: number } | null,
      date: string,
    ) =>
      (row === null ||
        row.date !== date ||
        row.quoteTime !== target.quote.time) &&
      !final(interval, date);
    if (
      (behind("1d", daily.live, target.date) ||
        behind("1wk", weekly.live, weekOf(target.date))) &&
      !live.includes(STALE.signalsPending)
    ) {
      live.push(STALE.signalsPending);
    }
  }
  return { instrument: i.id, daily, weekly, stale: { final, live } };
}

// a listing of unknown unit, or an index, is still a valid benchmark
export const UNKNOWN_UNITS_NOTE = "units unknown, treated as prices";

export type RelativeRead = Omit<RelativeReturn, "note"> & {
  // the maths' note, and when a unit is unknown, that it was read as a price
  note: string;
  // both listings ended on a live price of the same session date
  live: boolean;
};

export function readRelativeReturn(
  db: Db,
  instrument: string,
  benchmark: string,
  months: 1 | 3,
  to: string | null = null,
): RelativeRead | null {
  const a = readInstrument(db, instrument);
  const b = readInstrument(db, benchmark);
  if (a === null || b === null) return null;
  const bench = benchmarkSide(db, b, months, to);
  const side = instrumentSide(db, a, bench, null, to);
  return relativeOf(side, bench, months, to);
}

// live prices end it only when both quote the same session date
export function relativeOf(
  sa: Side,
  sb: Side,
  months: 1 | 3,
  to: string | null = null,
): RelativeRead | null {
  const a = sa.instrument;
  const b = sb.instrument;
  const ia = sa.closes;
  const ib = sb.closes;
  const ta = sa.target;
  const tb = sb.target;
  const after = (rows: readonly { date: string }[], date: string) =>
    (rows.at(-1)?.date ?? "") < date;
  const live =
    ta !== null &&
    tb !== null &&
    ta.date === tb.date &&
    (to === null || ta.date <= to) &&
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
  // one index's points are no other's, so two instruments share no unit
  const unknown =
    a.unit === "unknown" ||
    b.unit === "unknown" ||
    (a.id !== b.id && (a.unit === "index_points" || b.unit === "index_points"));
  return {
    ...r,
    note: unknown ? `${r.note}; ${UNKNOWN_UNITS_NOTE}` : r.note,
    live,
  };
}
