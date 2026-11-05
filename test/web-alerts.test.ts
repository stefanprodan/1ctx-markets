// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// The Alerts page's words from fixed, made-up rules: no DOM, no network.

import { describe, expect, test } from "bun:test";
import { STALE } from "../src/market/stale.ts";
import { WAITING } from "../src/rules/evaluate.ts";
import { FIELDS } from "../src/rules/format.ts";
import {
  type Alert,
  alertsStore,
  type ComparisonValue,
  type Listings,
  type Node,
  type Op,
  RECENT_PATH,
  RULES_PATH,
  type Rule,
  SEEN_PATH,
} from "../src/web/data/alerts.ts";
import {
  FIELD_WORDS,
  nearOf,
  OP_WORDS,
  ruleSummary,
  type StateKey,
  sortRules,
  stateOf,
} from "../src/web/views/Alerts.model.ts";

const OWN = "XETRA:MADE";

const L: Listings = {
  [OWN]: {
    name: "Made Up AG",
    type: "EQUITY",
    currency: "EUR",
    unit: "per_share",
  },
  "US:^VIX": {
    name: "Made Up Volatility",
    type: "INDEX",
    currency: "USD",
    unit: "index_points",
  },
  "US:ZZZ": {
    name: "Made Up Inc.",
    type: "EQUITY",
    currency: "USD",
    unit: "per_share",
  },
};

const price = (op: Op, right: number, symbol = OWN): Node => ({
  left: { field: "price", symbol },
  op,
  right,
});

const reading = (
  field: string,
  value: number | null,
  op: Op,
  right: number | { field: string; value: number | null },
  holds: boolean | null,
): ComparisonValue => ({
  left: { field, symbol: OWN, value, trade_time: null },
  op,
  right:
    typeof right === "number"
      ? right
      : {
          field: right.field,
          symbol: OWN,
          value: right.value,
          trade_time: null,
        },
  holds,
});

type Extra = Partial<Omit<Rule, "now">> & { now?: Partial<Rule["now"]> };

let ids = 1;
const ruleOf = (condition: Node, extra: Extra = {}): Rule => {
  const { now, ...rest } = extra;
  return {
    id: ids++,
    symbol: OWN,
    condition,
    note: null,
    paused: null,
    armed: true,
    created_at: "2026-11-02T10:00:00Z",
    last_result: "false",
    last_evaluated_at: "2026-11-02T10:00:00Z",
    ...rest,
    now: { result: "false", values: [], reasons: [], ...now },
  };
};

describe("a rule in words", () => {
  test("every field the rules take has a label", () => {
    expect(Object.keys(FIELDS).filter((f) => !(f in FIELD_WORDS))).toEqual([]);
  });

  test("each op reads as its words", () => {
    const said = (["<", "<=", ">", ">="] as const).map((op) =>
      ruleSummary(ruleOf(price(op, 80)), L),
    );
    expect(said).toEqual([
      "Price below 80.00 EUR",
      "Price at or below 80.00 EUR",
      "Price above 80.00 EUR",
      "Price at or above 80.00 EUR",
    ]);
    expect(Object.keys(OP_WORDS).sort()).toEqual(["<", "<=", ">", ">="]);
  });

  test("another listing is named by its ticker, an index without its caret", () => {
    expect(ruleSummary(ruleOf(price(">", 30, "US:^VIX")), L)).toBe(
      "VIX above 30",
    );
    const rsi: Node = {
      left: { field: "rsi14", symbol: "US:ZZZ" },
      op: "<",
      right: 30,
    };
    expect(ruleSummary(ruleOf(rsi), L)).toBe("ZZZ RSI below 30");
  });

  test("a flat group reads inline, a nested one by its count", () => {
    const rsi: Node = {
      left: { field: "rsi14", symbol: OWN },
      op: "<",
      right: 40,
    };
    expect(ruleSummary(ruleOf({ all: [price("<=", 165), rsi] }), L)).toBe(
      "Price at or below 165.00 EUR and RSI below 40",
    );
    expect(ruleSummary(ruleOf({ any: [price("<", 150), rsi] }), L)).toBe(
      "Price below 150.00 EUR or RSI below 40",
    );
    const nested = { all: [{ any: [price("<", 150), rsi] }, price(">", 100)] };
    expect(ruleSummary(ruleOf(nested), L)).toBe("All of 3 conditions");
    expect(ruleSummary(ruleOf({ any: [nested, rsi] }), L)).toBe(
      "Any of 4 conditions",
    );
  });

  test("an earnings gate leads the condition", () => {
    const gated = ruleOf(price(">", 200), {
      after_earnings: {
        symbol: OWN,
        fiscal_year: 2026,
        fiscal_quarter: 3,
        status: null,
      },
    });
    expect(ruleSummary(gated, L)).toBe(
      "After MADE's Q3 2026 results: price above 200.00 EUR",
    );
  });
});

