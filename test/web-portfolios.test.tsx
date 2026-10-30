// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// The Portfolios page from fixed, made-up answers: no DOM, no network.

import { describe, expect, test } from "bun:test";
import { render } from "preact-render-to-string";
import type { Fetch } from "../src/web/data/api.ts";
import type {
  Holding,
  Holdings,
  Overview,
  TradeRow,
} from "../src/web/data/portfolios.ts";
import { store } from "../src/web/data/store.ts";
import { accessWords } from "../src/web/views/Connect.model.ts";
import {
  amount,
  change,
  costLine,
  currencies,
  currencyGain,
  dryPowderFor,
  dryPowders,
  heldAt,
  holdingSub,
  importLine,
  largestFirst,
  listingWords,
  ranked,
  rateLine,
  readRemembered,
  shareLabel,
  shownIn,
  splitOf,
  tradeLine,
  tradeMoney,
  tradeSub,
  typed,
} from "../src/web/views/Portfolios.model.ts";
import {
  AddForm,
  FoundList,
  ImportPanel,
  PortfoliosBody,
  PositionEdit,
  Purchases,
  SettingsPanel,
} from "../src/web/views/Portfolios.tsx";

const NOW = Date.parse("2026-10-28T12:00:00Z");

const OVERVIEW: Overview = {
  display_currency: "USD",
  portfolios: [
    { id: 1, name: "Shares", trades: 2, positions: 1 },
    { id: 2, name: "Coins", trades: 0, positions: 0 },
  ],
  brokers: [
    { id: 1, name: "North" },
    { id: 2, name: "South" },
  ],
};

const total = (currency: string, more: object = {}) => ({
  currency,
  value: 1000,
  cost: 800,
  pl: 200,
  pl_percent: 25,
  day_change: 5,
  invested: 700,
  cash: 0,
  dry_powder: 300,
  invested_weight: 70,
  cash_weight: 0,
  dry_powder_weight: 30,
  ...more,
});

const HOLDINGS: Holdings = {
  currency: null,
  display_currency: null,
  totals: [
    total("EUR"),
    total("USD", {
      dry_powder: 0,
      dry_powder_weight: 0,
      invested: 1000,
      invested_weight: 100,
    }),
  ],
  converted: null,
  rates: [],
  exposure: [
    {
      currency: "EUR",
      currency_weights: null,
      market: [
        { key: "XETRA", value: 700, weight: 70 },
        { key: null, value: 300, weight: 30 },
      ],
      type: [
        { key: "ETF", value: 700, weight: 70 },
        { key: "CASH", value: 300, weight: 30 },
      ],
      portfolio: [{ key: "Shares", value: 1000, weight: 100 }],
      broker: [{ key: "North", value: 1000, weight: 100 }],
    },
  ],
  holdings: [
    {
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
      weight: 70,
      stale: [],
      parts: [
        {
          portfolio: "Shares",
          broker: "North",
          quantity: 4,
          average_cost: 80,
          cost: 320,
          value: 400,
        },
        {
          portfolio: "Shares",
          broker: "South",
          quantity: 3,
          average_cost: 80,
          cost: 240,
          value: 300,
        },
      ],
    },
    {
      kind: "cash",
      id: null,
      position: 5,
      name: "Kept for buying",
      type: "CASH",
      market: null,
      currency: "EUR",
      quantity: null,
      average_cost: null,
      cost: null,
      price: null,
      priced: "amount",
      as_of: "2026-10-01",
      value: 300,
      pl: null,
      pl_percent: null,
      day_change: null,
      change_percent: null,
      weight: 30,
      dry_powder: true,
      stale: [],
      parts: [],
    },
  ],
};

const trade = (more: Partial<TradeRow> = {}): TradeRow => ({
  id: 1,
  portfolio: "Shares",
  symbol: "XETRA:AAA",
  name: "Alpha Made Up",
  side: "buy",
  date: "2026-03-02",
  quantity: 4,
  price: 80,
  fees: 1.5,
  currency: "EUR",
  broker: "North",
  note: null,
  entered_by: "casey-agent",
  entered_at: "2026-03-02T10:00:00Z",
  removed_at: null,
  removed_by: null,
  ...more,
});

