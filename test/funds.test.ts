// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// Made-up funds only: fictional names, ISINs built with a valid check
// digit, and invented dates, prices and units.

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { readInstrument } from "../src/market/instruments.ts";
import { trackedIds } from "../src/market/tracking.ts";
import type { Markets } from "../src/operations/markets.ts";
import { markets } from "../src/operations/markets.ts";
import {
  addFundTrade,
  createBroker,
  type FundTradeArgs,
  type HoldingsAnswer,
  readHoldings,
  readTradeList,
  setTradeState,
  updateFund,
} from "../src/operations/portfolio.ts";
import {
  exportCsv,
  importCsv,
  parseImport,
} from "../src/operations/portfolio-import.ts";
import { OPERATOR, type Who } from "../src/operations/who.ts";
import { fundPrices } from "../src/portfolios/funds.ts";
import { portfolioByName } from "../src/portfolios/store.ts";
import { silent } from "../src/runtime/log.ts";
import { isIsin } from "../src/shared/isin.ts";
import { fred } from "../src/sources/fred/client.ts";
import { yahoo } from "../src/sources/yahoo/client.ts";
import {
  asked as topHoldingsAsked,
  topHoldingsJobs,
} from "../src/sources/yahoo/top-holdings.ts";
import { migrate, open } from "../src/storage/db/index.ts";
import { MIGRATIONS } from "../src/storage/db/migrations/index.ts";
import { writer } from "../src/storage/writer.ts";
import { tools } from "../src/tools/index.ts";
import { parseFundTool, parseTradeTool } from "../src/tools/portfolio.ts";
import { ADMIN_KEY, api, cookieFor, READ_KEY } from "./helpers/api.ts";
import { fakeClock } from "./helpers/clock.ts";
import { ask as askTool, portfolioBefore } from "./helpers/portfolio.ts";
import { instrument, NOW, quote } from "./helpers/world.ts";

const CASEY: Who = {
  name: "casey-agent",
  user: OPERATOR,
  credential: { kind: "key", id: "casey-agent" },
  portfolio: "write",
  alerts: "none",
  profile: "none",
  analysis: "none",
};

// fictional: ZZ is no country's code
const ONE = "ZZFUND000011";
const TWO = "ZZFUND000029";

// every source call counted and refused, so a test can say none was made
async function setup() {
  const clock = fakeClock(NOW);
  const { db } = open(":memory:", clock);
  const asked: string[] = [];
  const counted = async (url: string): Promise<Response> => {
    asked.push(url);
    throw new Error(`no network in tests: ${url}`);
  };
  const m: Markets = markets({
    db,
    clock,
    writer: writer(db),
    yahoo: yahoo({ clock, fetch: counted }),
    fred: fred({ clock, key: "0".repeat(32), fetch: counted }),
    log: silent,
  });
  instrument(db, "US:AAA", { currency: "USD", name: "Alpha Made Up" });
  quote(db, "US:AAA", 120, 118);
  await portfolioBefore(m, "Shares");
  for (const name of ["North", "South"])
    await createBroker(m, OPERATOR, { name });
  return { m, db, asked };
}

const fundTrade = (more: Partial<FundTradeArgs["trade"]> = {}) => ({
  portfolio: "Shares",
  side: "buy" as const,
  quantity: 10,
  price: 5,
  total: null,
  fees: 0,
  date: "2026-03-02",
  currency: "EUR",
  broker: null,
  note: null,
  ...more,
});

const fund = async (
  m: Markets,
  named: { isin?: string; name?: string; market?: string },
  more: Partial<FundTradeArgs["trade"]> = {},
) => {
  const r = await addFundTrade(m, CASEY, {
    isin: named.isin ?? null,
    name: named.name ?? null,
    market: named.market ?? null,
    trade: fundTrade(more),
  });
  if ("error" in r) throw new Error(r.message);
  return r;
};

async function holdingsOf(m: Markets): Promise<HoldingsAnswer> {
  const h = await readHoldings(m, OPERATOR, {
    portfolio: null,
    broker: null,
    currency: null,
  });
  if ("error" in h) throw new Error(h.message);
  return h;
}

const fundRow = async (m: Markets) =>
  (await holdingsOf(m)).holdings.find((r) => r.kind === "fund")!;

const prices = (db: Database) =>
  fundPrices(db, `fund:${ONE}`).map((p) => [p.date, p.price, p.trade]);

const ask = (m: Markets, name: string, args: object) =>
  askTool(m, CASEY, name, args);

