// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { readSession, recordSession } from "../src/market/calendars.ts";
import { readInstrument } from "../src/market/instruments.ts";
import { storeIntraday } from "../src/market/intraday.ts";
import { SWITCH } from "../src/market/stale.ts";
import { trackedIds } from "../src/market/tracking.ts";
import { addDays } from "../src/market/zone.ts";
import {
  alertViews,
  gapPercent,
  NO_EVENT_SOURCE,
  storedWhen,
} from "../src/operations/alerts.ts";
import { OPERATOR } from "../src/operations/who.ts";
import {
  applyRule,
  evaluateRules,
  NO_SESSION,
  WAITING,
} from "../src/rules/evaluate.ts";
import { NO_RETURN_QUOTE, UNKNOWN_UNIT } from "../src/rules/format.ts";
import { countRules, readRule } from "../src/rules/store.ts";
import { DAY_MS } from "../src/runtime/clock.ts";
import { silent } from "../src/runtime/log.ts";
import { MAX_WHEN, parseWhen, WHEN_FIELD_NAMES } from "../src/shared/when.ts";
import { refreshLive } from "../src/signals/store.ts";
import { finnhubJobs } from "../src/sources/finnhub/jobs.ts";
import { readEvents } from "../src/sources/finnhub/read.ts";
import { pruneResearch } from "../src/sources/finnhub/store.ts";
import { refreshResearch } from "../src/sources/finnhub/sync.ts";
import { DeadlinePassed, SourceError } from "../src/sources/source.ts";
import { yahooJobs } from "../src/sources/yahoo/jobs.ts";
import { catchUp, refetch } from "../src/sources/yahoo/sync.ts";
import { endRun, failRun, startRun } from "../src/storage/runs.ts";
import { tools } from "../src/tools/index.ts";
import { drive, pacedOf } from "./helpers/drive.ts";
import { EVERY_MS, type RulesTest, rulesTest } from "./helpers/rules.ts";
import { clone, listed, type Recorded, recorded } from "./helpers/yahoo.ts";

const NVDA_PRICE = 210.96;
// the session after the recorded Friday
const MONDAY = addDays("2026-10-23", 3);

const create = (
  t: RulesTest,
  symbol: string,
  when: string,
  extra: { note?: string; after_earnings?: string } = {},
) => t.edit({ action: "create", symbol, when, ...extra });

// the evaluation stored by the write that answered
const resultOf = (t: RulesTest, r: { body: any }): string | null =>
  rule(t, r.body.alert.id).lastResult;

const alerts = (t: RulesTest) =>
  (t.db.query("select count(*) as n from alerts").get() as { n: number }).n;

const rule = (t: RulesTest, id: number) => readRule(t.db, OPERATOR, id)!;

// a quote pass of a market that ended with this status
async function pass(t: RulesTest, status: "ok" | "failed", job = "quotes") {
  await t.write.write((db) => {
    const id = startRun(db, "yahoo", job, t.clock.now(), "US");
    if (status === "ok") endRun(db, id, t.clock.now(), 1);
    else failRun(db, id, t.clock.now(), new SourceError("timed out"));
  });
}

describe("the alert format", () => {
  test("refuses each malformed when or argument before anything is fetched", async () => {
    const t = await rulesTest();
    const bad: [unknown, string][] = [
      [
        { action: "create", symbol: "NVDA", when: "price = 1" },
        "unknown operator = at 7",
      ],
      [
        { action: "create", symbol: "NVDA", when: "rsi < 30" },
        "unknown field rsi at 1; did you mean rsi14?",
      ],
      [
        {
          action: "create",
          symbol: "NVDA",
          when: "price(A) < 1 and price(B) < 1 and price(C) < 1 and price(D) < 1",
        },
        "at most 4 symbols",
      ],
      [
        { action: "make" },
        "action must be one of create, update, pause, resume, delete",
      ],
      [
        { action: "create", when: "price < 1" },
        "symbol must be a non-empty string",
      ],
      [{ action: "create", symbol: "NVDA" }, "create needs when"],
      [
        { action: "create", symbol: "NVDA", when: "price < 1", id: 1 },
        "id is not an argument of create",
      ],
      [
        { action: "create", symbol: "NVDA", condition: "price < 1" },
        "unknown argument condition",
      ],
      [
        {
          action: "create",
          symbol: "NVDA",
          when: "price < 1",
          note: "x".repeat(501),
        },
        "note is longer than 500",
      ],
      [{ action: "update", id: 1 }, "update needs when, note or both"],
      [
        { action: "update", id: 1, symbol: "AAPL", when: "price < 1" },
        "symbol is not an argument of update",
      ],
      [{ action: "pause", id: 1, paused: true }, "unknown argument paused"],
      [{ action: "delete", id: 1.5 }, "id must be an alert id"],
    ];
    for (const [input, message] of bad) {
      const r = await t.edit(input);
      expect(r.error).toBe(true);
      expect(r.body.error).toBe("bad_arguments");
      expect(r.body.message).toContain(message);
    }
    const reads: [unknown, string][] = [
      [{ next: 3 }, "next must be a string"],
      [{ next: "9~0000000000" }, "next does not continue"],
      [{ since: MONDAY }, "since goes with history"],
      [{ history: true, since: "yesterday" }, "since must be a date"],
      [{ id: 1, symbol: "NVDA" }, "id reads one alert"],
    ];
    for (const [input, message] of reads) {
      const r = await t.read(input);
      expect(r.error).toBe(true);
      expect(r.body.message).toContain(message);
    }
    expect(t.calls).toHaveLength(0);
    expect(countRules(t.db)).toBe(0);
  });

  test("a stored when fits the limit with its full ids, so it goes back as is", () => {
    const id = (n: number) => `X:${"A".repeat(n - 2)}`;
    const cmp = (a: number, b: number) => ({
      left: { field: "price", symbol: id(a) },
      op: "<" as const,
      right: { field: "price", symbol: id(b) },
    });
    const node = (last: number) => ({
      all: [...Array.from({ length: 7 }, () => cmp(52, 52)), cmp(52, last)],
    });
    const at = storedWhen(node(49), "US:NVDA");
    expect(at.length).toBe(MAX_WHEN);
    expect(() => parseWhen(at)).not.toThrow();
    expect(() => storedWhen(node(50), "US:NVDA")).toThrow(
      `as stored is ${MAX_WHEN + 1} characters`,
    );
  });

  test("refuses what only the resolved instruments tell, storing no alert", async () => {
    const t = await rulesTest({
      fred: true,
      charts: {
        "^VIX": listed(await recorded("chart-vix-5d-1d")),
        "^TNX": listed(await recorded("chart-tnx-5d-1d")),
        "CL=F": listed(await recorded("chart-cl-f-5d-1d")),
      },
    });
    const bad: [string, string, string][] = [
      ["NVDA", "previous_close < 200", "reads no live value"],
      [
        "NVDA",
        "price < rsi14",
        "comparison 1 (price < rsi14) compares price in per_share USD with rsi14 in 0 to 100",
      ],
      ["NVDA", "price > price(^VIX)", UNKNOWN_UNIT],
      // index points against a yield: no two indices share a unit
      ["^VIX", "price > price(^TNX)", UNKNOWN_UNIT],
      // a future's price per barrel or per bond, which Yahoo leaves unknown
      ["^VIX", "price > price(CL=F)", UNKNOWN_UNIT],
      ["NVDA", "relative_return_1m(FRED:DCOILWTICO) < -5", NO_RETURN_QUOTE],
      ["NVDA", "relative_return_3m(FRED:DGS10, ^GSPC) < -5", NO_RETURN_QUOTE],
      ["FRED:DGS10", "price > 4", "a series with no quote"],
      ["FRED:DGS10", "sma50 > 4", "reads no live value"],
    ];
    for (const [symbol, when, message] of bad) {
      const r = await create(t, symbol, when);
      expect(r.error).toBe(true);
      expect(r.body.message).toContain(message);
    }
    expect(countRules(t.db)).toBe(0);
    // a series beside a live value is fine
    const ok = await create(t, "NVDA", "change_percent < drawdown(FRED:DGS10)");
    expect(ok.error).toBe(false);
    expect(ok.body.alert.when).toBe("change_percent < drawdown(FRED:DGS10)");
    // an index against its own values, or across in a known unit
    for (const when of [
      "price > sma50",
      "change_percent > change_percent(^TNX)",
    ]) {
      expect((await create(t, "^VIX", when)).error).toBe(false);
    }
  });

  test("the tools' texts fit and the when argument names every field", async () => {
    const t = await rulesTest();
    const list = tools(t.m);
    const read = list.find((x) => x.name === "alerts")!;
    const edit = list.find((x) => x.name === "alerts_edit")!;
    const when: string = (edit.inputSchema as any)[
      "~standard"
    ].jsonSchema.input({
      target: "draft-2020-12",
    }).properties.when.description;
    for (const name of WHEN_FIELD_NAMES) expect(when).toContain(name);
    expect(read.description.length).toBeLessThan(1024);
    expect(edit.description.length).toBeLessThan(1024);
    expect(read.writes).toBeUndefined();
    expect(edit.writes).toBe(true);
  });
});

