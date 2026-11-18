// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// The Alerts page's words from fixed, made-up alerts: no DOM, no network.

import { describe, expect, test } from "bun:test";
import { STALE } from "../src/market/stale.ts";
import { WAITING } from "../src/rules/evaluate.ts";
import { WHEN_FIELD_NAMES } from "../src/shared/when.ts";
import {
  ALERTS_PATH,
  type Alert,
  alertsStore,
  HISTORY_PATH,
  type Listings,
  type Now,
  SEEN_PATH,
  type Trigger,
} from "../src/web/data/alerts.ts";
import type { PlanItem } from "../src/web/data/trade-plans.ts";
import {
  alertMatches,
  comparisonsOf,
  conditionLines,
  FIELD_WORDS,
  figureOf,
  firedText,
  historyGroups,
  inTile,
  nearOf,
  OP_WORDS,
  plansFor,
  priceParts,
  rightNow,
  ruleSummary,
  type StateKey,
  sortRules,
  standingOf,
  stateOf,
  treeOf,
  triggerMatches,
  triggerText,
  whenLabel,
} from "../src/web/views/Alerts.model.ts";

const OWN = "XETRA:MADE";
const AT = "2026-11-05T09:00:00Z";

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

const now = (
  field: string,
  value: number | null,
  level: number | null,
  holds: boolean | null,
): Now => ({
  field,
  value,
  level,
  gap: value === null || level === null ? null : level - value,
  holds,
});

let ids = 1;
const alertOf = (when: string, extra: Partial<Alert> = {}): Alert => ({
  id: ids++,
  symbol: OWN,
  when,
  on: "touch",
  note: null,
  state: "watching",
  last_triggered_at: null,
  gap_percent: null,
  now: [],
  ...extra,
});