describe("an ISIN", () => {
  test("is checked by its check digit", () => {
    expect([ONE, TWO].map(isIsin)).toEqual([true, true]);
    expect(isIsin("ZZFUND000012")).toBe(false);
    expect(isIsin("ZZFUND00001")).toBe(false);
    expect(isIsin("zzfund000011")).toBe(false);
  });

  test("with a wrong check digit is refused, and no fund is made", async () => {
    const { db } = await setup();
    expect(() =>
      parseTradeTool({
        action: "add",
        isin: "ZZFUND000012",
        name: "Made Up Fund",
        side: "buy",
        quantity: 1,
        price: 1,
        currency: "EUR",
      }),
    ).toThrow("check digit");
    expect(
      db
        .query("select count(*) as n from instruments where source = 'owner'")
        .get(),
    ).toEqual({ n: 0 });
    // the same check on the lower-case spelling an agent may send
    const lower = parseTradeTool({
      action: "add",
      isin: ONE.toLowerCase(),
      name: "Made Up Fund",
      side: "buy",
      quantity: 1,
      price: 1,
      currency: "EUR",
    });
    expect(lower).toMatchObject({ fund: { isin: ONE } });
  });
});

describe("a fund's first buy", () => {
  test("makes the fund, found by its ISIN or its name after", async () => {
    const { m } = await setup();
    const first = await fund(m, { isin: ONE, name: "Made Up Growth Fund" });
    expect(first.fund).toMatchObject({
      id: `fund:${ONE}`,
      isin: ONE,
      name: "Made Up Growth Fund",
      currency: "EUR",
      price: 5,
      as_of: "2026-03-02",
    });
    expect(first.trade!.symbol).toBe(`fund:${ONE}`);
    const byIsin = await fund(m, { isin: ONE }, { date: "2026-04-01" });
    const byName = await fund(
      m,
      { name: "made up growth fund" },
      { date: "2026-05-04" },
    );
    expect([byIsin.fund.id, byName.fund.id]).toEqual([
      `fund:${ONE}`,
      `fund:${ONE}`,
    ]);
    expect((await fundRow(m)).quantity).toBe(30);
    const list = (await ask(m, "portfolio", { action: "list" })).body.funds;
    expect(list.map((f: { isin: string }) => f.isin)).toEqual([ONE]);
  });

  test("needs its name and currency; an unknown name is refused", async () => {
    const { m } = await setup();
    const add = (args: Partial<FundTradeArgs>, more = {}) =>
      addFundTrade(m, CASEY, {
        isin: null,
        name: null,
        market: null,
        trade: fundTrade(more),
        ...args,
      });
    expect(await add({ isin: ONE })).toMatchObject({ error: "bad_arguments" });
    expect(
      await add({ isin: ONE, name: "Made Up Fund" }, { currency: null }),
    ).toMatchObject({ error: "bad_arguments" });
    expect(
      await add({ isin: ONE, name: "Made Up Fund" }, { side: "sell" }),
    ).toMatchObject({ error: "not_found" });
    expect(await add({ name: "Nowhere Fund" })).toMatchObject({
      error: "not_found",
    });
    await fund(m, { isin: ONE, name: "Made Up Fund" });
    // a second fund under a name already taken
    expect(await add({ isin: TWO, name: "MADE UP FUND" })).toMatchObject({
      error: "conflict",
    });
  });

  test("has no live price to fall back on", async () => {
    const { m } = await setup();
    const r = await ask(m, "portfolio_trade", {
      action: "add",
      portfolio: "Shares",
      isin: ONE,
      name: "Made Up Fund",
      side: "buy",
      quantity: 3,
      currency: "EUR",
    });
    expect(r.body).toMatchObject({ error: "bad_arguments" });
    expect(r.body.message).toContain("price or total");
  });
});

