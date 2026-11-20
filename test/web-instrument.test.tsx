// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { options } from "preact";
import { render } from "preact-render-to-string";
import { App } from "../src/web/app/App.tsx";
import { path } from "../src/web/app/router.ts";
import type { Holding, TradeRow } from "../src/web/data/portfolios.ts";
import {
  type Detail,
  type Listed,
  markets,
  type TopHoldings,
} from "../src/web/data/store.ts";
import { briefQuantity } from "../src/web/lib/format.ts";
import { stopped } from "../src/web/lib/names.ts";
import { MenuButton } from "../src/web/ui/Menu.tsx";
import { barWidth } from "../src/web/ui/Weights.tsx";
import { monthlyShares, tradeMarks } from "../src/web/views/Chart.model.ts";
import { tradeText } from "../src/web/views/Chart.tsx";
import {
  afterHours,
  buyable,
  isinInput,
  onSymbolPage,
  priceState,
} from "../src/web/views/Instrument.model.ts";
import { Instrument } from "../src/web/views/Instrument.tsx";
import { signalsOf } from "../src/web/views/InstrumentCards.model.ts";
import { InstrumentCards } from "../src/web/views/InstrumentCards.tsx";
import {
  fundOf,
  ratingName,
  sectorName,
} from "../src/web/views/InstrumentFund.model.ts";
import { InstrumentMenu } from "../src/web/views/InstrumentMenu.tsx";
import {
  heldOf,
  interestFacts,
  positionOf,
} from "../src/web/views/InstrumentPosition.model.ts";
import { PositionCard } from "../src/web/views/InstrumentPosition.tsx";
import { gainOf, PositionsBody } from "../src/web/views/Positions.tsx";

const NOW = Date.parse("2026-11-01T12:00:00Z");

const listed = (id: string, more: Partial<Listed> = {}): Listed => ({
  id,
  name: `${id} name`,
  market: id.split(":")[0]!,
  currency: "USD",
  kind: "EQUITY",
  unit: "per_share",
  source: "yahoo",
  tracked: true,
  tracked_by: ["read"],
  read_until: null,
  price: 50,
  change: 1,
  change_percent: 2,
  fetched_at: "2026-11-01T11:59:00Z",
  ...more,
});

const detail = (
  row: Partial<Listed> = {},
  more: Partial<Detail> = {},
  quote: Partial<NonNullable<Detail["quote"]>> = {},
): Detail => ({
  instrument: listed("US:CASY", row),
  intraday: true,
  credit: null,
  error: null,
  quote: {
    id: "US:CASY",
    price: 50,
    change: 1,
    change_percent: 2,
    unit: "per_share",
    currency: "USD",
    fetched_at: "2026-11-01T11:59:30Z",
    stale: [],
    returns: {
      "1w": 1.5,
      "1m": -3.25,
      "3m": null,
      ytd: 12,
      "1y": 15,
      to: "2026-11-01",
      live: true,
    },
    session: { state: "closed", start: null, end: null },
    ...quote,
  },
  ...more,
});

const part = (
  portfolio: string,
  broker: string | null,
  more: Partial<Holding["parts"][number]> = {},
): Holding["parts"][number] => ({
  portfolio,
  broker,
  quantity: 10,
  average_cost: 40,
  cost: 400,
  value: 500,
  ...more,
});

const holding = (more: Partial<Holding> = {}): Holding => ({
  kind: "holding",
  id: "US:CASY",
  position: null,
  name: "Casey Made Up",
  type: "EQUITY",
  market: "US",
  currency: "USD",
  unit: "per_share",
  quantity: 25.4567,
  average_cost: 40,
  cost: 1018.27,
  price: 50,
  priced: "quote",
  as_of: null,
  value: 1272.84,
  pl: 254.57,
  pl_percent: 25,
  day_change: -12.5,
  change_percent: -0.97,
  currency_weight: 10,
  stale: [],
  parts: [part("Shares", "North", { quantity: 25.4567, value: 1272.84 })],
  ...more,
});

const bond = (more: Partial<Holding> = {}): Holding =>
  holding({
    kind: "bond",
    id: "BVB:CASY29",
    type: "BOND",
    market: "BVB",
    currency: "RON",
    unit: "percent_of_par",
    quantity: null,
    average_cost: null,
    cost: 5000,
    price: null,
    priced: "face",
    as_of: "2026-03-09",
    value: 5000,
    pl: null,
    pl_percent: null,
    day_change: null,
    change_percent: null,
    coupon: 5.5,
    maturity: "2029-04-15",
    parts: [
      part("Bonds", "West", {
        quantity: null,
        average_cost: null,
        cost: 2000,
        amount: 2000,
        value: 2000,
      }),
      part("Bonds", "East", {
        quantity: null,
        average_cost: null,
        cost: 3000,
        amount: 3000,
        value: 3000,
      }),
    ],
    ...more,
  });

