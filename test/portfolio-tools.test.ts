// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// The portfolio tools as an agent calls them: made-up data only.

import { describe, expect, test } from "bun:test";
import type { Markets } from "../src/operations/markets.ts";
import {
  createBroker,
  createPortfolio,
  saveSettings,
} from "../src/operations/portfolio.ts";
import { OPERATOR, type Who } from "../src/operations/who.ts";
import { ADMIN_KEY, api } from "./helpers/api.ts";
import { ask } from "./helpers/portfolio.ts";
import { instrument, quote, world } from "./helpers/world.ts";

const CASEY: Who = {
  name: "casey-agent",
  user: OPERATOR,
  credential: { kind: "key", id: "casey-agent" },
  portfolio: "write",
  rules: "none",
  profile: "none",
};
const ONE = "ZZFUND000011";

async function setup() {
  const w = world();
  instrument(w.db, "US:AAA", { currency: "USD", name: "Alpha Made Up" });
  quote(w.db, "US:AAA", 120, 118);
  await saveSettings(w.m, OPERATOR, { display_currency: "EUR" });
  await createPortfolio(w.m, OPERATOR, { name: "Shares" });
  for (const name of ["North", "South"])
    await createBroker(w.m, OPERATOR, { name });
  return w;
}

const tool = (m: Markets, name: string, args: object) =>
  ask(m, CASEY, name, args);

const cash = (m: Markets, more: object = {}) =>
  tool(m, "portfolio_cash", {
    action: "add",
    name: "Savings",
    amount: 100,
    currency: "EUR",
    broker: "North",
    ...more,
  });

const bond = (m: Markets, more: object = {}) =>
  tool(m, "portfolio_bond", {
    action: "add",
    name: "Made Up 2030",
    amount: 1000,
    currency: "EUR",
    coupon: 4.5,
    maturity: "2030-06-30",
    cost: 980,
    date: "2026-03-02",
    ...more,
  });

describe("portfolio_trade", () => {
  test("records a share, and a fund by isin, its key or its name", async () => {
    const { m } = await setup();
    const share = await tool(m, "portfolio_trade", {
      action: "add",
      symbol: "US:AAA",
      side: "buy",
      quantity: 3,
      price: 100,
      broker: "North",
      date: "2026-01-05",
    });
    expect(share.body.trade).toMatchObject({ symbol: "US:AAA", quantity: 3 });
    const first = await tool(m, "portfolio_trade", {
      action: "add",
      isin: ONE,
      name: "Made Up Fund",
      side: "buy",
      quantity: 10,
      price: 5,
      currency: "EUR",
      date: "2026-01-05",
    });
    expect(first.body.fund).toMatchObject({ id: `fund:${ONE}` });
    expect(first.body.trade.quantity).toBe(10);
    const byKey = await tool(m, "portfolio_trade", {
      action: "add",
      symbol: `fund:${ONE}`,
      side: "buy",
      quantity: 2,
      price: 6,
      date: "2026-01-06",
    });
    expect(byKey.body.trade.symbol).toBe(`fund:${ONE}`);
    const byName = await tool(m, "portfolio_trade", {
      action: "add",
      name: "made up fund",
      side: "buy",
      quantity: 1,
      price: 6,
      date: "2026-01-07",
    });
    expect(byName.error).toBe(false);
    const all = await tool(m, "portfolio_trade", {
      action: "add",
      isin: ONE,
      side: "sell",
      all: true,
      price: 6,
      date: "2026-01-08",
    });
    expect(all.body.trade.quantity).toBe(13);
    const gone = await tool(m, "portfolio_trade", {
      action: "remove",
      trade: all.body.trade.id,
    });
    expect(gone.body.trade.removed_by).toBe("casey-agent");
    // a portfolio named out of habit is checked, never needed
    const back = await tool(m, "portfolio_trade", {
      action: "restore",
      trade: all.body.trade.id,
      portfolio: "Shares",
    });
    expect(back.error).toBe(false);
    const wrong = await tool(m, "portfolio_trade", {
      action: "remove",
      trade: all.body.trade.id,
      portfolio: "Cash",
    });
    expect(wrong.body.message).toBe(
      `trade ${all.body.trade.id} is in Shares, not Cash`,
    );
  });

  test("refuses arguments that mean two things", async () => {
    const { m } = await setup();
    const refused: [object, string][] = [
      [{ quantity: 1, all: true }, "quantity or all, not both"],
      [{ all: true }, "all sells what is held"],
      [{ quantity: 1, isin: ONE }, "not both"],
      [{ quantity: 1, market: "US" }, "market is a fund's"],
      [{ symbol: `fund:${ONE}`, isin: ONE, quantity: 1 }, "isin or symbol"],
      [{ symbol: undefined, quantity: 1 }, "add names symbol"],
      [{ position: 1, quantity: 1 }, "unknown argument position"],
    ];
    for (const [more, words] of refused) {
      const r = await tool(m, "portfolio_trade", {
        action: "add",
        symbol: "US:AAA",
        side: "buy",
        price: 1,
        ...more,
      });
      expect([more, r.body.message]).toEqual([
        more,
        expect.stringContaining(words),
      ]);
    }
  });
});

