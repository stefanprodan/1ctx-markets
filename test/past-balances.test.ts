// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// Cash balances dated before their row's day: kept beside the row through
// the tool, read back as a day's balance. Made-up names and amounts only.

import { describe, expect, test } from "bun:test";
import {
  createBroker,
  historyOf,
  rowHistory,
  saveSettings,
} from "../src/operations/portfolio.ts";
import { OPERATOR, type Who } from "../src/operations/who.ts";
import { balanceOn, counted, type Entry } from "../src/portfolios/balances.ts";
import {
  entriesOf,
  readPosition,
  readPositions,
} from "../src/portfolios/store.ts";
import { plainError } from "../src/web/data/portfolios.ts";
import { ask } from "./helpers/portfolio.ts";
import { world } from "./helpers/world.ts";

const CASEY: Who = {
  name: "casey-agent",
  user: OPERATOR,
  credential: { kind: "key", id: "casey-agent" },
  portfolio: "write",
  alerts: "none",
  profile: "none",
  analysis: "none",
};
const HOUR = 3_600_000;

// the fake clock's day, the row's own
const TODAY = "2026-10-23";

async function setup() {
  const w = world();
  await saveSettings(w.m, OPERATOR, { display_currency: "EUR" });
  await createBroker(w.m, OPERATOR, { name: "North" });
  await createBroker(w.m, OPERATOR, { name: "South" });
  const cash = async (args: object) => {
    await w.clock.advance(HOUR);
    return ask(w.m, CASEY, "portfolio_cash", args);
  };
  const added = await cash({
    action: "add",
    name: "Savings",
    amount: 1000,
    currency: "EUR",
    broker: "North",
  });
  const id: number = added.body.position.position;
  const balance = (at: number, day: string) =>
    balanceOn(counted(entriesOf(w.db, OPERATOR, at)), day)?.amount ?? null;
  return { ...w, cash, id, balance };
}