const holdings = (more: Partial<TopHoldings> = {}): TopHoldings => ({
  source: "made-up",
  fetched_at: "2026-11-01T06:00:00Z",
  stale: [],
  top: [
    {
      rank: 1,
      symbol: "AAA",
      id: "US:AAA",
      name: "Alpha Made Up",
      weight_percent: 20.04,
    },
    {
      rank: 2,
      symbol: "BBB",
      id: null,
      name: "Beta Made Up",
      weight_percent: 10,
    },
    {
      rank: 3,
      symbol: null,
      id: null,
      name: "Gamma Made Up Holdings",
      weight_percent: 5,
    },
  ],
  top_weight_percent: 35.04,
  sectors: [
    { sector: "technology", weight_percent: 60 },
    { sector: "realestate", weight_percent: 30 },
    { sector: "consumer_cyclical", weight_percent: 10 },
  ],
  bond_ratings: [],
  government_bonds_percent: null,
  ...more,
});

const fund = (t: TopHoldings | undefined, kind = "ETF") =>
  detail({ kind }, t === undefined ? {} : { top_holdings: t });

describe("the instrument page's position", () => {
  test("shows only for a held instrument, with its value and gains", () => {
    expect(
      render(<InstrumentCards detail={detail()} held={null} />),
    ).not.toContain("Your position");
    // cash names no instrument, and another id is another listing
    const cash = holding({ kind: "cash", id: null });
    expect(heldOf([cash, holding({ id: "US:OTHER" })], "US:CASY")).toBeNull();
    const h = holding();
    expect(heldOf([cash, h], "US:CASY")).toBe(h);
    const html = render(<InstrumentCards detail={detail()} held={h} />);
    expect(html).toContain("Your position");
    expect(html).toContain('1,273<span class="hero-ccy">USD</span>');
    expect(html).toContain("+254.57 USD");
    expect(html).toContain("+25.00%");
    expect(html).toContain("all time");
    expect(html).toContain("−12.50 USD");
    expect(html).toContain("today");
    expect(html).toContain("Quantity");
    expect(html).toContain("25.46");
    expect(html).toContain("Average price");
    expect(html).toContain("40.00 USD");
    // the card's button opens the drawer; the eye is in the page head
    expect(html).toContain('aria-label="Activity"');
    expect(html).not.toContain('href="/portfolios"');
    expect(html).not.toContain("Hide amounts");
    // one part: no line per broker
    expect(html).not.toContain("ins-parts");
  });

  test("Hide amounts blurs the money and quantities, not the percents", () => {
    const shown = render(<PositionCard h={holding()} hide={false} />);
    expect(shown).not.toContain("amounts-hidden");
    const hidden = render(<PositionCard h={holding()} hide={true} />);
    expect(hidden).toContain("amounts-hidden");
    expect(hidden).toContain('class="hero-value amount"');
    expect(hidden).toContain('<span class="num up amount">+254.57 USD</span>');
    expect(hidden).toContain('<span class="amount">25.46</span>');
    expect(hidden).toContain('<span class="num up">+25.00%</span>');
  });

  test("a line per portfolio and broker when it is held at several", () => {
    const h = holding({
      parts: [
        part("Shares", "North", { quantity: 20, value: 1000 }),
        part("Trading", null, { quantity: 0.123456, value: 6.17 }),
      ],
    });
    expect(positionOf(h, NOW).parts).toEqual([
      {
        key: "Shares/North",
        where: "Shares · North",
        held: "20",
        value: "1,000 USD",
      },
      { key: "Trading/", where: "Trading", held: "0.1235", value: "6.17 USD" },
    ]);
    const html = render(<PositionCard h={h} hide={false} />);
    expect(html).toContain("Shares · North");
    expect(html).toContain("ins-parts");
  });

  test("a bond says its face value, coupon, maturity and purchase", () => {
    const p = positionOf(bond(), NOW);
    expect(p.facts.map((f) => [f.label, f.value, f.amount])).toEqual([
      ["Face value", "5,000 RON", true],
      ["Coupon", "5.5%", false],
      ["Matures", "15 Apr 2029", false],
      // this year's date has no year
      ["Bought", "9 Mar", false],
    ]);
    // no gain on a face value: no moves to show
    expect(
      p.moves.every((m) => m.money.text === "" && m.percent.text === ""),
    ).toBe(true);
    expect(p.parts.map((x) => [x.where, x.held])).toEqual([
      ["Bonds · West", "2,000 RON"],
      ["Bonds · East", "3,000 RON"],
    ]);
    const html = render(<PositionCard h={bond()} hide={false} />);
    expect(html).not.toContain("Quantity");
    expect(html).not.toContain("all time");
  });

  test("a bond with its coupon dates adds accrued, coupons paid and the next payout", () => {
    const h = bond({
      accrued: 41.2,
      coupons_paid: 275,
      next_payout: { date: "2027-04-15", amount: 275 },
    });
    expect(
      positionOf(h, NOW)
        .facts.slice(4)
        .map((f) => [f.label, f.value]),
    ).toEqual([
      ["Accrued", "41.20 RON"],
      ["Coupons paid", "275.00 RON"],
      ["Next payout", "275.00 RON on 15 Apr 2027"],
    ]);
    // none without them: the stale tag says why
    expect(interestFacts(bond({ accrued: null }), NOW)).toEqual([]);
    expect(interestFacts(holding(), NOW)).toEqual([]);
  });

  test("quantities read to two decimals, a fraction to four digits", () => {
    expect(briefQuantity(1234.5678)).toBe("1,234.57");
    expect(briefQuantity(1)).toBe("1");
    expect(briefQuantity(0.000123456)).toBe("0.0001235");
    expect(briefQuantity(null)).toBe("—");
  });
});

