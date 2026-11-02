// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// The final closes a return reads, and the live price that may end them.

import type { Instrument } from "../market/instruments.ts";
import { monthsBack } from "../shared/periods.ts";
import type { Db } from "../storage/db/index.ts";
import type { Close } from "./common.ts";
import { type Returns, trailingReturns } from "./relative.ts";
import { type LiveTarget, liveTarget } from "./target.ts";

// only final bars make final rows, and a series never skips a day
export function finalPrefix<T extends { final: boolean }>(
  bars: readonly T[],
): T[] {
  const k = bars.findIndex((b) => !b.final);
  return k === -1 ? [...bars] : bars.slice(0, k);
}

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

// read back only to anchor(end) for every end it can have, not every stored
// bar; the end is never before the last final close
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