describe("portfolio_cash", () => {
  test("lands in Cash, its row picked by position and answered as position", async () => {
    const { m } = await setup();
    const made = await cash(m, { dry_powder: true });
    expect(made.body.position).toMatchObject({
      portfolio: "Cash",
      dry_powder: true,
    });
    const first = made.body.position.position as number;
    expect("id" in made.body.position).toBe(false);
    const noted = await tool(m, "portfolio_cash", {
      action: "update",
      position: first,
      note: "made-up note",
    });
    const now = noted.body.position.position as number;
    expect(noted.body.position).toMatchObject({
      replaces: first,
      note: "made-up note",
    });
    // a stale position names the row that replaced it
    const stale = await tool(m, "portfolio_cash", {
      action: "update",
      position: first,
      note: "x",
    });
    expect(stale.body).toEqual({
      error: "conflict",
      message: `position ${first} was updated; it is position ${now} now`,
    });
    const removedStale = await tool(m, "portfolio_cash", {
      action: "remove",
      position: first,
    });
    expect(removedStale.body.error).toBe("conflict");
    // an unknown one lists Cash's rows
    const unknown = await tool(m, "portfolio_cash", {
      action: "update",
      position: 999,
      note: "x",
    });
    expect(unknown.body).toEqual({
      error: "not_found",
      message: `no cash row at position 999; Cash holds ${now} (Savings, North, EUR, dry powder)`,
    });
    // dry powder is a flag on the row, never a way to pick it
    const literal = await tool(m, "portfolio_cash", {
      action: "update",
      position: "dry_powder",
      note: "x",
    });
    expect(literal.body.message).toContain("position must be an id");
  });

  test("a removed row says so until restored; a second removal is kept", async () => {
    const { m } = await setup();
    const id = (await cash(m)).body.position.position as number;
    const remove = () =>
      tool(m, "portfolio_cash", { action: "remove", position: id });
    expect((await remove()).body.position.removed_by).toBe("casey-agent");
    expect((await remove()).error).toBe(false);
    const update = await tool(m, "portfolio_cash", {
      action: "update",
      position: id,
      amount: 5,
    });
    expect(update.body).toEqual({
      error: "not_found",
      message: `position ${id} was removed; restore brings it back; Cash holds none`,
    });
    const back = await tool(m, "portfolio_cash", {
      action: "restore",
      position: id,
    });
    expect(back.body.position).toMatchObject({
      position: id,
      removed_at: null,
    });
  });

  test("names at most ten rows, then how many more", async () => {
    const { m } = await setup();
    for (let k = 0; k < 12; k++) await cash(m, { name: `Spare ${k}` });
    const r = await tool(m, "portfolio_cash", {
      action: "update",
      position: 999,
      note: "x",
    });
    expect(r.body.message.split("(").length - 1).toBe(10);
    expect(r.body.message).toEndWith(", and 2 more");
  });

  test("a bond's position is refused, naming the bond tool", async () => {
    const { m } = await setup();
    const b = (await bond(m)).body.position.position as number;
    for (const action of ["update", "remove", "restore"]) {
      const r = await tool(m, "portfolio_cash", {
        action,
        position: b,
        ...(action === "update" ? { note: "x" } : {}),
      });
      expect(r.body).toEqual({
        error: "bad_arguments",
        message: `position ${b} is a bond; portfolio_bond changes it`,
      });
    }
  });

  test("takes only its own arguments", async () => {
    const { m } = await setup();
    for (const [args, words] of [
      [{ action: "update", position: 1, cost: 5 }, "unknown argument cost"],
      [{ action: "add", portfolio: "Cash" }, "unknown argument portfolio"],
      [{ action: "update", position: 1 }, "amount, by, date, note"],
    ] as const) {
      const r = await tool(m, "portfolio_cash", args);
      expect([args, r.body.message]).toEqual([
        args,
        expect.stringContaining(words),
      ]);
    }
  });
});

