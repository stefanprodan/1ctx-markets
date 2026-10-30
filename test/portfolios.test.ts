// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// Made-up portfolios only: no real holding, broker or amount.

import { describe, expect, test } from "bun:test";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { upsertInstrument } from "../src/market/instruments.ts";
import type { Markets } from "../src/operations/markets.ts";
import {
  addPosition,
  addTrade,
  createBroker,
  createPortfolio,
  type HoldingsAnswer,
  parsePortfolio,
  portfolioAnswer,
  readHoldings,
  readTradeList,
  saveSettings,
  setPositionState,
  setTradeState,
  updatePosition,
} from "../src/operations/portfolio.ts";
import type { Who } from "../src/operations/who.ts";
import { splitFactor } from "../src/portfolios/value.ts";
import { tokenHash } from "../src/server/access.ts";
import type { Db } from "../src/storage/db/index.ts";
import { withApp } from "./helpers/app.ts";
import { portfolioBefore } from "./helpers/portfolio.ts";
import { bar, instrument, LIVE, NOW, quote, world } from "./helpers/world.ts";

const CASEY: Who = { name: "casey-agent", portfolio: "write", rules: "none" };

// a currency pair as Yahoo lists it, with its closes and a live quote
function pair(
  db: Db,
  symbol: string,
  live: number,
  closes: Record<string, number> = {},
) {
  upsertInstrument(
    db,
    {
      market: "CCY",
      symbol,
      source: "yahoo",
      sourceSymbol: symbol,
      exchange: "CCY",
      name: symbol,
      type: "CURRENCY",
      currency: symbol.slice(3, 6),
      unit: "per_unit",
      zone: "UTC",
    },
    NOW,
  );
  for (const [date, close] of Object.entries(closes)) {
    bar(db, `CCY:${symbol}`, "1d", date, close, true);
  }
  quote(db, `CCY:${symbol}`, live, live);
}

async function setup() {
  const w = world();
  const { db } = w;
  instrument(db, "US:AAA", { currency: "USD", name: "Alpha Made Up" });
  instrument(db, "XETRA:BBB", { currency: "EUR", name: "Beta Made Up" });
  instrument(db, "CRYPTO:CCC-USD", {
    currency: "USD",
    unit: "per_unit",
    name: "Coin Made Up",
  });
  quote(db, "US:AAA", 120, 118);
  quote(db, "XETRA:BBB", 50, 50);
  quote(db, "CRYPTO:CCC-USD", 2000, 1900);
  await portfolioBefore(w.m, "Shares");
  await portfolioBefore(w.m, "Coins");
  for (const name of ["North", "South", "East"]) {
    await createBroker(w.m, { name });
  }
  return w;
}

type TradeIn = Partial<Parameters<typeof addTrade>[2]>;

const buy = (m: Markets, t: TradeIn) =>
  addTrade(m, CASEY, {
    portfolio: "Shares",
    symbol: "US:AAA",
    side: "buy",
    quantity: 1,
    price: null,
    total: null,
    fees: 0,
    date: "2026-01-05",
    currency: null,
    broker: null,
    note: null,
    ...t,
  });

const sell = (m: Markets, t: TradeIn) => buy(m, { side: "sell", ...t });

async function holdingsOf(
  m: Markets,
  args: Partial<Parameters<typeof readHoldings>[1]> = {},
): Promise<HoldingsAnswer> {
  const h = await readHoldings(m, {
    portfolio: null,
    broker: null,
    currency: null,
    ...args,
  });
  if ("error" in h) throw new Error(h.message);
  return h;
}

const row = (h: HoldingsAnswer, id: string) =>
  h.holdings.find((r) => r.id === id)!;

