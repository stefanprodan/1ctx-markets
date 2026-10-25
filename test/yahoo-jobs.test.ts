// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { start } from "../src/app.ts";
import { readBars } from "../src/bars.ts";
import { readSession } from "../src/calendars.ts";
import { DAY_MS, MINUTE_MS } from "../src/clock.ts";
import { open } from "../src/db/index.ts";
import { readInstrument } from "../src/instruments.ts";
import { silent } from "../src/log.ts";
import { INTERRUPTED, lastRun, startRun } from "../src/runs.ts";
import { scheduler } from "../src/scheduler.ts";
import { barsStale, JOBS, quoteStale } from "../src/stale.ts";
import { writer } from "../src/writer.ts";
import { yahoo } from "../src/yahoo/client.ts";
import { RETRY_MS, type TickReport, yahooJobs } from "../src/yahoo/jobs.ts";
import { addInstrument, readQuote } from "../src/yahoo/sync.ts";
import { fakeClock } from "./helpers/clock.ts";
import { BVB, CRYPTO, type SimListing, sim, US, XETRA } from "./helpers/sim.ts";
import {
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
  test("only markets in session and crypto always, in batches of 20 each with _=", async () => {
    const listings: SimListing[] = [
      ...Array.from({ length: 21 }, (_, i) => US(`U${i}`)),
      XETRA("X0"),
      CRYPTO("C0-USD"),
    ];
    const s = sim(listings);
    // Monday 17:58 UTC: New York trades, Xetra closed at 16:30
    const t = setup(utc("2026-10-26T17:58"), (url, now) => s.route(url, now));
    for (const l of listings) await addInstrument(t.ctx, l.symbol);
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
    await addInstrument(t.ctx, "U0");
    await addInstrument(t.ctx, "C0-USD");
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
      await addInstrument(t.ctx, symbol);
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
    await addInstrument(t.ctx, "VVSM.DE");
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
    await addInstrument(t.ctx, "U0");
    await addInstrument(t.ctx, "U1");
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

describe("bars at the session change", () => {
  async function weekend(edit: (nvda: any, now: number) => void = () => {}) {
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
      const answer = clone(fixtures[symbol]);
      if (monday) {
        const result = answer.body.chart.result[0];
        moveSession(result.meta, "2026-10-26T13:30", "2026-10-26T20:00", now);
        if (symbol === "NVDA") edit(result, now);
      }
      return answer;
    });
    await addInstrument(t.ctx, "NVDA");
    await addInstrument(t.ctx, "HYG");
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
    for (const l of listings) await addInstrument(t.ctx, l.symbol);
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
    expect(charts(urls)).toHaveLength(16);
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
    await addInstrument(t.ctx, "U0");
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
    const { rows } = await addInstrument(t.ctx, "NVDA");
    expect(rows).toBe(0);
    expect(readBars(t.db, "US:NVDA", "1d")).toEqual([]);
    await expect(t.jobs.backfillTurn()).rejects.toThrow("a history cut short");
    expect(lastRun(t.db, "yahoo", "backfill")).toMatchObject({
      status: "failed",
      error: "malformed answer",
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
    await addInstrument(t.ctx, "U0");
    await addInstrument(t.ctx, "U1");
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

describe("a simulated weekday", () => {
  // From Sunday evening to Tuesday 00:00 UTC, counting Monday's calls.
  async function monday(listings: SimListing[]) {
    const s = sim(listings);
    const t = setup(utc("2026-10-25T20:00"), (url, now) => s.route(url, now));
    for (const l of listings) await addInstrument(t.ctx, l.symbol);
    await t.runTo(utc("2026-10-26T00:00"));
    const before = t.f.urls.length;
    await t.runTo(utc("2026-10-27T00:00"));
    const urls = t.f.urls.slice(before);
    return { sparks: sparks(urls).length, charts: charts(urls).length };
  }

  test("one US and one Xetra instrument", async () => {
    // quote turns from 08:05 to 20:00 UTC, the 08:00 Xetra check and the
    // 20:15 US post-close batch; the 13:30 US check and the 16:45 Xetra
    // post-close batch ride turns. One refetch each.
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
