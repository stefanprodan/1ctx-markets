// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// The Portfolios hero's growth line and the fit of its figure, from
// made-up answers: no DOM, no network.

import { describe, expect, test } from "bun:test";
import { render } from "preact-render-to-string";
import type { Fetch } from "../src/web/data/api.ts";
import type {
  Growth,
  Holding,
  Holdings,
  NetWorth,
  Overview,
  TradeRow,
} from "../src/web/data/portfolios.ts";
import { store } from "../src/web/data/store.ts";
import { keptSeries } from "../src/web/views/NetWorth.model.ts";
import {
  FIT_FLOOR,
  FIT_SLACK,
  FIT_START,
  type FitRoom,
  GROWTH_PAD,
  growthKey,
  growthPoints,
  growthScope,
  growthShown,
  growthWords,
  hasCashLine,
  hasGrowth,
  heroFit,
  LINE_GAP,
  labelOver,
  linePath,
  shortMoney,
  yearBefore,
} from "../src/web/views/PortfolioGrowth.model.ts";
import { HeroFigure } from "../src/web/views/PortfolioGrowth.tsx";
import { PortfoliosBody } from "../src/web/views/Portfolios.tsx";

const NOW = Date.parse("2030-10-28T12:00:00Z");

const OVERVIEW: Overview = {
  display_currency: "EUR",
  portfolios: [
    { id: 3, name: "Cash", cash: true, trades: 0, positions: 1 },
    { id: 1, name: "Shares", trades: 1, positions: 0 },
    { id: 2, name: "Coins", trades: 1, positions: 0 },
  ],
  brokers: [{ id: 1, name: "North" }],
};

const total = (value: number, more: object = {}) => ({
  currency: "EUR",
  value,
  cost: value - 100,
  pl: 100,
  pl_percent: 10,
  day_change: 5,
  invested: value - 300,
  reserve: 0,
  dry_powder: 300,
  invested_weight: 70,
  reserve_weight: 0,
  dry_powder_weight: 30,
  ...more,
});

const share: Holding = {
  kind: "holding",
  id: "XETRA:AAA",
  position: null,
  name: "Alpha Made Up",
  type: "ETF",
  market: "XETRA",
  currency: "EUR",
  quantity: 7,
  average_cost: 80,
  cost: 560,
  price: 100,
  priced: "quote",
  as_of: null,
  value: 700,
  pl: 140,
  pl_percent: 25,
  day_change: 5,
  change_percent: 0.5,
  currency_weight: 70,
  stale: [],
  parts: [],
};

const cash: Holding = {
  ...share,
  kind: "cash",
  id: null,
  position: 5,
  name: "Kept for buying",
  type: "CASH",
  market: null,
  quantity: null,
  price: null,
  priced: "amount",
  as_of: "2030-10-01",
  value: 300,
  dry_powder: true,
};

const holdings = (value: number, rows: Holding[]): Holdings => ({
  currency: null,
  display_currency: "EUR",
  totals: [total(value)],
  converted: null,
  rates: [],
  exposure: [],
  holdings: rows,
});

// All and Shares tell apart by their totals and bar
const ALL = holdings(1000, [share, cash]);
const SHARES = holdings(4321, [share]);
const CASH = holdings(300, [cash]);

const trade = (id: number): TradeRow => ({
  id,
  portfolio: "Shares",
  symbol: "XETRA:AAA",
  name: "Alpha Made Up",
  side: "buy",
  date: "2030-03-02",
  quantity: 7,
  price: 80,
  fees: 0,
  currency: "EUR",
  broker: "North",
  note: null,
  entered_by: "casey-agent",
  entered_at: "2030-03-02T10:00:00Z",
  removed_at: null,
  removed_by: null,
});

