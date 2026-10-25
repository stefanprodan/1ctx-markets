// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { type Interval, readBars, upsertBars } from "../src/bars.ts";
import { recordSession, session } from "../src/calendars.ts";
import { MINUTE_MS } from "../src/clock.ts";
import { type Db, open } from "../src/db/index.ts";
import { type Unit, upsertInstrument } from "../src/instruments.ts";
import { silent } from "../src/log.ts";
import { endRun, failRun, startRun } from "../src/runs.ts";
import { dailySeries, liveDaily } from "../src/signals/daily.ts";
import { readRelativeReturn, readSignals } from "../src/signals/read.ts";
import { LEVEL_NOTE, relativeReturn } from "../src/signals/relative.ts";
import { finalPrefix, selectList } from "../src/signals/store.ts";
import { liveWeekly, weeklySeries } from "../src/signals/weekly.ts";
import { JOBS, STALE } from "../src/stale.ts";
import { writer } from "../src/writer.ts";
import { parseSpark, yahoo } from "../src/yahoo/client.ts";
import { yahooJobs } from "../src/yahoo/jobs.ts";
import {
  addInstrument,
  backfill,
  refetch,
  storeQuotes,
} from "../src/yahoo/sync.ts";
import { addDays, fromWallTime, wallOfDate } from "../src/zone.ts";
import { fakeClock } from "./helpers/clock.ts";
import { CRYPTO, sim } from "./helpers/sim.ts";
import {
  clone,
  fakeFetch,
  listed,
  type Recorded,
  recorded,
} from "./helpers/yahoo.ts";

const utc = (iso: string) => Date.parse(`${iso}Z`);
const DAY_S = 24 * 60 * 60;
// 2026-10-16, inside the 30-day window
const OCT16 = 1792157400;

function setup(start: number, route: (url: URL) => Recorded | undefined) {
  const clock = fakeClock(start);
  const { db } = open(":memory:", clock);
  const f = fakeFetch(route);
  const ctx = {
    db,
    clock,
    yahoo: yahoo({ clock, fetch: f.fetch }),
    writer: writer(db),
  };
  return { db, clock, ctx, f };
}

// NVDA's five years, then whatever the next answers are
async function stored(answers: Recorded[] = []) {
  const history = listed(await recorded("chart-nvda-5y-1d"));
  const queue = [history, ...answers];
  const t = setup(Date.parse(history.recordedAt), () => queue.shift());
  const { instrument } = await addInstrument(t.ctx, "NVDA");
  return { ...t, history, instrument };
}

function rows(db: Db, interval: Interval, kind = "final") {
  return db
    .query(
      `select date, ${selectList(interval)} from signals
       where instrument = 'US:NVDA' and interval = ? and kind = ?
       order by date`,
    )
    .all(interval, kind);
}

const closes = (bars: { date: string; close: number }[]) =>
  bars.map((b) => ({ date: b.date, close: b.close }));

function expectFinalRows(db: Db) {
  const days = finalPrefix(readBars(db, "US:NVDA", "1d"));
  const weeks = finalPrefix(readBars(db, "US:NVDA", "1wk"));
  expect(rows(db, "1d")).toEqual(dailySeries(days));
  expect(rows(db, "1wk")).toEqual(weeklySeries(closes(weeks)));
}

// the recorded spark answer's NVDA quote, edited, as Yahoo answers it
async function nvdaSpark(edit: (meta: any) => void = () => {}) {
  const fx = clone(await recorded("spark-v7-batch"));
  fx.body.spark.result = fx.body.spark.result.filter(
    (r: any) => r.symbol === "NVDA",
  );
  edit(fx.body.spark.result[0].response[0].meta);
  return fx.body;
}

const liveRow = (db: Db, interval: Interval) => {
  const all = rows(db, interval, "live");
  expect(all.length).toBeLessThanOrEqual(1);
  return all[0] ?? null;
};

