// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { crossEdge } from "../src/signals/common.ts";
import {
  type Bar,
  type DailyRow,
  dailySeries,
  liveDaily,
  turn,
} from "../src/signals/daily.ts";
import { addDays } from "../src/zone.ts";

// weekdays from a Monday
function weekdays(from: string, n: number): string[] {
  const out: string[] = [];
  for (let d = from; out.length < n; d = addDays(d, 1)) {
    const day = new Date(`${d}T00:00:00Z`).getUTCDay();
    if (day !== 0 && day !== 6) out.push(d);
  }
  return out;
}

function closesOnly(closes: number[], from = "2027-01-04"): Bar[] {
  const dates = weekdays(from, closes.length);
  return closes.map((close, k) => ({
    date: dates[k]!,
    high: null,
    low: null,
    close,
    volume: null,
  }));
}

// a fixed pseudo-random walk, the same on every run
function generated(n: number, from = "2025-01-06"): Bar[] {
  let seed = 7;
  const next = () => {
    seed = (seed * 1103515245 + 12345) % 2 ** 31;
    return seed / 2 ** 31;
  };
  let close = 100;
  return weekdays(from, n).map((date) => {
    close = Math.max(1, close + (next() - 0.5) * 4);
    const reach = next() * 3;
    return {
      date,
      high: close + reach,
      low: close - reach * next(),
      close,
      volume: Math.floor(1000 + next() * 1000),
    };
  });
}

function quoteOf(bar: Bar) {
  return {
    price: bar.close,
    dayHigh: bar.high,
    dayLow: bar.low,
    volume: bar.volume,
  };
}

function expectClose(a: DailyRow, b: DailyRow) {
  expect(Object.keys(a)).toEqual(Object.keys(b));
  for (const key of Object.keys(a) as (keyof DailyRow)[]) {
    const x = a[key];
    const y = b[key];
    if (typeof x === "number" && typeof y === "number") {
      expect({ key, diff: Math.abs(x - y) <= 1e-9 }).toEqual({
        key,
        diff: true,
      });
    } else {
      expect({ key, value: x }).toEqual({ key, value: y });
    }
  }
}

const range = (n: number, f: (k: number) => number) =>
  Array.from({ length: n }, (_, k) => f(k));