describe("a past balance", () => {
  test("is kept beside the row and never changes it", async () => {
    const s = await setup();
    const before = readPosition(s.db, OPERATOR, s.id)!;
    const r = await s.cash({
      action: "update",
      position: s.id,
      amount: 700,
      date: "2026-10-01",
    });
    expect(r.error).toBe(false);
    expect(r.body.replaced).toBeNull();
    expect(r.body.position).toMatchObject({
      amount: 700,
      as_of: "2026-10-01",
      past: true,
    });
    expect(readPosition(s.db, OPERATOR, s.id)).toEqual(before);
    // never a live row of its own
    expect(readPositions(s.db, OPERATOR).map((p) => p.id)).toEqual([s.id]);
    expect(s.balance(s.id, "2026-09-30")).toBeNull();
    expect(s.balance(s.id, "2026-10-01")).toBe(700);
    expect(s.balance(s.id, "2026-10-22")).toBe(700);
    expect(s.balance(s.id, TODAY)).toBe(1000);
  });

  test("added again for an earlier day is a past balance", async () => {
    const s = await setup();
    const before = readPosition(s.db, OPERATOR, s.id)!;
    const again = {
      action: "add",
      name: "Savings",
      currency: "EUR",
      broker: "North",
      date: "2026-10-01",
    };
    const r = await s.cash({ ...again, amount: 700 });
    expect(r.error).toBe(false);
    expect(r.body.replaced).toBeNull();
    expect(r.body.position).toMatchObject({
      amount: 700,
      as_of: "2026-10-01",
      past: true,
    });
    expect(readPosition(s.db, OPERATOR, s.id)).toEqual(before);
    expect(readPositions(s.db, OPERATOR).map((p) => p.id)).toEqual([s.id]);
    expect(s.balance(s.id, "2026-10-01")).toBe(700);
    expect(s.balance(s.id, TODAY)).toBe(1000);
    const refused = await s.cash({ ...again, amount: 700, note: "made-up" });
    expect([refused.error, refused.body.message]).toEqual([
      true,
      "a date before the row's own day takes only amount: its balance that day",
    ]);
    expect(entriesOf(s.db, OPERATOR, s.id)).toHaveLength(2);
  });

  test("on or after the row's day is an update as before", async () => {
    const s = await setup();
    const r = await s.cash({
      action: "update",
      position: s.id,
      amount: 1200,
      date: TODAY,
    });
    expect(r.body.replaced).toBe(s.id);
    expect(r.body.position.past).toBeUndefined();
  });

  test("takes only amount", async () => {
    const s = await setup();
    for (const more of [
      { by: -100 },
      { amount: 700, note: "made-up note" },
      { amount: 700, name: "Rainy day" },
      { amount: 700, broker: "South" },
      { amount: 700, dry_powder: true },
      { amount: 700, currency: "USD" },
      {},
    ]) {
      const r = await s.cash({
        action: "update",
        position: s.id,
        date: "2026-10-01",
        ...more,
      });
      expect([more, r.error, r.body.message]).toEqual([
        more,
        true,
        "a date before the row's own day takes only amount: its balance that day",
      ]);
    }
    expect(entriesOf(s.db, OPERATOR, s.id)).toHaveLength(1);
  });

  test("a refusal reads plainly on the page", () => {
    expect(
      plainError(
        "A date before the row's own day takes only amount: its balance that day.",
      ),
    ).toBe("An earlier day takes only a balance. Use Add a past balance.");
    expect(
      plainError(
        "A past balance never changes: remove it, or add another for its day.",
      ),
    ).toBe("A past balance never changes. Add another for its day.");
  });

  test("is never updated itself", async () => {
    const s = await setup();
    const past = (
      await s.cash({
        action: "update",
        position: s.id,
        amount: 700,
        date: "2026-10-01",
      })
    ).body.position.position;
    const r = await s.cash({ action: "update", position: past, amount: 800 });
    expect(r.error).toBe(true);
    expect(r.body.message).toContain("a past balance never changes");
  });

  test("stays with the account through an update, a rename and a broker move", async () => {
    const s = await setup();
    await s.cash({
      action: "update",
      position: s.id,
      amount: 700,
      date: "2026-10-01",
    });
    const up = async (position: number, change: object) =>
      (await s.cash({ action: "update", position, ...change })).body.position
        .position as number;
    const a = await up(s.id, { amount: 1100 });
    const b = await up(a, { name: "Rainy day" });
    const c = await up(b, { broker: "South" });
    expect(s.balance(c, "2026-10-05")).toBe(700);
    expect(s.balance(c, TODAY)).toBe(1100);
    // a past balance entered on the newest row reads with the oldest too
    await up(c, { amount: 650, date: "2026-10-09" });
    expect(s.balance(s.id, "2026-10-12")).toBe(650);
    expect(readPosition(s.db, OPERATOR, c)?.amount).toBe(1100);
  });

  test("is removed and restored as a row, the account left alone", async () => {
    const s = await setup();
    const past = (
      await s.cash({
        action: "update",
        position: s.id,
        amount: 700,
        date: "2026-10-01",
      })
    ).body.position.position;
    const removed = await s.cash({ action: "remove", position: past });
    expect(removed.body.position.removed_by).toBe("casey-agent");
    expect(s.balance(s.id, "2026-10-05")).toBeNull();
    const back = await s.cash({ action: "restore", position: past });
    expect(back.body.position.removed_at).toBeNull();
    expect(s.balance(s.id, "2026-10-05")).toBe(700);
    // the row it was entered on stays live
    expect(readPosition(s.db, OPERATOR, s.id)?.removedAt).toBeNull();
  });

  test("is in the history, marked", async () => {
    const s = await setup();
    const past = (
      await s.cash({
        action: "update",
        position: s.id,
        amount: 700,
        date: "2026-10-01",
      })
    ).body.position.position;
    const api = historyOf(s.m, OPERATOR, s.id) as {
      history: { id: number; past?: boolean }[];
    };
    expect(api.history.map((r) => [r.id, r.past ?? false])).toEqual([
      [past, true],
      [s.id, false],
    ]);
    // a past balance's own id answers its account's history
    expect(historyOf(s.m, OPERATOR, past) as object).toEqual(api);
    const tool = await ask(s.m, CASEY, "portfolio", {
      action: "history",
      position: s.id,
    });
    expect(tool.body.history).toMatchObject([
      { position: s.id, amount: 1000, removed: false },
      { position: past, amount: 700, date: "2026-10-01", past: true },
    ]);
    expect(rowHistory(s.m, OPERATOR, past)).toMatchObject({ position: s.id });
  });
});

describe("a day's balance", () => {
  const e = (
    id: number,
    asOf: string,
    amount: number,
    enteredAt: number,
  ): Entry => ({
    id,
    asOf,
    amount,
    enteredAt,
    replaces: null,
    pastOf: null,
    removedAt: null,
  });

  test("is the latest entry on or before it", () => {
    const all = [e(1, "2026-03-01", 10, 1), e(2, "2026-01-01", 5, 2)];
    expect(balanceOn(all, "2025-12-31")).toBeNull();
    expect(balanceOn(all, "2026-01-01")?.amount).toBe(5);
    expect(balanceOn(all, "2026-02-28")?.amount).toBe(5);
    expect(balanceOn(all, "2026-03-01")?.amount).toBe(10);
  });

  test("on a tie is the one entered last", () => {
    const all = [
      e(3, "2026-02-01", 30, 5),
      e(1, "2026-02-01", 10, 9),
      e(2, "2026-02-01", 20, 9),
    ];
    expect(balanceOn(all, "2026-02-01")?.amount).toBe(20);
  });

  test("leaves out removed past balances and rows a restore undid", () => {
    const all: Entry[] = [
      // 100, a mistyped 900 over it, then the 100 restored
      e(1, "2026-01-01", 100, 1),
      { ...e(2, "2026-01-05", 900, 2), replaces: 1, removedAt: 4 },
      { ...e(3, "2025-12-02", 50, 5), pastOf: 1 },
      { ...e(4, "2025-12-15", 70, 6), pastOf: 1, removedAt: 7 },
    ];
    expect(counted(all).map((x) => x.id)).toEqual([1, 3]);
    expect(balanceOn(counted(all), "2025-12-20")?.amount).toBe(50);
    expect(balanceOn(counted(all), "2026-01-06")?.amount).toBe(100);
  });
});