describe("final rows", () => {
  test("appear with the backfill and match the series over its final bars", async () => {
    const { db } = await stored();
    expect(rows(db, "1d")).toHaveLength(1254);
    expectFinalRows(db);
    const last = rows(db, "1d").at(-1) as any;
    expect(last.date).toBe("2026-10-22");
    expect(last.sma200).not.toBeNull();
    const week = rows(db, "1wk").at(-1) as any;
    expect(week.date).toBe("2026-10-12");
    expect(week.sma200).not.toBeNull();
    // no quote yet, so no live row
    expect(rows(db, "1d", "live")).toEqual([]);
  });

  test("none until the backfill ends", async () => {
    // asked for ten years, the recording starts five years back
    const short = await recorded("chart-nvda-5y-1d");
    let route: Recorded = short;
    const { db, ctx, clock } = setup(Date.parse(short.recordedAt), () => route);
    const { instrument } = await addInstrument(ctx, "NVDA");
    expect(readBars(db, "US:NVDA", "1d")).toEqual([]);
    const body = await nvdaSpark();
    await ctx.writer.write((db) =>
      storeQuotes(db, parseSpark(body, clock.now())),
    );
    expect(db.query("select count(*) as n from signals").get()).toEqual({
      n: 0,
    });
    const before = readSignals(db, "US:NVDA", clock.now())!;
    expect(before.daily).toEqual({ final: null, live: null });
    expect(before.stale.live).toContain(STALE.noHistory);
    expect(before.stale.live).not.toContain(STALE.signalsPending);

    route = listed(short);
    await backfill(ctx, instrument);
    expectFinalRows(db);
    // the stored quote makes the live row in the backfill's write
    expect(liveRow(db, "1d")).toMatchObject({ date: "2026-10-23" });
  });

  test("a changed past bar recomputes them from the first bar", async () => {
    const fx = clone(await recorded("chart-nvda-5d-1d"));
    fx.body.chart.result[0].indicators.quote[0].close[3] = 212.5;
    const { db, ctx, instrument } = await stored([fx]);
    const before = rows(db, "1d") as any[];
    await refetch(ctx, instrument);
    const after = rows(db, "1d") as any[];
    expectFinalRows(db);
    expect(after).toHaveLength(before.length);
    expect(after.at(-1).date).toBe("2026-10-22");
    expect(after.at(-1).sma50).not.toBe(before.at(-1).sma50);
    expect(after.at(-2)).toEqual(before.at(-2));
  });

  test("a split's rewrite recomputes them", async () => {
    const split = (fx: Recorded) => {
      const out = clone(fx);
      out.body.chart.result[0].events = {
        splits: {
          [OCT16]: {
            date: OCT16,
            numerator: 2,
            denominator: 1,
            splitRatio: "2:1",
          },
        },
      };
      return out;
    };
    const history = listed(await recorded("chart-nvda-5y-1d"));
    const halved = clone(history);
    const q = halved.body.chart.result[0].indicators.quote[0];
    for (const k of ["open", "high", "low", "close"]) {
      q[k] = q[k].map((v: number | null) => (v === null ? null : v / 2));
    }
    const { db, ctx, instrument } = await stored([
      split(await recorded("chart-nvda-5d-1d")),
      split(halved),
    ]);
    const before = rows(db, "1d").at(-1) as any;
    await refetch(ctx, instrument);
    expectFinalRows(db);
    const after = rows(db, "1d").at(-1) as any;
    expect(after.sma50).toBeCloseTo(before.sma50 / 2, 9);
    expect(after.rsi14).toBeCloseTo(before.rsi14, 9);
  });
});

