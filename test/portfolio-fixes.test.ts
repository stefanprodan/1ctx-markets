// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// The money rules a review found loose, each held: made-up data only.

import { describe, expect, test } from "bun:test";
import { upsertInstrument } from "../src/market/instruments.ts";
import { lastReadAt } from "../src/market/tracking.ts";
import type { Markets } from "../src/operations/markets.ts";
import {
  addPosition,
  addTrade,
  createBroker,
  type HoldingsAnswer,
  historyOf,
  latestDay,
  type PositionArgs,
  parsePortfolio,
  portfolioAnswer,
  readHoldings,
  readTradeList,
  setPositionState,
  setTradeState,
  updatePosition,
} from "../src/operations/portfolio.ts";
import {
  commentOf,
  exportCsv,
  importCsv,
  parseImport,
  plain,
  readComment,
} from "../src/operations/portfolio-import.ts";
import { searchAll } from "../src/operations/search.ts";
import type { Who } from "../src/operations/who.ts";
import {
  portfolioByName,
  readPosition,
  readTrade,
} from "../src/portfolios/store.ts";
import { money } from "../src/portfolios/value.ts";
import type { Db } from "../src/storage/db/index.ts";
import { sentence } from "../src/web/data/api.ts";
import { plainError } from "../src/web/data/portfolios.ts";
import { missingWords, staleWords } from "../src/web/views/Portfolios.model.ts";
import { api } from "./helpers/api.ts";
import { portfolioBefore } from "./helpers/portfolio.ts";
import { bar, instrument, LIVE, NOW, quote, world } from "./helpers/world.ts";

const CASEY: Who = { name: "casey-agent", portfolio: "write", rules: "none" };
const OTHER: Who = { name: "riley-agent", portfolio: "write", rules: "none" };

function pair(
  db: Db,
  symbol: string,
  live: number | null,
  closes: Record<string, [number, boolean]> = {},
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
  for (const [date, [close, final]] of Object.entries(closes)) {
    bar(db, `CCY:${symbol}`, "1d", date, close, final);
  }
  if (live !== null) quote(db, `CCY:${symbol}`, live, live);
}

async function setup() {
  const w = world();
  instrument(w.db, "US:AAA", { currency: "USD", name: "Alpha Made Up" });
  instrument(w.db, "US:NOQ", { currency: "USD", name: "Unquoted Made Up" });
  instrument(w.db, "KW:KKK", { currency: "KWD", name: "Kilo Made Up" });
  quote(w.db, "US:AAA", 100, 100);
  quote(w.db, "KW:KKK", 1, 1);
  await portfolioBefore(w.m, "Shares");
  await createBroker(w.m, { name: "North" });
  await createBroker(w.m, { name: "South" });
  return w;
}

type TradeIn = Partial<Parameters<typeof addTrade>[2]>;

const trade = (m: Markets, t: TradeIn, who = CASEY) =>
  addTrade(m, who, {
    portfolio: "Shares",
    symbol: "US:AAA",
    side: "buy",
    quantity: 1,
    price: 10,
    total: null,
    fees: 0,
    date: "2026-03-02",
    currency: null,
    broker: "North",
    note: null,
    ...t,
  });

const idOf = (r: Awaited<ReturnType<typeof trade>>) => {
  if ("error" in r) throw new Error(r.message);
  return r.trade!.id;
};

async function holdingsOf(
  m: Markets,
  currency: string | null = null,
): Promise<HoldingsAnswer> {
  const h = await readHoldings(m, { portfolio: null, broker: null, currency });
  if ("error" in h) throw new Error(h.message);
  return h;
}

const all = {
  portfolio: null,
  broker: null,
  symbol: null,
  from: null,
  to: null,
  removed: false,
};

describe("oversells are judged over the whole part", () => {
  test("a back-dated sell before its buy is refused", async () => {
    const { m } = await setup();
    await trade(m, { quantity: 5, date: "2026-03-02" });
    const r = await trade(m, { side: "sell", quantity: 5, date: "2026-02-01" });
    expect(r).toMatchObject({ error: "bad_arguments" });
  });

  test("removing a buy a later sell needs, or restoring that sell, is refused", async () => {
    const { m } = await setup();
    const b = idOf(await trade(m, { quantity: 5 }));
    const s = idOf(
      await trade(m, { side: "sell", quantity: 5, date: "2026-04-01" }),
    );
    expect(await setTradeState(m, CASEY, b, true)).toMatchObject({
      error: "conflict",
    });
    await setTradeState(m, CASEY, s, true);
    await setTradeState(m, CASEY, b, true);
    expect(await setTradeState(m, CASEY, s, false)).toMatchObject({
      error: "conflict",
    });
    await setTradeState(m, CASEY, b, false);
    expect(await setTradeState(m, CASEY, s, false)).toMatchObject({
      trade: { removed_at: null },
    });
  });

  test("a part an old entry oversold still takes a valid sell", async () => {
    const { m, db } = await setup();
    // a sell stored before checks held, with nothing bought
    db.query(
      `insert into trades (portfolio, instrument, side, date, quantity, price,
         fees, currency, broker, entered_by, entered_at)
       values (1, 'US:AAA', 'sell', '2026-01-02', 3, 10, 0, 'USD', 1, 'web', 0)`,
    ).run();
    await trade(m, { quantity: 5, date: "2026-03-02" });
    const r = await trade(m, { side: "sell", quantity: 2, date: "2026-04-01" });
    expect("error" in r).toBe(false);
  });

  test("a sell of all leaves what a later sell already sold", async () => {
    const { m } = await setup();
    await trade(m, { quantity: 10, date: "2026-01-05" });
    await trade(m, { side: "sell", quantity: 4, date: "2026-07-06" });
    const r = await trade(m, {
      side: "sell",
      quantity: "all",
      date: "2026-03-02",
    });
    expect(r).toMatchObject({ trade: { quantity: 6 } });
  });

  test("an import refuses a sell its file buys only later, and the fixed file saves", async () => {
    const { m } = await setup();
    const head =
      "Symbol,Trade Date,Purchase Price,Quantity,Commission,Comment,Transaction Type";
    const csv = [
      head,
      "US:AAA,20260301,10,10,0,[broker North],Sell",
      "US:AAA,20260401,10,5,0,[broker North],Buy",
    ].join("\n");
    const r = await importCsv(
      m,
      CASEY,
      parseImport({ portfolio: "Shares", csv, confirm: true }),
    );
    if ("error" in r) throw new Error(r.message);
    expect(r.rows.map((x) => [x.line, x.status])).toEqual([
      [2, "bad"],
      [3, "saved"],
    ]);
    // a sell after its buy, though the file lists it first
    const fine = [
      head,
      "US:AAA,20260601,10,5,0,[broker North],Sell",
      "US:AAA,20260504,10,5,0,[broker North],Buy",
    ].join("\n");
    const ok = await importCsv(
      m,
      CASEY,
      parseImport({ portfolio: "Shares", csv: fine }),
    );
    if ("error" in ok) throw new Error(ok.message);
    expect(ok.counts.ok).toBe(2);
  });

  test("an oversold holding that ends at nothing stays, with why", async () => {
    const { m, db } = await setup();
    db.query(
      `insert into trades (portfolio, instrument, side, date, quantity, price,
         fees, currency, broker, entered_by, entered_at)
       values (1, 'US:AAA', 'sell', '2026-01-02', 3, 10, 0, 'USD', 1, 'web', 0)`,
    ).run();
    const h = await holdingsOf(m);
    const a = h.holdings.find((r) => r.id === "US:AAA")!;
    expect(a.quantity).toBe(0);
    expect(a.stale).toContain("sells more than bought");
  });
});

