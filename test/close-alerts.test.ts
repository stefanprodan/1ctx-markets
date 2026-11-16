// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { rebuildWeeks, upsertBars } from "../src/market/bars.ts";
import {
  isBarFinal,
  readSession,
  recordSession,
  sessionDate,
  weekOf,
} from "../src/market/calendars.ts";
import { readInstrument } from "../src/market/instruments.ts";
import { addDays, localDate } from "../src/market/zone.ts";
import { OPERATOR } from "../src/operations/who.ts";
import { CLOSE_NO_RELATIVE, CLOSE_OWN } from "../src/rules/format.ts";
import { readRule } from "../src/rules/store.ts";
import { DAY_MS, MINUTE_MS } from "../src/runtime/clock.ts";
import { signalsAfterBars } from "../src/signals/store.ts";
import { refreshResearch } from "../src/sources/finnhub/sync.ts";
import { SourceError } from "../src/sources/source.ts";
import { endRun, failRun, startRun } from "../src/storage/runs.ts";
import { drive, pacedOf } from "./helpers/drive.ts";
import { type QuoteEdit, type RulesTest, rulesTest } from "./helpers/rules.ts";
import { NOW } from "./helpers/sources.ts";
import {
  backTo,
  clone,
  listed,
  type Recorded,
  recorded,
} from "./helpers/yahoo.ts";

// the recorded session: the Friday of the week the fixtures were recorded
const FRIDAY = addDays(weekOf(localDate("UTC", NOW)), 4);
// a date n days from it; a week is named by its Monday, day(-4) the
// recorded week's
const day = (n: number) => addDays(FRIDAY, n);

// a listing whose sessions a test steps through, days shifted from the
// recorded one
type Listing = { symbol: string; id: string; shift: number };

const listing = (symbol: string, id: string): Listing => ({
  symbol,
  id,
  shift: 0,
});

const create = (
  t: RulesTest,
  symbol: string,
  when: string,
  on: string,
  extra: Record<string, unknown> = {},
) => t.edit({ action: "create", symbol, when, on, ...extra });

const createId = async (...args: Parameters<typeof create>) =>
  (await create(...args)).body.alert.id as number;

const rule = (t: RulesTest, id: number) => readRule(t.db, OPERATOR, id)!;

const triggers = (t: RulesTest, id: number) =>
  t.db
    .query<{ snapshot: string }, [number]>(
      "select snapshot from alerts where rule_id = ? order by id",
    )
    .all(id)
    .map(
      (r) =>
        JSON.parse(r.snapshot) as {
          session: string;
          on: string;
          values: { left: { field: string; value: number }; right: any }[];
        },
    );

const marketOf = (t: RulesTest, l: Listing) =>
  readInstrument(t.db, l.id)!.market;
const stored = (t: RulesTest, l: Listing) => readSession(t.db, marketOf(t, l))!;

const priceOf = (t: RulesTest, l: Listing) =>
  t.db
    .query<{ price: number }, [string]>(
      "select price from quotes where instrument = ?",
    )
    .get(l.id)!.price;

type BarEdit = { date: string; close: number; high?: number; low?: number };

const bar = (date: string, close: number) => ({
  date,
  open: close,
  high: close,
  low: close,
  close,
  volume: 1000,
  final: false,
});

// the bar pass of a session: every bar before it final, its rows written
// and the rules run in its write, as a refetch stores them
async function refetched(t: RulesTest, l: Listing, bars: BarEdit[]) {
  await t.write.write((db) => {
    const i = readInstrument(db, l.id)!;
    const now = t.clock.now();
    const latest = readSession(db, i.market)!;
    const written = upsertBars(
      db,
      l.id,
      "1d",
      bars.map((b) => ({
        ...bar(b.date, b.close),
        high: b.high ?? b.close,
        low: b.low ?? b.close,
        final: isBarFinal(b.date, latest),
      })),
      now,
    );
    db.query(
      `update bars set final = 1 where instrument = ? and interval = '1d'
         and date < ?`,
    ).run(l.id, sessionDate(latest));
    rebuildWeeks(db, l.id, latest, now);
    signalsAfterBars(db, i, written.changedFrom ?? bars[0]?.date ?? null, now);
    endRun(db, startRun(db, "yahoo", "bars", now, l.id), now, bars.length);
    t.engine.evaluate(db, [l.id], now);
  });
}