describe("live rows", () => {
  test("a weekend quote of Friday's session replaces Friday's bar and its week", async () => {
    const { db, ctx, clock } = await stored();
    const days = readBars(db, "US:NVDA", "1d");
    const body = await nvdaSpark((m) => {
      m.regularMarketPrice = 205;
    });
    await ctx.writer.write((db) =>
      storeQuotes(db, parseSpark(body, clock.now())),
    );
    const finals = dailySeries(finalPrefix(days));
    const expected = liveDaily(
      days,
      finals.at(-1)!,
      { price: 205, dayHigh: 213.85, dayLow: 210.18, volume: 80189765 },
      { date: "2026-10-23", replacesLast: true },
    );
    expect(liveRow(db, "1d")).toEqual(expected);
    const weeks = readBars(db, "US:NVDA", "1wk");
    expect(liveRow(db, "1wk")).toEqual(
      liveWeekly(
        closes(weeks),
        weeklySeries(closes(finalPrefix(weeks))).at(-1)!,
        205,
        { date: "2026-10-19", replacesLast: true },
      ),
    );
    // no day added, final rows left alone
    expect(readBars(db, "US:NVDA", "1d")).toEqual(days);
    expectFinalRows(db);

    const read = readSignals(db, "US:NVDA", clock.now())!;
    expect(read.daily.live).toEqual({
      ...expected,
      computedAt: clock.now(),
      quoteTime: utc("2026-10-23T20:00:00"),
    });
    expect(read.daily.final!.date).toBe("2026-10-22");

    // a later quote moves the one live row
    const next = await nvdaSpark((m) => {
      m.regularMarketPrice = 220;
      m.regularMarketTime += 60;
    });
    await ctx.writer.write((db) =>
      storeQuotes(db, parseSpark(next, clock.now())),
    );
    expect((liveRow(db, "1d") as any).moveAtr).toBeGreaterThan(
      (expected.moveAtr as number) + 1,
    );
  });

  test("a quote without a day high or low gives no live ATR or 52-week range", async () => {
    const { db, ctx, clock } = await stored();
    const body = await nvdaSpark((m) => {
      m.regularMarketDayHigh = 0;
      m.regularMarketDayLow = 0;
    });
    await ctx.writer.write((db) =>
      storeQuotes(db, parseSpark(body, clock.now())),
    );
    expect(liveRow(db, "1d")).toMatchObject({
      date: "2026-10-23",
      atr14: null,
      high52w: null,
      low52w: null,
      drawdown: null,
      daysSinceHigh: null,
    });
    expect((liveRow(db, "1d") as any).rsi14).not.toBeNull();
    expect((rows(db, "1d").at(-1) as any).atr14).not.toBeNull();
  });

  test("a session rollover makes the previous bar's final row before the new live row", async () => {
    const monday = clone(listed(await recorded("chart-nvda-5d-1d")));
    const period = monday.body.chart.result[0].meta.currentTradingPeriod;
    period.regular.start += 3 * DAY_S;
    period.regular.end += 3 * DAY_S;
    const { db, ctx, clock, instrument } = await stored([monday]);
    await clock.advance(utc("2026-10-26T14:00") - clock.now());
    const quote = await nvdaSpark((m) => {
      m.currentTradingPeriod.regular.start += 3 * DAY_S;
      m.currentTradingPeriod.regular.end += 3 * DAY_S;
      m.regularMarketTime = utc("2026-10-26T13:55") / 1000;
      m.regularMarketPrice = 200;
    });
    await ctx.writer.write((db) =>
      storeQuotes(db, parseSpark(quote, clock.now())),
    );
    // Friday's bar is not final yet, so Monday's live row waits
    expect(liveRow(db, "1d")).toBeNull();
    expect(readSignals(db, "US:NVDA", clock.now())!.stale.live).toContain(
      STALE.signalsPending,
    );

    await refetch(ctx, instrument);
    const days = readBars(db, "US:NVDA", "1d");
    expect(days.at(-1)).toMatchObject({ date: "2026-10-23", final: true });
    expectFinalRows(db);
    const finals = rows(db, "1d") as any[];
    expect(finals.at(-1).date).toBe("2026-10-23");
    expect(liveRow(db, "1d")).toEqual(
      liveDaily(
        days,
        finals.at(-1),
        { price: 200, dayHigh: 213.85, dayLow: 210.18, volume: 80189765 },
        { date: "2026-10-26", replacesLast: false },
      ),
    );
    const weeks = readBars(db, "US:NVDA", "1wk");
    expect(weeks.at(-1)).toMatchObject({ date: "2026-10-19", final: true });
    expect(liveRow(db, "1wk")).toEqual(
      liveWeekly(closes(weeks), (rows(db, "1wk") as any[]).at(-1), 200, {
        date: "2026-10-26",
        replacesLast: false,
      }),
    );
    expect(readSignals(db, "US:NVDA", clock.now())!.stale.live).not.toContain(
      STALE.signalsPending,
    );
  });

  test("a quote traded before its market's session began makes none", async () => {
    const { db, ctx, clock } = await stored();
    const friday = await nvdaSpark();
    await ctx.writer.write((db) =>
      storeQuotes(db, parseSpark(friday, clock.now())),
    );
    expect(liveRow(db, "1d")).not.toBeNull();
    // Monday's session shows while the last trade is still Friday's
    const body = await nvdaSpark((m) => {
      m.currentTradingPeriod.regular.start += 3 * DAY_S;
      m.currentTradingPeriod.regular.end += 3 * DAY_S;
    });
    await ctx.writer.write((db) =>
      storeQuotes(db, parseSpark(body, clock.now() + 1000)),
    );
    expect(rows(db, "1d", "live")).toEqual([]);
    expect(rows(db, "1wk", "live")).toEqual([]);
  });
});

