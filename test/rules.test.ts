// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { DAY_MS } from "../src/clock.ts";
import { refreshResearch } from "../src/finnhub/store.ts";
import { readInstrument } from "../src/instruments.ts";
import { silent } from "../src/log.ts";
import { WAITING } from "../src/rules/evaluate.ts";
import {
  FIELD_NAMES,
  NO_RETURN_QUOTE,
  UNKNOWN_UNIT,
} from "../src/rules/format.ts";
import { countRules, readRule } from "../src/rules/store.ts";
import { endRun, failRun, startRun } from "../src/runs.ts";
import { SourceError } from "../src/source.ts";
import { tools } from "../src/tools/index.ts";
import { NO_EVENT_SOURCE } from "../src/tools/rules.ts";
import { trackedIds } from "../src/tracking.ts";
import { yahooJobs } from "../src/yahoo/jobs.ts";
import { refetch } from "../src/yahoo/sync.ts";
import { drive, pacedOf } from "./helpers/drive.ts";
import { EVERY_MS, type RulesTest, rulesTest } from "./helpers/rules.ts";
import { clone, listed, type Recorded, recorded } from "./helpers/yahoo.ts";

const NVDA_PRICE = 210.96;

const create = (
  t: RulesTest,
  symbol: string,
  condition: unknown,
  note?: string,
) =>
  t.rules({
    action: "create",
    symbol,
    condition,
    ...(note === undefined ? {} : { note }),
  });

const alerts = (t: RulesTest) =>
  (t.db.query("select count(*) as n from alerts").get() as { n: number }).n;

const rule = (t: RulesTest, id: number) => readRule(t.db, id)!;

// a quote pass of a market that ended with this status
async function pass(t: RulesTest, status: "ok" | "failed", job = "quotes") {
  await t.write.write((db) => {
    const id = startRun(db, "yahoo", job, t.clock.now(), "US");
    if (status === "ok") endRun(db, id, t.clock.now(), 1);
    else failRun(db, id, t.clock.now(), new SourceError("timed out"));
  });
}