describe("totals and costs", () => {
  test("one unquoted holding never blanks its currency's total", async () => {
    const { m } = await setup();
    await trade(m, { quantity: 2, price: 50 });
    await trade(m, {
      symbol: "US:NOQ",
      quantity: 1,
      price: 10,
      broker: "South",
    });
    const usd = (await holdingsOf(m)).totals.find((t) => t.currency === "USD")!;
    expect(usd.value).toBe(200);
    expect(usd.missing).toEqual(["US:NOQ"]);
    expect(missingWords("US:NOQ")).toBe("NOQ");
  });

  test("a lot sold whole with no rate leaves no stain on the next buy", async () => {
    const { m } = await setup();
    // paid in a currency with no pair at all
    await trade(m, { quantity: 1, price: 10, currency: "CHF" });
    await trade(m, { side: "sell", quantity: 1, date: "2026-04-01" });
    await trade(m, { quantity: 2, price: 20, date: "2026-05-04" });
    const a = (await holdingsOf(m)).holdings.find((r) => r.id === "US:AAA")!;
    expect(a.cost).toBe(40);
    expect(a.stale).toEqual([]);
  });

  test("amounts keep their precision and a total over shares stays whole", async () => {
    const { m } = await setup();
    const k = await trade(m, { symbol: "KW:KKK", quantity: 1, price: 0.001 });
    if ("error" in k) throw new Error(k.message);
    const kw = (await holdingsOf(m)).holdings.find((r) => r.id === "KW:KKK")!;
    expect(kw.cost).toBe(0.001);
    const t = await trade(m, { quantity: 3, price: null, total: 1000000.01 });
    if ("error" in t) throw new Error(t.message);
    const aaa = (await holdingsOf(m)).holdings.find((r) => r.id === "US:AAA")!;
    expect(aaa.cost).toBe(1000000.01);
  });

  test("a total with nothing costed answers cost and gain null", async () => {
    const { m } = await setup();
    const p: PositionArgs = {
      kind: "cash",
      portfolio: "Shares",
      name: "Spare",
      symbol: null,
      currency: "USD",
      amount: 50,
      units: null,
      price: null,
      cost: null,
      coupon: null,
      maturity: null,
      date: LIVE,
      broker: null,
      note: null,
      dryPowder: false,
    };
    await addPosition(m, CASEY, p);
    const usd = (await holdingsOf(m)).totals[0]!;
    expect(usd).toMatchObject({ value: 50, cost: null, pl: null });
  });
});

describe("rates", () => {
  test("a trade before the pair's first final close has no rate, with why", async () => {
    const { m, db } = await setup();
    pair(db, "EURUSD=X", 1.25, {
      "2026-02-04": [1.1, true],
      "2026-03-02": [1.3, false],
    });
    await trade(m, {
      quantity: 1,
      price: 10,
      currency: "EUR",
      date: "2026-01-05",
    });
    // the day's bar still trades: the close before it is the rate
    await trade(m, {
      quantity: 1,
      price: 10,
      currency: "EUR",
      date: "2026-03-02",
      broker: "South",
    });
    const h = await holdingsOf(m);
    const a = h.holdings.find((r) => r.id === "US:AAA")!;
    expect(a.stale).toContain("no EUR to USD close on or before 2026-01-05");
    expect(a.parts.find((p) => p.broker === "South")!.cost).toBe(11);
    expect(h.cost_rates).toEqual([
      {
        from: "EUR",
        to: "USD",
        pair: "CCY:EURUSD=X",
        count: 1,
        first: "2026-03-02",
        last: "2026-03-02",
      },
      {
        from: "EUR",
        to: "USD",
        pair: null,
        count: 1,
        first: "2026-01-05",
        last: "2026-01-05",
        reason: "no EUR to USD close on or before 2026-01-05",
      },
    ]);
    expect(staleWords("no EUR to USD close on or before 2026-01-05")).toBe(
      "No EUR rate",
    );
  });

  test("a holdings read keeps the pairs it reads tracked", async () => {
    const { m, db } = await setup();
    pair(db, "EURUSD=X", 1.25, { "2026-03-02": [1.1, true] });
    await trade(m, { quantity: 1, price: 10, currency: "EUR" });
    expect(lastReadAt(db, "CCY:EURUSD=X")).toBeNull();
    await holdingsOf(m);
    expect(lastReadAt(db, "CCY:EURUSD=X")).toBe(NOW);
  });
});

describe("import and export", () => {
  const head =
    "Symbol,Trade Date,Purchase Price,Quantity,Commission,Comment,Transaction Type";

  test("a hundredth's code stays as written", async () => {
    const { m } = await setup();
    const csv = [
      head,
      "US:AAA,20260302,90,1,0,[broker North][paid GBp],Buy",
    ].join("\n");
    await importCsv(
      m,
      CASEY,
      parseImport({ portfolio: "Shares", csv, confirm: true }),
    );
    expect((readTradeList(m, all) as { currency: string }[])[0]!.currency).toBe(
      "GBp",
    );
  });

  test("two saves of one file at once insert it once; another currency is no duplicate", async () => {
    const { m } = await setup();
    const csv = [head, "US:AAA,20260302,10,1,0,[broker North],Buy"].join("\n");
    const save = () =>
      importCsv(
        m,
        CASEY,
        parseImport({ portfolio: "Shares", csv, confirm: true }),
      );
    await Promise.all([save(), save()]);
    expect(readTradeList(m, all)).toHaveLength(1);
    const other = [
      head,
      "US:AAA,20260302,10,1,0,[broker North][paid EUR],Buy",
    ].join("\n");
    const r = await importCsv(
      m,
      CASEY,
      parseImport({ portfolio: "Shares", csv: other }),
    );
    if ("error" in r) throw new Error(r.message);
    expect(r.counts.ok).toBe(1);
  });

  test("export writes plain decimals its import reads", async () => {
    const { m, db } = await setup();
    await trade(m, { quantity: 1e-7, price: 10 });
    expect(plain(1e-7)).toBe("0.0000001");
    const csv = exportCsv(m, portfolioByName(db, "Shares")!);
    expect(csv).toContain(",0.0000001,");
    await portfolioBefore(m, "Copy");
    const r = await importCsv(
      m,
      CASEY,
      parseImport({ portfolio: "Copy", csv }),
    );
    if ("error" in r) throw new Error(r.message);
    expect(r.counts.ok).toBe(1);
  });

  test("any note reads back as written", () => {
    for (const note of [
      "North | paid EUR",
      "[broker North] not a tag",
      "\\ starts odd",
      "plain",
      " a leading space",
      null,
    ]) {
      for (const broker of [null, "Odd ] Name"]) {
        for (const paid of [null, "EUR"]) {
          for (const statedOn of [null, "2026-04-17"]) {
            const t = { broker, paid, note, statedOn };
            expect(readComment(commentOf(t))).toEqual(t);
          }
        }
      }
    }
    expect(readComment("bought on a whim")).toEqual({
      broker: null,
      paid: null,
      note: "bought on a whim",
      statedOn: null,
    });
  });

  test("a file under the cap fits its body, escaping and all", async () => {
    const w = await setup();
    const handle = api(w.m);
    // every line quoted, so its JSON escapes past the file's own size
    const line = `"US:AAA","20260302","10","1","0","[broker North] ${'""'.repeat(150)}","Buy"\n`;
    const csv = `${head}\n${line.repeat(Math.floor((440 * 1024) / line.length))}`;
    expect(Buffer.byteLength(JSON.stringify({ csv }))).toBeGreaterThan(
      528 * 1024,
    );
    const res = await handle(
      new Request("http://markets.test/api/v1/portfolios/1/import", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ csv }),
      }),
    );
    expect(res.status).toBe(200);
  });
});

