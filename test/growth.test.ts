// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// Made-up portfolios only: no real holding, broker, price or amount.

import { describe, expect, test } from "bun:test";
import { spec } from "../src/api/openapi.ts";
import { upsertInstrument } from "../src/market/instruments.ts";
import { OPERATOR } from "../src/operations/who.ts";
import { insertFund, setFundPrice } from "../src/portfolios/funds.ts";
import { growth, yearBefore } from "../src/portfolios/growth.ts";
import {
  ensureCash,
  insertPortfolio,
  insertPosition,
  insertTrade,
  listBrokers,
  listPortfolios,
  type NewPosition,
  type NewTrade,
  setDisplayCurrency,
  setPositionRemoved,
  setTradeRemoved,
} from "../src/portfolios/store.ts";
import { holdings } from "../src/portfolios/value.ts";
import type { Db } from "../src/storage/db/index.ts";
import { ADMIN_KEY, api } from "./helpers/api.ts";
import { answerSchema, validate } from "./helpers/schema.ts";
import { bar, instrument, quote, world } from "./helpers/world.ts";

// the shared clock four years on, so no test date is a real one
const NOW = Date.parse("2030-10-23T18:00:00Z");
const LIVE = "2030-10-23";

const EVERY = 60_000;

function setup(currency = "EUR") {
  const w = world();
  setDisplayCurrency(w.db, OPERATOR, currency, NOW);
  ensureCash(w.db, OPERATOR, NOW);
  const shares = insertPortfolio(w.db, OPERATOR, "Shares", NOW);
  return { ...w, shares };
}

function trade(db: Db, t: Partial<NewTrade> & Pick<NewTrade, "portfolio">) {
  return insertTrade(
    db,
    {
      instrument: "XETRA:AAA",
      side: "buy",
      date: "2030-01-05",
      quantity: 1,
      price: 1,
      fees: 0,
      currency: "EUR",
      statedOn: null,
      broker: null,
      note: null,
      enteredBy: "test",
      ...t,
    },
    NOW,
  );
}

function position(
  db: Db,
  p: Partial<NewPosition> & Pick<NewPosition, "portfolio" | "kind">,
) {
  return insertPosition(
    db,
    {
      name: "Made-up row",
      currency: "EUR",
      instrument: null,
      amount: 1000,
      cost: null,
      coupon: null,
      maturity: null,
      asOf: "2030-01-05",
      broker: null,
      note: null,
      dryPowder: false,
      replaces: null,
      enteredBy: "test",
      ...p,
    },
    NOW,
  );
}

function pair(
  db: Db,
  symbol: string,
  live: number,
  closes: [string, number][],
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
  for (const [date, close] of closes) {
    bar(db, `CCY:${symbol}`, "1d", date, close, true);
  }
  quote(db, `CCY:${symbol}`, live, live);
}

const closes = (db: Db, id: string, list: [string, number][]) => {
  for (const [date, close] of list) bar(db, id, "1d", date, close, true);
};

const scopeOf = (db: Db, portfolio: number | null, currency = "EUR") => ({
  owner: OPERATOR,
  portfolios: listPortfolios(db, OPERATOR),
  brokers: listBrokers(db, OPERATOR),
  portfolio,
  currency,
});

const read = (db: Db, portfolio: number | null, currency = "EUR") =>
  growth(db, scopeOf(db, portfolio, currency), LIVE, NOW, EVERY);

const live = (db: Db, portfolio: number | null, currency = "EUR") =>
  holdings(
    db,
    { ...scopeOf(db, portfolio, currency), broker: null },
    NOW,
    EVERY,
  ).converted!;

const on = (g: ReturnType<typeof read>, date: string) =>
  g.points.find((p) => p.date === date)!;

const days = (from: string, to: string) =>
  (Date.parse(to) - Date.parse(from)) / 86_400_000 + 1;