// the next session stored, as the checks leave it, and its bar pass done;
// given a time, only stored then, before it opens
async function next(t: RulesTest, l: Listing, days: number, at?: number) {
  const market = marketOf(t, l);
  if (at !== undefined) await t.clock.advance(at - t.clock.now());
  await t.write.write((db) => {
    const s = readSession(db, market)!;
    const start = s.start + days * DAY_MS;
    recordSession(
      db,
      market,
      { ...s, start, end: s.end + days * DAY_MS },
      at ?? start,
    );
  });
  l.shift += days;
  if (at !== undefined) return;
  await t.clock.advance(stored(t, l).start + MINUTE_MS - t.clock.now());
  await t.write.write((db) => {
    const run = startRun(db, "yahoo", "bars", t.clock.now(), market);
    endRun(db, run, t.clock.now(), 1);
  });
}

// the next session opens: its bar pass makes the last session's bar final
async function opens(
  t: RulesTest,
  l: Listing,
  days: number,
  close: number = priceOf(t, l),
) {
  const date = sessionDate(stored(t, l));
  await next(t, l, days);
  await refetched(t, l, [{ date, close }]);
}

// a regular pass five minutes on, inside the session
async function intraday(t: RulesTest, l: Listing, price: number) {
  await t.clock.advance(5 * MINUTE_MS);
  await t.quote(l.symbol, {
    price,
    sessionDays: l.shift,
    time: t.clock.now() - 30_000,
  });
}

// the pass after the closing auction, 15 minutes past the end
async function closePass(
  t: RulesTest,
  l: Listing,
  price: number,
  edit: QuoteEdit = {},
) {
  const end = stored(t, l).end;
  await t.clock.advance(end + 15 * MINUTE_MS - t.clock.now());
  await t.quote(l.symbol, {
    price,
    sessionDays: l.shift,
    time: end,
    ...edit,
  });
}

// a session with a dip and its close
async function session(
  t: RulesTest,
  l: Listing,
  days: number,
  close: number,
  dips: number[] = [],
) {
  await opens(t, l, days);
  for (const p of dips) await intraday(t, l, p);
  await closePass(t, l, close);
}

const nvda = () => listing("NVDA", "US:NVDA");

// the listing stored by an alert that never triggers, and the recorded
// session closed at this price, so alerts set next start from it
async function above(t: RulesTest, l: Listing, price = 284.3) {
  await t.edit({ action: "create", symbol: l.symbol, when: "price > 1000000" });
  await t.quote(l.symbol, { price });
}

async function nvdaTest() {
  const t = await rulesTest();
  const l = nvda();
  await above(t, l);
  return { t, l };
}