// a day a point from from to to, the gain rising or falling by one a day
function series(from: string, to: string, step = 1): Growth {
  const points: Growth["points"] = [];
  for (
    let d = new Date(`${from}T00:00:00Z`), i = 0;
    d.toISOString().slice(0, 10) <= to;
    d.setUTCDate(d.getUTCDate() + 1), i++
  ) {
    points.push({
      date: d.toISOString().slice(0, 10),
      value: 1000 + i,
      invested: 1000 - step * i,
      gain: step * i,
    });
  }
  return { currency: "EUR", from, to, points, eased: [], missing: [] };
}

const YEAR = series("2029-10-28", "2030-10-28");

// as the hero draws it: the gain against the view's value
function growthPath(g: Growth) {
  const d = growthPoints(g);
  return linePath(d.points, 300, 64, GROWTH_PAD, d.against);
}

// all cash per day, from 2030-10-25 to the store's day
function cashSeries(amounts: number[], currency = "EUR"): NetWorth {
  const points = amounts.map((cash, i) => ({
    date: `2030-10-${25 + i}`,
    invested: 700,
    cash,
    total: 700 + cash,
  }));
  return {
    currency,
    from: points[0]!.date,
    to: points.at(-1)!.date,
    points,
    eased: [],
    missing: [],
  };
}

const CASH_DAYS = cashSeries([250, 260, 280, 290]);

// answers by path prefix, the first match winning; a gate holds the
// portfolios' reads until opened
function fake(answers: [string, unknown][], gate?: { prefix: string }) {
  const asked: string[] = [];
  let open: () => void = () => {};
  const held = new Promise<void>((r) => {
    open = r;
  });
  const fetch: Fetch = async (path) => {
    const key = `GET ${path}`;
    asked.push(key);
    if (gate && key.startsWith(gate.prefix)) await held;
    const hit = answers.find(([k]) => key.startsWith(k));
    if (hit === undefined) throw new Error(`no answer for ${key}`);
    return Response.json(hit[1]);
  };
  return { fetch, asked, gate: () => open() };
}

const ANSWERS: [string, unknown][] = [
  ["GET /api/v1/holdings/growth", YEAR],
  ["GET /api/v1/holdings/net-worth", CASH_DAYS],
  ["GET /api/v1/brokers", { broker: { id: 2, name: "South" } }],
  ["GET /api/v1/portfolios/1/growth", series("2030-05-08", "2030-10-28")],
  ["GET /api/v1/portfolios/1/holdings", SHARES],
  ["GET /api/v1/portfolios/3/holdings", CASH],
  ["GET /api/v1/portfolios", OVERVIEW],
  ["GET /api/v1/holdings", ALL],
  ["GET /api/v1/trades", { trades: [trade(1)] }],
];

async function opened(portfolio: number | null = null, gate?: string) {
  const f = fake(ANSWERS, gate ? { prefix: gate } : undefined);
  const s = store(
    f.fetch,
    () => NOW,
    () => "/portfolios",
    () => {},
  );
  await s.portfolios.open({ portfolio, currency: null });
  return { st: s.portfolios, asked: f.asked, gate: f.gate };
}

type Store = Awaited<ReturnType<typeof opened>>["st"];

const keyOf = (st: Store) =>
  growthKey(st.shown.value!, st.trades.value!, st.holdings.value!);

// the series the hero draws now, read as the page reads it
const grow = (st: Store) => st.growth(st.shown.value!, keyOf(st));

const page = (st: Store) => render(<PortfoliosBody store={st} />);

const room = (more: Partial<FitRoom>): FitRoom => ({
  width: 390,
  figure: 150,
  brief: 60,
  currency: 40,
  line: 130,
  display: 28,
  ...more,
});