const trade = (id: number, more: Partial<TradeRow> = {}): TradeRow => ({
  id,
  portfolio: "Shares",
  symbol: "US:CASY",
  name: "Casey Made Up",
  side: "buy",
  date: "2025-05-10",
  quantity: 2,
  price: 50,
  fees: 0,
  currency: "USD",
  unit: "per_share",
  broker: "North",
  note: null,
  entered_by: "web",
  entered_at: null,
  removed_at: null,
  removed_by: null,
  ...more,
});

const rows = (html: string, cls: string): number =>
  html.split(`class="${cls}"`).length - 1;

describe("the instrument page's position drawer", () => {
  const two = holding({
    parts: [
      part("Trading", null, { quantity: 5.4567, cost: 400, value: 272.84 }),
      part("Shares", "North", { quantity: 20, cost: 800, value: 1000 }),
    ],
  });

  test("the position is its value and all-time gain alone", () => {
    const html = render(
      <PositionsBody h={two} trades={[]} failed={false} hide={false} />,
    );
    expect(html).toContain("Your position");
    expect(html).toContain('1,273<span class="hero-ccy">USD</span>');
    expect(html).toContain("+254.57 USD");
    expect(html).toContain("all time");
    expect(html).not.toContain("today");
    expect(html).not.toContain("Quantity");
    expect(html).not.toContain("Average price");
  });

  test("each broker's holding, largest first, its gain as a percent", () => {
    const html = render(
      <PositionsBody h={two} trades={[]} failed={false} hide={false} />,
    );
    expect(html).toContain("Held at");
    // the broker names the row, the portfolio when there is none
    const north = html.indexOf(">North<");
    const trading = html.indexOf(">Trading<");
    expect(north).toBeGreaterThan(-1);
    expect(trading).toBeGreaterThan(north);
    expect(html).toContain("20 at 40.00");
    expect(html).toContain("1,000 USD");
    expect(html).toContain('<span class="num up">+25.00%</span>');
    expect(html).toContain('<span class="num down">−31.79%</span>');
    // no gain in money on a broker's row
    expect(html).not.toContain("+200");
    expect(gainOf(two.parts[1]!)).toEqual({ pl: 200, pct: 25 });
    expect(gainOf(part("A", null, { value: null }))).toEqual({
      pl: null,
      pct: null,
    });
    expect(gainOf(part("A", null, { cost: 0, value: 5 })).pct).toBeNull();
    // a bond purchase's coupons paid are in its gain
    expect(gainOf(part("A", null, { coupons_paid: 20 }))).toEqual({
      pl: 120,
      pct: 30,
    });
  });

  test("trades read as orders, newest first, with Activity's tags", () => {
    const trades = [
      trade(1, { date: "2023-03-01", quantity: 4, price: 25, fees: 1 }),
      // two fills of one order fold into one row
      trade(2, { date: "2023-06-02", quantity: 1, price: 60 }),
      trade(3, { date: "2023-06-02", quantity: 3, price: 60 }),
      trade(4, { date: "2023-07-15", side: "sell", quantity: 2, price: 70 }),
      trade(5, { date: "2023-08-03", quantity: 0.5, price: 0 }),
      trade(6, { date: "2023-09-04", removed_at: "2023-09-05T10:00:00Z" }),
    ];
    const html = render(
      <PositionsBody h={two} trades={trades} failed={false} hide={false} />,
    );
    expect(html).toContain('Trades <span class="faint">4</span>');
    const reward = html.indexOf('<span class="tag tag-side">Reward</span>');
    const sell = html.indexOf(
      '<span class="tag tag-side tag-down">Sell</span>',
    );
    const buys = html.indexOf('<span class="tag tag-side tag-up">Buy</span>');
    expect(reward).toBeGreaterThan(-1);
    expect(sell).toBeGreaterThan(reward);
    expect(buys).toBeGreaterThan(sell);
    expect(html).toContain("+0.5");
    expect(html).toContain("240.00 USD");
    expect(html).toContain("4 × 60.00");
    // a buy pays its fees, a sell's are taken from what it received
    expect(html).toContain("101.00 USD");
    expect(html).toContain("140.00 USD");
    expect(html).toContain("2 Jun 2023 · North");
    expect(html).not.toContain("4 Sept 2023");
  });

  test("twenty orders, then Show more", () => {
    const many = Array.from({ length: 25 }, (_, i) =>
      trade(i + 1, { date: `2025-01-${String(i + 1).padStart(2, "0")}` }),
    );
    const html = render(
      <PositionsBody h={two} trades={many} failed={false} hide={false} />,
    );
    expect(html).toContain('Trades <span class="faint">25</span>');
    // two broker rows and twenty orders
    expect(rows(html, "pos-row")).toBe(22);
    expect(html).toContain("Show more");
  });

  test("no Trades section without trades; a failed read says so", () => {
    for (const trades of [null, []]) {
      const html = render(
        <PositionsBody h={two} trades={trades} failed={false} hide={false} />,
      );
      expect(html).not.toContain("Trades");
      expect(html).toContain("Held at");
    }
    const removed = render(
      <PositionsBody
        h={two}
        trades={[trade(1, { removed_at: "2025-09-02T10:00:00Z" })]}
        failed={false}
        hide={false}
      />,
    );
    expect(removed).not.toContain("Trades");
    const failed = render(
      <PositionsBody h={two} trades={null} failed={true} hide={false} />,
    );
    expect(failed).toContain("The trades did not load.");
  });

  test("Hide amounts blurs the drawer's money, not its percents", () => {
    const html = render(
      <PositionsBody h={two} trades={[trade(1)]} failed={false} hide={true} />,
    );
    expect(html).toContain('class="pos amounts-hidden"');
    expect(html).toContain('<span class="num amount">1,000 USD</span>');
    expect(html).toContain('<span class="num up">+25.00%</span>');
  });
});