describe("alerts on the close", () => {
  test("an intraday dip triggers a touch alert, never a close one", async () => {
    const { t, l } = await nvdaTest();
    const touch = (await create(t, "NVDA", "price < 277", "touch")).body;
    const close = (await create(t, "NVDA", "price < 277", "close")).body;
    expect(close.triggered).toBeNull();
    expect(close.alert).toMatchObject({
      on: "close",
      last_close: { session: day(0), holds: false },
    });
    const before = rule(t, close.alert.id);
    await opens(t, l, 3);
    for (const p of [280, 276.9, 283]) await intraday(t, l, p);
    expect(triggers(t, touch.alert.id)).toHaveLength(1);
    expect(triggers(t, close.alert.id)).toHaveLength(0);
    expect(rule(t, close.alert.id)).toEqual(before);
    // its now is the live reading: met if the session ended here
    await intraday(t, l, 276.5);
    const read = (await t.read({ id: close.alert.id })).body.alert;
    expect(read.now[0].holds).toBe(true);
    expect(read.last_close).toEqual({ session: day(0), holds: false });
    await closePass(t, l, 284.3);
    expect(triggers(t, close.alert.id)).toHaveLength(0);
    expect(rule(t, close.alert.id)).toMatchObject({
      closedSession: day(3),
      lastResult: "false",
      armed: true,
    });
  });

  test("triggers on a close, again only after a close where it is false", async () => {
    const { t, l } = await nvdaTest();
    const id = await createId(t, "NVDA", "price < 277", "close");
    const counts: number[] = [];
    for (const [days, close] of [
      [3, 276.5],
      [1, 275],
      [1, 280],
      [1, 276],
    ] as const) {
      await session(t, l, days, close, [281]);
      counts.push(triggers(t, id).length);
    }
    expect(counts).toEqual([1, 1, 1, 2]);
    expect(triggers(t, id).map((s) => [s.on, s.session])).toEqual([
      ["close", day(3)],
      ["close", day(6)],
    ]);
  });

  test("writes after the close and a revised close change nothing", async () => {
    const { t, l } = await nvdaTest();
    const id = await createId(t, "NVDA", "price < 277", "close");
    await session(t, l, 3, 276.5);
    expect(triggers(t, id)).toHaveLength(1);
    const after = rule(t, id);
    // a check storing the close again, a quote of the same listing later
    await t.clock.advance(30 * MINUTE_MS);
    await t.quote("NVDA", { price: 290, sessionDays: l.shift });
    await t.write.write((db) =>
      t.engine.evaluate(db, ["US:NVDA"], t.clock.now()),
    );
    expect(rule(t, id)).toEqual(after);
    // the next morning's bar pass revises the close above the level
    await opens(t, l, 1, 277.1);
    expect(rule(t, id)).toEqual(after);
    expect(triggers(t, id)).toHaveLength(1);
  });

  test("a missed close pass is evaluated from the final bar, once", async () => {
    const { t, l } = await nvdaTest();
    const id = await createId(t, "NVDA", "price < 277", "close");
    const fields = await createId(
      t,
      "NVDA",
      "day_high > 280 and day_low < 275.5 and price < previous_close",
      "close",
    );
    expect(rule(t, fields).closedSession).toBe(day(0));
    await opens(t, l, 3);
    await intraday(t, l, 280);
    // no quote after the closing auction; the bar pass sees the close
    await next(t, l, 1);
    await refetched(t, l, [
      { date: day(3), close: 276.5, high: 281, low: 275 },
    ]);
    expect(triggers(t, id).map((s) => s.session)).toEqual([day(3)]);
    // the bar's own high and low, and the close of the bar before
    const [read] = triggers(t, fields);
    expect(
      Object.fromEntries(read!.values.map((v) => [v.left.field, v.left.value])),
    ).toEqual({ dayHigh: 281, dayLow: 275, price: 276.5 });
    expect(read!.values[2]!.right.value).toBe(284.3);
    expect(rule(t, id).closedSession).toBe(day(3));
    await refetched(t, l, [{ date: day(3), close: 276.4 }]);
    expect(triggers(t, id)).toHaveLength(1);
  });

  test("a pass at the end's minute does not evaluate; the close pass does", async () => {
    const { t, l } = await nvdaTest();
    const id = await createId(t, "NVDA", "price < 277", "close");
    await opens(t, l, 3);
    const end = stored(t, l).end;
    await t.clock.advance(end - t.clock.now());
    await t.quote("NVDA", { price: 276.5, sessionDays: 3, time: end - 30_000 });
    expect(rule(t, id).closedSession).toBe(day(0));
    await closePass(t, l, 284.3);
    expect(triggers(t, id)).toHaveLength(0);
    expect(rule(t, id)).toMatchObject({
      closedSession: day(3),
      lastResult: "false",
    });
  });

  test("an unknown close is left to the final bar", async () => {
    const { t, l } = await nvdaTest();
    const id = await createId(t, "NVDA", "price < 277", "close");
    await opens(t, l, 3);
    // the listing's own refetch failed, so a split may be unseen
    await t.write.write((db) => {
      const now = t.clock.now();
      const run = startRun(db, "yahoo", "bars", now, "US:NVDA");
      failRun(db, run, now, new SourceError("timed out"));
    });
    const before = rule(t, id);
    await closePass(t, l, 276.5);
    expect(rule(t, id)).toEqual(before);
    await opens(t, l, 1, 276.5);
    expect(triggers(t, id).map((s) => s.session)).toEqual([day(3)]);
  });

  for (const untimed of [false, true]) {
    test(`a session the stored one moved past is read from its final bar${untimed ? ", for an untimed quote too" : ""}`, async () => {
      const { t, l } = await nvdaTest();
      const id = await createId(t, "NVDA", "price < 277", "close");
      await opens(t, l, 3);
      await intraday(t, l, 276.5);
      // a check stores the next session hours before it opens
      await next(t, l, 1, Date.parse(`${day(4)}T06:00:00Z`));
      const restored = () =>
        t.write.write((db) => {
          db.query(
            `update quotes set fetched_at = ?, time = ${untimed ? "null" : "time"}
             where instrument = 'US:NVDA'`,
          ).run(t.clock.now());
          t.engine.evaluate(db, ["US:NVDA"], t.clock.now());
        });
      await restored();
      expect(rule(t, id).closedSession).toBe(day(0));
      await next(t, l, 0);
      if (!untimed) {
        // no trade since: the next close pass stores the same quote again
        await t.clock.advance(
          stored(t, l).end + 15 * MINUTE_MS - t.clock.now(),
        );
        await restored();
        expect(rule(t, id).closedSession).toBe(day(0));
      }
      // its final bar closed above the level the last quote showed
      await refetched(t, l, [{ date: day(3), close: 280 }]);
      expect(rule(t, id)).toMatchObject({
        closedSession: day(3),
        lastResult: "false",
      });
      expect(triggers(t, id)).toHaveLength(0);
    });
  }

  test("an index stamped after the close pass is evaluated there, once", async () => {
    const t = await rulesTest({
      charts: { "^VIX": listed(await recorded("chart-vix-5d-1d")) },
    });
    const l = listing("^VIX", "CXI:^VIX");
    await above(t, l, 20);
    const id = await createId(t, "^VIX", "price > 25", "close");
    await opens(t, l, 3);
    await intraday(t, l, 22);
    const end = stored(t, l).end;
    await closePass(t, l, 26, { time: end + 10 * MINUTE_MS });
    expect(triggers(t, id).map((s) => s.session)).toEqual([
      sessionDate(stored(t, l)),
    ]);
    const after = rule(t, id);
    // restamped an hour later with another value
    await t.clock.advance(60 * MINUTE_MS);
    await t.quote("^VIX", {
      price: 24,
      sessionDays: l.shift,
      time: end + 70 * MINUTE_MS,
    });
    expect(rule(t, id)).toEqual(after);
  });

  test("set mid-session, it is checked against the last close", async () => {
    const t = await rulesTest();
    const l = nvda();
    await above(t, l, 276.5);
    await opens(t, l, 3);
    await intraday(t, l, 284);
    const made = (await create(t, "NVDA", "price < 277", "close")).body;
    expect(made.triggered).toMatchObject({
      on: "close",
      session: day(0),
    });
    expect(made.alert).toMatchObject({
      state: "triggered",
      last_close: { session: day(0), holds: true },
    });
    expect(made.alert.now[0]).toMatchObject({ value: 284, holds: false });
    // today's close holds too, but needs a false first
    await closePass(t, l, 276);
    expect(triggers(t, made.alert.id)).toHaveLength(1);
    expect(rule(t, made.alert.id).closedSession).toBe(day(3));
  });

  test("Xetra and US alerts each wait for their own session's close pass", async () => {
    const t = await rulesTest({
      charts: { "VVSM.DE": listed(await recorded("chart-vvsm-de-5d-1d")) },
    });
    const us = nvda();
    const de = listing("VVSM.DE", "XETRA:VVSM");
    await above(t, us);
    await above(t, de, 90);
    const a = await createId(t, "NVDA", "price < 277", "close");
    const b = await createId(t, "VVSM.DE", "price < 86.7", "close");
    await next(t, de, 3);
    await refetched(t, de, [{ date: day(0), close: 90 }]);
    await next(t, us, 3);
    await refetched(t, us, [{ date: day(0), close: 284.3 }]);
    await intraday(t, us, 276);
    await closePass(t, de, 86);
    await intraday(t, us, 276);
    expect(rule(t, b).closedSession).toBe(day(3));
    expect(rule(t, a).closedSession).toBe(day(0));
    await closePass(t, us, 276);
    expect(rule(t, a).closedSession).toBe(day(3));
    expect([triggers(t, a).length, triggers(t, b).length]).toEqual([1, 1]);
  });
});