describe("bonds, restore and removals", () => {
  test("a listed bond in another currency than its listing is refused", async () => {
    const { m, db } = await setup();
    instrument(db, "BVB:BND", {
      currency: "RON",
      unit: "percent_of_par",
      name: "Bond Made Up",
    });
    const r = await addPosition(m, CASEY, {
      kind: "bond",
      portfolio: "Shares",
      name: "Made Up Bond",
      symbol: "BVB:BND",
      currency: "EUR",
      amount: 1000,
      units: null,
      price: null,
      cost: null,
      coupon: 5,
      maturity: null,
      date: LIVE,
      broker: null,
      note: null,
      dryPowder: false,
    });
    expect(r).toMatchObject({ error: "bad_arguments" });
    expect(
      plainError(
        "BVB:BND is listed in RON; a bond takes its listing's currency",
      ),
    ).toBe("Use the bond's own currency.");
  });

  test("restore brings a removed trade back over the tool", async () => {
    const { m } = await setup();
    const id = idOf(await trade(m, { quantity: 1 }));
    await portfolioAnswer(
      m,
      CASEY,
      parsePortfolio({ action: "remove", trade: id }),
    );
    const back = await portfolioAnswer(
      m,
      CASEY,
      parsePortfolio({ action: "restore", trade: id }),
    );
    expect(JSON.parse(back.content[0]!.text).trade.removed_at).toBeNull();
  });

  test("a second removal keeps who removed it first", async () => {
    const { m, db } = await setup();
    const id = idOf(await trade(m, { quantity: 1 }));
    await setTradeState(m, CASEY, id, true);
    await setTradeState(m, OTHER, id, true);
    expect(readTrade(db, id)!.removedBy).toBe("casey-agent");
  });

  test("a refusal reads plainly on the page, without ids", () => {
    expect(
      plainError("Position 5 was removed or updated; restore it first."),
    ).toBe("Already changed or removed. Reload the page.");
    expect(plainError("No trade 12.")).toBe(
      "No longer there. Reload the page.",
    );
    expect(plainError("US:AAA: the source has no such symbol")).toBe(
      "The source has no such symbol",
    );
    expect(staleWords("sells more than bought")).toBe("Sold more than bought");
  });
});

describe("files as owners keep them", () => {
  const head =
    "Symbol,Trade Date,Purchase Price,Quantity,Commission,Comment,Transaction Type";

  // a made-up 10:1 split after the buy
  const split = (db: Db) =>
    db
      .query(
        `insert into splits (instrument, date, numerator, denominator, ratio,
           applied_at) values ('US:AAA', '2026-04-01', 10, 1, '10:1', 0)`,
      )
      .run();

  test("an export's old lot, already in today's shares, is held as written", async () => {
    const { m, db } = await setup();
    split(db);
    const csv = [head, "US:AAA,20260119,10,50,0,[broker North],Buy"].join("\n");
    await importCsv(
      m,
      CASEY,
      parseImport({ portfolio: "Shares", csv, confirm: true }),
    );
    const read = (await holdingsOf(m)).holdings.find((r) => r.id === "US:AAA")!;
    expect(read.quantity).toBe(50);
    expect(read.average_cost).toBe(10);
    const [t] = readTradeList(m, all) as { stated_on: string }[];
    expect(t!.stated_on).toBe(LIVE);
  });

  test("the same buy typed in counts every split since, and its export reads back", async () => {
    const { m, db } = await setup();
    split(db);
    await trade(m, { quantity: 5, price: 100, date: "2026-01-19" });
    const typed = (await holdingsOf(m)).holdings.find(
      (r) => r.id === "US:AAA",
    )!;
    expect(typed.quantity).toBe(50);
    const csv = exportCsv(m, portfolioByName(db, "Shares")!);
    expect(csv).toContain(",10,50,0,");
    // read back into its own portfolio: the same trade, nothing added
    const again = await importCsv(
      m,
      CASEY,
      parseImport({ portfolio: "Shares", csv }),
    );
    if ("error" in again) throw new Error(again.message);
    expect(again.counts.skipped).toBe(1);
    await portfolioBefore(m, "Copy");
    await importCsv(
      m,
      CASEY,
      parseImport({ portfolio: "Copy", csv, confirm: true }),
    );
    const copy = await readHoldings(m, {
      portfolio: "Copy",
      broker: null,
      currency: null,
    });
    if ("error" in copy) throw new Error(copy.message);
    expect(copy.holdings[0]!.quantity).toBe(50);
  });

  test("purchases of one bond in one file are kept apart and held as one", async () => {
    const { m, db } = await setup();
    instrument(db, "BVB:GOVA", {
      currency: "RON",
      unit: "percent_of_par",
      name: "Gov Made Up",
    });
    quote(db, "BVB:GOVA", 101, 101);
    const csv = [
      "Item,Symbol,Currency,Amount,Rate (%),Purchase Date,Maturity,Note",
      "Gov bond,BVB:GOVA,RON,1000,6,2026-01-05,2030-01-05,",
      "Gov bond,BVB:GOVA,RON,2000,6,2026-02-04,2030-01-05,",
      "Gov bond,BVB:GOVA,RON,500,6,2026-02-04,2030-01-05,",
      "Gov bond,,RON,700,5,2026-03-02,2029-01-05,",
    ].join("\n");
    const first = await importCsv(
      m,
      CASEY,
      parseImport({ portfolio: "Shares", csv, confirm: true }),
    );
    if ("error" in first) throw new Error(first.message);
    expect(first.counts.saved).toBe(4);
    expect(first.rows.some((r) => r.replaces !== undefined)).toBe(false);
    const again = await importCsv(
      m,
      CASEY,
      parseImport({ portfolio: "Shares", csv, confirm: true }),
    );
    if ("error" in again) throw new Error(again.message);
    expect(again.counts).toMatchObject({ saved: 0, skipped: 4 });
    const h = await holdingsOf(m);
    const listed = h.holdings.filter((r) => r.id === "BVB:GOVA");
    expect(listed).toHaveLength(1);
    expect(listed[0]!.value).toBe(3500 * 1.01);
    expect(listed[0]!.parts).toHaveLength(3);
    expect(h.holdings.filter((r) => r.kind === "bond")).toHaveLength(2);
  });

  test("a month's as of reads as its last day", async () => {
    const { m, db } = await setup();
    const funds = [
      "Fund,Currency,Units,Value,Cost Basis,As Of,Note",
      "Made Up Fund,EUR,10,125,100,2026-02,",
    ].join("\n");
    const cash = ["Item,Amount (EUR),As Of,Note", "Spare,50,2026-09,"].join(
      "\n",
    );
    for (const csv of [funds, cash]) {
      const r = await importCsv(
        m,
        CASEY,
        parseImport({ portfolio: "Shares", csv, confirm: true }),
      );
      if ("error" in r) throw new Error(r.message);
      expect(r.counts.saved).toBe(1);
    }
    const kept = db
      .query("select name, as_of as asOf from positions order by name")
      .all();
    expect(kept).toEqual([
      { name: "Made Up Fund", asOf: "2026-02-28" },
      { name: "Spare", asOf: "2026-09-30" },
    ]);
  });
});

