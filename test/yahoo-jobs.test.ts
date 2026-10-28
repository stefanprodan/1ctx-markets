// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { start } from "../src/app.ts";
import { readBars } from "../src/market/bars.ts";
import { readSession } from "../src/market/calendars.ts";
import { readInstrument, upsertInstrument } from "../src/market/instruments.ts";
import { readIntraday, storeIntraday } from "../src/market/intraday.ts";
import { readQuote } from "../src/market/quotes.ts";
import {
  barsStale,
  JOBS,
  OWED_RETRY_MS,
  quoteStale,
} from "../src/market/stale.ts";
import { markRead } from "../src/market/tracking.ts";
import { markets } from "../src/operations/markets.ts";
import { moversAnswer, parseMovers } from "../src/operations/movers.ts";
import { DAY_MS, MINUTE_MS } from "../src/runtime/clock.ts";
import { silent } from "../src/runtime/log.ts";
import { scheduler } from "../src/runtime/scheduler.ts";
import { readSignals } from "../src/signals/read.ts";
import { STOPPED } from "../src/sources/source.ts";
import { parseChart, parseSpark, yahoo } from "../src/sources/yahoo/client.ts";
import { fields } from "../src/sources/yahoo/history.ts";
import {
  FILLS_PER_TURN,
  RETRY_MS,
  type TickReport,
  yahooJobs,
} from "../src/sources/yahoo/jobs.ts";
import { storeQuotes } from "../src/sources/yahoo/quotes.ts";
import { catchUp } from "../src/sources/yahoo/sync.ts";
import { type Db, open } from "../src/storage/db/index.ts";
import { endRun, INTERRUPTED, lastRun, startRun } from "../src/storage/runs.ts";
import { writer } from "../src/storage/writer.ts";
import { fakeClock } from "./helpers/clock.ts";
import { BVB, CRYPTO, type SimListing, sim, US, XETRA } from "./helpers/sim.ts";
import {
  added,
  backTo,
  chartSymbol,
  clone,
  fakeFetch,
  listed,
  type Recorded,
  recorded,
} from "./helpers/yahoo.ts";

const EVERY = 5 * MINUTE_MS;
const utc = (iso: string) => Date.parse(`${iso}Z`);

function setup(
  start: number,
  route: (url: URL, now: number) => Recorded | Promise<Recorded> | undefined,
) {
  const clock = fakeClock(start);
  const { db } = open(":memory:", clock);
  const f = fakeFetch((url) => route(url, clock.now()));
  const ctx = {
    db,
    clock,
    yahoo: yahoo({ clock, fetch: f.fetch }),
    writer: writer(db),
  };
  const jobs = yahooJobs({ ctx, quoteEveryMs: EVERY, log: silent });
  // a tick each minute up to until, as the scheduler runs them
  const runTo = async (until: number): Promise<TickReport[]> => {
    const reports: TickReport[] = [];
    while (clock.now() + MINUTE_MS <= until) {
      await clock.advance(MINUTE_MS);
      reports.push(await jobs.tick());
    }
    return reports;
  };
  return { clock, db, ctx, f, jobs, runTo };
}

const sparks = (urls: URL[]) =>
  urls.filter((u) => u.pathname === "/v7/finance/spark");
const charts = (urls: URL[]) => urls.filter((u) => chartSymbol(u) !== null);
const daily = (urls: URL[]) =>
  charts(urls).filter((u) => u.searchParams.get("interval") === "1d");
const symbolsOf = (u: URL) => u.searchParams.get("symbols")!.split(",");

// a recorded spark entry, answered for whichever symbols are asked
async function sparkFrom(): Promise<{
  metas: Map<string, any>;
  route: (url: URL) => Recorded;
}> {
  const fx = await recorded("spark-v7-batch");
  const metas = new Map<string, any>(
    fx.body.spark.result.map((r: any) => [r.symbol, r.response[0].meta]),
  );
  return {
    metas,
    route: (url) => {
      const out = clone(fx);
      out.body.spark.result = symbolsOf(url).map((symbol) => ({
        symbol,
        response: [{ meta: clone(metas.get(symbol)) }],
      }));
      return out;
    },
  };
}

function moveSession(meta: any, start: string, end: string, now: number) {
  meta.currentTradingPeriod.regular.start = utc(start) / 1000;
  meta.currentTradingPeriod.regular.end = utc(end) / 1000;
  meta.regularMarketTime = Math.floor(now / 1000);
}