describe("the hero's fit", () => {
  test("a figure with room keeps the line beside", () => {
    expect(heroFit(room({}), FIT_START)).toEqual(FIT_START);
    // exactly the figure, its currency, the gap and the line
    const width = 150 + 40 + LINE_GAP + 130;
    expect(heroFit(room({ width }), FIT_START)).toEqual(FIT_START);
  });

  test("a figure that needs the room moves the line under, whole", () => {
    expect(heroFit(room({ figure: 250 }), FIT_START)).toEqual({
      line: "under",
      size: null,
      short: false,
    });
  });

  test("a figure wider than the hero shrinks in even pixels", () => {
    const fit = heroFit(room({ figure: 450 }), FIT_START);
    expect(fit.line).toBe("under");
    expect(fit.short).toBe(false);
    // 28 * 350 / 450 = 21.8, down to 20
    expect(fit.size).toBe(20);
    expect(heroFit(room({ figure: 400 }), FIT_START).size).toBe(24);
    expect(fit.size! % 2).toBe(0);
  });

  test("past the floor the figure reads short", () => {
    const fit = heroFit(room({ figure: 900 }), FIT_START);
    expect(fit).toEqual({ line: "under", size: 28, short: true });
    // a short form wider than the room shrinks too, never under the floor
    expect(heroFit(room({ figure: 900, brief: 400 }), FIT_START)).toEqual({
      line: "under",
      size: 24,
      short: true,
    });
    expect(heroFit(room({ figure: 900, brief: 900 }), FIT_START).size).toBe(
      FIT_FLOOR,
    );
    expect(shortMoney(9_876_543_210_000)).toBe("9.88T");
    expect(shortMoney(null)).toBe("—");
  });

  test("a line under goes back beside only with the slack to spare", () => {
    const under = { line: "under", size: null, short: false } as const;
    const edge = 150 + 40 + LINE_GAP + 130;
    expect(heroFit(room({ width: edge }), under)).toEqual(under);
    expect(heroFit(room({ width: edge + FIT_SLACK - 1 }), under)).toEqual(
      under,
    );
    expect(heroFit(room({ width: edge + FIT_SLACK }), under)).toEqual(
      FIT_START,
    );
  });

  test("no line leaves the room to the figure", () => {
    expect(heroFit(room({ figure: 340, line: 0 }), FIT_START)).toEqual(
      FIT_START,
    );
  });
});

describe("the growth line's words and path", () => {
  test("a full year is the past year", () => {
    expect(growthWords(YEAR)).toEqual({
      label: "1Y",
      title: "Past year growth excluding cash",
    });
  });

  test("a view younger than a year says its months and first day", () => {
    expect(growthWords(series("2030-05-08", "2030-10-28"))).toEqual({
      label: "6M",
      title: "Growth since 8 May excluding cash",
    });
    // rounded, never under a month
    expect(growthWords(series("2030-08-14", "2030-10-28")).label).toBe("2M");
    expect(growthWords(series("2030-10-25", "2030-10-28")).label).toBe("1M");
  });

  test("a year before a leap day is the 28th", () => {
    expect(yearBefore("2032-02-29")).toBe("2031-02-28");
    expect(yearBefore("2030-10-28")).toBe("2029-10-28");
  });

  test("green when the gain ended up, red when down; none under two days", () => {
    expect(growthPath(YEAR)?.up).toBe(true);
    expect(growthPath(series("2030-01-01", "2030-03-01", -1))?.up).toBe(false);
    const one = series("2030-10-28", "2030-10-28");
    expect(growthPath(one)).toBeNull();
    // a year's gain spans the height, the stroke's room kept
    expect(growthPath(YEAR)!.line).toStartWith("M0.0,60.0L");
    expect(growthPath(YEAR)!.end).toBe(4);
  });

  test("a gain of a tenth of a percent of the value stays near the middle", () => {
    // gain 0 then 1 on a value of 1001: the scale spans 2% of 1001
    const path = growthPath(series("2030-10-27", "2030-10-28"))!;
    expect(path.line).toBe("M0.0,33.4L300.0,30.6");
    // drawn against its own gain it would fill the height
    const own = growthPoints(series("2030-10-27", "2030-10-28")).points;
    expect(linePath(own, 300, 64, GROWTH_PAD)!.line).toBe(
      "M0.0,60.0L300.0,4.0",
    );
  });

  test("the label goes above the end of a falling line", () => {
    expect(labelOver(growthPath(YEAR)!, 64)).toBe(false);
    const fall = growthPath(series("2030-01-01", "2030-03-01", -1))!;
    expect(labelOver(fall, 64)).toBe(true);
  });

  test("Cash and a view of cash alone have no growth line", () => {
    expect(hasGrowth(ALL, false)).toBe(true);
    expect(hasGrowth(ALL, true)).toBe(false);
    expect(hasGrowth(CASH, false)).toBe(false);
  });

  test("only the person's own Cash portfolio has the cash line", () => {
    const [cashRow, shares] = OVERVIEW.portfolios;
    expect(hasCashLine(cashRow, true)).toBe(true);
    // a Cash portfolio shared with them is another person's cash
    expect(hasCashLine(cashRow, false)).toBe(false);
    expect(hasCashLine(shares, true)).toBe(false);
    expect(hasCashLine(undefined, true)).toBe(false);
  });
});