describe("sells of all, precision, and rates by pair", () => {
  test("a sell of all takes every share, however many digits", async () => {
    for (const held of [0.123456789, 1.0000000049, 0.1 + 0.2]) {
      const { m } = await setup();
      await trade(m, { quantity: held, date: "2026-03-02" });
      const r = await trade(m, {
        side: "sell",
        quantity: "all",
        date: "2026-04-01",
      });
      expect([held, "error" in r]).toEqual([held, false]);
      const a = (await holdingsOf(m)).holdings.find((x) => x.id === "US:AAA");
      expect([held, a]).toEqual([held, undefined]);
    }
  });

  test("after an old oversell, all sells what is held now", async () => {
    const { m, db } = await setup();
    await trade(m, { quantity: 10, date: "2026-01-05" });
    // stored before checks held: sells more than the 10 bought
    db.query(
      `insert into trades (portfolio, instrument, side, date, quantity, price,
         fees, currency, broker, entered_by, entered_at)
       values (1, 'US:AAA', 'sell', '2026-02-04', 15, 10, 0, 'USD', 1, 'web', 0)`,
    ).run();
    await trade(m, { quantity: 20, date: "2026-03-02" });
    expect(
      (await holdingsOf(m)).holdings.find((x) => x.id === "US:AAA")!.quantity,
    ).toBe(20);
    const r = await trade(m, {
      side: "sell",
      quantity: "all",
      date: "2026-04-01",
    });
    expect(r).toMatchObject({ trade: { quantity: 20 } });
  });

  test("a tiny price keeps its digits and a total over shares stays whole", async () => {
    const { m } = await setup();
    const coin = await trade(m, {
      symbol: "KW:KKK",
      quantity: 1e8,
      price: null,
      total: 1234.56,
    });
    if ("error" in coin) throw new Error(coin.message);
    expect(coin.trade!.price).toBe(0.0000123456);
    const third = await trade(m, { quantity: 3, price: null, total: 100 });
    if ("error" in third) throw new Error(third.message);
    const h = await holdingsOf(m);
    expect(h.holdings.find((x) => x.id === "KW:KKK")!.cost).toBe(1234.56);
    expect(h.holdings.find((x) => x.id === "US:AAA")!.cost).toBe(100);
  });

  test("costs say their rates once per pair, sold lots and all", async () => {
    const { m, db } = await setup();
    const days = ["2026-01-05", "2026-01-06", "2026-01-07", "2026-01-08"];
    pair(
      db,
      "EURUSD=X",
      1.2,
      Object.fromEntries(days.map((d) => [d, [1.1, true]])),
    );
    for (const date of days) {
      await trade(m, { quantity: 1, price: 10, currency: "EUR", date });
    }
    await trade(m, {
      side: "sell",
      quantity: 2,
      date: "2026-02-04",
    });
    const h = await holdingsOf(m, "USD");
    expect(h.cost_rates).toEqual([
      {
        from: "EUR",
        to: "USD",
        pair: "CCY:EURUSD=X",
        count: 4,
        first: "2026-01-05",
        last: "2026-01-08",
      },
    ]);
  });

  test("an untagged note keeps a backslash it starts with", () => {
    expect(readComment("\\server\\share")).toEqual({
      broker: null,
      paid: null,
      note: "\\server\\share",
      statedOn: null,
    });
    expect(readComment("\\[not a tag").note).toBe("[not a tag");
  });
});