describe("the rule format", () => {
  test("refuses each malformed condition before anything is fetched", async () => {
    const t = await rulesTest();
    const cmp = { left: "price", op: "<", right: 1 };
    const bad: [unknown, string][] = [
      [{ left: "price", op: "<" }, "has no right"],
      [{ left: "price", op: "=", right: 1 }, "op must be one of < <= > >="],
      [{ left: 200, op: ">", right: "price" }, "put the number on the right"],
      [
        { left: "price", op: "<", right: 1, when: "now" },
        "unknown property when",
      ],
      [{ left: "move_atr", op: "<", right: -2 }, "did you mean moveAtr?"],
      [{ left: "volume", op: ">", right: 1 }, "unknown field volume"],
      [
        { left: { field: "price", ticker: "X" }, op: "<", right: 1 },
        "unknown property ticker",
      ],
      [{ left: "relativeReturn1m", op: "<", right: 1 }, "needs a benchmark"],
      [
        { left: { field: "rsi14", benchmark: "QQQ" }, op: "<", right: 1 },
        "only relativeReturn1m and relativeReturn3m take a benchmark",
      ],
      [{ left: "price", op: "<", right: Number.NaN }, "must be"],
      [{ left: "price", op: "<", right: 1e16 }, "must be a finite number"],
      [{ all: [] }, "must be a non-empty list"],
      [{ all: [cmp], any: [cmp] }, "stands alone"],
      [{ all: [{ all: [{ all: [cmp] }] }] }, "nest at most 3 deep"],
      [{ all: Array(9).fill(cmp) }, "at most 8 conditions"],
      [
        { all: [{ all: Array(5).fill(cmp) }, { any: Array(4).fill(cmp) }] },
        "at most 8 comparisons",
      ],
      [
        { all: [{ ...cmp, afterEarnings: "NVDA" }] },
        "on the condition's root only",
      ],
      [[cmp], "condition must be"],
      [
        { left: "price", op: "<", right: 1, x: "y".repeat(5000) },
        "longer than 4096 bytes",
      ],
      [
        {
          all: ["A", "B", "C", "D"].map((s) => ({
            left: { field: "price", symbol: s },
            op: "<",
            right: 1,
          })),
        },
        "at most 4 instruments",
      ],
    ];
    for (const [condition, message] of bad) {
      const r = await create(t, "NVDA", condition);
      expect(r.error).toBe(true);
      expect(r.body.error).toBe("bad_arguments");
      expect(r.body.message).toContain(message);
    }
    const args: [unknown, string][] = [
      [{ action: "make" }, "action must be one of create, list, pause, delete"],
      [
        { action: "create", condition: cmp },
        "symbol must be a non-empty string",
      ],
      [{ action: "create", symbol: "NVDA" }, "create needs a condition"],
      [
        { action: "create", symbol: "NVDA", condition: cmp, id: 1 },
        "id is not an argument of create",
      ],
      [
        {
          action: "create",
          symbol: "NVDA",
          condition: cmp,
          note: "x".repeat(501),
        },
        "note is longer than 500",
      ],
      [{ action: "pause", id: 1 }, "paused must be true or false"],
      [{ action: "delete", id: 1.5 }, "id must be a rule id"],
      [{ action: "list", next: 3 }, "next must be a string"],
      [{ action: "list", next: "9~0000000000" }, "next does not continue"],
    ];
    for (const [input, message] of args) {
      const r = await t.rules(input);
      expect(r.error).toBe(true);
      expect(r.body.message).toContain(message);
    }
    expect(t.calls).toHaveLength(0);
    expect(countRules(t.db)).toBe(0);
  });

  test("refuses what only the resolved instruments tell, storing no rule", async () => {
    const t = await rulesTest({
      fred: true,
      charts: {
        "^VIX": listed(await recorded("chart-vix-5d-1d")),
        "^TNX": listed(await recorded("chart-tnx-5d-1d")),
      },
    });
    const bad: [string, unknown, string][] = [
      [
        "NVDA",
        { left: "previousClose", op: "<", right: 200 },
        "reads no live value",
      ],
      [
        "NVDA",
        { left: "price", op: "<", right: "rsi14" },
        "both sides need the same unit",
      ],
      [
        "NVDA",
        { left: "price", op: ">", right: { field: "price", symbol: "^VIX" } },
        UNKNOWN_UNIT,
      ],
      // index points against a yield, both in a unit Yahoo leaves unknown
      [
        "^VIX",
        { left: "price", op: ">", right: { field: "price", symbol: "^TNX" } },
        UNKNOWN_UNIT,
      ],
      [
        "NVDA",
        {
          left: { field: "relativeReturn1m", benchmark: "FRED:DCOILWTICO" },
          op: "<",
          right: -5,
        },
        NO_RETURN_QUOTE,
      ],
      [
        "NVDA",
        {
          left: {
            field: "relativeReturn3m",
            symbol: "FRED:DGS10",
            benchmark: "^GSPC",
          },
          op: "<",
          right: -5,
        },
        NO_RETURN_QUOTE,
      ],
      [
        "FRED:DGS10",
        { left: "price", op: ">", right: 4 },
        "a series with no quote",
      ],
      [
        "FRED:DGS10",
        { left: "sma50", op: ">", right: 4 },
        "reads no live value",
      ],
    ];
    for (const [symbol, condition, message] of bad) {
      const r = await create(t, symbol, condition);
      expect(r.error).toBe(true);
      expect(r.body.message).toContain(message);
    }
    expect(countRules(t.db)).toBe(0);
    // a series beside a live value is fine
    const ok = await create(t, "NVDA", {
      left: "changePct",
      op: "<",
      right: { field: "drawdown", symbol: "FRED:DGS10" },
    });
    expect(ok.error).toBe(false);
    // an unknown unit against its own values, or across in a known unit
    for (const condition of [
      { left: "price", op: ">", right: "sma50" },
      {
        left: "changePct",
        op: ">",
        right: { field: "changePct", symbol: "^TNX" },
      },
    ]) {
      expect((await create(t, "^VIX", condition)).error).toBe(false);
    }
  });

  test("the tool's description names every field", async () => {
    const t = await rulesTest();
    const tool = tools(t.m).find((x) => x.name === "rules")!;
    for (const name of FIELD_NAMES) expect(tool.description).toContain(name);
    expect(tool.description.length).toBeLessThan(1024);
  });
});