describe("portfolio_bond", () => {
  test("adds and updates a bond; coupon and maturity never change", async () => {
    const { m } = await setup();
    const made = await bond(m);
    expect(made.body.position).toMatchObject({
      portfolio: "Shares",
      coupon: 4.5,
      as_of: "2026-03-02",
    });
    const id = made.body.position.position as number;
    const up = await tool(m, "portfolio_bond", {
      action: "update",
      position: id,
      amount: 2000,
      cost: 1950,
      name: "Made Up 2030 B",
    });
    expect(up.body.position).toMatchObject({
      amount: 2000,
      cost: 1950,
      name: "Made Up 2030 B",
      replaces: id,
    });
    // currency names the amount's, converted when not the bond's
    const named = await tool(m, "portfolio_bond", {
      action: "update",
      position: up.body.position.position,
      amount: 2000,
      currency: "EUR",
    });
    expect(named.error).toBe(false);
    up.body.position = named.body.position;
    const coupon = await tool(m, "portfolio_bond", {
      action: "update",
      position: up.body.position.position,
      coupon: 5,
    });
    expect(coupon.body.message).toBe("coupon is not an argument of update");
    const c = (await cash(m)).body.position.position as number;
    const onCash = await tool(m, "portfolio_bond", {
      action: "update",
      position: c,
      amount: 1,
    });
    expect(onCash.body.message).toBe(
      `position ${c} is cash; portfolio_cash changes it`,
    );
    const unknown = await tool(m, "portfolio_bond", {
      action: "remove",
      position: 999,
    });
    expect(unknown.body.message).toBe(
      `no bond at position 999; bonds kept: ${up.body.position.position} (Made Up 2030 B, EUR)`,
    );
  });
});

describe("portfolio_fund", () => {
  test("picks a fund by isin, its key or its name; with a pick, name renames", async () => {
    const { m } = await setup();
    await tool(m, "portfolio_trade", {
      action: "add",
      isin: ONE,
      name: "Made Up Fund",
      side: "buy",
      quantity: 10,
      price: 5,
      currency: "EUR",
      date: "2026-01-05",
    });
    const byKey = await tool(m, "portfolio_fund", {
      symbol: `fund:${ONE}`,
      price: 6,
      date: "2026-01-06",
    });
    expect(byKey.body.price).toEqual({ date: "2026-01-06", price: 6 });
    const byName = await tool(m, "portfolio_fund", {
      name: "Made Up Fund",
      price: 7,
      date: "2026-01-07",
    });
    expect(byName.body.fund.price).toBe(7);
    const renamed = await tool(m, "portfolio_fund", {
      isin: ONE,
      name: "Made Up Growth Fund",
    });
    expect(renamed.body).toMatchObject({
      fund: { name: "Made Up Growth Fund" },
      renamed_from: "Made Up Fund",
    });
    for (const [args, words] of [
      [{ symbol: "US:AAA", price: 1 }, "symbol is a fund's key"],
      [{ symbol: `fund:${ONE}`, isin: ONE, price: 1 }, "not both"],
      [{ price: 1 }, "name the fund by isin, symbol or name"],
    ] as const) {
      const r = await tool(m, "portfolio_fund", args);
      expect([args, r.body.message]).toEqual([
        args,
        expect.stringContaining(words),
      ]);
    }
  });
});

describe("portfolio holdings", () => {
  test("answer symbol over MCP, id over REST", async () => {
    const { m } = await setup();
    await tool(m, "portfolio_trade", {
      action: "add",
      symbol: "US:AAA",
      side: "buy",
      quantity: 3,
      price: 100,
      date: "2026-01-05",
    });
    await cash(m);
    const read = await tool(m, "portfolio", { action: "holdings" });
    const rows = read.body.holdings as Record<string, unknown>[];
    expect(rows.map((r) => [r.kind, r.symbol, "id" in r])).toEqual([
      ["cash", null, false],
      ["holding", "US:AAA", false],
    ]);
    expect(rows[0]!.position).toBeNumber();
    const rest = await api(m)(
      new Request("http://markets.test/api/v1/holdings", {
        headers: { authorization: `Bearer ${ADMIN_KEY}` },
      }),
    );
    const body = (await rest.json()) as { holdings: Record<string, unknown>[] };
    expect(body.holdings.map((r) => [r.id, "symbol" in r])).toEqual([
      [null, false],
      ["US:AAA", false],
    ]);
  });

  test("removed true lists cash and bonds removed and not replaced, never counted", async () => {
    const { m } = await setup();
    const kept = (await cash(m)).body.position.position as number;
    const updated = await tool(m, "portfolio_cash", {
      action: "update",
      position: kept,
      amount: 150,
    });
    const gone = (await cash(m, { name: "Old", broker: "South" })).body.position
      .position as number;
    await tool(m, "portfolio_cash", { action: "remove", position: gone });
    const b = (await bond(m)).body.position.position as number;
    await tool(m, "portfolio_bond", { action: "remove", position: b });

    const plain = await tool(m, "portfolio", { action: "holdings" });
    expect("removed" in plain.body).toBe(false);
    const read = await tool(m, "portfolio", {
      action: "holdings",
      removed: true,
    });
    expect(
      read.body.removed.map((r: Record<string, unknown>) => [
        r.position,
        r.kind,
        r.name,
        r.broker,
        r.currency,
      ]),
    ).toEqual([
      [b, "bond", "Made Up 2030", null, "EUR"],
      [gone, "cash", "Old", "South", "EUR"],
    ]);
    expect(read.body.removed[0].removed_at).toBeString();
    expect(JSON.stringify(read.body.removed)).not.toContain("amount");
    expect(read.body.totals).toEqual(plain.body.totals);
    expect(
      read.body.holdings.map((r: { position: number }) => r.position),
    ).toEqual([updated.body.position.position]);
    // scoped as the holdings are
    const north = await tool(m, "portfolio", {
      action: "holdings",
      broker: "North",
      removed: true,
    });
    expect(north.body.removed).toEqual([]);
  });
});

