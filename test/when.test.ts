// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import {
  FIELD_NAMES,
  parseWhenCondition,
  RuleError,
  whenText,
} from "../src/rules/format.ts";
import {
  MAX_SYMBOL,
  MAX_WHEN,
  parseWhen,
  renderWhen,
  WHEN_FIELD_NAMES,
  WHEN_FIELDS,
  WhenError,
  whenComparisons,
} from "../src/shared/when.ts";

const cmp = (field: string, op: string, right: unknown): any => ({
  left: { field, symbol: null },
  op,
  right,
});

describe("when", () => {
  test("reads every operator, a number either side, and a field on the right", () => {
    for (const op of ["<", "<=", ">", ">="]) {
      expect(parseWhen(`price ${op} 180`)).toEqual(cmp("price", op, 180));
    }
    // a number on the left turns the comparison round
    expect(parseWhen("180 > price")).toEqual(cmp("price", "<", 180));
    expect(parseWhen("180 <= price")).toEqual(cmp("price", ">=", 180));
    expect(parseWhen("price > sma200")).toEqual(
      cmp("price", ">", { field: "sma200", symbol: null }),
    );
    expect(parseWhen("move_atr < -2.5")).toEqual(cmp("move_atr", "<", -2.5));
    expect(parseWhen("price < 1e3")).toEqual(cmp("price", "<", 1000));
    // spacing and case of the words do not matter
    expect(parseWhen("  PRICE<1   AND rsi14>2 ")).toEqual(
      parseWhen("price < 1 and rsi14 > 2"),
    );
  });

  test("and binds before or, and parentheses group", () => {
    const a = cmp("price", "<", 1);
    const b = cmp("price", "<", 2);
    const c = cmp("price", "<", 3);
    expect(parseWhen("price < 1 or price < 2 and price < 3")).toEqual({
      any: [a, { all: [b, c] }],
    });
    expect(parseWhen("price < 1 and price < 2 or price < 3")).toEqual({
      any: [{ all: [a, b] }, c],
    });
    expect(parseWhen("(price < 1 or price < 2) and price < 3")).toEqual({
      all: [{ any: [a, b] }, c],
    });
    expect(parseWhen("price < 1 and price < 2 and price < 3")).toEqual({
      all: [a, b, c],
    });
    expect(parseWhen("((price < 1))")).toEqual(a);
  });

  test("reads another symbol and a benchmark as written", () => {
    expect(parseWhen("price(^VIX) > 25")).toEqual({
      left: { field: "price", symbol: "^VIX" },
      op: ">",
      right: 25,
    });
    for (const s of ["VWCE.DE", "XETRA:VVSM", "EURUSD=X", "BRK-B"]) {
      expect(parseWhen(`price( ${s} ) < 1`)).toMatchObject({
        left: { symbol: s },
      });
    }
    expect(parseWhen("relative_return_1m(QQQ) < -5")).toEqual({
      left: { field: "relative_return_1m", symbol: null, benchmark: "QQQ" },
      op: "<",
      right: -5,
    });
    expect(parseWhen("relative_return_3m(FRED:DGS10, ^GSPC) < -5")).toEqual({
      left: {
        field: "relative_return_3m",
        symbol: "FRED:DGS10",
        benchmark: "^GSPC",
      },
      op: "<",
      right: -5,
    });
  });

  test("refuses with the token, its position and the near field", () => {
    const bad: [string, string][] = [
      ["", "when is empty"],
      ["rsi < 30", "unknown field rsi at 1; did you mean rsi14?"],
      [
        "changePct < 2",
        "unknown field changePct at 1; did you mean change_percent?",
      ],
      ["sma_50 > 1", "unknown field sma_50 at 1; did you mean sma50?"],
      [
        "price < 1 and volume > 2",
        "unknown field volume at 15; did you mean volume_ratio?",
      ],
      ["price = 3", "unknown operator = at 7; use < <= > or >="],
      ["price == 3", "unknown operator == at 7"],
      ["price 3", "expected < <= > or >= at 7, found 3"],
      ["(price < 1", "( at 1 is not closed: expected ) at 11, found the end"],
      ["price(^VIX < 1", "( at 6 is not closed"],
      ["price < 1 and", "expected a field or a number at 14, found the end"],
      ["price < and", "expected a field or a number at 9, found and"],
      ["1 < 2", "the comparison at 1 compares two numbers"],
      ["price < 1 price < 2", "expected and, or or the end at 11, found price"],
      [
        "relative_return_1m < 1",
        "relative_return_1m at 1 needs a benchmark: relative_return_1m(QQQ)",
      ],
      [
        "relative_return_1m(A, B, C) < 1",
        "takes a benchmark, or a symbol and a benchmark",
      ],
      ["price(A, B) < 1", "price at 1 takes one symbol"],
      ["price( ) < 1", "expected a symbol at 7"],
      [
        `price(${"X".repeat(MAX_SYMBOL + 1)}) < 1`,
        `longer than ${MAX_SYMBOL} characters`,
      ],
      ["price < 1e16", "number 1e16 at 9 is out of range"],
      [
        "price < 1 and (price < 2 or (price < 3 and price < 4))",
        "conditions nest at most 3 levels; the one at 30 is deeper",
      ],
      [
        Array(9).fill("price < 1").join(" and "),
        "at most 8 comparisons; one more starts at 113",
      ],
      [
        `price < ${"1".repeat(MAX_WHEN)}`,
        `when is longer than ${MAX_WHEN} characters`,
      ],
    ];
    for (const [text, message] of bad) {
      expect(() => parseWhen(text)).toThrow(WhenError);
      expect(() => parseWhen(text)).toThrow(message);
    }
    expect(parseWhen(Array(8).fill("price < 1").join(" and "))).toBeDefined();
    expect(parseWhen("price < 1 and (price < 2 or price < 3)")).toBeDefined();
  });

  test("renders one canonical form that reads back the same", () => {
    const cases: [string, string][] = [
      ["price<180", "price < 180"],
      ["180 > price", "price < 180"],
      [
        "price < 1 or price < 2 and price < 3",
        "price < 1 or (price < 2 and price < 3)",
      ],
      [
        "(price < 1 or rsi14 > 2) and price > sma200",
        "(price < 1 or rsi14 > 2) and price > sma200",
      ],
      [
        "(price < 1 and price < 2) and price < 3",
        "(price < 1 and price < 2) and price < 3",
      ],
      ["PRICE(^VIX)>25", "price(^VIX) > 25"],
      ["relative_return_3m( A ,B ) < -5.5", "relative_return_3m(A, B) < -5.5"],
      ["price > 0.0025", "price > 0.0025"],
    ];
    for (const [text, canonical] of cases) {
      const n = parseWhen(text);
      expect(renderWhen(n)).toBe(canonical);
      expect(parseWhen(renderWhen(n))).toEqual(n);
    }
  });

  test("lists comparisons depth first", () => {
    const n = parseWhen(
      "rsi14 < 1 or (price < 2 and sma50 > 3) or drawdown < 4",
    );
    expect(whenComparisons(n).map((c) => c.left.field)).toEqual([
      "rsi14",
      "price",
      "sma50",
      "drawdown",
    ]);
  });

  test("names every stored field once, as quote and screen do", () => {
    expect(Object.values(WHEN_FIELDS).sort()).toEqual([...FIELD_NAMES].sort());
    expect(new Set(WHEN_FIELD_NAMES).size).toBe(FIELD_NAMES.length);
    for (const name of WHEN_FIELD_NAMES) expect(name).toMatch(/^[a-z0-9_]+$/);
  });

  test("goes into the stored tree and back, the own symbol left out", () => {
    const text =
      "(change_percent < -3 or move_atr < -2) and price(CXI:^VIX) > 25 and relative_return_1m(SNP:^GSPC) < price";
    const input = parseWhenCondition(text, "NVDA");
    expect(input.afterEarnings).toBe("NVDA");
    expect(input.node).toMatchObject({
      all: [
        {
          any: [
            { left: { field: "changePct", symbol: null } },
            { left: { field: "moveAtr", symbol: null } },
          ],
        },
        { left: { field: "price", symbol: "CXI:^VIX" } },
        {
          left: {
            field: "relativeReturn1m",
            symbol: null,
            benchmark: "SNP:^GSPC",
          },
        },
      ],
    });
    // bound as the store keeps it: every symbol an id
    const bind = (n: any): any =>
      "all" in n
        ? { all: n.all.map(bind) }
        : "any" in n
          ? { any: n.any.map(bind) }
          : {
              ...n,
              left: { ...n.left, symbol: n.left.symbol ?? "US:NVDA" },
              right:
                typeof n.right === "number"
                  ? n.right
                  : { ...n.right, symbol: n.right.symbol ?? "US:NVDA" },
            };
    expect(whenText(bind(input.node), "US:NVDA")).toBe(text);
    // the own symbol named is the own symbol, so it reads without it
    expect(
      whenText(
        bind(parseWhenCondition("price(US:NVDA) < 1", null).node),
        "US:NVDA",
      ),
    ).toBe("price < 1");
    expect(() => parseWhenCondition("rsi < 1", null)).toThrow(RuleError);
  });
});
