// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Every row is one step from the previous row over the bars up to it,
// so the live row is the same step over the final bars plus one
// provisional bar and cannot drift from what the final row will be.

import { addDays } from "../zone.ts";
import {
  baseRows,
  checkLastRow,
  checkOrder,
  emaNext,
  emaSeries,
  meanClose,
  smaCross,
} from "./common.ts";

// What the signals read of a daily bar. FRED has closes only, and an
// index or FX pair reports volume 0.
export type Bar = {
  date: string;
  high: number | null;
  low: number | null;
  close: number;
  volume: number | null;
};

export type Quote = {
  price: number;
  dayHigh: number | null;
  dayLow: number | null;
  volume: number | null;
};

export type DailyRow = {
  date: string;
  sma50: number | null;
  sma200: number | null;
  ema20: number | null;
  // sign of SMA 50 - SMA 200
  cross: -1 | 0 | 1 | null;
  crossEdge: -1 | 0 | 1 | null;
  rsi14: number | null;
  macd: number | null;
  macdSignal: number | null;
  macdHistogram: number | null;
  macdTurn: -1 | 0 | 1 | null;
  atr14: number | null;
  moveAtr: number | null;
  // percent per day
  volatility20: number | null;
  bollingerLower: number | null;
  high52w: number | null;
  low52w: number | null;
  drawdown: number | null;
  fromLow: number | null;
  daysSinceHigh: number | null;
  volumeRatio: number | null;
  // running values the next row steps from
  ema12: number | null;
  ema26: number | null;
  rsiGain: number | null;
  rsiLoss: number | null;
  prevHistogram: number | null;
};

// 52 calendar weeks ending on the bar's date
const WINDOW_DAYS = 52 * 7;

// from the first stored bar: Wilder's averages and EMA seeds depend on it
export function dailySeries(bars: readonly Bar[]): DailyRow[] {
  checkOrder(bars);
  const rows: DailyRow[] = [];
  for (let i = 0; i < bars.length; i++) {
    rows.push(dailyRow(bars, i, rows[i - 1] ?? null));
  }
  return rows;
}

// replacesLast: the quote's session is the last stored bar, not yet final
export function liveDaily(
  bars: readonly Bar[],
  last: DailyRow | null,
  quote: Quote,
  session: { date: string; replacesLast: boolean },
): DailyRow {
  const base = baseRows(bars, session.date, session.replacesLast);
  checkLastRow(base, last);
  const all = [
    ...base,
    {
      date: session.date,
      high: quote.dayHigh,
      low: quote.dayLow,
      close: quote.price,
      volume: quote.volume,
    },
  ];
  return dailyRow(all, all.length - 1, last, true);
}

function dailyRow(
  bars: readonly Bar[],
  i: number,
  prev: DailyRow | null,
  provisional = false,
): DailyRow {
  const bar = bars[i]!;
  const c = bar.close;
  const prevClose = i > 0 ? bars[i - 1]!.close : null;

  const ema = (n: number, p: number | null) =>
    p !== null
      ? emaNext(p, c, n)
      : i >= n - 1
        ? meanClose(bars, i - n + 1, i + 1)
        : null;
  const ema20 = ema(20, prev?.ema20 ?? null);
  const ema12 = ema(12, prev?.ema12 ?? null);
  const ema26 = ema(26, prev?.ema26 ?? null);

  const macd = ema12 !== null && ema26 !== null ? ema12 - ema26 : null;
  const macdSignal = signalOf(bars, i, macd, prev?.macdSignal ?? null);
  const macdHistogram =
    macd !== null && macdSignal !== null ? macd - macdSignal : null;
  const prevHistogram = prev?.macdHistogram ?? null;
  const macdTurn =
    macdHistogram !== null &&
    prevHistogram !== null &&
    prev?.prevHistogram != null
      ? turn(macdHistogram, prevHistogram, prev.prevHistogram)
      : null;

  const { rsiGain, rsiLoss } = rsiAverages(bars, i, prev);
  const atr14 = atrOf(bars, i, prev?.atr14 ?? null);
  const prevAtr = prev?.atr14 ?? null;
  const moveAtr =
    prevAtr !== null && prevAtr !== 0 && prevClose !== null
      ? (c - prevClose) / prevAtr
      : null;

  return {
    date: bar.date,
    ...smaCross(bars, i, prev),
    ema20,
    rsi14: rsiGain === null || rsiLoss === null ? null : rsi(rsiGain, rsiLoss),
    macd,
    macdSignal,
    macdHistogram,
    macdTurn,
    atr14,
    moveAtr,
    volatility20: volatility(bars, i),
    bollingerLower: bollingerLower(bars, i),
    ...range52w(bars, i, provisional),
    volumeRatio: volumeRatio(bars, i),
    ema12,
    ema26,
    rsiGain,
    rsiLoss,
    prevHistogram,
  };
}

export function turn(h: number, h1: number, h2: number): -1 | 0 | 1 {
  if (h > h1 && h1 <= h2) return 1;
  if (h < h1 && h1 >= h2) return -1;
  return 0;
}

export function rsi(gain: number, loss: number): number {
  if (loss === 0) return gain === 0 ? 50 : 100;
  return 100 - 100 / (1 + gain / loss);
}