describe("evaluation", () => {
  test("each comparison and combinator against the live price", async () => {
    const t = await rulesTest();
    const price = (op: string, right: number) => ({ left: "price", op, right });
    const cases: [unknown, string][] = [
      [price("<", 211), "true"],
      [price("<", NVDA_PRICE), "false"],
      [price("<=", NVDA_PRICE), "true"],
      [price(">", NVDA_PRICE), "false"],
      [price(">=", NVDA_PRICE), "true"],
      [price(">", 210), "true"],
      [{ all: [price(">", 200), price("<", 100)] }, "false"],
      [{ all: [price(">", 200), price("<", 300)] }, "true"],
      [{ any: [price(">", 300), price("<", 100)] }, "false"],
      [{ any: [price(">", 300), price("<", 300)] }, "true"],
      [
        {
          all: [
            { any: [price("<", 100), price("<", 220)] },
            { left: "dayHigh", op: ">=", right: "dayLow" },
          ],
        },
        "true",
      ],
      [{ all: Array(8).fill(price(">", 1)) }, "true"],
    ];
    for (const [condition, result] of cases) {
      const r = await create(t, "NVDA", condition);
      expect(r.error).toBe(false);
      expect(r.body.evaluation.result).toBe(result);
      // a rule true at creation fires at once
      expect(r.body.alert === null).toBe(result === "false");
    }
  });

  test("true then true fires once, false then true fires again", async () => {
    const t = await rulesTest();
    const r = await create(t, "NVDA", { left: "price", op: "<", right: 200 });
    expect(r.body.evaluation.result).toBe("false");
    await t.quote("NVDA", { price: 199 });
    expect(alerts(t)).toBe(1);
    expect(rule(t, r.body.rule.id)).toMatchObject({
      armed: false,
      lastResult: "true",
    });
    await t.quote("NVDA", { price: 198 });
    expect(alerts(t)).toBe(1);
    await t.quote("NVDA", { price: 201 });
    expect(rule(t, r.body.rule.id)).toMatchObject({
      armed: true,
      lastResult: "false",
    });
    await t.quote("NVDA", { price: 199.5 });
    expect(alerts(t)).toBe(2);
    // each alert holds the values read when it fired
    const snapshots = t.db
      .query("select snapshot from alerts order by id")
      .all()
      .map((r: any) => JSON.parse(r.snapshot));
    expect(snapshots.map((s) => s.values[0].left.value)).toEqual([199, 199.5]);
    expect(snapshots[0].rule).toMatchObject({
      id: r.body.rule.id,
      symbol: "US:NVDA",
    });
  });

  test("an unknown input neither fires nor rearms", async () => {
    const t = await rulesTest();
    const r = await create(t, "NVDA", { left: "price", op: "<", right: 200 });
    const id = r.body.rule.id;
    await pass(t, "failed");
    await t.quote("NVDA", { price: 190 });
    expect(rule(t, id)).toMatchObject({ armed: true, lastResult: "unknown" });
    expect(alerts(t)).toBe(0);
    await pass(t, "ok");
    await t.quote("NVDA", { price: 190 });
    expect(alerts(t)).toBe(1);
    await pass(t, "failed");
    await t.quote("NVDA", { price: 205 });
    // still disarmed: a stale false is no false
    expect(rule(t, id)).toMatchObject({ armed: false, lastResult: "unknown" });
    await pass(t, "ok");
    await t.quote("NVDA", { price: 190 });
    expect(alerts(t)).toBe(1);
  });

  test("a new engine over the same database keeps armed", async () => {
    const t = await rulesTest();
    const r = await create(t, "NVDA", { left: "price", op: "<", right: 200 });
    await t.quote("NVDA", { price: 199 });
    expect(alerts(t)).toBe(1);
    const restarted = await rulesTest({ db: t.db });
    await restarted.quote("NVDA", { price: 198 });
    expect(alerts(t)).toBe(1);
    expect(rule(t, r.body.rule.id).armed).toBe(false);
  });

  test("a rule reading another instrument is evaluated on its quotes", async () => {
    const vix = listed(await recorded("chart-vix-5d-1d"));
    const t = await rulesTest({ charts: { "^VIX": vix } });
    // VIX above 25
    const alone = await create(t, "^VIX", {
      left: "price",
      op: ">",
      right: 25,
    });
    expect(alone.body.rule.symbol).toBe("CXI:^VIX");
    expect(alone.body.evaluation.result).toBe("false");
    // a dip in NVDA while VIX is above 25
    const both = await create(t, "NVDA", {
      all: [
        { left: "changePct", op: "<", right: -3 },
        { left: { field: "price", symbol: "^VIX" }, op: ">", right: 25 },
      ],
    });
    expect(both.body.evaluation.result).toBe("false");
    await t.quote("NVDA", { price: 200 });
    expect(alerts(t)).toBe(0);
    await t.quote("^VIX", { price: 27 });
    const fired = t.db
      .query("select rule_id as rule from alerts order by id")
      .all()
      .map((r: any) => r.rule);
    expect(fired).toEqual([alone.body.rule.id, both.body.rule.id]);
  });

  test("the owner's examples evaluate on the live signals", async () => {
    const t = await rulesTest();
    const below200 = await create(t, "NVDA", {
      left: "price",
      op: "<",
      right: 200,
    });
    const oversold = await create(t, "NVDA", {
      all: [
        { left: "rsi14", op: "<", right: 30 },
        { left: "price", op: ">", right: "sma200" },
      ],
    });
    const atrs = await create(t, "NVDA", {
      left: "moveAtr",
      op: "<",
      right: -2,
    });
    const drawdown = await create(t, "NVDA", {
      left: "drawdown",
      op: "<",
      right: -20,
    });
    for (const r of [below200, oversold, atrs, drawdown]) {
      expect(r.body.evaluation.result).toBe("false");
      for (const v of r.body.evaluation.values) {
        expect(typeof v.left.value).toBe("number");
        expect(v.left.trade_time).toBe("2026-10-23T20:00:00Z");
      }
    }
    const [rsi, above] = oversold.body.evaluation.values;
    expect(rsi.left.value).toBeGreaterThan(30);
    expect(above.right.field).toBe("sma200");
    expect(above.holds).toBe(above.left.value > above.right.value);
    // a fall of more than 2 ATRs and 20% from the 52-week high
    await t.quote("NVDA", { price: 185, dayLow: 184 });
    const fired = new Set(
      t.db
        .query("select rule_id as rule from alerts")
        .all()
        .map((r: any) => r.rule),
    );
    expect(fired).toEqual(
      new Set([
        below200.body.rule.id,
        atrs.body.rule.id,
        drawdown.body.rule.id,
      ]),
    );
  });
});

