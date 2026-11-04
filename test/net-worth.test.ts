// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// Net worth per day: the holdings' value plus every cash account's
// balance. Made-up accounts, names and figures only.

import { describe, expect, test } from "bun:test";
import { PREFIX } from "../src/api/http.ts";
import { spec } from "../src/api/openapi.ts";
import { upsertInstrument } from "../src/market/instruments.ts";
import { addPosition, saveSettings } from "../src/operations/portfolio.ts";
import { OPERATOR, type Who } from "../src/operations/who.ts";
import { netWorth } from "../src/portfolios/net-worth.ts";
import {
  cashPortfolio,
  ensureCash,
  insertPortfolio,
  insertPosition,
  insertTrade,
  listBrokers,
  listPortfolios,
  type NewPosition,
  setDisplayCurrency,
  setPositionRemoved,
} from "../src/portfolios/store.ts";
import type { Db } from "../src/storage/db/index.ts";
import { ADMIN_KEY, api, cookieFor } from "./helpers/api.ts";
import { answerSchema, validate } from "./helpers/schema.ts";
import { bar, instrument, LIVE, NOW, quote, world } from "./helpers/world.ts";

const EVERY = 60_000;
const DAY = 86_400_000;

function setup(currency = "EUR") {
  const w = world();
  setDisplayCurrency(w.db, OPERATOR, currency, NOW);
  ensureCash(w.db, OPERATOR, NOW);
  const cash = cashPortfolio(w.db, OPERATOR)!.id;
  // each row entered a moment after the last, so a tie reads in order
  let entered = 0;
  const add = (p: Partial<NewPosition>) =>
    insertPosition(
      w.db,
      {
        portfolio: cash,
        kind: "cash",
        name: "Made-up account",
        currency: "EUR",
        instrument: null,
        amount: 100,
        cost: null,
        coupon: null,
        maturity: null,
        asOf: LIVE,
        broker: null,
        note: null,
        dryPowder: false,
        replaces: null,
        enteredBy: "test",
        ...p,
      },
      NOW - 30 * DAY + ++entered * 1000,
    );
  return { ...w, cash, add };
}

const read = (db: Db, currency = "EUR", zone = "UTC") =>
  netWorth(
    db,
    {
      owner: OPERATOR,
      portfolios: listPortfolios(db, OPERATOR),
      brokers: listBrokers(db, OPERATOR),
      currency,
      zone,
    },
    LIVE,
    NOW,
    EVERY,
  );

const on = (n: ReturnType<typeof read>, date: string) =>
  n.points.find((p) => p.date === date)!;

const days = (from: string, to: string) =>
  (Date.parse(to) - Date.parse(from)) / DAY + 1;

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