describe("how near a rule is", () => {
  test("a price from its level, in percent of the price", () => {
    const level = ruleOf(price("<=", 95), {
      now: { values: [reading("price", 100, "<=", 95, false)] },
    });
    expect(nearOf(level, L).distance).toBe(5);
    const average = ruleOf(price("<", 0), {
      now: {
        values: [
          reading("price", 100, "<", { field: "sma200", value: 90 }, false),
        ],
      },
    });
    expect(nearOf(average, L).distance).toBe(10);
  });

  test("met is no distance at all", () => {
    const met = ruleOf(price("<=", 105), {
      now: {
        result: "true",
        values: [reading("price", 100, "<=", 105, true)],
      },
    });
    expect(nearOf(met, L)).toMatchObject({ distance: 0, holds: 1, of: 1 });
  });

  test("all of: a reading left that is not a price has no distance", () => {
    const all = ruleOf(
      { all: [price("<", 105), price("<", 0)] },
      {
        now: {
          values: [
            reading("price", 100, "<", 105, true),
            reading("rsi14", 45, "<", 40, false),
          ],
        },
      },
    );
    expect(nearOf(all, L)).toMatchObject({ distance: null, holds: 1, of: 2 });
  });

  test("any of: the nearest price", () => {
    const any = ruleOf(
      { any: [price("<", 95), price(">", 110)] },
      {
        now: {
          values: [
            reading("price", 100, "<", 95, false),
            reading("price", 100, ">", 110, false),
            reading("rsi14", 45, "<", 40, false),
          ],
        },
      },
    );
    expect(nearOf(any, L).distance).toBe(5);
  });

  test("a group nested in another takes its own nearest or farthest", () => {
    // price 105: the any's nearer side is 110, 4.8% away
    const inner = ruleOf(
      { all: [price(">=", 100), { any: [price("<=", 50), price(">=", 110)] }] },
      {
        now: {
          values: [
            reading("price", 105, ">=", 100, true),
            reading("price", 105, "<=", 50, false),
            reading("price", 105, ">=", 110, false),
          ],
        },
      },
    );
    expect(nearOf(inner, L).distance).toBeCloseTo(4.76, 2);
    // an any met through one side counts as met
    const met = ruleOf(
      { all: [{ any: [price("<=", 50), price(">=", 100)] }, price(">=", 110)] },
      {
        now: {
          values: [
            reading("price", 105, "<=", 50, false),
            reading("price", 105, ">=", 100, true),
            reading("price", 105, ">=", 110, false),
          ],
        },
      },
    );
    expect(nearOf(met, L).distance).toBeCloseTo(4.76, 2);
  });

  test("no percent for readings near zero that share the price's unit", () => {
    for (const field of ["macd", "macdHistogram", "atr14"]) {
      const rule = ruleOf(
        { left: { field, symbol: OWN }, op: ">", right: 0 },
        { now: { values: [reading(field, -0.5, ">", 0, false)] } },
      );
      expect([field, nearOf(rule, L).distance]).toEqual([field, null]);
    }
  });
});

