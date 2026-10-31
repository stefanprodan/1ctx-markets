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
import { JUST_SAVED, plainError } from "../src/web/data/portfolios.ts";
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
  findZones,
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
  today,
  tradeLine,
  tradeMoney,
  tradeSub,
  tradeTitle,
  typed,
  zoneWords,
} from "../src/web/views/Portfolios.model.ts";
import {
  AddForm,
  FoundList,
  FundActions,
  FundPriceEdit,
  ImportPanel,
  PortfoliosBody,
  PositionEdit,
  Purchases,
  Refusal,
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
      currency_weight: 70,
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
      currency_weight: 30,
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

  test("an edit starts on today, a bond's on its purchase date", async () => {
    const { s: st } = await loaded();
    const dateOf = (h: Holding) =>
      render(
        <PositionEdit store={st.portfolios} h={h} onDone={() => {}} />,
      ).match(/type="date" value="([^"]*)"/)?.[1];
    const cash = { ...HOLDINGS.holdings[1]!, as_of: "2026-01-13" };
    const bond = { ...cash, kind: "bond" as const };
    expect(dateOf(cash)).toBe(today(null));
    expect(dateOf(bond)).toBe("2026-01-13");
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

describe("the owner's time zone", () => {
  const at = (zone: string | null) => {
    const f = fake({
      "GET /api/v1/portfolios": { ...OVERVIEW, time_zone: zone },
      "GET /api/v1/holdings": HOLDINGS,
      "GET /api/v1/trades": { trades: [] },
    });
    return store(
      f.fetch,
      () => NOW,
      () => "/portfolios",
      () => {},
    );
  };

  test("today is the owner's day, the UTC day until one is named", () => {
    const evening = Date.parse("2026-10-23T18:00:00Z");
    expect(today(null, evening)).toBe("2026-10-23");
    expect(today("Pacific/Kiritimati", evening)).toBe("2026-10-24");
    expect(
      today("America/Los_Angeles", Date.parse("2026-10-24T03:00:00Z")),
    ).toBe("2026-10-23");
  });

  test("zones are found by city or area as typed", () => {
    expect(findZones("bucha")[0]).toBe("Europe/Bucharest");
    expect(findZones("new york")).toContain("America/New_York");
    expect(findZones("europe paris")).toEqual(["Europe/Paris"]);
    expect(findZones("nowhere made up")).toEqual([]);
    expect(zoneWords("America/Argentina/Buenos_Aires")).toEqual({
      city: "Buenos Aires",
      area: "America/Argentina",
    });
  });

  test("the first card asks for it, and Settings changes it", async () => {
    const s = at(null);
    await s.portfolios.load();
    s.portfolios.overview.value = {
      ...s.portfolios.overview.value!,
      display_currency: null,
    };
    const first = render(<PortfoliosBody store={s.portfolios} />);
    expect(first).toContain("Time zone");
    expect(first).toContain('aria-label="Time zone:');
    const saved = at("Asia/Tokyo");
    await saved.portfolios.load();
    const settings = render(
      <SettingsPanel store={saved.portfolios} onDone={() => {}} />,
    );
    expect(settings).toContain('aria-label="Time zone: Asia/Tokyo"');
    expect(settings).toContain("Tokyo · Asia");
    expect(settings).not.toContain("<select");
  });

  test("an edit starts on the owner's today", async () => {
    const s = at("Pacific/Kiritimati");
    await s.portfolios.load();
    const html = render(
      <PositionEdit
        store={s.portfolios}
        h={{ ...HOLDINGS.holdings[1]!, as_of: "2026-01-13" }}
        onDone={() => {}}
      />,
    );
    expect(html.match(/type="date" value="([^"]*)"/)?.[1]).toBe(
      today("Pacific/Kiritimati"),
    );
  });

  test("a refused retry reads plainly", () => {
    expect(
      plainError(
        "the same trade was saved as trade 12 in the last 10 minutes, so a retry adds nothing; again: true saves a second fill",
      ),
    ).toBe("This trade was just saved.");
  });
});

describe("a position's market", () => {
  test("cash and fund forms pick one from the app's own menu", async () => {
    const f = fake({
      "GET /api/v1/portfolios": { ...OVERVIEW, markets: ["BVB", "US"] },
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
    for (const kind of ["cash", "fund"] as const) {
      const html = render(
        <AddForm store={s.portfolios} kind={kind} onDone={() => {}} />,
      );
      expect(html).toContain('aria-label="Market: None"');
      expect(html).not.toContain("<select");
    }
    const bond = render(
      <AddForm store={s.portfolios} kind="bond" onDone={() => {}} />,
    );
    expect(bond).not.toContain("Market:");
    const edit = render(
      <PositionEdit
        store={s.portfolios}
        h={{ ...HOLDINGS.holdings[1]!, market: "BVB" }}
        onDone={() => {}}
      />,
    );
    expect(edit).toContain('aria-label="Market: BVB"');
  });
});

describe("a refused retry", () => {
  test("offers Save again, which sends the trade with again", async () => {
    const html = render(
      <Refusal text={JUST_SAVED} busy={false} onAgain={() => {}} />,
    );
    expect(html).toContain("This trade was just saved.");
    expect(html).toContain("Save again");
    expect(
      render(
        <Refusal text="Pick a portfolio." busy={false} onAgain={() => {}} />,
      ),
    ).not.toContain("Save again");
    const bodies: unknown[] = [];
    const f = fake({
      "GET /api/v1/portfolios": OVERVIEW,
      "GET /api/v1/holdings": HOLDINGS,
      "GET /api/v1/trades": { trades: [] },
      "POST /api/v1/trades": { trade: trade() },
    });
    const s = store(
      async (path, init) => {
        if (init?.method === "POST") bodies.push(JSON.parse(String(init.body)));
        return f.fetch(path, init);
      },
      () => NOW,
      () => "/portfolios",
      () => {},
    );
    await s.portfolios.load();
    await s.portfolios.addTrade({
      portfolio: 1,
      symbol: "XETRA:AAA",
      side: "buy",
      quantity: 1,
      price: 10,
      date: "2026-10-28",
      again: true,
    });
    expect(bodies).toEqual([expect.objectContaining({ again: true })]);
  });
});

describe("a fund the owner prices", () => {
  const ISIN = "ZZFUND000011";
  const fundRow: Holding = {
    ...HOLDINGS.holdings[0]!,
    kind: "fund",
    id: `fund:${ISIN}`,
    isin: ISIN,
    name: "Made Up World Fund",
    type: "FUND",
    market: "BVB",
    quantity: 10,
    average_cost: 5,
    cost: 50,
    price: 6,
    priced: "hand",
    as_of: "2026-09-30",
    value: 60,
    day_change: null,
    change_percent: null,
    parts: [
      {
        portfolio: "Shares",
        broker: "North",
        quantity: 10,
        average_cost: 5,
        cost: 50,
        value: 60,
      },
    ],
  };
  const withFund = async () => {
    const bodies: [string, unknown][] = [];
    const f = fake({
      "GET /api/v1/portfolios": {
        ...OVERVIEW,
        markets: ["BVB", "US"],
        funds: [
          {
            id: `fund:${ISIN}`,
            isin: ISIN,
            name: "Made Up World Fund",
            currency: "EUR",
            market: "BVB",
            price: 6,
            as_of: "2026-09-30",
          },
        ],
      },
      "GET /api/v1/holdings": {
        ...HOLDINGS,
        holdings: [...HOLDINGS.holdings, fundRow],
      },
      "GET /api/v1/trades": { trades: [] },
      "POST /api/v1/funds/trades": { trade: trade(), fund: {} },
      "PATCH /api/v1/funds/": { fund: {} },
    });
    const s = store(
      async (path, init) => {
        if (init?.method && init.method !== "GET") {
          bodies.push([
            `${init.method} ${path}`,
            JSON.parse(String(init.body)),
          ]);
        }
        return f.fetch(path, init);
      },
      () => NOW,
      () => "/portfolios",
      () => {},
    );
    await s.portfolios.load();
    return { s, bodies };
  };

  test("its row offers Buy, Sell and Set price", async () => {
    const { s } = await withFund();
    const html = render(
      <FundActions h={fundRow} store={s.portfolios} onTrade={() => {}} />,
    );
    expect(html).toContain(">Buy<");
    expect(html).toContain(">Sell<");
    expect(html).toContain("Set price");
    expect(holdingSub(fundRow, NOW)).toContain("Fund");
    expect(costLine(fundRow)).toMatch(/^10 × /);
  });

  test("its price form asks the day the price is for", async () => {
    const { s, bodies } = await withFund();
    const html = render(
      <FundPriceEdit store={s.portfolios} h={fundRow} onDone={() => {}} />,
    );
    expect(html).toContain("Price per unit");
    expect(html).toContain(`type="date" value="${today(null)}"`);
    expect(html).toContain('aria-label="Market: BVB"');
    expect(html).not.toContain("<select");
    expect(
      await s.portfolios.setFundPrice(ISIN, { price: 6.5, date: "2026-10-27" }),
    ).toBeNull();
    expect(bodies).toEqual([
      [`PATCH /api/v1/funds/${ISIN}`, { price: 6.5, date: "2026-10-27" }],
    ]);
  });

  test("the Fund tab records a buy, a new fund named with its currency", async () => {
    const { s, bodies } = await withFund();
    const html = render(
      <AddForm store={s.portfolios} kind="fund" onDone={() => {}} />,
    );
    for (const label of ["ISIN", "Name", "Units", "Price per unit", "Date"]) {
      expect(html).toContain(`>${label}<`);
    }
    expect(html).toContain("Currency");
    expect(html).toContain("Add buy");
    expect(html).not.toContain("<select");
    expect(
      await s.portfolios.addFundTrade({
        portfolio: 1,
        isin: "ZZFUND000029",
        name: "Made Up Bond Fund",
        currency: "EUR",
        side: "buy",
        units: 3,
        price: 10,
        date: "2026-10-27",
      }),
    ).toBeNull();
    expect(bodies[0]![0]).toBe("POST /api/v1/funds/trades");
  });

  test("its Sell opens the Fund tab on it, its name kept", async () => {
    const { s } = await withFund();
    const html = render(
      <AddForm
        store={s.portfolios}
        onDone={() => {}}
        start={{
          symbol: `fund:${ISIN}`,
          side: "sell",
          portfolio: "Shares",
          broker: "North",
          fund: { isin: ISIN, name: "Made Up World Fund", market: "BVB" },
        }}
      />,
    );
    expect(html).toMatch(/aria-selected="true"[^>]*>Fund</);
    expect(html).toContain(`value="${ISIN}"`);
    expect(html).toContain("Made Up World Fund");
    expect(html).toMatch(/aria-pressed="true"[^>]*>Sell/);
    expect(html).toContain("Add sell");
  });

  test("its trades read by name, and its refusals plainly", () => {
    const t = trade({ symbol: `fund:${ISIN}`, name: "Made Up World Fund" });
    expect(tradeTitle(t)).toBe("Buy Made Up World Fund");
    expect(
      plainError(
        "isin must be an ISIN: 2 letters, 9 letters or digits, and a check digit that matches",
      ),
    ).toBe("Not a valid ISIN.");
    expect(
      plainError("the fund ZZFUND000011 has this name; name a new fund apart"),
    ).toBe("Another fund has this name.");
  });
});
