// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { readBars } from "../src/bars.ts";
import { readSessions } from "../src/calendars.ts";
import { DAY_MS } from "../src/clock.ts";
import { open } from "../src/db/index.ts";
import { readInstrument, upsertInstrument } from "../src/instruments.ts";
import {
  type ChartAnswer,
  parseChart,
  parseSpark,
  yahoo,
} from "../src/yahoo/client.ts";
import { marketOf, symbolOf } from "../src/yahoo/resolve.ts";
import {
  addInstrument,
  backfillStart,
  dailyBars,
  readQuote,
  refetch,
  storeQuotes,
} from "../src/yahoo/sync.ts";
import { startOfDate } from "../src/zone.ts";
import { fakeClock } from "./helpers/clock.ts";
import { clone, fakeFetch, type Recorded, recorded } from "./helpers/yahoo.ts";

async function answer(
  name: string,
  edit: (result: any) => void = () => {},
): Promise<ChartAnswer> {
  const fx = clone(await recorded(name));
  edit(fx.body.chart.result[0]);
  return parseChart(fx.body, Date.parse(fx.recordedAt));
}

function appendRow(result: any, at: number, values: number[]) {
  result.timestamp.push(at);
  const q = result.indicators.quote[0];
  const [open, high, low, close, volume] = values;
  q.open.push(open);
  q.high.push(high);
  q.low.push(low);
  q.close.push(close);
  q.volume.push(volume);
}

const dates = (bars: { date: string }[]) => bars.map((b) => b.date);

// a database and a client whose chart answers come from route
function setup(start: number, route: (url: URL) => Recorded | undefined) {
  const clock = fakeClock(start);
  const { db } = open(":memory:", clock);
  const f = fakeFetch(route);
  const ctx = { db, clock, yahoo: yahoo({ clock, fetch: f.fetch }) };
  return { ...ctx, ctx, f };
}

