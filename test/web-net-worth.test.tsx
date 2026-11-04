// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// Home's Wealth tab and the tabs around it, from made-up answers: no DOM,
// no network.

import { afterEach, describe, expect, test } from "bun:test";
import { render } from "preact-render-to-string";
import type {
  Holdings,
  NetWorth,
  Overview,
  Total,
  Worth,
} from "../src/web/data/portfolios.ts";
import { markets } from "../src/web/data/store.ts";
import {
  glanceCount,
  glanceTab,
  glanceTabs,
  wealthShown,
} from "../src/web/views/Dashboard.model.ts";
import {
  cashHref,
  cashPoints,
  dayPercent,
  keptSeries,
  linePoints,
  pointsOf,
  SHAPE_GUESS,
  shapeOf,
  totalOf,
  wealthOf,
  worthWords,
} from "../src/web/views/NetWorth.model.ts";
import { NetWorthPanel } from "../src/web/views/NetWorth.tsx";
import {
  labelOver,
  linePath,
  MIN_SPAN,
  WORTH_PAD,
} from "../src/web/views/PortfolioGrowth.model.ts";

const worthPath = (s: NetWorth, t: Total) =>
  linePath(linePoints(pointsOf(s, t)), 300, 64, WORTH_PAD);

// the heights of a path's points, top first
const heights = (line: string) =>
  [...line.matchAll(/,([\d.]+)/g)].map((m) => Number(m[1]));

const NOW = Date.parse("2030-11-04T12:00:00Z");

const TOTAL: Total = {
  currency: "EUR",
  value: 1500,
  net_worth: 2000,
  cost: 1000,
  pl: 200,
  pl_percent: 20,
  day_change: 100,
  invested: 1200,
  reserve: 500,
  dry_powder: 300,
  invested_weight: 80,
  reserve_weight: null,
  dry_powder_weight: 20,
};

const OVERVIEW: Overview = {
  display_currency: "EUR",
  portfolios: [
    { id: 1, name: "Cash", cash: true, trades: 0, positions: 2 },
    { id: 2, name: "Shares", trades: 3, positions: 0 },
  ],
  brokers: [],
};

const HOLDINGS: Holdings = {
  currency: null,
  display_currency: "EUR",
  totals: [],
  converted: { ...TOTAL, missing: [] },
  rates: [],
  exposure: [],
  holdings: [],
};

const series = (totals: number[], from = "2030-10-20"): NetWorth => {
  const start = Date.parse(`${from}T00:00:00Z`);
  const points = totals.map((total, i) => ({
    date: new Date(start + i * 86_400_000).toISOString().slice(0, 10),
    invested: 0,
    cash: total,
    total,
  }));
  return {
    currency: "EUR",
    from,
    to: points.at(-1)?.date ?? from,
    points,
    eased: [],
    missing: [],
  };
};

// no live figure, so the line keeps the series' own last point
const BARE: Total = { ...TOTAL, net_worth: null };

const WORTH: Worth = {
  overview: OVERVIEW,
  holdings: HOLDINGS,
  // this year's, as the page's own day words leave the year out
  series: series([1900, 1950, 2000], `${new Date().getFullYear()}-10-20`),
};

afterEach(() => {
  markets.portfolios.clear();
});