describe("a tick at a session's rollover", () => {
  test("finalises the bar, its final row, then the live row", async () => {
    const s = sim([CRYPTO("C0-USD")]);
    const clock = fakeClock(utc("2026-10-25T23:52"));
    const { db } = open(":memory:", clock);
    const f = fakeFetch((url) => s.route(url, clock.now()));
    const ctx = {
      db,
      clock,
      yahoo: yahoo({ clock, fetch: f.fetch }),
      writer: writer(db),
    };
    const jobs = yahooJobs({ ctx, quoteEveryMs: 5 * MINUTE_MS, log: silent });
    await addInstrument(ctx, "C0-USD");
    await clock.advance(utc("2026-10-25T23:55") - clock.now());
    await jobs.quoteTick();
    const live = () =>
      db
        .query(
          "select date from signals where kind = 'live' and interval = '1d'",
        )
        .all();
    expect(live()).toEqual([{ date: "2026-10-25" }]);

    await clock.advance(utc("2026-10-26T00:00") - clock.now());
    await jobs.quoteTick();
    // Sunday's bar is not final until the bar pass
    expect(live()).toEqual([{ date: "2026-10-25" }]);
    await jobs.barTick();
    const days = readBars(db, "CRYPTO:C0-USD", "1d");
    expect(days.at(-2)).toMatchObject({ date: "2026-10-25", final: true });
    const finals = db
      .query(
        `select date, ${selectList("1d")} from signals
         where kind = 'final' and interval = '1d' order by date`,
      )
      .all() as any[];
    expect(finals).toEqual(dailySeries(finalPrefix(days)));
    expect(finals.at(-1).date).toBe("2026-10-25");
    const row = db
      .query(
        `select date, ${selectList("1d")} from signals
         where kind = 'live' and interval = '1d'`,
      )
      .get();
    expect(row).toEqual(
      liveDaily(
        days,
        finals.at(-1),
        { price: 100, dayHigh: 101, dayLow: 98, volume: 1000 },
        { date: "2026-10-26", replacesLast: true },
      ),
    );
  });
});

describe("staleness", () => {
  test("follows the bars, the quote and a pending recompute", async () => {
    const { db, ctx, clock } = await stored();
    const friday = await nvdaSpark();
    await ctx.writer.write((db) =>
      storeQuotes(db, parseSpark(friday, clock.now())),
    );
    let at = clock.now();
    const run = (job: string, error?: unknown) => {
      at += MINUTE_MS;
      const id = startRun(db, "yahoo", job, at, "US");
      if (error === undefined) endRun(db, id, at, 1);
      else failRun(db, id, at, error);
    };
    run(JOBS.bars);
    const read = () => readSignals(db, "US:NVDA", clock.now())!.stale;
    expect(read()).toEqual({ final: [], live: [] });

    run(JOBS.quotes, new Error("down"));
    expect(read()).toEqual({ final: [], live: [STALE.quotesFailed] });

    run(JOBS.bars, new Error("down"));
    expect(read()).toEqual({
      final: [STALE.barsFailed],
      live: [STALE.barsFailed, STALE.quotesFailed],
    });

    run(JOBS.bars);
    run(JOBS.quotes);
    // a bar turned final with no recompute yet
    db.query(
      "update bars set final = 1 where instrument = 'US:NVDA' and date = '2026-10-23'",
    ).run();
    expect(read().final).toEqual([STALE.signalsPending]);
    expect(read().live).toContain(STALE.signalsPending);
    expect(readSignals(db, "US:NOPE", clock.now())).toBeNull();
  });
});