describe("quotes", () => {
  test("a restart adds no pass to a period that had one; a first run and a long stop ask at once", async () => {
    const s = sim([CRYPTO("C0-USD")]);
    const t = setup(utc("2026-10-26T18:00"), (url, now) => s.route(url, now));
    await added(t.ctx, "C0-USD");
    const fresh = () =>
      yahooJobs({ ctx: t.ctx, quoteEveryMs: EVERY, log: silent });
    const tick = async (jobs: ReturnType<typeof fresh>) => {
      await t.clock.advance(MINUTE_MS);
      return (await jobs.tick()).quoted;
    };
    // a first run has no pass behind it
    expect(await tick(t.jobs)).toEqual(["CRYPTO"]);
    // restarted within the same five minutes: nothing new to ask
    expect(await tick(fresh())).toEqual([]);
    // the next period asks as the schedule does
    const again = fresh();
    await t.clock.advance(2 * MINUTE_MS);
    expect(await tick(again)).toEqual(["CRYPTO"]);
    // a pass cut by shutdown is no pass: the restart asks again
    t.db
      .query(
        "update sync_runs set status = 'failed', error = ? where id = (select max(id) from sync_runs where job = 'quotes')",
      )
      .run(STOPPED);
    expect(await tick(fresh())).toEqual(["CRYPTO"]);
    // down for hours: the first tick asks at once
    await t.clock.advance(3 * 60 * MINUTE_MS);
    expect(await tick(fresh())).toEqual(["CRYPTO"]);
  });

  test("a restart asks again only the market whose pass shutdown cut", async () => {
    const s = sim([US("U0"), CRYPTO("C0-USD")]);
    // Monday 17:58 UTC: New York trades
    const t = setup(utc("2026-10-26T17:58"), (url, now) => s.route(url, now));
    await added(t.ctx, "U0");
    await added(t.ctx, "C0-USD");
    expect((await t.runTo(utc("2026-10-26T18:00"))).at(-1)!.quoted).toEqual([
      "CRYPTO",
      "US",
    ]);
    // shutdown cut the crypto pass, the US one ended
    t.db
      .query(
        "update sync_runs set status = 'failed', error = ? where id = (select max(id) from sync_runs where job = 'quotes' and scope = 'CRYPTO')",
      )
      .run(STOPPED);
    await t.clock.advance(MINUTE_MS);
    const restarted = yahooJobs({
      ctx: t.ctx,
      quoteEveryMs: EVERY,
      log: silent,
    });
    expect((await restarted.tick()).quoted).toEqual(["CRYPTO"]);
  });

  test("only markets in session and crypto always, in batches of 20 each with _=", async () => {
    const listings: SimListing[] = [
      ...Array.from({ length: 21 }, (_, i) => US(`U${i}`)),
      XETRA("X0"),
      CRYPTO("C0-USD"),
    ];
    const s = sim(listings);
    // Monday 17:58 UTC: New York trades, Xetra closed at 16:30
    const t = setup(utc("2026-10-26T17:58"), (url, now) => s.route(url, now));
    for (const l of listings) await added(t.ctx, l.symbol);
    await t.runTo(utc("2026-10-26T18:00"));
    const before = t.f.urls.length;
    const reports = await t.runTo(utc("2026-10-26T18:05"));

    const asked = sparks(t.f.urls.slice(before));
    expect(asked).toHaveLength(2);
    expect(asked.map((u) => symbolsOf(u).length)).toEqual([20, 2]);
    for (const u of asked) {
      expect(u.searchParams.get("_")).toBe(String(utc("2026-10-26T18:05")));
    }
    const symbols = asked.flatMap(symbolsOf);
    expect(symbols).toContain("C0-USD");
    expect(symbols).not.toContain("X0.DE");
    expect(reports.at(-1)!.quoted).toEqual(["CRYPTO", "US"]);
    // the four ticks between turns of the period ask nothing
    expect(reports.slice(0, 4).every((r) => r.quoted.length === 0)).toBe(true);
    expect(readQuote(t.db, "US:U0")!.fetchedAt).toBe(utc("2026-10-26T18:05"));
    // only the first tick's post-close batch, taken late
    expect(readQuote(t.db, "XETRA:X0")!.fetchedAt).toBe(
      utc("2026-10-26T17:59"),
    );
    expect(lastRun(t.db, "yahoo", JOBS.quotes, "US")).toMatchObject({
      status: "ok",
      rows: 21,
    });
  });

  test("a failed batch fails its markets' runs and marks only their quotes stale", async () => {
    const s = sim([US("U0"), CRYPTO("C0-USD")]);
    let down = false;
    const t = setup(utc("2026-10-26T17:58"), (url, now) =>
      down && url.pathname === "/v7/finance/spark"
        ? { recordedAt: "", status: 500, headers: {}, body: "" }
        : s.route(url, now),
    );
    await added(t.ctx, "U0");
    await added(t.ctx, "C0-USD");
    await t.runTo(utc("2026-10-26T18:00"));
    down = true;
    await t.runTo(utc("2026-10-26T18:05"));
    const u0 = readInstrument(t.db, "US:U0")!;
    expect(quoteStale(t.db, u0)).toEqual(["quote sync failed"]);
    expect(lastRun(t.db, "yahoo", JOBS.quotes, "US")!.error).toBe(
      "source error",
    );
    down = false;
    await t.runTo(utc("2026-10-26T18:10"));
    expect(quoteStale(t.db, u0)).toEqual([]);
  });

  test("a symbol skipped or left out is stale alone; an empty answer fails the run", async () => {
    const s = sim([US("U0"), US("U1"), CRYPTO("C0-USD")]);
    let edit: (result: any[]) => any[] = (r) => r;
    const t = setup(utc("2026-10-26T17:58"), (url, now) => {
      const answer = s.route(url, now)!;
      if (url.pathname === "/v7/finance/spark") {
        answer.body.spark.result = edit(answer.body.spark.result);
      }
      return answer;
    });
    for (const symbol of ["U0", "U1", "C0-USD"]) {
      await added(t.ctx, symbol);
    }
    await t.runTo(utc("2026-10-26T18:00"));
    edit = (result) => {
      for (const r of result) {
        if (r.symbol === "U1") delete r.response[0].meta.regularMarketPrice;
      }
      return result;
    };
    await t.runTo(utc("2026-10-26T18:05"));
    expect(lastRun(t.db, "yahoo", JOBS.quotes, "US")).toMatchObject({
      status: "ok",
      rows: 1,
    });
    expect(readQuote(t.db, "US:U0")!.fetchedAt).toBe(utc("2026-10-26T18:05"));
    expect(quoteStale(t.db, readInstrument(t.db, "US:U0")!)).toEqual([]);
    expect(quoteStale(t.db, readInstrument(t.db, "US:U1")!)).toEqual([
      "no quote in the last pass",
    ]);
    expect(lastRun(t.db, "yahoo", JOBS.quotes, "CRYPTO")!.status).toBe("ok");

    edit = () => [];
    await t.runTo(utc("2026-10-26T18:10"));
    for (const market of ["US", "CRYPTO"]) {
      expect(lastRun(t.db, "yahoo", JOBS.quotes, market)).toMatchObject({
        status: "failed",
        error: "malformed answer",
        rows: 0,
      });
    }
  });
});

describe("closed markets", () => {
  test("are checked from the last attempt, and quoting restarts once a later session shows", async () => {
    const chart = listed(await recorded("chart-vvsm-de-5d-1d"));
    const spark = await sparkFrom();
    const vvsm = spark.metas.get("VVSM.DE");
    let chartAnswer = chart;
    let sparkDown = false;
    const t = setup(utc("2026-10-25T19:40"), (url) => {
      if (chartSymbol(url) !== null) return chartAnswer;
      if (sparkDown)
        return { recordedAt: "", status: 500, headers: {}, body: "" };
      return spark.route(url);
    });
    await added(t.ctx, "VVSM.DE");
    expect(readBars(t.db, "XETRA:VVSM", "1d").at(-1)).toMatchObject({
      date: "2026-10-23",
      final: false,
    });

    // Sunday: Friday's post-close quote, never taken, and a first refetch
    const sunday = await t.runTo(utc("2026-10-25T19:41"));
    expect(sunday.at(-1)!.quoted).toEqual(["XETRA"]);
    expect(sunday.at(-1)!.bars.map((b) => b.market)).toEqual(["XETRA"]);
    const settled = t.f.urls.length;
    // nothing until Monday 09:00 in Berlin, 08:00 UTC after the clock change
    await t.runTo(utc("2026-10-26T07:59"));
    expect(t.f.urls).toHaveLength(settled);

    // Yahoo still shows Friday's session: the next check is an hour on
    let reports = await t.runTo(utc("2026-10-26T08:00"));
    expect(reports.at(-1)!.checked).toEqual(["XETRA"]);
    expect(sparks(t.f.urls.slice(settled))).toHaveLength(1);
    await t.runTo(utc("2026-10-26T08:59"));
    expect(t.f.urls).toHaveLength(settled + 1);

    // a failed check counts as an attempt: none again before 10:00
    sparkDown = true;
    await t.runTo(utc("2026-10-26T09:00"));
    expect(t.f.urls).toHaveLength(settled + 2);
    const instrument = readInstrument(t.db, "XETRA:VVSM")!;
    expect(quoteStale(t.db, instrument)).toEqual(["session check failed"]);
    await t.runTo(utc("2026-10-26T09:59"));
    expect(t.f.urls).toHaveLength(settled + 2);

    // Monday's session shows: the bars are refetched in the same tick and
    // Friday's bar is final
    sparkDown = false;
    moveSession(
      vvsm,
      "2026-10-26T08:00",
      "2026-10-26T16:30",
      utc("2026-10-26T10:00"),
    );
    chartAnswer = clone(chart);
    moveSession(
      chartAnswer.body.chart.result[0].meta,
      "2026-10-26T08:00",
      "2026-10-26T16:30",
      utc("2026-10-26T10:00"),
    );
    reports = await t.runTo(utc("2026-10-26T10:00"));
    expect(reports.at(-1)!.checked).toEqual(["XETRA"]);
    expect(reports.at(-1)!.bars).toEqual([
      { market: "XETRA", rows: 5, changed: [], error: null },
    ]);
    expect(readSession(t.db, "XETRA")!.start).toBe(utc("2026-10-26T08:00"));
    expect(readBars(t.db, "XETRA:VVSM", "1d").at(-1)).toMatchObject({
      date: "2026-10-23",
      final: true,
    });
    expect(quoteStale(t.db, instrument)).toEqual([]);
    expect(barsStale(t.db, instrument, t.clock.now())).toEqual([]);

    // quoting restarts on the next turn of the period
    reports = await t.runTo(utc("2026-10-26T10:05"));
    expect(reports.map((r) => r.quoted)).toEqual([[], [], [], [], ["XETRA"]]);
    expect(reports.flatMap((r) => r.bars)).toEqual([]);
  });
});