describe("the instrument page's performance", () => {
  const DAILY = {
    sma50: 48,
    sma200: 45,
    cross: 1,
    cross_edge: 0,
    rsi14: 55,
    macd_histogram: 0.2,
    macd_turn: 0,
    atr14: 1.1,
    volatility20: 1.5,
    high52w: 60,
    low52w: 40,
    drawdown: -16.67,
    from_low: 25,
    days_since_high: 30,
    volume_ratio: 1.2,
  };

  test("the four returns, then the 52-week range under its label", () => {
    const html = render(
      <InstrumentCards
        detail={detail({}, {}, { signals: { daily: DAILY } })}
        held={null}
      />,
    );
    expect(html).toContain('<h2 class="card-title">Performance');
    for (const label of ["1 week", "1 month", "3 months", "Year to date"])
      expect(html).toContain(`<dt>${label}</dt>`);
    expect(html).toContain("+1.50%");
    expect(html).toContain("−3.25%");
    // a return the server has none of
    expect(html).toContain(">—<");
    expect(html).toContain('<h3 class="card-label">52-week range</h3>');
    expect(html).toContain("range-bar");
    expect(html).toContain("16.67% below");
    // the range lives in Performance, never a card of its own
    expect(html).not.toContain('<h2 class="card-title">52-week range');
  });

  test("an average at or below zero has no distance, a yield's keeps its points", () => {
    const daily = { ...DAILY, sma50: -2, sma200: 0 };
    const labels = (d: Detail) =>
      signalsOf(d)
        .trend.filter((f) => f.label.endsWith("average"))
        .map((f) => [f.label, f.value]);
    expect(labels(detail({}, {}, { signals: { daily } }))).toEqual([]);
    expect(
      labels(detail({ unit: "percent" }, {}, { price: 1, signals: { daily } })),
    ).toEqual([
      ["50-day average", "3.00 pts above"],
      ["200-day average", "1.00 pts above"],
    ]);
  });

  test("returns alone, a range alone, or neither", () => {
    const returnsOnly = render(
      <InstrumentCards detail={detail()} held={null} />,
    );
    expect(returnsOnly).toContain("Performance");
    expect(returnsOnly).toContain("1 week");
    expect(returnsOnly).not.toContain("52-week range");
    const rangeOnly = render(
      <InstrumentCards
        detail={detail({}, {}, { returns: null, signals: { daily: DAILY } })}
        held={null}
      />,
    );
    expect(rangeOnly).toContain("Performance");
    expect(rangeOnly).not.toContain("1 week");
    expect(rangeOnly).toContain("52-week range");
    const neither = signalsOf(detail({}, {}, { returns: null }));
    expect([neither.returns, neither.range]).toEqual([null, null]);
    expect(
      render(
        <InstrumentCards
          detail={detail({}, {}, { returns: null })}
          held={null}
        />,
      ),
    ).not.toContain("Performance");
  });
});