describe("average cost", () => {
  test("weighs buys, and a sell takes its share of cost from its own broker", async () => {
    const { m } = await setup();
    await buy(m, { quantity: 10, price: 100, fees: 5, broker: "North" });
    await buy(m, {
      quantity: 10,
      price: 110,
      fees: 5,
      broker: "North",
      date: "2026-02-02",
    });
    await buy(m, { quantity: 5, price: 90, broker: "South" });
    await buy(m, { quantity: 2, price: 95, broker: "East" });
    // half the North part goes at its average, South and East stay whole
    const sold = await sell(m, {
      quantity: 10,
      price: 130,
      broker: "North",
      date: "2026-03-02",
    });
    expect("error" in sold).toBe(false);
    const h = await holdingsOf(m);
    const a = row(h, "US:AAA");
    expect(a.parts.map((p) => [p.broker, p.quantity, p.average_cost])).toEqual([
      ["North", 10, 105.5],
      ["South", 5, 90],
      ["East", 2, 95],
    ]);
    expect(a.quantity).toBe(17);
    expect(a.cost).toBe(1055 + 450 + 190);
    expect(a.average_cost).toBeCloseTo(1695 / 17, 6);
    expect(a.value).toBe(17 * 120);
    expect(a.pl).toBe(17 * 120 - 1695);
    expect(a.day_change).toBe(17 * 2);
  });

  test("today's move counts a share bought today from its price and one sold today to its price", async () => {
    const { m } = await setup();
    await buy(m, { quantity: 10, price: 100 });
    await buy(m, { quantity: 4, price: 119, date: LIVE });
    await sell(m, { quantity: 2, price: 121, date: LIVE });
    const a = row(await holdingsOf(m), "US:AAA");
    expect(a.quantity).toBe(12);
    // 10 held at the open, 2 of them sold: 8 × 2 + 4 × 1 + 2 × 3
    expect(a.day_change).toBe(8 * 2 + 4 * 1 + 2 * 3);
  });

  test("a buy today at the live price has no move today", async () => {
    const { m } = await setup();
    await buy(m, { quantity: 10, price: 120, date: LIVE });
    const h = await holdingsOf(m);
    expect(row(h, "US:AAA").day_change).toBe(0);
    expect(h.totals.find((t) => t.currency === "USD")!.day_change).toBe(0);
  });

  test("a holding sold out today stays at nothing until the day is over, its move counted", async () => {
    const { m } = await setup();
    await buy(m, { quantity: 10, price: 100 });
    await sell(m, { quantity: 10, price: 121, date: LIVE });
    const h = await holdingsOf(m);
    const a = row(h, "US:AAA");
    expect(a).toMatchObject({ quantity: 0, value: 0, sold_today: true });
    // closed at 118, sold at 121
    expect(a.day_change).toBe(10 * 3);
    expect(h.totals.find((t) => t.currency === "USD")!.day_change).toBe(30);
    expect(h.exposure[0]!.market).toEqual([]);
  });

  test("a holding sold out on an earlier day is gone", async () => {
    const { m } = await setup();
    await buy(m, { quantity: 10, price: 100 });
    await sell(m, { quantity: 10, price: 110, date: "2026-03-17" });
    const h = await holdingsOf(m);
    expect(h.holdings).toEqual([]);
  });

  test("a sell of more than a broker holds is refused, the other parts aside", async () => {
    const { m } = await setup();
    await buy(m, { quantity: 3, price: 100, broker: "North" });
    await buy(m, { quantity: 9, price: 100, broker: "South" });
    const refused = await sell(m, { quantity: 4, price: 120, broker: "North" });
    expect(refused).toMatchObject({ error: "bad_arguments" });
    expect(JSON.stringify(refused)).not.toContain("3");
  });

  test("a split after a trade answers it in today's shares", async () => {
    const { m, db } = await setup();
    db.query(
      `insert into splits (instrument, date, numerator, denominator, ratio,
         applied_at) values ('US:AAA', '2026-04-01', 4, 1, '4:1', 0)`,
    ).run();
    expect(splitFactor([{ date: "2026-04-01", ratio: 4 }], "2026-03-31")).toBe(
      4,
    );
    await buy(m, { quantity: 10, price: 400, date: "2026-03-02" });
    // after the split: already in today's shares
    await buy(m, { quantity: 10, price: 100, date: "2026-04-01" });
    const h = await holdingsOf(m);
    const a = row(h, "US:AAA");
    expect(a.quantity).toBe(50);
    expect(a.average_cost).toBe(100);
    const [late, early] = readTradeList(m, {
      portfolio: null,
      broker: null,
      symbol: null,
      from: null,
      to: null,
      removed: false,
    }) as { split_adjusted?: unknown; quantity: number }[];
    expect(late!.split_adjusted).toBeUndefined();
    expect(early).toMatchObject({
      quantity: 10,
      split_adjusted: { quantity: 40, price: 100 },
    });
  });
});