describe("the hero's growth line on the page", () => {
  test("holds an empty slot until its series lands, then draws it", async () => {
    const { st, asked } = await opened();
    const waiting = page(st);
    expect(waiting).toContain('<div class="growth" aria-hidden="true"></div>');
    expect(waiting).not.toContain("growth-svg");
    await grow(st);
    expect(asked).toContain("GET /api/v1/holdings/growth");
    const drawn = page(st);
    expect(drawn).toContain('class="growth-svg growth-up"');
    expect(drawn).toContain('title="Past year growth excluding cash"');
    expect(drawn).toContain(">1Y<");
  });

  test("a view seen once draws at once, never read again", async () => {
    const { st, asked } = await opened();
    await grow(st);
    await grow(st);
    expect(asked.filter((a) => a.includes("/growth"))).toHaveLength(1);
    // the minute's refresh keeps the key, so the line stays as drawn
    const before = keyOf(st);
    await st.load();
    expect(keyOf(st)).toBe(before);
    const drawn = page(st);
    expect(drawn).toContain("growth-svg");
    // drawn from the cache: no fade
    expect(drawn).not.toContain("growth-fade");
  });

  test("a trade added reads the series again", async () => {
    const { st } = await opened();
    const before = keyOf(st);
    st.trades.value = [trade(1), trade(2)];
    expect(keyOf(st)).not.toBe(before);
    st.trades.value = [trade(1), { ...trade(2), removed_at: "2030-10-28" }];
    expect(keyOf(st)).toBe(before);
  });

  test("a new view never shows the last view's line", async () => {
    const { st, asked } = await opened();
    await grow(st);
    await st.pick({ portfolio: 1 });
    const next = page(st);
    expect(next).toContain("4,321");
    expect(next).not.toContain("growth-svg");
    expect(next).toContain('<div class="growth" aria-hidden="true"></div>');
    await grow(st);
    expect(asked).toContain("GET /api/v1/portfolios/1/growth");
    const young = page(st);
    expect(young).toContain('title="Growth since 8 May excluding cash"');
    expect(young).toContain(">6M<");
  });

  test("a currency picked is asked for", async () => {
    const { st, asked } = await opened(1);
    await st.pick({ currency: "USD" });
    await grow(st);
    expect(asked).toContain("GET /api/v1/portfolios/1/growth?currency=USD");
  });

  test("Cash holds a slot, then draws its cash per day", async () => {
    const { st, asked } = await opened(3);
    expect(page(st)).toContain('<div class="growth" aria-hidden="true"></div>');
    await st.cash("EUR", keptSeries);
    expect(asked).toContain("GET /api/v1/holdings/net-worth?currency=EUR");
    expect(asked.filter((a) => a.includes("/growth"))).toHaveLength(0);
    const drawn = page(st);
    expect(drawn).toContain('class="growth-svg growth-up"');
    expect(drawn).toContain('title="Cash since 25 Oct 2030"');
    // the minute's refresh reads no series
    await st.load();
    await st.cash("EUR", keptSeries);
    expect(asked.filter((a) => a.includes("/net-worth"))).toHaveLength(1);
  });

  test("Cash ends its line on the hero's figure", async () => {
    const f = fake([
      ["GET /api/v1/holdings/net-worth", cashSeries([300, 290, 280, 200])],
      ...ANSWERS,
    ]);
    const s = store(
      f.fetch,
      () => NOW,
      () => "/portfolios",
      () => {},
    );
    await s.portfolios.open({ portfolio: 3, currency: null });
    await s.portfolios.cash("EUR", keptSeries);
    // the last day's 200 is the hero's 300: back up, ending at the top
    const drawn = page(s.portfolios);
    expect(drawn).toContain("growth-up");
    expect(drawn).toContain('class="growth-label"');
    expect(drawn).not.toContain("growth-label-over");
  });

  test("Cash in another currency than its series has no line and no slot", async () => {
    const f = fake([
      ["GET /api/v1/holdings/net-worth", cashSeries([1, 2], "USD")],
      ...ANSWERS,
    ]);
    const s = store(
      f.fetch,
      () => NOW,
      () => "/portfolios",
      () => {},
    );
    await s.portfolios.open({ portfolio: 3, currency: null });
    await s.portfolios.cash("EUR", keptSeries);
    expect(page(s.portfolios)).not.toContain('class="growth');
  });

  test("Cash under two days has no line and no slot", async () => {
    const f = fake([
      ["GET /api/v1/holdings/net-worth", cashSeries([250])],
      ...ANSWERS,
    ]);
    const s = store(
      f.fetch,
      () => NOW,
      () => "/portfolios",
      () => {},
    );
    await s.portfolios.open({ portfolio: 3, currency: null });
    await s.portfolios.cash("EUR", keptSeries);
    expect(page(s.portfolios)).not.toContain('class="growth');
  });

  test("a save reads the cash again", async () => {
    const { st, asked } = await opened(3);
    await st.cash("EUR", keptSeries);
    expect(page(st)).toContain("growth-svg");
    expect(await st.createBroker("South")).toBeNull();
    expect(st.cashes.value.size).toBe(0);
    await st.cash("EUR", keptSeries);
    expect(asked.filter((a) => a.includes("/net-worth"))).toHaveLength(2);
  });

  test("a read made while a save is out never keeps the days before it", async () => {
    let saved = false;
    let release: () => void = () => {};
    const held = new Promise<void>((r) => {
      release = r;
    });
    const f = fake(ANSWERS);
    const s = store(
      async (path, init) => {
        if (init?.method === "POST") {
          await held;
          saved = true;
          return Response.json({ broker: { id: 2, name: "South" } });
        }
        if (String(path).startsWith("/api/v1/holdings/net-worth"))
          return Response.json(cashSeries(saved ? [900, 910] : [100, 110]));
        return f.fetch(path, init);
      },
      () => NOW,
      () => "/portfolios",
      () => {},
    );
    const st = s.portfolios;
    await st.open({ portfolio: 3, currency: null });
    await st.cash("EUR", keptSeries);
    const saving = st.createBroker("South");
    // the page reads again whenever the kept series is gone
    await st.cash("EUR", keptSeries);
    release();
    expect(await saving).toBeNull();
    await st.cash("EUR", keptSeries);
    expect(st.cashes.value.get("EUR")?.points[0]?.cash).toBe(900);
  });

  test("a failed cash read is tried again when Cash is shown again", async () => {
    let fail = true;
    const f = fake(ANSWERS);
    const s = store(
      async (path, init) =>
        String(path).includes("/net-worth") && fail
          ? new Response("no", { status: 500 })
          : f.fetch(path, init),
      () => NOW,
      () => "/portfolios",
      () => {},
    );
    const st = s.portfolios;
    await st.open({ portfolio: 3, currency: null });
    await st.cash("EUR", keptSeries);
    expect(page(st)).not.toContain('class="growth');
    // the minute's refresh does not read it again
    fail = false;
    await st.load();
    await st.cash("EUR", keptSeries);
    expect(st.cashes.value.get("EUR")).toBeNull();
    st.cashAgain();
    await st.cash("EUR", keptSeries);
    expect(page(st)).toContain("growth-svg");
    const reads = f.asked.filter((a) => a.includes("/net-worth")).length;
    // a series read is kept when Cash is shown again
    st.cashAgain();
    await st.cash("EUR", keptSeries);
    expect(f.asked.filter((a) => a.includes("/net-worth"))).toHaveLength(reads);
  });

  test("Home's series of today stands in for the Cash tab's", async () => {
    const { st, asked } = await opened(3);
    const own = { ...CASH_DAYS, to: "2030-10-28" };
    await st.loadWorth();
    st.worth.value = { ...st.worth.value!, series: own };
    const kept = (w: { series: NetWorth | null }) => w.series;
    const reads = asked.filter((a) => a.includes("/net-worth")).length;
    await st.cash("EUR", kept);
    expect(asked.filter((a) => a.includes("/net-worth"))).toHaveLength(reads);
    expect(st.cashes.value.get("EUR")).toBe(own);
    expect(asked).not.toContain("GET /api/v1/holdings/net-worth?currency=EUR");
    // another currency is read
    await st.cash("USD", kept);
    expect(asked).toContain("GET /api/v1/holdings/net-worth?currency=USD");
    // a save may have moved past days Home read before it
    expect(await st.createBroker("South")).toBeNull();
    await st.cash("EUR", kept);
    expect(asked).toContain("GET /api/v1/holdings/net-worth?currency=EUR");
  });

  test("a shared Cash portfolio reads no cash", async () => {
    const f = fake(ANSWERS);
    const s = store(
      f.fetch,
      () => NOW,
      () => "/portfolios",
      () => {},
    );
    await s.shared.openOf("casey", { portfolio: 3, currency: null });
    await s.shared.cash("EUR", keptSeries);
    expect(f.asked.filter((a) => a.includes("/net-worth"))).toHaveLength(0);
    expect(page(s.shared)).not.toContain('class="growth');
  });

  test("under two days held, no line and no slot", async () => {
    const f = fake([
      ["GET /api/v1/holdings/growth", series("2030-10-28", "2030-10-28")],
      ...ANSWERS,
    ]);
    const s = store(
      f.fetch,
      () => NOW,
      () => "/portfolios",
      () => {},
    );
    await s.portfolios.open({ portfolio: null, currency: null });
    expect(page(s.portfolios)).toContain('class="growth"');
    await grow(s.portfolios);
    expect(page(s.portfolios)).not.toContain('class="growth');
  });

  test("a failed read draws no line and no slot, and the next key reads again", async () => {
    let fail = true;
    const f = fake(ANSWERS);
    const s = store(
      async (path, init) =>
        String(path).includes("/growth") && fail
          ? new Response("no", { status: 500 })
          : f.fetch(path, init),
      () => NOW,
      () => "/portfolios",
      () => {},
    );
    await s.portfolios.open({ portfolio: null, currency: null });
    await grow(s.portfolios);
    expect(page(s.portfolios)).not.toContain('class="growth');
    // the same key is not read again; a trade saved is a new key
    fail = false;
    await grow(s.portfolios);
    expect(page(s.portfolios)).not.toContain('class="growth');
    s.portfolios.trades.value = [trade(1), trade(2)];
    await grow(s.portfolios);
    expect(page(s.portfolios)).toContain("growth-svg");
  });
});