describe("alerts on the weekly close", () => {
  test("a market with a close pass evaluates the week at Friday's close", async () => {
    const { t, l } = await nvdaTest();
    const id = await createId(t, "NVDA", "price < 277", "weekly_close");
    expect(rule(t, id).closedSession).toBe(day(-4));
    // Monday to Thursday close below, Friday above
    await session(t, l, 3, 276);
    for (let k = 0; k < 3; k++) await session(t, l, 1, 276);
    expect(rule(t, id).closedSession).toBe(day(-4));
    await session(t, l, 1, 280);
    expect(rule(t, id)).toMatchObject({
      closedSession: day(3),
      lastResult: "false",
    });
    // the next Friday closes below
    await session(t, l, 3, 276);
    for (let k = 0; k < 3; k++) await session(t, l, 1, 280);
    await session(t, l, 1, 276);
    expect(triggers(t, id).map((s) => [s.on, s.session])).toEqual([
      ["weekly_close", day(10)],
    ]);
    // a Friday holiday: Thursday is the week's last close
    await session(t, l, 3, 280);
    for (let k = 0; k < 3; k++) await session(t, l, 1, 280);
    expect(rule(t, id).closedSession).toBe(day(10));
    await opens(t, l, 4, 280);
    expect(rule(t, id)).toMatchObject({
      closedSession: day(17),
      lastResult: "false",
      armed: true,
    });
    await refetched(t, l, [{ date: day(20), close: 276 }]);
    expect(rule(t, id).closedSession).toBe(day(17));
    expect(triggers(t, id)).toHaveLength(1);
  });

  test("a market trading Sunday to Thursday is read from the final week", async () => {
    const { t, l } = await nvdaTest();
    const id = await createId(t, "NVDA", "price < 277", "weekly_close");
    // Thursday, then Sunday, closes the week of day(3)
    await session(t, l, 6, 280);
    await session(t, l, 3, 276);
    expect(rule(t, id).closedSession).toBe(day(-4));
    await opens(t, l, 1, 276);
    expect(triggers(t, id).map((s) => s.session)).toEqual([day(3)]);
    await refetched(t, l, [{ date: day(9), close: 276 }]);
    expect(triggers(t, id)).toHaveLength(1);
  });

  test("a failed Friday close pass is read from the final week after Monday's bar pass", async () => {
    const { t, l } = await nvdaTest();
    const id = await createId(t, "NVDA", "price < 277", "weekly_close");
    await opens(t, l, 7);
    await intraday(t, l, 280);
    expect(rule(t, id).closedSession).toBe(day(-4));
    await opens(t, l, 3, 276);
    expect(triggers(t, id).map((s) => s.session)).toEqual([day(3)]);
    await refetched(t, l, [{ date: day(7), close: 275 }]);
    expect(triggers(t, id)).toHaveLength(1);
  });

  test("a week whose Monday bar pass failed is read on Tuesday", async () => {
    const { t, l } = await nvdaTest();
    const id = await createId(t, "NVDA", "price < 277", "weekly_close");
    await opens(t, l, 7);
    await intraday(t, l, 280);
    await next(t, l, 3);
    await t.write.write((db) => {
      const now = t.clock.now();
      failRun(
        db,
        startRun(db, "yahoo", "bars", now, l.id),
        now,
        new SourceError("timed out"),
      );
      t.engine.evaluate(db, [l.id], now);
    });
    expect(rule(t, id).closedSession).toBe(day(-4));
    // Tuesday's stores Friday's close and Monday's, this week's still open
    await next(t, l, 1);
    await refetched(t, l, [
      { date: day(7), close: 276 },
      { date: day(10), close: 280 },
    ]);
    expect(triggers(t, id).map((s) => s.session)).toEqual([day(3)]);
  });

  test("crypto closes are read from final bars once the period rolls", async () => {
    const t = await rulesTest({
      charts: { "SOL-USD": listed(await recorded("chart-sol-usd-5d-1d")) },
    });
    const l = listing("SOL-USD", "CRYPTO:SOL-USD");
    await above(t, l, 120);
    const daily = await createId(t, "SOL-USD", "price < 100", "close");
    const weekly = await createId(t, "SOL-USD", "price < 100", "weekly_close");
    const today = sessionDate(stored(t, l));
    const first = rule(t, daily).closedSession;
    expect(first).not.toBeNull();
    expect(first! < today).toBe(true);
    // a quote two minutes before the UTC today ends is no close
    await t.clock.advance(
      Date.parse(`${today}T23:58:00Z`) + 30_000 - t.clock.now(),
    );
    await t.quote("SOL-USD", {
      price: 99,
      time: Date.parse(`${today}T23:58:00Z`),
    });
    expect(rule(t, daily).closedSession).toBe(first);
    expect(triggers(t, daily)).toHaveLength(0);
    // the period rolled; today closes only once the bar pass stores it
    await next(t, l, 1);
    await t.clock.advance(40 * MINUTE_MS);
    await t.quote("SOL-USD", {
      price: 99,
      sessionDays: 1,
      time: t.clock.now() - 30_000,
    });
    expect(rule(t, daily).closedSession).toBe(first);
    await refetched(t, l, [{ date: today, close: 99 }]);
    expect(triggers(t, daily).map((s) => s.session)).toEqual([today]);
    // the week of a Sunday closes with it
    expect(triggers(t, weekly).map((s) => s.session)).toEqual([day(-4)]);
    await refetched(t, l, [{ date: today, close: 98 }]);
    expect([triggers(t, daily).length, triggers(t, weekly).length]).toEqual([
      1, 1,
    ]);
  });
});