describe("the glance tabs", () => {
  test("put Wealth first for a person with a portfolio, Movers for one without", () => {
    expect(glanceTabs(true)).toEqual(["worth", "movers", "trend", "earnings"]);
    // shown while it is not yet known, so the loader holds its place
    expect(glanceTabs(null)).toEqual(["worth", "movers", "trend", "earnings"]);
    expect(glanceTabs(false)).toEqual(["movers", "trend", "earnings"]);
    expect(glanceTab(null, true)).toBe("worth");
    expect(glanceTab(null, null)).toBe("worth");
    expect(glanceTab(null, false)).toBe("movers");
    expect(glanceTab("trend", true)).toBe("trend");
    expect(glanceTab("worth", false)).toBe("movers");
    expect(glanceTab("nonsense", true)).toBe("worth");
  });

  test("follow the last answer while the portfolios are read", () => {
    expect(wealthShown(true, "0")).toBe(true);
    expect(wealthShown(false, "1")).toBe(false);
    expect(wealthShown(null, "1")).toBe(true);
    // a person without portfolios starts on Movers, no Wealth loader first
    expect(wealthShown(null, "0")).toBe(false);
    expect(glanceTab(null, wealthShown(null, "0"))).toBe("movers");
    expect(wealthShown(null, null)).toBeNull();
    expect(wealthShown(null, "maybe")).toBeNull();
  });

  test("count only above 0", () => {
    const s = { waiting: false, earnings: 3, crossed: 2 };
    expect(glanceCount("earnings", s)).toBe(3);
    expect(glanceCount("trend", s)).toBe(2);
    expect(glanceCount("worth", s)).toBeNull();
    expect(glanceCount("movers", s)).toBeNull();
    const none = { waiting: false, earnings: 0, crossed: 0 };
    expect(glanceCount("earnings", none)).toBeNull();
    expect(glanceCount("trend", none)).toBeNull();
    expect(glanceCount("earnings", { ...s, waiting: true })).toBeNull();
  });

  test("know a person has Wealth from their portfolios", () => {
    expect(wealthOf(null)).toBeNull();
    expect(wealthOf(WORTH)).toBe(true);
    expect(
      wealthOf({ ...WORTH, overview: { ...OVERVIEW, portfolios: [] } }),
    ).toBe(false);
    expect(
      wealthOf({
        ...WORTH,
        holdings: { ...HOLDINGS, converted: null, totals: [] },
      }),
    ).toBe(false);
  });
});

describe("the Cash tab's line", () => {
  const cash = (amounts: number[], currency = "EUR"): NetWorth => {
    const s = series(amounts.map((a) => a + 5000));
    return {
      ...s,
      currency,
      points: s.points.map((p, i) => ({ ...p, cash: amounts[i]! })),
    };
  };

  test("draws all cash per day, today on the hero's figure", () => {
    expect(cashPoints(cash([300, 320, 310]), "EUR", 340)).toEqual([
      { date: "2030-10-20", value: 300 },
      { date: "2030-10-21", value: 320 },
      { date: "2030-10-22", value: 340 },
    ]);
    // no figure keeps the series' own last day
    expect(cashPoints(cash([300, 320]), "EUR", null).at(-1)?.value).toBe(320);
  });

  test("draws none from a series in another currency", () => {
    expect(cashPoints(cash([300, 320], "USD"), "EUR", 340)).toEqual([]);
    expect(cashPoints(null, "EUR", 340)).toEqual([]);
  });

  test("spans at least 2% of the cash, the line centred", () => {
    const p = linePath(cashPoints(cash([500, 501]), "EUR", 501), 300, 64, 2)!;
    const ys = heights(p.line);
    expect(ys[0]! - ys[1]!).toBeCloseTo((1 / 10.02) * 60, 1);
    expect((ys[0]! + ys[1]!) / 2).toBeCloseTo(32, 1);
  });

  test("is titled and labelled as net worth's line", () => {
    const points = cashPoints(cash([1, 2], "EUR"), "EUR", null);
    expect(worthWords(points, NOW, "Cash")).toEqual({
      label: "20 Oct",
      title: "Cash since 20 Oct",
    });
  });
});