describe("a fund's holding", () => {
  test("averages its cost through buys and a partial sell", async () => {
    const { m } = await setup();
    await fund(
      m,
      { isin: ONE, name: "Made Up Fund" },
      { quantity: 10, price: 4 },
    );
    await fund(
      m,
      { isin: ONE },
      { quantity: 10, price: 6, date: "2026-04-01" },
    );
    // a sale reduces the cost pro rata, its own price aside
    await fund(
      m,
      { isin: ONE },
      { side: "sell", quantity: 5, price: 9, date: "2026-05-04" },
    );
    const row = await fundRow(m);
    expect(row).toMatchObject({
      kind: "fund",
      id: `fund:${ONE}`,
      isin: ONE,
      type: "FUND",
      quantity: 15,
      average_cost: 5,
      cost: 75,
      priced: "hand",
      day_change: null,
    });
  });

  test("values every buy at the latest price, shown with its date", async () => {
    const { m } = await setup();
    await fund(
      m,
      { isin: ONE, name: "Made Up Fund" },
      { quantity: 4, price: 10 },
    );
    await fund(
      m,
      { isin: ONE },
      { quantity: 6, price: 12, date: "2026-04-01" },
    );
    const set = await updateFund(m, CASEY, ONE, {
      price: 15,
      date: "2026-06-30",
    });
    expect(set).toMatchObject({ price: { date: "2026-06-30", price: 15 } });
    const row = await fundRow(m);
    expect(row).toMatchObject({
      quantity: 10,
      price: 15,
      as_of: "2026-06-30",
      value: 150,
      cost: 112,
      pl: 38,
    });
    // an earlier day's price never values the holding over the latest
    await updateFund(m, CASEY, ONE, { price: 1, date: "2026-05-03" });
    expect((await fundRow(m)).value).toBe(150);
  });

  test("a price for a day already priced replaces it; earlier days stay", async () => {
    const { m, db } = await setup();
    await fund(m, { isin: ONE, name: "Made Up Fund" }, { price: 5 });
    await updateFund(m, CASEY, ONE, { price: 7, date: "2026-06-30" });
    const again = await updateFund(m, CASEY, "Made Up Fund", {
      price: 8,
      date: "2026-06-30",
    });
    expect(again).toMatchObject({ replaced: { date: "2026-06-30", price: 7 } });
    expect(fundPrices(db, `fund:${ONE}`).map((p) => [p.date, p.price])).toEqual(
      [
        ["2026-06-30", 8],
        ["2026-03-02", 5],
      ],
    );
    expect((await fundRow(m)).price).toBe(8);
  });

  test("a buy's price stands for its day only when none is entered", async () => {
    const { m, db } = await setup();
    await fund(m, { isin: ONE, name: "Made Up Fund" }, { price: 5 });
    expect((await fundRow(m)).as_of).toBe("2026-03-02");
    await updateFund(m, CASEY, ONE, { price: 6, date: "2026-04-01" });
    // a later buy on that day keeps the price entered for it
    await fund(m, { isin: ONE }, { price: 6.5, date: "2026-04-01" });
    await fund(
      m,
      { isin: ONE },
      { total: 70, quantity: 10, price: null, fees: 0, date: "2026-04-05" },
    );
    expect(fundPrices(db, `fund:${ONE}`).map((p) => [p.date, p.price])).toEqual(
      [
        ["2026-04-05", 7],
        ["2026-04-01", 6],
        ["2026-03-02", 5],
      ],
    );
  });

  test("a buy paid in another currency sets no price", async () => {
    const { m } = await setup();
    await fund(m, { isin: ONE, name: "Made Up Fund" }, { currency: "EUR" });
    await updateFund(m, CASEY, ONE, { price: 5, date: "2026-03-02" });
    const r = await addFundTrade(m, CASEY, {
      isin: ONE,
      name: null,
      market: null,
      trade: fundTrade({ currency: "USD", date: "2026-04-01", price: 6 }),
    });
    if ("error" in r) throw new Error(r.message);
    expect((await fundRow(m)).as_of).toBe("2026-03-02");
  });

  test("a removal and a restore act on its trades as a share's", async () => {
    const { m } = await setup();
    const one = await fund(
      m,
      { isin: ONE, name: "Made Up Fund" },
      { broker: "North" },
    );
    await fund(m, { isin: ONE }, { broker: "South", date: "2026-04-01" });
    expect((await fundRow(m)).parts.map((p) => p.broker)).toEqual([
      "North",
      "South",
    ]);
    await setTradeState(m, CASEY, one.trade!.id, true);
    expect((await fundRow(m)).quantity).toBe(10);
    await setTradeState(m, CASEY, one.trade!.id, false);
    expect((await fundRow(m)).quantity).toBe(20);
  });

  test("counts in the market its money is in, never its key's", async () => {
    const { m } = await setup();
    await fund(m, { isin: ONE, name: "Made Up Fund", market: "us" });
    const h = await holdingsOf(m);
    expect(h.holdings.find((r) => r.kind === "fund")!.market).toBe("US");
    const eur = h.exposure.find((x) => x.currency === "EUR")!;
    expect(eur.market.map((x) => x.key)).toEqual(["US"]);
    expect(
      (await ask(m, "portfolio", { action: "list" })).body.markets,
    ).toEqual(["US"]);
  });
});

describe("a buy's price", () => {
  test("goes with its buy, so a buy put right on the same day is valued right", async () => {
    const { m, db } = await setup();
    const wrong = await fund(
      m,
      { isin: ONE, name: "Made Up Fund" },
      { quantity: 10, price: 50 },
    );
    await setTradeState(m, CASEY, wrong.trade!.id, true);
    expect(prices(db)).toEqual([]);
    const right = await fund(m, { isin: ONE }, { quantity: 10, price: 5 });
    expect(await fundRow(m)).toMatchObject({
      price: 5,
      value: 50,
      cost: 50,
      stale: [],
    });
    expect(prices(db)).toEqual([["2026-03-02", 5, right.trade!.id]]);
    // the day's latest live buy stands: a restored earlier one waits
    await setTradeState(m, CASEY, wrong.trade!.id, false);
    expect(prices(db)).toEqual([["2026-03-02", 5, right.trade!.id]]);
    await setTradeState(m, CASEY, right.trade!.id, true);
    expect(prices(db)).toEqual([["2026-03-02", 50, wrong.trade!.id]]);
  });

  test("a later buy's replaces it; the owner's is never touched by a trade", async () => {
    const { m, db } = await setup();
    await fund(m, { isin: ONE, name: "Made Up Fund" }, { price: 5 });
    const later = await fund(m, { isin: ONE }, { price: 5.5 });
    expect(prices(db)).toEqual([["2026-03-02", 5.5, later.trade!.id]]);
    await updateFund(m, CASEY, ONE, { price: 6, date: "2026-04-01" });
    const buy = await fund(m, { isin: ONE }, { price: 7, date: "2026-04-01" });
    await setTradeState(m, CASEY, buy.trade!.id, true);
    await setTradeState(m, CASEY, buy.trade!.id, false);
    expect(prices(db)).toEqual([
      ["2026-04-01", 6, null],
      ["2026-03-02", 5.5, later.trade!.id],
    ]);
  });
});