describe("the earnings gate", () => {
  const calendarWithActuals = (fx: Recorded): Recorded => {
    const out = clone(fx);
    out.body.earningsCalendar[0].epsActual = 2.61;
    return out;
  };

  test("opens only on actuals, and only for prices traded after them", async () => {
    const t = await rulesTest({ finnhub: true });
    // a dip after the company's next earnings
    const r = await create(t, "NVDA", {
      afterEarnings: "NVDA",
      left: "changePct",
      op: "<",
      right: -5,
    });
    expect(r.error).toBe(false);
    expect(r.body.rule.condition.afterEarnings).toEqual({
      symbol: "US:NVDA",
      fiscalYear: 2027,
      fiscalQuarter: 3,
    });
    expect(r.body.rule.after_earnings).toMatchObject({
      date: "2026-11-17",
      status: "scheduled",
      reported_seen_at: null,
    });
    expect(r.body.evaluation).toMatchObject({
      result: "false",
      reasons: [WAITING],
    });
    await t.quote("NVDA", { price: 195 });
    expect(alerts(t)).toBe(0);

    const nvda = readInstrument(t.db, "US:NVDA")!;
    const research = (sections = ["calendar"] as const) =>
      drive(
        t.clock,
        pacedOf(t.m),
        refreshResearch(
          { db: t.db, clock: t.clock, writer: t.write, finnhub: t.m.finnhub },
          nvda,
          [...sections],
          { hooks: t.engine.finnhub },
        ),
      );
    // the scheduled day after the close, no actuals yet
    await t.clock.advance(Date.parse("2026-11-17T21:00:00Z") - t.clock.now());
    await research();
    await t.quote("NVDA", {
      price: 195,
      sessionDays: 25,
      time: Date.parse("2026-11-17T20:00:00Z"),
    });
    expect(rule(t, r.body.rule.id).lastResult).toBe("false");
    expect(alerts(t)).toBe(0);

    // actuals seen at 22:00: the close traded before them does not pass
    await t.clock.advance(Date.parse("2026-11-17T22:00:00Z") - t.clock.now());
    t.calendar.edit = calendarWithActuals;
    await research();
    expect(rule(t, r.body.rule.id).lastResult).toBe("unknown");
    await t.quote("NVDA", {
      price: 194,
      time: Date.parse("2026-11-17T20:01:00Z"),
    });
    expect(rule(t, r.body.rule.id).lastResult).toBe("unknown");
    expect(alerts(t)).toBe(0);

    // the next session's dip does
    await t.clock.advance(Date.parse("2026-11-18T14:45:00Z") - t.clock.now());
    await t.quote("NVDA", {
      price: 195,
      sessionDays: 26,
      time: Date.parse("2026-11-18T14:40:00Z"),
    });
    expect(alerts(t)).toBe(1);
    const snapshot = JSON.parse(
      (t.db.query("select snapshot from alerts").get() as any).snapshot,
    );
    expect(snapshot.after_earnings).toMatchObject({
      symbol: "US:NVDA",
      fiscal_year: 2027,
      fiscal_quarter: 3,
      reported_seen_at: "2026-11-17T22:00:00Z",
    });
  });

  test("binds the next event not yet reported, never one reported today", async () => {
    const t = await rulesTest({ finnhub: true });
    // today's quarter reported at the close, the next one still to come
    t.calendar.edit = (fx) => {
      const out = clone(fx);
      const next = out.body.earningsCalendar[0];
      out.body.earningsCalendar.unshift({
        ...next,
        date: "2026-10-25",
        quarter: 2,
        epsActual: 2.61,
        revenueActual: 110e9,
      });
      return out;
    };
    const r = await create(t, "NVDA", {
      afterEarnings: "NVDA",
      left: "changePct",
      op: "<",
      right: -5,
    });
    expect(r.error).toBe(false);
    expect(r.body.rule.condition.afterEarnings).toEqual({
      symbol: "US:NVDA",
      fiscalYear: 2027,
      fiscalQuarter: 3,
    });
    // a dip traded after today's actuals waits for the next quarter
    await t.clock.advance(10 * 60_000);
    await t.quote("NVDA", { price: 150, time: t.clock.now() - 60_000 });
    expect(rule(t, r.body.rule.id).lastResult).toBe("false");
    expect(alerts(t)).toBe(0);
  });

  test("its event is waited on while the rule exists", async () => {
    const t = await rulesTest({ finnhub: true });
    const r = await create(t, "NVDA", {
      afterEarnings: "NVDA",
      left: "changePct",
      op: "<",
      right: -5,
    });
    const waited = () => t.engine.finnhub.waited(t.db, t.clock.now());
    expect(waited()).toEqual([
      { instrument: "US:NVDA", fiscalYear: 2027, fiscalQuarter: 3 },
    ]);
    await t.rules({ action: "pause", id: r.body.rule.id, paused: true });
    expect(waited()).toHaveLength(1);
    await t.rules({ action: "delete", id: r.body.rule.id });
    expect(waited()).toEqual([]);
  });

  test("is refused with no event source", async () => {
    const off = await rulesTest();
    const gated = {
      afterEarnings: "NVDA",
      left: "changePct",
      op: "<",
      right: -5,
    };
    const r = await create(off, "NVDA", gated);
    expect(r).toMatchObject({
      error: true,
      body: { message: NO_EVENT_SOURCE },
    });
    const on = await rulesTest({
      finnhub: true,
      charts: { "^VIX": listed(await recorded("chart-vix-5d-1d")) },
    });
    const index = await create(on, "NVDA", { ...gated, afterEarnings: "^VIX" });
    expect(index.error).toBe(true);
    expect(index.body.message).toContain(NO_EVENT_SOURCE);
    expect(countRules(off.db) + countRules(on.db)).toBe(0);
  });
});