function fake(answers: Record<string, unknown>): {
  fetch: Fetch;
  asked: string[];
} {
  const asked: string[] = [];
  return {
    asked,
    fetch: async (path, init) => {
      const key = `${init?.method ?? "GET"} ${path}`;
      asked.push(key);
      const hit = Object.entries(answers).find(([k]) => key.startsWith(k));
      if (hit === undefined) throw new Error(`no answer for ${key}`);
      return Response.json(hit[1]);
    },
  };
}

async function loaded(
  holdings: Holdings = HOLDINGS,
  trades: TradeRow[] = [trade()],
) {
  const f = fake({
    "GET /api/v1/portfolios": OVERVIEW,
    "GET /api/v1/holdings": holdings,
    "GET /api/v1/trades": { trades },
  });
  const s = store(
    f.fetch,
    () => NOW,
    () => "/portfolios",
    () => {},
  );
  await s.portfolios.load();
  return { s, asked: f.asked };
}

describe("the Portfolios page", () => {
  test("with nothing converted, a total per currency, never summed", async () => {
    const { s } = await loaded();
    const html = render(<PortfoliosBody store={s.portfolios} />);
    expect(html).toContain("1,000.00 EUR");
    expect(html).toContain("1,000.00 USD");
    expect(html).not.toContain("2,000.00");
    expect(html).toContain("Dry powder");
    expect(html).toContain("Holdings");
    expect(html).toContain("Exposure");
    expect(html).toContain("Trades");
    // the instrument's symbol, never its id
    expect(html).toContain(">AAA<");
    expect(html).not.toContain("XETRA:AAA");
  });

  test("asks the holdings of the portfolio, broker and currency picked", async () => {
    const { s, asked } = await loaded();
    const f = fake({
      "GET /api/v1/portfolios": OVERVIEW,
      "GET /api/v1/portfolios/1/holdings": HOLDINGS,
      "GET /api/v1/trades": { trades: [] },
    });
    const t = store(
      f.fetch,
      () => NOW,
      () => "/portfolios",
      () => {},
    );
    await t.portfolios.pick({ portfolio: 1, broker: "North", currency: "USD" });
    expect(asked).toContain("GET /api/v1/holdings");
    expect(f.asked).toContain(
      "GET /api/v1/portfolios/1/holdings?broker=North&currency=USD",
    );
    expect(f.asked).toContain(
      "GET /api/v1/trades?removed=true&portfolio=1&broker=North",
    );
    void s;
  });

  test("with a converted total, it is the one total shown, with its rate", async () => {
    const { s } = await loaded({
      ...HOLDINGS,
      currency: "USD",
      converted: { ...total("USD", { value: 2250 }), missing: [] },
      rates: [
        { from: "EUR", to: "USD", rate: 1.25, at: "2026-10-28T11:55:00Z" },
        { from: "USD", to: "USD", rate: 1, at: null },
      ],
    });
    const html = render(<PortfoliosBody store={s.portfolios} />);
    expect(html).toContain('<span class="label">Total</span>');
    expect(html).toContain("2,250.00 USD");
    expect(html).toContain("1 EUR = 1.25 USD");
    expect(html).not.toContain('aria-label="Total in EUR"');
    expect(currencyGain(HOLDINGS.totals, "EUR").text).toBe("+25.00%");
    expect(currencyGain(HOLDINGS.totals, "JPY").text).toBe("");
  });

  test("with no portfolio yet it asks for one, the display currency kept", async () => {
    const f = fake({
      "GET /api/v1/portfolios": { ...OVERVIEW, portfolios: [] },
      "GET /api/v1/holdings": {
        ...HOLDINGS,
        totals: [],
        holdings: [],
        exposure: [],
      },
      "GET /api/v1/trades": { trades: [] },
    });
    const s = store(
      f.fetch,
      () => NOW,
      () => "/portfolios",
      () => {},
    );
    await s.portfolios.load();
    const html = render(<PortfoliosBody store={s.portfolios} />);
    expect(html).toContain("Create your first portfolio");
    // the most traded currencies are one tap each, the one set pressed
    expect(html).toMatch(/aria-pressed="true"[^>]*>USD</);
    expect(html).toContain("Other…");
    expect(html).not.toContain("Holdings");
    expect(html).not.toContain('aria-label="Add"');
    expect(html).not.toContain('aria-label="More"');
  });

  test("a portfolio with nothing in it offers each way to add holdings, under its name", async () => {
    const f = fake({
      "GET /api/v1/portfolios": {
        ...OVERVIEW,
        portfolios: [OVERVIEW.portfolios[0]!],
      },
      "GET /api/v1/holdings": {
        ...HOLDINGS,
        totals: [],
        holdings: [],
        exposure: [],
      },
      "GET /api/v1/trades": { trades: [] },
    });
    const s = store(
      f.fetch,
      () => NOW,
      () => "/portfolios",
      () => {},
    );
    await s.portfolios.load();
    const html = render(<PortfoliosBody store={s.portfolios} />);
    expect(html).toContain("Shares · totals in USD");
    expect(html).toContain("Add your holdings");
    for (const way of [
      "Add a trade",
      "Add cash, a fund or a bond",
      "Import a CSV",
      "Let an agent do it",
    ]) {
      expect(html).toContain(way);
    }
    expect(html).toContain('href="/connect"');
    expect(html).not.toContain('aria-label="Add"');
    expect(html).toContain('aria-label="More"');
  });

  test("with no display currency it asks for one before anything else", async () => {
    const f = fake({
      "GET /api/v1/portfolios": { ...OVERVIEW, display_currency: null },
      "GET /api/v1/holdings": HOLDINGS,
      "GET /api/v1/trades": { trades: [] },
    });
    const s = store(
      f.fetch,
      () => NOW,
      () => "/portfolios",
      () => {},
    );
    await s.portfolios.load();
    const html = render(<PortfoliosBody store={s.portfolios} />);
    // portfolios exist, so only the currency is asked
    expect(html).toContain("Pick a currency for totals");
    expect(html).not.toContain('placeholder="Long term"');
    expect(html).not.toContain('aria-pressed="true"');
    expect(html).not.toContain("Holdings");
    expect(html).not.toContain('aria-label="Add"');
  });

  test("every pick is the app's own menu, never a native select", async () => {
    const { s } = await loaded({
      ...HOLDINGS,
      exposure: [
        HOLDINGS.exposure[0]!,
        { ...HOLDINGS.exposure[0]!, currency: "USD" },
      ],
    });
    const page = render(<PortfoliosBody store={s.portfolios} />);
    expect(page).toContain('aria-label="Currency: EUR"');
    for (const html of [
      page,
      render(<AddForm store={s.portfolios} onDone={() => {}} />),
      render(<ImportPanel store={s.portfolios} onDone={() => {}} />),
      render(<SettingsPanel store={s.portfolios} onDone={() => {}} />),
    ]) {
      expect(html).not.toContain("<select");
    }
  });

  test("the add form leads with a trade's fields and asks for a portfolio", async () => {
    const { s } = await loaded();
    const html = render(<AddForm store={s.portfolios} onDone={() => {}} />);
    for (const word of [
      "Symbol",
      "Buy",
      "Sell",
      "Quantity",
      "Price",
      "Use total",
      "Date",
      "Fees",
      "Portfolio",
      "Pick a portfolio",
      "Broker",
      "Note",
      "Fund",
    ]) {
      expect([word, html.includes(word)]).toEqual([word, true]);
    }
    expect(html).toMatch(/<button[^>]*disabled[^>]*>Sell</);
    expect(
      render(<ImportPanel store={s.portfolios} onDone={() => {}} />),
    ).toContain("Choose CSV");
    expect(
      render(<SettingsPanel store={s.portfolios} onDone={() => {}} />),
    ).toContain("Brokers");
  });

  test("a sign-out clears what the page held", async () => {
    const { s } = await loaded();
    s.portfolios.clear();
    expect(s.portfolios.holdings.value).toBeNull();
    expect(s.portfolios.overview.value).toBeNull();
  });
});