describe("daily bars from a chart answer", () => {
  test("a live day's last bar is not final, the days before are", async () => {
    const a = await answer("chart-nvda-5d-1d");
    const bars = dailyBars(a, a.session);
    expect(dates(bars)).toEqual([
      "2026-10-19",
      "2026-10-20",
      "2026-10-21",
      "2026-10-22",
      "2026-10-23",
    ]);
    expect(bars.map((b) => b.final)).toEqual([true, true, true, true, false]);
    expect(bars[4]!.close).toBe(210.9600067138672);
  });

  test("a trailing row outside its session's date makes no bar", async () => {
    // EURUSD=X traded Sunday 19:20 UTC while its session was Friday's
    const a = await answer("chart-eurusd-x-5d-1d");
    expect(a.rows).toHaveLength(6);
    const bars = dailyBars(a, a.session);
    expect(dates(bars)).toEqual([
      "2026-10-19",
      "2026-10-20",
      "2026-10-21",
      "2026-10-22",
      "2026-10-23",
    ]);
    expect(bars[4]!.final).toBe(false);
  });

  test("a closing auction after the end merges into its session's bar", async () => {
    // VVSM.DE's 15:35:57 print against a 15:30 end
    const a = await answer("chart-vvsm-de-5d-1d", (r) =>
      appendRow(r, r.meta.regularMarketTime, [86.97, 87.9, 85.5, 87.5, 9e5]),
    );
    const bars = dailyBars(a, a.session);
    expect(bars).toHaveLength(5);
    expect(bars[4]).toMatchObject({
      date: "2026-10-23",
      close: 87.5,
      high: 87.9,
      volume: 9e5,
      final: false,
    });
    expect(bars[4]!.low).toBeLessThan(86);
  });

  test("a trailing row from an earlier date than the session makes no bar", async () => {
    // CL=F showed Sunday's session while its last trade was Friday's
    const a = await answer("chart-cl-f-5d-1d", (r) =>
      appendRow(r, r.meta.regularMarketTime, [1, 999, 1, 999, 1]),
    );
    const bars = dailyBars(a, a.session);
    expect(dates(bars)).toEqual([
      "2026-10-20",
      "2026-10-21",
      "2026-10-22",
      "2026-10-23",
    ]);
    expect(bars[3]).toMatchObject({ close: 103.2699966430664, final: true });
  });

  test("a null close is skipped, never stored as 0", async () => {
    const a = await answer("chart-nvda-5d-1d", (r) => {
      r.indicators.quote[0].close[2] = null;
    });
    const bars = dailyBars(a, a.session);
    expect(dates(bars)).not.toContain("2026-10-21");
    expect(bars).toHaveLength(4);
  });

  test("a bar's date follows the exchange's zone across a clock change", async () => {
    const a = await answer("chart-nvda-5y-1d");
    const bars = dailyBars(a, a.session);
    expect(bars).toHaveLength(a.rows.length);
    expect(new Set(dates(bars)).size).toBe(bars.length);
    for (const b of bars) {
      const day = new Date(`${b.date}T12:00:00Z`).getUTCDay();
      expect(day === 0 || day === 6).toBe(false);
    }
    // New York left summer time on 2025-11-02 and began it on 2026-03-08
    expect(dates(bars)).toEqual(
      expect.arrayContaining([
        "2025-10-31",
        "2025-11-03",
        "2026-03-06",
        "2026-03-09",
      ]),
    );

    // London's Monday after the spring change is stamped Sunday 23:00 UTC
    const fx = await answer("chart-eurusd-x-5d-1d", (r) => {
      r.timestamp = [
        Date.parse("2026-03-27T00:00:00Z") / 1000,
        Date.parse("2026-03-29T23:00:00Z") / 1000,
      ];
      const q = r.indicators.quote[0];
      for (const k of ["open", "high", "low", "close", "volume"]) {
        q[k] = q[k].slice(0, 2);
      }
      r.meta.regularMarketTime = Date.parse("2026-03-30T12:00:00Z") / 1000;
      r.meta.currentTradingPeriod.regular = {
        start: Date.parse("2026-03-29T23:00:00Z") / 1000,
        end: Date.parse("2026-03-30T22:59:00Z") / 1000,
      };
    });
    const spring = dailyBars(fx, fx.session);
    expect(dates(spring)).toEqual(["2026-03-27", "2026-03-30"]);
    expect(spring.map((b) => b.final)).toEqual([true, false]);
  });
});

describe("backfill", () => {
  test("adds an instrument with ten years from a Monday, its weeks and splits", async () => {
    const fx = await recorded("chart-nvda-5y-1d");
    const now = Date.parse(fx.recordedAt);
    const { db, ctx, f } = setup(now, () => fx);
    const { instrument, rows } = await addInstrument(ctx, "NVDA", "US:NVDA");
    expect(instrument).toMatchObject({
      id: "US:NVDA",
      market: "US",
      symbol: "NVDA",
      source: "yahoo",
      sourceSymbol: "NVDA",
      exchange: "NMS",
      name: "NVIDIA Corporation",
      type: "EQUITY",
      currency: "USD",
      zone: "America/New_York",
    });
    expect(f.urls).toHaveLength(1);
    // 2016-10-25 is a Tuesday; a day early covers any zone
    expect(backfillStart(now).monday).toBe("2016-10-24");
    expect(f.urls[0]!.searchParams.get("period1")).toBe(
      String(Date.parse("2016-10-23T00:00:00Z") / 1000),
    );
    expect(rows).toBe(1255);
    const days = readBars(db, "US:NVDA", "1d");
    expect(days.at(-1)).toMatchObject({ date: "2026-10-23", final: false });
    expect(days.at(-2)).toMatchObject({ date: "2026-10-22", final: true });
    const weeks = readBars(db, "US:NVDA", "1wk");
    expect(weeks.at(-1)).toMatchObject({
      date: "2026-10-19",
      close: 210.9600067138672,
      final: false,
    });
    expect(weeks.at(-2)).toMatchObject({ date: "2026-10-12", final: true });
    // a split inside the backfill is applied by it, with no refetch
    expect(db.query("select date, ratio from splits").all()).toEqual([
      { date: "2024-06-10", ratio: "10:1" },
    ]);
    expect(readSessions(db).map((s) => s.market)).toEqual(["US"]);
  });

  test("an answer for another listing than the one resolved is refused", async () => {
    const fx = await recorded("chart-nvda-5d-1d");
    const { db, ctx } = setup(Date.parse(fx.recordedAt), () => fx);
    await expect(addInstrument(ctx, "NVDA.TO", "TOR:NVDA")).rejects.toThrow(
      "TOR:NVDA answered as US:NVDA",
    );
    expect(readInstrument(db, "US:NVDA")).toBeNull();
  });

  test("bars need a stored instrument", () => {
    const { db } = open(":memory:", fakeClock());
    expect(() =>
      db
        .query(
          `insert into bars (instrument, interval, date, close, final, fetched_at)
           values ('US:NOPE', '1d', '2026-10-23', 1, 0, 0)`,
        )
        .run(),
    ).toThrow("FOREIGN KEY");
  });
});

