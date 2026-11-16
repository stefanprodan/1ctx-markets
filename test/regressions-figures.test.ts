// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// Made-up portfolios only: no real holding, broker, price or amount.

import { expect, test } from "bun:test";
import { OPERATOR } from "../src/operations/who.ts";
import { insertFund, setFundPrice } from "../src/portfolios/funds.ts";
import {
  insertPortfolio,
  insertPosition,
  insertTrade,
  listBrokers,
  listPortfolios,
  type NewPosition,
  setDisplayCurrency,
} from "../src/portfolios/store.ts";
import { holdings } from "../src/portfolios/value.ts";
import { notification } from "../src/push/text.ts";
import type { Db } from "../src/storage/db/index.ts";
import { ADMIN_KEY, api } from "./helpers/api.ts";
import { instrument, NOW, quote, world } from "./helpers/world.ts";

const EVERY = 60_000;

function setup() {
  const w = world();
  setDisplayCurrency(w.db, OPERATOR, "EUR", NOW);
  const shares = insertPortfolio(w.db, OPERATOR, "Shares", NOW);
  instrument(w.db, "XETRA:AAA", { currency: "EUR" });
  quote(w.db, "XETRA:AAA", 12, 10);
  buy(w.db, shares, "XETRA:AAA", 10, 10);
  return { ...w, shares };
}

function buy(
  db: Db,
  portfolio: number,
  id: string,
  quantity: number,
  price: number,
) {
  insertTrade(
    db,
    {
      portfolio,
      instrument: id,
      side: "buy",
      date: "2026-01-05",
      quantity,
      price,
      fees: 0,
      currency: "EUR",
      statedOn: null,
      broker: null,
      note: null,
      enteredBy: "test",
    },
    NOW,
  );
}

function position(db: Db, p: Pick<NewPosition, "portfolio" | "kind">) {
  insertPosition(
    db,
    {
      name: "Made-up row",
      currency: "EUR",
      instrument: null,
      amount: 1000,
      cost: null,
      coupon: null,
      maturity: null,
      asOf: "2026-01-05",
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

const read = (db: Db, portfolio: number) =>
  holdings(
    db,
    {
      owner: OPERATOR,
      portfolios: listPortfolios(db, OPERATOR),
      brokers: listBrokers(db, OPERATOR),
      portfolio,
      broker: null,
      currency: "EUR",
    },
    NOW,
    EVERY,
  );

test("a total's day change counts cash, a face-valued bond and an owner-priced fund as no move", () => {
  const { db, shares } = setup();
  position(db, { portfolio: shares, kind: "cash" });
  position(db, { portfolio: shares, kind: "bond" });
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
  buy(db, shares, f.id, 5, 100);
  setFundPrice(
    db,
    f.id,
    "2026-01-05",
    100,
    { name: "test", user: OPERATOR },
    NOW,
  );
  const h = read(db, shares);
  expect(h.totals[0]!.day_change).toBe(20);
  expect(h.converted!.day_change).toBe(20);
});

test("a total's day change is missing when a quoted holding's is, its value still summed", async () => {
  const { db, m, shares } = setup();
  instrument(db, "XETRA:BBB", { currency: "EUR" });
  quote(db, "XETRA:BBB", 50, 50);
  db.query(
    `update quotes set previous_close = null, previous_close_field = null,
       change = null, change_percent = null
     where instrument = 'XETRA:BBB'`,
  ).run();
  buy(db, shares, "XETRA:BBB", 2, 40);
  const h = read(db, shares);
  expect(h.totals[0]).toMatchObject({
    value: 220,
    day_change: null,
    missing: [],
  });
  expect(h.converted).toMatchObject({
    value: 220,
    day_change: null,
    missing: [],
  });
  const res = await api(m)(
    new Request(`http://markets.test/api/v1/portfolios/${shares}/holdings`, {
      headers: { authorization: `Bearer ${ADMIN_KEY}` },
    }),
  );
  const body = await res.json();
  expect(body.totals[0].day_change).toBeNull();
  expect(body.converted.day_change).toBeNull();
});

test("a pushed price has its currency's decimals", () => {
  const push = (currency: string, price: number) =>
    notification(
      { symbol: "XX:AAA", when: "price < 2000", note: null, values: { price } },
      {
        "XX:AAA": { name: null, type: "EQUITY", currency, unit: "price" },
      },
    ).body;
  expect(push("JPY", 1234)).toBe("AAA fell below 2,000 JPY: 1,234 JPY");
  expect(push("KWD", 1234.5)).toBe("AAA fell below 2,000.00 KWD: 1,234.50 KWD");
  expect(push("USD", 1234.5)).toBe("AAA fell below 2,000.00 USD: 1,234.50 USD");
});