describe("a closed market's check", () => {
  test("goes round its instruments, so one that never answers cannot hide a session", async () => {
    const s = sim([US("U0"), US("U1")]);
    const t = setup(utc("2026-10-25T20:00"), (url, now) => {
      const answer = s.route(url, now)!;
      if (url.pathname === "/v7/finance/spark") {
        for (const r of answer.body.spark.result) {
          if (r.symbol === "U0") r.response = null;
        }
      }
      return answer;
    });
    await added(t.ctx, "U0");
    await added(t.ctx, "U1");
    await t.runTo(utc("2026-10-26T16:00"));
    expect(readSession(t.db, "US")!.start).toBe(utc("2026-10-26T13:30"));
    expect(readQuote(t.db, "US:U1")!.fetchedAt).toBe(utc("2026-10-26T16:00"));
    // U0, never answered, is stale on its own, never U1
    expect(quoteStale(t.db, readInstrument(t.db, "US:U1")!)).toEqual([]);
    expect(quoteStale(t.db, readInstrument(t.db, "US:U0")!)).toEqual([
      "no quote yet",
    ]);
  });
});

describe("a market closed before the start", () => {
  test("gets its last session's 5-minute closes in one check, and a restart with them asks nothing", async () => {
    const fx = clone(await recorded("spark-v7-extended-post-2122"));
    // a second Xetra listing, so one check for all tells from one at a time
    const copy = clone(
      fx.body.spark.result.find((r: any) => r.symbol === "VWCE.DE"),
    );
    copy.symbol = "XDWD.DE";
    copy.response[0].meta.symbol = "XDWD.DE";
    fx.body.spark.result.push(copy);
    const at = Date.parse(fx.recordedAt);
    const route = (url: URL): Recorded | undefined => {
      if (url.pathname !== "/v7/finance/spark") return undefined;
      const out = clone(fx);
      const asked = new Set(symbolsOf(url));
      out.body.spark.result = out.body.spark.result.filter((r: any) =>
        asked.has(r.symbol),
      );
      return out;
    };
    const t = setup(at, route);
    // stored by an earlier process whose answers kept no points
    const bare = clone(fx);
    for (const r of bare.body.spark.result) {
      delete r.response[0].timestamp;
      r.response[0].indicators = { quote: [{}] };
    }
    const xetra = bare.body.spark.result.filter((r: any) =>
      r.symbol.endsWith(".DE"),
    );
    bare.body.spark.result = xetra;
    for (const r of xetra) {
      const meta = r.response[0].meta;
      const symbol = meta.symbol.replace(/\.DE$/, "");
      upsertInstrument(
        t.db,
        {
          market: "XETRA",
          symbol,
          source: "yahoo",
          sourceSymbol: meta.symbol,
          exchange: meta.exchangeName,
          name: symbol,
          type: meta.instrumentType,
          currency: meta.currency,
          unit: "per_share",
          zone: meta.exchangeTimezoneName,
        },
        at,
      );
      t.db
        .query(
          `insert into bars (instrument, interval, date, close, final, fetched_at)
           values (?, '1d', '2026-10-27', 1, 1, ?)`,
        )
        .run(`XETRA:${symbol}`, at);
      markRead(t.db, [`XETRA:${symbol}`], at);
    }
    storeQuotes(t.db, parseSpark(bare.body, at));
    endRun(t.db, startRun(t.db, "yahoo", JOBS.quotes, at, "XETRA"), at, 1);
    endRun(t.db, startRun(t.db, "yahoo", JOBS.bars, at, "XETRA"), at, 2);
    const ids = xetra.map((r: any) => `XETRA:${r.symbol.replace(/\.DE$/, "")}`);
    const stored = () =>
      t.db
        .query<{ n: number }, []>(
          `select count(distinct instrument) as n from intraday
           where instrument like 'XETRA:%' and session = '2026-10-27'`,
        )
        .get()!.n;
    expect(stored()).toBe(0);
    await t.runTo(at + MINUTE_MS);
    const asked = sparks(t.f.urls).filter((u) =>
      symbolsOf(u).some((s) => s.endsWith(".DE")),
    );
    expect(asked).toHaveLength(1);
    expect(symbolsOf(asked[0]!).sort()).toEqual(
      xetra.map((r: any) => r.symbol).sort(),
    );
    expect(stored()).toBe(ids.length);
    const again = yahooJobs({ ctx: t.ctx, quoteEveryMs: EVERY, log: silent });
    const before = sparks(t.f.urls).length;
    await t.clock.advance(MINUTE_MS);
    await again.tick();
    expect(
      sparks(t.f.urls)
        .slice(before)
        .filter((u) => symbolsOf(u).some((s) => s.endsWith(".DE"))),
    ).toHaveLength(0);
  });
});

