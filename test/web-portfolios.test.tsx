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
import {
  addressOf,
  JUST_SAVED,
  plainError,
  viewOf,
} from "../src/web/data/portfolios.ts";
import { store } from "../src/web/data/store.ts";
import { accessWords } from "../src/web/views/Connect.model.ts";
import {
  AddForm,
  FoundList,
  FundPriceEdit,
  ImportPanel,
  PositionEdit,
  Purchases,
  Refusal,
  SettingsPanel,
} from "../src/web/views/PortfolioForms.tsx";
import {
  activityOf,
  amount,
  barOf,
  change,
  columnsFor,
  currencies,
  dryPowderFor,
  dryPowders,
  enteredBy,
  findZones,
  foldFills,
  groupShare,
  groupsOf,
  heldAt,
  heroOf,
  holdingMatches,
  holdingName,
  holdingTicker,
  homeOf,
  importLine,
  listingWords,
  missingWords,
  money,
  monthsOf,
  orderOf,
  pageOf,
  priceLine,
  ranked,
  rateLine,
  readRemembered,
  rowActions,
  shownGainPercent,
  shownIn,
  shownValue,
  signedMoney,
  sortRows,
  sums,
  today,
  tradeMatches,
  tradeMoney,
  tradeName,
  typed,
  unitPrice,
  zoneWords,
} from "../src/web/views/Portfolios.model.ts";
import {
  Activity,
  EditSheet,
  PortfoliosBody,
  rowMenu,
  TradeSheet,
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
  test("leads with the value band, then holdings and activity", async () => {
    const { s } = await loaded();
    const html = render(<PortfoliosBody store={s.portfolios} />);
    expect(html).toContain("All portfolios");
    // nothing converted: the first currency's total, never a sum
    expect(html).toContain("1,000");
    expect(html).not.toContain("2,000");
    expect(html).toContain(">Holdings<");
    expect(html).toContain(">Activity<");
    expect(html).toContain('aria-label="Add"');
    expect(html).toContain('aria-label="More"');
    // the instrument's symbol, never its id
    expect(html).toContain(">AAA<");
    expect(html).not.toContain("XETRA:AAA");
    // the portfolios are links, so a pick is a step Back returns from
    expect(html).toContain('href="/portfolios/1"');
    expect(html).toContain('aria-current="page"');
  });

  test("a cash row opens its drawer from a button, a listed row its page", async () => {
    const { s } = await loaded();
    const html = render(<PortfoliosBody store={s.portfolios} />);
    expect(html).toContain(
      '<button type="button" class="table-open"><span class="table-hidden">Kept for buying</span>',
    );
    expect(html).toContain(
      '<a class="table-open" href="/instruments/XETRA%3AAAA">',
    );
  });

  test("a holding sold today shows the day's move in place of its value", async () => {
    const { s } = await loaded({
      ...HOLDINGS,
      holdings: [
        { ...HOLDINGS.holdings[0]!, sold_today: true, day_change: -12 },
        HOLDINGS.holdings[1]!,
      ],
    });
    const html = render(<PortfoliosBody store={s.portfolios} />);
    expect(html).toContain("Sold today");
    expect(html).toContain("−12.00 EUR");
  });

  test("a broker in an old link is ignored", async () => {
    const f = fake({
      "GET /api/v1/portfolios/1/holdings": HOLDINGS,
      "GET /api/v1/portfolios": OVERVIEW,
      "GET /api/v1/trades": { trades: [] },
    });
    const t = store(
      f.fetch,
      () => NOW,
      () => "/portfolios",
      () => {},
    );
    await t.portfolios.open(viewOf("1", "?broker=North&currency=USD"));
    expect(f.asked).toContain("GET /api/v1/portfolios/1/holdings?currency=USD");
    expect(f.asked.some((a) => a.includes("broker="))).toBe(false);
    expect(t.portfolios.portfolio.value).toBe(1);
  });

  test("a portfolio gone elsewhere falls back to all", async () => {
    const t = store(
      async (path) => {
        if (path.startsWith("/api/v1/portfolios/9/")) {
          return Response.json(
            { code: "not_found", detail: "no such portfolio" },
            {
              status: 404,
              headers: { "content-type": "application/problem+json" },
            },
          );
        }
        if (path.startsWith("/api/v1/trades"))
          return Response.json({ trades: [] });
        if (path.includes("/holdings")) return Response.json(HOLDINGS);
        return Response.json(OVERVIEW);
      },
      () => NOW,
      () => "/portfolios",
      () => {},
    );
    await t.portfolios.pick({ portfolio: 9 });
    expect(t.portfolios.portfolio.value).toBeNull();
    expect(t.portfolios.error.value).toBeNull();
  });

  test("with a converted total, it is the one total shown", async () => {
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
    expect(html).toContain("2,250");
    expect(html).toContain('aria-label="Show totals in"');
    expect(
      rateLine({ from: "EUR", to: "USD", rate: 1.25, at: "2026-10-28" }, NOW),
    ).toBe("1 EUR = 1.25 USD · 28 Oct");
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

  test("no native select on the page or in any of its drawers", async () => {
    const { s } = await loaded();
    const st = s.portfolios;
    const cash = HOLDINGS.holdings[1]!;
    for (const html of [
      render(<PortfoliosBody store={st} />),
      render(<AddForm store={st} onDone={() => {}} />),
      render(<ImportPanel store={st} onDone={() => {}} />),
      render(<SettingsPanel store={st} onDone={() => {}} />),
      render(<EditSheet store={st} h={cash} what="edit" onDone={() => {}} />),
      render(
        <TradeSheet
          store={st}
          fills={[trade()]}
          all
          onTrade={() => {}}
          onDone={() => {}}
        />,
      ),
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
      holdings: [
        { ...HOLDINGS.holdings[0]!, stale: ["sells more than bought"] },
        HOLDINGS.holdings[1]!,
      ],
    };
    const { s } = await loaded(odd);
    const html = render(<PortfoliosBody store={s.portfolios} />);
    expect(html).toContain("Sold more than bought");
    expect(missingWords("US:NOQ")).toBe("NOQ");
    expect(missingWords("no EUR to JPY rate")).toBe("No EUR to JPY rate");
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
    expect(holdingName(HOLDINGS.holdings[1]!, NOW)).toBe("Dry powder · 1 Oct");
    expect(
      holdingName({ ...HOLDINGS.holdings[1]!, dry_powder: false }, NOW),
    ).toBe("Reserve · 1 Oct");
    expect(holdingTicker(HOLDINGS.holdings[1]!)).toBe("Kept for buying");
    expect(money(119743.4, "EUR")).toBe("119,743 EUR");
    expect(money(12.5, "EUR")).toBe("12.50 EUR");
    expect(signedMoney(-2500.6, null).text).toBe("−2,501");
    expect(enteredBy("web")).toBe("Web");
    expect(currencies(HOLDINGS)).toEqual(["EUR", "USD"]);
    expect(rateLine({ from: "EUR", to: "JPY", rate: null, at: null })).toBe(
      "No EUR to JPY rate",
    );
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
    expect(unitPrice(100, "RON", "percent_of_par")).toBe("100.00%");
    expect(unitPrice(80, "EUR", null)).toBe("80.00 EUR");
    expect(
      priceLine({
        ...HOLDINGS.holdings[0]!,
        price: 98.25,
        unit: "percent_of_par",
      }),
    ).toBe("98.25% of face");
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
            ? {
                currency: "EUR",
                rate: null,
                rate_at: null,
                value: null,
                cost: null,
                pl: null,
              }
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
    expect(sortRows(rows, "value").map((r) => r.id)).toEqual([
      "D",
      "A",
      "E",
      "B",
      "C",
    ]);
    // turned round, a row with nothing to rank by still goes last
    expect(sortRows(rows, "value", "asc").map((r) => r.id)).toEqual([
      "B",
      "A",
      "E",
      "D",
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
    expect(html).toContain('<span class="sym-ticker">AAA</span>');
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

  test("its row offers Buy, Sell and Set price, and opens its price", async () => {
    const { s } = await withFund();
    expect(
      rowMenu(
        fundRow,
        () => {},
        () => {},
      ).map((i) => i.label),
    ).toEqual(["Buy", "Sell", "Set price"]);
    expect(holdingName(fundRow, NOW)).toBe(`Fund · ${ISIN}`);
    // ICU builds name September "Sep" or "Sept"
    expect(priceLine(fundRow, NOW)).toMatch(/^6\.00 EUR · 30 Sept?$/);
    expect(pageOf(fundRow)).toBeNull();
    expect(homeOf(fundRow)).toBe("price");
    // no instrument page: its row is a button that opens the drawer
    const html = render(<PortfoliosBody store={s.portfolios} />);
    expect(html).not.toContain(`/instruments/fund`);
    expect(html).toContain(
      '<button type="button" class="table-open"><span class="table-hidden">Made Up World Fund</span>',
    );
  });

  test("its price form asks the day the price is for", async () => {
    const { s, bodies } = await withFund();
    const html = render(
      <FundPriceEdit store={s.portfolios} h={fundRow} onDone={() => {}} />,
    );
    expect(html).toContain("Price per unit");
    expect(html).toContain('value="Made Up World Fund"');
    expect(html).toContain(`type="date" value="${today(null)}"`);
    expect(html).toContain('aria-label="Market: BVB"');
    expect(html).not.toContain("<select");
    expect(
      await s.portfolios.setFundPrice(ISIN, { price: 6.5, date: "2026-10-27" }),
    ).toBeNull();
    expect(
      await s.portfolios.setFundPrice(ISIN, { name: "Made Up Globe Fund" }),
    ).toBeNull();
    expect(bodies).toEqual([
      [`PATCH /api/v1/funds/${ISIN}`, { price: 6.5, date: "2026-10-27" }],
      [`PATCH /api/v1/funds/${ISIN}`, { name: "Made Up Globe Fund" }],
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
    expect(tradeName(t)).toBe("Made Up World Fund");
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

describe("the view in the address", () => {
  test("names the portfolio in the path and the currency in the query", () => {
    expect(addressOf({ portfolio: null, currency: null })).toBe("/portfolios");
    expect(addressOf({ portfolio: 5, currency: null })).toBe("/portfolios/5");
    expect(addressOf({ portfolio: 5, currency: "RON" })).toBe(
      "/portfolios/5?currency=RON",
    );
  });

  test("reads back what it wrote, and anything else as all", () => {
    expect(viewOf("5", "?currency=RON")).toEqual({
      portfolio: 5,
      currency: "RON",
    });
    // a list's broker is no longer part of the address
    expect(viewOf("abc", "?broker=North&currency=XYZ")).toEqual({
      portfolio: null,
      currency: null,
    });
    expect(viewOf(undefined, "?currency=ron").currency).toBe("RON");
  });
});

describe("a list's search", () => {
  test("match every word typed against some field", () => {
    const t = trade({ symbol: "US:MADE", name: "Made Up Corp", note: null });
    expect(tradeMatches(t, "")).toBe(true);
    expect(tradeMatches(t, "made north")).toBe(true);
    expect(tradeMatches(t, "MADE  corp")).toBe(true);
    expect(tradeMatches(t, "made south")).toBe(false);
    // the side the row shows is searched too
    expect(tradeMatches(t, "buy made")).toBe(true);
    expect(tradeMatches(t, "sell made")).toBe(false);
    const h = HOLDINGS.holdings[0]!;
    expect(holdingMatches(h, h.name!.split(" ")[0]!)).toBe(true);
    expect(holdingMatches(h, "nothing-like-it")).toBe(false);
    // the holdings search covers the brokers it is held at
    expect(holdingMatches(h, "aaa south")).toBe(true);
    expect(holdingMatches(h, "aaa west")).toBe(false);
  });
});

describe("the page's model", () => {
  const row = (more: Partial<Holding>): Holding => ({
    ...HOLDINGS.holdings[0]!,
    ...more,
  });
  const cash = HOLDINGS.holdings[1]!;

  test("groups by portfolio on All and by kind in one, largest first, with totals", () => {
    const rows = [
      row({ id: "US:AAA", type: "EQUITY", value: 100 }),
      row({
        id: "US:BBB",
        type: "ETF",
        value: 300,
        parts: [{ ...HOLDINGS.holdings[0]!.parts[0]!, portfolio: "Coins" }],
      }),
      { ...cash, value: 50 },
    ];
    expect(groupsOf(rows, false).map((g) => [g.key, g.value])).toEqual([
      ["ETFs", 300],
      ["Stocks", 100],
      ["Cash", 50],
    ]);
    expect(groupsOf(rows, true).map((g) => [g.key, g.rows.length])).toEqual([
      ["Coins", 1],
      ["Shares", 1],
      ["Other", 1],
    ]);
    expect(
      groupShare({ ...HOLDINGS, converted: null, totals: [total("EUR")] }, 250),
    ).toBe("25.0%");
  });

  test("drops the columns nothing in view fills", () => {
    expect(columnsFor(HOLDINGS.holdings)).toEqual({
      spark: true,
      price: true,
      priceHead: "Change",
      gain: true,
    });
    expect(columnsFor([cash])).toEqual({
      spark: false,
      price: false,
      priceHead: "Price",
      gain: false,
    });
    const fund = row({ kind: "fund", priced: "hand", pl: null });
    expect(columnsFor([fund, cash]).priceHead).toBe("Price");
    expect(columnsFor([fund, cash]).price).toBe(true);
  });

  test("today shows only when something moves within a day, all time only with a gain", () => {
    const h = heroOf(HOLDINGS)!;
    expect(h.today).toBe(true);
    expect(h.allTime).toBe(true);
    expect(h.dayPercent).toBeCloseTo((5 / 995) * 100);
    const still = heroOf({
      ...HOLDINGS,
      totals: [total("EUR", { cost: 0, pl: null })],
      holdings: [cash],
    })!;
    expect(still.today).toBe(false);
    expect(still.allTime).toBe(false);
    expect(heroOf({ ...HOLDINGS, totals: [] })).toBeNull();
  });

  test("the bar splits invested from cash, or dry powder from reserve, only with both", () => {
    expect(barOf(total("EUR"))!.map((x) => [x.label, x.pct])).toEqual([
      ["Invested", 70],
      ["Cash", 30],
    ]);
    expect(barOf(total("EUR", { dry_powder: 0 }))).toBeNull();
    expect(
      barOf(total("EUR", { invested: 0, dry_powder: 300, cash: 100 }))!.map(
        (x) => x.label,
      ),
    ).toEqual(["Dry powder", "Reserve"]);
    expect(barOf(total("EUR", { invested: 0, cash: 0 }))).toBeNull();
  });

  test("fills of one order fold into one row; months read newest first", () => {
    const fills = [
      trade({ id: 1, quantity: 1, price: 10, fees: 0 }),
      trade({ id: 2, quantity: 3, price: 14, fees: 0 }),
      trade({ id: 3, broker: "South" }),
      trade({ id: 4, side: "sell", date: "2026-04-01" }),
      trade({ id: 5, price: 0, fees: 0 }),
    ];
    const orders = foldFills(fills);
    expect(orders.map((o) => o.map((t) => t.id))).toEqual([
      [4],
      [5],
      [3],
      [2, 1],
    ]);
    expect(orderOf(orders[3]!)).toEqual({
      quantity: 4,
      amount: 52,
      fees: 0,
      price: 13,
    });
    const months = monthsOf(fills);
    expect(months.map((m) => [m.label, m.trail])).toEqual([
      ["April 2026", "1 sold"],
      ["March 2026", "3 bought"],
    ]);
    expect(tradeName(trade({ symbol: "CRYPTO:BTC-USD" }))).toBe("BTC");
  });

  test("fills in two portfolios stay two orders, so a removal hits its own", () => {
    const orders = foldFills([
      trade({ id: 1 }),
      trade({ id: 2, portfolio: "Coins" }),
    ]);
    expect(orders.map((o) => o.map((t) => t.id))).toEqual([[2], [1]]);
  });

  test("a row with no rate shows no display value and counts in no sum", () => {
    const conv = (value: number | null, rate: number | null) => ({
      currency: "USD",
      rate,
      rate_at: null,
      value,
      cost: null,
      pl: null,
      pl_percent: null,
      weight: null,
    });
    const rated = row({
      value: 100,
      day_change: 2,
      converted: conv(125, 1.25),
    });
    const lost = row({
      value: 700,
      day_change: 5,
      converted: conv(null, null),
    });
    expect(shownValue(lost)).toBeNull();
    expect(shownValue(row({ value: 7 }))).toBe(7);
    expect(sums([rated, lost])).toEqual({
      value: 125,
      day: 2.5,
      dayKnown: true,
    });
    expect(groupsOf([rated, lost], true)[0]!.value).toBe(125);
  });

  test("a gain's percent is on its money's base, the rate's move in", () => {
    const conv = {
      currency: "EUR",
      rate: 0.8,
      rate_at: null,
      value: 400,
      cost: 440,
      pl: -40,
      pl_percent: -9.09,
      weight: 10,
    };
    const usd = row({
      currency: "USD",
      pl: 50,
      pl_percent: 10,
      converted: conv,
    });
    expect(shownGainPercent(usd)).toBe(-9.09);
    expect(shownGainPercent(row({ pl_percent: 10 }))).toBe(10);
    expect(
      shownGainPercent(
        row({ converted: { ...conv, rate: null, pl: null, pl_percent: null } }),
      ),
    ).toBeNull();
    const up = row({ id: "B", pl_percent: 5 });
    expect(sortRows([usd, up], "gain").map((r) => r.id)).toEqual([
      "B",
      "XETRA:AAA",
    ]);
  });

  test("with no display currency, two currencies are never summed", async () => {
    const two = {
      ...HOLDINGS,
      totals: [total("EUR", { value: 300 }), total("USD", { value: 900 })],
      holdings: [
        row({ currency: "EUR", value: 300 }),
        row({ id: "US:BBB", currency: "USD", value: 900, type: "EQUITY" }),
      ],
    };
    const hero = heroOf(two)!;
    expect(hero.total.currency).toBe("USD");
    expect(hero.others.map((t) => t.currency)).toEqual(["EUR"]);
    expect(groupShare(two, 1200)).toBe("");
    const { s } = await loaded(two);
    const html = render(<PortfoliosBody store={s.portfolios} />);
    expect(html).toContain("300.00 EUR");
    expect(html).not.toContain("1,200");
    expect(html).not.toContain("300.0%");
    // one large figure: the others are hero lines
    expect(html.match(/class="hero-value/g)).toHaveLength(1);
    expect(html).toContain('class="hero-line"');
  });

  test("a holding sold today says so under its name", () => {
    expect(holdingName(row({ sold_today: true }))).toBe(
      "Alpha Made Up · Sold today",
    );
  });

  test("the activity counts orders, not fills", () => {
    const list = [
      trade({ id: 1 }),
      trade({ id: 2 }),
      trade({ id: 3, removed_at: "2026-03-03T10:00:00Z" }),
      trade({ id: 4, removed_at: "2026-03-03T10:00:00Z" }),
    ];
    expect(activityOf(list, false, "")).toMatchObject({ count: 1, removed: 1 });
  });

  test("the activity shows live or removed trades, searched", () => {
    const list = [
      trade({ id: 1 }),
      trade({ id: 2, removed_at: "2026-03-03T10:00:00Z" }),
    ];
    expect(activityOf(list, false, "")).toMatchObject({ count: 1, removed: 1 });
    expect(activityOf(list, true, "")).toMatchObject({ count: 1, kept: 1 });
    expect(activityOf(list, false, "nothing")).toMatchObject({
      count: 0,
      kept: 1,
    });
  });

  test("a row with no instrument page opens what edits it", () => {
    expect(pageOf(HOLDINGS.holdings[0]!)).toBe("/instruments/XETRA%3AAAA");
    expect(homeOf(cash)).toBe("edit");
    expect(homeOf(row({ kind: "bond", id: null, position: null }))).toBe(
      "purchases",
    );
  });

  test("the row menu's items per kind", () => {
    expect(rowActions(HOLDINGS.holdings[0]!)).toEqual(["buy", "sell", "page"]);
    expect(rowActions(row({ sold_today: true }))).toEqual(["buy", "page"]);
    expect(rowActions(cash)).toEqual(["edit"]);
    expect(
      rowActions(
        row({ kind: "bond", id: null, position: null, priced: "face" }),
      ),
    ).toEqual(["purchases"]);
    expect(
      rowActions(row({ kind: "bond", id: null, position: 7, priced: "face" })),
    ).toEqual(["edit"]);
    expect(
      rowMenu(
        HOLDINGS.holdings[0]!,
        () => {},
        () => {},
      ).map((i) => [i.label, i.href]),
    ).toEqual([
      ["Buy", undefined],
      ["Sell", undefined],
      ["Instrument page", "/instruments/XETRA%3AAAA"],
    ]);
  });
});

describe("removed trades", () => {
  const removed = trade({ id: 2, removed_at: "2026-03-03T10:00:00Z" });

  test("a faint line at the list's end opens them under their own title", async () => {
    const page = render(
      <Activity trades={[trade(), removed]} onOpen={() => {}} />,
    );
    expect(page).toContain("Removed trades · 1");
    const view = render(
      <Activity trades={[trade(), removed]} onOpen={() => {}} removed />,
    );
    expect(view).toContain(">Removed trades<");
    expect(view).toContain("← All activity");
  });

  test("a removed trade's drawer offers Restore", async () => {
    const { s } = await loaded();
    const html = render(
      <TradeSheet
        store={s.portfolios}
        fills={[removed]}
        all={false}
        onTrade={() => {}}
        onDone={() => {}}
      />,
    );
    expect(html).toContain(">Restore<");
    expect(html).toContain("Removed from the holdings.");
    expect(html).toContain(">Removed<");
    expect(html).toContain("3 Mar 2026");
    expect(html).not.toContain(">Remove<");
  });

  test("a live trade's drawer offers Remove, Buy and Sell, its fills summed", async () => {
    const { s } = await loaded();
    const html = render(
      <TradeSheet
        store={s.portfolios}
        fills={[trade({ id: 1 }), trade({ id: 3, quantity: 2 })]}
        all
        onTrade={() => {}}
        onDone={() => {}}
      />,
    );
    expect(html).toContain("Remove");
    expect(html).toContain(">Buy<");
    expect(html).toContain(">Sell<");
    expect(html).toContain("2 fills");
    expect(html).toContain("Average price");
    expect(html).toContain(">Shares<");
  });

  test("a fund's trade offers Buy and Sell too", async () => {
    const { s } = await loaded();
    const html = render(
      <TradeSheet
        store={s.portfolios}
        fills={[trade({ symbol: "fund:ZZFUND000011", name: "Made Up Fund" })]}
        all={false}
        onTrade={() => {}}
        onDone={() => {}}
      />,
    );
    expect(html).toContain(">Buy<");
    expect(html).toContain(">Sell<");
    expect(html).toContain("Made Up Fund");
  });
});