describe("currencies", () => {
  test("a trade paid in another currency costs at its day's close, both amounts kept", async () => {
    const { m, db } = await setup();
    pair(db, "EURUSD=X", 1.2, { "2026-01-02": 1.1, "2026-01-05": 1.15 });
    // a coin listed in USD, bought with EUR
    const done = await buy(m, {
      portfolio: "Coins",
      symbol: "CRYPTO:CCC-USD",
      quantity: 1,
      price: 1000,
      fees: 10,
      currency: "EUR",
    });
    expect(done).toMatchObject({
      trade: { currency: "EUR", listing_currency: "USD" },
    });
    const c = row(await holdingsOf(m), "CRYPTO:CCC-USD");
    expect(c.currency).toBe("USD");
    expect(c.cost).toBe(money(1010 * 1.15));
    expect(c.paid).toEqual([{ currency: "EUR", amount: 1010 }]);
    expect(c.value).toBe(2000);
  });

  test("totals are per currency, never summed across them", async () => {
    const { m } = await setup();
    await buy(m, { quantity: 2, price: 100 });
    await buy(m, { symbol: "XETRA:BBB", quantity: 4, price: 40 });
    const h = await holdingsOf(m);
    expect(h.currency).toBeNull();
    expect(h.converted).toBeNull();
    expect(h.totals.map((t) => [t.currency, t.value])).toEqual([
      ["EUR", 200],
      ["USD", 240],
    ]);
    // weights only within one currency
    expect(row(h, "US:AAA").weight).toBe(100);
    expect(row(h, "XETRA:BBB").weight).toBe(100);
    expect(h.exposure.map((e) => e.currency)).toEqual(["EUR", "USD"]);
  });

  test("a named currency converts every row and part with its rate and time", async () => {
    const { m, db } = await setup();
    pair(db, "EURUSD=X", 1.25, { "2026-01-05": 1.1 });
    await buy(m, { quantity: 2, price: 100 });
    await buy(m, { symbol: "XETRA:BBB", quantity: 4, price: 40 });
    const h = await holdingsOf(m, { currency: "USD" });
    expect(h.rates).toEqual([
      {
        from: "EUR",
        to: "USD",
        rate: 1.25,
        pair: "CCY:EURUSD=X",
        at: "2026-10-23T18:00:00Z",
        stale: expect.any(Array),
      },
      { from: "USD", to: "USD", rate: 1, pair: null, at: null, stale: [] },
    ]);
    // the trade day's close a converted cost used, by pair
    expect(h.cost_rates).toEqual([
      {
        from: "EUR",
        to: "USD",
        pair: "CCY:EURUSD=X",
        count: 1,
        first: "2026-01-05",
        last: "2026-01-05",
      },
    ]);
    const b = row(h, "XETRA:BBB");
    // value at the live rate, cost at the trade day's close
    expect(b.converted).toMatchObject({
      currency: "USD",
      rate: 1.25,
      value: 250,
      cost: 176,
    });
    expect(h.converted).toMatchObject({ currency: "USD", value: 490 });
    expect(h.converted!.missing).toEqual([]);
    const weights = h.exposure[0]!.currency_weights!;
    expect(weights.map((w) => w.key)).toEqual(["EUR", "USD"]);
  });

  test("a pair the server cannot quote is null with its reason", async () => {
    const { m } = await setup();
    await buy(m, { symbol: "XETRA:BBB", quantity: 4, price: 40 });
    // no pair stored, and the tests' Yahoo answers nothing
    const h = await holdingsOf(m, { currency: "JPY" });
    const b = row(h, "XETRA:BBB");
    expect(b.converted).toMatchObject({ rate: null, value: null });
    expect(h.rates[0]).toMatchObject({
      from: "EUR",
      to: "JPY",
      rate: null,
      reason: "no EUR to JPY rate",
    });
    expect(h.converted!.missing).toEqual(["no EUR to JPY rate"]);
  });

  test("the owner's display currency converts when the caller names none", async () => {
    const { m, db } = await setup();
    pair(db, "EURUSD=X", 1.25);
    await buy(m, { symbol: "XETRA:BBB", quantity: 4, price: 40 });
    expect((await holdingsOf(m)).converted).toBeNull();
    await saveSettings(m, { display_currency: "USD" });
    const shown = await holdingsOf(m);
    expect(shown.display_currency).toBe("USD");
    expect(shown.converted).toMatchObject({ currency: "USD", value: 250 });
    // a named currency wins
    expect((await holdingsOf(m, { currency: "EUR" })).converted?.currency).toBe(
      "EUR",
    );
    // it can be changed, never cleared
    for (const bad of [null, "ABC", "usd", "GBp"]) {
      await expect(saveSettings(m, { display_currency: bad })).rejects.toThrow(
        "in circulation",
      );
    }
    await expect(saveSettings(m, {})).rejects.toThrow("in circulation");
    // a conversion named by the caller takes the same list
    expect(() =>
      parsePortfolio({ action: "holdings", currency: "ABC" }),
    ).toThrow("in circulation");
    expect((await holdingsOf(m)).display_currency).toBe("USD");
  });

  test("every currency a person names is in circulation, or a listing's hundredth", () => {
    const trade = {
      action: "add",
      kind: "trade",
      symbol: "AAA",
      side: "buy",
      quantity: 1,
      price: 1,
      date: "2026-01-02",
    };
    const named = [
      trade,
      { action: "add", kind: "cash", name: "Cash", amount: 1 },
      { action: "add", kind: "fund", name: "Fund", units: 1, price: 1 },
      {
        action: "add",
        kind: "bond",
        name: "Bond",
        amount: 1,
        coupon: 5,
        maturity: "2030-01-02",
      },
      { action: "update", position: "dry_powder", by: 1 },
    ];
    for (const args of named) {
      expect(() => parsePortfolio({ ...args, currency: "ABC" })).toThrow(
        "in circulation",
      );
      expect(() => parsePortfolio({ ...args, currency: "EUR" })).not.toThrow();
    }
    expect(parsePortfolio({ ...trade, currency: "GBp" })).toMatchObject({
      trade: { currency: "GBp" },
    });
  });

  test("a portfolio needs a display currency set first", async () => {
    const { m } = world();
    expect(await createPortfolio(m, { name: "Shares" })).toEqual({
      error: "conflict",
      message: "Set a display currency first.",
    });
    await saveSettings(m, { display_currency: "EUR" });
    expect(await createPortfolio(m, { name: "Shares" })).toMatchObject({
      portfolio: { name: "Shares" },
    });
  });
});