describe("bars at the session change", () => {
  async function weekend(
    edit: (nvda: any, now: number) => void = () => {},
    // symbols whose Monday chart answers fail, with a 404 that pauses no
    // queue, so the next chart goes at once
    down = new Set<string>(),
  ) {
    const fixtures = {
      NVDA: listed(await recorded("chart-nvda-5d-1d")),
      HYG: listed(await recorded("chart-hyg-5d-1d")),
    };
    const spark = await sparkFrom();
    // HYG rides the spark answer as NVDA's twin on PCX
    const hyg = clone(spark.metas.get("NVDA"));
    hyg.symbol = "HYG";
    hyg.exchangeName = "PCX";
    spark.metas.set("HYG", hyg);
    let monday = false;
    const t = setup(utc("2026-10-25T19:40"), (url, now) => {
      const symbol = chartSymbol(url) as keyof typeof fixtures | null;
      if (symbol === null) return spark.route(url);
      if (monday && down.has(symbol)) {
        return { recordedAt: "", status: 404, headers: {}, body: "" };
      }
      const answer = clone(fixtures[symbol]);
      if (monday) {
        const result = answer.body.chart.result[0];
        moveSession(result.meta, "2026-10-26T13:30", "2026-10-26T20:00", now);
        if (symbol === "NVDA") edit(result, now);
      }
      return answer;
    });
    await added(t.ctx, "NVDA");
    await added(t.ctx, "HYG");
    await t.runTo(utc("2026-10-26T13:29"));
    const before = t.f.urls.length;
    monday = true;
    for (const symbol of ["NVDA", "HYG"]) {
      moveSession(
        spark.metas.get(symbol),
        "2026-10-26T13:30",
        "2026-10-26T20:00",
        utc("2026-10-26T13:30"),
      );
    }
    const report = (await t.runTo(utc("2026-10-26T13:30")))[0]!;
    return { ...t, before, report };
  }

  test("refetch 30 days once per instrument, and the previous bar turns final", async () => {
    const t = await weekend();
    expect(t.report.checked).toEqual(["US"]);
    const asked = charts(t.f.urls.slice(t.before));
    expect(asked.map(chartSymbol).sort()).toEqual(["HYG", "NVDA"]);
    for (const u of asked) {
      expect(u.searchParams.get("period1")).toBe(
        String(Math.floor((t.clock.now() - 30 * DAY_MS) / 1000)),
      );
    }
    for (const id of ["US:NVDA", "US:HYG"]) {
      expect(readBars(t.db, id, "1d").at(-1)).toMatchObject({
        date: "2026-10-23",
        final: true,
      });
    }
    // quoting goes on, without another refetch the same session
    const rest = await t.runTo(utc("2026-10-26T15:00"));
    expect(charts(t.f.urls.slice(t.before))).toHaveLength(2);
    expect(rest.flatMap((r) => r.bars)).toEqual([]);
    expect(rest.filter((r) => r.quoted.length > 0)).toHaveLength(18);
  });

  test("a new split in the refetch is applied in the tick that first sees the session", async () => {
    const t = await weekend((result) => {
      result.events = {
        splits: {
          [utc("2026-10-26T13:30") / 1000]: {
            date: utc("2026-10-26T13:30") / 1000,
            numerator: 2,
            denominator: 1,
            splitRatio: "2:1",
          },
        },
      };
      const q = result.indicators.quote[0];
      for (const k of ["open", "high", "low", "close"]) {
        q[k] = q[k].map((v: number) => v / 2);
      }
    });
    // the window, then the whole history once
    expect(
      charts(t.f.urls.slice(t.before)).filter((u) => chartSymbol(u) === "NVDA"),
    ).toHaveLength(2);
    expect(t.db.query("select date, ratio from splits").all()).toEqual([
      { date: "2026-10-26", ratio: "2:1" },
    ]);
    const nvda = t.report.bars[0]!.changed.find(
      (c) => c.instrument === "US:NVDA",
    );
    expect(nvda).toEqual({ instrument: "US:NVDA", changedFrom: "2026-10-19" });
    expect(readBars(t.db, "US:NVDA", "1d").at(-1)!.close).toBeCloseTo(
      210.9600067138672 / 2,
      6,
    );
    expect(
      barsStale(t.db, readInstrument(t.db, "US:NVDA")!, t.clock.now()),
    ).toEqual([]);
  });

  test("one failed refetch marks only its instrument stale, and only it is retried", async () => {
    const down = new Set(["NVDA"]);
    const t = await weekend(undefined, down);
    const nvda = readInstrument(t.db, "US:NVDA")!;
    const hyg = readInstrument(t.db, "US:HYG")!;
    expect(t.report.bars).toMatchObject([{ market: "US", error: null }]);
    expect(lastRun(t.db, "yahoo", JOBS.bars, "US")!.status).toBe("ok");
    expect(barsStale(t.db, nvda, t.clock.now())).toEqual(["bar sync failed"]);
    expect(barsStale(t.db, hyg, t.clock.now())).toEqual([]);
    // still down: asked again only once RETRY_MS has passed, each time
    const failedAt = t.clock.now();
    const asked = (from: number) =>
      charts(t.f.urls.slice(from)).map(chartSymbol);
    let before = t.f.urls.length;
    await t.runTo(failedAt + RETRY_MS - MINUTE_MS);
    expect(asked(before)).toEqual([]);
    await t.runTo(failedAt + RETRY_MS);
    expect(asked(before)).toEqual(["NVDA"]);
    expect(barsStale(t.db, nvda, t.clock.now())).toEqual(["bar sync failed"]);
    before = t.f.urls.length;
    await t.runTo(failedAt + 2 * RETRY_MS - MINUTE_MS);
    expect(asked(before)).toEqual([]);
    down.clear();
    await t.runTo(failedAt + 2 * RETRY_MS);
    expect(asked(before)).toEqual(["NVDA"]);
    expect(barsStale(t.db, nvda, t.clock.now())).toEqual([]);
    expect(barsStale(t.db, hyg, t.clock.now())).toEqual([]);
    expect(lastRun(t.db, "yahoo", JOBS.bars, "US")!.status).toBe("ok");
  });

  test("a read that catches up an instrument clears its failed refetch at once", async () => {
    const down = new Set(["NVDA"]);
    const t = await weekend(undefined, down);
    const nvda = readInstrument(t.db, "US:NVDA")!;
    expect(barsStale(t.db, nvda, t.clock.now())).toEqual(["bar sync failed"]);
    down.clear();
    const before = t.f.urls.length;
    await catchUp(t.ctx, nvda, () => true);
    expect(charts(t.f.urls.slice(before)).map(chartSymbol)).toEqual(["NVDA"]);
    expect(barsStale(t.db, nvda, t.clock.now())).toEqual([]);
  });

  test("the market's run fails when no refetch answered", async () => {
    const t = await weekend(undefined, new Set(["NVDA", "HYG"]));
    expect(t.report.bars[0]!.error).not.toBeNull();
    expect(lastRun(t.db, "yahoo", JOBS.bars, "US")!.status).toBe("failed");
    expect(
      barsStale(t.db, readInstrument(t.db, "US:HYG")!, t.clock.now()),
    ).toContain("bar sync failed");
  });
});