describe("net worth", () => {
  test("counts each account's balance on the day, past balances too", () => {
    const s = setup();
    const a = s.add({ asOf: "2026-10-20", amount: 1000 });
    s.add({ asOf: "2026-10-11", amount: 600, pastOf: a });
    s.add({ asOf: "2026-10-14", amount: 800, pastOf: a });
    s.add({ name: "Second", asOf: "2026-10-12", amount: 50 });
    const n = read(s.db);
    // the first day both accounts have a balance
    expect(n.from).toBe("2026-10-12");
    expect(n.to).toBe(LIVE);
    expect(n.points).toHaveLength(days("2026-10-12", LIVE));
    expect(n.points[0]).toEqual({
      date: "2026-10-12",
      invested: 0,
      cash: 650,
      total: 650,
    });
    expect(on(n, "2026-10-14").cash).toBe(850);
    expect(on(n, "2026-10-19").cash).toBe(850);
    expect(on(n, "2026-10-20").cash).toBe(1050);
    expect(n.points.at(-1)).toEqual({
      date: LIVE,
      invested: 0,
      cash: 1050,
      total: 1050,
    });
    expect(n.missing).toEqual([]);
  });

  test("counts a removed account until the day it was removed, never its start", () => {
    const s = setup();
    s.add({ asOf: "2026-10-01", amount: 1000 });
    const gone = s.add({ name: "Closed", asOf: "2026-10-05", amount: 300 });
    setPositionRemoved(
      s.db,
      OPERATOR,
      gone,
      "test",
      Date.parse("2026-10-18T10:00:00Z"),
    );
    const n = read(s.db);
    expect(n.from).toBe("2026-10-01");
    expect(on(n, "2026-10-04").cash).toBe(1000);
    expect(on(n, "2026-10-05").cash).toBe(1300);
    expect(on(n, "2026-10-17").cash).toBe(1300);
    expect(on(n, "2026-10-18").cash).toBe(1000);
    expect(n.points.at(-1)!.cash).toBe(1000);
    // removed on the owner's day, in the owner's zone
    const east = read(s.db, "EUR", "Pacific/Kiritimati");
    expect(on(east, "2026-10-18").cash).toBe(1300);
    expect(on(east, "2026-10-19").cash).toBe(1000);
  });

  test("converts each day at that day's stored rate", () => {
    const s = setup();
    pair(s.db, "EURUSD=X", 2, [
      ["2026-10-13", 1.25],
      ["2026-10-16", 1],
    ]);
    s.add({ asOf: "2026-10-14", amount: 10 });
    s.add({
      name: "Dollars",
      currency: "USD",
      asOf: "2026-10-14",
      amount: 100,
    });
    const n = read(s.db);
    expect(n.from).toBe("2026-10-14");
    expect(on(n, "2026-10-14").cash).toBe(90);
    expect(on(n, "2026-10-16").cash).toBe(110);
    expect(on(n, "2026-10-22").cash).toBe(110);
    // today at the live rate, as the holdings answer converts it
    expect(n.points.at(-1)!.cash).toBe(60);
    expect(n.missing).toEqual([]);
  });

  test("names a pair with no stored close and counts nothing for it", () => {
    const s = setup();
    s.add({ asOf: "2026-10-20", amount: 10 });
    s.add({ name: "Pounds", currency: "GBP", asOf: "2026-10-20", amount: 50 });
    const n = read(s.db);
    expect(n.missing).toEqual(["CCY:GBPEUR=X"]);
    expect(n.points.map((p) => p.cash)).toEqual([10, 10, 10, 10]);
  });

  test("starts at most a year back", () => {
    const s = setup();
    s.add({ asOf: "2024-01-01", amount: 5 });
    const n = read(s.db);
    expect(n.from).toBe("2025-10-23");
    expect(n.points).toHaveLength(days("2025-10-23", LIVE));
    expect(n.points.every((p) => p.total === 5)).toBe(true);
  });

  test("counts money moved into back-dated accounts once", () => {
    const s = setup();
    const old = s.add({ name: "Combined", asOf: "2026-10-01", amount: 3000 });
    s.add({ name: "Part one", asOf: "2026-10-05", amount: 1000 });
    s.add({ name: "Part two", asOf: "2026-10-05", amount: 2000 });
    const emptied = s.add({
      name: "Combined",
      asOf: "2026-10-20",
      amount: 0,
      replaces: old,
    });
    setPositionRemoved(s.db, OPERATOR, old, "test", NOW - 3 * DAY);
    s.add({ name: "Combined", asOf: "2026-10-05", amount: 0, pastOf: emptied });
    const n = read(s.db);
    expect(n.from).toBe("2026-10-05");
    expect(n.points.every((p) => p.cash === 3000)).toBe(true);
  });

  test("falls back to the growth window with no live cash account", () => {
    const s = setup();
    const shares = insertPortfolio(s.db, OPERATOR, "Shares", NOW);
    instrument(s.db, "XETRA:AAA", { currency: "EUR" });
    bar(s.db, "XETRA:AAA", "1d", "2026-10-09", 10, true);
    quote(s.db, "XETRA:AAA", 12, 12);
    insertTrade(
      s.db,
      {
        portfolio: shares,
        instrument: "XETRA:AAA",
        side: "buy",
        date: "2026-10-09",
        quantity: 10,
        price: 10,
        fees: 0,
        currency: "EUR",
        statedOn: null,
        broker: null,
        note: null,
        enteredBy: "test",
      },
      NOW,
    );
    const n = read(s.db);
    expect(n.from).toBe("2026-10-09");
    expect(n.points[0]).toEqual({
      date: "2026-10-09",
      invested: 100,
      cash: 0,
      total: 100,
    });
    expect(n.points.at(-1)!.total).toBe(120);
    const none = setup();
    expect(read(none.db).points).toEqual([]);
  });
});