describe("a closed bar not final yet", () => {
  const closeOf = (t: RulesTest, id: string, interval: string, date: string) =>
    t.db
      .query<{ close: number }, [string, string, string]>(
        "select close from bars where instrument = ? and interval = ? and date = ?",
      )
      .get(id, interval, date)!.close;

  // a bar not final, as a quote pass leaves today's and a missed refetch
  // a closed day's, and the weeks built from them
  const pending = (t: RulesTest, l: Listing, date: string, close: number) =>
    t.write.write((db) => {
      const now = t.clock.now();
      upsertBars(db, l.id, "1d", [bar(date, close)], now);
      rebuildWeeks(db, l.id, readSession(db, marketOf(t, l)), now);
    });

  const finals = (t: RulesTest, l: Listing, interval: string) =>
    t.db
      .query<{ date: string; final: number }, [string, string]>(
        `select date, final from bars where instrument = ? and interval = ?
         order by date desc limit 3`,
      )
      .all(l.id, interval)
      .map((b) => [b.date, b.final]);

  // the period rolled to day(3); day(2) waits for its refetch
  async function rolled() {
    const t = await rulesTest({
      charts: {
        "SOL-USD": listed(
          backTo(await recorded("chart-sol-usd-5d-1d"), day(-52)),
        ),
      },
    });
    const l = listing("SOL-USD", "CRYPTO:SOL-USD");
    await above(t, l, 120);
    await pending(t, l, day(2), 120);
    await next(t, l, 1);
    // today's live bar, as real data always has
    await pending(t, l, day(3), 120);
    return { t, l };
  }

  test("a crypto day waits for its final bar, never reading the one before", async () => {
    const { t, l } = await rolled();
    expect(finals(t, l, "1d")).toEqual([
      [day(3), 0],
      [day(2), 0],
      [day(1), 1],
    ]);
    const old = closeOf(t, l.id, "1d", day(1));
    const made = (await create(t, "SOL-USD", `price < ${old + 1}`, "close"))
      .body;
    expect(made.triggered).toBeNull();
    expect(rule(t, made.alert.id)).toMatchObject({
      closedSession: null,
      lastResult: null,
    });
    await refetched(t, l, [{ date: day(2), close: old + 50 }]);
    expect(rule(t, made.alert.id)).toMatchObject({
      closedSession: day(2),
      lastResult: "false",
    });
    expect(triggers(t, made.alert.id)).toHaveLength(0);
  });

  test("an ended week waits to turn final, never reading the one before", async () => {
    const { t, l } = await rolled();
    expect(finals(t, l, "1wk")).toEqual([
      [day(3), 0],
      [day(-4), 0],
      [day(-11), 1],
    ]);
    const old = closeOf(t, l.id, "1wk", day(-11));
    const made = (
      await create(t, "SOL-USD", `price < ${old + 1}`, "weekly_close")
    ).body;
    expect(made.triggered).toBeNull();
    expect(rule(t, made.alert.id).closedSession).toBeNull();
    await refetched(t, l, [{ date: day(2), close: old - 1 }]);
    expect(triggers(t, made.alert.id).map((s) => s.session)).toEqual([day(-4)]);
  });

  test("a bar left not final before the last final one does not wait", async () => {
    const { t, l } = await nvdaTest();
    await opens(t, l, 3);
    await intraday(t, l, 280);
    await next(t, l, 1);
    await refetched(t, l, [{ date: day(3), close: 276.5 }]);
    // a Sunday bar, never made final
    await t.write.write((db) =>
      upsertBars(db, l.id, "1d", [bar(day(-5), 276.5)], t.clock.now()),
    );
    const made = (await create(t, "NVDA", "price < 277", "close")).body;
    expect(made.triggered).toMatchObject({ session: day(3) });
  });

  test("a stock's last day waits through a failed refetch", async () => {
    const { t, l } = await nvdaTest();
    await opens(t, l, 3);
    await intraday(t, l, 295);
    await pending(t, l, day(3), 295);
    // a check stores the next session before it opens
    await next(t, l, 1, Date.parse(`${day(4)}T06:00:00Z`));
    // true on Friday's final bar, which is no longer the last close
    const made = (await create(t, "NVDA", "price < 290", "close")).body;
    expect(made.triggered).toBeNull();
    expect(rule(t, made.alert.id).closedSession).toBeNull();
    await t.clock.advance(stored(t, l).start + MINUTE_MS - t.clock.now());
    await pending(t, l, day(4), 296);
    await t.write.write((db) => {
      const now = t.clock.now();
      failRun(
        db,
        startRun(db, "yahoo", "bars", now, "US"),
        now,
        new SourceError("timed out"),
      );
      t.engine.evaluate(db, ["US:NVDA"], now);
    });
    expect(rule(t, made.alert.id).closedSession).toBeNull();
    await next(t, l, 0);
    await refetched(t, l, [{ date: day(3), close: 295 }]);
    expect(rule(t, made.alert.id)).toMatchObject({
      closedSession: day(3),
      lastResult: "false",
    });
    expect(triggers(t, made.alert.id)).toHaveLength(0);
    // mid-session with yesterday final: nothing new, and no wait
    await intraday(t, l, 280);
    expect(rule(t, made.alert.id).closedSession).toBe(day(3));
    await closePass(t, l, 280);
    expect(triggers(t, made.alert.id).map((s) => s.session)).toEqual([day(4)]);
  });
});