describe("plain words on the page", () => {
  test("a row's stale reason and a total's missing listing read plainly", async () => {
    const odd = {
      ...HOLDINGS,
      currency: "USD",
      converted: { ...total("USD"), missing: ["US:NOQ", "no EUR to JPY rate"] },
      holdings: [
        { ...HOLDINGS.holdings[0]!, stale: ["sells more than bought"] },
        HOLDINGS.holdings[1]!,
      ],
    };
    const { s } = await loaded(odd);
    const html = render(<PortfoliosBody store={s.portfolios} />);
    expect(html).toContain("Sold more than bought");
    expect(html).toContain("NOQ");
    expect(html).toContain("No EUR to JPY rate");
    expect(html).not.toContain("US:NOQ");
  });
});

describe("the page's words", () => {
  test("say amounts, gains and dates plainly", () => {
    expect(amount(1234.5, "EUR")).toBe("1,234.50 EUR");
    expect(amount(-3, "USD")).toBe("−3.00 USD");
    expect(amount(3704, "JPY")).toBe("3,704 JPY");
    expect(amount(8.642, "KWD")).toBe("8.642 KWD");
    expect(amount(1234.5, "EUR", true)).toBe("1,234.50");
    expect(change(-0.001).dir).toBe(0);
    expect(change(12.3, "EUR").text).toBe("+12.30 EUR");
    expect(typed("1,5")).toBe(1.5);
    expect(typed("1,234.5")).toBe(1234.5);
    expect(typed("")).toBeNull();
    expect(Number.isNaN(typed("abc")!)).toBe(true);
    expect(holdingSub(HOLDINGS.holdings[1]!, NOW)).toBe("Dry powder · 1 Oct");
    expect(
      holdingSub({ ...HOLDINGS.holdings[1]!, dry_powder: false }, NOW),
    ).toBe("Reserve · 1 Oct");
    expect(tradeLine(trade())).toBe("4 × 80.00 EUR + 1.50 fees");
    expect(tradeSub(trade(), NOW)).toBe(
      "2 Mar · Shares · North · by casey-agent",
    );
    expect(tradeSub(trade({ entered_by: "web" }), NOW)).toContain("by Web");
    expect(splitOf(total("EUR")).map((p) => p.label)).toEqual([
      "Invested",
      "Dry powder",
    ]);
    expect(
      splitOf(total("EUR", { cash: 100, cash_weight: 10 })).map((p) => p.label),
    ).toEqual(["Invested", "Reserve", "Dry powder"]);
    expect(currencies(HOLDINGS)).toEqual(["EUR", "USD"]);
    expect(rateLine({ from: "EUR", to: "JPY", rate: null, at: null })).toBe(
      "No EUR to JPY rate",
    );
    expect(shareLabel("market", null)).toBe("Not listed");
    expect(shareLabel("type", "CASH")).toBe("Cash");
    expect(
      importLine({
        side: "buy",
        symbol: "US:AAA",
        quantity: 2,
        price: 10,
        currency: "USD",
        date: `${new Date().getFullYear()}-01-05`,
      }),
    ).toBe("Buy AAA · 2 × 10.00 USD · 5 Jan");
    expect(
      accessWords({
        id: "a",
        name: "a",
        created_at: "",
        last_used_at: null,
        expires_at: null,
        portfolio: "write",
      }),
    ).toBe("Writes portfolios");
  });

  test("only the kind is remembered, and a broken value forgets it", () => {
    expect(
      readRemembered(
        '{"kind":"cash","side":"sell","portfolio":2,"broker":"North"}',
      ),
    ).toEqual({ kind: "cash" });
    expect(readRemembered("{oops")).toEqual({ kind: "trade" });
    expect(readRemembered('{"kind":"manual"}')).toEqual({ kind: "fund" });
  });

  test("a bond bought twice lists each purchase with its own edit and remove", async () => {
    const { s: st } = await loaded();
    const part = (position: number, as_of: string, face: number) => ({
      portfolio: "Shares",
      broker: "North",
      quantity: null,
      average_cost: null,
      cost: null,
      value: face,
      position,
      as_of,
      amount: face,
    });
    const bond = {
      ...HOLDINGS.holdings[1]!,
      kind: "bond" as const,
      id: "BVB:GOVA",
      position: null,
      name: "Gov bond",
      type: "BOND",
      currency: "RON",
      parts: [part(7, "2026-01-05", 1000), part(8, "2026-02-02", 2000)],
    };
    const html = render(<Purchases store={st.portfolios} h={bond} />);
    expect(html).toContain("Face 1,000.00 RON");
    expect(html).toContain("Face 2,000.00 RON");
    expect(html.match(/> Edit</g)).toHaveLength(2);
    expect(html.match(/> Remove</g)).toHaveLength(2);
  });

  test("a cash edit starts from the stored amount, not the shown value", async () => {
    const { s: st } = await loaded();
    const cash = {
      ...HOLDINGS.holdings[1]!,
      currency: "JPY",
      value: 123,
      parts: [
        {
          portfolio: "Shares",
          broker: null,
          quantity: null,
          average_cost: null,
          cost: null,
          value: 123,
          position: 5,
          as_of: "2026-01-13",
          amount: 123.4,
        },
      ],
    };
    const html = render(
      <PositionEdit store={st.portfolios} h={cash} onDone={() => {}} />,
    );
    expect(html).toContain('value="123.4"');
  });

  test("a bond's price reads as a percent of face", () => {
    expect(
      tradeLine(
        trade({
          quantity: 1000,
          price: 100,
          fees: 0,
          currency: "RON",
          unit: "percent_of_par",
        }),
      ),
    ).toBe("1,000 × 100.00%");
    expect(
      costLine({
        ...HOLDINGS.holdings[0]!,
        quantity: 1000,
        average_cost: 98.25,
        unit: "percent_of_par",
      }),
    ).toBe("1,000 × 98.25%");
  });

  test("search results say where each listing trades", () => {
    const found = [
      {
        id: "XETRA:MADE",
        name: "Made Up World Fund",
        type: "ETF",
        exchange: "GER",
        exchange_name: "XETRA",
        stored: false,
      },
      {
        id: "MIL:MADE",
        name: "Made Up World Fund",
        type: "ETF",
        exchange: "MIL",
        exchange_name: "Milan",
        stored: false,
      },
      {
        id: "AMS:MADE",
        name: "Made Up World Fund",
        type: "ETF",
        exchange: "AMS",
        currency: "EUR",
        stored: true,
      },
    ];
    const html = render(<FoundList found={found} onPick={() => {}} />);
    expect(html).toContain(">XETRA<");
    expect(html).toContain(">Milan<");
    expect(html).toContain(">AMS · EUR<");
    expect(listingWords({ id: "MIL:MADE", exchange_name: "Milan" })).toBe(
      "Milan",
    );
  });
});