describe("the net worth band", () => {
  test("takes the converted total, the day's change of net worth before it", () => {
    expect(totalOf(WORTH)).toMatchObject({ net_worth: 2000 });
    // 100 on 1900 before it
    expect(dayPercent(TOTAL)).toBeCloseTo(5.263, 3);
    expect(dayPercent({ ...TOTAL, day_change: null })).toBeNull();
    expect(dayPercent({ ...TOTAL, net_worth: null })).toBeNull();
    expect(cashHref(WORTH)).toBe("/portfolios/1");
    expect(
      cashHref({
        ...WORTH,
        overview: { ...OVERVIEW, portfolios: [OVERVIEW.portfolios[1]!] },
      }),
    ).toBe("/portfolios");
  });

  test("maps the series to its totals, none in another currency", () => {
    expect(pointsOf(series([1900, 2000]), BARE)).toEqual([
      { date: "2030-10-20", total: 1900 },
      { date: "2030-10-21", total: 2000 },
    ]);
    // today ends on the band's figure, read again on each refresh
    expect(pointsOf(series([1900, 1990]), TOTAL).at(-1)).toEqual({
      date: "2030-10-21",
      total: 2000,
    });
    expect(pointsOf(WORTH.series, { ...TOTAL, currency: "USD" })).toEqual([]);
    expect(pointsOf(null, TOTAL)).toEqual([]);
  });

  test("keeps the series on a refresh through the owner's day only", () => {
    const kept = { ...WORTH, series: series([1, 2], "2030-11-03") };
    expect(keptSeries(kept, NOW)).toBe(kept.series);
    expect(keptSeries(kept, NOW + 86_400_000)).toBeNull();
    // the owner's zone dates the day: 4 Nov 12:00 UTC is 5 Nov in Kiritimati
    const east = {
      ...kept,
      overview: { ...OVERVIEW, time_zone: "Pacific/Kiritimati" },
    };
    expect(keptSeries(east, NOW)).toBeNull();
    expect(keptSeries({ ...WORTH, series: null }, NOW)).toBeNull();
  });

  test("labels the line by its first day, then months, then the year", () => {
    const of = (days: number) =>
      worthWords(
        pointsOf(series(Array(days + 1).fill(1), "2029-11-04"), BARE),
        NOW,
      );
    expect(
      worthWords(pointsOf(series([1, 2], "2030-11-02"), BARE), NOW),
    ).toEqual({ label: "2 Nov", title: "Net worth since 2 Nov" });
    expect(of(29).label).toBe("4 Nov 2029");
    expect(of(30).label).toBe("1M");
    expect(of(152).label).toBe("5M");
    expect(of(365)).toEqual({
      label: "1Y",
      title: "Net worth since 4 Nov 2029",
    });
  });

  test("draws no line under two points, its scale at least 2% of the value", () => {
    expect(worthPath(series([5]), BARE)).toBeNull();
    const flat = worthPath(series([1000, 1001]), BARE)!;
    // a 0.1% move stays near the middle, never the whole height
    const ys = heights(flat.line);
    expect(MIN_SPAN).toBe(0.02);
    expect(ys[0]! - ys[1]!).toBeCloseTo((1 / 20.02) * 60, 1);
    expect(flat.up).toBe(true);
    const fall = worthPath(series([1000, 500]), BARE)!;
    expect(fall.up).toBe(false);
    expect(fall.line).toBe("M0.0,2.0L300.0,62.0");
    expect(fall.area).toBe("M0.0,2.0L300.0,62.0L300,64L0,64Z");
  });

  test("puts the label above the end of a line ending low, under one ending high", () => {
    const rise = worthPath(series([1000, 1500]), BARE)!;
    expect(rise.end).toBe(2);
    expect(labelOver(rise, 64)).toBe(false);
    const fall = worthPath(series([1500, 1000]), BARE)!;
    expect(fall.end).toBe(62);
    expect(labelOver(fall, 64)).toBe(true);
    // a flat line ends in the middle, its label under it
    expect(labelOver(worthPath(series([1000, 1000]), BARE)!, 64)).toBe(false);
    // nothing to scale against: zero is drawn in the middle too
    const zero = worthPath(series([0, 0]), BARE)!;
    expect(zero.line).toBe("M0.0,32.0L300.0,32.0");
    expect(labelOver(zero, 64)).toBe(false);
  });

  test("keeps the loader's shape from widths only, a guess for anything else", () => {
    expect(shapeOf("[201,163,88]")).toEqual([201, 163, 88]);
    for (const raw of [null, "", "{", "[]", '["1"]', "[0]", "[-4]", "7"]) {
      expect([raw, shapeOf(raw)]).toEqual([raw, SHAPE_GUESS]);
    }
  });

  test("draws the figure, moves, bar and line, or the loader until read", () => {
    const waiting = render(<NetWorthPanel />);
    expect(waiting).toContain("nw-bar-waiting");
    expect(waiting).not.toContain("growth-svg");
    markets.portfolios.worth.value = WORTH;
    const html = render(<NetWorthPanel />);
    expect(html).toContain('href="/portfolios" class="nw-link"');
    expect(html).toContain(">2,000</a>");
    expect(html).toContain("today");
    expect(html).toContain("all time");
    expect(html).toContain('href="/portfolios/1" class="nw-link"');
    expect(html).toContain("Invested");
    expect(html).toContain("800.00 EUR");
    expect(html).toContain('aria-label="Net worth since 20 Oct"');
    expect(html).toContain("growth-up");
    markets.portfolios.worth.value = { ...WORTH, series: null };
    expect(render(<NetWorthPanel />)).not.toContain("growth-svg");
    markets.portfolios.clear();
    markets.portfolios.worthFailed.value = true;
    expect(render(<NetWorthPanel />)).toContain("Could not load net worth.");
  });
});