describe("a fund's name and currency", () => {
  test("a name is set right by its ISIN, never to another fund's", async () => {
    const { m } = await setup();
    await fund(m, { isin: ONE, name: "Made Up Fund" });
    await fund(m, { isin: TWO, name: "Made Up Other Fund" });
    const renamed = await ask(m, "portfolio_fund", {
      isin: ONE,
      name: "Made Up Growth Fund",
    });
    expect(renamed.body.fund.name).toBe("Made Up Growth Fund");
    // said back, so a name sent beside the ISIN is seen to rename it
    expect(renamed.body.renamed_from).toBe("Made Up Fund");
    const same = await ask(m, "portfolio_fund", { isin: ONE, price: 6 });
    expect("renamed_from" in same.body).toBe(false);
    expect(
      await updateFund(m, CASEY, ONE, { name: "made up other fund" }),
    ).toMatchObject({ error: "conflict" });
    // named by its name alone, the name only finds it
    expect(() => parseFundTool({ name: "Made Up Growth Fund" })).toThrow(
      "changes price, market, currency or holdings",
    );
    expect((await fundRow(m)).name).toBe("Made Up Growth Fund");
  });

  test("its currency changes only while it has no live trades", async () => {
    const { m } = await setup();
    const one = await fund(m, { isin: ONE, name: "Made Up Fund" });
    expect(await updateFund(m, CASEY, ONE, { currency: "USD" })).toMatchObject({
      error: "bad_arguments",
    });
    await setTradeState(m, CASEY, one.trade!.id, true);
    const set = await updateFund(m, CASEY, ONE, { currency: "USD" });
    expect(set).toMatchObject({ fund: { currency: "USD" } });
  });

  test("a new currency drops the prices in the old one", async () => {
    const { m, db } = await setup();
    const one = await fund(m, { isin: ONE, name: "Made Up Fund" });
    await updateFund(m, CASEY, ONE, { price: 6, date: "2026-03-03" });
    await setTradeState(m, CASEY, one.trade!.id, true);
    await updateFund(m, CASEY, ONE, { currency: "USD" });
    expect(prices(db)).toEqual([]);
    // a price sent with the new currency is kept
    await updateFund(m, CASEY, ONE, {
      currency: "EUR",
      price: 7,
      date: "2026-03-04",
    });
    expect(prices(db)).toEqual([["2026-03-04", 7, null]]);
  });

  test("a later buy naming another name beside the ISIN is refused", async () => {
    const { m } = await setup();
    await fund(m, { isin: ONE, name: "Made Up Fund" });
    const r = await addFundTrade(m, CASEY, {
      isin: ONE,
      name: "Made Up Different Fund",
      market: null,
      trade: fundTrade({ date: "2026-04-01" }),
    });
    expect(r).toMatchObject({ error: "bad_arguments" });
    // the same name in another case is the fund's own
    await fund(m, { isin: ONE, name: "MADE UP FUND" }, { date: "2026-04-05" });
    expect((await fundRow(m)).quantity).toBe(20);
  });

  test("a refused first buy makes no fund", async () => {
    const { m, db } = await setup();
    await fund(m, { isin: ONE, name: "Made Up Fund" });
    const r = await addFundTrade(m, CASEY, {
      isin: TWO,
      name: "Made Up Fund",
      market: null,
      trade: fundTrade(),
    });
    expect(r).toMatchObject({ error: "conflict" });
    expect(
      db.query("select instrument from funds order by instrument").all(),
    ).toEqual([{ instrument: `fund:${ONE}` }]);
    expect(
      db
        .query("select count(*) as n from instruments where id = ?")
        .get(`fund:${TWO}`),
    ).toEqual({ n: 0 });
  });
});