describe("the net worth route", () => {
  test("ends on the holdings answer's net worth, cash as dry powder and reserve", async () => {
    const s = setup();
    const shares = insertPortfolio(s.db, OPERATOR, "Shares", NOW);
    instrument(s.db, "XETRA:AAA", { currency: "EUR" });
    bar(s.db, "XETRA:AAA", "1d", "2026-10-01", 10, true);
    bar(s.db, "XETRA:AAA", "1d", "2026-10-14", 11, true);
    quote(s.db, "XETRA:AAA", 12.34, 12);
    insertTrade(
      s.db,
      {
        portfolio: shares,
        instrument: "XETRA:AAA",
        side: "buy",
        date: "2026-10-01",
        quantity: 7,
        price: 10,
        fees: 1,
        currency: "EUR",
        statedOn: null,
        broker: null,
        note: null,
        enteredBy: "test",
      },
      NOW,
    );
    pair(s.db, "EURUSD=X", 1.17, [["2026-10-01", 1.1]]);
    s.add({
      name: "Kept for buying",
      asOf: "2026-10-05",
      amount: 200.1,
      dryPowder: true,
    });
    s.add({
      name: "Rainy day",
      currency: "USD",
      asOf: "2026-10-05",
      amount: 333.33,
    });
    const handle = api(s.m);
    const get = (path: string) =>
      handle(
        new Request(`http://markets.test${PREFIX}${path}`, {
          headers: { authorization: `Bearer ${ADMIN_KEY}` },
        }),
      );
    const res = await get("/holdings/net-worth?currency=EUR");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(
      validate(
        body,
        answerSchema(spec, "GET", "/holdings/net-worth", 200)!,
        spec,
      ),
    ).toEqual([]);
    const h = await (await get("/holdings?currency=EUR")).json();
    const last = body.points.at(-1);
    expect(last.date).toBe(LIVE);
    expect(last.total).toBe(h.converted.net_worth);
    expect(last.cash).toBe(
      Number((h.converted.dry_powder + h.converted.reserve).toFixed(2)),
    );
    expect(last.invested + last.cash).toBeCloseTo(last.total, 6);
    // every day before is the growth's value plus the day's cash
    const g = await (await get("/holdings/growth?currency=EUR")).json();
    const day = body.points.find(
      (p: { date: string }) => p.date === "2026-10-16",
    );
    const grown = g.points.find(
      (p: { date: string }) => p.date === "2026-10-16",
    );
    expect(day.invested).toBe(grown.value);
    expect(day.cash).toBe(Number((200.1 + 333.33 / 1.1).toFixed(2)));
    // the display currency when none is named
    expect(await (await get("/holdings/net-worth")).json()).toEqual(body);
  });

  test("refuses a read with no currency named or set", async () => {
    const s = setup();
    setDisplayCurrency(s.db, OPERATOR, null, NOW);
    const res = await api(s.m)(
      new Request(`http://markets.test${PREFIX}/holdings/net-worth`, {
        headers: { authorization: `Bearer ${ADMIN_KEY}` },
      }),
    );
    expect(res.status).toBe(400);
  });

  test("reads the caller's own portfolios, never ones shared with them", async () => {
    const w = world();
    for (const id of ["ana", "jo"]) {
      w.db
        .query(
          "insert into users (id, name, role, created_at) values (?, ?, 'member', 0)",
        )
        .run(id, id);
    }
    for (const [user, amount] of [
      ["ana", 7000],
      ["jo", 40],
    ] as const) {
      await saveSettings(w.m, user, { display_currency: "EUR" });
      const who: Who = {
        name: user,
        user,
        credential: { kind: "key", id: user },
        portfolio: "write",
        rules: "none",
        profile: "none",
      };
      await addPosition(w.m, who, {
        kind: "cash",
        portfolio: null,
        name: "Spare",
        symbol: null,
        currency: "EUR",
        amount,
        cost: null,
        coupon: null,
        maturity: null,
        date: "2026-10-01",
        broker: null,
        note: null,
        dryPowder: false,
      });
    }
    const handle = api(w.m);
    const send = (user: string, path: string, method = "GET") =>
      handle(
        new Request(`http://markets.test${PREFIX}${path}`, {
          method,
          headers: {
            cookie: cookieFor(w.db, w.clock.now(), user, null),
            "sec-fetch-site": "same-origin",
          },
        }),
      );
    expect((await send("ana", "/sharing/jo", "PUT")).status).toBe(200);
    // the share reads ana's holdings, but net worth stays jo's own
    expect((await send("jo", "/holdings?owner=ana")).status).toBe(200);
    const mine = await (await send("jo", "/holdings/net-worth")).json();
    expect(mine.points.every((p: { total: number }) => p.total === 40)).toBe(
      true,
    );
    expect((await send("jo", "/holdings/net-worth?owner=ana")).status).toBe(
      400,
    );
  });
});