describe("relative return", () => {
  const listing = (
    market: string,
    symbol: string,
    zone: string,
    unit: Unit,
    currency: string | null,
  ) => ({
    market,
    symbol,
    source: "yahoo",
    sourceSymbol: symbol,
    exchange: market,
    name: null,
    type: "EQUITY",
    currency,
    unit,
    zone,
  });

  // weekdays from 2026-06-01 to 2026-10-23, skipping some, with closes
  // from step
  function bars(skip: string[], step: (k: number) => number) {
    const out = [];
    let k = 0;
    for (let d = "2026-06-01"; d <= "2026-10-23"; d = addDays(d, 1)) {
      const day = new Date(wallOfDate(d)).getUTCDay();
      if (day === 0 || day === 6 || skip.includes(d)) continue;
      out.push({
        date: d,
        open: null,
        high: null,
        low: null,
        close: step(k++),
        volume: null,
        final: true,
      });
    }
    return out;
  }

  function seeded() {
    const clock = fakeClock(utc("2026-10-26T15:00"));
    const { db } = open(":memory:", clock);
    const now = clock.now();
    const a = upsertInstrument(
      db,
      listing("US", "AAA", "America/New_York", "per_share", "USD"),
      now,
    );
    const b = upsertInstrument(
      db,
      listing("XETRA", "BBB", "Europe/Berlin", "per_share", "EUR"),
      now,
    );
    // the benchmark closed on a day the instrument traded, and the
    // other way round
    const aBars = bars(["2026-09-25"], (k) => 100 + k);
    const bBars = bars(["2026-07-27", "2026-09-28"], (k) => 50 + k / 2);
    upsertBars(db, a.id, "1d", aBars, now);
    upsertBars(db, b.id, "1d", bBars, now);
    const monday = (zone: string, open: number, close: number) =>
      session(
        zone,
        fromWallTime(zone, wallOfDate("2026-10-26") + open),
        fromWallTime(zone, wallOfDate("2026-10-26") + close),
      );
    recordSession(
      db,
      "US",
      monday("America/New_York", 9.5 * 3.6e6, 16 * 3.6e6),
      now,
    );
    recordSession(
      db,
      "XETRA",
      monday("Europe/Berlin", 9 * 3.6e6, 17.5 * 3.6e6),
      now,
    );
    const quote = db.query(
      `insert into quotes (instrument, price, time, source, fetched_at)
       values (?, ?, ?, 'yahoo', ?)`,
    );
    return { db, now, a, b, aBars, bBars, quote };
  }

  test("aligns on the benchmark's days and ends on live prices when both have one", () => {
    const { db, now, aBars, bBars, quote } = seeded();
    const plain = relativeReturn(
      { bars: closes(aBars), currency: "USD" },
      { bars: closes(bBars), currency: "EUR" },
      1,
    );
    // only the instrument quoted: final closes on both sides
    quote.run("US:AAA", 300, now - MINUTE_MS, now);
    expect(readRelativeReturn(db, "US:AAA", "XETRA:BBB", 1)).toEqual({
      ...plain!,
      live: false,
    });
    expect(plain!.benchmark.from).toBe("2026-09-23");

    quote.run("XETRA:BBB", 80, now - MINUTE_MS, now);
    const live = relativeReturn(
      {
        bars: closes(aBars),
        currency: "USD",
        live: { date: "2026-10-26", price: 300 },
      },
      {
        bars: closes(bBars),
        currency: "EUR",
        live: { date: "2026-10-26", price: 80 },
      },
      3,
    );
    expect(readRelativeReturn(db, "US:AAA", "XETRA:BBB", 3)).toEqual({
      ...live!,
      live: true,
    });
    expect(live!.instrument.to).toBe("2026-10-26");
    expect(readRelativeReturn(db, "US:AAA", "US:NOPE", 1)).toBeNull();
  });

  test("a percent series is a change in level, and none against a price", () => {
    const { db, now, aBars } = seeded();
    for (const symbol of ["Y10", "Y2"]) {
      const y = upsertInstrument(
        db,
        listing("FRED", symbol, "America/New_York", "percent", null),
        now,
      );
      upsertBars(
        db,
        y.id,
        "1d",
        bars([], (k) => (symbol === "Y10" ? 4 : 3) + k / 100),
        now,
      );
    }
    const r = readRelativeReturn(db, "FRED:Y10", "FRED:Y2", 1)!;
    expect(r.note).toBe(LEVEL_NOTE);
    expect(r.instrument.unit).toBe("points");
    expect(r.instrument.currency).toBe("unknown");
    expect(readRelativeReturn(db, "US:AAA", "FRED:Y10", 1)).toBeNull();
    expect(aBars.length).toBeGreaterThan(0);
  });
});

describe("the table", () => {
  test("holds one live row per instrument and interval, weekly rows only averages", async () => {
    const { db } = await stored();
    const insert = (
      interval: string,
      date: string,
      kind: string,
      ema = null as number | null,
    ) =>
      db
        .query(
          `insert into signals (instrument, interval, date, kind, ema20,
             quote_time, computed_at)
           values ('US:NVDA', ?, ?, ?, ?, ?, 0)`,
        )
        .run(interval, date, kind, ema, kind === "live" ? 1 : null);
    insert("1d", "2026-10-26", "live");
    expect(() => insert("1d", "2026-10-27", "live")).toThrow("UNIQUE");
    expect(() => insert("1wk", "2026-10-26", "final", 1)).toThrow("CHECK");
    expect(() => insert("1d", "2026-10-28", "final", null)).not.toThrow();
  });
});