describe("refetch", () => {
  test("the last 30 days, which makes earlier bars final and takes corrections", async () => {
    const fx = await recorded("chart-nvda-5d-1d");
    const monday = clone(fx);
    const result = monday.body.chart.result[0];
    const day = 24 * 60 * 60;
    result.meta.currentTradingPeriod.regular.start += 3 * day;
    result.meta.currentTradingPeriod.regular.end += 3 * day;
    result.indicators.quote[0].close[3] = 212.5;
    let route = fx;
    const { db, ctx, clock, f } = setup(Date.parse(fx.recordedAt), () => route);
    const { instrument } = await addInstrument(ctx, "NVDA");
    expect(readBars(db, "US:NVDA", "1d").at(-1)!.final).toBe(false);

    route = monday;
    await clock.advance(Date.parse("2026-10-26T14:00:00Z") - clock.now());
    await refetch(ctx, instrument);
    expect(f.urls).toHaveLength(2);
    expect(f.urls[1]!.searchParams.get("period1")).toBe(
      String(Math.floor((clock.now() - 30 * DAY_MS) / 1000)),
    );
    const days = readBars(db, "US:NVDA", "1d");
    expect(days.every((d) => d.final)).toBe(true);
    expect(days[3]).toMatchObject({ date: "2026-10-22", close: 212.5 });
    expect(readBars(db, "US:NVDA", "1wk")).toEqual([
      expect.objectContaining({ date: "2026-10-19", final: true }),
    ]);
  });

  test("a split refetches the whole history once, and not again", async () => {
    const bonus = await recorded("chart-tlv-ro-bonus-2026");
    const before = clone(bonus);
    delete before.body.chart.result[0].events;
    let route = before;
    const now = Date.parse(bonus.recordedAt);
    const { db, ctx, f } = setup(now, () => route);
    const { instrument } = await addInstrument(ctx, "TLV.RO", "BVB:TLV");
    expect(db.query("select * from splits").all()).toEqual([]);

    route = bonus;
    await refetch(ctx, instrument);
    // after a gap longer than 30 days, from the last final bar
    expect(f.urls).toHaveLength(3);
    expect(f.urls[1]!.searchParams.get("period1")).toBe(
      String(startOfDate("Europe/Bucharest", "2026-07-31") / 1000),
    );
    expect(f.urls[2]!.searchParams.get("period1")).toBe(
      String(backfillStart(now).from / 1000),
    );
    expect(
      db.query("select date, numerator, denominator, ratio from splits").all(),
    ).toEqual([
      {
        date: "2026-07-16",
        numerator: 114.42,
        denominator: 100,
        ratio: "114.42:100",
      },
    ]);

    await refetch(ctx, instrument);
    expect(f.urls).toHaveLength(4);
  });
});