describe("weekly fields of a daily close alert", () => {
  const weekRow = (t: RulesTest, id: string, monday: string) =>
    t.db
      .query<{ sma50: number }, [string, string]>(
        `select sma50 from signals where instrument = ? and interval = '1wk'
           and kind = 'final' and date = ?`,
      )
      .get(id, monday)!.sma50;

  test("a mid-week crypto day reads the last completed week's row", async () => {
    const t = await rulesTest({
      charts: {
        "SOL-USD": listed(
          backTo(await recorded("chart-sol-usd-5d-1d"), day(-508)),
        ),
      },
    });
    const l = listing("SOL-USD", "CRYPTO:SOL-USD");
    await above(t, l, 120);
    const id = await createId(t, "SOL-USD", "price > weekly_sma50", "close");
    await opens(t, l, 1);
    // the week of day(-4) closed with Sunday's bar
    const level = weekRow(t, l.id, day(-4));
    await opens(t, l, 1, level * 0.9);
    expect(rule(t, id)).toMatchObject({
      closedSession: day(3),
      lastResult: "false",
    });
    const before = triggers(t, id).length;
    await opens(t, l, 1, level * 1.1);
    const fired = triggers(t, id).slice(before);
    expect(fired.map((s) => s.session)).toEqual([day(4)]);
    expect(fired[0]!.values[0]!.right.value).toBeCloseTo(level, 2);
  });

  test("the close pass reads the same row a final bar would", async () => {
    const t = await rulesTest();
    const l = nvda();
    await above(t, l, 1000);
    await opens(t, l, 3);
    const level = weekRow(t, l.id, day(-4));
    const id = await createId(t, "NVDA", "price < weekly_sma50", "close");
    expect(rule(t, id)).toMatchObject({
      closedSession: day(0),
      lastResult: "false",
    });
    await intraday(t, l, level * 0.9);
    await closePass(t, l, level * 0.9);
    const fired = triggers(t, id);
    expect(fired.map((s) => s.session)).toEqual([day(3)]);
    expect(fired[0]!.values[0]!.right.value).toBeCloseTo(level, 2);
    // the live reading takes this week's
    const live = (await t.read({ id })).body.alert.now[0];
    expect(live.level).not.toBeCloseTo(level, 2);
  });
});