describe("a finished session's close that lands late", () => {
  // stored from Sunday's chart; from the next session's start each chart
  // ask is answered by at, k counting the asks
  async function nextSession(o: {
    symbol: string;
    sunday: Recorded;
    session: [string, string];
    at: (k: number, now: number) => Recorded;
    price?: number;
  }) {
    const spark = await sparkFrom();
    let moved = false;
    const asks: number[] = [];
    const t = setup(utc("2026-10-25T19:40"), (url, now) => {
      if (chartSymbol(url) === null) return spark.route(url);
      if (!moved) return o.sunday;
      asks.push(now);
      return o.at(asks.length - 1, now);
    });
    await added(t.ctx, o.symbol);
    const [start, end] = o.session;
    await t.runTo(utc(start) - MINUTE_MS);
    moved = true;
    const meta = spark.metas.get(o.symbol);
    moveSession(meta, start, end, utc(start));
    if (o.price !== undefined) meta.regularMarketPrice = o.price;
    await t.runTo(utc(start));
    return { ...t, asks, meta, spark };
  }

  const XETRA_MONDAY: [string, string] = [
    "2026-10-26T08:00",
    "2026-10-26T16:30",
  ];
  const FRIDAY_CLOSE = 87.22000122070312;

  // Monday's open as recorded, and with Friday's close not in yet
  async function mondayOpen() {
    const open = await recorded("chart-vvsm-de-5d-1d-open-0800");
    const late = clone(open);
    late.body.chart.result[0].indicators.quote[0].close[3] = null;
    return { open, late };
  }

  function appendDay(result: any, at: string, close: number | null) {
    result.timestamp.push(utc(at) / 1000);
    const q = result.indicators.quote[0];
    for (const k of ["open", "high", "low", "close"]) q[k].push(close);
    q.volume.push(close === null ? null : 1000);
  }

  const bar = (db: any, id: string, date: string) =>
    readBars(db, id, "1d").find((b) => b.date === date);

  const spaced = (asks: number[]) =>
    asks.slice(1).map((at, k) => at - asks[k]!);

  test("a Xetra chart at the open without the last close keeps its bar and asks again until it lands", async () => {
    const { open, late } = await mondayOpen();
    const t = await nextSession({
      symbol: "VVSM.DE",
      sunday: listed(await recorded("chart-vvsm-de-5d-1d")),
      session: XETRA_MONDAY,
      at: (k) => (k < 2 ? late : open),
    });
    expect(t.asks).toEqual([utc("2026-10-26T08:00")]);
    expect(bar(t.db, "XETRA:VVSM", "2026-10-23")).toMatchObject({
      close: FRIDAY_CLOSE,
      final: false,
    });

    await t.runTo(utc("2026-10-26T18:00"));
    expect(t.asks).toEqual([
      utc("2026-10-26T08:00"),
      utc("2026-10-26T08:15"),
      utc("2026-10-26T08:30"),
    ]);
    expect(bar(t.db, "XETRA:VVSM", "2026-10-23")).toMatchObject({
      close: FRIDAY_CLOSE,
      final: true,
    });
    expect(
      barsStale(t.db, readInstrument(t.db, "XETRA:VVSM")!, t.clock.now()),
    ).toEqual([]);
  });

  test("a crypto chart at midnight without the day just ended gets it on a later pass", async () => {
    const sunday = listed(await recorded("chart-sol-usd-5d-1d"));
    // Monday's chart: its session and first row, Sunday's row left out
    // or with its final close
    const monday = (close: number | null) => {
      const out = clone(sunday);
      const result = out.body.chart.result[0];
      moveSession(
        result.meta,
        "2026-10-26T00:00",
        "2026-10-26T23:59",
        utc("2026-10-26T00:00"),
      );
      const q = result.indicators.quote[0];
      if (close === null) {
        result.timestamp.pop();
        for (const k of ["open", "high", "low", "close", "volume"]) q[k].pop();
      } else {
        q.close[q.close.length - 1] = close;
      }
      appendDay(result, "2026-10-26T00:00", 101.3);
      return out;
    };
    const missing = monday(null);
    const full = monday(101.2);
    const t = await nextSession({
      symbol: "SOL-USD",
      sunday,
      session: ["2026-10-26T00:00", "2026-10-26T23:59"],
      at: (k) => (k < 2 ? missing : full),
    });
    expect(bar(t.db, "CRYPTO:SOL-USD", "2026-10-25")).toMatchObject({
      close: 101.66000366210938,
      final: false,
    });

    await t.runTo(utc("2026-10-26T06:00"));
    expect(t.asks).toEqual([
      utc("2026-10-26T00:00"),
      utc("2026-10-26T00:15"),
      utc("2026-10-26T00:30"),
    ]);
    expect(bar(t.db, "CRYPTO:SOL-USD", "2026-10-25")).toMatchObject({
      close: 101.2,
      final: true,
    });
  });

  test("US charts at the open have the last close and make no extra pass", async () => {
    const open = await recorded("chart-nvda-5d-1d-open-1330");
    const t = await nextSession({
      symbol: "NVDA",
      sunday: listed(await recorded("chart-nvda-5d-1d")),
      session: ["2026-10-26T13:30", "2026-10-26T20:00"],
      at: () => open,
    });
    await t.runTo(utc("2026-10-26T21:00"));
    expect(t.asks).toEqual([utc("2026-10-26T13:30")]);
    expect(bar(t.db, "US:NVDA", "2026-10-23")).toMatchObject({ final: true });
  });

  test("an owed mark on an instrument with no bars never speeds up its market's pass", async () => {
    const { late } = await mondayOpen();
    const t = await nextSession({
      symbol: "VVSM.DE",
      sunday: listed(await recorded("chart-vvsm-de-5d-1d")),
      session: XETRA_MONDAY,
      at: () => late,
    });
    const meta = clone(t.meta);
    meta.symbol = "XX0.DE";
    t.spark.metas.set("XX0.DE", meta);
    await t.ctx.writer.write((db) => {
      const now = t.clock.now();
      upsertInstrument(
        db,
        {
          market: "XETRA",
          symbol: "XX0",
          source: "yahoo",
          sourceSymbol: "XX0.DE",
          exchange: "GER",
          name: "XX0",
          type: "ETF",
          currency: "EUR",
          unit: "per_share",
          zone: "Europe/Berlin",
        },
        now,
      );
      markRead(db, ["XETRA:XX0"], now);
      endRun(db, startRun(db, "yahoo", JOBS.bars, now, "XETRA:XX0"), now, 0);
      endRun(db, startRun(db, "yahoo", JOBS.owed, now, "XETRA:XX0"), now, 0);
    });
    await t.runTo(utc("2026-10-26T10:00"));
    expect(t.asks).toHaveLength(9);
    expect(new Set(spaced(t.asks))).toEqual(new Set([OWED_RETRY_MS]));
  });

  test("a day never closed is asked every period until the next session starts, then dropped", async () => {
    const { late } = await mondayOpen();
    // Tuesday's open: Monday closed, Friday still without its close
    const tuesday = clone(late);
    const result = tuesday.body.chart.result[0];
    moveSession(
      result.meta,
      "2026-10-27T08:00",
      "2026-10-27T16:30",
      utc("2026-10-27T08:00"),
    );
    result.indicators.quote[0].close[4] = 88;
    appendDay(result, "2026-10-27T08:00", null);
    const t = await nextSession({
      symbol: "VVSM.DE",
      sunday: listed(await recorded("chart-vvsm-de-5d-1d")),
      session: XETRA_MONDAY,
      at: (_, now) => (now >= utc("2026-10-27T08:00") ? tuesday : late),
    });
    await t.runTo(utc("2026-10-27T07:59"));
    // the worst case: every period from one session's start to the next
    expect(t.asks).toHaveLength(96);
    expect(new Set(spaced(t.asks))).toEqual(new Set([OWED_RETRY_MS]));
    expect(bar(t.db, "XETRA:VVSM", "2026-10-23")).toMatchObject({
      final: false,
    });

    moveSession(
      t.meta,
      "2026-10-27T08:00",
      "2026-10-27T16:30",
      utc("2026-10-27T08:00"),
    );
    await t.runTo(utc("2026-10-27T12:00"));
    expect(t.asks).toHaveLength(97);
    expect(t.asks.at(-1)).toBe(utc("2026-10-27T08:00"));
    expect(bar(t.db, "XETRA:VVSM", "2026-10-23")).toBeUndefined();
    expect(bar(t.db, "XETRA:VVSM", "2026-10-26")).toMatchObject({
      close: 88,
      final: true,
    });
  });

  test("the daily SMA 200 spans the owed day, and a crossing reads its close once it lands", async () => {
    const week = backTo(await recorded("chart-vvsm-de-5d-1d"), "2026-01-01");
    const q = week.body.chart.result[0].indicators.quote[0];
    const made = q.close.length - 5;
    for (const k of ["open", "high", "low", "close"]) {
      q[k] = q[k].map((v: number, i: number) => (i < made ? 88 : v));
    }
    const closes: number[] = [...q.close];
    const { open, late } = await mondayOpen();
    const t = await nextSession({
      symbol: "VVSM.DE",
      sunday: listed(week),
      session: XETRA_MONDAY,
      at: (k) => (k < 2 ? late : open),
      price: 90,
    });
    const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    const then = mean(closes.slice(-200));
    const now = mean([...closes.slice(-199), 90]);
    const daily = () =>
      readSignals(t.db, "XETRA:VVSM", t.clock.now())!.daily as any;
    // owed: the live average already counts the kept bar
    expect(daily().final.date).toBe("2026-10-22");
    expect(daily().live).toMatchObject({ date: "2026-10-26" });
    expect(daily().live.sma200).toBeCloseTo(now, 9);

    await t.runTo(utc("2026-10-26T08:30"));
    expect(daily().final.date).toBe("2026-10-23");
    expect(daily().final.sma200).toBeCloseTo(then, 9);
    expect(daily().live.sma200).toBeCloseTo(now, 9);
    const m = markets({
      db: t.db,
      clock: t.clock,
      writer: t.ctx.writer,
      yahoo: t.ctx.yahoo,
      fred: null,
      log: silent,
    });
    const r = await moversAnswer(
      m,
      parseMovers({
        symbols: ["XETRA:VVSM"],
        average: "daily_sma200",
        relation: "crossed_up",
      }),
    );
    const item = JSON.parse(r.content[0]!.text).items[0];
    expect(item.status).toBe("matched");
    expect(item.average.last_final).toEqual({
      date: "2026-10-23",
      close: expect.closeTo(FRIDAY_CLOSE, 2),
      value: expect.closeTo(then, 2),
    });
  });
});