describe("growth", () => {
  test("counts a split in today's shares and a sell at its amount", () => {
    const { db, shares } = setup();
    instrument(db, "XETRA:AAA", { currency: "EUR" });
    db.query(
      `insert into splits (instrument, date, numerator, denominator, ratio,
         applied_at) values ('XETRA:AAA', '2030-03-02', 2, 1, '2:1', ?)`,
    ).run(NOW);
    // stored closes are split-adjusted, as the bars job writes them
    closes(db, "XETRA:AAA", [
      ["2029-12-01", 25],
      ["2030-03-02", 26],
      ["2030-06-01", 30],
    ]);
    quote(db, "XETRA:AAA", 28, 28);
    trade(db, {
      portfolio: shares,
      date: "2029-12-01",
      quantity: 10,
      price: 50,
      fees: 1,
    });
    trade(db, {
      portfolio: shares,
      side: "sell",
      date: "2030-06-01",
      quantity: 5,
      price: 30,
      fees: 2,
    });
    const g = read(db, shares);
    // younger than a year: drawn from its first day
    expect(g.from).toBe("2029-12-01");
    expect(g.to).toBe(LIVE);
    expect(g.points.length).toBe(days("2029-12-01", LIVE));
    expect(g.points[0]).toEqual({
      date: "2029-12-01",
      value: 500,
      invested: 501,
      gain: -1,
    });
    expect(on(g, "2030-03-01").value).toBe(500);
    expect(on(g, "2030-03-02").value).toBe(520);
    // a sell's amount is what reached the account, fees off
    expect(on(g, "2030-06-01")).toEqual({
      date: "2030-06-01",
      value: 450,
      invested: 353,
      gain: 97,
    });
    expect(g.points.at(-1)).toEqual({
      date: LIVE,
      value: 420,
      invested: 353,
      gain: 67,
    });
    expect(g.missing).toEqual([]);
    expect(g.eased).toEqual([]);
  });

  test("an older view starts a year back with every earlier buy in", () => {
    const { db, shares } = setup();
    instrument(db, "XETRA:AAA", { currency: "EUR" });
    closes(db, "XETRA:AAA", [
      ["2024-05-02", 10],
      ["2029-10-20", 12],
    ]);
    quote(db, "XETRA:AAA", 12, 12);
    trade(db, {
      portfolio: shares,
      date: "2024-05-02",
      quantity: 10,
      price: 10,
    });
    const g = read(db, shares);
    expect(g.from).toBe("2029-10-23");
    expect(g.points.length).toBe(366);
    expect(g.points[0]).toEqual({
      date: "2029-10-23",
      value: 120,
      invested: 100,
      gain: 20,
    });
  });

  test("converts value and money in at each day's own rate", () => {
    const { db, shares } = setup();
    instrument(db, "US:BBB", { currency: "USD" });
    // EURUSD=X: dollars per euro, read inverse for USD to EUR
    pair(db, "EURUSD=X", 1.1, [
      ["2030-02-02", 1.25],
      ["2030-05-04", 1],
    ]);
    closes(db, "US:BBB", [
      ["2030-02-02", 100],
      ["2030-05-04", 100],
    ]);
    quote(db, "US:BBB", 110, 110);
    trade(db, {
      portfolio: shares,
      instrument: "US:BBB",
      currency: "USD",
      date: "2030-02-02",
      quantity: 10,
      price: 100,
    });
    const g = read(db, shares);
    expect(g.points[0]).toEqual({
      date: "2030-02-02",
      value: 800,
      invested: 800,
      gain: 0,
    });
    expect(on(g, "2030-05-04")).toEqual({
      date: "2030-05-04",
      value: 1000,
      invested: 800,
      gain: 200,
    });
    expect(g.points.at(-1)!.value).toBe(1000);
    expect(g.points.at(-1)!.value).toBe(live(db, shares).invested!);
  });

  test("names a holding with no close and counts it 0 until one", () => {
    const { db, shares } = setup();
    instrument(db, "XETRA:AAA", { currency: "EUR" });
    instrument(db, "XETRA:DDD", { currency: "EUR" });
    closes(db, "XETRA:AAA", [["2030-01-05", 10]]);
    closes(db, "XETRA:DDD", [["2030-01-20", 5]]);
    quote(db, "XETRA:AAA", 10, 10);
    quote(db, "XETRA:DDD", 5, 5);
    trade(db, { portfolio: shares, quantity: 10, price: 10 });
    trade(db, {
      portfolio: shares,
      instrument: "XETRA:DDD",
      quantity: 10,
      price: 5,
    });
    const g = read(db, shares);
    expect(g.missing).toEqual(["XETRA:DDD"]);
    expect(on(g, "2030-01-19").value).toBe(100);
    expect(on(g, "2030-01-20").value).toBe(150);
  });

  test("names a pair with no close", () => {
    const { db, shares } = setup();
    instrument(db, "US:BBB", { currency: "USD" });
    closes(db, "US:BBB", [["2030-02-02", 100]]);
    quote(db, "US:BBB", 100, 100);
    trade(db, {
      portfolio: shares,
      instrument: "US:BBB",
      currency: "USD",
      date: "2030-02-02",
      quantity: 1,
      price: 100,
    });
    const g = read(db, shares);
    expect(g.missing).toEqual(["CCY:USDEUR=X"]);
    expect(on(g, "2030-03-02")).toEqual({
      date: "2030-03-02",
      value: 0,
      invested: 0,
      gain: 0,
    });
  });

  test("eases a fund the owner prices between its prices", () => {
    const { db, shares } = setup();
    const f = insertFund(
      db,
      {
        isin: "XS0000000001",
        name: "Made-up Fund",
        currency: "EUR",
        market: null,
      },
      "test",
      NOW,
    );
    trade(db, {
      portfolio: shares,
      instrument: f.id,
      date: "2030-01-05",
      quantity: 10,
      price: 100,
    });
    const by = { name: "test", user: OPERATOR };
    setFundPrice(db, f.id, "2030-01-05", 100, by, NOW);
    setFundPrice(db, f.id, "2030-01-15", 120, by, NOW);
    const g = read(db, shares);
    expect(g.eased).toEqual([f.id]);
    expect(on(g, "2030-01-05").value).toBe(1000);
    expect(on(g, "2030-01-10").value).toBe(1100);
    expect(on(g, "2030-01-15").value).toBe(1200);
    expect(on(g, "2030-04-01").value).toBe(1200);
    expect(g.points.at(-1)!.value).toBe(live(db, shares).invested!);
  });

  test("dates a bond from the first row of its chain", () => {
    const { db, shares } = setup();
    const first = position(db, {
      portfolio: shares,
      kind: "bond",
      asOf: "2030-02-02",
      amount: 1000,
      cost: 980,
    });
    setPositionRemoved(db, OPERATOR, first, "test", NOW);
    position(db, {
      portfolio: shares,
      kind: "bond",
      asOf: "2030-07-01",
      amount: 1000,
      cost: 980,
      note: "edited",
      replaces: first,
    });
    const g = read(db, shares);
    expect(g.from).toBe("2030-02-02");
    expect(g.points[0]).toEqual({
      date: "2030-02-02",
      value: 1000,
      invested: 980,
      gain: 20,
    });
    expect(on(g, "2030-07-01").invested).toBe(980);
    expect(g.points.at(-1)).toEqual({
      date: LIVE,
      value: 1000,
      invested: 980,
      gain: 20,
    });
  });

  test("moves a listed bond with its closes from today's live value", () => {
    const { db, shares } = setup();
    instrument(db, "BVB:BND", { currency: "EUR", unit: "percent_of_par" });
    closes(db, "BVB:BND", [
      ["2030-03-02", 98],
      ["2030-06-01", 100],
    ]);
    quote(db, "BVB:BND", 102, 102);
    position(db, {
      portfolio: shares,
      kind: "bond",
      instrument: "BVB:BND",
      asOf: "2030-03-02",
      amount: 1000,
      cost: 990,
    });
    const g = read(db, shares);
    expect(on(g, "2030-03-02").value).toBe(999.6);
    expect(on(g, "2030-06-01").value).toBe(1020);
    expect(g.points.at(-1)!.value).toBe(1020);
    expect(g.points.at(-1)!.value).toBe(live(db, shares).invested!);
  });

  test("leaves cash and reserve out; Cash and an empty view draw nothing", () => {
    const { db, shares } = setup();
    const cash = listPortfolios(db, OPERATOR).find((p) => p.cash)!.id;
    position(db, { portfolio: cash, kind: "cash", amount: 5000 });
    position(db, {
      portfolio: cash,
      kind: "cash",
      name: "Ready",
      amount: 700,
      dryPowder: true,
    });
    instrument(db, "XETRA:AAA", { currency: "EUR" });
    closes(db, "XETRA:AAA", [["2030-01-05", 10]]);
    quote(db, "XETRA:AAA", 10, 10);
    trade(db, { portfolio: shares, quantity: 10, price: 10 });
    const all = read(db, null);
    expect(all.points.every((p) => p.value === 100)).toBe(true);
    expect(all.points.at(-1)!.value).toBe(live(db, null).invested!);
    expect(read(db, cash)).toEqual({
      currency: "EUR",
      from: LIVE,
      to: LIVE,
      points: [],
      eased: [],
      missing: [],
    });
    const empty = insertPortfolio(db, OPERATOR, "Empty", NOW);
    expect(read(db, empty).points).toEqual([]);
    // bought today: one day held is no line
    const fresh = insertPortfolio(db, OPERATOR, "Fresh", NOW);
    trade(db, { portfolio: fresh, date: LIVE, quantity: 1, price: 10 });
    expect(read(db, fresh).points).toEqual([]);
  });

  test("keeps a stretch held nothing after a sell out, until a rebuy", () => {
    const { db, shares } = setup();
    instrument(db, "XETRA:AAA", { currency: "EUR" });
    closes(db, "XETRA:AAA", [
      ["2030-01-05", 10],
      ["2030-03-02", 12],
      ["2030-05-04", 11],
    ]);
    quote(db, "XETRA:AAA", 11, 11);
    trade(db, { portfolio: shares, quantity: 10, price: 10 });
    trade(db, {
      portfolio: shares,
      side: "sell",
      date: "2030-03-02",
      quantity: 10,
      price: 12,
    });
    trade(db, {
      portfolio: shares,
      date: "2030-05-04",
      quantity: 10,
      price: 11,
    });
    const g = read(db, shares);
    expect(g.from).toBe("2030-01-05");
    expect(g.points.length).toBe(days("2030-01-05", LIVE));
    expect(on(g, "2030-04-01")).toEqual({
      date: "2030-04-01",
      value: 0,
      invested: -20,
      gain: 20,
    });
    expect(on(g, "2030-05-04")).toEqual({
      date: "2030-05-04",
      value: 110,
      invested: 90,
      gain: 20,
    });
  });

  test("starts on a rebuy when the view held nothing before it in the year", () => {
    const { db, shares } = setup();
    instrument(db, "XETRA:AAA", { currency: "EUR" });
    closes(db, "XETRA:AAA", [
      ["2023-03-01", 10],
      ["2023-06-01", 15],
      ["2030-09-23", 20],
    ]);
    quote(db, "XETRA:AAA", 20, 20);
    trade(db, {
      portfolio: shares,
      date: "2023-03-01",
      quantity: 10,
      price: 10,
    });
    trade(db, {
      portfolio: shares,
      side: "sell",
      date: "2023-06-01",
      quantity: 10,
      price: 15,
    });
    trade(db, {
      portfolio: shares,
      date: "2030-09-23",
      quantity: 10,
      price: 20,
    });
    const g = read(db, shares);
    expect(g.from).toBe("2030-09-23");
    expect(g.points.length).toBe(days("2030-09-23", LIVE));
    expect(g.points[0]).toEqual({
      date: "2030-09-23",
      value: 200,
      invested: 150,
      gain: 50,
    });
  });

  test("counts a trade dated past today only in today's point", () => {
    const { db, shares } = setup();
    instrument(db, "XETRA:AAA", { currency: "EUR" });
    closes(db, "XETRA:AAA", [["2030-01-05", 10]]);
    quote(db, "XETRA:AAA", 10, 10);
    trade(db, { portfolio: shares, quantity: 10, price: 10 });
    trade(db, {
      portfolio: shares,
      date: "2030-10-24",
      quantity: 5,
      price: 10,
    });
    const g = read(db, shares);
    expect(on(g, "2030-10-22")).toEqual({
      date: "2030-10-22",
      value: 100,
      invested: 100,
      gain: 0,
    });
    expect(g.points.at(-1)).toEqual({
      date: LIVE,
      value: 150,
      invested: 150,
      gain: 0,
    });
    expect(g.points.at(-1)!.value).toBe(live(db, shares).invested!);
  });

  test("leaves out a holding never priced, naming it", () => {
    const { db, shares } = setup();
    instrument(db, "XETRA:AAA", { currency: "EUR" });
    closes(db, "XETRA:AAA", [["2030-01-05", 10]]);
    quote(db, "XETRA:AAA", 10, 10);
    trade(db, { portfolio: shares, quantity: 10, price: 10 });
    const f = insertFund(
      db,
      {
        isin: "XS0000000001",
        name: "Made-up Fund",
        currency: "EUR",
        market: null,
      },
      "test",
      NOW,
    );
    trade(db, {
      portfolio: shares,
      instrument: f.id,
      quantity: 10,
      price: 100,
    });
    // a live quote but no daily close stored yet
    instrument(db, "XETRA:EEE", { currency: "EUR" });
    quote(db, "XETRA:EEE", 50, 50);
    trade(db, {
      portfolio: shares,
      instrument: "XETRA:EEE",
      date: "2030-02-02",
      quantity: 2,
      price: 50,
    });
    const g = read(db, shares);
    expect(g.missing).toEqual([f.id, "XETRA:EEE"].sort());
    expect(g.eased).toEqual([]);
    expect(g.points.every((p) => p.value === 100 && p.invested === 100)).toBe(
      true,
    );
  });

  test("puts a bond with no cost in at its face", () => {
    const { db, shares } = setup();
    position(db, {
      portfolio: shares,
      kind: "bond",
      asOf: "2030-02-02",
      amount: 1000,
      cost: null,
    });
    const g = read(db, shares);
    expect(g.points[0]).toEqual({
      date: "2030-02-02",
      value: 1000,
      invested: 1000,
      gain: 0,
    });
  });

  test("ignores a removed trade", () => {
    const { db, shares } = setup();
    instrument(db, "XETRA:AAA", { currency: "EUR" });
    closes(db, "XETRA:AAA", [["2030-01-05", 10]]);
    quote(db, "XETRA:AAA", 10, 10);
    trade(db, { portfolio: shares, quantity: 10, price: 10 });
    const gone = trade(db, {
      portfolio: shares,
      date: "2030-02-02",
      quantity: 5,
      price: 10,
    });
    setTradeRemoved(db, OPERATOR, gone, "test", NOW);
    const g = read(db, shares);
    expect(on(g, "2030-03-02")).toEqual({
      date: "2030-03-02",
      value: 100,
      invested: 100,
      gain: 0,
    });
    expect(g.points.at(-1)!.value).toBe(100);
  });

  test("a year before 29 Feb is 28 Feb", () => {
    expect(yearBefore("2032-02-29")).toBe("2031-02-28");
    expect(yearBefore("2031-02-28")).toBe("2030-02-28");
    expect(yearBefore("2030-11-03")).toBe("2029-11-03");
  });
});