describe("evaluation", () => {
  test("each comparison and combinator against the live price", async () => {
    const t = await rulesTest();
    const cases: [string, string][] = [
      ["price < 211", "true"],
      [`price < ${NVDA_PRICE}`, "false"],
      [`price <= ${NVDA_PRICE}`, "true"],
      [`price > ${NVDA_PRICE}`, "false"],
      [`price >= ${NVDA_PRICE}`, "true"],
      ["price > 210", "true"],
      ["price > 200 and price < 100", "false"],
      ["price > 200 and price < 300", "true"],
      ["price > 300 or price < 100", "false"],
      ["price > 300 or price < 300", "true"],
      ["(price < 100 or price < 220) and day_high >= day_low", "true"],
      // and binds before or: true or (false and false)
      ["price < 300 or price < 100 and price > 300", "true"],
      ["(price < 300 or price < 100) and price > 300", "false"],
      [Array(8).fill("price > 1").join(" and "), "true"],
    ];
    for (const [when, result] of cases) {
      const r = await create(t, "NVDA", when);
      expect(r.error).toBe(false);
      expect(resultOf(t, r)).toBe(result);
      // an alert true when set triggers in the answer
      expect(r.body.triggered === null).toBe(result === "false");
      if (r.body.triggered !== null) {
        expect(r.body.triggered.alert_id).toBe(r.body.alert.id);
        expect(r.body.alert.state).toBe("triggered");
      }
    }
  });

  test("evaluated now stores nothing and answers what applying would", async () => {
    const t = await rulesTest();
    const a = await create(t, "NVDA", "price < 200");
    const b = await create(t, "NVDA", "price < 211 and rsi14 > 30");
    // true and armed in a session it has not fired in: applying it would fire
    t.db
      .query("update rules set armed = 1, fired_session = null where id = ?")
      .run(b.body.alert.id);
    const rows = () => t.db.query("select * from rules order by id").all();
    const before = rows();
    const fired = alerts(t);
    const listed = [rule(t, a.body.alert.id), rule(t, b.body.alert.id)];
    const now = evaluateRules(t.db, listed, t.clock.now(), EVERY_MS);
    expect(now.map((e) => e.result)).toEqual(["false", "true"]);
    expect(rows()).toEqual(before);
    expect(alerts(t)).toBe(fired);
    const applied = await t.write.write((db) =>
      listed.map((r) => applyRule(db, r, t.clock.now(), EVERY_MS)),
    );
    expect(applied.map((o) => o.evaluation)).toEqual(now);
    expect(applied.map((o) => o.alert !== null)).toEqual([false, true]);
  });

  test("an unknown input neither fires nor rearms", async () => {
    const t = await rulesTest();
    const r = await create(t, "NVDA", "price < 200");
    const id = r.body.alert.id;
    // a pending source switch keeps a quote stale however new
    const switching = (done: boolean) =>
      t.write.write((db) => {
        const at = t.clock.now();
        const run = startRun(db, SWITCH.source, SWITCH.job, at, "US");
        if (done) endRun(db, run, at, 0);
      });
    await switching(false);
    await t.quote("NVDA", { price: 190 });
    expect(rule(t, id)).toMatchObject({ armed: true, lastResult: "unknown" });
    expect(alerts(t)).toBe(0);
    await switching(true);
    await t.quote("NVDA", { price: 190 });
    expect(alerts(t)).toBe(1);
    await switching(false);
    await t.quote("NVDA", { price: 205 });
    // still disarmed: a stale false is no false
    expect(rule(t, id)).toMatchObject({ armed: false, lastResult: "unknown" });
    await switching(true);
    await t.quote("NVDA", { price: 190 });
    expect(alerts(t)).toBe(1);
  });

  test("a quote the failed pass stored is read fresh", async () => {
    const t = await rulesTest();
    const r = await create(t, "NVDA", "price < 200");
    await pass(t, "failed");
    await t.quote("NVDA", { price: 190 });
    expect(rule(t, r.body.alert.id)).toMatchObject({ lastResult: "true" });
    expect(alerts(t)).toBe(1);
  });

  test("a new engine over the same database keeps armed", async () => {
    const t = await rulesTest();
    const r = await create(t, "NVDA", "price < 200");
    await t.quote("NVDA", { price: 199 });
    expect(alerts(t)).toBe(1);
    const restarted = await rulesTest({ db: t.db });
    await restarted.quote("NVDA", { price: 198 });
    expect(alerts(t)).toBe(1);
    expect(rule(t, r.body.alert.id).armed).toBe(false);
  });

  test("a rule reading another instrument is evaluated on its quotes", async () => {
    const vix = listed(await recorded("chart-vix-5d-1d"));
    const t = await rulesTest({ charts: { "^VIX": vix } });
    // VIX above 25
    const alone = await create(t, "^VIX", "price > 25");
    expect(alone.body.alert.symbol).toBe("CXI:^VIX");
    expect(resultOf(t, alone)).toBe("false");
    // a dip in NVDA while VIX is above 25
    const both = await create(
      t,
      "NVDA",
      "change_percent < -3 and price(^VIX) > 25",
    );
    expect(resultOf(t, both)).toBe("false");
    await t.quote("NVDA", { price: 200 });
    expect(alerts(t)).toBe(0);
    await t.quote("^VIX", { price: 27 });
    const fired = t.db
      .query("select rule_id as rule from alerts order by id")
      .all()
      .map((r: any) => r.rule);
    expect(fired).toEqual([alone.body.alert.id, both.body.alert.id]);
  });

  test("the owner's examples evaluate on the live signals", async () => {
    const t = await rulesTest();
    const below200 = await create(t, "NVDA", "price < 200");
    const oversold = await create(t, "NVDA", "rsi14 < 30 and price > sma200");
    const atrs = await create(t, "NVDA", "move_atr < -2");
    const drawdown = await create(t, "NVDA", "drawdown < -20");
    for (const r of [below200, oversold, atrs, drawdown]) {
      expect(resultOf(t, r)).toBe("false");
      expect(r.body.alert.state).toBe("watching");
      for (const v of r.body.alert.now) expect(typeof v.value).toBe("number");
    }
    const [rsi, above] = oversold.body.alert.now;
    expect(rsi).toMatchObject({ field: "rsi14", level: 30 });
    expect(rsi.value).toBeGreaterThan(30);
    expect(above.field).toBe("price");
    expect(above.holds).toBe(above.value > above.level);
    expect(above.gap).toBeCloseTo(above.level - above.value, 4);
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
        below200.body.alert.id,
        atrs.body.alert.id,
        drawdown.body.alert.id,
      ]),
    );
  });
});

// a market's next session stored, and its bar pass done, as the checks and
// the bar job leave them before its first quote
async function nextSession(t: RulesTest, id: string, days: number) {
  const { market } = readInstrument(t.db, id)!;
  await t.write.write((db) => {
    const s = readSession(db, market)!;
    const at = s.start + days * DAY_MS;
    recordSession(
      db,
      market,
      { ...s, start: at, end: s.end + days * DAY_MS },
      at,
    );
  });
  await t.clock.advance(
    readSession(t.db, market)!.start + 60_000 - t.clock.now(),
  );
  await t.write.write((db) => {
    const run = startRun(db, "yahoo", "bars", t.clock.now(), market);
    endRun(db, run, t.clock.now(), 1);
  });
}

