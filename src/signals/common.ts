// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Seeds and steps only go through here, so a recompute matches the stepped one.

export type Close = { date: string; close: number };

export function meanClose(
  rows: readonly Close[],
  from: number,
  to: number,
): number {
  let sum = 0;
  for (let k = from; k < to; k++) sum += rows[k]!.close;
  return sum / (to - from);
}

export function emaNext(prev: number, value: number, n: number): number {
  return prev + (2 / (n + 1)) * (value - prev);
}

// SMA-seeded at index n - 1; null before
export function emaSeries(
  rows: readonly Close[],
  n: number,
  upto: number,
): (number | null)[] {
  const out: (number | null)[] = [];
  let e: number | null = null;
  for (let k = 0; k <= upto; k++) {
    if (e !== null) e = emaNext(e, rows[k]!.close, n);
    else if (k >= n - 1) e = meanClose(rows, k - n + 1, k + 1);
    out.push(e);
  }
  return out;
}

export function sign(d: number): -1 | 0 | 1 {
  return d > 0 ? 1 : d < 0 ? -1 : 0;
}

export function crossEdge(diff: number, prevDiff: number): -1 | 0 | 1 {
  if (diff > 0 && prevDiff <= 0) return 1;
  if (diff < 0 && prevDiff >= 0) return -1;
  return 0;
}

export type Cross = {
  sma50: number | null;
  sma200: number | null;
  cross: -1 | 0 | 1 | null;
  crossEdge: -1 | 0 | 1 | null;
};

export function smaCross(
  rows: readonly Close[],
  i: number,
  prev: { sma50: number | null; sma200: number | null } | null,
): Cross {
  const sma50 = i >= 49 ? meanClose(rows, i - 49, i + 1) : null;
  const sma200 = i >= 199 ? meanClose(rows, i - 199, i + 1) : null;
  if (sma50 === null || sma200 === null) {
    return { sma50, sma200, cross: null, crossEdge: null };
  }
  const diff = sma50 - sma200;
  const edge =
    prev?.sma50 != null && prev.sma200 != null
      ? crossEdge(diff, prev.sma50 - prev.sma200)
      : null;
  return { sma50, sma200, cross: sign(diff), crossEdge: edge };
}

// dates strictly rising, so an index is a trading day
export function checkOrder(rows: readonly { date: string }[]): void {
  for (let k = 1; k < rows.length; k++) {
    if (rows[k]!.date <= rows[k - 1]!.date) {
      throw new Error(`bars out of order at ${rows[k]!.date}`);
    }
  }
}

// without the last stored row when the provisional row replaces it
export function baseRows<T extends { date: string }>(
  rows: readonly T[],
  date: string,
  replacesLast: boolean,
): readonly T[] {
  const last = rows.at(-1);
  if (replacesLast) {
    if (last?.date !== date) {
      throw new Error(`no stored bar on ${date} to replace`);
    }
    return rows.slice(0, -1);
  }
  if (last !== undefined && date <= last.date) {
    throw new Error(`${date} is not after the last bar ${last.date}`);
  }
  return rows;
}

export function checkLastRow(
  rows: readonly { date: string }[],
  last: { date: string } | null,
): void {
  const want = rows.at(-1)?.date ?? null;
  if ((last?.date ?? null) !== want) {
    throw new Error(
      `last final row ${last?.date ?? "none"} is not the bar before (${want ?? "none"})`,
    );
  }
}