describe("a cash row's maturity and history", () => {
  test("a term deposit's maturity is set, rolled over and taken off", async () => {
    const { m } = await setup();
    const made = await cash(m, { maturity: "2027-01-15" });
    expect(made.body.position.maturity).toBe("2027-01-15");
    let at = made.body.position.position as number;
    const rolled = await tool(m, "portfolio_cash", {
      action: "update",
      position: at,
      maturity: "2027-07-15",
    });
    expect(rolled.body.position.maturity).toBe("2027-07-15");
    at = rolled.body.position.position as number;
    const read = await tool(m, "portfolio", { action: "holdings" });
    const row = (read.body.holdings as Record<string, unknown>[]).find(
      (x) => x.position === at,
    );
    expect(row?.maturity).toBe("2027-07-15");
    const off = await tool(m, "portfolio_cash", {
      action: "update",
      position: at,
      maturity: null,
    });
    expect(off.body.position.maturity).toBeNull();
    const plain = await tool(m, "portfolio", { action: "holdings" });
    const kept = (plain.body.holdings as Record<string, unknown>[]).find(
      (x) => x.kind === "cash",
    );
    expect(kept && "maturity" in kept).toBe(false);
  });

  test("a bond's maturity never changes on update", async () => {
    const { m } = await setup();
    const at = (await bond(m)).body.position.position as number;
    const moved = await tool(m, "portfolio_bond", {
      action: "update",
      position: at,
      maturity: "2031-01-01",
    });
    expect(moved.body.error).toBe("bad_arguments");
  });

  test("history reads the chain oldest first, removals by hand marked", async () => {
    const { m } = await setup();
    const first = (await cash(m)).body.position.position as number;
    const up = await tool(m, "portfolio_cash", {
      action: "update",
      position: first,
      by: 50,
    });
    const second = up.body.position.position as number;
    const noted = await tool(m, "portfolio_cash", {
      action: "update",
      position: second,
      note: "made-up note",
    });
    const third = noted.body.position.position as number;
    await tool(m, "portfolio_cash", { action: "remove", position: third });
    const read = await tool(m, "portfolio", {
      action: "history",
      position: second,
    });
    expect(read.body.position).toBe(second);
    const rows = read.body.history as Record<string, unknown>[];
    expect(rows.map((r) => [r.position, r.amount, r.note, r.removed])).toEqual([
      [first, 100, null, false],
      [second, 150, null, false],
      [third, 150, "made-up note", true],
    ]);
    // what was set, never who set it
    expect(rows.every((r) => !("entered_by" in r))).toBe(true);
    expect(rows[0]).toMatchObject({
      currency: "EUR",
      broker: "North",
      dry_powder: false,
    });
    const none = await tool(m, "portfolio", {
      action: "history",
      position: 999,
    });
    expect(none.body.error).toBe("not_found");
    // a restore of the first row sets the newer ones aside, undone
    await tool(m, "portfolio_cash", { action: "restore", position: first });
    const back = await tool(m, "portfolio", {
      action: "history",
      position: first,
    });
    expect(
      (back.body.history as Record<string, unknown>[]).map((r) => [
        r.position,
        r.removed,
        r.undone ?? false,
      ]),
    ).toEqual([
      [first, false, false],
      [second, false, true],
      [third, false, true],
    ]);
    const wrong = await tool(m, "portfolio", {
      action: "history",
      position: first,
      symbol: "US:AAA",
    });
    expect(wrong.body.message).toContain("is not an argument of history");
  });
});