const money = (v: number) => Math.round(v * 100) / 100;

describe("positions", () => {
  test("a hand price is shown with its date", async () => {
    const { m, db } = await setup();
    await addPosition(m, CASEY, {
      kind: "fund",
      portfolio: "Shares",
      name: "Made Up Fund",
      symbol: null,
      currency: "EUR",
      amount: null,
      units: 10,
      price: 12.5,
      cost: 100,
      coupon: null,
      maturity: null,
      date: "2026-04-17",
      broker: null,
      note: null,
      dryPowder: false,
    });
    const f = (await holdingsOf(m)).holdings.find((r) => r.kind === "fund")!;
    // migration 0020's check keeps the old word in the table
    expect(
      db
        .query("select count(*) as n from positions where kind = 'manual'")
        .get(),
    ).toEqual({ n: 1 });
    expect(f).toMatchObject({
      priced: "hand",
      as_of: "2026-04-17",
      price: 12.5,
      value: 125,
      pl: 25,
    });
  });

  test("a bond with no listing is valued at face, said so", async () => {
    const { m } = await setup();
    await addPosition(m, CASEY, {
      kind: "bond",
      portfolio: "Shares",
      name: "Made Up Bond",
      symbol: null,
      currency: "EUR",
      amount: 1000,
      units: null,
      price: null,
      cost: 990,
      coupon: 5,
      maturity: "2030-01-01",
      date: "2026-01-02",
      broker: null,
      note: null,
      dryPowder: false,
    });
    const b = (await holdingsOf(m)).holdings.find((r) => r.kind === "bond")!;
    expect(b).toMatchObject({ priced: "face", value: 1000, coupon: 5 });
  });
});