describe("what a close alert may read", () => {
  test("refuses other symbols, relative returns and a listing with no quote", async () => {
    const t = await rulesTest({
      fred: true,
      charts: { "^VIX": listed(await recorded("chart-vix-5d-1d")) },
    });
    const bad: [string, string, string, string][] = [
      ["NVDA", "price < 277 and price(^VIX) > 25", "close", CLOSE_OWN],
      [
        "NVDA",
        "relative_return_1m(^VIX) < -5",
        "weekly_close",
        CLOSE_NO_RELATIVE,
      ],
      ["FRED:DGS10", "sma50 > 4", "close", "has no close to wait for"],
      [
        "NVDA",
        "previous_close > 180",
        "touch",
        "for a close, use price with on: close",
      ],
      [
        "NVDA",
        "previous_close > 180",
        "close",
        "for a close, use price with on: close",
      ],
    ];
    for (const [symbol, when, on, message] of bad) {
      const r = await create(t, symbol, when, on);
      expect(r.error).toBe(true);
      expect(r.body.message).toContain(message);
    }
    const n = t.db.query("select count(*) as n from rules").get() as {
      n: number;
    };
    expect(n.n).toBe(0);
  });

  test("a split pauses a close alert", async () => {
    const { t, l } = await nvdaTest();
    const id = await createId(t, "NVDA", "price < 277", "close");
    await t.write.write((db) =>
      t.engine.rescaled(db, "US:NVDA", t.clock.now()),
    );
    expect(rule(t, id).paused).toBe("split");
    // the same levels on another close: still from before the split
    await t.edit({ action: "update", id, on: "weekly_close" });
    expect(rule(t, id)).toMatchObject({
      paused: "split",
      triggerOn: "weekly_close",
    });
    await session(t, l, 3, 27.6);
    expect(rule(t, id).closedSession).toBeNull();
    expect(triggers(t, id)).toHaveLength(0);
  });
});