describe("one alert a session", () => {
  const xetra = async () =>
    rulesTest({
      charts: { "VVSM.DE": listed(await recorded("chart-vvsm-de-5d-1d")) },
    });
  const at = (iso: string) => {
    const ms = Date.parse(iso);
    return { ms, quote: { time: ms } };
  };

  test("a price hovering at the level fires once in its session", async () => {
    const t = await xetra();
    const r = await create(t, "VVSM.DE", "price <= 80");
    const id = r.body.alert.id;
    expect(resultOf(t, r)).toBe("false");
    for (const price of [79.95, 80.05, 79.77, 80, 80.65, 79.99]) {
      await t.quote("VVSM.DE", { price });
    }
    expect(alerts(t)).toBe(1);
    expect(rule(t, id)).toMatchObject({
      armed: true,
      firedSession: "2026-10-23",
      lastResult: "true",
    });
    const snapshot = JSON.parse(
      (t.db.query("select snapshot from alerts").get() as any).snapshot,
    );
    expect(snapshot.values[0].left.value).toBe(79.95);

    // armed, so the next session's first true fires
    await nextSession(t, "XETRA:VVSM", 3);
    await t.quote("VVSM.DE", {
      price: 79.5,
      sessionDays: 3,
      time: t.clock.now() - 30_000,
    });
    expect(alerts(t)).toBe(2);
    expect(rule(t, id)).toMatchObject({
      armed: false,
      firedSession: MONDAY,
    });
  });

  test("true from one session into the next with no false fires once", async () => {
    const t = await xetra();
    const r = await create(t, "VVSM.DE", "price <= 80");
    await t.quote("VVSM.DE", { price: 79.9 });
    expect(alerts(t)).toBe(1);
    await nextSession(t, "XETRA:VVSM", 3);
    await t.quote("VVSM.DE", {
      price: 79.8,
      sessionDays: 3,
      time: t.clock.now() - 30_000,
    });
    expect(alerts(t)).toBe(1);
    expect(rule(t, r.body.alert.id)).toMatchObject({
      armed: false,
      firedSession: "2026-10-23",
      lastResult: "true",
    });
  });

  test("a day with no session keeps the last trade's, whatever the clock", async () => {
    const t = await xetra();
    const r = await create(t, "VVSM.DE", "price <= 80");
    const id = r.body.alert.id;
    await t.quote("VVSM.DE", { price: 79.9 });
    // a holiday Monday and the Tuesday morning before its open: the quotes
    // still carry the last session's trade time
    for (const day of ["2026-10-26T10:00:00Z", "2026-10-27T06:00:00Z"]) {
      await t.clock.advance(at(day).ms - t.clock.now());
      await t.quote("VVSM.DE", { price: 80.5 });
      await t.quote("VVSM.DE", { price: 79.9 });
    }
    expect(alerts(t)).toBe(1);
    expect(rule(t, id)).toMatchObject({
      armed: true,
      firedSession: "2026-10-23",
    });
    await nextSession(t, "XETRA:VVSM", 4);
    await t.quote("VVSM.DE", {
      price: 79.9,
      sessionDays: 4,
      time: t.clock.now() - 30_000,
    });
    expect(alerts(t)).toBe(2);
    expect(rule(t, id).firedSession).toBe("2026-10-27");
  });

  test("crypto's session is the UTC day", async () => {
    const t = await rulesTest({
      charts: { "SOL-USD": listed(await recorded("chart-sol-usd-5d-1d")) },
    });
    const r = await create(t, "SOL-USD", "price <= 100");
    const id = r.body.alert.id;
    expect(resultOf(t, r)).toBe("false");
    const step = async (iso: string, price: number, sessionDays = 0) => {
      const { ms, quote } = at(iso);
      await t.clock.advance(ms + 30_000 - t.clock.now());
      await t.quote("SOL-USD", { price, sessionDays, ...quote });
    };
    await step("2026-10-25T23:50:00Z", 99);
    await step("2026-10-25T23:55:00Z", 101);
    await step("2026-10-25T23:58:00Z", 99.5);
    expect(alerts(t)).toBe(1);
    expect(rule(t, id)).toMatchObject({
      armed: true,
      firedSession: "2026-10-25",
    });
    await nextSession(t, "CRYPTO:SOL-USD", 1);
    await step("2026-10-26T00:05:00Z", 99, 1);
    expect(alerts(t)).toBe(2);
    expect(rule(t, id).firedSession).toBe(MONDAY);
  });

  test("another symbol's new session does not start the rule's", async () => {
    const vix = listed(await recorded("chart-vix-5d-1d"));
    const t = await rulesTest({ charts: { "^VIX": vix } });
    const r = await create(
      t,
      "NVDA",
      "change_percent > -50 and price(^VIX) > 25",
    );
    const id = r.body.alert.id;
    expect(resultOf(t, r)).toBe("false");
    await t.quote("^VIX", { price: 27 });
    await t.quote("^VIX", { price: 24 });
    expect(alerts(t)).toBe(1);
    await nextSession(t, "CXI:^VIX", 3);
    await t.quote("^VIX", {
      price: 27,
      sessionDays: 3,
      time: t.clock.now() - 30_000,
    });
    expect(rule(t, id)).toMatchObject({
      lastResult: "true",
      armed: true,
      firedSession: "2026-10-23",
    });
    expect(alerts(t)).toBe(1);
    await nextSession(t, "US:NVDA", 3);
    await t.quote("^VIX", { price: 27, sessionDays: 3 });
    expect(alerts(t)).toBe(1);
    await t.quote("NVDA", { sessionDays: 3, time: t.clock.now() - 30_000 });
    expect(alerts(t)).toBe(2);
    expect(rule(t, id).firedSession).toBe(MONDAY);
  });

  test("no session date reads unknown and changes nothing", async () => {
    const vix = listed(await recorded("chart-vix-5d-1d"));
    const t = await rulesTest({ charts: { "^VIX": vix } });
    const r = await create(t, "NVDA", "price(^VIX) > 25");
    const id = r.body.alert.id;
    t.db.query("delete from quotes where instrument = 'US:NVDA'").run();
    await t.quote("^VIX", { price: 27 });
    expect(alerts(t)).toBe(0);
    expect(rule(t, id)).toMatchObject({
      armed: true,
      firedSession: null,
      lastResult: "unknown",
    });
    const evaluated = () =>
      evaluateRules(t.db, [rule(t, id)], t.clock.now(), EVERY_MS)[0]!;
    expect(evaluated()).toMatchObject({
      result: "unknown",
      reasons: [`US:NVDA: ${NO_SESSION}`],
    });
    // named beside the other reasons, not hidden by them
    t.db.query("delete from quotes where instrument = 'CXI:^VIX'").run();
    const { reasons } = evaluated();
    expect(reasons.length).toBeGreaterThan(1);
    expect(reasons).toContain(`US:NVDA: ${NO_SESSION}`);
  });

  test("an untimed quote before the next session opens keeps the last one", async () => {
    const t = await rulesTest();
    const r = await create(t, "NVDA", "price < 200");
    const id = r.body.alert.id;
    // an index page's quote: no trade time, dated by its fetch
    const untimed = (price: number) =>
      t.write.write((db) => {
        db.query(
          `update quotes set time = null, price = ?, fetched_at = ?
           where instrument = 'US:NVDA'`,
        ).run(price, t.clock.now());
        t.engine.evaluate(db, ["US:NVDA"], t.clock.now());
      });
    await untimed(199);
    expect(alerts(t)).toBe(1);
    expect(rule(t, id).firedSession).toBe("2026-10-23");

    // the next session stored by a check hours before it opens
    await t.clock.advance(Date.parse("2026-10-26T06:00:00Z") - t.clock.now());
    await t.write.write((db) => {
      const s = readSession(db, "US")!;
      const shift = 3 * DAY_MS;
      recordSession(
        db,
        "US",
        { ...s, start: s.start + shift, end: s.end + shift },
        t.clock.now(),
      );
    });
    await untimed(201);
    await untimed(199);
    expect(rule(t, id)).toMatchObject({
      lastResult: "true",
      armed: true,
      firedSession: "2026-10-23",
    });
    expect(alerts(t)).toBe(1);

    // its first quote in the open session fires, a false having come
    await t.clock.advance(Date.parse("2026-10-26T13:35:00Z") - t.clock.now());
    await t.write.write((db) => {
      const run = startRun(db, "yahoo", "bars", t.clock.now(), "US");
      endRun(db, run, t.clock.now(), 1);
    });
    await untimed(199);
    expect(alerts(t)).toBe(2);
    expect(rule(t, id).firedSession).toBe(MONDAY);
  });

  test("a fallback date older than the fired session counts as fired", async () => {
    const t = await rulesTest();
    const r = await create(t, "NVDA", "price < 200");
    const id = r.body.alert.id;
    const untimed = (price: number) =>
      t.write.write((db) => {
        db.query(
          `update quotes set time = null, price = ?, fetched_at = ?
           where instrument = 'US:NVDA'`,
        ).run(price, t.clock.now());
        t.engine.evaluate(db, ["US:NVDA"], t.clock.now());
      });
    await untimed(199);
    expect(rule(t, id).firedSession).toBe("2026-10-23");
    await t.clock.advance(Date.parse("2026-10-26T06:00:00Z") - t.clock.now());
    await t.write.write((db) => {
      const s = readSession(db, "US")!;
      const shift = 3 * DAY_MS;
      recordSession(
        db,
        "US",
        { ...s, start: s.start + shift, end: s.end + shift },
        t.clock.now(),
      );
      // the fired session's bar never came, as when its bar pass failed
      db.query(
        `delete from bars where instrument = 'US:NVDA' and interval = '1d'
           and date >= '2026-10-23'`,
      ).run();
    });
    await untimed(201);
    await untimed(199);
    expect(alerts(t)).toBe(1);
    expect(rule(t, id)).toMatchObject({
      armed: true,
      firedSession: "2026-10-23",
    });
  });

  test("a series with no quote takes its final row's date", async () => {
    const t = await rulesTest({ fred: true });
    // the series' drawdown above NVDA's day move
    const r = await create(t, "FRED:DGS10", "change_percent(NVDA) < drawdown");
    const id = r.body.alert.id;
    const series = "FRED:DGS10";
    const final = () =>
      t.db
        .query<{ date: string }, [string]>(
          `select date from signals where instrument = ? and interval = '1d'
             and kind = 'final' order by date desc limit 1`,
        )
        .get(series)!.date;
    const set = (drawdown: number) =>
      t.write.write((db) => {
        db.query(
          `update signals set drawdown = ? where instrument = ?
             and interval = '1d' and kind = 'final' and date = ?`,
        ).run(drawdown, series, final());
        t.engine.evaluate(db, [series], t.clock.now());
      });
    await set(-50);
    expect(rule(t, id).lastResult).toBe("false");
    const first = final();
    await set(50);
    await set(-50);
    await set(50);
    expect(alerts(t)).toBe(1);
    expect(rule(t, id)).toMatchObject({ armed: true, firedSession: first });
    // the next observation's bar and final row, as the series' pass writes them
    const next = addDays(first, 1);
    await t.write.write((db) => {
      for (const [table, where] of [
        ["bars", "interval = '1d' and final = 1"],
        ["signals", "interval = '1d' and kind = 'final'"],
      ]) {
        db.exec(`
          create temp table next_row as select * from ${table}
            where instrument = '${series}' and ${where} and date = '${first}';
          update next_row set date = '${next}';
          insert into ${table} select * from next_row;
          drop table next_row;
        `);
      }
    });
    await set(50);
    expect(alerts(t)).toBe(2);
    expect(rule(t, id).firedSession).toBe(next);
  });

  test("a restart keeps the session it fired in", async () => {
    const t = await rulesTest();
    const r = await create(t, "NVDA", "price < 200");
    await t.quote("NVDA", { price: 199 });
    expect(alerts(t)).toBe(1);
    const restarted = await rulesTest({ db: t.db });
    await restarted.quote("NVDA", { price: 201 });
    await restarted.quote("NVDA", { price: 198 });
    expect(alerts(t)).toBe(1);
    expect(rule(t, r.body.alert.id)).toMatchObject({
      armed: true,
      firedSession: "2026-10-23",
    });
  });

  test("answers watching only while the next true triggers", async () => {
    const t = await xetra();
    const r = await create(t, "VVSM.DE", "price <= 80");
    const id = r.body.alert.id;
    const listedAlert = async () => (await t.read()).body.alerts[0];
    await expect(listedAlert()).resolves.toMatchObject({
      state: "watching",
      last_triggered_at: null,
    });
    await t.quote("VVSM.DE", { price: 79.9 });
    await t.quote("VVSM.DE", { price: 80.1 });
    await t.quote("VVSM.DE", { price: 79.9 });
    // stored armed, but this session already triggered
    expect(rule(t, id).armed).toBe(true);
    const listed = await listedAlert();
    expect(listed).toMatchObject({
      state: "triggered",
      gap_percent: 0,
    });
    expect(listed.last_triggered_at).not.toBeNull();
    expect(listed.reasons).toBeUndefined();
    const view = alertViews(t.m, OPERATOR, [rule(t, id)]).alerts[0]!;
    expect(view).toEqual(listed);
    // the next session's quote before its bar pass is unknown, so it waits
    const { market } = readInstrument(t.db, "XETRA:VVSM")!;
    const s = readSession(t.db, market)!;
    await t.clock.advance(s.start + 3 * DAY_MS + 60_000 - t.clock.now());
    await t.quote("VVSM.DE", {
      price: 79.9,
      sessionDays: 3,
      time: t.clock.now() - 30_000,
    });
    expect(rule(t, id).lastResult).toBe("unknown");
    const unknown = await listedAlert();
    expect(unknown.state).toBe("unknown");
    expect(unknown.reasons.length).toBeGreaterThan(0);
    expect(unknown.now[0].holds).toBeNull();
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
    const r = await create(t, "NVDA", "change_percent < -5", {
      after_earnings: "NVDA",
    });
    expect(r.error).toBe(false);
    expect(r.body.alert.after_earnings).toMatchObject({
      symbol: "US:NVDA",
      fiscal_year: 2027,
      fiscal_quarter: 3,
    });
    expect(r.body.alert.after_earnings).toMatchObject({
      date: "2026-11-17",
      status: "scheduled",
    });
    expect(r.body.alert).toMatchObject({
      when: "change_percent < -5",
      state: "waiting_for_earnings",
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
    expect(rule(t, r.body.alert.id).lastResult).toBe("false");
    expect(alerts(t)).toBe(0);

    // actuals seen at 22:00: the close traded before them does not pass
    await t.clock.advance(Date.parse("2026-11-17T22:00:00Z") - t.clock.now());
    t.calendar.edit = calendarWithActuals;
    await research();
    expect(rule(t, r.body.alert.id).lastResult).toBe("unknown");
    await t.quote("NVDA", {
      price: 194,
      time: Date.parse("2026-11-17T20:01:00Z"),
    });
    expect(rule(t, r.body.alert.id).lastResult).toBe("unknown");
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

  test("a price with no trade time never passes it", async () => {
    const t = await rulesTest({ finnhub: true });
    const r = await create(t, "NVDA", "change_percent < -5", {
      after_earnings: "NVDA",
    });
    const nvda = readInstrument(t.db, "US:NVDA")!;
    await t.clock.advance(Date.parse("2026-11-17T22:00:00Z") - t.clock.now());
    t.calendar.edit = calendarWithActuals;
    await drive(
      t.clock,
      pacedOf(t.m),
      refreshResearch(
        { db: t.db, clock: t.clock, writer: t.write, finnhub: t.m.finnhub },
        nvda,
        ["calendar"],
        { hooks: t.engine.finnhub },
      ),
    );
    // after the results, a dip with no trade time, as an index page gives
    await t.clock.advance(Date.parse("2026-11-18T14:45:00Z") - t.clock.now());
    await t.quote("NVDA", {
      price: 195,
      previousClose: 195,
      sessionDays: 26,
      time: Date.parse("2026-11-18T14:40:00Z"),
    });
    expect(rule(t, r.body.alert.id).lastResult).toBe("false");
    await t.write.write((db) => {
      db.query(
        "update quotes set time = null, change_percent = -20 where instrument = 'US:NVDA'",
      ).run();
      t.engine.evaluate(db, ["US:NVDA"], t.clock.now());
    });
    expect(rule(t, r.body.alert.id).lastResult).toBe("unknown");
    expect(alerts(t)).toBe(0);
  });

  test("a live signal row from a quote with no trade time never passes it", async () => {
    const t = await rulesTest({ finnhub: true });
    const r = await create(t, "NVDA", "rsi14 > 0", { after_earnings: "NVDA" });
    const nvda = readInstrument(t.db, "US:NVDA")!;
    await t.clock.advance(Date.parse("2026-11-17T22:00:00Z") - t.clock.now());
    t.calendar.edit = calendarWithActuals;
    await drive(
      t.clock,
      pacedOf(t.m),
      refreshResearch(
        { db: t.db, clock: t.clock, writer: t.write, finnhub: t.m.finnhub },
        nvda,
        ["calendar"],
        { hooks: t.engine.finnhub },
      ),
    );
    await t.clock.advance(Date.parse("2026-11-18T14:45:00Z") - t.clock.now());
    await t.quote("NVDA", {
      sessionDays: 26,
      time: Date.parse("2026-11-18T14:40:00Z"),
    });
    // the new session's bars in, as the bar pass leaves them
    await drive(t.clock, pacedOf(t.m), refetch(t.ctx, nvda));
    await pass(t, "ok", "bars");
    await t.write.write((db) => {
      refreshLive(db, nvda, t.clock.now());
      t.engine.evaluate(db, ["US:NVDA"], t.clock.now());
    });
    // traded after the results, so its live row may pass
    expect(rule(t, r.body.alert.id).lastResult).toBe("true");
    // with no trade time the live row is dated by its fetch, not by its trade
    await t.write.write((db) => {
      db.query(
        "update quotes set time = null where instrument = 'US:NVDA'",
      ).run();
      refreshLive(db, nvda, t.clock.now());
      t.engine.evaluate(db, ["US:NVDA"], t.clock.now());
    });
    expect(rule(t, r.body.alert.id).lastResult).toBe("unknown");
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
    const r = await create(t, "NVDA", "change_percent < -5", {
      after_earnings: "NVDA",
    });
    expect(r.error).toBe(false);
    expect(r.body.alert.after_earnings).toMatchObject({
      symbol: "US:NVDA",
      fiscal_year: 2027,
      fiscal_quarter: 3,
    });
    // a dip traded after today's actuals waits for the next quarter
    await t.clock.advance(10 * 60_000);
    await t.quote("NVDA", { price: 150, time: t.clock.now() - 60_000 });
    expect(rule(t, r.body.alert.id).lastResult).toBe("false");
    expect(alerts(t)).toBe(0);
  });

  test("fires once on the first sighting from the market calendar", async () => {
    const t = await rulesTest({ finnhub: true });
    const r = await create(t, "NVDA", "change_percent < -5", {
      after_earnings: "NVDA",
    });
    // the whole market's answer lists the share with its actuals
    t.calendar.edit = (fx) => {
      const rows: { symbol: string }[] = fx.body.earningsCalendar;
      if (rows.every((r) => r.symbol === "NVDA")) return fx;
      const out = clone(fx);
      out.body.earningsCalendar.push({
        symbol: "NVDA",
        date: "2026-11-17",
        hour: "amc",
        quarter: 3,
        year: 2027,
        epsEstimate: 2.5,
        epsActual: 2.61,
        revenueEstimate: 60e9,
        revenueActual: 62e9,
      });
      return out;
    };
    const jobs = finnhubJobs({
      ctx: { db: t.db, clock: t.clock, writer: t.write, finnhub: t.m.finnhub },
      log: silent,
      hooks: t.engine.finnhub,
    });
    const market = () =>
      t.calls.filter(
        (u) =>
          u.pathname === "/api/v1/calendar/earnings" &&
          !u.searchParams.has("symbol"),
      ).length;
    await t.clock.advance(Date.parse("2026-11-17T22:00:00Z") - t.clock.now());
    const pass = await drive(t.clock, pacedOf(t.m), jobs.tick());
    expect(pass.market).toEqual({ rows: 1, reported: ["US:NVDA"] });
    expect(market()).toBe(1);
    // evaluated in the write that saw the actuals
    expect(rule(t, r.body.alert.id).lastResult).toBe("unknown");
    await t.clock.advance(Date.parse("2026-11-18T14:45:00Z") - t.clock.now());
    await t.quote("NVDA", {
      price: 195,
      sessionDays: 26,
      time: Date.parse("2026-11-18T14:40:00Z"),
    });
    expect(alerts(t)).toBe(1);
    // reported: the market calendar is not asked again for it
    await t.clock.advance(60 * 60_000);
    await drive(t.clock, pacedOf(t.m), jobs.tick());
    expect(market()).toBe(1);
    expect(alerts(t)).toBe(1);
  });

  test("retention keeps the event it waits on", async () => {
    const t = await rulesTest({ finnhub: true });
    await create(t, "NVDA", "change_percent < -5", { after_earnings: "NVDA" });
    const later = Date.parse("2029-06-01T00:00:00Z");
    await t.write.write((db) =>
      pruneResearch(db, later, t.engine.finnhub.waited(db, later)),
    );
    expect(
      readEvents(t.db, "2000-01-01", "2100-01-01").map(
        (e) => `${e.instrument} ${e.fiscalYear}Q${e.fiscalQuarter}`,
      ),
    ).toEqual(["US:NVDA 2027Q3"]);
  });

  test("its event is waited on while the rule exists", async () => {
    const t = await rulesTest({ finnhub: true });
    const r = await create(t, "NVDA", "change_percent < -5", {
      after_earnings: "NVDA",
    });
    const waited = () => t.engine.finnhub.waited(t.db, t.clock.now());
    expect(waited()).toEqual([
      { instrument: "US:NVDA", fiscalYear: 2027, fiscalQuarter: 3 },
    ]);
    await t.edit({ action: "pause", id: r.body.alert.id });
    expect(waited()).toHaveLength(1);
    await t.edit({ action: "delete", id: r.body.alert.id });
    expect(waited()).toEqual([]);
  });

  test("is refused with no event source", async () => {
    const off = await rulesTest();
    const r = await create(off, "NVDA", "change_percent < -5", {
      after_earnings: "NVDA",
    });
    expect(r).toMatchObject({
      error: true,
      body: { message: NO_EVENT_SOURCE },
    });
    const on = await rulesTest({
      finnhub: true,
      charts: { "^VIX": listed(await recorded("chart-vix-5d-1d")) },
    });
    const index = await create(on, "NVDA", "change_percent < -5", {
      after_earnings: "^VIX",
    });
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
    const add = async (name: string, when: string) => {
      const r = await create(t, "NVDA", when);
      expect(r.error).toBe(false);
      ids[name] = r.body.alert.id;
    };
    await add("price", "price < 200");
    await add("average", "sma50 > 300");
    await add("trend", "price < sma200");
    await add("rsi", "rsi14 < 30");
    await add("manual", "day_low < 150");
    await t.edit({ action: "pause", id: ids.manual });
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
    const opening = readRule(t.db, OPERATOR, ids.price!)!;
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

    // resuming is refused; new levels run, unpaused by the split
    const resumed = await t.edit({ action: "resume", id: ids.price });
    expect(resumed).toMatchObject({
      error: true,
      body: { error: "split_paused" },
    });
    expect(resumed.body.message).toContain("update it with new levels");
    const listed1 = await t.read({ id: ids.price });
    expect(listed1.body.alert.state).toBe("split_paused");
    const updated = await t.edit({
      action: "update",
      id: ids.price,
      when: "price < 20",
    });
    expect(updated.body.alert).toMatchObject({
      id: ids.price,
      when: "price < 20",
      state: "watching",
    });
    expect(updated.body.triggered).toBeNull();
    expect(rule(t, ids.price!)).toMatchObject({
      paused: null,
      lastResult: "false",
    });
    const fresh = await create(t, "NVDA", "price < 20");
    t.charts.set("NVDA", () => withSplit(scaled(window, 10), OCT16, 10, 1));
    await refetch(t.ctx, readInstrument(t.db, "US:NVDA")!);
    expect(rule(t, fresh.body.alert.id).paused).toBeNull();
    expect(rule(t, ids.price!).paused).toBeNull();
  });

  test("a quote answer fetched before a split's rescale stores no session older than the split", async () => {
    const t = await rulesTest();
    await nvdaRules(t);
    const history = listed(await recorded("chart-nvda-5y-1d"));
    const window = await recorded("chart-nvda-5d-1d");
    const answers = [
      withSplit(scaled(window, 10), OCT16, 10, 1),
      withSplit(scaled(history, 10), OCT16, 10, 1),
    ];
    t.charts.set("NVDA", () => answers.shift()!);
    await refetch(t.ctx, readInstrument(t.db, "US:NVDA")!);
    expect(answers).toHaveLength(0);
    // the late answer's points, written after the rescale cleared them
    const at = (iso: string) => ({ at: Date.parse(iso), close: 200 });
    storeIntraday(
      t.db,
      "US:NVDA",
      "America/New_York",
      [at("2026-10-15T15:00:00Z"), at("2026-10-16T15:00:00Z")],
      t.clock.now(),
    );
    const sessions = () =>
      t.db
        .query("select distinct session from intraday order by session")
        .all();
    expect(sessions()).toEqual([{ session: "2026-10-16" }]);
  });

  test("a post-split opening quote reads unknown until the bar pass ends", async () => {
    const t = await rulesTest();
    const r = await create(t, "NVDA", "price < 200");
    await t.clock.advance(Date.parse("2026-10-26T13:35:00Z") - t.clock.now());
    await t.quote("NVDA", {
      price: 21.1,
      sessionDays: 3,
      time: Date.parse("2026-10-26T13:31:00Z"),
    });
    const after = await t.read();
    expect(after.body.alerts[0].state).toBe("unknown");
    expect(alerts(t)).toBe(0);
    // the bar pass found no split, so its end reads the level again
    const window = await recorded("chart-nvda-5d-1d");
    t.charts.set("NVDA", () => window);
    const jobs = yahooJobs({ ctx: t.ctx, quoteEveryMs: EVERY_MS, log: silent });
    const [bars] = await jobs.barTick();
    expect(bars).toMatchObject({ market: "US", error: null });
    expect(rule(t, r.body.alert.id).lastResult).toBe("true");
    expect(alerts(t)).toBe(1);
  });

  test("past prices adjusted with no split refetch the history and pause them too", async () => {
    const t = await rulesTest();
    const ids = await nvdaRules(t);
    const deep = await create(t, "NVDA", "drawdown < -50");
    const window = await recorded("chart-nvda-5d-1d");
    const history = listed(await recorded("chart-nvda-5y-1d"));
    const answers = [scaled(window, 2), scaled(history, 2)];
    t.charts.set("NVDA", () => answers.shift()!);
    const points = () =>
      t.db.query("select count(*) as n from intraday").get() as { n: number };
    storeIntraday(
      t.db,
      "US:NVDA",
      "America/New_York",
      [{ at: t.clock.now(), close: 200 }],
      t.clock.now(),
    );
    await refetch(t.ctx, readInstrument(t.db, "US:NVDA")!);
    expect(answers).toHaveLength(0);
    expect(pausedOf(t, ids)).toMatchObject({ price: "split", rsi: null });
    // on the old scale: the next quote pass refills the session
    expect(points().n).toBe(0);
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
    expect(rule(t, deep.body.alert.id)).toMatchObject({
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
      const level = await create(t, "NVDA", "price < 200");
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
      expect(rule(t, level.body.alert.id).paused).toBe("split");
      await t.quote("NVDA", { price: NVDA_PRICE / 2 });
      expect(alerts(t)).toBe(0);
    }
  });

  test("a read's split answered past its deadline pauses nothing", async () => {
    const t = await rulesTest();
    const level = await create(t, "NVDA", "price < 200");
    const window = await recorded("chart-nvda-5d-1d");
    let alive = true;
    t.charts.set("NVDA", () => {
      alive = false;
      return withSplit(scaled(window, 10), OCT16, 10, 1);
    });
    await expect(
      catchUp(t.ctx, readInstrument(t.db, "US:NVDA")!, () => alive),
    ).rejects.toBeInstanceOf(DeadlinePassed);
    expect(rule(t, level.body.alert.id).paused).toBeNull();
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
    const level = await create(t, "NVDA", "price < 210.5");
    const window = await recorded("chart-nvda-5d-1d");
    const history = listed(await recorded("chart-nvda-5y-1d"));
    const answers = [scaled(window, 1.005), scaled(history, 1.005)];
    t.charts.set("NVDA", () => answers.shift()!);
    await refetch(t.ctx, readInstrument(t.db, "US:NVDA")!);
    expect(answers).toHaveLength(0);
    expect(rule(t, level.body.alert.id).paused).toBe("split");
    await pass(t, "ok", "bars");
    await t.quote("NVDA", { price: NVDA_PRICE / 1.005 });
    expect(alerts(t)).toBe(0);
  });

  test("TLV's bonus issue pauses its price levels", async () => {
    const bonus = await recorded("chart-tlv-ro-bonus-2026");
    const before = listed(bonus);
    delete before.body.chart.result[0].events;
    const t = await rulesTest({ charts: { "TLV.RO": before } });
    const level = await create(t, "TLV.RO", "price < 30");
    const move = await create(t, "TLV.RO", "change_percent < -5");
    expect(level.body.alert.symbol).toBe("BVB:TLV");
    t.charts.set("TLV.RO", () => bonus);
    const tlv = readInstrument(t.db, "BVB:TLV")!;
    await refetch(t.ctx, tlv);
    expect(t.db.query("select ratio from splits").all()).toEqual([
      { ratio: "114.42:100" },
    ]);
    expect(rule(t, level.body.alert.id).paused).toBe("split");
    expect(rule(t, move.body.alert.id).paused).toBeNull();
    // applied once: the next refetch finds nothing new to pause
    const again = await create(t, "TLV.RO", "price < 25");
    await refetch(t.ctx, tlv);
    expect(rule(t, again.body.alert.id).paused).toBeNull();
  });
});

describe("dependencies", () => {
  test("every instrument a rule reads stays tracked while it exists", async () => {
    const t = await rulesTest({
      charts: { "^VIX": listed(await recorded("chart-vix-5d-1d")) },
    });
    const r = await create(
      t,
      "NVDA",
      "change_percent < -3 and price(^VIX) > 25 and relative_return_1m(^GSPC) < -5",
    );
    expect(r.error).toBe(false);
    const benchmark = r.body.alert.now[2].benchmark;
    expect(r.body.alert.now[2].field).toBe("relative_return_1m");
    const reads = ["US:NVDA", "CXI:^VIX", benchmark];
    await t.clock.advance(31 * DAY_MS);
    expect([...trackedIds(t.db, t.clock.now())].sort()).toEqual(reads.sort());
    await t.edit({ action: "pause", id: r.body.alert.id });
    expect(trackedIds(t.db, t.clock.now()).size).toBe(3);
    await t.edit({ action: "delete", id: r.body.alert.id });
    expect(trackedIds(t.db, t.clock.now()).size).toBe(0);
  });

  test("a dependency that cannot be fetched leaves no rule", async () => {
    const t = await rulesTest();
    const r = await create(
      t,
      "NVDA",
      "change_percent < change_percent(NOSUCHNAME)",
    );
    expect(r.error).toBe(true);
    expect(r.body.error).toBe("not_found");
    expect(r.body.message).toContain("NOSUCHNAME");
    expect(countRules(t.db)).toBe(0);
  });
});

describe("the alerts tools", () => {
  test("a create whose write is queued past the deadline answers timeout and adds no alert", async () => {
    const t = await rulesTest();
    const first = await create(t, "NVDA", "price > 1");
    expect(first.error).toBe(false);
    const real = t.m.writer.write;
    // each write waits out the call's deadline before it is queued
    t.m.writer.write = async (fn) => {
      await t.clock.advance(t.m.callMs);
      return real(fn);
    };
    const r = await create(t, "NVDA", "price < 1");
    t.m.writer.write = real;
    expect(r.error).toBe(true);
    expect(r.body.error).toBe("timeout");
    expect(countRules(t.db)).toBe(1);
  });

  test("lists in pages, pauses, resumes and deletes, keeping history", async () => {
    const t = await rulesTest();
    const ids: number[] = [];
    for (let k = 0; k < 60; k++) {
      const r = await create(t, "NVDA", `price < ${100 + k}`, {
        note: `${k} ${"n".repeat(480)}`,
      });
      ids.push(r.body.alert.id);
    }
    const seen: number[] = [];
    let next: string | null = null;
    let pages = 0;
    do {
      const page: any = await t.read(next === null ? {} : { next });
      seen.push(...page.body.alerts.map((x: any) => x.id));
      expect(Object.keys(page.body.instruments)).toEqual(["US:NVDA"]);
      next = page.body.next;
      pages++;
    } while (next !== null && pages < 10);
    expect(seen).toEqual(ids);
    expect(pages).toBeGreaterThan(1);

    const id = ids[0]!;
    const paused = await t.edit({ action: "pause", id });
    expect(paused.body.alert.state).toBe("paused");
    await t.quote("NVDA", { price: 50 });
    expect(rule(t, id).lastResult).toBe("false");
    const resumed = await t.edit({ action: "resume", id });
    expect(resumed.body.alert.state).toBe("watching");
    await t.quote("NVDA", { price: 49 });
    expect(rule(t, id).lastResult).toBe("true");
    const fired = alerts(t);
    expect(fired).toBe(60);
    expect(await t.edit({ action: "delete", id })).toEqual({
      error: false,
      body: { deleted: id },
    });
    expect(alerts(t)).toBe(fired);
    const gone = await t.edit({ action: "delete", id });
    expect(gone).toMatchObject({ error: true, body: { error: "not_found" } });
    const one = await t.read({ id });
    expect(one).toMatchObject({ error: true, body: { error: "not_found" } });
  });

  test("a symbol keeps the list to its alerts", async () => {
    const t = await rulesTest({
      charts: { "^VIX": listed(await recorded("chart-vix-5d-1d")) },
    });
    const nvda = await create(t, "NVDA", "price < 100");
    await create(t, "^VIX", "price > 90");
    const ids = async (symbol: string) =>
      (await t.read({ symbol })).body.alerts.map((a: any) => a.id);
    expect(await ids("NVDA")).toEqual([nvda.body.alert.id]);
    expect(await ids("US:NVDA")).toEqual([nvda.body.alert.id]);
    expect(await ids("ZZNOTSTORED")).toEqual([]);
    expect((await t.read()).body.alerts).toHaveLength(2);
  });

  test("one alert reads with its last five triggers", async () => {
    const t = await rulesTest();
    const r = await create(t, "NVDA", "price < 200");
    const id = r.body.alert.id;
    // a new when each time, so each true triggers again in the session
    for (let k = 0; k < 7; k++) {
      await t.edit({ action: "update", id, when: `price < ${300 + k}` });
    }
    const one = await t.read({ id });
    expect(one.body.alert).toMatchObject({ id, when: "price < 306" });
    expect(one.body.history.map((x: any) => x.when)).toEqual([
      "price < 306",
      "price < 305",
      "price < 304",
      "price < 303",
      "price < 302",
    ]);
    expect(Object.keys(one.body.instruments)).toEqual(["US:NVDA"]);
  });
});

describe("updates", () => {
  test("refuses more than 4 symbols before fetching any", async () => {
    const t = await rulesTest();
    const r = await create(t, "NVDA", "price < 200");
    const calls = t.calls.length;
    const u = await t.edit({
      action: "update",
      id: r.body.alert.id,
      when: "price(A) < 1 and price(B) < 1 and price(C) < 1 and price(D) < 1",
    });
    expect(u.body).toMatchObject({
      error: "bad_arguments",
      message: "an alert reads at most 4 symbols; this one names 5",
    });
    expect(t.calls).toHaveLength(calls);
  });

  test("a new when keeps the id and history, rearms and triggers in the answer", async () => {
    const t = await rulesTest();
    const r = await create(t, "NVDA", "price < 200", { note: "dip" });
    const id = r.body.alert.id;
    await t.quote("NVDA", { price: 199 });
    expect(alerts(t)).toBe(1);
    const fired = rule(t, id).firedSession;
    expect(fired).not.toBeNull();
    expect((await t.read({ id })).body.alert.state).toBe("triggered");
    // the old question triggered this session; the new one is asked anew
    const u = await t.edit({ action: "update", id, when: "price < 205" });
    expect(u.error).toBe(false);
    expect(u.body.alert).toMatchObject({
      id,
      symbol: "US:NVDA",
      when: "price < 205",
      note: "dip",
      state: "triggered",
    });
    expect(u.body.triggered).toMatchObject({
      alert_id: id,
      when: "price < 205",
      values: { price: 199 },
    });
    expect(alerts(t)).toBe(2);
    expect(rule(t, id).firedSession).toBe(fired);
    const history = await t.read({ history: true, id });
    expect(history.body.triggers.map((x: any) => x.when)).toEqual([
      "price < 205",
      "price < 200",
    ]);
    // false when set: it watches, armed for the next true
    const back = await t.edit({ action: "update", id, when: "price < 150" });
    expect(back.body.triggered).toBeNull();
    expect(back.body.alert.state).toBe("watching");
    expect(rule(t, id)).toMatchObject({ armed: true, firedSession: null });
  });

  test("a note alone changes nothing else, and null clears it", async () => {
    const t = await rulesTest();
    const r = await create(t, "NVDA", "price < 300", { note: "first" });
    const id = r.body.alert.id;
    const before = rule(t, id);
    const noted = await t.edit({ action: "update", id, note: "second" });
    expect(noted.body).toMatchObject({
      alert: { id, when: "price < 300", note: "second" },
      triggered: null,
    });
    const cleared = await t.edit({ action: "update", id, note: null });
    expect(cleared.body.alert.note).toBeNull();
    expect(rule(t, id)).toEqual({ ...before, note: null });
    expect(alerts(t)).toBe(1);
  });

  test("a paused alert takes a new when and stays paused", async () => {
    const t = await rulesTest();
    const r = await create(t, "NVDA", "price < 100");
    const id = r.body.alert.id;
    await t.edit({ action: "pause", id });
    const u = await t.edit({ action: "update", id, when: "price < 300" });
    expect(u.body).toMatchObject({
      alert: { state: "paused", when: "price < 300" },
      triggered: null,
    });
    expect(alerts(t)).toBe(0);
  });

  test("another person's or a missing alert is not found and unchanged", async () => {
    const t = await rulesTest();
    t.db
      .query(
        "insert into users (id, name, role, created_at) values ('other', 'Other', 'member', 0)",
      )
      .run();
    const r = await create(t, "NVDA", "price < 100");
    t.db
      .query("update rules set owner = 'other' where id = ?")
      .run(r.body.alert.id);
    for (const id of [r.body.alert.id, 999]) {
      for (const input of [
        { action: "update", id, when: "price < 300" },
        { action: "update", id, note: "x" },
        { action: "pause", id },
        { action: "delete", id },
      ]) {
        const u = await t.edit(input);
        expect(u).toMatchObject({ error: true, body: { error: "not_found" } });
      }
    }
    expect(readRule(t.db, OPERATOR, r.body.alert.id)).toBeNull();
    expect(
      readRule(t.db, "other", r.body.alert.id)!.condition.node,
    ).toMatchObject({ op: "<", right: 100 });
  });

  test("a refused when leaves the alert as it was", async () => {
    const t = await rulesTest();
    const r = await create(t, "NVDA", "price < 100");
    const id = r.body.alert.id;
    const before = rule(t, id);
    for (const when of ["price < rsi14", "price < price(NOSUCHNAME)"]) {
      const u = await t.edit({ action: "update", id, when });
      expect(u.error).toBe(true);
    }
    expect(rule(t, id)).toEqual(before);
  });
});

describe("how close", () => {
  test("gaps per comparison and the alert's distance for and, or and other fields", async () => {
    const t = await rulesTest();
    const pct = (level: number) => ((level - NVDA_PRICE) / NVDA_PRICE) * 100;
    const away = async (when: string) => (await create(t, "NVDA", when)).body;
    const one = await away("price < 200");
    expect(one.alert.now).toEqual([
      {
        field: "price",
        value: NVDA_PRICE,
        level: 200,
        gap: expect.closeTo(200 - NVDA_PRICE, 6),
        gap_percent: expect.closeTo(pct(200), 2),
        holds: false,
      },
    ]);
    expect(one.alert.gap_percent).toBeCloseTo(-pct(200), 2);
    // and: the farthest; or: the nearest
    expect(
      (await away("price < 200 and price < 190")).alert.gap_percent,
    ).toBeCloseTo(-pct(190), 2);
    expect(
      (await away("price < 200 or price < 190")).alert.gap_percent,
    ).toBeCloseTo(-pct(200), 2);
    // a reading other than a price level has no percent
    expect(
      (await away("price < 200 and rsi14 < 20")).alert.gap_percent,
    ).toBeNull();
    expect(
      (await away("price < 200 or rsi14 < 20")).alert.gap_percent,
    ).toBeCloseTo(-pct(200), 2);
    const rsi = await away("rsi14 < 20");
    expect(rsi.alert.gap_percent).toBeNull();
    expect(rsi.alert.now[0]).not.toHaveProperty("gap_percent");
    expect(rsi.alert.now[0].gap).toBeCloseTo(20 - rsi.alert.now[0].value, 3);
    // met: 0
    const met = await away("price < 300");
    expect(met.alert.gap_percent).toBe(0);
    expect(met.alert.now[0].holds).toBe(true);
    // against another field the level is its value now
    const avg = await away("price < sma200");
    expect(avg.alert.now[0].level).toBe(
      (await t.read({ id: avg.alert.id })).body.alert.now[0].level,
    );
    expect(avg.alert.now[0].gap_percent).toBeCloseTo(
      ((avg.alert.now[0].level - NVDA_PRICE) / NVDA_PRICE) * 100,
      2,
    );
  });

  test("a comparison with a missing side gives no distance", () => {
    const side = (symbol: string) => ({
      field: "price",
      symbol,
      value: 100,
      trade_time: null,
    });
    const stale = {
      left: side("CXI:^VIX"),
      op: "<=" as const,
      right: 100,
      holds: null,
    };
    const far = {
      left: side("US:NVDA"),
      op: ">" as const,
      right: 110,
      holds: false,
    };
    const node = (k: "any" | "all") =>
      ({
        [k]: [
          {
            left: { field: "price", symbol: "CXI:^VIX" },
            op: "<=",
            right: 100,
          },
          { left: { field: "price", symbol: "US:NVDA" }, op: ">", right: 110 },
        ],
      }) as never;
    const ev = {
      result: "unknown" as const,
      values: [stale, far],
      reasons: [],
    };
    expect(gapPercent(node("any"), ev)).toBe(10);
    expect(gapPercent(node("all"), ev)).toBeNull();
  });
});

describe("history", () => {
  test("newest first, by alert, symbol and day, a deleted alert's too, in pages bound to their arguments", async () => {
    const t = await rulesTest();
    const ids: number[] = [];
    for (let k = 0; k < 60; k++) {
      const r = await create(t, "NVDA", `price < ${300 + k}`, {
        note: `${k} ${"n".repeat(480)}`,
      });
      expect(r.body.triggered).not.toBeNull();
      ids.push(r.body.alert.id);
    }
    const seen: number[] = [];
    let next: string | null = null;
    let pages = 0;
    do {
      const page: any = await t.read(
        next === null ? { history: true } : { history: true, next },
      );
      seen.push(...page.body.triggers.map((x: any) => x.alert_id));
      next = page.body.next;
      pages++;
      if (next !== null) {
        const other = await t.read({ history: true, symbol: "NVDA", next });
        expect(other.body.message).toContain("next does not continue");
      }
    } while (next !== null && pages < 10);
    expect(seen).toEqual([...ids].reverse());
    expect(pages).toBeGreaterThan(1);

    const id = ids[3]!;
    await t.edit({ action: "delete", id });
    const kept = await t.read({ history: true, id });
    expect(kept.body.triggers).toHaveLength(1);
    expect(kept.body.triggers[0]).toMatchObject({
      alert_id: id,
      symbol: "US:NVDA",
      when: "price < 303",
      values: { price: NVDA_PRICE },
    });
    const count = async (args: object) =>
      (await t.read({ history: true, id, ...args })).body.triggers.length;
    expect(await count({ symbol: "NVDA" })).toBe(1);
    expect(await count({ symbol: "ZZNOTSTORED" })).toBe(0);
    // triggered on the recorded day, before the next one
    expect(await count({ since: addDays(MONDAY, -3) })).toBe(1);
    expect(await count({ since: MONDAY })).toBe(0);
  });

  test("snapshots stored before conditions were text read as triggers", async () => {
    const t = await rulesTest();
    const snapshot = {
      rule: {
        id: 41,
        symbol: "US:NVDA",
        condition: {
          all: [
            {
              left: { field: "changePct", symbol: "US:NVDA" },
              op: "<",
              right: -3,
            },
            {
              left: { field: "price", symbol: "US:NVDA" },
              op: "<",
              right: { field: "sma200", symbol: "US:NVDA" },
            },
            {
              left: { field: "price", symbol: "CXI:^VIX" },
              op: ">",
              right: 25,
            },
          ],
          afterEarnings: {
            symbol: "US:NVDA",
            fiscalYear: 2027,
            fiscalQuarter: 3,
          },
        },
        note: "old",
      },
      after_earnings: {
        symbol: "US:NVDA",
        fiscal_year: 2027,
        fiscal_quarter: 3,
        date: null,
        reported_seen_at: null,
      },
      values: [
        {
          left: {
            field: "changePct",
            symbol: "US:NVDA",
            value: -4,
            trade_time: null,
          },
          op: "<",
          right: -3,
          holds: true,
        },
        {
          left: {
            field: "price",
            symbol: "US:NVDA",
            value: 150,
            trade_time: null,
          },
          op: "<",
          right: {
            field: "sma200",
            symbol: "US:NVDA",
            value: 160,
            trade_time: null,
          },
          holds: true,
        },
        {
          left: {
            field: "price",
            symbol: "CXI:^VIX",
            value: 30,
            trade_time: null,
          },
          op: ">",
          right: 25,
          holds: true,
        },
      ],
    };
    t.db
      .query(
        "insert into alerts (owner, rule_id, fired_at, snapshot) values (?, 41, ?, ?)",
      )
      .run(OPERATOR, t.clock.now(), JSON.stringify(snapshot));
    const read = await t.read({ history: true });
    expect(read.body.triggers).toEqual([
      {
        id: 1,
        alert_id: 41,
        symbol: "US:NVDA",
        when: "change_percent < -3 and price < sma200 and price(CXI:^VIX) > 25",
        note: "old",
        triggered_at: new Date(t.clock.now()).toISOString().replace(".000", ""),
        values: {
          change_percent: -4,
          price: 150,
          sma200: 160,
          "price(CXI:^VIX)": 30,
        },
        after_earnings: snapshot.after_earnings,
      },
    ]);
    // neither listing stored: names come only from stored ones
    expect(read.body.instruments).toEqual({});
  });
});
