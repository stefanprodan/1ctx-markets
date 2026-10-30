// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// Made-up files only: no real holding, broker or amount.

import { describe, expect, test } from "bun:test";
import { upsertInstrument } from "../src/market/instruments.ts";
import {
  createBroker,
  readTradeList,
  type Who,
} from "../src/operations/portfolio.ts";
import {
  exportCsv,
  importCsv,
  parseImport,
} from "../src/operations/portfolio-import.ts";
import { parseCsv, parseDay, parseNumber } from "../src/portfolios/csv.ts";
import { portfolioByName, readPositions } from "../src/portfolios/store.ts";
import { portfolioBefore } from "./helpers/portfolio.ts";
import { instrument, NOW, quote, world } from "./helpers/world.ts";

const CASEY: Who = { name: "casey-agent", access: "write" };

const HEADER =
  "Symbol,Current Price,Date,Time,Change,Open,High,Low,Volume,Trade Date,Purchase Price,Quantity,Commission,High Limit,Low Limit,Comment,Transaction Type";

// every column Yahoo writes, a watched row, a bad row and a quoted comment
const YAHOO = [
  HEADER,
  "US:AAA,120,2026/10/23,16:00 EDT,2,118,121,117,1000,20260105,100.5,10,1.5,,,[broker North] first buy,Buy",
  'US:AAA,120,2026/10/23,16:00 EDT,2,118,121,117,1000,20260302,130,4,1,,,"[broker North] a note, with a comma",Sell',
  "XETRA:BBB,50,2026/10/23,17:30 CEST,0,50,51,49,500,,,,,,,,",
  "US:AAA,120,2026/10/23,16:00 EDT,2,118,121,117,1000,20261301,99,1,0,,,,Buy",
].join("\r\n");

async function setup() {
  const w = world();
  instrument(w.db, "US:AAA", { currency: "USD", name: "Alpha Made Up" });
  instrument(w.db, "XETRA:BBB", { currency: "EUR", name: "Beta Made Up" });
  quote(w.db, "US:AAA", 120, 118);
  await portfolioBefore(w.m, "Shares");
  await portfolioBefore(w.m, "Copy");
  await createBroker(w.m, { name: "North" });
  return w;
}

const all = {
  portfolio: null,
  broker: null,
  symbol: null,
  from: null,
  to: null,
  removed: false,
};

describe("the csv reader", () => {
  test("reads quotes, doubled quotes, CRLF and a BOM", () => {
    expect(parseCsv('﻿a,"b ""c"", d"\r\n1,2\n')).toEqual([
      ["a", 'b "c", d'],
      ["1", "2"],
    ]);
  });

  test("takes plain numbers and day-first or ISO dates, never a slash", () => {
    expect(parseNumber("1,234.5")).toBe(1234.5);
    expect(parseNumber("12,5")).toBe("bad");
    expect(parseNumber("")).toBeNull();
    expect(parseDay("20260105")).toBe("2026-01-05");
    expect(parseDay("5.1.2026")).toBe("2026-01-05");
    expect(parseDay("01/05/2026")).toBe("bad");
    expect(parseDay("2026-02-30")).toBe("bad");
  });
});

describe("the Yahoo import", () => {
  test("previews every column, refuses a bad row and saves nothing", async () => {
    const { m } = await setup();
    const preview = await importCsv(
      m,
      CASEY,
      parseImport({ portfolio: "Shares", csv: YAHOO }),
    );
    if ("error" in preview) throw new Error(preview.message);
    expect(preview.kind).toBe("trades");
    expect(preview.saved).toBe(false);
    expect(preview.counts).toEqual({ ok: 2, bad: 1, skipped: 1, saved: 0 });
    expect(preview.rows.map((r) => [r.line, r.status, r.reason])).toEqual([
      [2, "ok", undefined],
      [3, "ok", undefined],
      [4, "skipped", "no trade, a watched symbol"],
      [5, "bad", "trade date is not a date"],
    ]);
    expect(preview.rows[0]!.item).toEqual({
      symbol: "US:AAA",
      input: "US:AAA",
      side: "buy",
      date: "2026-01-05",
      quantity: 10,
      price: 100.5,
      fees: 1.5,
      currency: "USD",
      broker: "North",
      note: "first buy",
    });
    // Comment's tags name the broker, the note after them
    expect(preview.rows[1]!.item).toMatchObject({
      side: "sell",
      broker: "North",
      note: "a note, with a comma",
    });
    expect(readTradeList(m, all)).toEqual([]);
    const saved = await importCsv(
      m,
      CASEY,
      parseImport({ portfolio: "Shares", csv: YAHOO, confirm: true }),
    );
    if ("error" in saved) throw new Error(saved.message);
    expect(saved.counts).toEqual({ ok: 0, bad: 1, skipped: 1, saved: 2 });
    expect(readTradeList(m, all)).toHaveLength(2);
    // the same file again finds its trades already saved
    const again = await importCsv(
      m,
      CASEY,
      parseImport({ portfolio: "Shares", csv: YAHOO }),
    );
    if ("error" in again) throw new Error(again.message);
    expect(again.counts.ok).toBe(0);
  });

  test("a broker for the whole file names every trade", async () => {
    const { m } = await setup();
    const r = await importCsv(
      m,
      CASEY,
      parseImport({ portfolio: "Shares", csv: YAHOO, broker: "north" }),
    );
    if ("error" in r) throw new Error(r.message);
    expect(r.broker).toBe("North");
    expect(r.rows[0]!.item).toMatchObject({ broker: "North" });
  });

  test("export then import gives the same trades", async () => {
    const { m, db } = await setup();
    await importCsv(
      m,
      CASEY,
      parseImport({ portfolio: "Shares", csv: YAHOO, confirm: true }),
    );
    const csv = exportCsv(m, portfolioByName(db, "Shares")!);
    expect(csv.split("\r\n")[0]).toBe(HEADER);
    await importCsv(
      m,
      CASEY,
      parseImport({ portfolio: "Copy", csv, confirm: true }),
    );
    const strip = (portfolio: string) =>
      (readTradeList(m, { ...all, portfolio }) as Record<string, unknown>[])
        .map(
          ({
            id: _,
            portfolio: __,
            portfolio_id: ___,
            entered_at: ____,
            ...t
          }) => t,
        )
        .reverse();
    expect(strip("Copy")).toEqual(strip("Shares"));
  });

  test("a trade paid in another currency keeps it through Comment", async () => {
    const { m, db } = await setup();
    upsertInstrument(
      db,
      {
        market: "CCY",
        symbol: "EURUSD=X",
        source: "yahoo",
        sourceSymbol: "EURUSD=X",
        exchange: "CCY",
        name: "EURUSD=X",
        type: "CURRENCY",
        currency: "USD",
        unit: "per_unit",
        zone: "UTC",
      },
      NOW,
    );
    const csv = [
      HEADER,
      "US:AAA,,,,,,,,,20260105,90,1,0,,,[broker North][paid EUR],Buy",
    ].join("\n");
    await importCsv(
      m,
      CASEY,
      parseImport({ portfolio: "Shares", csv, confirm: true }),
    );
    const [t] = readTradeList(m, all) as { currency: string }[];
    expect(t!.currency).toBe("EUR");
    expect(exportCsv(m, portfolioByName(db, "Shares")!)).toContain(
      "[broker North][paid EUR]",
    );
  });
});

