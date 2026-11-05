// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { parseAlertsEdit, parseAlertsRead } from "../src/operations/alerts.ts";
import {
  parseBondTool,
  parseCashTool,
  parseFundTool,
  parsePortfolioRead,
  parseTradeTool,
} from "../src/tools/portfolio.ts";

const asText = (input: Record<string, unknown>, names: string[]) =>
  Object.fromEntries(
    Object.entries(input).map(([k, v]) => [
      k,
      names.includes(k) ? String(v) : v,
    ]),
  );

describe("write arguments sent as text", () => {
  const cases: [
    string,
    (input: unknown) => unknown,
    Record<string, unknown>,
    string[],
  ][] = [
    [
      "a trade",
      parseTradeTool,
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
      parseTradeTool,
      { action: "add", symbol: "AAA", side: "sell", quantity: 1, total: 99 },
      ["quantity", "total"],
    ],
    [
      "a sell of all",
      parseTradeTool,
      { action: "add", symbol: "AAA", side: "sell", all: true },
      ["all"],
    ],
    [
      "a fund",
      parseTradeTool,
      {
        action: "add",
        isin: "ZZFUND000011",
        side: "buy",
        quantity: 10,
        price: 5,
      },
      ["quantity", "price"],
    ],
    [
      "cash",
      parseCashTool,
      {
        action: "add",
        name: "Kept",
        currency: "EUR",
        amount: 100,
        dry_powder: true,
      },
      ["amount", "dry_powder"],
    ],
    [
      "a bond",
      parseBondTool,
      {
        action: "add",
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
      parseCashTool,
      { action: "update", position: 7, by: -5, dry_powder: false },
      ["position", "by", "dry_powder"],
    ],
    [
      "an update of an amount",
      parseBondTool,
      { action: "update", position: 7, amount: 120, cost: 3 },
      ["position", "amount", "cost"],
    ],
    [
      "a fund's price",
      parseFundTool,
      { isin: "ZZFUND000011", price: 6.5 },
      ["price"],
    ],
    [
      "a trade removed",
      parseTradeTool,
      { action: "remove", trade: 12 },
      ["trade"],
    ],
    [
      "a position restored",
      parseCashTool,
      { action: "restore", position: 3 },
      ["position"],
    ],
    [
      "trades with removed ones",
      parsePortfolioRead,
      { action: "trades", removed: true },
      ["removed"],
    ],
  ];
  for (const [name, parse, input, names] of cases) {
    test(`${name} reads as its values`, () => {
      expect(parse(asText(input, names))).toEqual(parse(input));
    });
  }

  test("text that is not a value is refused in the same words", () => {
    const refused: [(input: unknown) => unknown, object, string][] = [
      [
        parseTradeTool,
        { action: "add", symbol: "AAA", side: "buy", quantity: "ten" },
        "quantity must be a number",
      ],
      [
        parseCashTool,
        { action: "update", position: "1.5", note: "x" },
        "position must be",
      ],
      [parseTradeTool, { action: "remove", trade: "-3" }, "trade must be"],
      [
        parseTradeTool,
        {
          action: "add",
          symbol: "AAA",
          side: "buy",
          quantity: 1,
          again: "yes",
        },
        "again must be true or false",
      ],
      [
        parseTradeTool,
        { action: "add", symbol: "AAA", side: "sell", quantity: "all" },
        "a sell of all is all: true",
      ],
    ];
    for (const [parse, input, words] of refused) {
      expect(() => parse(input)).toThrow(words);
    }
  });

  test("an alert's id and history as text", () => {
    expect(parseAlertsEdit({ action: "pause", id: "4" })).toEqual(
      parseAlertsEdit({ action: "pause", id: 4 }),
    );
    expect(parseAlertsEdit({ action: "delete", id: "4" })).toEqual(
      parseAlertsEdit({ action: "delete", id: 4 }),
    );
    expect(parseAlertsRead({ history: "true", id: "4" })).toEqual(
      parseAlertsRead({ history: true, id: 4 }),
    );
  });

  test("an alert's id that is not one is refused", () => {
    expect(() => parseAlertsEdit({ action: "delete", id: "4a" })).toThrow(
      "id must be an alert id",
    );
    expect(() => parseAlertsRead({ history: "yes" })).toThrow(
      "history must be true or false",
    );
  });
});
