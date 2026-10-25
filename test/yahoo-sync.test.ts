// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { readBars } from "../src/bars.ts";
import { readSessions } from "../src/calendars.ts";
import { DAY_MS } from "../src/clock.ts";
import { type Db, open } from "../src/db/index.ts";
import { readInstrument, upsertInstrument } from "../src/instruments.ts";
import { writer } from "../src/writer.ts";
import {
  type ChartAnswer,
  parseChart,
  parseSpark,
  yahoo,
} from "../src/yahoo/client.ts";
import { marketOf, symbolOf } from "../src/yahoo/resolve.ts";
import {
  addInstrument,
  backfill,
  backfillStart,
  dailyBars,
  readQuote,
  refetch,
  storeQuotes,
  unitOf,
} from "../src/yahoo/sync.ts";
import { startOfDate } from "../src/zone.ts";
import { fakeClock } from "./helpers/clock.ts";
import {
  backTo,
  clone,
  fakeFetch,
  listed,
  type Recorded,
  recorded,
} from "./helpers/yahoo.ts";

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

// 2026-10-16, inside the 30-day window
const OCT16 = 1792157400;

// a database and a client whose chart answers come from route
function setup(
  start: number,
  route: (url: URL) => Recorded | Promise<Recorded> | undefined,
) {
  const clock = fakeClock(start);
  const { db } = open(":memory:", clock);
  const f = fakeFetch(route);
  const ctx = {
    db,
    clock,
    yahoo: yahoo({ clock, fetch: f.fetch }),
    writer: writer(db),
  };
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

  test("a trailing row never makes a bar of its own", async () => {
    // a Sunday evening trade in CL=F's Sunday session, which has no
    // regular row yet
    const cl = await answer("chart-cl-f-5d-1d", (r) => {
      const at = Date.parse("2026-10-25T22:30:00Z") / 1000;
      r.meta.regularMarketTime = at;
      appendRow(r, at, [103, 104, 102, 103.5, 10]);
    });
    expect(dates(dailyBars(cl, cl.session))).not.toContain("2026-10-25");
    // off the bar grid, though not stamped at the last trade's time
    const fx = await answer("chart-eurusd-x-5d-1d", (r) => {
      r.meta.regularMarketTime += 1;
    });
    expect(dates(dailyBars(fx, fx.session))).not.toContain("2026-10-25");
    expect(dailyBars(fx, fx.session)).toHaveLength(5);
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
    const fx = backTo(await recorded("chart-nvda-5y-1d"), "2016-10-21");
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
    // the Friday before the Monday is dropped
    expect(rows).toBe(fx.body.chart.result[0].timestamp.length - 1);
    const days = readBars(db, "US:NVDA", "1d");
    expect(days[0]!.date).toBe("2016-10-24");
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

describe("units", () => {
  test("from Yahoo's instrument type, never a guess for an index or a future", async () => {
    const names: Record<string, string> = {
      NVDA: "chart-nvda-5d-1d",
      "VVSM.DE": "chart-vvsm-de-5d-1d",
      "SOL-USD": "chart-sol-usd-5d-1d",
      "EURUSD=X": "chart-eurusd-x-5d-1d",
      "^TNX": "chart-tnx-5d-1d",
      "^VIX": "chart-vix-5d-1d",
      "CL=F": "chart-cl-f-5d-1d",
    };
    const fixtures = new Map<string, Recorded>();
    for (const [symbol, name] of Object.entries(names)) {
      fixtures.set(symbol, listed(await recorded(name)));
    }
    const { ctx } = setup(Date.parse("2026-10-25T19:40:00Z"), (url) =>
      fixtures.get(decodeURIComponent(url.pathname.split("/").at(-1)!)),
    );
    const units: Record<string, string> = {};
    for (const symbol of Object.keys(names)) {
      const { instrument } = await addInstrument(ctx, symbol);
      units[symbol] = instrument.unit;
    }
    expect(units).toEqual({
      NVDA: "per_share",
      "VVSM.DE": "per_share",
      "SOL-USD": "per_unit",
      "EURUSD=X": "per_unit",
      "^TNX": "unknown",
      "^VIX": "unknown",
      "CL=F": "unknown",
    });
    expect(unitOf("MUTUALFUND")).toBe("per_share");
    expect(unitOf("FUTURE")).toBe("unknown");
  });
});

describe("refetch", () => {
  test("the last 30 days, which makes earlier bars final and takes corrections", async () => {
    const fx = listed(await recorded("chart-nvda-5d-1d"));
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
    const before = listed(bonus);
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

describe("refetch changes", () => {
  // NVDA's ten years, then a refetch answering route
  async function stored() {
    const history = listed(await recorded("chart-nvda-5y-1d"));
    let route: Recorded = history;
    const t = setup(Date.parse(history.recordedAt), () => route);
    const { instrument } = await addInstrument(t.ctx, "NVDA");
    return {
      ...t,
      instrument,
      answer: (r: Recorded) => {
        route = r;
      },
    };
  }

  function without(fx: Recorded, index: number): Recorded {
    const out = clone(fx);
    const result = out.body.chart.result[0];
    result.timestamp.splice(index, 1);
    for (const k of ["open", "high", "low", "close", "volume"]) {
      result.indicators.quote[0][k].splice(index, 1);
    }
    return out;
  }

  test("reports the earliest date whose values changed, and none when nothing did", async () => {
    const { ctx, instrument, answer } = await stored();
    const fx = await recorded("chart-nvda-5d-1d");
    answer(fx);
    expect(await refetch(ctx, instrument)).toEqual({
      rows: 5,
      changedFrom: null,
    });
    const corrected = clone(fx);
    corrected.body.chart.result[0].indicators.quote[0].close[3] = 212.5;
    answer(corrected);
    expect((await refetch(ctx, instrument)).changedFrom).toBe("2026-10-22");
  });

  test("drops a stored day the source no longer has, only inside the answer's span", async () => {
    const { db, ctx, instrument, answer } = await stored();
    const fx = await recorded("chart-nvda-5d-1d");
    answer(without(fx, 2));
    expect((await refetch(ctx, instrument)).changedFrom).toBe("2026-10-21");
    const days = dates(readBars(db, "US:NVDA", "1d"));
    expect(days).not.toContain("2026-10-21");
    expect(days).toContain("2026-10-16");
    expect(days).toHaveLength(1254);
    const week = readBars(db, "US:NVDA", "1wk").at(-1)!;
    expect(week.date).toBe("2026-10-19");

    // an answer without rows deletes nothing
    const empty = clone(fx);
    const result = empty.body.chart.result[0];
    delete result.timestamp;
    result.indicators.quote = [{}];
    answer(empty);
    expect((await refetch(ctx, instrument)).changedFrom).toBeNull();
    expect(readBars(db, "US:NVDA", "1d")).toHaveLength(1254);
  });

  test("drops a stored day whose close the source no longer gives", async () => {
    const { db, ctx, instrument, answer } = await stored();
    const fx = clone(await recorded("chart-nvda-5d-1d"));
    fx.body.chart.result[0].indicators.quote[0].close[2] = null;
    answer(fx);
    expect((await refetch(ctx, instrument)).changedFrom).toBe("2026-10-21");
    const days = readBars(db, "US:NVDA", "1d");
    expect(dates(days)).not.toContain("2026-10-21");
    const week = readBars(db, "US:NVDA", "1wk").at(-1)!;
    expect(week.volume).toBe(
      days
        .filter((d) => d.date >= "2026-10-19")
        .reduce((sum, d) => sum + d.volume!, 0),
    );
  });

  test("a history cut short is refused and its split left for the next run", async () => {
    const { db, ctx, f, instrument, answer } = await stored();
    const short = clone(await recorded("chart-nvda-5d-1d"));
    short.body.chart.result[0].events = {
      splits: {
        "1792157400": {
          date: 1792157400,
          numerator: 2,
          denominator: 1,
          splitRatio: "2:1",
        },
      },
    };
    answer(short);
    // the window and then the whole history both answer five days
    await expect(refetch(ctx, instrument)).rejects.toThrow(
      "a history cut short",
    );
    expect(f.urls).toHaveLength(3);
    expect(readBars(db, "US:NVDA", "1d")).toHaveLength(1255);
    expect(db.query("select date from splits").all()).toEqual([
      { date: "2024-06-10" },
    ]);
    await expect(refetch(ctx, instrument)).rejects.toThrow();
    expect(f.urls).toHaveLength(5);
  });
});

describe("a history that stops early", () => {
  test("is refused, keeping the stored days after it and leaving its split", async () => {
    const history = listed(await recorded("chart-nvda-5y-1d"));
    const window = clone(await recorded("chart-nvda-5d-1d"));
    window.body.chart.result[0].events = {
      splits: {
        "1792157400": {
          date: 1792157400,
          numerator: 2,
          denominator: 1,
          splitRatio: "2:1",
        },
      },
    };
    const early = clone(history);
    const result = early.body.chart.result[0];
    result.timestamp.splice(-60);
    for (const k of ["open", "high", "low", "close", "volume"]) {
      result.indicators.quote[0][k].splice(-60);
    }
    const answers = [history, window, early];
    let n = 0;
    const { db, ctx } = setup(
      Date.parse(history.recordedAt),
      () => answers[n++],
    );
    const { instrument } = await addInstrument(ctx, "NVDA");
    await expect(refetch(ctx, instrument)).rejects.toThrow(
      "a history cut short",
    );
    expect(n).toBe(3);
    const days = readBars(db, "US:NVDA", "1d");
    expect(days).toHaveLength(1255);
    expect(days.at(-1)!.date).toBe("2026-10-23");
    expect(db.query("select date from splits").all()).toEqual([
      { date: "2024-06-10" },
    ]);
  });
});

describe("a split's whole history", () => {
  async function stored(answers: Recorded[]) {
    const history = listed(await recorded("chart-nvda-5y-1d"));
    const queue = [history, ...answers];
    const t = setup(Date.parse(history.recordedAt), () => queue.shift());
    const { instrument } = await addInstrument(t.ctx, "NVDA");
    return { ...t, history, instrument };
  }

  const closeOn = (db: Db, date: string) =>
    readBars(db, "US:NVDA", "1d").find((b) => b.date === date)!.close;

  // the recorded close of 2026-10-22, the day before the last
  const octoberClose = (fx: Recorded): number =>
    fx.body.chart.result[0].indicators.quote[0].close.at(-2);

  test("is refused when it stops a day short of the stored bars", async () => {
    const history = listed(await recorded("chart-nvda-5y-1d"));
    const window = withSplit(await recorded("chart-nvda-5d-1d"), OCT16, 2, 1);
    const whole = withSplit(scaled(history, 2), OCT16, 2, 1);
    const result = whole.body.chart.result[0];
    result.timestamp.pop();
    for (const k of ["open", "high", "low", "close", "volume"]) {
      result.indicators.quote[0][k].pop();
    }
    const { db, ctx, instrument } = await stored([window, whole]);
    const before = closeOn(db, "2026-10-22");
    await expect(refetch(ctx, instrument)).rejects.toThrow(
      "a history cut short",
    );
    expect(closeOn(db, "2026-10-22")).toBe(before);
    expect(db.query("select date from splits").all()).toEqual([
      { date: "2024-06-10" },
    ]);
  });

  test("is refused when it starts a day after the stored bars", async () => {
    const history = listed(await recorded("chart-nvda-5y-1d"));
    const window = withSplit(await recorded("chart-nvda-5d-1d"), OCT16, 2, 1);
    const whole = withSplit(scaled(history, 2), OCT16, 2, 1);
    const result = whole.body.chart.result[0];
    result.timestamp.shift();
    for (const k of ["open", "high", "low", "close", "volume"]) {
      result.indicators.quote[0][k].shift();
    }
    const { db, ctx, instrument } = await stored([window, whole]);
    const first = readBars(db, "US:NVDA", "1d")[0]!;
    expect(first.date).toBe("2021-10-25");
    await expect(refetch(ctx, instrument)).rejects.toThrow(
      "a history cut short",
    );
    expect(readBars(db, "US:NVDA", "1d")[0]).toEqual(first);
    expect(db.query("select date from splits").all()).toEqual([
      { date: "2024-06-10" },
    ]);
  });

  test("the whole history's ratio wins over the window's", async () => {
    const history = listed(await recorded("chart-nvda-5y-1d"));
    const window = await recorded("chart-nvda-5d-1d");
    const halved = withSplit(scaled(history, 2), OCT16, 2, 1);
    const { db, ctx, instrument } = await stored([
      withSplit(window, OCT16, 2, 1),
      halved,
      withSplit(window, OCT16, 3, 1),
      halved,
    ]);
    await refetch(ctx, instrument);
    await refetch(ctx, instrument);
    expect(
      db
        .query("select numerator, ratio from splits where date = '2026-10-16'")
        .all(),
    ).toEqual([{ numerator: 2, ratio: "2:1" }]);
    expect(closeOn(db, "2026-10-22")).toBeCloseTo(octoberClose(history) / 2, 9);
  });

  test("a corrected ratio refetches the history and replaces the record", async () => {
    const history = listed(await recorded("chart-nvda-5y-1d"));
    const window = await recorded("chart-nvda-5d-1d");
    const { db, ctx, f, instrument } = await stored([
      withSplit(window, OCT16, 2, 1),
      withSplit(scaled(history, 2), OCT16, 2, 1),
      withSplit(window, OCT16, 2, 1),
      withSplit(window, OCT16, 3, 1),
      withSplit(scaled(history, 3), OCT16, 3, 1),
    ]);
    await refetch(ctx, instrument);
    await refetch(ctx, instrument);
    expect(f.urls).toHaveLength(4);
    await refetch(ctx, instrument);
    expect(f.urls).toHaveLength(6);
    expect(
      db
        .query("select numerator, ratio from splits where date = '2026-10-16'")
        .all(),
    ).toEqual([{ numerator: 3, ratio: "3:1" }]);
    expect(closeOn(db, "2026-10-22")).toBeCloseTo(octoberClose(history) / 3, 9);
  });

  test("an older answer in flight never lands after the split's rewrite", async () => {
    const history = listed(await recorded("chart-nvda-5y-1d"));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    // the add, the backfill's old-scale history held past the split, then
    // the refetch's window and whole history
    const answers: Recorded[] = [
      history,
      history,
      withSplit(await recorded("chart-nvda-5d-1d"), OCT16, 2, 1),
      withSplit(scaled(history, 2), OCT16, 2, 1),
    ];
    let n = 0;
    const { db, ctx, f } = setup(Date.parse(history.recordedAt), async () => {
      const k = n++;
      if (k === 1) await gate;
      return answers[k]!;
    });
    const { instrument } = await addInstrument(ctx, "NVDA");
    const older = backfill(ctx, instrument);
    const newer = refetch(ctx, instrument);
    await new Promise((resolve) => setImmediate(resolve));
    // the refetch waits for the backfill's whole call and write
    expect(f.urls).toHaveLength(2);
    release();
    await older;
    await newer;
    expect(f.urls).toHaveLength(4);
    expect(closeOn(db, "2026-10-22")).toBeCloseTo(octoberClose(history) / 2, 9);
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
          unit: unitOf(meta.instrumentType),
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
    expect(storeQuotes(db, parseSpark(body, clock.now() + 1))).toHaveLength(4);
    expect(readQuote(db, "CRYPTO:SOL-USD")!.price).toBe(101.52);
  });

  test("a quote as old as the stored one replaces it only when fetched later", async () => {
    const { db, clock, fx } = await withInstruments();
    storeQuotes(db, parseSpark(fx.body, clock.now()));
    const body = clone(fx.body);
    body.spark.result[0].response[0].meta.previousClose = 100;
    expect(storeQuotes(db, parseSpark(body, clock.now() - 1000))).toEqual([]);
    expect(readQuote(db, "CRYPTO:SOL-USD")).toMatchObject({
      previousClose: 102.269684,
      fetchedAt: clock.now(),
    });
    expect(storeQuotes(db, parseSpark(body, clock.now() + 1000))).toHaveLength(
      5,
    );
    expect(readQuote(db, "CRYPTO:SOL-USD")).toMatchObject({
      previousClose: 100,
      fetchedAt: clock.now() + 1000,
    });
  });

  test("a bad entry skips only itself, with a fixed phrase", async () => {
    const { db, clock, fx } = await withInstruments();
    const body = clone(fx.body);
    delete body.spark.result[2].response[0].meta.regularMarketPrice;
    body.spark.result[4].response = null;
    const parsed = parseSpark(body, clock.now());
    expect(parsed.skipped).toEqual([
      { symbol: "NVDA", phrase: "malformed answer" },
      { symbol: "EURUSD=X", phrase: "not found" },
    ]);
    expect(storeQuotes(db, parsed)).toHaveLength(3);
    expect(readQuote(db, "US:NVDA")).toBeNull();
  });

  test("an instrument not stored gets no quote, its market's session still counts", async () => {
    const fx = await recorded("spark-v7-batch");
    const clock = fakeClock(Date.parse(fx.recordedAt));
    const { db } = open(":memory:", clock);
    expect(storeQuotes(db, parseSpark(fx.body, clock.now()))).toEqual([]);
    expect(readSessions(db)).toHaveLength(5);
  });
});