// a chart answer with one split event at at, in seconds
function withSplit(fx: Recorded, at: number, n: number, d: number): Recorded {
  const out = clone(fx);
  out.body.chart.result[0].events = {
    splits: {
      [at]: { date: at, numerator: n, denominator: d, splitRatio: `${n}:${d}` },
    },
  };
  return out;
}

// a chart answer with every price divided by by
function scaled(fx: Recorded, by: number): Recorded {
  const out = clone(fx);
  const q = out.body.chart.result[0].indicators.quote[0];
  for (const k of ["open", "high", "low", "close"]) {
    q[k] = q[k].map((v: number | null) => (v === null ? null : v / by));
  }
  return out;
}

// a chart answer with its last n prices divided by by
function scaledLast(fx: Recorded, by: number, n: number): Recorded {
  const out = clone(fx);
  const q = out.body.chart.result[0].indicators.quote[0];
  for (const k of ["open", "high", "low", "close"]) {
    q[k] = q[k].map((v: number | null, i: number) =>
      v === null || i < q[k].length - n ? v : v / by,
    );
  }
  return out;
}

// 2026-10-16, inside the 30-day window
const OCT16 = 1792157400;

describe("splits", () => {
  // price levels, levels against the rule's own averages, and the rest
  async function nvdaRules(t: RulesTest) {
    const ids: Record<string, number> = {};
    const add = async (name: string, condition: unknown) => {
      const r = await create(t, "NVDA", condition);
      expect(r.error).toBe(false);
      ids[name] = r.body.rule.id;
    };
    await add("price", { left: "price", op: "<", right: 200 });
    await add("average", { left: "sma50", op: ">", right: 300 });
    await add("trend", { left: "price", op: "<", right: "sma200" });
    await add("rsi", { left: "rsi14", op: "<", right: 30 });
    await add("manual", { left: "dayLow", op: "<", right: 150 });
    await t.rules({ action: "pause", id: ids.manual, paused: true });
    return ids;
  }

  const pausedOf = (t: RulesTest, ids: Record<string, number>) =>
    Object.fromEntries(
      Object.entries(ids).map(([k, id]) => [k, rule(t, id).paused]),
    );

  test("NVDA's 10-for-1 split pauses price levels before they are read again", async () => {
    const t = await rulesTest();
    const ids = await nvdaRules(t);
    const history = listed(await recorded("chart-nvda-5y-1d"));
    const window = await recorded("chart-nvda-5d-1d");

    // Monday's opening quote, after the split, before the bar pass
    await t.clock.advance(Date.parse("2026-10-26T13:35:00Z") - t.clock.now());
    await t.quote("NVDA", {
      price: 21.1,
      previousClose: 21.09,
      dayHigh: 21.2,
      dayLow: 21,
      sessionDays: 3,
      time: Date.parse("2026-10-26T13:31:00Z"),
    });
    expect(alerts(t)).toBe(0);
    const opening = readRule(t.db, ids.price!)!;
    expect(opening.lastResult).toBe("unknown");

    // the bar pass applies the split and pauses the price levels
    const answers = [
      withSplit(scaled(window, 10), OCT16, 10, 1),
      withSplit(scaled(history, 10), OCT16, 10, 1),
    ];
    t.charts.set("NVDA", () => answers.shift()!);
    await refetch(t.ctx, readInstrument(t.db, "US:NVDA")!);
    expect(answers).toHaveLength(0);
    expect(pausedOf(t, ids)).toEqual({
      price: "split",
      average: "split",
      trend: null,
      rsi: null,
      manual: "split",
    });
    // never evaluated on the new scale
    expect(rule(t, ids.price!).lastEvaluatedAt).toBe(opening.lastEvaluatedAt);
    await pass(t, "ok", "bars");
    await t.quote("NVDA", { price: 21 });
    expect(alerts(t)).toBe(0);
    expect(rule(t, ids.trend!).lastResult).not.toBe("unknown");
    expect(rule(t, ids.price!).lastEvaluatedAt).toBe(opening.lastEvaluatedAt);

    // resuming is refused; a rule with new levels runs, and the applied
    // split does not pause it again
    const resumed = await t.rules({
      action: "pause",
      id: ids.price,
      paused: false,
    });
    expect(resumed.error).toBe(true);
    expect(resumed.body.message).toContain("recreate it with new levels");
    const listed1 = await t.rules({ action: "list" });
    expect(listed1.body.rules[0].message).toContain(
      "recreate it with new levels",
    );
    const fresh = await create(t, "NVDA", {
      left: "price",
      op: "<",
      right: 20,
    });
    t.charts.set("NVDA", () => withSplit(scaled(window, 10), OCT16, 10, 1));
    await refetch(t.ctx, readInstrument(t.db, "US:NVDA")!);
    expect(rule(t, fresh.body.rule.id).paused).toBeNull();
  });

  test("a post-split opening quote reads unknown until the bar pass ends", async () => {
    const t = await rulesTest();
    const r = await create(t, "NVDA", { left: "price", op: "<", right: 200 });
    await t.clock.advance(Date.parse("2026-10-26T13:35:00Z") - t.clock.now());
    await t.quote("NVDA", {
      price: 21.1,
      sessionDays: 3,
      time: Date.parse("2026-10-26T13:31:00Z"),
    });
    const after = await t.rules({ action: "list" });
    expect(after.body.rules[0].last_result).toBe("unknown");
    expect(alerts(t)).toBe(0);
    // the bar pass found no split, so its end reads the level again
    const window = await recorded("chart-nvda-5d-1d");
    t.charts.set("NVDA", () => window);
    const jobs = yahooJobs({ ctx: t.ctx, quoteEveryMs: EVERY_MS, log: silent });
    const [bars] = await jobs.barTick();
    expect(bars).toMatchObject({ market: "US", error: null });
    expect(rule(t, r.body.rule.id).lastResult).toBe("true");
    expect(alerts(t)).toBe(1);
  });

  test("past prices adjusted with no split refetch the history and pause them too", async () => {
    const t = await rulesTest();
    const ids = await nvdaRules(t);
    const deep = await create(t, "NVDA", {
      left: "drawdown",
      op: "<",
      right: -50,
    });
    const window = await recorded("chart-nvda-5d-1d");
    const history = listed(await recorded("chart-nvda-5y-1d"));
    const answers = [scaled(window, 2), scaled(history, 2)];
    t.charts.set("NVDA", () => answers.shift()!);
    await refetch(t.ctx, readInstrument(t.db, "US:NVDA")!);
    expect(answers).toHaveLength(0);
    expect(pausedOf(t, ids)).toMatchObject({ price: "split", rsi: null });
    // every stored day on the new scale: a halved price is no deep drawdown
    await pass(t, "ok", "bars");
    await t.quote("NVDA", {
      price: 105.48,
      previousClose: 106.105,
      dayHigh: 106.925,
      dayLow: 105.09,
    });
    const live = t.db
      .query(
        "select drawdown from signals where instrument = 'US:NVDA' and kind = 'live' and interval = '1d'",
      )
      .get() as { drawdown: number };
    expect(live.drawdown).toBeCloseTo(-13.32, 1);
    expect(rule(t, deep.body.rule.id)).toMatchObject({
      paused: null,
      lastResult: "false",
    });
    expect(alerts(t)).toBe(0);
  });

  test("a window's rescale the whole history does not confirm stays paused and writes nothing", async () => {
    const window = await recorded("chart-nvda-5d-1d");
    const history = listed(await recorded("chart-nvda-5y-1d"));
    // the whole history unchanged, or halved only on its recent days
    for (const whole of [history, scaledLast(history, 2, 10)]) {
      const t = await rulesTest();
      const level = await create(t, "NVDA", {
        left: "price",
        op: "<",
        right: 200,
      });
      const closes = () =>
        t.db
          .query("select date, close from bars where instrument = 'US:NVDA'")
          .all();
      const before = closes();
      const answers = [scaled(window, 2), whole];
      t.charts.set("NVDA", () => answers.shift()!);
      await expect(
        refetch(t.ctx, readInstrument(t.db, "US:NVDA")!),
      ).rejects.toThrow("does not confirm");
      expect(answers).toHaveLength(0);
      expect(closes()).toEqual(before);
      expect(rule(t, level.body.rule.id).paused).toBe("split");
      await t.quote("NVDA", { price: NVDA_PRICE / 2 });
      expect(alerts(t)).toBe(0);
    }
  });

  test("a correction to one past bar pauses nothing and refetches no history", async () => {
    const t = await rulesTest();
    const ids = await nvdaRules(t);
    const window = clone(await recorded("chart-nvda-5d-1d"));
    const closes = window.body.chart.result[0].indicators.quote[0].close;
    closes[0] = closes[0] * 0.9;
    const before = t.calls.length;
    t.charts.set("NVDA", () => window);
    await refetch(t.ctx, readInstrument(t.db, "US:NVDA")!);
    expect(t.calls.length - before).toBe(1);
    expect(pausedOf(t, ids)).toMatchObject({ price: null, average: null });
  });

  test("a rescale of half a percent pauses price levels", async () => {
    const t = await rulesTest();
    const level = await create(t, "NVDA", {
      left: "price",
      op: "<",
      right: 210.5,
    });
    const window = await recorded("chart-nvda-5d-1d");
    const history = listed(await recorded("chart-nvda-5y-1d"));
    const answers = [scaled(window, 1.005), scaled(history, 1.005)];
    t.charts.set("NVDA", () => answers.shift()!);
    await refetch(t.ctx, readInstrument(t.db, "US:NVDA")!);
    expect(answers).toHaveLength(0);
    expect(rule(t, level.body.rule.id).paused).toBe("split");
    await pass(t, "ok", "bars");
    await t.quote("NVDA", { price: NVDA_PRICE / 1.005 });
    expect(alerts(t)).toBe(0);
  });

  test("TLV's bonus issue pauses its price levels", async () => {
    const bonus = await recorded("chart-tlv-ro-bonus-2026");
    const before = listed(bonus);
    delete before.body.chart.result[0].events;
    const t = await rulesTest({ charts: { "TLV.RO": before } });
    const level = await create(t, "TLV.RO", {
      left: "price",
      op: "<",
      right: 30,
    });
    const move = await create(t, "TLV.RO", {
      left: "changePct",
      op: "<",
      right: -5,
    });
    expect(level.body.rule.symbol).toBe("BVB:TLV");
    t.charts.set("TLV.RO", () => bonus);
    const tlv = readInstrument(t.db, "BVB:TLV")!;
    await refetch(t.ctx, tlv);
    expect(t.db.query("select ratio from splits").all()).toEqual([
      { ratio: "114.42:100" },
    ]);
    expect(rule(t, level.body.rule.id).paused).toBe("split");
    expect(rule(t, move.body.rule.id).paused).toBeNull();
    // applied once: the next refetch finds nothing new to pause
    const again = await create(t, "TLV.RO", {
      left: "price",
      op: "<",
      right: 25,
    });
    await refetch(t.ctx, tlv);
    expect(rule(t, again.body.rule.id).paused).toBeNull();
  });
});