describe("a slow bar pass", () => {
  test("never takes a quote turn", async () => {
    const listings = Array.from({ length: 16 }, (_, i) => US(`U${i}`));
    const s = sim(listings);
    let slow = false;
    const t = setup(utc("2026-10-26T13:25"), (url, now) => {
      const answer = s.route(url, now)!;
      if (!slow || chartSymbol(url) === null) return answer;
      // each chart answers 25 s later, 400 s for the pass
      return new Promise((resolve) =>
        t.clock.at(t.clock.now() + 25_000, () => resolve(answer)),
      );
    });
    for (const l of listings) await added(t.ctx, l.symbol);
    // Friday's bar pass, so only Monday's is slow
    await t.jobs.tick();
    slow = true;
    const before = t.f.urls.length;
    const jobs = scheduler(t.clock, silent);
    t.jobs.schedule(jobs);
    // a second at a time, so each answer's timer is set before it is due
    while (t.clock.now() < utc("2026-10-26T13:45")) {
      await t.clock.advance(1000);
    }
    await jobs.stop();
    const urls = t.f.urls.slice(before);
    expect(daily(urls)).toHaveLength(16);
    const turns = sparks(urls).map((u) => Number(u.searchParams.get("_")));
    for (const at of ["13:35", "13:40", "13:45"]) {
      expect(turns).toContain(utc(`2026-10-26T${at}`));
    }
  });
});

describe("backfill", () => {
  test("runs as its own turn for an instrument with no bars, never on the quote path", async () => {
    const s = sim([US("U0")]);
    const t = setup(utc("2026-10-26T17:58"), (url, now) => s.route(url, now));
    await added(t.ctx, "U0");
    t.db.query("delete from bars").run();
    const u0 = readInstrument(t.db, "US:U0")!;
    expect(barsStale(t.db, u0, t.clock.now())).toEqual(["no history"]);
    const before = t.f.urls.length;
    await t.runTo(utc("2026-10-26T18:00"));
    // a bar pass passes it by, and quotes go on
    expect(sparks(t.f.urls.slice(before))).toHaveLength(2);
    expect(charts(t.f.urls.slice(before))).toHaveLength(0);
    expect(await t.jobs.backfillTurn()).toBe("US:U0");
    expect(charts(t.f.urls.slice(before))).toHaveLength(1);
    expect(readBars(t.db, "US:U0", "1d").at(-1)).toMatchObject({
      date: "2026-10-26",
      final: false,
    });
    expect(barsStale(t.db, u0, t.clock.now())).toEqual([]);
    expect(await t.jobs.backfillTurn()).toBeNull();
  });

  test("a first history that starts well after the listing is retried later", async () => {
    // ten years asked, the listing traded since 1999, five years answered
    const short = await recorded("chart-nvda-5y-1d");
    let answer = short;
    const t = setup(Date.parse(short.recordedAt), () => answer);
    const { rows } = await added(t.ctx, "NVDA");
    expect(rows).toBe(0);
    expect(readBars(t.db, "US:NVDA", "1d")).toEqual([]);
    await expect(t.jobs.backfillTurn()).rejects.toThrow("a history cut short");
    expect(lastRun(t.db, "yahoo", "backfill")).toMatchObject({
      status: "failed",
      error: "malformed answer",
      // a run per instrument, so another one's success never hides it
      scope: "US:NVDA",
    });
    expect(readBars(t.db, "US:NVDA", "1d")).toEqual([]);
    expect(await t.jobs.backfillTurn()).toBeNull();
    answer = backTo(short, "2016-10-24");
    await t.clock.advance(RETRY_MS);
    expect(await t.jobs.backfillTurn()).toBe("US:NVDA");
    expect(readBars(t.db, "US:NVDA", "1d")[0]!.date).toBe("2016-10-24");
  });

  test("an empty history waits like a failure, and the next instrument goes", async () => {
    const s = sim([US("U0"), US("U1")]);
    let empty = false;
    const t = setup(utc("2026-10-26T17:58"), (url, now) => {
      const answer = s.route(url, now)!;
      if (empty && chartSymbol(url) === "U0") {
        const result = answer.body.chart.result[0];
        delete result.timestamp;
        result.indicators.quote = [{}];
      }
      return answer;
    });
    await added(t.ctx, "U0");
    await added(t.ctx, "U1");
    t.db.query("delete from bars").run();
    empty = true;
    const before = t.f.urls.length;
    expect(await t.jobs.backfillTurn()).toBe("US:U0");
    expect(lastRun(t.db, "yahoo", "backfill")).toMatchObject({
      status: "ok",
      rows: 0,
    });
    expect(await t.jobs.backfillTurn()).toBe("US:U1");
    expect(await t.jobs.backfillTurn()).toBeNull();
    expect(charts(t.f.urls.slice(before)).map(chartSymbol)).toEqual([
      "U0",
      "U1",
    ]);
    await t.clock.advance(RETRY_MS);
    expect(await t.jobs.backfillTurn()).toBe("US:U0");
  });
});