const cash = (m: Markets, amount: number, currency = "EUR", dry = true) =>
  addPosition(m, CASEY, {
    kind: "cash",
    portfolio: "Shares",
    name: "Kept for buying",
    symbol: null,
    currency,
    amount,
    units: null,
    price: null,
    cost: null,
    coupon: null,
    maturity: null,
    date: LIVE,
    broker: null,
    note: null,
    dryPowder: dry,
  });

describe("a fund, kept under its old word", () => {
  test("adding it again replaces it, and a removal restores", async () => {
    const { m } = await setup();
    const fund = (units: number) =>
      addPosition(m, CASEY, {
        kind: "fund",
        portfolio: "Shares",
        name: "Made Up Fund",
        symbol: null,
        currency: "EUR",
        amount: null,
        units,
        price: 10,
        cost: null,
        coupon: null,
        maturity: null,
        date: "2026-04-17",
        broker: "North",
        note: null,
        dryPowder: false,
      });
    const first = await fund(5);
    const second = await fund(8);
    if ("error" in first || "error" in second) throw new Error("refused");
    expect(second.replaced).toBe(first.position.id);
    const funds = () =>
      holdingsOf(m).then((h) => h.holdings.filter((r) => r.kind === "fund"));
    expect((await funds()).map((r) => r.quantity)).toEqual([8]);
    await setPositionState(m, CASEY, second.position.id, true);
    expect(await funds()).toEqual([]);
    await setPositionState(m, CASEY, second.position.id, false);
    expect((await funds()).map((r) => r.quantity)).toEqual([8]);
  });
});