describe("dependencies", () => {
  test("every instrument a rule reads stays tracked while it exists", async () => {
    const t = await rulesTest({
      charts: { "^VIX": listed(await recorded("chart-vix-5d-1d")) },
    });
    const r = await create(t, "NVDA", {
      all: [
        { left: "changePct", op: "<", right: -3 },
        { left: { field: "price", symbol: "^VIX" }, op: ">", right: 25 },
        {
          left: { field: "relativeReturn1m", benchmark: "^GSPC" },
          op: "<",
          right: -5,
        },
      ],
    });
    expect(r.error).toBe(false);
    const benchmark = r.body.rule.condition.all[2].left.benchmark;
    const reads = ["US:NVDA", "CXI:^VIX", benchmark];
    await t.clock.advance(31 * DAY_MS);
    expect([...trackedIds(t.db, t.clock.now())].sort()).toEqual(reads.sort());
    await t.rules({ action: "pause", id: r.body.rule.id, paused: true });
    expect(trackedIds(t.db, t.clock.now()).size).toBe(3);
    await t.rules({ action: "delete", id: r.body.rule.id });
    expect(trackedIds(t.db, t.clock.now()).size).toBe(0);
  });

  test("a dependency that cannot be fetched leaves no rule", async () => {
    const t = await rulesTest();
    const r = await create(t, "NVDA", {
      left: "changePct",
      op: "<",
      right: { field: "changePct", symbol: "NOSUCHNAME" },
    });
    expect(r.error).toBe(true);
    expect(r.body.error).toBe("not_found");
    expect(r.body.message).toContain("NOSUCHNAME");
    expect(countRules(t.db)).toBe(0);
  });
});