describe("imports, rounding and removals as typed", () => {
  const head =
    "Symbol,Trade Date,Purchase Price,Quantity,Commission,Comment,Transaction Type";
  const bonds =
    "Item,Symbol,Currency,Amount,Rate (%),Purchase Date,Maturity,Note";
  const run = async (m: Markets, csv: string, confirm = true) => {
    const r = await importCsv(
      m,
      CASEY,
      parseImport({ portfolio: "Shares", csv, confirm }),
    );
    if ("error" in r) throw new Error(r.message);
    return r;
  };

  test("a file sell that leaves a later stored sell oversold is bad", async () => {
    const { m } = await setup();
    await trade(m, { quantity: 10, date: "2026-01-05" });
    await trade(m, { side: "sell", quantity: 10, date: "2026-03-02" });
    const typed = await trade(m, {
      side: "sell",
      quantity: 5,
      date: "2026-02-04",
    });
    expect(typed).toMatchObject({ error: "bad_arguments" });
    const r = await run(
      m,
      [head, "US:AAA,20260204,10,5,0,[broker North],Sell"].join("\n"),
    );
    expect(r.rows.map((x) => x.status)).toEqual(["bad"]);
    // a file buy before it makes room for it
    const fine = await run(
      m,
      [
        head,
        "US:AAA,20260204,10,5,0,[broker North],Sell",
        "US:AAA,20260210,10,5,0,[broker North],Buy",
      ].join("\n"),
      false,
    );
    expect(fine.counts.ok).toBe(2);
  });

  test("a sell of all takes a large fractional holding to nothing", async () => {
    const { m } = await setup();
    await trade(m, { quantity: 1234567.12345123, date: "2026-03-02" });
    const r = await trade(m, {
      side: "sell",
      quantity: "all",
      date: "2026-04-01",
    });
    expect(r).toMatchObject({ trade: { quantity: 1234567.12345123 } });
    const a = (await holdingsOf(m)).holdings.find((x) => x.id === "US:AAA");
    expect(a).toBeUndefined();
  });

  test("money keeps 8 decimals from a cent up and digits below", () => {
    expect(money(370371.000000002)).toBe(370371);
    expect(money(0.0000123456789)).toBe(0.0000123456789);
    expect(money(12.345678912)).toBe(12.34567891);
    let sum = 0;
    for (let k = 0; k < 300; k++) sum += 1234.57;
    expect(sum).not.toBe(370371);
    expect(money(sum)).toBe(370371);
  });

  test("300 lots sum to their cost exactly", async () => {
    const { m } = await setup();
    for (let k = 0; k < 300; k++) {
      await trade(m, { quantity: 1, price: 1234.57, date: "2026-03-02" });
    }
    const h = await holdingsOf(m);
    expect(h.holdings.find((x) => x.id === "US:AAA")!.cost).toBe(370371);
    expect(h.totals.find((t) => t.currency === "USD")!.cost).toBe(370371);
  });

  test("answers round money to the currency's minor units, prices kept", async () => {
    const { m, db } = await setup();
    instrument(db, "JP:YYY", { currency: "JPY", name: "Yen Made Up" });
    db.query("delete from quotes").run();
    quote(db, "US:AAA", 124.50094314671, 124.40094314671);
    quote(db, "JP:YYY", 1234.567, 1234.567);
    quote(db, "KW:KKK", 1.23456789, 1.23456789);
    await trade(m, { quantity: 100, price: 62.9078579898804 });
    await trade(m, { symbol: "JP:YYY", quantity: 3, price: 1000.4 });
    await trade(m, { symbol: "KW:KKK", quantity: 7, price: 1 });
    const h = await holdingsOf(m);
    const a = h.holdings.find((x) => x.id === "US:AAA")!;
    expect(a.value).toBe(12450.09);
    expect(a.cost).toBe(6290.79);
    expect(a.pl).toBe(6159.31);
    expect(a.day_change).toBe(10);
    expect(a.price).toBe(124.50094314671);
    expect(a.parts[0]!.value).toBe(12450.09);
    expect(h.totals.find((t) => t.currency === "USD")!.value).toBe(12450.09);
    const y = h.holdings.find((x) => x.id === "JP:YYY")!;
    expect([y.value, y.cost]).toEqual([3704, 3001]);
    expect(h.holdings.find((x) => x.id === "KW:KKK")!.value).toBe(8.642);
  });

  test("a bond with no purchase date is read once, and so is one that resolves later", async () => {
    const { m, clock, db } = await setup();
    const csv = [
      bonds,
      "Undated bond,,RON,1000,6,,2030-01-05,",
      "Later bond,BVB:LATER,RON,2000,6,2026-02-04,2030-01-05,",
    ].join("\n");
    const first = await run(m, csv);
    expect(first.counts.saved).toBe(2);
    await clock.advance(2 * 86_400_000);
    instrument(db, "BVB:LATER", {
      currency: "RON",
      unit: "percent_of_par",
      name: "Later Made Up",
    });
    quote(db, "BVB:LATER", 110, 110);
    const again = await run(m, csv);
    // the later bond gets the listing it now resolves to
    expect(again.counts).toMatchObject({ saved: 1, skipped: 1 });
    const kept = db
      .query(
        `select name, instrument from positions
         where kind = 'bond' and removed_at is null order by name`,
      )
      .all();
    expect(kept).toEqual([
      { name: "Later bond", instrument: "BVB:LATER" },
      { name: "Undated bond", instrument: null },
    ]);
    const later = (await holdingsOf(m)).holdings.find(
      (r) => r.name === "Later bond",
    )!;
    expect([later.priced, later.value]).toEqual(["listing", 2200]);
    expect((await run(m, csv)).counts).toMatchObject({ saved: 0, skipped: 2 });
  });

  test("a merged bond's parts carry each purchase's position", async () => {
    const { m, db } = await setup();
    instrument(db, "BVB:GOVA", {
      currency: "RON",
      unit: "percent_of_par",
      name: "Gov Made Up",
    });
    await run(
      m,
      [
        bonds,
        "Gov bond,BVB:GOVA,RON,1000,6,2026-01-05,2030-01-05,",
        "Gov bond,BVB:GOVA,RON,2000,6,2026-02-04,2030-01-05,",
      ].join("\n"),
    );
    const row = (await holdingsOf(m)).holdings.find(
      (r) => r.id === "BVB:GOVA",
    )!;
    expect(row.position).toBeNull();
    expect(
      row.parts.map((p) => [typeof p.position, p.as_of, p.amount]),
    ).toEqual([
      ["number", "2026-01-05", 1000],
      ["number", "2026-02-04", 2000],
    ]);
  });

  test("a portfolio or broker with only removed rows is deleted, a live row keeps it", async () => {
    const { m, db } = await setup();
    const handle = api(m);
    const del = (path: string) =>
      handle(
        new Request(`http://markets.test/api/v1${path}`, { method: "DELETE" }),
      );
    await portfolioBefore(m, "Mistake");
    const t = idOf(await trade(m, { portfolio: "Mistake", broker: "South" }));
    const live = await del("/portfolios/2");
    expect(live.status).toBe(409);
    expect(((await live.json()) as { detail: string }).detail).toContain(
      "holds trades or positions",
    );
    expect((await del("/brokers/2")).status).toBe(409);
    await setTradeState(m, CASEY, t, true);
    expect((await del("/brokers/2")).status).toBe(204);
    expect(readTrade(db, t)!.broker).toBeNull();
    expect((await del("/portfolios/2")).status).toBe(204);
    expect(readTrade(db, t)).toBeNull();
    expect(portfolioByName(db, "Mistake")).toBeNull();
  });

  test("export then import gives a total-derived price back exactly", async () => {
    const { m, db } = await setup();
    const r = await trade(m, { quantity: 3, price: null, total: 100 });
    if ("error" in r) throw new Error(r.message);
    const stored = readTrade(db, r.trade!.id)!.price;
    const csv = exportCsv(m, portfolioByName(db, "Shares")!);
    await portfolioBefore(m, "Copy");
    await importCsv(
      m,
      CASEY,
      parseImport({ portfolio: "Copy", csv, confirm: true }),
    );
    const copy = db
      .query("select price from trades where portfolio = 2")
      .get() as { price: number };
    expect(copy.price).toBe(stored);
  });

  test("a month as of is never past today, and a later date is refused", async () => {
    const { m, db } = await setup();
    const cash = (when: string) =>
      ["Item,Amount (EUR),As Of,Note", `Spare,50,${when},`].join("\n");
    expect((await run(m, cash(LIVE.slice(0, 7)))).counts.saved).toBe(1);
    const kept = db
      .query("select as_of as asOf from positions where removed_at is null")
      .get() as { asOf: string };
    expect(kept.asOf).toBe(LIVE);
    for (const when of ["2026-12", "2026-12-01"]) {
      const r = await run(m, cash(when), false);
      expect(r.rows[0]).toMatchObject({
        status: "bad",
        reason: "as of is in the future",
      });
    }
    const typed = await addPosition(m, CASEY, {
      kind: "cash",
      portfolio: "Shares",
      name: "Later",
      symbol: null,
      currency: "EUR",
      amount: 5,
      units: null,
      price: null,
      cost: null,
      coupon: null,
      maturity: null,
      date: "2026-12-01",
      broker: null,
      note: null,
      dryPowder: false,
    });
    expect(typed).toMatchObject({
      error: "bad_arguments",
      message: "date is in the future",
    });
  });
});