describe("the add panel", () => {
  test("plain listings come before futures, each keeping the source's order", () => {
    const c = (id: string, type: string) => ({
      id,
      name: null,
      type,
      exchange: "",
      stored: false,
    });
    expect(
      ranked([
        c("CME:AAA=F", "FUTURE"),
        c("US:AAA", "EQUITY"),
        c("US:BBB", "ETF"),
        c("X:AAA", "OPTION"),
        c("CRYPTO:CCC-USD", "CRYPTOCURRENCY"),
      ]).map((x) => x.id),
    ).toEqual(["US:AAA", "US:BBB", "CRYPTO:CCC-USD", "CME:AAA=F", "X:AAA"]);
  });

  test("Show in offers only currencies the server converts into", () => {
    expect(
      currencies({
        ...HOLDINGS,
        display_currency: "EUR",
        totals: [
          ...HOLDINGS.totals,
          { ...HOLDINGS.totals[0]!, currency: "BGN" },
          { ...HOLDINGS.totals[0]!, currency: "GBp" },
        ],
      }),
    ).toEqual(["EUR", "USD"]);
  });

  test("a buy costs its fees on top, a sell nets them, a bond counts per hundred", () => {
    expect(tradeMoney("buy", 5, 10, 1, "per_share")).toBe(51);
    expect(tradeMoney("sell", 5, 10, 1, "per_share")).toBe(49);
    expect(tradeMoney("buy", 1000, 98, 0, "percent_of_par")).toBe(980);
  });

  test("an amount is shown in the display currency by the rate the holdings used", () => {
    const h = {
      ...HOLDINGS,
      display_currency: "EUR",
      rates: [
        { from: "USD", to: "EUR", rate: 0.9, at: "2026-10-28T11:55:00Z" },
      ],
    } as Holdings;
    expect(shownIn(h, 100, "USD")).toEqual({ value: 90, currency: "EUR" });
    expect(shownIn(h, 100, "EUR")).toBeNull();
    expect(shownIn(h, 100, "JPY")).toBeNull();
  });

  test("holdings rank by their converted value, whatever their currency", () => {
    const row = (id: string, currency: string, value: number | null) =>
      ({
        ...HOLDINGS.holdings[0]!,
        id,
        currency,
        converted:
          value === null
            ? undefined
            : {
                currency: "EUR",
                rate: 1,
                rate_at: null,
                value,
                cost: null,
                pl: null,
              },
      }) as Holding;
    const rows = [
      row("A", "EUR", 50),
      row("B", "EUR", 10),
      row("C", "USD", null),
      row("D", "USD", 90),
      row("E", "RON", 50),
    ];
    expect(largestFirst(rows).map((r) => r.id)).toEqual([
      "D",
      "A",
      "E",
      "B",
      "C",
    ]);
  });

  test("where a listing is held: every portfolio and broker of it", () => {
    expect(
      heldAt(HOLDINGS, "XETRA:AAA").map((p) => [p.broker, p.quantity]),
    ).toEqual([
      ["North", 4],
      ["South", 3],
    ]);
    expect(heldAt(HOLDINGS, "US:NOT")).toEqual([]);
  });

  test("a buy pays from its own currency's dry powder, its portfolio's first", () => {
    const all = [
      { position: 1, portfolio: "Cash", currency: "EUR" },
      { position: 2, portfolio: "Shares", currency: "USD" },
      { position: 3, portfolio: "Cash", currency: "USD" },
    ];
    expect(dryPowderFor(all, "Shares", "USD")?.position).toBe(2);
    expect(dryPowderFor(all, "Cash", "USD")?.position).toBe(3);
    expect(dryPowderFor(all, "Coins", "USD")?.currency).toBe("USD");
    expect(dryPowderFor(all, "Cash", "JPY")?.position).toBe(1);
    expect(dryPowderFor([], "Cash", "EUR")).toBeNull();
    expect(dryPowders(HOLDINGS)).toEqual([
      { position: 5, portfolio: "", currency: "EUR" },
    ]);
  });

  test("the only portfolio is picked for an add and an import", async () => {
    const f = fake({
      "GET /api/v1/portfolios": {
        ...OVERVIEW,
        portfolios: [OVERVIEW.portfolios[0]!],
        brokers: [OVERVIEW.brokers[0]!],
      },
      "GET /api/v1/holdings": HOLDINGS,
      "GET /api/v1/trades": { trades: [] },
    });
    const s = store(
      f.fetch,
      () => NOW,
      () => "/portfolios",
      () => {},
    );
    await s.portfolios.load();
    const add = render(<AddForm store={s.portfolios} onDone={() => {}} />);
    expect(add).toContain('aria-label="Portfolio: Shares"');
    expect(add).toContain('aria-label="Broker: North"');
    expect(add).not.toContain("Pick a portfolio");
    expect(
      render(<ImportPanel store={s.portfolios} onDone={() => {}} />),
    ).toContain('aria-label="Portfolio: Shares"');
  });

  test("a holding's Buy or Sell opens the panel on it", async () => {
    const { s } = await loaded();
    const html = render(
      <AddForm
        store={s.portfolios}
        onDone={() => {}}
        start={{ symbol: "XETRA:AAA", side: "sell", portfolio: "Shares" }}
      />,
    );
    expect(html).toContain('<span class="ins-symbol">AAA</span>');
    expect(html).toContain('aria-label="Change symbol"');
    expect(html).toMatch(/aria-pressed="true"[^>]*>Sell/);
    expect(html).toContain("Add sell");
    expect(html).not.toContain("Pick a portfolio");
  });
});