describe("quotes from a spark answer", () => {
  async function withInstruments() {
    const fx = await recorded("spark-v7-batch");
    const clock = fakeClock(Date.parse(fx.recordedAt));
    const { db } = open(":memory:", clock);
    for (const q of fx.body.spark.result) {
      const meta = q.response[0].meta;
      upsertInstrument(
        db,
        {
          market: marketOf(meta.exchangeName),
          symbol: symbolOf(meta.symbol),
          source: "yahoo",
          sourceSymbol: meta.symbol,
          exchange: meta.exchangeName,
          name: null,
          type: meta.instrumentType,
          currency: meta.currency,
          zone: meta.exchangeTimezoneName,
        },
        clock.now(),
      );
    }
    return { db, clock, fx };
  }

  test("each quote's price, trade time, previous close, worked-out change and session", async () => {
    const { db, clock, fx } = await withInstruments();
    const written = storeQuotes(db, parseSpark(fx.body, clock.now()));
    expect(written).toHaveLength(5);
    const sol = readQuote(db, "CRYPTO:SOL-USD")!;
    expect(sol).toMatchObject({
      price: 101.52,
      time: 1792962233_000,
      previousClose: 102.269684,
      previousCloseField: "previousClose",
      dayHigh: 102.57087,
      dayLow: 100.37113,
      volume: 1255574400,
      source: "yahoo",
      fetchedAt: clock.now(),
    });
    // Yahoo's own change field says +0.27%
    expect(sol.change).toBeCloseTo(-0.749684, 9);
    expect(sol.changePercent).toBeCloseTo(-0.73304, 4);
    expect(readQuote(db, "XETRA:VVSM")!.time).toBe(
      Date.parse("2026-10-23T15:35:57Z"),
    );
    expect(readQuote(db, "CCY:EURUSD=X")!.volume).toBe(0);
    expect(readSessions(db).map((s) => s.market)).toEqual([
      "BVB",
      "CCY",
      "CRYPTO",
      "US",
      "XETRA",
    ]);
    expect(readQuote(db, "BVB:TLV")!.price).toBe(36.18);
  });

  test("falls back to the chart's previous close and says so", async () => {
    const { db, clock, fx } = await withInstruments();
    const body = clone(fx.body);
    delete body.spark.result[0].response[0].meta.previousClose;
    storeQuotes(db, parseSpark(body, clock.now()));
    expect(readQuote(db, "CRYPTO:SOL-USD")).toMatchObject({
      previousClose: 102.269684,
      previousCloseField: "chartPreviousClose",
    });
  });

  test("a day high or low of 0 is none", async () => {
    const { db, clock, fx } = await withInstruments();
    const body = clone(fx.body);
    const meta = body.spark.result[2].response[0].meta;
    meta.regularMarketDayHigh = 0;
    meta.regularMarketDayLow = 0;
    storeQuotes(db, parseSpark(body, clock.now()));
    expect(readQuote(db, "US:NVDA")).toMatchObject({
      dayHigh: null,
      dayLow: null,
      volume: 80189765,
    });
  });

  test("an older quote never replaces a newer one", async () => {
    const { db, clock, fx } = await withInstruments();
    storeQuotes(db, parseSpark(fx.body, clock.now()));
    const body = clone(fx.body);
    const meta = body.spark.result[0].response[0].meta;
    meta.regularMarketTime -= 60;
    meta.regularMarketPrice = 1;
    expect(storeQuotes(db, parseSpark(body, clock.now()))).toHaveLength(4);
    expect(readQuote(db, "CRYPTO:SOL-USD")!.price).toBe(101.52);
  });

  test("an instrument not stored gets no quote, its market's session still counts", async () => {
    const fx = await recorded("spark-v7-batch");
    const clock = fakeClock(Date.parse(fx.recordedAt));
    const { db } = open(":memory:", clock);
    expect(storeQuotes(db, parseSpark(fx.body, clock.now()))).toEqual([]);
    expect(readSessions(db)).toHaveLength(5);
  });
});