describe("a review's second pass", () => {
  const head =
    "Symbol,Trade Date,Purchase Price,Quantity,Commission,Comment,Transaction Type";
  const bonds =
    "Item,Symbol,Currency,Amount,Rate (%),Purchase Date,Maturity,Note";
  const run = async (m: Markets, csv: string, portfolio = "Shares") => {
    const r = await importCsv(
      m,
      CASEY,
      parseImport({ portfolio, csv, confirm: true }),
    );
    if ("error" in r) throw new Error(r.message);
    return r;
  };
  const bond = (more: Partial<PositionArgs> = {}): PositionArgs => ({
    kind: "bond",
    portfolio: "Shares",
    name: "Made Up Bond",
    symbol: null,
    currency: "RON",
    amount: 1000,
    units: null,
    price: null,
    cost: null,
    coupon: 6,
    maturity: "2030-01-13",
    date: "2026-01-13",
    broker: null,
    note: null,
    dryPowder: false,
    ...more,
  });
  const positionId = (r: Awaited<ReturnType<typeof addPosition>>) => {
    if ("error" in r) throw new Error(r.message);
    return r.position.id;
  };

  test("a sell of all agrees with the holdings on what is left", async () => {
    const cases: [number[], number][] = [
      [[0.1, 0.2], 0.3],
      [[1000], 999.999999],
      [[1e9], 1e9 - 0.5],
    ];
    for (const [buys, sold] of cases) {
      for (const broker of ["North", null]) {
        const { m } = await setup();
        for (const q of buys) {
          await trade(m, { quantity: q, date: "2026-01-13", broker });
        }
        await trade(m, {
          side: "sell",
          quantity: sold,
          date: "2026-02-11",
          broker,
        });
        const row = (await holdingsOf(m)).holdings.find(
          (x) => x.id === "US:AAA",
        );
        const all = await trade(m, {
          side: "sell",
          quantity: "all",
          date: "2026-05-07",
          broker,
        });
        const label = [buys, sold, broker];
        if (row === undefined) {
          expect([label, all]).toMatchObject([
            label,
            {
              error: "bad_arguments",
              message: expect.stringMatching(/^none is held/),
            },
          ]);
        } else {
          expect([label, "error" in all]).toEqual([label, false]);
        }
      }
    }
  });

  test("each kept fill absorbs one file row, and each kept bond one line", async () => {
    const { m, db } = await setup();
    await trade(m, { date: "2026-01-13" });
    await trade(m, { date: "2026-01-13" });
    const row = "US:AAA,20260113,10,1,0,[broker North],Buy";
    const r = await run(m, [head, row, row, row].join("\n"));
    expect(r.counts).toMatchObject({ skipped: 2, saved: 1 });
    const undated = "Undated bond,,RON,1000,6,,2030-01-13,";
    await run(m, [bonds, undated].join("\n"));
    const b = await run(m, [bonds, undated, undated].join("\n"));
    expect(b.counts).toMatchObject({ skipped: 1, saved: 1 });
    const n = db
      .query(
        "select count(*) as n from positions where kind = 'bond' and removed_at is null",
      )
      .get() as { n: number };
    expect(n.n).toBe(2);
  });

  test("restoring a bond after its face or date changed sets the update aside", async () => {
    for (const change of [
      { amount: { amount: 1500, currency: null } },
      { date: "2026-02-11" },
    ]) {
      const { m, db } = await setup();
      const first = positionId(await addPosition(m, CASEY, bond()));
      const up = await updatePosition(m, CASEY, first, change);
      if ("error" in up) throw new Error(up.message);
      await setPositionState(m, CASEY, first, false);
      const live = db
        .query("select id from positions where removed_at is null")
        .all();
      expect(live).toEqual([{ id: first }]);
      const h = historyOf(m, up.position.id);
      if ("error" in h) throw new Error(h.message);
      expect(h.history.map((x) => x.id).sort()).toEqual(
        [first, up.position.id].sort(),
      );
    }
  });

  test("an export read back after a later split counts the split once", async () => {
    const { m, db, clock } = await setup();
    await trade(m, { quantity: 5, price: 100, date: "2026-01-13" });
    const csv = exportCsv(m, portfolioByName(db, "Shares")!);
    expect(csv).toContain(`[as of ${LIVE}]`);
    db.query(
      `insert into splits (instrument, date, numerator, denominator, ratio,
         applied_at) values ('US:AAA', '2026-10-26', 10, 1, '10:1', 0)`,
    ).run();
    await clock.advance(5 * 86_400_000);
    const quantityIn = async (name: string, text: string) => {
      await portfolioBefore(m, name);
      await run(m, text, name);
      const h = await readHoldings(m, {
        portfolio: name,
        broker: null,
        currency: null,
      });
      if ("error" in h) throw new Error(h.message);
      return h.holdings[0]!.quantity;
    };
    expect(await quantityIn("Tagged", csv)).toBe(50);
    // a broker's file says nothing: stated on the import's day
    const bare = csv.replace(/\[as of [^\]]*\]/, "");
    expect(await quantityIn("Bare", bare)).toBe(5);
  });

  test("an import keeps a note's own spaces after the tags", async () => {
    const { m, db } = await setup();
    await run(
      m,
      [head, 'US:AAA,20260113,10,1,0,"[broker North]  two spaces ",Buy'].join(
        "\n",
      ),
    );
    const t = db.query("select note from trades").get() as { note: string };
    expect(t.note).toBe(" two spaces ");
  });

  test("updates and live-price trades store what was given", async () => {
    const { m, db } = await setup();
    db.query("delete from quotes where instrument = 'US:AAA'").run();
    quote(db, "US:AAA", 12.123456789123, 12.123456789123);
    const t = await trade(m, { price: null });
    if ("error" in t) throw new Error(t.message);
    expect(readTrade(db, t.trade!.id)!.price).toBe(12.123456789123);
    const id = positionId(
      await addPosition(m, CASEY, {
        ...bond(),
        kind: "cash",
        name: "Spare",
        amount: 1,
        coupon: null,
        maturity: null,
      }),
    );
    const up = await updatePosition(m, CASEY, id, {
      amount: { amount: 12.123456789123, currency: null },
    });
    if ("error" in up) throw new Error(up.message);
    expect(readPosition(db, up.position.id)!.amount).toBe(12.123456789123);
  });

  test("money rounds once, from the exact value", async () => {
    const { m, db } = await setup();
    db.query("delete from quotes where instrument = 'US:AAA'").run();
    quote(db, "US:AAA", 0.024999999, 0.024999999);
    await trade(m, { quantity: 1, price: 0.01 });
    const row = (await holdingsOf(m)).holdings.find((x) => x.id === "US:AAA")!;
    expect(row.value).toBe(0.02);
  });

  test("a listed bond position carries the day's change", async () => {
    const { m, db } = await setup();
    instrument(db, "BVB:GOVC", {
      currency: "RON",
      unit: "percent_of_par",
      name: "Gov Made Up",
    });
    quote(db, "BVB:GOVC", 110, 100);
    await addPosition(m, CASEY, bond({ symbol: "BVB:GOVC", amount: 3000 }));
    const h = await holdingsOf(m);
    const row = h.holdings.find((x) => x.id === "BVB:GOVC")!;
    expect(row.day_change).toBe(300);
    expect(h.totals.find((t) => t.currency === "RON")!.day_change).toBe(300);
  });

  test("shown rates keep their digits", async () => {
    const { m, db } = await setup();
    pair(db, "EURUSD=X", 1.123456789, { "2026-01-13": [1.123456789, true] });
    const t = await trade(m, { price: null, currency: "EUR" });
    if ("error" in t) throw new Error(t.message);
    // eight significant digits would be 0.89010989
    const near = (v: number | null | undefined) =>
      Math.abs((v ?? 0) - 1 / 1.123456789) < 1e-14;
    expect(near(t.live_price!.rate)).toBe(true);
    const h = await holdingsOf(m, "EUR");
    const row = h.holdings.find((x) => x.id === "US:AAA")!;
    expect(near(row.converted!.rate)).toBe(true);
    const id = positionId(
      await addPosition(m, CASEY, {
        ...bond(),
        kind: "cash",
        name: "Spare",
        currency: "USD",
        amount: 1,
        coupon: null,
        maturity: null,
      }),
    );
    const up = await updatePosition(m, CASEY, id, {
      amount: { amount: 10, currency: "EUR" },
    });
    if ("error" in up) throw new Error(up.message);
    expect(up.rate!.rate).toBe(1.123456789);
  });

  test("a second removal of a position keeps who removed it first", async () => {
    const { m, db } = await setup();
    const id = positionId(await addPosition(m, CASEY, bond()));
    await setPositionState(m, CASEY, id, true);
    const first = readPosition(db, id)!;
    await setPositionState(m, OTHER, id, true);
    expect(readPosition(db, id)).toEqual(first);
    expect(first.removedBy).toBe(CASEY.name);
  });

  test("a broker's live trades are read by index, never a scan", async () => {
    const { db } = await setup();
    for (const where of [
      "broker = 1",
      "portfolio = 1 and broker = 1",
      "1 = 1",
    ]) {
      const plan = db
        .query(
          `explain query plan select * from trades where ${where}
           and removed_at is null order by date desc, id desc`,
        )
        .all() as { detail: string }[];
      const said = plan.map((p) => p.detail).join("; ");
      expect([where, /TEMP B-TREE|SCAN trades$/.test(said)]).toEqual([
        where,
        false,
      ]);
    }
  });
});