describe("an alert in words", () => {
  test("a search finds an alert by symbol, name, condition, note or state", () => {
    const a = alertOf("price <= 80", { note: "Rung two", state: "paused" });
    for (const q of [
      "made",
      "MADE up ag",
      "at or below 80",
      "rung two",
      "paused",
      "",
    ]) {
      expect(alertMatches(a, q, L)).toBe(true);
    }
    // every word must match somewhere
    expect(alertMatches(a, "made zzz", L)).toBe(false);
  });

  test("every field when takes has a label", () => {
    expect(Object.keys(FIELD_WORDS).sort()).toEqual(
      [...WHEN_FIELD_NAMES].sort(),
    );
  });

  test("each op reads as its words", () => {
    const said = (["<", "<=", ">", ">="] as const).map((op) =>
      ruleSummary(alertOf(`price ${op} 80`), L),
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
    expect(ruleSummary(alertOf("price(US:^VIX) > 30"), L)).toBe("VIX above 30");
    expect(ruleSummary(alertOf("rsi14(US:ZZZ) < 30"), L)).toBe(
      "ZZZ RSI below 30",
    );
    expect(ruleSummary(alertOf("relative_return_1m(US:ZZZ) < -5"), L)).toBe(
      "1-month return vs ZZZ below -5 pts",
    );
  });

  test("a flat group reads inline, a nested one by its count", () => {
    expect(ruleSummary(alertOf("price <= 165 and rsi14 < 40"), L)).toBe(
      "Price at or below 165.00 EUR and RSI below 40",
    );
    expect(ruleSummary(alertOf("price < 150 or rsi14 < 40"), L)).toBe(
      "Price below 150.00 EUR or RSI below 40",
    );
    const nested = "(price < 150 or rsi14 < 40) and price > 100";
    expect(ruleSummary(alertOf(nested), L)).toBe("All of 3 conditions");
    expect(
      ruleSummary(
        alertOf("(price < 150 and price > 100) or (rsi14 < 40 and rsi14 > 10)"),
        L,
      ),
    ).toBe("Any of 4 conditions");
  });

  test("an earnings gate leads the condition", () => {
    const gated = alertOf("price > 200", {
      after_earnings: {
        symbol: OWN,
        fiscal_year: 2026,
        fiscal_quarter: 3,
        date: null,
        status: null,
      },
    });
    expect(ruleSummary(gated, L)).toBe(
      "After MADE's Q3 2026 results: price above 200.00 EUR",
    );
  });

  test("a close alert says which close it waits for", () => {
    expect(ruleSummary(alertOf("price < 80", { on: "close" }), L)).toBe(
      "Price below 80.00 EUR on the close",
    );
    expect(ruleSummary(alertOf("price < 80", { on: "weekly_close" }), L)).toBe(
      "Price below 80.00 EUR on the weekly close",
    );
  });

  test("an unreadable condition shows as its text", () => {
    expect(treeOf("price <")).toBeNull();
    expect(ruleSummary(alertOf("price <"), L)).toBe("price <");
  });

  test("each comparison's line holds its place in now", () => {
    const n = treeOf("price < 150 and (rsi14 < 40 or price > sma200)")!;
    expect(conditionLines(n, OWN, L)).toEqual([
      { text: "All of", depth: 0, at: null },
      { text: "Price below 150.00 EUR", depth: 1, at: 0 },
      { text: "Any of", depth: 1, at: null },
      { text: "RSI below 40", depth: 2, at: 1 },
      { text: "Price above 200-day average", depth: 2, at: 2 },
    ]);
    const c = comparisonsOf("price > sma200")[0]!;
    expect(rightNow(c, now("price", 100, 90, true), OWN, L)).toBe(
      "200-day average 90.00 EUR",
    );
  });
});

describe("what triggered, in words", () => {
  const trigger = (when: string, values: Trigger["values"]): Trigger => ({
    id: 1,
    alert_id: 1,
    symbol: OWN,
    when,
    note: null,
    triggered_at: AT,
    values,
  });

  test("a level and a field read from the values keyed as when", () => {
    const c = comparisonsOf("price <= 80")[0]!;
    expect(firedText(c, { price: 79.5 }, OWN, L)).toBe(
      "Price fell to 79.50 EUR, at or below 80.00 EUR",
    );
    expect(
      triggerText(
        trigger("price > sma200 and price(US:^VIX) > 30", {
          price: 101,
          sma200: 99,
          "price(US:^VIX)": 31,
        }),
        L,
      ),
    ).toBe(
      "Price rose to 101.00 EUR, above 200-day average (99.00 EUR); VIX rose to 31, above 30",
    );
  });

  test("a close alert's trigger names the close it read", () => {
    const fired = trigger("price > 80", { price: 81 });
    const at = (on: Trigger["on"], session: string | null) =>
      triggerText({ ...fired, on, session }, L);
    expect(at("close", "2026-11-13")).toBe(
      "Price rose to 81.00 EUR, above 80.00 EUR at the 13 Nov close",
    );
    expect(at("weekly_close", "2026-11-09")).toBe(
      "Price rose to 81.00 EUR, above 80.00 EUR at the close of the week of 9 Nov",
    );
    expect(at("touch", "2026-11-13")).toBe(
      "Price rose to 81.00 EUR, above 80.00 EUR",
    );
    expect(triggerText(fired, L)).toBe(
      "Price rose to 81.00 EUR, above 80.00 EUR",
    );
  });
});

describe("how near an alert is", () => {
  test("the distance is the server's gap_percent", () => {
    const a = alertOf("price <= 95", {
      gap_percent: 5,
      now: [now("price", 100, 95, false)],
    });
    expect(nearOf(a, L)).toEqual({
      distance: 5,
      met: false,
      holds: 0,
      of: 1,
      shown: { text: "100.00 EUR", field: "price" },
    });
  });

  test("counts the comparisons met, and names a reading not a price", () => {
    const a = alertOf("price < 105 and rsi14 < 40", {
      now: [now("price", 100, 105, true), now("rsi14", 45, 40, false)],
    });
    expect(nearOf(a, L)).toMatchObject({ distance: null, holds: 1, of: 2 });
    const rsi = alertOf("rsi14 < 40", { now: [now("rsi14", 34.5, 40, true)] });
    expect(nearOf(rsi, L).shown?.text).toBe("RSI 34.5");
  });
});

describe("an alert's state", () => {
  test("is the server's state in the page's words", () => {
    const cases: [Partial<Alert>, StateKey][] = [
      [{ state: "split_paused" }, "split"],
      [{ state: "paused" }, "paused"],
      [
        { state: "unknown", reasons: [`price of ${OWN}: quote overdue`] },
        "stale",
      ],
      [
        { state: "unknown", reasons: [`price of ${OWN}: not stored`] },
        "unknown",
      ],
      [{ state: "waiting_for_earnings", reasons: [WAITING] }, "earnings"],
      [
        {
          state: "watching",
          gap_percent: 0,
          now: [{ field: "price", value: 1, level: 1, gap: 0, holds: true }],
        },
        "holds",
      ],
      // a gap rounded to 0 is not met while the condition is false
      [
        {
          state: "watching",
          gap_percent: 0,
          now: [{ field: "price", value: 1, level: 1, gap: 0, holds: false }],
        },
        "watching",
      ],
      [{ state: "triggered", gap_percent: 0 }, "fired"],
      [{ state: "watching", gap_percent: 3 }, "watching"],
      [{ state: "watching" }, "watching"],
    ];
    for (const [extra, state] of cases) {
      expect([state, stateOf(alertOf("price < 1", extra))]).toEqual([
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
        alertOf("price < 1", {
          state: "unknown",
          reasons: [`price of ${OWN}: ${r}`],
        }),
      );
    expect(fresh.map(of)).toEqual(fresh.map(() => "stale"));
    expect(other.map(of)).toEqual(other.map(() => "unknown"));
  });

  test("tiles filter on the server's state, gap and the week's triggers", () => {
    const near = alertOf("price < 1", { gap_percent: 4 });
    const far = alertOf("price < 1", { gap_percent: 6 });
    const paused = alertOf("price < 1", { state: "paused", gap_percent: 1 });
    const t = Date.parse(AT);
    const fired: Trigger[] = [
      {
        id: 1,
        alert_id: far.id,
        symbol: OWN,
        when: "price < 1",
        note: null,
        triggered_at: AT,
        values: { price: 0.5 },
      },
    ];
    const tile = (key: Parameters<typeof inTile>[0]) =>
      [near, far, paused]
        .filter((a) => inTile(key, a, fired, t))
        .map((a) => a.id);
    expect(tile("near")).toEqual([near.id]);
    expect(tile("paused")).toEqual([paused.id]);
    expect(tile("fired")).toEqual([far.id]);
    expect(tile("all")).toHaveLength(3);
  });

  test("sorts the nearest first, a symbol's alerts together, paused last", () => {
    const at = (
      symbol: string,
      d: number,
      state: Alert["state"] = "watching",
    ) =>
      alertOf(`price < ${100 - d}`, {
        symbol,
        state,
        note: `${symbol} ${d}`,
        gap_percent: d,
      });
    const alerts = [
      at(OWN, 10),
      at("US:ZZZ", 2),
      at("US:ZZZ", 0.5, "paused"),
      at(OWN, 1),
      at("US:ZZZ", 3, "split_paused"),
    ];
    expect(sortRules(alerts).map((r) => r.note)).toEqual([
      `${OWN} 1`,
      `${OWN} 10`,
      "US:ZZZ 2",
      "US:ZZZ 0.5",
      "US:ZZZ 3",
    ]);
  });
});

describe("the history page", () => {
  const firing = (id: number, alert: Alert, when = alert.when): Trigger => ({
    id,
    alert_id: alert.id,
    symbol: alert.symbol,
    when,
    note: null,
    triggered_at: AT,
    values: {},
  });
  const priced = (
    value: number,
    level: number,
    holds: boolean,
    gap: number,
  ): Now => ({ ...now("price", value, level, holds), gap_percent: gap });

  test("a met alert keeps its trigger still met, with the price now", () => {
    const a = alertOf("price <= 80", {
      state: "triggered",
      now: [priced(79.5, 80, true, 0)],
    });
    expect(standingOf(firing(1, a), [a])).toMatchObject({
      met: true,
      tag: null,
      price: 79.5,
    });
  });

  test("a level moved back past says which side and how far", () => {
    const below = alertOf("price <= 80", {
      now: [priced(80.16, 80, false, -0.2)],
    });
    expect(standingOf(firing(1, below), [below]).tag).toBe("Back above · 0.2%");
    const above = alertOf("price >= 150", {
      now: [priced(147, 150, false, 2.04)],
    });
    expect(standingOf(firing(2, above), [above]).tag).toBe("Back below · 2.0%");
  });

  test("a condition on something other than a price has no distance", () => {
    const a = alertOf("rsi14 < 30", { now: [now("rsi14", 35, 30, false)] });
    const s = standingOf(firing(1, a), [a]);
    expect(s).toMatchObject({ met: false, tag: null, price: null });
    expect(figureOf(s, L)).toEqual({ figure: "RSI 35", currency: null });
  });

  test("a reading in the price's currency keeps its name", () => {
    const a = alertOf("sma50 > sma200", {
      now: [now("sma50", 165, 160, true)],
    });
    expect(figureOf(standingOf(firing(1, a), [a]), L)?.figure).toMatch(
      /^50-day average /,
    );
  });

  test("an alert watching again is no longer met, though it holds now", () => {
    const a = alertOf("price <= 80", {
      state: "watching",
      now: [priced(79, 80, true, 0)],
    });
    expect(standingOf(firing(1, a), [a])).toMatchObject({ met: false });
  });

  test("the figure is the price when the alert reads one", () => {
    const a = alertOf("price <= 80 and rsi14 < 30", {
      now: [priced(79.5, 80, true, 0), now("rsi14", 28, 30, true)],
    });
    expect(figureOf(standingOf(firing(1, a), [a]), L)).toEqual({
      figure: "79.50",
      currency: "EUR",
    });
    expect(figureOf(standingOf(firing(2, a), []), L)).toBeNull();
  });

  test("a paused or split-paused alert is no longer met, untagged", () => {
    for (const state of ["paused", "split_paused"] as const) {
      const a = alertOf("price <= 80", {
        state,
        now: [priced(79, 80, true, 0)],
      });
      expect(standingOf(firing(1, a), [a])).toMatchObject({
        met: false,
        tag: null,
        price: 79,
      });
    }
  });

  test("a removed, changed or unread alert is no longer met, untagged", () => {
    const a = alertOf("price <= 80", { now: [priced(79, 80, true, 0)] });
    expect(standingOf(firing(1, a), [])).toEqual({
      trigger: firing(1, a),
      met: false,
      tag: null,
      price: null,
      reading: null,
    });
    expect(standingOf(firing(2, a, "price <= 90"), [a])).toMatchObject({
      met: false,
      tag: null,
      price: 79,
    });
    const unread = alertOf("price <= 80", {
      state: "unknown",
      reasons: [`price of ${OWN}: quote overdue`],
      now: [{ ...now("price", null, 80, null), gap_percent: null }],
    });
    expect(standingOf(firing(3, unread), [unread])).toMatchObject({
      met: false,
      tag: null,
      price: null,
    });
  });

  test("the newest leads, met or not, then the rest split by now", () => {
    const met = alertOf("price <= 80", {
      state: "triggered",
      now: [priced(79, 80, true, 0)],
    });
    const back = alertOf("price <= 70", {
      now: [priced(79, 70, false, -11.39)],
    });
    const g = historyGroups(
      [firing(4, back), firing(3, met), firing(2, back), firing(1, met)],
      [met, back],
    )!;
    expect(g.latest.trigger.id).toBe(4);
    expect(g.latest.met).toBe(false);
    // an alert's older trigger: it went false before firing again
    expect(g.met.map((s) => s.trigger.id)).toEqual([3]);
    expect(g.gone.map((s) => [s.trigger.id, s.tag])).toEqual([
      [2, null],
      [1, null],
    ]);
    expect(historyGroups([], [met])).toBeNull();
  });

  test("a search keeps each trigger's standing from the whole history", () => {
    const a = alertOf("price <= 80", {
      state: "triggered",
      now: [priced(79, 80, true, 0)],
    });
    const newer = { ...firing(2, a), note: "second" };
    const older = { ...firing(1, a), note: "first" };
    const g = historyGroups([newer, older], [a], (t) => t.note === "first")!;
    // the newer trigger is hidden, yet the older one is still not met
    expect(g.latest.trigger.id).toBe(1);
    expect(g.latest.met).toBe(false);
    expect(historyGroups([newer], [a], () => false)).toBeNull();
  });

  test("a search finds a trigger by symbol, name, what fired or note", () => {
    const a = alertOf("price <= 80");
    const t: Trigger = {
      ...firing(1, a),
      note: "Rung two",
      values: { price: 79.5 },
    };
    for (const q of ["made", "MADE up ag", "79.50", "rung", ""]) {
      expect(triggerMatches(t, q, L)).toBe(true);
    }
    expect(triggerMatches(t, "made zzz", L)).toBe(false);
  });

  test("a trigger's time reads alone today, then with its day", () => {
    const now = new Date(2026, 10, 16, 21, 0).getTime();
    const at = (d: number, h: number, m: number, y = 2026) =>
      new Date(y, 10, d, h, m).toISOString();
    expect(whenLabel(at(16, 19, 20), now)).toBe("19:20");
    expect(whenLabel(at(15, 17, 5), now)).toBe("Yesterday 17:05");
    expect(whenLabel(at(14, 17, 5), now)).toBe("14 Nov 17:05");
    expect(whenLabel(at(14, 9, 30, 2025), now)).toBe("14 Nov 2025 09:30");
  });

  test("Plan finds the symbol's active plans only", () => {
    const plan = (id: number, status: PlanItem["status"], symbols: string[]) =>
      ({ id, name: `Plan ${id}`, status, symbols }) as PlanItem;
    const plans = [
      plan(1, "active", [OWN, "US:ZZZ"]),
      plan(2, "archived", [OWN]),
      plan(3, "active", ["US:ZZZ"]),
      plan(4, "active", [OWN]),
    ];
    expect(plansFor(plans, OWN).map((p) => p.id)).toEqual([1, 4]);
    expect(plansFor(null, OWN)).toEqual([]);
  });

  test("a large price keeps its currency apart, an index has none", () => {
    expect(priceParts(1234.5, OWN, L)).toEqual({
      figure: "1,234.50",
      currency: "EUR",
    });
    expect(priceParts(16.82, "US:^VIX", L)).toEqual({
      figure: "16.82",
      currency: null,
    });
  });
});

describe("the alerts store", () => {
  // each call waits until the test answers it
  const fake = () => {
    const asked: {
      path: string;
      method?: string;
      body?: unknown;
      answer: (v: unknown) => void;
    }[] = [];
    const call = (<T>(path: string, method?: string, body?: unknown) =>
      new Promise<T>((resolve) => {
        asked.push({ path, method, body, answer: (v) => resolve(v as T) });
      })) as Parameters<typeof alertsStore>[0];
    return { asked, call };
  };
  const never = () => () => {};
  const trigger = (id: number): Trigger => ({
    id,
    alert_id: 1,
    triggered_at: AT,
    symbol: OWN,
    note: null,
    when: "price < 1",
    values: { price: 0.5 },
  });
  const settle = () => new Promise((r) => setTimeout(r, 0));

  test("reads every page of alerts and the first of the history", async () => {
    const f = fake();
    const store = alertsStore(f.call, () => 1, never);
    const load = store.loadAll();
    await settle();
    f.asked
      .find((a) => a.path === ALERTS_PATH)!
      .answer({
        alerts: [alertOf("price < 1")],
        instruments: {},
        next_page_token: "7",
      });
    f.asked
      .find((a) => a.path === HISTORY_PATH)!
      .answer({
        triggers: [trigger(3)],
        instruments: {},
        next_page_token: "3",
      });
    await settle();
    const second = f.asked.find(
      (a) => a.path === `${ALERTS_PATH}?page_token=7`,
    )!;
    second.answer({ alerts: [alertOf("price < 2")], instruments: L });
    await load;
    expect(store.alerts.value?.map((a) => a.when)).toEqual([
      "price < 1",
      "price < 2",
    ]);
    expect(store.next.value).toBe("3");
    expect(store.listings.value).toEqual(L);
    const more = store.loadMore();
    f.asked.at(-1)!.answer({ triggers: [trigger(2)], instruments: {} });
    expect(f.asked.at(-1)!.path).toBe(`${HISTORY_PATH}?page_token=3`);
    await more;
    expect(store.history.value?.map((t) => t.id)).toEqual([3, 2]);
    expect(store.next.value).toBeNull();
  });

  test("writes go to an alert's path, a new one as when", async () => {
    const f = fake();
    const store = alertsStore(f.call, () => 1, never);
    const writes = [
      store.add(OWN, true, 80, " near the top "),
      store.add(OWN, false, 70, ""),
      store.pause(4, true),
      store.remove(4),
    ];
    await settle();
    expect(f.asked.map((a) => [a.method, a.path, a.body])).toEqual([
      [
        "POST",
        ALERTS_PATH,
        { symbol: OWN, when: "price >= 80", note: "near the top" },
      ],
      ["POST", ALERTS_PATH, { symbol: OWN, when: "price <= 70" }],
      ["PATCH", `${ALERTS_PATH}/4`, { paused: true }],
      ["DELETE", `${ALERTS_PATH}/4`, undefined],
    ]);
    for (const a of f.asked.splice(0)) a.answer({});
    await settle();
    // each write reloads; answer them so the promises end
    for (const a of f.asked) {
      a.answer(
        a.path === HISTORY_PATH
          ? { triggers: [], instruments: {} }
          : { alerts: [], instruments: {} },
      );
    }
    expect(await Promise.all(writes)).toEqual([null, null, null, null]);
  });

  test("an older page answered after a sign-out lands nowhere", async () => {
    const f = fake();
    let session = 1;
    const store = alertsStore(f.call, () => session, never);
    const first = store.loadAll();
    await settle();
    f.asked
      .find((a) => a.path === ALERTS_PATH)!
      .answer({ alerts: [], instruments: {} });
    f.asked
      .find((a) => a.path === HISTORY_PATH)!
      .answer({
        triggers: [trigger(3)],
        instruments: {},
        next_page_token: "3",
      });
    await first;
    const more = store.loadMore();
    session++;
    store.signedOut();
    f.asked
      .at(-1)!
      .answer({ triggers: [trigger(2), trigger(1)], instruments: {} });
    await more;
    expect(store.history.value).toBeNull();
    expect(store.next.value).toBeNull();
  });

  test("a sign-out clears a failed read's error", async () => {
    const store = alertsStore(
      () => Promise.reject(new Error("The server did not answer.")),
      () => 1,
      never,
    );
    await store.loadAll();
    expect(store.error.value).not.toBeNull();
    store.signedOut();
    expect(store.error.value).toBeNull();
    expect(store.code.value).toBeNull();
  });

  test("a refresh that started before a mark never moves it back", async () => {
    const f = fake();
    const store = alertsStore(f.call, () => 1, never);
    store.seen.value = { seen: 1, unseen: 1 };
    store.history.value = [trigger(2)];
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
