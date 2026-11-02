// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { render } from "preact-render-to-string";
import type { Holding, TradeRow } from "../src/web/data/portfolios.ts";
import type { Detail, Listed, TopHoldings } from "../src/web/data/store.ts";
import { briefQuantity } from "../src/web/lib/format.ts";
import { barWidth } from "../src/web/ui/Weights.tsx";
import { signalsOf } from "../src/web/views/InstrumentCards.model.ts";
import { InstrumentCards } from "../src/web/views/InstrumentCards.tsx";
import {
  fundOf,
  ratingName,
  sectorName,
} from "../src/web/views/InstrumentFund.model.ts";
import {
  heldOf,
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
      '<a class="sym-ticker sym-link" href="/instruments/US%3AAAA" aria-label="Alpha Made Up">AAA</a>',
    );
    expect(html).toContain('href="/instruments/BBB"');
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