describe("the rules tool", () => {
  test("lists in pages, pauses, resumes and deletes, keeping alerts", async () => {
    const t = await rulesTest();
    const ids: number[] = [];
    for (let k = 0; k < 60; k++) {
      const r = await create(
        t,
        "NVDA",
        { left: "price", op: "<", right: 100 + k },
        `${k} ${"n".repeat(480)}`,
      );
      ids.push(r.body.rule.id);
    }
    const seen: number[] = [];
    let next: string | null = null;
    let pages = 0;
    do {
      const page: any = await t.rules(
        next === null ? { action: "list" } : { action: "list", next },
      );
      seen.push(...page.body.rules.map((x: any) => x.id));
      next = page.body.next;
      pages++;
    } while (next !== null && pages < 10);
    expect(seen).toEqual(ids);
    expect(pages).toBeGreaterThan(1);

    const id = ids[0]!;
    const paused = await t.rules({ action: "pause", id, paused: true });
    expect(paused.body.rule.paused).toBe("manual");
    await t.quote("NVDA", { price: 50 });
    expect(rule(t, id).lastResult).toBe("false");
    const resumed = await t.rules({ action: "pause", id, paused: false });
    expect(resumed.body.rule.paused).toBeNull();
    await t.quote("NVDA", { price: 49 });
    expect(rule(t, id).lastResult).toBe("true");
    const fired = alerts(t);
    expect(fired).toBe(60);
    expect(await t.rules({ action: "delete", id })).toEqual({
      error: false,
      body: { deleted: id, alerts: "kept" },
    });
    expect(alerts(t)).toBe(fired);
    const gone = await t.rules({ action: "delete", id });
    expect(gone).toMatchObject({ error: true, body: { error: "not_found" } });
  });
});