describe("the hero while a tab is read", () => {
  test("keeps the name and bar of the figures drawn until the read lands", async () => {
    const { st, gate } = await opened(null, "GET /api/v1/portfolios/1/");
    await grow(st);
    const picked = st.pick({ portfolio: 1 });
    expect(st.portfolio.value).toBe(1);
    const held = page(st);
    expect(held).toContain("All portfolios");
    expect(held).toContain("1,000");
    // All's bar, Invested against Dry powder, never a portfolio's
    expect(held).toContain("pf-ivc-dry");
    expect(held).not.toContain("pf-ivc-cash");
    expect(held).toContain("growth-svg");
    gate();
    await picked;
    const landed = page(st);
    expect(landed).toContain("4,321");
    expect(landed).not.toContain("All portfolios");
    expect(landed).toContain('<h2 class="hero-name">Shares</h2>');
    expect(landed).toContain("pf-ivc-cash");
  });
});

describe("a save on the same view", () => {
  const scope = growthScope({ portfolio: 1, currency: null }, SHARES);
  const last = { scope, series: YEAR };
  const next = series("2029-10-28", "2030-10-28", 2);

  test("keeps the last line drawn while the new key is read", () => {
    expect(growthShown(undefined, last, scope)).toEqual({
      series: YEAR,
      held: true,
      none: false,
    });
    expect(growthShown(next, last, scope)).toEqual({
      series: next,
      held: false,
      none: false,
    });
  });

  test("another view or currency never shows the last line", () => {
    const other = growthScope({ portfolio: 2, currency: null }, SHARES);
    const usd = growthScope({ portfolio: 1, currency: "USD" }, SHARES);
    for (const s of [other, usd]) {
      expect(growthShown(undefined, last, s)).toEqual({
        series: null,
        held: false,
        none: false,
      });
    }
    expect(growthShown(undefined, null, scope).series).toBeNull();
  });

  test("a failed read or under two days is no line", () => {
    expect(growthShown(null, last, scope)).toEqual({
      series: null,
      held: false,
      none: true,
    });
    const one = series("2030-10-28", "2030-10-28");
    expect(growthShown(one, last, scope).none).toBe(true);
  });
});