describe("dry powder", () => {
  test("is answered per currency beside invested value and other cash", async () => {
    const { m } = await setup();
    await buy(m, { symbol: "XETRA:BBB", quantity: 4, price: 40 });
    await cash(m, 300);
    await addPosition(m, CASEY, {
      kind: "cash",
      portfolio: "Shares",
      name: "Current account",
      symbol: null,
      currency: "EUR",
      amount: 500,
      units: null,
      price: null,
      cost: null,
      coupon: null,
      maturity: null,
      date: LIVE,
      broker: null,
      note: null,
      dryPowder: false,
    });
    const eur = (await holdingsOf(m)).totals[0]!;
    expect(eur).toMatchObject({
      currency: "EUR",
      value: 1000,
      invested: 200,
      cash: 500,
      dry_powder: 300,
      invested_weight: 20,
      cash_weight: 50,
      dry_powder_weight: 30,
    });
  });

  test("a buy paid from it is add, then update by its cost in another currency", async () => {
    const { m, db } = await setup();
    pair(db, "EURUSD=X", 1.25);
    const dry = await cash(m, 2000);
    if ("error" in dry) throw new Error(dry.message);
    const tool = (input: object) =>
      portfolioAnswer(m, CASEY, parsePortfolio(input)).then((r) =>
        JSON.parse(r.content[0]!.text),
      );
    const bought = await tool({
      action: "add",
      portfolio: "Shares",
      symbol: "US:AAA",
      side: "buy",
      quantity: 5,
      broker: "north",
      date: LIVE,
    });
    // no price: the live one, shown back
    expect(bought.live_price).toMatchObject({ price: 120 });
    expect(bought.trade).toMatchObject({ price: 120, broker: "North" });
    const moved = await tool({
      action: "update",
      position: dry.position.id,
      by: -600,
      currency: "USD",
    });
    expect(moved.rate).toMatchObject({ from: "USD", to: "EUR", rate: 0.8 });
    expect(moved.position).toMatchObject({
      amount: 1520,
      dry_powder: true,
      entered_by: "casey-agent",
      replaces: dry.position.id,
    });
    // a wrong update is seen and set back
    await setPositionState(m, CASEY, dry.position.id, false);
    const back = (await holdingsOf(m)).holdings.find((r) => r.kind === "cash")!;
    expect(back.value).toBe(2000);
  });

  test("an amount with no currency takes its target's", async () => {
    const { m } = await setup();
    const dry = await cash(m, 2000);
    if ("error" in dry) throw new Error(dry.message);
    const tool = (input: object) =>
      portfolioAnswer(m, CASEY, parsePortfolio(input)).then((r) =>
        JSON.parse(r.content[0]!.text),
      );
    // the dry powder's own currency, and no rate to answer
    const moved = await tool({
      action: "update",
      position: "dry_powder",
      by: 450,
    });
    expect(moved.rate).toBeUndefined();
    expect(moved.position).toMatchObject({ amount: 2450, currency: "EUR" });
    // a total in the listing's currency
    await buy(m, { quantity: 4, price: 100 });
    const sold = await tool({
      action: "add",
      portfolio: "Shares",
      symbol: "US:AAA",
      side: "sell",
      quantity: 2,
      total: 300,
    });
    expect(sold.trade).toMatchObject({ currency: "USD", price: 150 });
    expect(sold.total).toEqual({
      amount: 300,
      currency: "USD",
      includes_fees: true,
    });
  });

  test("dry powder in two currencies, none named, is refused with both", async () => {
    const { m } = await setup();
    await cash(m, 2000, "EUR");
    await addPosition(m, CASEY, {
      kind: "cash",
      portfolio: "Coins",
      name: "Kept for coins",
      symbol: null,
      currency: "USD",
      amount: 500,
      units: null,
      price: null,
      cost: null,
      coupon: null,
      maturity: null,
      date: LIVE,
      broker: null,
      note: null,
      dryPowder: true,
    });
    const r = await portfolioAnswer(
      m,
      CASEY,
      parsePortfolio({ action: "update", position: "dry_powder", by: 100 }),
    );
    expect(r.isError).toBe(true);
    const body = JSON.parse(r.content[0]!.text);
    expect(body.positions.map((p: { currency: string }) => p.currency)).toEqual(
      ["EUR", "USD"],
    );
    expect(JSON.stringify(body)).not.toContain("2000");
    // naming the currency picks one
    const picked = await portfolioAnswer(
      m,
      CASEY,
      parsePortfolio({
        action: "update",
        position: "dry_powder",
        by: 100,
        currency: "USD",
      }),
    );
    expect(JSON.parse(picked.content[0]!.text).position.amount).toBe(600);
  });

  test("a sell of all across two brokers, then the proceeds into dry powder", async () => {
    const { m, db } = await setup();
    pair(db, "EURUSD=X", 1.25);
    await buy(m, { quantity: 3, price: 100, broker: "North" });
    await buy(m, { quantity: 2, price: 100, broker: "South" });
    const dry = await cash(m, 100);
    if ("error" in dry) throw new Error(dry.message);
    const sold = await sell(m, {
      quantity: "all",
      total: 1000,
      fees: 5,
      currency: "USD",
      date: LIVE,
    });
    if ("error" in sold) throw new Error(sold.message);
    expect(sold.total).toEqual({
      amount: 1000,
      currency: "USD",
      includes_fees: true,
    });
    expect(sold.trades!.map((t) => [t.broker, t.quantity, t.price])).toEqual([
      ["North", 3, 201],
      ["South", 2, 201],
    ]);
    expect(row(await holdingsOf(m), "US:AAA")).toMatchObject({
      quantity: 0,
      sold_today: true,
    });
    const put = await updatePosition(m, CASEY, dry.position.id, {
      by: { amount: 1000, currency: "USD" },
    });
    expect(put).toMatchObject({ position: { amount: 900 } });
  });

  test("a sell of all at one broker leaves the others", async () => {
    const { m } = await setup();
    await buy(m, { quantity: 3, price: 100, broker: "North" });
    await buy(m, { quantity: 2, price: 100, broker: "South" });
    const sold = await sell(m, {
      quantity: "all",
      price: 110,
      broker: "South",
      date: LIVE,
    });
    expect(sold).toMatchObject({ trade: { quantity: 2, broker: "South" } });
    const a = row(await holdingsOf(m), "US:AAA");
    expect(a.parts.map((p) => p.broker)).toEqual(["North"]);
  });
});