describe("daily signals", () => {
  test("closes 1 to 20 give SMA and EMA 10.5 and close 21 moves EMA to 11.5", () => {
    const rows = dailySeries(closesOnly(range(21, (k) => k + 1)));
    expect(rows[18]!.ema20).toBeNull();
    expect(rows[18]!.bollingerLower).toBeNull();
    expect(rows[19]!.ema20).toBe(10.5);
    expect(rows[19]!.bollingerLower).toBeCloseTo(10.5 - 2 * Math.sqrt(33.25));
    expect(rows[20]!.ema20).toBeCloseTo(11.5, 12);
  });

  test("RSI is 100 on rising closes and 50 on equal ones", () => {
    const rising = dailySeries(closesOnly(range(15, (k) => 10 + k)));
    expect(rising[13]!.rsi14).toBeNull();
    expect(rising[14]!.rsi14).toBe(100);
    const flat = dailySeries(closesOnly(range(15, () => 10)));
    expect(flat[14]!.rsi14).toBe(50);
    const falling = dailySeries(closesOnly(range(15, (k) => 30 - k)));
    expect(falling[14]!.rsi14).toBe(0);
  });

  test("RSI steps with Wilder's smoothing", () => {
    // 14 changes of +1, then a fall of 2
    const rows = dailySeries(closesOnly([...range(15, (k) => 10 + k), 22]));
    expect(rows[15]!.rsiGain).toBeCloseTo(13 / 14, 12);
    expect(rows[15]!.rsiLoss).toBeCloseTo(2 / 14, 12);
    expect(rows[15]!.rsi14).toBeCloseTo(100 - 100 / (1 + 13 / 2), 12);
  });

  test("ATR is 2 on a 2-point range and a live 97 moves -1.5 ATRs", () => {
    const bars = closesOnly(range(14, () => 100)).map((b) => ({
      ...b,
      high: 101,
      low: 99,
    }));
    const rows = dailySeries(bars);
    expect(rows[12]!.atr14).toBeNull();
    expect(rows[13]!.atr14).toBe(2);
    expect(rows[13]!.moveAtr).toBeNull();
    const live = liveDaily(
      bars,
      rows[13]!,
      { price: 97, dayHigh: 100, dayLow: 96, volume: null },
      { date: addDays(bars[13]!.date, 1), replacesLast: false },
    );
    expect(live.moveAtr).toBe(-1.5);
    expect(live.atr14).toBeCloseTo((13 * 2 + 4) / 14, 12);
  });

  test("MACD of a straight line is constant and its histogram flat", () => {
    // an SMA-seeded EMA n of a line lags it by (n - 1) / 2 from the seed
    const rows = dailySeries(closesOnly(range(40, (k) => k + 1)));
    expect(rows[24]!.macd).toBeNull();
    expect(rows[25]!.macd).toBeCloseTo(7, 9);
    expect(rows[32]!.macdSignal).toBeNull();
    expect(rows[33]!.macdSignal).toBeCloseTo(7, 9);
    expect(rows[39]!.macdHistogram).toBeCloseTo(0, 9);
  });

  test("the histogram turns up from a trough only", () => {
    expect(turn(-3, -4, -3)).toBe(1);
    expect(turn(-2, -3, -4)).toBe(0);
    expect(turn(3, 4, 3)).toBe(-1);
    expect(turn(2, 3, 4)).toBe(0);
    expect(turn(1, 1, 0)).toBe(0);
  });

  test("the cross has no edge at equality and turns up past it", () => {
    expect(crossEdge(0, -1)).toBe(0);
    expect(crossEdge(1, 0)).toBe(1);
    expect(crossEdge(-1, 0)).toBe(-1);
    expect(crossEdge(1, 1)).toBe(0);
  });

  test("each signal starts on its first-value bar", () => {
    const rows = dailySeries(generated(300));
    // one-based bar of each first value
    const first: Partial<Record<keyof DailyRow, number>> = {
      ema12: 12,
      atr14: 14,
      rsi14: 15,
      rsiGain: 15,
      rsiLoss: 15,
      moveAtr: 15,
      ema20: 20,
      bollingerLower: 20,
      volatility20: 21,
      volumeRatio: 21,
      ema26: 26,
      macd: 26,
      macdSignal: 34,
      macdHistogram: 34,
      prevHistogram: 35,
      macdTurn: 36,
      sma50: 50,
      sma200: 200,
      cross: 200,
      crossEdge: 201,
      // 2025-01-06 + 363 days is a Sunday, so the Monday after
      high52w: 261,
      low52w: 261,
      drawdown: 261,
      fromLow: 261,
      daysSinceHigh: 261,
    };
    expect(rows[260]!.date).toBe("2026-01-05");
    for (const [key, bar] of Object.entries(first)) {
      const k = key as keyof DailyRow;
      expect({ k, value: rows[bar - 2]![k] }).toEqual({ k, value: null });
      expect({ k, set: rows[bar - 1]![k] !== null }).toEqual({ k, set: true });
      expect({ k, set: rows[299]![k] !== null }).toEqual({ k, set: true });
    }
  });

  test("volatility is the sample deviation of log returns in percent", () => {
    const rows = dailySeries(closesOnly(range(21, (k) => (k % 2 ? 2 : 1))));
    expect(rows[19]!.volatility20).toBeNull();
    expect(rows[20]!.volatility20).toBeCloseTo(
      100 * Math.LN2 * Math.sqrt(20 / 19),
      12,
    );
    const negative = dailySeries(closesOnly(range(21, (k) => k - 1)));
    expect(negative[20]!.volatility20).toBeNull();
  });

  test("the 52-week window spans a leap day and a year end", () => {
    const bar = (date: string, high: number, low: number, close: number) => ({
      date,
      high,
      low,
      close,
      volume: null,
    });
    const rows = dailySeries([
      // a day outside the window only because 2028 has a February 29
      bar("2027-07-02", 500, 1, 100),
      bar("2027-07-05", 90, 50, 80),
      bar("2027-12-31", 120, 40, 110),
      bar("2028-02-29", 100, 30, 90),
      bar("2028-06-30", 70, 55, 60),
    ]);
    expect(rows[3]!.high52w).toBeNull();
    expect(rows[4]).toMatchObject({
      high52w: 120,
      low52w: 30,
      drawdown: -50,
      fromLow: 100,
      daysSinceHigh: 2,
    });
  });

  test("days since the high count from the latest bar at it", () => {
    const rows = dailySeries(
      closesOnly([...range(255, () => 10), 12, 11, 12, 9, 8, 7, 9]),
    );
    expect(rows[259]!.high52w).toBeNull();
    expect(rows[261]).toMatchObject({
      high52w: 12,
      low52w: 7,
      daysSinceHigh: 4,
    });
  });

  test("a final bar without highs and lows ranges over its close", () => {
    const closes = closesOnly(range(262, (k) => 100 - (k % 50)));
    const rows = dailySeries(closes);
    expect(rows[261]).toMatchObject({ high52w: 100, low52w: 51 });
    const mixed = closes.map((b, k) =>
      k === 200 ? { ...b, high: 101, low: 99 } : b,
    );
    expect(dailySeries(mixed)[261]).toMatchObject({
      high52w: 101,
      low52w: 51,
    });
  });

  test("one bar without a high or low keeps the 52-week range", () => {
    const bars = generated(600).map((b, k) =>
      k === 400 ? { ...b, high: null, low: null } : b,
    );
    const rows = dailySeries(bars);
    expect(rows[400]!.high52w).not.toBeNull();
    expect(rows[599]!.high52w).not.toBeNull();
    const halfRange = generated(300).map((b, k) =>
      k === 290 ? { ...b, low: null } : b,
    );
    expect(dailySeries(halfRange)[299]!.high52w).toBeNull();
  });

  test("a live quote without a high or low has no range on a close series", () => {
    const closes = closesOnly(range(262, (k) => 100 - (k % 50)));
    const rows = dailySeries(closes);
    const live = liveDaily(
      closes,
      rows[261]!,
      { price: 80, dayHigh: null, dayLow: null, volume: null },
      { date: addDays(closes[261]!.date, 1), replacesLast: false },
    );
    expect(live.high52w).toBeNull();
    expect(live.daysSinceHigh).toBeNull();
  });

  test("volume ratio reads the previous 20 days and needs volume", () => {
    const withVolume = (volumes: (number | null)[]) =>
      dailySeries(
        closesOnly(range(volumes.length, () => 10)).map((b, k) => ({
          ...b,
          volume: volumes[k]!,
        })),
      );
    const twenty = range(20, () => 100);
    expect(withVolume([...twenty, 50])[19]!.volumeRatio).toBeNull();
    expect(withVolume([...twenty, 50])[20]!.volumeRatio).toBe(0.5);
    expect(withVolume([...twenty, 0])[20]!.volumeRatio).toBe(0);
    expect(withVolume(range(21, () => 0))[20]!.volumeRatio).toBeNull();
    expect(withVolume([...twenty, null])[20]!.volumeRatio).toBeNull();
  });

  test("the live row is the final row of the bars with its bar appended", () => {
    const bars = generated(300);
    const rows = dailySeries(bars);
    for (let k = 0; k < bars.length; k++) {
      const prior = bars.slice(0, k);
      const last = rows[k - 1] ?? null;
      const quote = quoteOf(bars[k]!);
      const date = bars[k]!.date;
      expectClose(
        liveDaily(prior, last, quote, { date, replacesLast: false }),
        rows[k]!,
      );
      // a stored partial bar for the session is replaced, never added to
      const partial = [...prior, { ...bars[k]!, close: 1, high: 1, low: 1 }];
      expectClose(
        liveDaily(partial, last, quote, { date, replacesLast: true }),
        rows[k]!,
      );
    }
  });

  test("a quote without a day high gives no live ATR or 52-week range", () => {
    const bars = generated(300);
    const rows = dailySeries(bars);
    const live = liveDaily(
      bars,
      rows[299]!,
      { price: 90, dayHigh: null, dayLow: 85, volume: 1500 },
      { date: addDays(bars[299]!.date, 3), replacesLast: false },
    );
    expect(live).toMatchObject({
      atr14: null,
      high52w: null,
      low52w: null,
      drawdown: null,
      fromLow: null,
      daysSinceHigh: null,
    });
    expect(live.moveAtr).toBeCloseTo(
      (90 - bars[299]!.close) / rows[299]!.atr14!,
      12,
    );
    expect(live.rsi14).not.toBeNull();
  });

  test("ATR seeds again after a bar without a high or low", () => {
    const bars = generated(60).map((b, k) =>
      k === 30 ? { ...b, high: null, low: null } : b,
    );
    const rows = dailySeries(bars);
    expect(rows[30]!.atr14).toBeNull();
    expect(rows[43]!.atr14).toBeNull();
    expect(rows[44]!.atr14).not.toBeNull();
  });

  test("a live row checks the session against the stored bars", () => {
    const bars = generated(30);
    const rows = dailySeries(bars);
    const quote = quoteOf(bars[29]!);
    expect(() =>
      liveDaily(bars, rows[28]!, quote, {
        date: bars[29]!.date,
        replacesLast: false,
      }),
    ).toThrow("is not after the last bar");
    expect(() =>
      liveDaily(bars, rows[28]!, quote, {
        date: addDays(bars[29]!.date, 3),
        replacesLast: true,
      }),
    ).toThrow("no stored bar");
    expect(() =>
      liveDaily(bars, rows[28]!, quote, {
        date: addDays(bars[29]!.date, 3),
        replacesLast: false,
      }),
    ).toThrow("is not the bar before");
  });

  test("bars out of date order are refused", () => {
    const bars = generated(3);
    expect(() => dailySeries([bars[0]!, bars[2]!, bars[1]!])).toThrow(
      "out of order",
    );
  });
});