describe("a fund's holdings", () => {
  test("Top holdings and Sectors, each holding with a symbol linking", () => {
    const html = render(
      <InstrumentCards detail={fund(holdings())} held={null} />,
    );
    expect(html).toContain('<h2 class="card-title">Top holdings');
    expect(html).toContain('<h2 class="card-title">Sectors');
    expect(html).toContain("Top 3: 35.0% of the fund · fetched 1 Nov");
    expect(html).not.toContain("not current");
    // by the stored id, else by symbol, in the ticker's style
    expect(html).toContain(
      '<a class="sym-ticker sym-link" href="/symbol/US%3AAAA" aria-label="Alpha Made Up">AAA</a>',
    );
    expect(html).toContain('href="/symbol/BBB"');
    // no symbol: its name, no link
    expect(html).toContain(
      '<dt title="Gamma Made Up Holdings">Gamma Made Up Holdings</dt>',
    );
    expect(html.match(/<a class="sym-ticker/g)?.length).toBe(2);
    expect(html).toContain("20.0%");
    for (const words of ["Technology", "Real estate", "Consumer cyclical"])
      expect(html).toContain(words);
    expect(html).not.toContain("Bond ratings");
  });

  test("the bars are grey and scaled to the largest", () => {
    expect(barWidth(20, 20)).toBe(100);
    expect(barWidth(5, 20)).toBe(25);
    expect(barWidth(0.02, 40)).toBe(1);
    expect(barWidth(0, 0)).toBe(0);
    const html = render(
      <InstrumentCards detail={fund(holdings())} held={null} />,
    );
    expect(html).toContain('style="width:100%;"');
    expect(html).toContain('style="width:50%;"');
    expect(html).not.toMatch(/weights[^"]*\b(up|down)\b/);
  });

  test("a bond fund lists its ratings, US government bonds under them", () => {
    const t = holdings({
      sectors: [],
      bond_ratings: [
        { rating: "us_government", weight_percent: 40 },
        { rating: "aaa", weight_percent: 30 },
        { rating: "below_b", weight_percent: 2 },
      ],
      government_bonds_percent: 41.25,
    });
    const html = render(<InstrumentCards detail={fund(t)} held={null} />);
    expect(html).toContain('<h2 class="card-title">Bond ratings');
    expect(html).not.toContain("Sectors");
    for (const words of ["US government", "AAA", "Below B"])
      expect(html).toContain(words);
    expect(html).toContain("US government bonds: 41.3%");
    expect(ratingName("bbb")).toBe("BBB");
    expect(sectorName("something_new")).toBe("Something new");
  });

  test("stale holdings say so; a fund with none says it in one line", () => {
    const stale = fundOf(
      listed("US:CASY", { kind: "ETF" }),
      holdings({ stale: ["the sync is pending"] }),
      NOW,
    );
    expect(stale?.line).toBe(
      "Top 3: 35.0% of the fund · fetched 1 Nov · not current",
    );
    const none = render(
      <InstrumentCards
        detail={fund(
          { source: "made-up", message: "None for this fund." },
          "MUTUALFUND",
        )}
        held={null}
      />,
    );
    expect(none).toContain("Top holdings");
    expect(none).toContain("No top holdings listed for this fund.");
    expect(none).not.toContain("weights");
    expect(none).not.toContain("Sectors");
    expect(
      fundOf(listed("US:CASY", { kind: "ETF" }), {
        source: "made-up",
        error: "timeout",
        message: "No answer.",
      })?.line,
    ).toBe("Could not get its top holdings.");
  });

  test("a share's page has neither card", () => {
    const html = render(<InstrumentCards detail={detail()} held={null} />);
    expect(html).not.toContain("Top holdings");
    expect(html).not.toContain("Sectors");
    // a stray answer on a share is no fund's
    expect(fundOf(listed("US:CASY"), holdings())).toBeNull();
    expect(fundOf(listed("US:CASY", { kind: "ETF" }), undefined)).toBeNull();
  });
});

describe("an instrument's page by role", () => {
  test("Refetch and Delete are an admin's; anyone adds to their Home", () => {
    markets.detailId.value = "US:CASY";
    markets.detail.value = detail();
    const menu = () => {
      const nodes: any[] = [];
      const before = options.vnode;
      options.vnode = (v) => {
        nodes.push(v);
        before?.(v);
      };
      try {
        render(<Instrument params={{ id: "US:CASY" }} />);
      } finally {
        options.vnode = before;
      }
      return nodes.find((n) => n.type === InstrumentMenu)!.props;
    };
    try {
      markets.me.value = {
        id: "operator",
        name: "Casey",
        role: "admin",
        email: null,
        operator: true,
      };
      expect(menu().admin).toBe(true);
      markets.me.value = { ...markets.me.value, id: "ana", role: "member" };
      const member = menu();
      expect(member.admin).toBe(false);
      expect(member.home).toBeDefined();
      markets.layout.value = [{ name: "A", view: "cards", ids: ["US:CASY"] }];
      expect(menu().home.at).toBe(0);
      // no add or remove while World markets still fill Home in
      markets.seeding.value = [{ value: "AAPL", state: "pending" }];
      expect(menu().home).toMatchObject({ sections: null, at: -1 });
    } finally {
      markets.layout.value = null;
      markets.seeding.value = null;
      markets.me.value = null;
      markets.detail.value = null;
      markets.detailId.value = null;
    }
  });
});

describe("an instrument's ISIN", () => {
  // made up, its check digit right
  const LISTED = "ZZLIST000016";
  // the open menu's items, as a click on More draws them
  const items = (props: Parameters<typeof InstrumentMenu>[0]) => {
    const nodes: any[] = [];
    const before = options.vnode;
    options.vnode = (v) => {
      nodes.push(v);
      before?.(v);
    };
    try {
      render(<InstrumentMenu {...props} />);
    } finally {
      options.vnode = before;
    }
    const button = nodes.find((n) => n.type === MenuButton)!;
    return render(<>{button.props.children(() => {})}</>);
  };
  const base = {
    symbol: "VUAA",
    busy: false,
    done: false,
    removing: false,
    onRefetch: () => {},
    onDelete: () => {},
    onIsin: async () => null,
  };

  test("Set ISIN is in the menu for an admin only", () => {
    expect(items({ ...base, admin: true })).toContain("Set ISIN");
    expect(items({ ...base, admin: false })).not.toContain("Set ISIN");
  });

  test("the field takes an ISIN in any case, empty to take it off", () => {
    expect(isinInput(` ${LISTED.toLowerCase()} `)).toBe(LISTED);
    expect(isinInput("  ")).toBeNull();
    expect(isinInput(`${LISTED.slice(0, -1)}7`)).toBeUndefined();
    expect(isinInput("VUAA")).toBeUndefined();
  });

  test("the page shows it once set, and hands the menu the write", () => {
    markets.detailId.value = "XETRA:VUAA";
    markets.detail.value = detail({ id: "XETRA:VUAA" }, { isin: LISTED });
    markets.me.value = {
      id: "operator",
      name: "Casey",
      role: "admin",
      email: null,
      operator: true,
    };
    const nodes: any[] = [];
    const before = options.vnode;
    options.vnode = (v) => {
      nodes.push(v);
      before?.(v);
    };
    try {
      const html = render(<Instrument params={{ id: "XETRA:VUAA" }} />);
      expect(html).toContain(LISTED);
      const menu = nodes.find((n) => n.type === InstrumentMenu)!.props;
      expect(menu.isin).toBe(LISTED);
      expect(typeof menu.onIsin).toBe("function");
    } finally {
      options.vnode = before;
      markets.me.value = null;
      markets.detail.value = null;
      markets.detailId.value = null;
    }
  });

  test("Tradegate's price shows beside the close only while Xetra is closed", () => {
    const at = (session: string) =>
      afterHours(
        detail(
          {},
          {},
          {
            extended: {
              session: session as never,
              price: 51,
              change: 1,
              change_percent: 2,
              time: "2026-11-01T19:00:00Z",
            },
          },
        ),
      )?.word ?? null;
    expect(at("pre")).toBe("Pre-market");
    expect(at("post")).toBe("After hours");
    expect(at("closed")).toBe("After hours");
    expect(at("regular")).toBeNull();
  });
});

describe("an instrument's page by symbol", () => {
  test("each symbol's page is its own, so nothing carries to the next", () => {
    const was = path.value;
    const keyAt = (at: string) => {
      path.value = at;
      const nodes: any[] = [];
      const before = options.vnode;
      options.vnode = (v) => {
        nodes.push(v);
        before?.(v);
      };
      try {
        render(<App />);
      } finally {
        options.vnode = before;
      }
      return nodes.find((n) => n.type === Instrument)?.key;
    };
    markets.signedIn.value = true;
    try {
      const one = keyAt("/symbol/US%3AAAA");
      const two = keyAt("/symbol/US%3ABBB");
      expect(one).toBeDefined();
      expect(two).toBeDefined();
      expect(one).not.toBe(two);
    } finally {
      path.value = was;
      markets.signedIn.value = undefined;
    }
  });

  test("a delete answered after the reader moved on leaves them where they are", async () => {
    const was = {
      path: path.value,
      fetch: globalThis.fetch,
      location: globalThis.location,
      history: globalThis.history,
    };
    const answered = Promise.withResolvers<void>();
    const asked: string[] = [];
    globalThis.fetch = (async (input: string, init?: RequestInit) => {
      asked.push(`${init?.method ?? "GET"} ${input}`);
      await answered.promise;
      return new Response(null, { status: 204 });
    }) as typeof fetch;
    globalThis.location = {
      origin: "http://markets.test",
      get pathname() {
        return path.value;
      },
      search: "",
    } as Location;
    globalThis.history = {
      state: null,
      pushState() {},
      replaceState() {},
    } as unknown as History;
    path.value = "/symbol/US%3ACASY";
    markets.detailId.value = "US:CASY";
    markets.detail.value = detail();
    markets.me.value = {
      id: "operator",
      name: "Casey",
      role: "admin",
      email: null,
      operator: true,
    };
    try {
      const nodes: any[] = [];
      const before = options.vnode;
      options.vnode = (v) => {
        nodes.push(v);
        before?.(v);
      };
      try {
        render(<Instrument params={{ id: "US:CASY" }} />);
      } finally {
        options.vnode = before;
      }
      nodes.find((n) => n.type === InstrumentMenu)!.props.onDelete();
      expect(asked).toEqual(["DELETE /api/v1/instruments/US%3ACASY"]);
      path.value = "/symbol/US%3AMSFT";
      answered.resolve();
      await new Promise((r) => setTimeout(r, 0));
      expect(path.value).toBe("/symbol/US%3AMSFT");
    } finally {
      globalThis.fetch = was.fetch;
      globalThis.location = was.location;
      globalThis.history = was.history;
      path.value = was.path;
      markets.me.value = null;
      markets.detail.value = null;
      markets.detailId.value = null;
    }
  });

  test("a late answer acts only while its symbol's page is open", () => {
    expect(onSymbolPage("/symbol/US%3AAAA", "US:AAA")).toBe(true);
    expect(onSymbolPage("/symbol/US:AAA", "US:AAA")).toBe(true);
    expect(onSymbolPage("/symbol/US%3ABBB", "US:AAA")).toBe(false);
    expect(onSymbolPage("/screener", "US:AAA")).toBe(false);
    expect(onSymbolPage("/symbol/%E0%A4%A", "US:AAA")).toBe(false);
  });
});

describe("a fund the owner prices, on its page", () => {
  const FUND_ID = "fund:ZZFUND000011";
  const hand = (more: Partial<Detail> = {}) =>
    detail(
      {
        id: FUND_ID,
        kind: "FUND",
        name: "Made Up World Fund",
        market: "",
        tracked: false,
      },
      { intraday: false, ...more },
      {
        id: FUND_ID,
        kind: "hand_price",
        as_of: "2026-10-24",
        price: 6,
        change: null,
        change_percent: null,
        fetched_at: null,
        returns: null,
        session: null,
      },
    );

  test("its head names the day its price is for, never a stop", () => {
    expect(priceState(hand(), NOW)).toBe("Price for 24 Oct");
    // never fetched, so never "no longer updated"
    expect(stopped(hand().instrument)).toBeNull();
    expect(stopped(listed("US:OLD", { tracked: false }))).toBe(
      "No longer updated",
    );
  });

  test("its holdings show as an ETF's, each part as of its own day", () => {
    const t = holdings({
      fetched_at: "2026-11-04T10:00:00Z",
      as_of: "2026-09-30",
      sectors_as_of: "2026-06-30",
    });
    const f = fundOf(hand().instrument, t, NOW);
    expect(f?.line).toMatch(/^Top 3: 35\.0% of the fund · as of 30 Sept?$/);
    expect(f?.split?.title).toBe("Sectors");
    expect(f?.split?.note).toBe("As of 30 Jun");
    // sectors of the same day say nothing more
    expect(
      fundOf(
        hand().instrument,
        holdings({ as_of: "2026-09-30", sectors_as_of: "2026-09-30" }),
        NOW,
      )?.split?.note,
    ).toBeNull();
    // sectors entered before any rows still show
    const only = fundOf(
      hand().instrument,
      holdings({ top: [], top_weight_percent: null }),
      NOW,
    );
    expect(only?.split?.rows.length).toBe(3);
    expect(only?.top).toEqual([]);
  });

  test("its head has the + and a menu that only sets its price", () => {
    markets.detailId.value = FUND_ID;
    markets.detail.value = hand();
    markets.me.value = {
      id: "operator",
      name: "Casey",
      role: "admin",
      email: null,
      operator: true,
    };
    try {
      const page = render(<Instrument params={{ id: FUND_ID }} />);
      expect(page).toContain('aria-label="Buy or sell"');
      expect(page).toContain('Fund<span class="faint"> · Price for 24 Oct');
      // a line a month apart: a year to open on, no day ranges, no averages
      expect(page).not.toMatch(/>1D<|>5D</);
      expect(page).toMatch(/seg-on" aria-pressed="true">1Y</);
      expect(page).not.toContain('aria-label="Averages"');
      expect(page).not.toContain(">Candles<");
      // not held: nothing to sell or price, and an admin's fetch menu is moot
      expect(page).not.toContain('aria-label="More"');
    } finally {
      markets.me.value = null;
      markets.detail.value = null;
      markets.detailId.value = null;
    }
  });

  test("only what a trade buys has the +", () => {
    for (const kind of ["EQUITY", "ETF", "MUTUALFUND", "CRYPTOCURRENCY"])
      expect(buyable(listed("US:CASY", { kind }))).toBe(true);
    expect(buyable(listed(FUND_ID, { kind: "FUND" }))).toBe(true);
    for (const kind of ["INDEX", "FUTURE", "CURRENCY", "SERIES", "BOND"])
      expect(buyable(listed("US:CASY", { kind }))).toBe(false);
  });

  test("its trades mark the bar of their day, or the last bar before it", () => {
    const times = ["2026-08-31", "2026-09-30", "2026-10-24"];
    expect(
      tradeMarks(times, [
        { date: "2026-09-30", side: "buy", quantity: 2, price: 10 },
        // between bars: on the one before
        { date: "2026-10-12", side: "buy", quantity: 1, price: 40 },
        { date: "2026-10-14", side: "sell", quantity: 3, price: 30 },
        // two buys on one bar are one mark at their price by quantity
        { date: "2026-10-01", side: "buy", quantity: 1, price: 10 },
        // before the range: none
        { date: "2026-01-02", side: "buy", quantity: 5, price: 1 },
      ]),
    ).toEqual([
      { time: "2026-09-30", side: "buy", price: 17.5, quantity: 4 },
      { time: "2026-09-30", side: "sell", price: 30, quantity: 3 },
    ]);
    expect(
      tradeMarks(
        [],
        [{ date: "2026-10-01", side: "buy", quantity: 1, price: 1 }],
      ),
    ).toEqual([]);
  });

  test("a month's mark reads at its average price, a day's at its price", () => {
    const mark = { time: "2026-09-15", quantity: 4, price: 17.5 };
    expect(tradeText({ ...mark, side: "buy", month: true })).toBe(
      "Bought 4 · avg 17.50",
    );
    expect(tradeText({ ...mark, side: "sell", month: true })).toBe(
      "Sold 4 · avg 17.50",
    );
    expect(tradeText({ ...mark, side: "buy", month: false })).toBe(
      "Bought 4 at 17.50",
    );
  });

  test("a year or more sums each month's trades on its latest trade's bar", () => {
    const times = ["2026-08-31", "2026-09-01", "2026-09-15", "2026-10-01"];
    expect(
      monthlyShares(times, [
        { date: "2026-09-02", side: "buy", quantity: 1, price: 10 },
        { date: "2026-09-16", side: "buy", quantity: 3, price: 20 },
        { date: "2026-09-20", side: "sell", quantity: 2, price: 30 },
        { date: "2026-10-02", side: "buy", quantity: 5, price: 40 },
        // before the range: none
        { date: "2026-08-03", side: "buy", quantity: 9, price: 1 },
      ]),
    ).toEqual([
      { time: "2026-09-15", side: "buy", price: 17.5, quantity: 4 },
      { time: "2026-09-15", side: "sell", price: 30, quantity: 2 },
      { time: "2026-10-01", side: "buy", price: 40, quantity: 5 },
    ]);
  });

  test("a month's buys and sells each sit on their own latest bar", () => {
    const times = ["2026-09-01", "2026-09-15", "2026-09-29"];
    expect(
      monthlyShares(times, [
        { date: "2026-09-02", side: "buy", quantity: 1, price: 10 },
        { date: "2026-09-30", side: "sell", quantity: 1, price: 13 },
      ]),
    ).toEqual([
      { time: "2026-09-01", side: "buy", price: 10, quantity: 1 },
      { time: "2026-09-29", side: "sell", price: 13, quantity: 1 },
    ]);
  });

  test("a month's trades sit on the week of its latest trade", () => {
    // a buy on Monday 21 September lands on its own week, not on the 7th
    const weeks = ["2026-08-31", "2026-09-07", "2026-09-14", "2026-09-21"];
    expect(
      monthlyShares(weeks, [
        { date: "2026-09-09", side: "buy", quantity: 1, price: 50 },
        { date: "2026-09-21", side: "buy", quantity: 1, price: 40 },
      ]),
    ).toEqual([{ time: "2026-09-21", side: "buy", price: 45, quantity: 2 }]);
  });

  test("a month on weekly bars counts a trade by its own date", () => {
    // a Friday 3 April buy sits in the week of Monday 30 March
    const weeks = ["2026-03-23", "2026-03-30", "2026-04-06"];
    const buy = {
      date: "2026-04-03",
      side: "buy",
      quantity: 1,
      price: 10,
    } as const;
    expect(monthlyShares(weeks, [buy])).toEqual([
      { time: "2026-04-06", side: "buy", price: 10, quantity: 1 },
    ]);
    // a month with no bar of its own falls on the bar before
    expect(monthlyShares(["2026-03-30"], [buy])).toEqual([
      { time: "2026-03-30", side: "buy", price: 10, quantity: 1 },
    ]);
  });
});