describe("the earnings gate on a close", () => {
  const withActuals = (fx: Recorded): Recorded => {
    const out = clone(fx);
    out.body.earningsCalendar[0].epsActual = 2.61;
    return out;
  };

  const research = (t: RulesTest) =>
    drive(
      t.clock,
      pacedOf(t.m),
      refreshResearch(
        { db: t.db, clock: t.clock, writer: t.write, finnhub: t.m.finnhub },
        readInstrument(t.db, "US:NVDA")!,
        ["calendar"],
        { hooks: t.engine.finnhub },
      ),
    );

  // the results seen at this time, scheduled for day(25) after the close
  async function gated(seen: string) {
    const t = await rulesTest({ finnhub: true });
    const l = nvda();
    const r = await create(t, "NVDA", "change_percent < -5", "close", {
      after_earnings: "NVDA",
    });
    expect(r.body.alert.state).toBe("waiting_for_earnings");
    await opens(t, l, 25, 200);
    await closePass(t, l, 200, { previousClose: 200 });
    expect(rule(t, r.body.alert.id).closedSession).toBe(day(25));
    await t.clock.advance(Date.parse(seen) - t.clock.now());
    t.calendar.edit = withActuals;
    await research(t);
    return { t, l, id: r.body.alert.id as number };
  }

  test("results after the close count from the next session's close", async () => {
    const { t, l, id } = await gated(`${day(25)}T22:00:00Z`);
    expect(rule(t, id).closedSession).toBe(day(25));
    await opens(t, l, 1, 200);
    await closePass(t, l, 180, { previousClose: 200 });
    expect(triggers(t, id).map((s) => s.session)).toEqual([day(26)]);
  });

  test("from a final bar, only a day after the results' date counts", async () => {
    // seen after the close: the next day's final bar counts
    const after = await gated(`${day(25)}T22:00:00Z`);
    await opens(after.t, after.l, 1, 200);
    await opens(after.t, after.l, 1, 180);
    expect(triggers(after.t, after.id).map((s) => s.session)).toEqual([
      day(26),
    ]);
    // seen before the open: that day's final bar cannot tell, so it is
    // spent with no trigger and the next close decides
    const before = await gated(`${day(26)}T12:00:00Z`);
    await opens(before.t, before.l, 1, 200);
    await opens(before.t, before.l, 1, 180);
    expect(triggers(before.t, before.id)).toHaveLength(0);
    expect(rule(before.t, before.id)).toMatchObject({
      closedSession: day(26),
      lastResult: "unknown",
    });
    const read = (await before.t.read({ id: before.id })).body.alert;
    expect(read.last_close).toEqual({ session: day(26), holds: null });
    await closePass(before.t, before.l, 170, { previousClose: 180 });
    expect(triggers(before.t, before.id).map((s) => s.session)).toEqual([
      day(27),
    ]);
  });
});

describe("changing on", () => {
  test("on alone is checked again, rearms and evaluates in the answer", async () => {
    const t = await rulesTest({
      charts: { "^VIX": listed(await recorded("chart-vix-5d-1d")) },
    });
    const l = nvda();
    await above(t, l, 276.5);
    const vix = (await create(t, "NVDA", "price(^VIX) > 25", "touch")).body
      .alert;
    const refused = await t.edit({ action: "update", id: vix.id, on: "close" });
    expect(refused.error).toBe(true);
    expect(refused.body.message).toContain(CLOSE_OWN);
    expect(rule(t, vix.id).triggerOn).toBe("touch");

    const made = (await create(t, "NVDA", "price < 277", "touch")).body;
    expect(made.triggered).not.toBeNull();
    expect(made.triggered).toMatchObject({
      on: "touch",
      session: day(0),
    });
    const id = made.alert.id;
    const changed = (await t.edit({ action: "update", id, on: "close" })).body;
    expect(changed.alert).toMatchObject({
      id,
      on: "close",
      last_close: { session: day(0), holds: true },
    });
    // a new question: triggers again on the same close
    expect(changed.triggered).toMatchObject({
      alert_id: id,
      on: "close",
      session: day(0),
    });
    const read = (await t.read({ id })).body;
    expect(read.history.map((h: any) => h.on)).toEqual(["close", "touch"]);
    // the same on again changes nothing
    const same = (await t.edit({ action: "update", id, on: "close" })).body;
    expect(same.triggered).toBeNull();
    expect(triggers(t, id)).toHaveLength(2);
  });

  test("a new when is evaluated again at a close already evaluated", async () => {
    const { t } = await nvdaTest();
    const made = (await create(t, "NVDA", "price < 100", "close")).body;
    expect(made.alert.last_close).toEqual({
      session: day(0),
      holds: false,
    });
    const changed = (
      await t.edit({ action: "update", id: made.alert.id, when: "price < 300" })
    ).body;
    expect(changed.triggered).toMatchObject({
      on: "close",
      session: day(0),
    });
    expect(changed.alert.last_close).toEqual({
      session: day(0),
      holds: true,
    });
  });
});
