// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// What the tools read: the latest signal rows with why they may be
// behind, and relative return, computed on read for the benchmark the
// caller names rather than stored for every pair.

import type { Interval } from "../market/bars.ts";
import { weekOf } from "../market/calendars.ts";
import { type Instrument, readInstrument } from "../market/instruments.ts";
import {
  barsStale,
  quoteStale,
  STALE,
  type StaleReason,
} from "../market/stale.ts";
import { seriesStale } from "../sources/fred/jobs.ts";
import { FRED } from "../sources/ids.ts";
import type { Db } from "../storage/db/index.ts";
import type { Close } from "./common.ts";
import type { DailyRow } from "./daily.ts";
import {
  type Listing,
  monthsBack,
  type RelativeReturn,
  type Returns,
  relativeReturn,
  trailingReturns,
} from "./relative.ts";
import {
  finalPending,
  finalPrefix,
  type Kind,
  type LiveTarget,
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

// a listing of unknown unit, or an index, is still a valid benchmark
export const UNKNOWN_UNITS_NOTE = "units unknown, treated as prices";

export type RelativeRead = Omit<RelativeReturn, "note"> & {
  // the maths' note, and when a unit is unknown, that it was read as a price
  note: string;
  // both listings ended on a live price of the same session date
  live: boolean;
};

// Final daily closes up to to, from the last bar on or before from; the
// whole series when no bar is that old. A bar not final ends them.
function closesFrom(
  db: Db,
  id: string,
  from: string,
  to: string | null,
): { rows: Close[]; first: string | null; whole: boolean } {
  const bars = db
    .query<
      { date: string; close: number; final: number },
      [string, string, string]
    >(
      `select date, close, final from bars
       where instrument = ?1 and interval = '1d' and date <= ?3
         and date >= coalesce((select max(date) from bars
           where instrument = ?1 and interval = '1d' and date <= ?2), '')
       order by date`,
    )
    .all(id, from, to ?? "9999-12-31");
  const first = bars[0]?.date ?? null;
  return {
    rows: finalPrefix(bars.map((b) => ({ ...b, final: b.final === 1 }))).map(
      ({ date, close }) => ({ date, close }),
    ),
    first,
    whole: first === null || first > from,
  };
}

// The closes that reach back to anchor(end) for every end they can
// have, read from there instead of every stored bar: the end is never
// before the last final close.
export function readCloses(
  db: Db,
  id: string,
  anchor: (end: string) => string,
  to: string | null = null,
): Close[] {
  const top = db
    .query<{ d: string | null }, [string, string]>(
      `select max(date) as d from bars
       where instrument = ? and interval = '1d' and date <= ?`,
    )
    .get(id, to ?? "9999-12-31")!.d;
  if (top === null) return [];
  let s = closesFrom(db, id, anchor(top), to);
  for (;;) {
    const end = s.rows.at(-1)?.date;
    if (end === undefined || s.whole || s.first! <= anchor(end)) return s.rows;
    s = closesFrom(db, id, anchor(end), to);
  }
}

// What a relative return reads of one listing, kept to be read again.
export type Side = {
  instrument: Instrument;
  closes: readonly Close[];
  target: LiveTarget | null;
};

// A benchmark side reaches its own start months back.
export function benchmarkSide(
  db: Db,
  b: Instrument,
  months: 1 | 3,
  to: string | null = null,
): Side {
  return {
    instrument: b,
    closes: readCloses(db, b.id, (end) => monthsBack(end, months), to),
    target: liveTarget(db, b),
  };
}

// An instrument side reaches its own anchor and, beside a benchmark,
// the benchmark's first close, which no start of its is before.
export function instrumentSide(
  db: Db,
  a: Instrument,
  bench: Side | null,
  anchor: ((end: string) => string) | null,
  to: string | null = null,
): Side {
  const first = bench?.closes[0]?.date ?? null;
  const reach = (end: string) => {
    const own = anchor === null ? null : anchor(end);
    if (own === null) return first ?? end;
    return first === null || own < first ? own : first;
  };
  return {
    instrument: a,
    closes: readCloses(db, a.id, reach, to),
    target: liveTarget(db, a),
  };
}

// Ends on the live price only when its session date follows the last
// final close, the rule relativeOf follows; a yield moves in points.
export function returnsOf(side: Side): Returns | null {
  const t = side.target;
  const after = t !== null && t.date > (side.closes.at(-1)?.date ?? "");
  return trailingReturns({
    bars: side.closes,
    currency: side.instrument.currency ?? "unknown",
    ...(side.instrument.unit === "percent" ? { level: true as const } : {}),
    ...(after ? { live: { date: t.date, price: t.quote.price } } : {}),
  });
}

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
