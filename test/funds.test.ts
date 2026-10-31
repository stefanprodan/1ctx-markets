// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// Made-up funds only: fictional names, ISINs built with a valid check
// digit, and invented dates, prices and units.

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { trackedIds } from "../src/market/tracking.ts";
import type { Markets } from "../src/operations/markets.ts";
import { markets } from "../src/operations/markets.ts";
import {
  addFundTrade,
  createBroker,
  type FundTradeArgs,
  type HoldingsAnswer,
  parsePortfolio,
  portfolioAnswer,
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
import type { Who } from "../src/operations/who.ts";
import { fundPrices } from "../src/portfolios/funds.ts";
import { portfolioByName } from "../src/portfolios/store.ts";
import { silent } from "../src/runtime/log.ts";
import { isIsin } from "../src/shared/isin.ts";
import { fred } from "../src/sources/fred/client.ts";
import { yahoo } from "../src/sources/yahoo/client.ts";
import { migrate, open } from "../src/storage/db/index.ts";
import { MIGRATIONS } from "../src/storage/db/migrations/index.ts";
import { writer } from "../src/storage/writer.ts";
import { tools } from "../src/tools/index.ts";
import { fakeClock } from "./helpers/clock.ts";
import { portfolioBefore } from "./helpers/portfolio.ts";
import { instrument, NOW, quote } from "./helpers/world.ts";

const CASEY: Who = { name: "casey-agent", portfolio: "write", rules: "none" };

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
  for (const name of ["North", "South"]) await createBroker(m, { name });
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
  const h = await readHoldings(m, {
    portfolio: null,
    broker: null,
    currency: null,
  });
  if ("error" in h) throw new Error(h.message);
  return h;
}

const fundRow = async (m: Markets) =>
  (await holdingsOf(m)).holdings.find((r) => r.kind === "fund")!;

const ask = async (m: Markets, args: object) => {
  const r = await portfolioAnswer(m, CASEY, parsePortfolio(args));
  return { error: r.isError === true, body: JSON.parse(r.content[0]!.text) };
};

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
      parsePortfolio({
        action: "add",
        kind: "fund",
        isin: "ZZFUND000012",
        name: "Made Up Fund",
        side: "buy",
        units: 1,
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
    const lower = parsePortfolio({
      action: "add",
      kind: "fund",
      isin: ONE.toLowerCase(),
      name: "Made Up Fund",
      side: "buy",
      units: 1,
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
    const list = (await ask(m, { action: "list" })).body.funds;
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
    const r = await ask(m, {
      action: "add",
      kind: "fund",
      portfolio: "Shares",
      isin: ONE,
      name: "Made Up Fund",
      side: "buy",
      units: 3,
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
    await updateFund(m, CASEY, ONE, { price: 1, date: "2026-05-01" });
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
      { total: 70, quantity: 10, price: null, fees: 0, date: "2026-04-02" },
    );
    expect(fundPrices(db, `fund:${ONE}`).map((p) => [p.date, p.price])).toEqual(
      [
        ["2026-04-02", 7],
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
    expect((await ask(m, { action: "list" })).body.markets).toEqual(["US"]);
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
    const listed = readTradeList(m, {
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
    const csv = exportCsv(m, portfolioByName(db, "Shares")!);
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
      "2026-02-02",
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
      "2025-12-01",
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
      "2026-02-02",
      null,
      0,
      3,
      null,
      50,
      null,
      null,
      "BVB",
    );
    const kept = db
      .query("select * from positions where kind <> 'manual' order by id")
      .all();
    expect(kept).toHaveLength(3);
    migrate(db, clock);
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