describe("trades", () => {
  test("a removed trade is kept and restored", async () => {
    const { m } = await setup();
    const made = await buy(m, { quantity: 2, price: 100 });
    if ("error" in made) throw new Error(made.message);
    const id = made.trade!.id;
    const gone = await setTradeState(m, CASEY, id, true);
    expect(gone).toMatchObject({ trade: { removed_by: "casey-agent" } });
    expect(row(await holdingsOf(m), "US:AAA")).toBeUndefined();
    const all = readTradeList(m, {
      portfolio: null,
      broker: null,
      symbol: null,
      from: null,
      to: null,
      removed: true,
    });
    expect((all as { id: number }[]).map((t) => t.id)).toEqual([id]);
    await setTradeState(m, CASEY, id, false);
    expect(row(await holdingsOf(m), "US:AAA").quantity).toBe(2);
  });

  test("an unknown broker is refused with the known ones, never made", async () => {
    const { m, db } = await setup();
    const r = await buy(m, { quantity: 1, price: 1, broker: "Nort" });
    expect(r).toMatchObject({
      error: "not_found",
      message: "no broker Nort; brokers: East, North, South",
    });
    expect(
      (db.query("select count(*) as n from brokers").get() as { n: number }).n,
    ).toBe(3);
  });

  test("a key that reads cannot write, one without access cannot read", async () => {
    const { m } = await setup();
    const reader: Who = { name: "reader", portfolio: "read", rules: "none" };
    const none: Who = { name: "none", portfolio: "none", rules: "none" };
    const write = await portfolioAnswer(
      m,
      reader,
      parsePortfolio({ action: "remove", trade: 1 }),
    );
    expect(write.isError).toBe(true);
    expect(JSON.parse(write.content[0]!.text).error).toBe("forbidden");
    const read = await portfolioAnswer(
      m,
      none,
      parsePortfolio({ action: "list" }),
    );
    expect(JSON.parse(read.content[0]!.text).error).toBe("forbidden");
  });
});

describe("setup", () => {
  const ask = async (m: Markets, args: object, who: Who = CASEY) => {
    const r = await portfolioAnswer(
      m,
      who,
      parsePortfolio({ action: "setup", ...args }),
    );
    return { error: r.isError === true, body: JSON.parse(r.content[0]!.text) };
  };

  test("a new owner's agent sets the currency, a portfolio and a broker in one call", async () => {
    const { m } = world();
    instrument(m.db, "US:AAA", { currency: "USD", name: "Alpha Made Up" });
    quote(m.db, "US:AAA", 120, 118);
    const refused = await ask(m, { portfolio: "Long term" });
    expect(refused.error).toBe(true);
    expect(refused.body.message).toContain("display_currency");
    expect(() => parsePortfolio({ action: "setup" })).toThrow("one or more");
    const done = await ask(m, {
      display_currency: "EUR",
      portfolio: "Long term",
      broker: "North",
    });
    expect(done.error).toBe(false);
    expect(done.body).toMatchObject({
      display_currency: "EUR",
      made: ["portfolio Long term", "broker North"],
      brokers: [{ name: "North" }],
    });
    expect(done.body.portfolios.map((p: { name: string }) => p.name)).toEqual([
      "Long term",
    ]);
    // the owner's currency is set once: the same is a no-op, another refused
    const changed = await ask(m, { display_currency: "USD", broker: "South" });
    expect(changed.error).toBe(true);
    expect(changed.body.message).toContain("EUR");
    expect((await ask(m, { display_currency: "EUR" })).body.made).toEqual([]);
    // a retry makes nothing twice
    const again = await ask(m, { portfolio: "Long term", broker: "North" });
    expect(again.body.made).toEqual([]);
    expect(again.body.portfolios).toHaveLength(1);
    // the one portfolio and the broker made take a trade at once
    const added = await portfolioAnswer(
      m,
      CASEY,
      parsePortfolio({
        action: "add",
        symbol: "US:AAA",
        side: "buy",
        quantity: 10,
        price: 100,
        broker: "North",
      }),
    );
    expect(added.isError).toBeUndefined();
  });

  test("setup is a write and takes only its own arguments", async () => {
    const { m } = world();
    const reader: Who = { name: "reader", portfolio: "read", rules: "none" };
    const r = await ask(m, { display_currency: "EUR" }, reader);
    expect(r.body.error).toBe("forbidden");
    expect(() =>
      parsePortfolio({ action: "setup", display_currency: "ABC" }),
    ).toThrow("in circulation");
    expect(() => parsePortfolio({ action: "setup", name: "X" })).toThrow(
      "not an argument of setup",
    );
  });
});

