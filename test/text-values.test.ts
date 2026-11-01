// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import {
  DRY_POWDER_CHANGES,
  DRY_POWDER_PICK,
  parsePortfolio,
  UPDATE_TARGET,
} from "../src/operations/portfolio.ts";
import { parseRules } from "../src/operations/rules.ts";

const asText = (input: Record<string, unknown>, names: string[]) =>
  Object.fromEntries(
    Object.entries(input).map(([k, v]) => [
      k,
      names.includes(k) ? String(v) : v,
    ]),
  );

describe("write arguments sent as text", () => {
  const cases: [string, Record<string, unknown>, string[]][] = [
    [
      "a trade",
      {
        action: "add",
        symbol: "AAA",
        side: "buy",
        quantity: 2.5,
        price: 100,
        fees: 1,
        date: "2026-01-02",
        again: true,
      },
      ["quantity", "price", "fees", "again"],
    ],
    [
      "a trade by total",
      { action: "add", symbol: "AAA", side: "sell", quantity: 1, total: 99 },
      ["quantity", "total"],
    ],
    [
      "a fund",
      {
        action: "add",
        kind: "fund",
        isin: "ZZFUND000011",
        side: "buy",
        units: 10,
        price: 5,
      },
      ["units", "price"],
    ],
    [
      "cash",
      {
        action: "add",
        kind: "cash",
        name: "Kept",
        currency: "EUR",
        amount: 100,
        dry_powder: true,
      },
      ["amount", "dry_powder"],
    ],
    [
      "a bond",
      {
        action: "add",
        kind: "bond",
        name: "Bond",
        currency: "EUR",
        amount: 1000,
        coupon: 5.5,
        cost: 990,
        maturity: "2030-01-02",
      },
      ["amount", "coupon", "cost"],
    ],
    [
      "an update by position",
      { action: "update", position: 7, by: -5, dry_powder: false },
      ["position", "by", "dry_powder"],
    ],
    [
      "an update of an amount",
      { action: "update", position: 7, amount: 120, cost: 3 },
      ["position", "amount", "cost"],
    ],
    [
      "a fund's price",
      { action: "update", isin: "ZZFUND000011", price: 6.5 },
      ["price"],
    ],
    ["a trade removed", { action: "remove", trade: 12 }, ["trade"]],
    ["a position restored", { action: "restore", position: 3 }, ["position"]],
    [
      "trades with removed ones",
      { action: "trades", removed: true },
      ["removed"],
    ],
  ];
  for (const [name, input, names] of cases) {
    test(`${name} reads as its values`, () => {
      expect(parsePortfolio(asText(input, names))).toEqual(
        parsePortfolio(input),
      );
    });
  }

  test("text that is not a value is refused in the same words", () => {
    const refused: [Record<string, unknown>, string][] = [
      [
        { action: "add", symbol: "AAA", side: "buy", quantity: "ten" },
        "quantity must be a number",
      ],
      [{ action: "update", position: "1.5", note: "x" }, "position must be"],
      [{ action: "remove", trade: "-3" }, "trade must be"],
      [
        {
          action: "add",
          symbol: "AAA",
          side: "buy",
          quantity: 1,
          again: "yes",
        },
        "again must be true or false",
      ],
    ];
    for (const [input, words] of refused) {
      expect(() => parsePortfolio(input)).toThrow(words);
    }
  });

  test("a sell of all is still all", () => {
    expect(
      parsePortfolio({
        action: "add",
        symbol: "AAA",
        side: "sell",
        quantity: "all",
      }),
    ).toMatchObject({ trade: { quantity: "all" } });
  });

  test("currency alone picks the dry powder row; with by it is the amount's", () => {
    expect(
      parsePortfolio({
        action: "update",
        position: "dry_powder",
        broker: "North",
        currency: "EUR",
        note: "kept",
      }),
    ).toEqual({
      action: "update",
      position: "dry_powder",
      portfolio: null,
      currency: "EUR",
      change: { note: "kept", broker: "North" },
    });
    expect(
      parsePortfolio({
        action: "update",
        position: "dry_powder",
        currency: "USD",
        by: 5,
      }),
    ).toMatchObject({
      currency: null,
      change: { by: { amount: 5, currency: "USD" } },
    });
  });

  test("a dry powder pick that changes nothing names what it can change", () => {
    expect(() =>
      parsePortfolio({
        action: "update",
        position: "dry_powder",
        broker: "North",
        currency: "EUR",
      }),
    ).toThrow(DRY_POWDER_CHANGES);
    expect(DRY_POWDER_CHANGES).not.toContain("name");
    // a price or a market keeps its own refusal
    expect(() =>
      parsePortfolio({
        action: "update",
        position: "dry_powder",
        market: "US",
      }),
    ).toThrow("cash has no market");
  });

  test("an update with no position says what picks the row", () => {
    expect(() => parsePortfolio({ action: "update", note: "x" })).toThrow(
      UPDATE_TARGET,
    );
    expect(() =>
      parsePortfolio({
        action: "update",
        dry_powder: true,
        broker: "North",
        currency: "EUR",
        note: "x",
      }),
    ).toThrow(DRY_POWDER_PICK);
  });

  test("a rule's id, paused and condition as text", () => {
    expect(parseRules({ action: "pause", id: "4", paused: "true" })).toEqual(
      parseRules({ action: "pause", id: 4, paused: true }),
    );
    expect(parseRules({ action: "delete", id: "4" })).toEqual(
      parseRules({ action: "delete", id: 4 }),
    );
    const condition = {
      all: [
        { left: "rsi14", op: "<", right: 30 },
        { left: "price", op: ">", right: "sma200" },
      ],
    };
    const native = parseRules({ action: "create", symbol: "AAA", condition });
    expect(
      parseRules({
        action: "create",
        symbol: "AAA",
        condition: JSON.stringify(condition),
      }),
    ).toEqual(native);
    expect(
      parseRules({
        action: "create",
        symbol: "AAA",
        condition: {
          all: [
            { left: "rsi14", op: "<", right: "30" },
            { left: "price", op: ">", right: "sma200" },
          ],
        },
      }),
    ).toEqual(native);
  });

  test("a condition as text over the size limit is refused before parsing", () => {
    const deep = `${'{"all":['.repeat(5000)}{"left":"price","op":">","right":1}${"]}".repeat(5000)}`;
    expect(() =>
      parseRules({ action: "create", symbol: "AAA", condition: deep }),
    ).toThrow("condition is longer than");
  });

  test("a rule's id that is not one is refused", () => {
    expect(() => parseRules({ action: "delete", id: "4a" })).toThrow(
      "id must be a rule id",
    );
    expect(() => parseRules({ action: "pause", id: 4, paused: "yes" })).toThrow(
      "paused must be true or false",
    );
  });
});