describe("growth routes", () => {
  test("answer as the spec says, refuse an unknown portfolio and argument", async () => {
    const { db, m, shares } = setup();
    instrument(db, "XETRA:AAA", { currency: "EUR" });
    // the routes read the shared world clock, not this file's
    closes(db, "XETRA:AAA", [["2026-01-07", 10]]);
    quote(db, "XETRA:AAA", 12, 12);
    trade(db, {
      portfolio: shares,
      quantity: 10,
      price: 10,
      date: "2026-01-07",
    });
    const handle = api(m);
    const get = (path: string) =>
      handle(
        new Request(`http://markets.test/api/v1${path}`, {
          headers: { authorization: `Bearer ${ADMIN_KEY}` },
        }),
      );
    const one = await get(`/portfolios/${shares}/growth`);
    expect(one.status).toBe(200);
    const body = await one.json();
    expect(
      validate(
        body,
        answerSchema(spec, "GET", "/portfolios/{id}/growth", 200)!,
        spec,
      ),
    ).toEqual([]);
    expect(body.points.at(-1).value).toBe(120);
    const h = await (await get(`/portfolios/${shares}/holdings`)).json();
    expect(body.points.at(-1).value).toBe(h.converted.invested);
    const all = await (await get("/holdings/growth?currency=EUR")).json();
    expect(all.points.length).toBe(body.points.length);
    expect((await get("/portfolios/999/growth")).status).toBe(404);
    expect((await get(`/portfolios/${shares}/growth?broker=x`)).status).toBe(
      400,
    );
    expect((await get("/holdings/growth?from=2030-01-01")).status).toBe(400);
  });

  test("refuses a read with no currency named or set", async () => {
    const { db, m } = setup();
    setDisplayCurrency(db, OPERATOR, null, NOW);
    const res = await api(m)(
      new Request("http://markets.test/api/v1/holdings/growth", {
        headers: { authorization: `Bearer ${ADMIN_KEY}` },
      }),
    );
    expect(res.status).toBe(400);
  });
});
