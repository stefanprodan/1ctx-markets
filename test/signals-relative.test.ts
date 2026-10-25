// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import {
  monthsBack,
  RETURN_NOTE,
  relativeReturn,
} from "../src/signals/relative.ts";

const bars = (rows: [string, number][]) =>
  rows.map(([date, close]) => ({ date, close }));

// the benchmark is closed on 2027-02-26, which the instrument traded
const benchmark = {
  bars: bars([
    ["2027-02-24", 90],
    ["2027-02-25", 100],
    ["2027-03-30", 105],
    ["2027-03-31", 110],
  ]),
  currency: "EUR",
};
const instrument = {
  bars: bars([
    ["2027-02-25", 50],
    ["2027-02-26", 999],
    ["2027-03-31", 60],
    ["2027-04-01", 999],
  ]),
  currency: "USD",
};

describe("relative return", () => {
  test("anchors on the benchmark's days and names both currencies", () => {
    // 2027-03-31 one month back clamps to 2027-02-28, a Sunday
    const r = relativeReturn(instrument, benchmark, 1)!;
    expect(r.benchmark).toMatchObject({
      from: "2027-02-25",
      to: "2027-03-31",
      currency: "EUR",
    });
    expect(r.instrument).toMatchObject({
      from: "2027-02-25",
      to: "2027-03-31",
      currency: "USD",
    });
    expect(r.benchmark.return).toBeCloseTo(10, 12);
    expect(r.instrument.return).toBeCloseTo(20, 12);
    expect(r.relative).toBeCloseTo(10, 12);
    expect(r.note).toBe(RETURN_NOTE);
    expect(RETURN_NOTE).toBe(
      "price returns in each listing's own currency; FX conversion excluded",
    );
  });

  test("a live price replaces its bar's close or follows the last bar", () => {
    const same = relativeReturn(
      instrument,
      { ...benchmark, live: { date: "2027-03-31", price: 120 } },
      1,
    )!;
    expect(same.benchmark.return).toBeCloseTo(20, 12);
    expect(same.relative).toBeCloseTo(0, 12);

    // a new benchmark day moves both end anchors to 2027-04-01
    const next = relativeReturn(
      instrument,
      { ...benchmark, live: { date: "2027-04-01", price: 100 } },
      1,
    )!;
    expect(next.benchmark).toMatchObject({ from: "2027-02-25", return: 0 });
    expect(next.instrument).toMatchObject({ to: "2027-04-01" });
  });

  test("no answer without a bar on or before the start", () => {
    expect(relativeReturn(instrument, benchmark, 3)).toBeNull();
    const late = { ...instrument, bars: instrument.bars.slice(1) };
    expect(relativeReturn(late, benchmark, 1)).toBeNull();
  });

  test("months back keep the day and clamp it to the month's end", () => {
    expect(monthsBack("2027-03-31", 1)).toBe("2027-02-28");
    expect(monthsBack("2028-03-31", 1)).toBe("2028-02-29");
    expect(monthsBack("2027-05-31", 3)).toBe("2027-02-28");
    expect(monthsBack("2027-01-15", 3)).toBe("2026-10-15");
  });
});