describe("a fund's trades", () => {
  test("are listed and exported, and an export imports back", async () => {
    const { m, db } = await setup();
    await fund(
      m,
      { isin: ONE, name: "Made Up Fund" },
      { quantity: 3, price: 10 },
    );
    await fund(
      m,
      { isin: ONE },
      { side: "sell", quantity: 1, price: 12, date: "2026-04-01" },
    );
    const listed = readTradeList(m, OPERATOR, {
      portfolio: null,
      broker: null,
      symbol: ONE,
      from: null,
      to: null,
      removed: false,
    });
    if ("error" in listed) throw new Error(listed.message);
    expect(listed.map((t) => [t.symbol, t.side, t.quantity])).toEqual([
      [`fund:${ONE}`, "sell", 1],
      [`fund:${ONE}`, "buy", 3],
    ]);
    const csv = exportCsv(
      m,
      OPERATOR,
      portfolioByName(db, OPERATOR, "Shares")!,
    );
    expect(csv).toContain(`fund:${ONE},`);
    await portfolioBefore(m, "Copy");
    const r = await importCsv(
      m,
      CASEY,
      parseImport({ portfolio: "Copy", csv, confirm: true }),
    );
    if ("error" in r) throw new Error(r.message);
    expect(r.counts.saved).toBe(2);
    const copy = (await holdingsOf(m)).holdings.find(
      (x) => x.kind === "fund" && x.parts.some((p) => p.portfolio === "Copy"),
    )!;
    expect(copy.parts.map((p) => [p.portfolio, p.quantity])).toEqual([
      ["Shares", 2],
      ["Copy", 2],
    ]);
  });

  test("a funds list is refused, as it holds no purchases", async () => {
    const { m } = await setup();
    const csv = [
      "Fund,Currency,Units,Value,Cost Basis,As Of,Note",
      "Made Up Fund,EUR,10,125,100,2026-04-17,",
    ].join("\n");
    await expect(
      importCsv(m, CASEY, parseImport({ portfolio: "Shares", csv })),
    ).rejects.toThrow("funds list is not read");
  });
});

describe("a fund the owner prices", () => {
  test("is never asked of a source, tracked, searched or quoted", async () => {
    const { m, db, asked } = await setup();
    await fund(m, { isin: ONE, name: "Made Up Fund" });
    await updateFund(m, CASEY, ONE, { price: 6, date: "2026-04-01" });
    await holdingsOf(m);
    expect(trackedIds(db, NOW).has(`fund:${ONE}`)).toBe(false);
    const quote = tools(m).find((t) => t.name === "quote")!;
    for (const symbol of [`fund:${ONE}`, `FUND:${ONE}`]) {
      const r = await quote.run({ symbols: [symbol] });
      expect(r.content[0]!.text).toContain("the owner prices");
    }
    expect(asked).toEqual([]);
    // a search asks Yahoo for the words, and never answers the fund
    const search = tools(m).find((t) => t.name === "search")!;
    const found = await search.run({ query: "Made Up Fund" });
    expect(found.content[0]!.text).not.toContain(ONE);
    expect(asked.filter((u) => u.includes(ONE))).toEqual([]);
  });
});

describe("migration 0026-fund-trades", () => {
  test("drops fund positions and leaves every other as it was", () => {
    const db = new Database(":memory:", { strict: true });
    db.exec("pragma foreign_keys = on");
    const clock = fakeClock();
    const at = MIGRATIONS.findIndex((x) => x.id === "0026-fund-trades");
    migrate(db, clock, MIGRATIONS.slice(0, at));
    db.exec(`
      insert into portfolios (name, created_at) values ('Shares', 1);
      insert into brokers (name, created_at) values ('North', 1);
      insert into instruments (id, market, symbol, source, source_symbol,
        exchange, type, zone, added_at, updated_at, unit)
        values ('BVB:BND', 'BVB', 'BND', 'bvb', 'BND', 'BVB', 'BOND', 'UTC',
          0, 0, 'percent_of_par');
    `);
    const add = db.query(
      `insert into positions (portfolio, kind, name, currency, instrument,
         amount, units, price, cost, coupon, maturity, as_of, broker,
         dry_powder, replaces, note, entered_by, entered_at, removed_at,
         removed_by, market)
       values (1, ?, ?, 'EUR', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'casey', ?,
         ?, ?, ?)`,
    );
    add.run(
      "cash",
      "Kept",
      null,
      100,
      null,
      null,
      null,
      null,
      null,
      "2026-01-02",
      1,
      1,
      null,
      "aside",
      10,
      20,
      "casey",
      "US",
    );
    add.run(
      "cash",
      "Kept",
      null,
      150,
      null,
      null,
      null,
      null,
      null,
      "2026-02-08",
      1,
      1,
      1,
      null,
      20,
      null,
      null,
      "US",
    );
    add.run(
      "manual",
      "Made Up Fund",
      null,
      null,
      10,
      5,
      40,
      null,
      null,
      "2026-01-02",
      null,
      0,
      null,
      null,
      30,
      40,
      "casey",
      null,
    );
    add.run(
      "bond",
      "Made Up Bond",
      "BVB:BND",
      1000,
      null,
      null,
      990,
      6,
      "2030-01-02",
      "2025-12-07",
      1,
      0,
      null,
      null,
      40,
      null,
      null,
      null,
    );
    add.run(
      "manual",
      "Made Up Fund",
      null,
      null,
      12,
      5,
      40,
      null,
      null,
      "2026-02-08",
      null,
      0,
      3,
      null,
      50,
      null,
      null,
      "BVB",
    );
    // every column the rebuilt table keeps, so a dropped one fails here
    const columns = `id, portfolio, kind, name, currency, instrument, amount,
      cost, coupon, maturity, as_of, broker, dry_powder, replaces, note,
      entered_by, entered_at, removed_at, removed_by, market`;
    const kept = db
      .query(
        `select ${columns} from positions where kind <> 'manual' order by id`,
      )
      .all();
    expect(kept).toHaveLength(3);
    migrate(db, clock, MIGRATIONS.slice(0, at + 1));
    expect(
      db
        .query("select name from pragma_table_info('positions') order by cid")
        .all()
        .map((c) => (c as { name: string }).name),
    ).toEqual(columns.split(",").map((c) => c.trim()));
    expect(db.query("select * from positions order by id").all()).toEqual(kept);
    expect(db.query("pragma foreign_key_check").all()).toEqual([]);
    expect(() =>
      db.exec(
        `insert into positions (portfolio, kind, name, currency, as_of,
           entered_by, entered_at)
         values (1, 'manual', 'X', 'EUR', '2026-01-02', 'casey', 1)`,
      ),
    ).toThrow("CHECK");
    // ids go on past the dropped funds
    db.exec(
      `insert into positions (portfolio, kind, name, currency, amount,
         as_of, entered_by, entered_at)
       values (1, 'cash', 'More', 'EUR', 1, '2026-03-02', 'casey', 60)`,
    );
    expect(db.query("select max(id) as id from positions").get()).toEqual({
      id: 6,
    });
    expect(
      db
        .query(
          "select name from sqlite_master where type = 'index' and tbl_name = 'positions' order by name",
        )
        .all(),
    ).toEqual([
      { name: "positions_by_instrument" },
      { name: "positions_by_portfolio" },
    ]);
  });
});