describe("five sessions from the start", () => {
  const AAPL = "chart-aapl-5d-5m";
  const EURUSD = "chart-eurusd-x-5d-5m";
  const BTC = "chart-btc-usd-5d-5m";
  const fives = (urls: URL[]) =>
    charts(urls).filter((u) => u.searchParams.get("interval") === "5m");
  const sessions = (db: Db, id: string) =>
    db
      .query<{ session: string; n: number }, [string]>(
        `select session, count(*) as n from intraday where instrument = ?
         group by session order by session`,
      )
      .all(id)
      .map((r) => [r.session, r.n]);

  // a recorded 5-minute chart, answered as the symbol asked
  function as(fx: Recorded, url: URL): Recorded | undefined {
    if (url.searchParams.get("interval") !== "5m") return undefined;
    const out = clone(fx);
    out.body.chart.result[0].meta.symbol = chartSymbol(url);
    return out;
  }

  // stored and read, as a tool's read leaves it
  function listing(db: Db, fx: Recorded, symbol: string, now: number) {
    const url = new URL(`https://x/v8/finance/chart/${symbol}?interval=5m`);
    const answer = parseChart(as(fx, url)!.body, now);
    const instrument = upsertInstrument(db, fields(answer), now);
    markRead(db, [instrument.id], now);
    return instrument;
  }

  test("fill a listing's missing sessions in one call, never replacing a stored one, once a process", async () => {
    const fx = await recorded(AAPL);
    const at = Date.parse(fx.recordedAt);
    const t = setup(at, (url) => as(fx, url));
    listing(t.db, fx, "AAPL", at);
    // the quote passes' session, stored before the fill
    storeIntraday(
      t.db,
      "US:AAPL",
      "America/New_York",
      [{ at: utc("2026-10-28T14:00"), close: 1 }],
      at,
    );
    expect(await t.jobs.fillTurn()).toEqual(["US:AAPL"]);
    const asked = fives(t.f.urls);
    expect(asked).toHaveLength(1);
    expect(Object.fromEntries(asked[0]!.searchParams)).toEqual({
      range: "5d",
      interval: "5m",
      includePrePost: "false",
    });
    expect(sessions(t.db, "US:AAPL")).toEqual([
      ["2026-10-22", 78],
      ["2026-10-23", 78],
      ["2026-10-26", 78],
      ["2026-10-27", 78],
      ["2026-10-28", 1],
    ]);
    expect(readIntraday(t.db, "US:AAPL", "2026-10-28", "2026-10-28")).toEqual([
      { session: "2026-10-28", at: utc("2026-10-28T14:00"), close: 1 },
    ]);
    // regular hours only: 9:30 to 16:00 New York
    const points = readIntraday(t.db, "US:AAPL", "2026-10-22", "2026-10-27");
    expect(points[0]!.at).toBe(utc("2026-10-22T13:30"));
    expect(points.at(-1)!.at).toBe(utc("2026-10-27T19:55"));
    expect(await t.jobs.fillTurn()).toEqual([]);
    // still short of five, it is not asked again this process
    t.db
      .query("delete from intraday where instrument = ? and session < ?")
      .run("US:AAPL", "2026-10-26");
    await t.clock.advance(RETRY_MS);
    expect(await t.jobs.fillTurn()).toEqual([]);
    expect(fives(t.f.urls)).toHaveLength(1);
    // a new process asks it once more
    const again = yahooJobs({ ctx: t.ctx, quoteEveryMs: EVERY, log: silent });
    expect(await again.fillTurn()).toEqual(["US:AAPL"]);
    expect(sessions(t.db, "US:AAPL").map(([s]) => s)).toHaveLength(5);
    expect(await again.fillTurn()).toEqual([]);
  });

  test("keep no session before the newest split, nor more than five", async () => {
    const fx = await recorded(BTC);
    const at = Date.parse(fx.recordedAt);
    const t = setup(at, (url) => as(fx, url));
    listing(t.db, fx, "BTC-USD", at);
    listing(t.db, fx, "ETH-USD", at);
    t.db
      .query(
        `insert into splits (instrument, date, numerator, denominator, ratio,
           applied_at) values ('CRYPTO:BTC-USD', '2026-10-26', 2, 1, '2:1', ?)`,
      )
      .run(at);
    storeIntraday(
      t.db,
      "CRYPTO:ETH-USD",
      "UTC",
      [{ at: utc("2026-10-19T12:00"), close: 1 }],
      at,
    );
    await t.jobs.fillTurn();
    // crypto's sessions are UTC days
    expect(sessions(t.db, "CRYPTO:BTC-USD")).toEqual([
      ["2026-10-26", 288],
      ["2026-10-27", 288],
      ["2026-10-28", 263],
    ]);
    expect(sessions(t.db, "CRYPTO:ETH-USD")).toEqual([
      ["2026-10-24", 288],
      ["2026-10-25", 288],
      ["2026-10-26", 288],
      ["2026-10-27", 288],
      ["2026-10-28", 263],
    ]);
  });

  test("a failed or empty answer is not asked again this process", async () => {
    const fx = await recorded(AAPL);
    const at = Date.parse(fx.recordedAt);
    const t = setup(at, (url) => {
      const symbol = chartSymbol(url);
      if (symbol === "U0") return { ...fx, status: 404, body: "" };
      const out = as(fx, url)!;
      const result = out.body.chart.result[0];
      delete result.timestamp;
      result.indicators.quote = [{}];
      return out;
    });
    listing(t.db, fx, "U0", at);
    listing(t.db, fx, "U1", at);
    expect(await t.jobs.fillTurn()).toEqual(["US:U0", "US:U1"]);
    expect(sessions(t.db, "US:U0")).toEqual([]);
    expect(sessions(t.db, "US:U1")).toEqual([]);
    await t.clock.advance(RETRY_MS);
    expect(await t.jobs.fillTurn()).toEqual([]);
    expect(fives(t.f.urls).map(chartSymbol)).toEqual(["U0", "U1"]);
  });

  test("ask a few listings a turn, one call at a time, oldest first", async () => {
    const fx = await recorded(AAPL);
    const at = Date.parse(fx.recordedAt);
    let flight = 0;
    let most = 0;
    const t = setup(at, async (url) => {
      flight++;
      most = Math.max(most, flight);
      await Promise.resolve();
      flight--;
      return as(fx, url)!;
    });
    const symbols = Array.from(
      { length: FILLS_PER_TURN + 2 },
      (_, i) => `U${i}`,
    );
    for (const [k, s] of symbols.entries()) listing(t.db, fx, s, at + k);
    // untracked: no read names it
    upsertInstrument(t.db, fields(parseChart(fx.body, at)), at);
    const first = await t.jobs.fillTurn();
    expect(first).toEqual(
      symbols.slice(0, FILLS_PER_TURN).map((s) => `US:${s}`),
    );
    expect(fives(t.f.urls)).toHaveLength(FILLS_PER_TURN);
    expect(most).toBe(1);
    expect(await t.jobs.fillTurn()).toEqual(["US:U5", "US:U6"]);
    expect(await t.jobs.fillTurn()).toEqual([]);
    expect(fives(t.f.urls)).toHaveLength(FILLS_PER_TURN + 2);
  });

  test("run in the backfill lane after a pending history, never on the quote path", async () => {
    const s = sim([US("U0"), US("U1")]);
    const fx = await recorded(AAPL);
    const t = setup(utc("2026-10-26T17:58"), (url, now) =>
      url.searchParams.get("interval") === "5m"
        ? as(fx, url)
        : s.route(url, now),
    );
    await added(t.ctx, "U0");
    await added(t.ctx, "U1");
    t.db.query("delete from bars where instrument = 'US:U0'").run();
    const before = t.f.urls.length;
    await t.runTo(utc("2026-10-26T18:05"));
    // ticks quote and refetch, and ask no 5-minute chart
    expect(sparks(t.f.urls.slice(before)).length).toBeGreaterThan(0);
    expect(fives(t.f.urls)).toHaveLength(0);
    const jobs = scheduler(t.clock, silent);
    t.jobs.schedule(jobs);
    const mark = t.f.urls.length;
    await t.clock.advance(MINUTE_MS);
    await t.clock.advance(MINUTE_MS);
    await jobs.stop();
    const asked = charts(t.f.urls.slice(mark)).map((u) => [
      chartSymbol(u),
      u.searchParams.get("interval"),
    ]);
    // the history first, alone in its turn; then the sessions of both
    const history = asked.findIndex(([s, i]) => s === "U0" && i === "1d");
    expect(history).toBeGreaterThanOrEqual(0);
    expect(history).toBeLessThan(asked.findIndex(([, i]) => i === "5m"));
    expect(asked.filter(([, i]) => i === "5m").map(([s]) => s)).toEqual([
      "U0",
      "U1",
    ]);
  });

  test("a currency pair's filled final days close at their session's last point", async () => {
    const monday = listed(await recorded("chart-eurusd-x-5d-1d-open-0800"));
    const fx = await recorded(EURUSD);
    const nvda = listed(await recorded("chart-nvda-5d-1d"));
    const t = setup(Date.parse(monday.recordedAt), (url) => {
      if (url.searchParams.get("interval") === "5m") return as(fx, url);
      return chartSymbol(url) === "EURUSD=X" ? monday : nvda;
    });
    const EUR = "CCY:EURUSD=X";
    await added(t.ctx, "EURUSD=X");
    await added(t.ctx, "NVDA");
    const shares = () =>
      t.db
        .query(
          "select * from bars where instrument = 'US:NVDA' order by 1, 2, 3",
        )
        .all();
    const before = shares();
    const close = (date: string) =>
      t.db
        .query<{ close: number; point: number }, [string, string]>(
          `select close, point_close as point from bars where instrument = ?
           and interval = '1d' and date = ?`,
        )
        .get(EUR, date);
    const live = readBars(t.db, EUR, "1d").at(-1)!;
    const signals = () =>
      t.db
        .query("select * from signals where instrument = ? order by 1, 2, 3, 4")
        .all(EUR);
    const stale = signals();
    await t.clock.advance(Date.parse(fx.recordedAt) - t.clock.now());
    await t.jobs.fillTurn();
    // London dates: the Friday ran from Thursday 23:00 UTC to 21:25
    expect(sessions(t.db, EUR).map(([s]) => s)).toEqual([
      "2026-10-22",
      "2026-10-23",
      "2026-10-26",
      "2026-10-27",
      "2026-10-28",
    ]);
    const last = (session: string) =>
      readIntraday(t.db, EUR, session, session).at(-1)!;
    expect(last("2026-10-23")).toMatchObject({
      at: utc("2026-10-23T21:25"),
      close: 1.1204482316970825,
    });
    expect(close("2026-10-23")).toEqual({
      close: 1.1204482316970825,
      point: 1,
    });
    expect(close("2026-10-22")).toEqual({
      close: last("2026-10-22").close,
      point: 1,
    });
    expect(
      readBars(t.db, EUR, "1wk").find((w) => w.date === "2026-10-19"),
    ).toMatchObject({ close: 1.1204482316970825 });
    // the live day keeps the quote's price
    expect(readBars(t.db, EUR, "1d").at(-1)).toEqual(live);
    expect(signals()).not.toEqual(stale);
    expect(shares()).toEqual(before);
  });
});