// EMA 9 of MACD, seeded with the mean of its first 9 values: MACD's
// first value is at index 25, so the seed lands on index 33.
function signalOf(
  bars: readonly Bar[],
  i: number,
  macd: number | null,
  prev: number | null,
): number | null {
  if (macd === null) return null;
  if (prev !== null) return emaNext(prev, macd, 9);
  if (i < 33) return null;
  const e12 = emaSeries(bars, 12, i);
  const e26 = emaSeries(bars, 26, i);
  let sum = 0;
  for (let k = i - 8; k <= i; k++) sum += e12[k]! - e26[k]!;
  return sum / 9;
}

function rsiAverages(
  bars: readonly Bar[],
  i: number,
  prev: DailyRow | null,
): { rsiGain: number | null; rsiLoss: number | null } {
  if (prev?.rsiGain != null && prev.rsiLoss != null) {
    const d = bars[i]!.close - bars[i - 1]!.close;
    return {
      rsiGain: (13 * prev.rsiGain + Math.max(d, 0)) / 14,
      rsiLoss: (13 * prev.rsiLoss + Math.max(-d, 0)) / 14,
    };
  }
  if (i < 14) return { rsiGain: null, rsiLoss: null };
  let gain = 0;
  let loss = 0;
  for (let k = i - 13; k <= i; k++) {
    const d = bars[k]!.close - bars[k - 1]!.close;
    gain += Math.max(d, 0);
    loss += Math.max(-d, 0);
  }
  return { rsiGain: gain / 14, rsiLoss: loss / 14 };
}

function trueRange(bars: readonly Bar[], k: number): number | null {
  const { high, low } = bars[k]!;
  if (high === null || low === null) return null;
  if (k === 0) return high - low;
  const pc = bars[k - 1]!.close;
  return Math.max(high - low, Math.abs(high - pc), Math.abs(low - pc));
}

// After a bar without a high or low, ATR seeds again from the next 14
// true ranges rather than stay null until a recompute.
function atrOf(
  bars: readonly Bar[],
  i: number,
  prev: number | null,
): number | null {
  const tr = trueRange(bars, i);
  if (tr === null) return null;
  if (prev !== null) return (13 * prev + tr) / 14;
  if (i < 13) return null;
  let sum = 0;
  for (let k = i - 13; k <= i; k++) {
    const t = trueRange(bars, k);
    if (t === null) return null;
    sum += t;
  }
  return sum / 14;
}

// sample deviation of 20 log returns, a close at or below 0 has none
function volatility(bars: readonly Bar[], i: number): number | null {
  if (i < 20) return null;
  const r: number[] = [];
  for (let k = i - 19; k <= i; k++) {
    const a = bars[k - 1]!.close;
    const b = bars[k]!.close;
    if (a <= 0 || b <= 0) return null;
    r.push(Math.log(b / a));
  }
  const m = r.reduce((s, x) => s + x, 0) / 20;
  const v = r.reduce((s, x) => s + (x - m) ** 2, 0) / 19;
  return 100 * Math.sqrt(v);
}

function bollingerLower(bars: readonly Bar[], i: number): number | null {
  if (i < 19) return null;
  const m = meanClose(bars, i - 19, i + 1);
  let v = 0;
  for (let k = i - 19; k <= i; k++) v += (bars[k]!.close - m) ** 2;
  return m - 2 * Math.sqrt(v / 20);
}

type Range52w = Pick<
  DailyRow,
  "high52w" | "low52w" | "drawdown" | "fromLow" | "daysSinceHigh"
>;

const NO_RANGE: Range52w = {
  high52w: null,
  low52w: null,
  drawdown: null,
  fromLow: null,
  daysSinceHigh: null,
};

// A final bar with neither high nor low ranges over its close (FRED,
// a 0 range a source stored as null); a quote without them is not a
// bar's range yet, so the live row has none rather than use the price.
function range52w(
  bars: readonly Bar[],
  i: number,
  provisional: boolean,
): Range52w {
  const start = addDays(bars[i]!.date, 1 - WINDOW_DAYS);
  if (bars[0]!.date > start) return NO_RANGE;
  let lo = 0;
  let hi = i;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid]!.date < start) lo = mid + 1;
    else hi = mid;
  }
  let high = Number.NEGATIVE_INFINITY;
  let low = Number.POSITIVE_INFINITY;
  let at = lo;
  for (let k = lo; k <= i; k++) {
    const b = bars[k]!;
    const closeOnly = b.high === null && b.low === null;
    if (closeOnly && provisional && k === i) return NO_RANGE;
    const h = closeOnly ? b.close : b.high;
    const l = closeOnly ? b.close : b.low;
    if (h === null || l === null) return NO_RANGE;
    // the latest bar at the high, since the fall starts there
    if (h >= high) {
      high = h;
      at = k;
    }
    if (l < low) low = l;
  }
  const c = bars[i]!.close;
  return {
    high52w: high,
    low52w: low,
    drawdown: high > 0 ? 100 * (c / high - 1) : null,
    fromLow: low > 0 ? 100 * (c / low - 1) : null,
    daysSinceHigh: i - at,
  };
}

// An instrument without volume (an index or FX reading 0, FRED) has
// none; a 0 day for one that trades is a ratio of 0.
function volumeRatio(bars: readonly Bar[], i: number): number | null {
  const v = bars[i]!.volume;
  if (i < 20 || v === null) return null;
  let sum = 0;
  for (let k = i - 20; k < i; k++) {
    const w = bars[k]!.volume;
    if (w === null) return null;
    sum += w;
  }
  return sum === 0 ? null : v / (sum / 20);
}