describe("over MCP and REST", () => {
  const WRITER = "1ctx-markets-test-portfolio-writer-0123456789";

  const client = async (url: string, bearer: string) => {
    const c = new Client({ name: "test", version: "1" });
    await c.connect(
      new StreamableHTTPClientTransport(new URL(`${url}/mcp`), {
        requestInit: { headers: { authorization: `Bearer ${bearer}` } },
      }),
    );
    return c;
  };

  test("a key's portfolio access holds on the tool and the routes, and no holding is logged", () =>
    withApp(async (t) => {
      instrument(t.db, "US:AAA", { currency: "USD", name: "Alpha Made Up" });
      quote(t.db, "US:AAA", 120, 118);
      t.db
        .query(
          `insert into keys (id, name, token_hash, created_at, portfolio)
           values ('testwriterkey', 'casey-writer', ?, ?, 'write')`,
        )
        .run(tokenHash(WRITER), t.clock.now());
      const admin = { authorization: `Bearer ${t.admin}` };
      const set = await fetch(`${t.url}/api/v1/portfolio-settings`, {
        method: "PUT",
        headers: { ...admin, "content-type": "application/json" },
        body: JSON.stringify({ display_currency: "USD" }),
      });
      expect(set.status).toBe(200);
      const made = await fetch(`${t.url}/api/v1/portfolios`, {
        method: "POST",
        headers: { ...admin, "content-type": "application/json" },
        body: JSON.stringify({ name: "Shares" }),
      });
      expect(made.status).toBe(201);
      await fetch(`${t.url}/api/v1/brokers`, {
        method: "POST",
        headers: { ...admin, "content-type": "application/json" },
        body: JSON.stringify({ name: "North" }),
      });

      // the seeded agent key has no portfolio access
      const plain = await client(t.url, t.bearer);
      const refused = await plain.callTool({
        name: "portfolio",
        arguments: { action: "list" },
      });
      expect(refused.isError).toBe(true);
      expect(JSON.stringify(refused.content)).toContain("forbidden");
      await plain.close();
      const rest = await fetch(`${t.url}/api/v1/holdings`, {
        headers: { authorization: `Bearer ${t.bearer}` },
      });
      expect(rest.status).toBe(403);

      const writer = await client(t.url, WRITER);
      const added = await writer.callTool({
        name: "portfolio",
        arguments: {
          action: "add",
          symbol: "US:AAA",
          side: "buy",
          quantity: 17,
          price: 99.25,
          broker: "North",
          note: "made-up note",
          date: LIVE,
        },
      });
      expect(added.isError).toBeUndefined();
      const saved = JSON.parse((added.content as { text: string }[])[0]!.text);
      expect(saved.trade).toMatchObject({
        symbol: "US:AAA",
        entered_by: "casey-writer",
        broker: "North",
      });
      const held = await writer.callTool({
        name: "portfolio",
        arguments: { action: "holdings" },
      });
      expect((held.content as { text: string }[])[0]!.text).toContain(
        '"quantity":17',
      );
      await writer.close();

      const logged = t.lines.join("\n");
      for (const secret of [
        "99.25",
        "Alpha Made Up",
        "made-up note",
        "North",
        '"17"',
        "=17",
      ]) {
        expect([secret, logged.includes(secret)]).toEqual([secret, false]);
      }
      expect(logged).toContain("tool=portfolio");
    }));
});
