// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { addDays } from "../src/market/zone.ts";
import { liveWeekly, weeklySeries } from "../src/signals/weekly.ts";

function weeks(closes: number[], from = "2023-01-02") {
  return closes.map((close, k) => ({ date: addDays(from, 7 * k), close }));
}

describe("weekly signals", () => {
  test("the cross has no edge at equality and an up edge past it", () => {
    // SMA 50 - SMA 200 reads -1, 0, then +3 over the last three weeks
    const rows = weeklySeries(
      weeks([210, ...Array.from({ length: 200 }, () => 10), 210]),
    );
    expect(rows[198]).toMatchObject({ sma200: null, cross: null });
    expect(rows[199]).toMatchObject({
      sma50: 10,
      sma200: 11,
      cross: -1,
      crossEdge: null,
    });
    expect(rows[200]).toMatchObject({ cross: 0, crossEdge: 0 });
    expect(rows[201]).toMatchObject({
      sma50: 14,
      sma200: 11,
      cross: 1,
      crossEdge: 1,
    });
  });

  test("the live week replaces the stored week's close", () => {
    const stored = weeks(Array.from({ length: 202 }, (_, k) => 100 + k));
    const rows = weeklySeries(stored);
    const replaced = liveWeekly(stored, rows[200]!, 500, {
      date: stored[201]!.date,
      replacesLast: true,
    });
    const expected = weeklySeries([
      ...stored.slice(0, 201),
      { date: stored[201]!.date, close: 500 },
    ])[201]!;
    expect(replaced).toEqual(expected);
    expect(replaced.sma50).toBeCloseTo(rows[201]!.sma50! + (500 - 301) / 50);

    const next = addDays(stored[201]!.date, 7);
    expect(
      liveWeekly(stored, rows[201]!, 500, { date: next, replacesLast: false }),
    ).toEqual(weeklySeries([...stored, { date: next, close: 500 }])[202]!);
  });

  test("a live week starts on a Monday", () => {
    const stored = weeks([1, 2]);
    expect(() =>
      liveWeekly(stored, weeklySeries(stored)[1]!, 3, {
        date: addDays(stored[1]!.date, 9),
        replacesLast: false,
      }),
    ).toThrow("not a Monday");
  });
});