describe("what reads the series again", () => {
  const bond: Holding = {
    ...share,
    kind: "bond",
    id: null,
    position: 9,
    name: "Made Up 2030",
    type: "BOND",
    quantity: 1000,
    cost: 990,
    priced: "face",
    as_of: "2030-01-05",
    parts: [
      {
        portfolio: "Shares",
        broker: "North",
        quantity: 1000,
        average_cost: 99,
        cost: 990,
        value: 1000,
        position: 9,
        as_of: "2030-01-05",
        amount: 1000,
      },
    ],
  };
  const all = { portfolio: null, currency: null };

  test("a bond's face edited", () => {
    const before = growthKey(all, [trade(1)], holdings(1000, [bond]));
    const face = {
      ...bond,
      quantity: 2000,
      parts: [{ ...bond.parts[0]!, quantity: 2000, amount: 2000 }],
    };
    expect(growthKey(all, [trade(1)], holdings(1000, [face]))).not.toBe(before);
  });

  test("the display currency changed, unless one is picked", () => {
    const usd = { ...ALL, display_currency: "USD" };
    expect(growthKey(all, [trade(1)], usd)).not.toBe(
      growthKey(all, [trade(1)], ALL),
    );
    const picked = { portfolio: null, currency: "RON" };
    expect(growthKey(picked, [trade(1)], usd)).toBe(
      growthKey(picked, [trade(1)], ALL),
    );
  });
});

describe("the hero's figure", () => {
  test("a short figure keeps the full one and its currency in its title", () => {
    const v = 9_876_543_210_987_654;
    expect(render(<HeroFigure value={v} currency="IDR" short={true} />)).toBe(
      '<span title="9,876,543,210,987,654 IDR">9876.54T</span>',
    );
    expect(
      render(<HeroFigure value={4321} currency="EUR" short={false} />),
    ).toBe("4,321");
  });
});
