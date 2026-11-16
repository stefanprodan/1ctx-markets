// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import {
  type Bar,
  dailyRange,
  hasDailyBars,
  upsertBars,
  weeksOf,
} from "../src/market/bars.ts";
import { upsertInstrument } from "../src/market/instruments.ts";
import { addDays, wallOfDate } from "../src/market/zone.ts";
import { DAY_MS } from "../src/runtime/clock.ts";
import { recomputeSignals, signalsAfterBars } from "../src/signals/store.ts";
import { type Db, open } from "../src/storage/db/index.ts";
import { fakeClock } from "./helpers/clock.ts";

describe("final signals", () => {
  const start = Date.parse("2026-10-26T15:00:00Z");
  const later = start + DAY_MS;
  const scoped = { id: "US:AAA", market: "US" };

  function weekdays(from: string, to: string): string[] {
    const out: string[] = [];
    for (let d = from; d <= to; d = addDays(d, 1)) {
      const w = new Date(wallOfDate(d)).getUTCDay();
      if (w !== 0 && w !== 6) out.push(d);
    }
    return out;
  }

  const barsOn = (dates: readonly string[]): Bar[] =>
    dates.map((date, k) => {
      const close = 100 + 10 * Math.sin(k / 9) + k / 20;
      return {
        date,
        open: close - 0.5,
        high: close + 1,
        low: close - 1,
        close,
        volume: 1000 + ((k * 37) % 500),
        final: true,
      };
    });

  // a week is final once its Friday is
  function store(db: Db, bars: readonly Bar[], now: number) {
    upsertBars(db, scoped.id, "1d", bars, now);
    const last = bars.at(-1)!.date;
    const weeks = weeksOf(bars, null, now).map((w) => ({
      ...w,
      final: addDays(w.date, 4) <= last,
    }));
    upsertBars(db, scoped.id, "1wk", weeks, now);
  }

  function seeded(dates: readonly string[]) {
    const clock = fakeClock(start);
    const { db } = open(":memory:", clock);
    upsertInstrument(
      db,
      {
        market: "US",
        symbol: "AAA",
        source: "yahoo",
        sourceSymbol: "AAA",
        exchange: "NMS",
        name: null,
        type: "EQUITY",
        currency: "USD",
        unit: "per_share",
        zone: "America/New_York",
      },
      clock.now(),
    );
    store(db, barsOn(dates), clock.now());
    signalsAfterBars(db, scoped, null, clock.now());
    return { db, clock };
  }

  const rows = (db: Db) =>
    db
      .query(
        "select * from signals where instrument = ? order by interval, kind, date",
      )
      .all(scoped.id)
      .map((r) => ({ ...(r as object), computed_at: 0 }));

  const all = weekdays("2025-06-02", "2026-10-23");

  test("a bar turning final adds its rows, equal to a full rewrite", () => {
    const appended = seeded(all.slice(0, -1));
    const rewritten = seeded(all.slice(0, -1));
    for (const t of [appended, rewritten]) {
      store(t.db, barsOn(all), later);
    }
    signalsAfterBars(appended.db, scoped, all.at(-1)!, later);
    recomputeSignals(rewritten.db, scoped.id, later);
    signalsAfterBars(rewritten.db, scoped, null, later);
    expect(rows(appended.db)).toEqual(rows(rewritten.db));
    // the earlier rows were kept, and a day and a week added
    const written = appended.db
      .query<{ interval: string; date: string }, [string, number]>(
        `select interval, date from signals
         where instrument = ? and kind = 'final' and computed_at > ?
         order by interval`,
      )
      .all(scoped.id, start);
    expect(written).toEqual([
      { interval: "1d", date: "2026-10-23" },
      { interval: "1wk", date: "2026-10-19" },
    ]);
  });

  // as rows stored by an older build of the maths, or before a column
  for (const [what, set] of [
    ["a value", "rsi14 = rsi14 + 1"],
    ["a column left null", "sma50 = null, cross = null"],
  ] as const) {
    test(`${what} differing on the last stored row rewrites them all`, () => {
      for (const interval of ["1d", "1wk"]) {
        const old = seeded(all.slice(0, -1));
        const rewritten = seeded(all.slice(0, -1));
        const column =
          interval === "1wk"
            ? set.replace("rsi14 = rsi14 + 1", "sma50 = sma50 + 1")
            : set;
        old.db.run(
          `update signals set ${column} where instrument = ? and interval = ?
           and kind = 'final' and date = (select max(date) from signals
             where instrument = ?1 and interval = ?2 and kind = 'final')`,
          [scoped.id, interval],
        );
        for (const t of [old, rewritten]) store(t.db, barsOn(all), later);
        signalsAfterBars(old.db, scoped, all.at(-1)!, later);
        recomputeSignals(rewritten.db, scoped.id, later);
        signalsAfterBars(rewritten.db, scoped, null, later);
        expect(rows(old.db)).toEqual(rows(rewritten.db));
      }
    });
  }

  test("a bar filled in under the stored rows rewrites them all", () => {
    const gap = all[100]!;
    const t = seeded(all.filter((d) => d !== gap));
    store(t.db, barsOn(all), later);
    signalsAfterBars(t.db, scoped, null, later);
    const fresh = seeded(all);
    expect(rows(t.db)).toEqual(rows(fresh.db));
  });

  test("a close changed under the stored rows rewrites them all", () => {
    const t = seeded(all);
    const moved = barsOn(all).map((b, k) =>
      k === 50 ? { ...b, close: b.close + 5 } : b,
    );
    store(t.db, moved, later);
    signalsAfterBars(t.db, scoped, all[50]!, later);
    const fresh = seeded(all);
    store(fresh.db, moved, later);
    recomputeSignals(fresh.db, scoped.id, later);
    signalsAfterBars(fresh.db, scoped, null, later);
    expect(rows(t.db)).toEqual(rows(fresh.db));
    expect(rows(t.db)).not.toEqual(rows(seeded(all).db));
  });
});

test("an instrument has daily bars exactly when a count or a range finds them", () => {
  const clock = fakeClock();
  const { db } = open(":memory:", clock);
  const bar = { open: 1, high: 1, low: 1, close: 1, volume: 1, final: true };
  for (const symbol of ["NONE", "WEEKS", "DAYS"]) {
    upsertInstrument(
      db,
      {
        market: "US",
        symbol,
        source: "yahoo",
        sourceSymbol: symbol,
        exchange: "NMS",
        name: null,
        type: "EQUITY",
        currency: "USD",
        unit: "per_share",
        zone: "America/New_York",
      },
      clock.now(),
    );
  }
  upsertBars(db, "US:WEEKS", "1wk", [{ ...bar, date: "2026-10-19" }], 0);
  upsertBars(db, "US:DAYS", "1d", [{ ...bar, date: "2026-10-23" }], 0);
  const count = db.query<{ n: number }, [string]>(
    "select count(*) as n from bars where instrument = ? and interval = '1d'",
  );
  for (const id of ["US:NONE", "US:WEEKS", "US:DAYS"]) {
    const has = hasDailyBars(db, id);
    expect(has).toBe(count.get(id)!.n > 0);
    expect(has).toBe(dailyRange(db, id) !== null);
  }
  expect(hasDailyBars(db, "US:DAYS")).toBe(true);
});