describe("a fund's holdings, entered by hand", () => {
  const bulletin = {
    as_of: "2026-09-30",
    top: [
      { name: "Made Up Bond 2030", weight: 4.5 },
      { symbol: "US:AAA", weight: 9.25 },
      { symbol: "us:bbb", name: "Beta, as the report names it", weight: 6 },
    ],
    assets: { stock: 70, bond: 25, cash: 5 },
  };
  const sectors = { technology: 30.5, energy: 12, utilities: 7.5 };

  async function held() {
    const t = await setup();
    instrument(t.db, "US:BBB", { currency: "USD", name: "Beta Made Up" });
    await fund(t.m, { isin: ONE, name: "Made Up Fund" });
    return t;
  }

  const read = async (m: Markets, who: Who = CASEY) =>
    askTool(m, who, "research", {
      symbol: `fund:${ONE}`,
      section: "top_holdings",
    });

  test("read back through research as an ETF's, ranked by weight", async () => {
    const { m, asked } = await held();
    const none = await read(m);
    expect(none.body.message).toBe("no holdings entered for this fund");
    const w = await ask(m, "portfolio_fund", {
      isin: ONE,
      holdings: { ...bulletin, sectors },
    });
    expect(w.error).toBe(false);
    const r = await read(m);
    expect(r.error).toBe(false);
    expect(r.body).toMatchObject({
      id: `fund:${ONE}`,
      name: "Made Up Fund",
      section: "top_holdings",
      source: "owner",
      as_of: "2026-09-30",
      sectors_as_of: "2026-09-30",
      top_weight_percent: 19.75,
      fetched_at: "2026-10-23T18:00:00Z",
      entered_at: "2026-10-23T18:00:00Z",
      assets: {
        stock_percent: 70,
        bond_percent: 25,
        cash_percent: 5,
        other_percent: null,
      },
      bond_ratings: [],
    });
    expect(r.body.top).toEqual([
      {
        rank: 1,
        symbol: "AAA",
        id: "US:AAA",
        name: "Alpha Made Up",
        weight_percent: 9.25,
      },
      {
        rank: 2,
        symbol: "BBB",
        id: "US:BBB",
        name: "Beta, as the report names it",
        weight_percent: 6,
      },
      {
        rank: 3,
        symbol: null,
        id: null,
        name: "Made Up Bond 2030",
        weight_percent: 4.5,
      },
    ]);
    expect(r.body.sectors.map((s: { sector: string }) => s.sector)).toEqual([
      "technology",
      "energy",
      "utilities",
    ]);
    expect(w.body.holdings).toEqual(
      Object.fromEntries(
        Object.entries(r.body).filter(
          ([k]) => !["id", "name", "type", "currency", "section"].includes(k),
        ),
      ),
    );
    expect(asked).toEqual([]);
  });

  test("top and assets are replaced whole; sectors only when given", async () => {
    const { m } = await held();
    await ask(m, "portfolio_fund", {
      isin: ONE,
      holdings: { ...bulletin, as_of: "2026-06-30", sectors },
    });
    // the next bulletin: five rows and a split, no sectors
    await ask(m, "portfolio_fund", {
      isin: ONE,
      holdings: {
        as_of: "2026-07-31",
        top: [{ name: "Made Up Bank", weight: 8 }],
        assets: { stock: 80, cash: 20 },
      },
    });
    let r = (await read(m)).body;
    expect(r.top.map((h: { name: string }) => h.name)).toEqual([
      "Made Up Bank",
    ]);
    expect(r.assets.bond_percent).toBeNull();
    expect([r.as_of, r.sectors_as_of]).toEqual(["2026-07-31", "2026-06-30"]);
    expect(r.sectors).toHaveLength(3);
    // a later report's sectors replace the earlier ones
    await ask(m, "portfolio_fund", {
      isin: ONE,
      holdings: { as_of: "2026-08-31", sectors: { healthcare: 40 } },
    });
    r = (await read(m)).body;
    expect(r.sectors).toEqual([{ sector: "healthcare", weight_percent: 40 }]);
    expect([r.as_of, r.sectors_as_of]).toEqual(["2026-07-31", "2026-08-31"]);
    expect(r.top).toHaveLength(1);
  });

  test("an earlier entry never replaces a later part", async () => {
    const { m, asked } = await held();
    await ask(m, "portfolio_fund", { isin: ONE, holdings: bulletin });
    const late = await ask(m, "portfolio_fund", {
      isin: ONE,
      holdings: { ...bulletin, as_of: "2026-06-30", sectors },
    });
    expect(late.error).toBe(true);
    expect(late.body.error).toBe("conflict");
    expect(late.body.message).toContain("send sectors alone");
    // nothing of the refused entry was kept
    expect((await read(m)).body.sectors).toEqual([]);
    // refused before its unknown symbol is looked up
    const unknown = await ask(m, "portfolio_fund", {
      isin: ONE,
      holdings: {
        as_of: "2026-06-30",
        top: [{ symbol: "ZZZZ", weight: 1 }],
        assets: { stock: 100 },
      },
    });
    expect(unknown.body.error).toBe("conflict");
    expect(asked).toEqual([]);
    const alone = await ask(m, "portfolio_fund", {
      isin: ONE,
      holdings: { as_of: "2026-06-30", sectors },
    });
    expect(alone.error).toBe(false);
    expect((await read(m)).body.as_of).toBe("2026-09-30");
  });

  test("weights, keys and symbols are checked", async () => {
    const { m, asked } = await held();
    const refused = async (holdings: object) => {
      const r = await ask(m, "portfolio_fund", { isin: ONE, holdings });
      expect(r.error).toBe(true);
      return r.body.message as string;
    };
    const day = { as_of: "2026-09-30" };
    expect(
      await refused({ ...day, top: [{ name: "X", weight: 101 }], assets: {} }),
    ).toContain("from above 0 to 100");
    expect(
      await refused({
        ...day,
        top: [
          { name: "X", weight: 60 },
          { name: "Y", weight: 50 },
        ],
        assets: { stock: 100 },
      }),
    ).toContain("sum to more than 100");
    expect(
      await refused({ ...day, top: [{ name: "X", weight: 5 }] }),
    ).toContain("go together");
    expect(await refused({ ...day, sectors: { tech: 10 } })).toContain(
      "not tech",
    );
    expect(
      await refused({
        ...day,
        assets: { gold: 5 },
        top: [{ name: "X", weight: 1 }],
      }),
    ).toContain("not gold");
    expect(await refused({ as_of: "2026-12-31", sectors })).toContain(
      "in the future",
    );
    expect(
      await refused({
        ...day,
        top: [
          { symbol: "US:AAA", weight: 2 },
          { symbol: "us:aaa", weight: 1 },
        ],
        assets: { stock: 100 },
      }),
    ).toContain("US:AAA twice");
    expect(
      await refused({
        ...day,
        top: Array.from({ length: 11 }, (_, k) => ({
          name: `H${k}`,
          weight: 1,
        })),
        assets: { stock: 100 },
      }),
    ).toContain("1 to 10");
    asked.length = 0;
    // an unknown symbol is looked up as any symbol argument is
    const unknown = await ask(m, "portfolio_fund", {
      isin: ONE,
      holdings: {
        ...day,
        top: [{ symbol: "ZZZZ", weight: 1 }],
        assets: { stock: 100 },
      },
    });
    expect(unknown.error).toBe(true);
    expect(unknown.body.message).toContain("holding ZZZZ");
    expect((await read(m)).body.message).toBe(
      "no holdings entered for this fund",
    );
  });

  test("Yahoo's refresh never asks for or overwrites them", async () => {
    const { m, db, asked } = await held();
    await ask(m, "portfolio_fund", { isin: ONE, holdings: bulletin });
    const before = (await read(m)).body;
    const jobs = topHoldingsJobs({
      ctx: { db, clock: m.clock, writer: m.writer, yahoo: m.yahoo },
      log: silent,
    });
    expect((await jobs.tick()).asked).toEqual([]);
    expect(topHoldingsAsked(readInstrument(db, `fund:${ONE}`)!)).toBe(false);
    expect((await read(m)).body).toEqual(before);
    expect(asked).toEqual([]);
  });
});

