// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The two listings trade on different calendars, so every anchor is a
// date on the benchmark's days, never a row offset.

import { wallOfDate } from "../zone.ts";
import { type Close, checkOrder } from "./common.ts";

export const RETURN_NOTE =
  "price returns in each listing's own currency; FX conversion excluded";

export const LEVEL_NOTE =
  "changes in each series' level, in points, not returns";

export type Listing = {
  bars: readonly Close[];
  // replaces the close of a bar on its date, or follows the last bar
  live?: { date: string; price: number };
  currency: string;
  // a yield or spread, which changes in level rather than returns
  level?: true;
};

export type ListingReturn = {
  change: number;
  unit: "percent" | "points";
  from: string;
  to: string;
  currency: string;
};

export type RelativeReturn = {
  months: 1 | 3;
  // points of the unit both listings share
  relative: number;
  instrument: ListingReturn;
  benchmark: ListingReturn;
  note: typeof RETURN_NOTE | typeof LEVEL_NOTE;
};

export function relativeReturn(
  instrument: Listing,
  benchmark: Listing,
  months: 1 | 3,
): RelativeReturn | null {
  if (months !== 1 && months !== 3) throw new Error("months is 1 or 3");
  const level = instrument.level === true;
  if (level !== (benchmark.level === true)) return null;
  const bench = withLive(benchmark);
  const inst = withLive(instrument);
  const end = bench.at(-1);
  if (end === undefined) return null;
  const benchStart = onOrBefore(bench, monthsBack(end.date, months));
  if (benchStart === null) return null;
  const b = change(benchStart, end, benchmark.currency, level);
  const instStart = onOrBefore(inst, benchStart.date);
  const instEnd = onOrBefore(inst, end.date);
  if (b === null || instStart === null || instEnd === null) return null;
  // a listing that stopped trading would read as flat
  if (instEnd.date < benchStart.date) return null;
  if (instStart.date === instEnd.date && benchStart.date !== end.date) {
    return null;
  }
  const i = change(instStart, instEnd, instrument.currency, level);
  if (i === null) return null;
  return {
    months,
    relative: i.change - b.change,
    instrument: i,
    benchmark: b,
    note: level ? LEVEL_NOTE : RETURN_NOTE,
  };
}

// the same calendar day m months back, clamped to that month's end
export function monthsBack(date: string, months: number): string {
  const d = new Date(wallOfDate(date));
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() - months;
  const monthEnd = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  const day = Math.min(d.getUTCDate(), monthEnd);
  return new Date(Date.UTC(y, m, day)).toISOString().slice(0, 10);
}

function withLive(l: Listing): readonly Close[] {
  checkOrder(l.bars);
  if (l.live === undefined) return l.bars;
  const { date, price } = l.live;
  const last = l.bars.at(-1);
  if (last !== undefined && date < last.date) {
    throw new Error(`live ${date} is before the last bar ${last.date}`);
  }
  const base = last?.date === date ? l.bars.slice(0, -1) : l.bars;
  return [...base, { date, close: price }];
}

function onOrBefore(rows: readonly Close[], date: string): Close | null {
  let lo = 0;
  let hi = rows.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (rows[mid]!.date <= date) lo = mid + 1;
    else hi = mid;
  }
  return lo > 0 ? rows[lo - 1]! : null;
}

function change(
  from: Close,
  to: Close,
  currency: string,
  level: boolean,
): ListingReturn | null {
  if (!level && from.close <= 0) return null;
  return {
    change: level ? to.close - from.close : 100 * (to.close / from.close - 1),
    unit: level ? "points" : "percent",
    from: from.date,
    to: to.date,
    currency,
  };
}