describe("a rule's state", () => {
  test("names each state from the pause and the evaluation now", () => {
    const cases: [Extra, StateKey][] = [
      [{ paused: "split" }, "split"],
      [{ paused: "manual" }, "paused"],
      [
        {
          now: {
            result: "unknown",
            reasons: [`price of ${OWN}: quote overdue`],
          },
        },
        "stale",
      ],
      [
        {
          now: {
            result: "unknown",
            reasons: [`price of ${OWN}: not stored`],
          },
        },
        "unknown",
      ],
      [{ now: { result: "false", reasons: [WAITING] } }, "earnings"],
      [{ armed: true, now: { result: "true" } }, "holds"],
      [{ armed: false, now: { result: "true" } }, "fired"],
      [{ now: { result: "false" } }, "watching"],
    ];
    for (const [extra, state] of cases) {
      expect([state, stateOf(ruleOf(price("<", 1), extra))]).toEqual([
        state,
        state,
      ]);
    }
  });

  test("calls a missing price no fresh price, any other wait can't check", () => {
    const fresh = [
      STALE.quoteOverdue,
      STALE.quotesFailed,
      STALE.noQuote,
      STALE.noQuoteYet,
      STALE.checkFailed,
    ];
    const other = [
      STALE.barsFailed,
      STALE.barsPending,
      STALE.signalsPending,
      STALE.noHistory,
    ];
    const of = (r: string) =>
      stateOf(
        ruleOf(price("<", 1), {
          now: { result: "unknown", reasons: [`price of ${OWN}: ${r}`] },
        }),
      );
    expect(fresh.map(of)).toEqual(fresh.map(() => "stale"));
    expect(other.map(of)).toEqual(other.map(() => "unknown"));
  });

  test("sorts the nearest first, a symbol's rules together, paused last", () => {
    const at = (symbol: string, d: number, paused: Rule["paused"] = null) =>
      ruleOf(price("<", 100 - d, symbol), {
        symbol,
        paused,
        note: `${symbol} ${d}`,
        now: {
          values: [
            {
              ...reading("price", 100, "<", 100 - d, false),
              left: { field: "price", symbol, value: 100, trade_time: null },
            },
          ],
        },
      });
    const rules = [
      at(OWN, 10),
      at("US:ZZZ", 2),
      at("US:ZZZ", 0.5, "manual"),
      at(OWN, 1),
      at("US:ZZZ", 3, "split"),
    ];
    expect(sortRules(rules).map((r) => r.note)).toEqual([
      `${OWN} 1`,
      `${OWN} 10`,
      "US:ZZZ 2",
      "US:ZZZ 0.5",
      "US:ZZZ 3",
    ]);
  });
});

describe("the alerts store", () => {
  // each call waits until the test answers it
  const fake = () => {
    const asked: {
      path: string;
      method?: string;
      answer: (v: unknown) => void;
    }[] = [];
    const call = (<T>(path: string, method?: string) =>
      new Promise<T>((resolve) => {
        asked.push({ path, method, answer: (v) => resolve(v as T) });
      })) as Parameters<typeof alertsStore>[0];
    return { asked, call };
  };
  const never = () => () => {};
  const alert = (id: number): Alert => ({
    id,
    rule_id: 1,
    fired_at: "2026-11-05T09:00:00Z",
    symbol: OWN,
    note: null,
    condition: price("<", 1),
    values: [],
  });
  const settle = () => new Promise((r) => setTimeout(r, 0));

  test("an older page answered after a sign-out lands nowhere", async () => {
    const f = fake();
    let session = 1;
    const store = alertsStore(f.call, () => session, never);
    const first = store.loadAll();
    f.asked
      .find((a) => a.path === RULES_PATH)!
      .answer({ rules: [], instruments: {} });
    f.asked
      .find((a) => a.path === RECENT_PATH)!
      .answer({
        alerts: [alert(3)],
        instruments: {},
        next: 3,
      });
    await first;
    const more = store.loadMore();
    session++;
    store.signedOut();
    f.asked
      .at(-1)!
      .answer({ alerts: [alert(2), alert(1)], instruments: {}, next: null });
    await more;
    expect(store.alerts.value).toBeNull();
    expect(store.next.value).toBeNull();
  });

  test("a refresh that started before a mark never moves it back", async () => {
    const f = fake();
    const store = alertsStore(f.call, () => 1, never);
    store.seen.value = { seen: 1, unseen: 1 };
    store.alerts.value = [alert(2)];
    const read = store.loadSeen();
    const mark = store.markSeen();
    await settle();
    const put = f.asked.find((a) => a.method === "PUT")!;
    expect(put.path).toBe(SEEN_PATH);
    put.answer({ seen: 2, unseen: 0 });
    await mark;
    f.asked.find((a) => a.method === undefined)!.answer({ seen: 1, unseen: 1 });
    await read;
    expect(store.seen.value).toEqual({ seen: 2, unseen: 0 });
  });
});