describe("a fund read by its key", () => {
  const OTHER: Who = { ...CASEY, name: "nobody", user: "nobody" };
  const MARKETS_ONLY: Who = { ...CASEY, portfolio: "none" };

  async function priced() {
    const t = await setup();
    await fund(
      t.m,
      { isin: ONE, name: "Made Up Fund" },
      { date: "2026-08-03" },
    );
    for (const [date, price] of [
      ["2026-08-31", 5.25],
      ["2026-09-28", 5.5],
      ["2026-09-30", 5.75],
      ["2026-10-20", 6],
    ] as const) {
      await updateFund(t.m, CASEY, ONE, { price, date });
    }
    return t;
  }

  const history = (m: Markets, args: object, who: Who = CASEY) =>
    askTool(m, who, "history", { symbol: `fund:${ONE}`, ...args });

  test("history answers its entered prices as closes, never a source", async () => {
    const { m, asked } = await priced();
    const daily = await history(m, { from: "2026-08-01" });
    expect(daily.error).toBe(false);
    expect(daily.body).toMatchObject({
      id: `fund:${ONE}`,
      source: "owner",
      currency: "EUR",
      interval: "1d",
      to: "2026-10-20",
      session: null,
      stale: [],
    });
    expect(
      daily.body.bars.map((b: { date: string; close: number }) => [
        b.date,
        b.close,
      ]),
    ).toEqual([
      ["2026-08-03", 5],
      ["2026-08-31", 5.25],
      ["2026-09-28", 5.5],
      ["2026-09-30", 5.75],
      ["2026-10-20", 6],
    ]);
    expect(daily.body.bars[0]).toMatchObject({
      open: null,
      high: null,
      low: null,
      volume: null,
      final: true,
      signals: null,
    });
    // a week keeps its last price, under its Monday
    const weekly = await history(m, { interval: "1wk", from: "2026-08-01" });
    expect(
      weekly.body.bars.map((b: { date: string; close: number }) => [
        b.date,
        b.close,
      ]),
    ).toEqual([
      ["2026-08-03", 5],
      ["2026-08-31", 5.25],
      ["2026-09-28", 5.75],
      ["2026-10-19", 6],
    ]);
    const intraday = await history(m, { interval: "5m" });
    expect(intraday.body.error).toBe("no_data");
    expect(asked).toEqual([]);
  });

  test("is not found by a person who never held or priced it", async () => {
    const { m } = await priced();
    for (const who of [OTHER, MARKETS_ONLY]) {
      for (const args of [{}, { interval: "5m" }]) {
        const r = await history(m, args, who);
        expect(r.body.error).toBe("not_found");
      }
      const r = await askTool(m, who, "research", {
        symbol: `fund:${ONE}`,
        section: "top_holdings",
      });
      expect(r.body.error).toBe("not_found");
    }
    // the same answer as a fund that is not there
    const missing = await askTool(m, CASEY, "history", {
      symbol: `fund:${TWO}`,
    });
    expect(missing.body.message).toBe(
      (await history(m, {}, OTHER)).body.message,
    );
  });

  test("REST answers its detail and bars", async () => {
    const { m, asked } = await priced();
    await ask(m, "portfolio_fund", {
      isin: ONE,
      holdings: { as_of: "2026-09-30", sectors: { energy: 20 } },
    });
    const call = api(m);
    const get = (path: string, key = ADMIN_KEY) =>
      call(
        new Request(`http://markets.test/api/v1/instruments/${path}`, {
          headers: { authorization: `Bearer ${key}` },
        }),
      );
    const detail = await get(`fund:${ONE}`);
    expect(detail.status).toBe(200);
    const d = await detail.json();
    expect(d).toMatchObject({
      input: `fund:${ONE}`,
      credit: null,
      intraday: false,
      error: null,
      instrument: { id: `fund:${ONE}`, kind: "FUND", price: 6 },
      quote: {
        kind: "hand_price",
        price: 6,
        as_of: "2026-10-20",
        change: null,
        session: null,
      },
      top_holdings: { source: "owner", sectors_as_of: "2026-09-30" },
    });
    const bars = await get(`fund:${ONE}/bars?from=2026-09-01&to=2026-09-30`);
    expect(bars.status).toBe(200);
    expect(bars.headers.get("cache-control")).not.toContain("max-age");
    const b = await bars.json();
    expect(b.instrument.basis).toContain("entered by hand");
    expect(b.bars.map((x: { close: number }) => x.close)).toEqual([5.5, 5.75]);
    // never fetched, so its read never waits on a first fetch
    const stored = (name: string) =>
      call(
        new Request(
          `http://markets.test/api/v1/instruments/fund:${name}/stored`,
          { headers: { cookie: cookieFor(m.db, m.clock.now()) } },
        ),
      ).then((r) => r.json());
    expect((await stored(ONE)).stored).toBe(true);
    expect((await stored(TWO)).stored).toBe(false);
    // the read key opens no portfolio
    expect((await get(`fund:${ONE}`, READ_KEY)).status).toBe(404);
    expect((await get(`fund:${ONE}/bars`, READ_KEY)).status).toBe(404);
    expect(asked).toEqual([]);
  });
});