describe("a simulated weekday", () => {
  // From Sunday evening to Tuesday 00:00 UTC, counting Monday's calls.
  async function monday(listings: SimListing[]) {
    const s = sim(listings);
    const t = setup(utc("2026-10-25T20:00"), (url, now) => s.route(url, now));
    for (const l of listings) await added(t.ctx, l.symbol);
    await t.runTo(utc("2026-10-26T00:00"));
    const before = t.f.urls.length;
    await t.runTo(utc("2026-10-27T00:00"));
    const urls = t.f.urls.slice(before);
    return { sparks: sparks(urls).length, charts: charts(urls).length };
  }

  test("one US and one Xetra instrument", async () => {
    // quote turns 08:05-20:00 UTC, the 08:00 Xetra check, the 20:15 US batch;
    // the 13:30 US check and the 16:45 Xetra batch ride turns; one refetch each
    expect(await monday([US("NVDA"), XETRA("VVSM")])).toEqual({
      sparks: 144 + 1 + 1,
      charts: 2,
    });
  });

  test("forty instruments across New York, Xetra, Bucharest and crypto", async () => {
    const listings = [
      ...Array.from({ length: 15 }, (_, i) => US(`U${i}`)),
      ...Array.from({ length: 10 }, (_, i) => XETRA(`X${i}`)),
      ...Array.from({ length: 10 }, (_, i) => BVB(`B${i}`)),
      ...Array.from({ length: 5 }, (_, i) => CRYPTO(`C${i}-USD`)),
    ];
    // one call a turn while 20 or fewer symbols are due, two above
    expect(await monday(listings)).toEqual({ sparks: 391, charts: 40 });
  });
});

describe("startup and shutdown", () => {
  test("a run a crash left running is failed with a fixed phrase", async () => {
    const clock = fakeClock();
    const { db } = open(":memory:", clock);
    const id = startRun(db, "yahoo", JOBS.quotes, clock.now() - 1, "US");
    const app = start({
      hostname: "127.0.0.1",
      port: 0,
      bearer: "x".repeat(32),
      clock,
      log: () => silent,
      version: "v0.0.0-test",
      db,
      quoteEveryMs: EVERY,
      fetch: async (url) => {
        throw new Error(`no network in tests: ${url}`);
      },
    });
    try {
      await app.writer.write(() => {});
      expect(
        db.query("select status, error from sync_runs where id = ?").get(id),
      ).toEqual({ status: "failed", error: INTERRUPTED });
    } finally {
      await app.stop();
    }
    await expect(app.writer.write(() => 1)).rejects.toThrow(
      "the writer is closed",
    );
    db.close();
  });
});