describe("a review's third pass", () => {
  const head =
    "Symbol,Trade Date,Purchase Price,Quantity,Commission,Comment,Transaction Type";
  const bonds =
    "Item,Symbol,Currency,Amount,Rate (%),Purchase Date,Maturity,Note";
  const run = async (m: Markets, csv: string, confirm = true) => {
    const r = await importCsv(
      m,
      CASEY,
      parseImport({ portfolio: "Shares", csv, confirm }),
    );
    if ("error" in r) throw new Error(r.message);
    return r;
  };
  const bond = (amount: number, date = "2026-01-21"): PositionArgs => ({
    kind: "bond",
    portfolio: "Shares",
    name: "Made Up Bond",
    symbol: null,
    currency: "RON",
    amount,
    units: null,
    price: null,
    cost: null,
    coupon: 4,
    maturity: "2031-06-17",
    date,
    broker: null,
    note: null,
    dryPowder: false,
  });
  const live = (db: Db) =>
    db
      .query(
        "select id, amount from positions where removed_at is null order by id",
      )
      .all() as { id: number; amount: number }[];
  const idOfPosition = (r: Awaited<ReturnType<typeof addPosition>>) => {
    if ("error" in r) throw new Error(r.message);
    return r.position.id;
  };
  const updated = async (m: Markets, id: number, amount: number) => {
    const r = await updatePosition(m, CASEY, id, {
      amount: { amount, currency: null },
    });
    if ("error" in r) throw new Error(r.message);
    return r.position.id;
  };

  test("restoring any row of a bond's chain leaves one live purchase", async () => {
    const { m, db } = await setup();
    const b0 = idOfPosition(await addPosition(m, CASEY, bond(700)));
    const b1 = await updated(m, b0, 900);
    await setPositionState(m, CASEY, b0, false);
    await updated(m, b0, 1100);
    await setPositionState(m, CASEY, b1, false);
    expect(live(db)).toEqual([{ id: b1, amount: 900 }]);
  });

  test("restoring one of two equal bond purchases keeps the other", async () => {
    const { m, db } = await setup();
    const a = idOfPosition(await addPosition(m, CASEY, bond(700)));
    const csv = [bonds, "Made Up Bond,,RON,700,4,2026-01-21,2031-06-17,"];
    const r = await run(m, [...csv, csv[1]!].join("\n"));
    expect(r.counts).toMatchObject({ skipped: 1, saved: 1 });
    const other = live(db).find((x) => x.id !== a)!.id;
    await setPositionState(m, CASEY, a, true);
    await setPositionState(m, CASEY, a, false);
    expect(live(db).map((x) => x.id)).toEqual([a, other]);
  });

  test("a bond line saved in one write matches no later line of it", async () => {
    const { m } = await setup();
    const line = "Twin bond,,RON,700,4,2026-01-21,2031-06-17,";
    const csv = [bonds, line, line].join("\n");
    expect((await run(m, csv, false)).counts.ok).toBe(2);
    expect((await run(m, csv)).counts).toMatchObject({ saved: 2 });
    expect((await run(m, csv)).counts).toMatchObject({
      saved: 0,
      skipped: 2,
    });
  });

  test("two undated lines relist two kept unlisted purchases", async () => {
    const { m, db } = await setup();
    await run(
      m,
      [
        bonds,
        "Pair bond,BVB:PAIRB,RON,700,4,2026-01-21,2031-06-17,",
        "Pair bond,BVB:PAIRB,RON,700,4,2026-02-18,2031-06-17,",
      ].join("\n"),
    );
    instrument(db, "BVB:PAIRB", {
      currency: "RON",
      unit: "percent_of_par",
      name: "Pair Made Up",
    });
    const line = "Pair bond,BVB:PAIRB,RON,700,4,,2031-06-17,";
    const r = await run(m, [bonds, line, line].join("\n"));
    expect(r.counts).toMatchObject({ saved: 2 });
    const kept = db
      .query(
        `select instrument, as_of as asOf from positions
         where removed_at is null order by as_of`,
      )
      .all();
    expect(kept).toEqual([
      { instrument: "BVB:PAIRB", asOf: "2026-01-21" },
      { instrument: "BVB:PAIRB", asOf: "2026-02-18" },
    ]);
  });

  test("an as of tag before the trade's date is bad", async () => {
    const { m } = await setup();
    const r = await run(
      m,
      [head, "US:AAA,20260318,10,1,0,[as of 2026-03-11],Buy"].join("\n"),
      false,
    );
    expect(r.rows[0]).toMatchObject({
      status: "bad",
      reason: "the as of tag is before the trade date",
    });
  });

  test("a comment of only spaces is no note", async () => {
    const { m, db } = await setup();
    expect(readComment("   ").note).toBeNull();
    expect(readComment("[broker North]   ").note).toBeNull();
    await run(m, [head, 'US:AAA,20260318,10,1,0,"   ",Buy'].join("\n"));
    const t = db.query("select note from trades").get() as {
      note: string | null;
    };
    expect(t.note).toBeNull();
  });
});

