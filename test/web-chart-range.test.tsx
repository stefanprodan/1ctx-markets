// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { render } from "preact-render-to-string";
import { trailingReturns } from "../src/signals/relative.ts";
import { railDrawer } from "../src/web/app/shell.ts";
import {
  askedFrom,
  type DailyRange,
  DESK,
  drawnFor,
  fromStart,
  type History,
  type HistoryBar,
  legendOf,
  PHONE,
  rangesOf,
  readRange,
} from "../src/web/views/Chart.model.ts";
import { Chart } from "../src/web/views/Chart.tsx";

const bar = (date: string, close: number): HistoryBar => ({
  date,
  open: null,
  high: null,
  low: null,
  close,
  volume: null,
  final: true,
  sma50: null,
  sma200: null,
});

// weekdays from first to last, a close each, but the days left out
function days(first: string, last: string, out: string[] = []): HistoryBar[] {
  const bars: HistoryBar[] = [];
  const d = new Date(`${first}T00:00:00Z`);
  for (let i = 0; d.toISOString().slice(0, 10) <= last; i++) {
    const date = d.toISOString().slice(0, 10);
    const wd = d.getUTCDay();
    if (wd !== 0 && wd !== 6 && !out.includes(date)) {
      bars.push(bar(date, 100 + i * 0.25 + 7 * Math.sin(i / 9)));
    }
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return bars;
}

const history = (bars: HistoryBar[], open = false): History => ({
  instrument: { id: "US:AAA", unit: "per_share" },
  interval: "1d",
  session: { state: open ? "open" : "closed" },
  bars,
});

// a Monday's last bar: 3M starts on a Sunday, YTD on a holiday
const LAST = "2026-08-31";
const TODAY = "2026-09-01";
const ALL = days("2025-06-02", LAST, ["2025-12-31", "2026-01-01"]);

// what the chart draws for a range: the route's bars from askedFrom on
function drawn(bars: HistoryBar[], range: DailyRange, open = false) {
  const from = askedFrom(range, TODAY);
  return fromStart(
    history(
      bars.filter((b) => b.date >= from),
      open,
    ),
    range,
  );
}

const PERIODS = [
  ["1M", "1m"],
  ["3M", "3m"],
  ["YTD", "ytd"],
] as const;

describe("the chart's range", () => {
  test("measures 1M, 3M and YTD as the server's returns", () => {
    const server = trailingReturns({
      bars: ALL.map((b) => ({ date: b.date, close: b.close! })),
      currency: "USD",
    })!;
    for (const [range, period] of PERIODS) {
      const { history: h, since } = drawn(ALL, range);
      expect(since).toBeNull();
      expect(legendOf(h, null)!.change!).toBeCloseTo(server[period]!, 10);
    }
    // the line starts at the close the change is measured from
    expect(drawn(ALL, "3M").history.bars[0]!.date).toBe("2026-05-29");
    expect(drawn(ALL, "YTD").history.bars[0]!.date).toBe("2025-12-30");
  });

  test("measures to a live price as the server does", () => {
    const live = ALL.map((b, i) =>
      i === ALL.length - 1 ? { ...b, close: 140, final: false } : b,
    );
    const server = trailingReturns({
      bars: ALL.slice(0, -1).map((b) => ({ date: b.date, close: b.close! })),
      live: { date: LAST, price: 140 },
      currency: "USD",
    })!;
    for (const [range, period] of PERIODS) {
      const { history: h } = drawn(live, range, true);
      expect(legendOf(h, null)!.change!).toBeCloseTo(server[period]!, 10);
    }
  });

  test("names the first bar's day when the range starts before it", () => {
    const young = days("2026-07-16", LAST);
    const ytd = drawn(young, "YTD");
    expect(ytd.since).toBe("since 16 Jul");
    expect(ytd.history.bars[0]!.date).toBe("2026-07-16");
    const first = young[0]!.close!;
    const last = young.at(-1)!.close!;
    expect(legendOf(ytd.history, null)!.change!).toBeCloseTo(
      (last / first - 1) * 100,
      10,
    );
    // the server has no return for it either
    expect(
      trailingReturns({
        bars: young.map((b) => ({ date: b.date, close: b.close! })),
        currency: "USD",
      })!.ytd,
    ).toBeNull();
    expect(drawn(young, "1M").since).toBeNull();
    // a first bar in an earlier year says its year
    expect(fromStart(history(days("2024-02-14", LAST)), "3Y").since).toBe(
      "since 14 Feb 2024",
    );
    // Max is from the first bar by name
    expect(fromStart(history(young), "Max").since).toBeNull();
  });
});

describe("a slow series", () => {
  // a monthly series dated the 1st, its latest a month and more old
  const MONTHLY = Array.from({ length: 30 }, (_, i) => {
    const d = new Date(Date.UTC(2024, 3 + i, 1)).toISOString().slice(0, 10);
    return bar(d, 100 + i);
  }).filter((b) => b.date <= "2026-09-01");

  function reader(bars: HistoryBar[]) {
    const asked: string[] = [];
    const read = async (from: string) => {
      asked.push(from);
      return history(bars.filter((b) => b.date >= from));
    };
    return { asked, read };
  }

  test("reads again for the close by its start, as the server measures", async () => {
    const server = trailingReturns({
      bars: MONTHLY.map((b) => ({ date: b.date, close: b.close! })),
      currency: "USD",
    })!;
    for (const [range, period] of PERIODS) {
      const r = reader(MONTHLY);
      const got = await readRange(r.read, range, "2026-11-01");
      expect([range, got.since]).toEqual([range, null]);
      expect(r.asked).toHaveLength(2);
      expect(legendOf(got.history, null)!.change!).toBeCloseTo(
        server[period]!,
        10,
      );
    }
  });

  test("says since only when the whole history starts after the range", async () => {
    const young = reader(MONTHLY.filter((b) => b.date >= "2026-07-01"));
    const got = await readRange(young.read, "YTD", "2026-11-01");
    expect(got.since).toBe("since 1 Jul");
    expect(young.asked).toHaveLength(2);
    // a daily listing finds its start in the first read
    const daily = reader(ALL);
    expect((await readRange(daily.read, "3M", TODAY)).since).toBeNull();
    expect(daily.asked).toHaveLength(1);
  });
});

describe("the chart's ranges without 5-minute closes", () => {
  test("offer no 1D or 5D and draw 1M for a kept one", () => {
    expect(rangesOf(DESK, false)).toEqual([
      "1M",
      "3M",
      "6M",
      "YTD",
      "1Y",
      "3Y",
      "5Y",
      "Max",
    ]);
    expect(rangesOf(PHONE, true)).toEqual(PHONE.ranges);
    expect(drawnFor(DESK, "5D", false)).toBe("1M");
    expect(drawnFor(DESK, "5D", true)).toBe("5D");
    expect(drawnFor(PHONE, "3M", false)).toBe("6M");
  });

  test("draw 1M for a kept 5D, which an instrument with them draws", () => {
    const store = new Map([["chart", JSON.stringify({ range: "5D" })]]);
    const before = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: () => {},
      },
    });
    try {
      railDrawer.value = false;
      const without = render(<Chart id="BVB:TLV" intraday={false} />);
      expect(without).not.toContain(">1D<");
      expect(without).not.toContain(">5D<");
      expect(without).toMatch(/seg-on"[^>]*>1M</);
      const withIt = render(<Chart id="US:AAA" intraday />);
      expect(withIt).toMatch(/seg-on"[^>]*>5D</);
    } finally {
      if (before === undefined)
        Reflect.deleteProperty(globalThis, "localStorage");
      else Object.defineProperty(globalThis, "localStorage", before);
    }
  });
});