describe("an import's currencies", () => {
  test("each must be in circulation, or a listing's hundredth", async () => {
    const { m } = await setup();
    expect(() =>
      parseImport({ portfolio: "Shares", csv: HEADER, currency: "ABC" }),
    ).toThrow("in circulation");
    const files = [
      [
        HEADER,
        "US:AAA,,,,,,,,,20260105,90,1,0,,,[paid ABC],Buy",
        "US:AAA,,,,,,,,,20260105,90,1,0,,,[paid GBp],Buy",
      ],
      ["Item,Amount (ABC),As Of,Note", "Account,10,2026-04-17,"],
      [
        "Fund,Currency,Units,Value,Cost Basis,As Of,Note",
        "Made Up Fund,ABC,10,125,100,2026-04-17,",
        "Made Up Fund,eur,10,125,100,2026-04-17,",
      ],
      [
        "Item,Symbol,Currency,Amount,Rate (%),Purchase Date,Maturity,Note",
        "Made Up Bond,,ABC,1000,5.5,2026-01-02,2030-01-02,",
      ],
    ];
    const statuses = [];
    for (const lines of files) {
      const r = await importCsv(
        m,
        CASEY,
        parseImport({ portfolio: "Shares", csv: lines.join("\n") }),
      );
      if ("error" in r) throw new Error(r.message);
      statuses.push(r.rows.map((row) => row.status));
    }
    expect(statuses).toEqual([["bad", "ok"], ["bad"], ["bad", "ok"], ["bad"]]);
  });
});

describe("position imports", () => {
  test("cash takes its header's currency and dry powder only where picked", async () => {
    const { m, db } = await setup();
    const csv = [
      "Item,Amount (EUR),As Of,Note",
      "Kept for buying,1500,2026-04-17,",
      "Current account,250.5,17.4.2026,day to day",
      ",10,2026-04-17,",
    ].join("\n");
    const preview = await importCsv(
      m,
      CASEY,
      parseImport({ portfolio: "Shares", csv, dry_powder: [2] }),
    );
    if ("error" in preview) throw new Error(preview.message);
    expect(preview.kind).toBe("cash");
    expect(preview.rows.map((r) => r.status)).toEqual(["ok", "ok", "bad"]);
    expect(preview.rows[0]!.item).toMatchObject({
      currency: "EUR",
      amount: 1500,
      dry_powder: true,
    });
    expect(preview.rows[1]!.item).toMatchObject({ dry_powder: false });
    await importCsv(
      m,
      CASEY,
      parseImport({ portfolio: "Shares", csv, dry_powder: [2], confirm: true }),
    );
    expect(readPositions(db).map((p) => [p.name, p.dryPowder, p.asOf])).toEqual(
      [
        ["Current account", false, "2026-04-17"],
        ["Kept for buying", true, "2026-04-17"],
      ],
    );
  });

  test("funds are priced by hand and bonds at face without a listing", async () => {
    const { m, db } = await setup();
    const funds = [
      "Fund,Currency,Units,Value,Cost Basis,As Of,Note",
      "Made Up Fund,EUR,10,125,100,2026-04-17,",
    ].join("\n");
    const bonds = [
      "Item,Symbol,Currency,Amount,Rate (%),Purchase Date,Maturity,Note",
      "Made Up Bond,,EUR,1000,5.5,2026-01-02,2030-01-02,",
    ].join("\n");
    for (const csv of [funds, bonds]) {
      const r = await importCsv(
        m,
        CASEY,
        parseImport({ portfolio: "Shares", csv, confirm: true }),
      );
      if ("error" in r) throw new Error(r.message);
      expect(r.counts.saved).toBe(1);
    }
    const [bond, fund] = readPositions(db);
    expect(fund).toMatchObject({ kind: "manual", units: 10, price: 12.5 });
    expect(bond).toMatchObject({
      kind: "bond",
      amount: 1000,
      coupon: 5.5,
      maturity: "2030-01-02",
    });
  });
});