describe("a review's fourth pass", () => {
  test("a trade dated ahead of its listing's today reads back from export", async () => {
    const { m, db } = await setup();
    const ahead = latestDay(NOW);
    expect(ahead > LIVE).toBe(true);
    const r = await trade(m, { quantity: 3, price: 41.5, date: ahead });
    if ("error" in r) throw new Error(r.message);
    const csv = exportCsv(m, portfolioByName(db, "Shares")!);
    expect(csv).toContain(`[as of ${ahead}]`);
    await portfolioBefore(m, "Copy");
    const back = await importCsv(
      m,
      CASEY,
      parseImport({ portfolio: "Copy", csv, confirm: true }),
    );
    if ("error" in back) throw new Error(back.message);
    expect(back.counts).toMatchObject({ saved: 1, bad: 0 });
  });

  test("a stored listing takes the exchange in words from the source's result", async () => {
    const { m } = await setup();
    const listings = [
      {
        sourceSymbol: "AAA",
        exchange: "NMS",
        exchangeName: "Made Up Exchange",
        type: "EQUITY",
        name: "Alpha Made Up",
      },
    ];
    const fake = { search: async () => listings };
    Object.assign(m, {
      yahoo: { ...m.yahoo, within: () => fake } as unknown as Markets["yahoo"],
    });
    const { all } = await searchAll(m, "AAA");
    const a = all.find((c) => c.id === "US:AAA")!;
    expect(a).toMatchObject({
      stored: true,
      exchange_name: "Made Up Exchange",
      currency: "USD",
    });
  });
});

describe("refusals an agent can act on", () => {
  const call = async (m: Markets, args: object) => {
    const r = await portfolioAnswer(m, CASEY, parsePortfolio(args));
    return {
      error: r.isError === true,
      text: (r.content[0] as { text: string }).text,
    };
  };

  test("remove, restore and update take the row's own portfolio", async () => {
    const { m } = await setup();
    await portfolioBefore(m, "Other");
    const t = idOf(await trade(m, { date: "2026-01-27" }));
    const ok = await call(m, {
      action: "remove",
      trade: t,
      portfolio: "Shares",
    });
    expect(ok.error).toBe(false);
    const back = await call(m, {
      action: "restore",
      trade: t,
      portfolio: "Shares",
    });
    expect(back.error).toBe(false);
    const wrong = await call(m, {
      action: "remove",
      trade: t,
      portfolio: "Other",
    });
    expect(wrong.error).toBe(true);
    expect(wrong.text).toContain(`trade ${t} is in Shares, not Other`);
    // kind rides along from add out of habit: a known one is fine
    const kinded = await call(m, { action: "remove", trade: t, kind: "trade" });
    expect(kinded.error).toBe(false);
    const again = await call(m, { action: "restore", trade: t, kind: "trade" });
    expect(again.error).toBe(false);
    await expect(
      call(m, { action: "remove", trade: t, kind: "shares" }),
    ).rejects.toThrow("kind must be one of");
    const cash = await addPosition(m, CASEY, {
      kind: "cash",
      portfolio: "Shares",
      name: "Spare",
      symbol: null,
      currency: "USD",
      amount: 40,
      units: null,
      price: null,
      cost: null,
      coupon: null,
      maturity: null,
      date: null,
      broker: null,
      note: null,
      dryPowder: false,
    });
    if ("error" in cash) throw new Error(cash.message);
    const up = await call(m, {
      action: "update",
      position: cash.position.id,
      amount: 45,
      portfolio: "Other",
    });
    expect(up.text).toContain("is in Shares, not Other");
  });

  test("a removal a later sale needs names that sale", async () => {
    const { m } = await setup();
    const buy = idOf(await trade(m, { quantity: 6, date: "2026-01-27" }));
    const sale = idOf(
      await trade(m, { side: "sell", quantity: 6, date: "2026-03-23" }),
    );
    const r = await setTradeState(m, CASEY, buy, true);
    expect(r).toMatchObject({
      error: "conflict",
      message: `a later sale at that broker would sell more than it holds: remove sale ${sale} (2026-03-23) first`,
    });
    if ("error" in r) {
      expect(plainError(r.message)).toBe(
        "A later sale would sell more than is held. Remove the sale of 2026-03-23 first.",
      );
    }
    await setTradeState(m, CASEY, sale, true);
    await setTradeState(m, CASEY, buy, true);
    // restoring the sale with its buy gone: it oversells itself
    expect(await setTradeState(m, CASEY, sale, false)).toMatchObject({
      error: "conflict",
      message: "it sells more than that broker held then",
    });
  });

  test("a sell with no broker of a share held at brokers says where", async () => {
    const { m } = await setup();
    await trade(m, { quantity: 7, broker: "North", date: "2026-01-27" });
    await trade(m, { quantity: 3, broker: "South", date: "2026-01-27" });
    const r = await trade(m, {
      side: "sell",
      quantity: 2,
      broker: null,
      date: "2026-03-23",
    });
    expect(r).toMatchObject({
      error: "bad_arguments",
      message:
        "more than is held with no broker; held at North 7 and South 3: name a broker or sell all",
    });
    // the page capitalises a refusal before it is made plain
    expect(plainError(sentence((r as { message: string }).message))).toBe(
      "Pick the broker, or sell all.",
    );
    const named = await trade(m, {
      side: "sell",
      quantity: 9,
      broker: "North",
      date: "2026-03-23",
    });
    expect(named).toMatchObject({
      message: "sells more than that broker holds",
    });
  });
});
