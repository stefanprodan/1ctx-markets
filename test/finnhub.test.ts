// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { start } from "../src/app.ts";
import { DAY_MS, MINUTE_MS } from "../src/clock.ts";
import { type Db, open } from "../src/db/index.ts";
import {
  finnhub,
  parseCalendar,
  parseEarnings,
  SPACING_MS,
} from "../src/finnhub/client.ts";
import { finnhubJobs, TICK_BUDGET_MS } from "../src/finnhub/jobs.ts";
import {
  type EventKey,
  eligible,
  eventStatus,
  type FinnhubContext,
  finnhubSymbol,
  nextEvent,
  pruneResearch,
  readEvents,
  readResearch,
  refreshResearch,
  STALE_RESEARCH,
  sectionState,
} from "../src/finnhub/store.ts";
import { type Instrument, upsertInstrument } from "../src/instruments.ts";
import { keys } from "../src/keys.ts";
import { format, logger, silent } from "../src/log.ts";
import { lastRun } from "../src/runs.ts";
import { SourceError } from "../src/source.ts";
import { markRead } from "../src/tracking.ts";
import { writer } from "../src/writer.ts";
import { fakeClock } from "./helpers/clock.ts";
import {
  drive,
  FINNHUB_KEY,
  finnhubAnswer,
  finnhubFixture,
} from "./helpers/finnhub.ts";
import { NOW } from "./helpers/sources.ts";
import { clone, fakeFetch, type Recorded } from "./helpers/yahoo.ts";

type Route = (url: URL) => Promise<Recorded | undefined> | Recorded | undefined;

function setup(options: { route?: Route; start?: number } = {}) {
  const clock = fakeClock(options.start ?? NOW);
  const { db } = open(":memory:", clock);
  const write = writer(db);
  // the fake clock's time at each call's start
  const starts: number[] = [];
  const f = fakeFetch(async (url) => {
    starts.push(clock.now());
    return (await options.route?.(url)) ?? finnhubAnswer(url);
  });
  const client = finnhub({ clock, key: FINNHUB_KEY, fetch: f.fetch });
  const ctx: FinnhubContext = { db, clock, writer: write, finnhub: client };
  return { clock, db, write, f, starts, client, ctx };
}

function share(
  db: Db,
  symbol: string,
  now: number,
  options: { market?: string; type?: string; read?: boolean } = {},
): Instrument {
  const market = options.market ?? "US";
  const i = upsertInstrument(
    db,
    {
      market,
      symbol,
      source: "yahoo",
      sourceSymbol: market === "US" ? symbol : `${symbol}.${market}`,
      exchange: market === "US" ? "NMS" : market,
      name: symbol,
      type: options.type ?? "EQUITY",
      currency: "USD",
      unit: "per_share",
      zone: "America/New_York",
    },
    now,
  );
  if (options.read !== false) markRead(db, [i.id], now);
  return i;
}

const count = (db: Db, sql: string, ...args: (string | number)[]) =>
  (db.query(sql).get(...args) as { n: number }).n;

// edits a recorded answer for one symbol and path
const edited =
  (path: string, symbol: string, edit: (body: any) => void): Route =>
  async (url) => {
    if (url.pathname !== path || url.searchParams.get("symbol") !== symbol) {
      return undefined;
    }
    const fx = clone((await finnhubAnswer(url))!);
    edit(fx.body);
    return fx;
  };

describe("finnhub answers", () => {
  test("NVDA parses in full, its repeated earnings period collapsed", async () => {
    const t = setup();
    const d = <T>(p: Promise<T>) => drive(t.clock, p);
    const metric = await d(t.client.metric("NVDA"));
    expect(metric.data).toMatchObject({
      forwardPE: 17.02191,
      forwardPEG: 0.3021,
      peTTM: 26.3592,
      psTTM: 16.781,
      pb: 22.203,
      epsGrowthTTMYoy: 125.15,
      revenueGrowthTTMYoy: 83.38,
      netMarginTTM: 63.66,
      roeTTM: 110.11,
      currentRatioQuarterly: 4.5889,
      debtToEquityQuarterly: 0.1457,
      dividendYieldTTM: 0.1333,
      beta: 2.269422,
    });
    const analysts = (await d(t.client.analysts("NVDA"))).data!;
    expect(analysts).toHaveLength(4);
    expect(analysts[0]).toEqual({
      period: "2026-10-01",
      strongBuy: 25,
      buy: 41,
      hold: 2,
      sell: 1,
      strongSell: 0,
    });
    const earnings = (await d(t.client.earnings("NVDA"))).data!;
    expect(earnings.map((e) => e.period)).toEqual([
      "2026-09-30",
      "2026-06-30",
      "2026-03-31",
    ]);
    const insider = (
      await d(t.client.insider("NVDA", "2025-10-25", "2026-10-25"))
    ).data!;
    expect(insider).toHaveLength(8);
    expect(insider[0]).toEqual({
      period: "2026-01-01",
      change: -527640,
      mspr: -100,
    });
    const calendar = (
      await d(t.client.calendar("NVDA", "2026-06-27", "2027-01-23"))
    ).data!;
    expect(calendar).toEqual([
      {
        fiscalYear: 2027,
        fiscalQuarter: 3,
        date: "2026-11-17",
        hour: "amc",
        epsEstimate: 2.5263,
        epsActual: null,
        revenueEstimate: 111356225808,
        revenueActual: null,
      },
    ]);
  });

  test.each([["VVSM.DE"], ["TLV.RO"]])(
    "%s is no data on every call, never an error",
    async (symbol) => {
      const t = setup();
      const answers = await drive(
        t.clock,
        Promise.all([
          t.client.metric(symbol),
          t.client.analysts(symbol),
          t.client.earnings(symbol),
          t.client.insider(symbol, "2025-10-25", "2026-10-25"),
          t.client.calendar(symbol, "2026-06-27", "2027-01-23"),
        ]),
      );
      for (const a of answers) expect(a.data).toBeNull();
    },
  );

  test("a malformed or conflicting answer is an error, never empty rows", async () => {
    const nvda = async (name: string) => (await finnhubFixture(name)).body;
    expect(() => parseEarnings({ not: "a list" }, "NVDA")).toThrow(
      "malformed answer",
    );
    const conflicting = clone(await nvda("earnings-nvda"));
    conflicting[2].actual = 1.9;
    expect(() => parseEarnings(conflicting, "NVDA")).toThrow(
      "2026-06-30 answered twice",
    );
    const other = clone(await nvda("calendar-earnings-nvda"));
    other.earningsCalendar[0].symbol = "AMD";
    expect(() => parseCalendar(other, "NVDA")).toThrow("another symbol");
    const t = setup({
      route: edited("/api/v1/stock/recommendation", "NVDA", (b) => {
        b[0].buy = "41";
      }),
    });
    await expect(t.client.analysts("NVDA")).rejects.toThrow("malformed answer");
  });

  test("the key goes only in its header, never in a URL or an error", async () => {
    const t = setup({
      route: (url) => {
        if (url.pathname.endsWith("/stock/earnings")) {
          throw new Error(`fetch failed for ${url} with ${FINNHUB_KEY}`);
        }
        return undefined;
      },
    });
    await t.client.metric("NVDA");
    const error = await drive(
      t.clock,
      t.client.earnings("NVDA").catch((e: unknown) => e),
    );
    expect(error).toBeInstanceOf(SourceError);
    expect(String(error)).toBe("SourceError: network error");
    for (const url of t.f.urls) expect(url.href).not.toContain(FINNHUB_KEY);
    for (const h of t.f.headers) {
      expect(h.get("x-finnhub-token")).toBe(FINNHUB_KEY);
    }
  });

  test("a 401 is a refused key and a 429 pauses the source", async () => {
    let status = 401;
    const t = setup({
      route: () => ({ recordedAt: "", status, headers: {}, body: {} }),
    });
    await expect(t.client.metric("NVDA")).rejects.toThrow("key refused");
    status = 429;
    await expect(drive(t.clock, t.client.analysts("NVDA"))).rejects.toThrow(
      "rate limited",
    );
    const asked = t.f.urls.length;
    // a tool fails at once while the source backs off, asking nothing
    await expect(t.client.failFast().earnings("NVDA")).rejects.toThrow(
      "rate limited",
    );
    expect(t.f.urls).toHaveLength(asked);
  });

  test("one limiter spaces every start 1.1 s apart, a job's and a tool's", async () => {
    const t = setup();
    const job = t.client;
    const tool = t.client.failFast();
    const all = Promise.all([
      job.metric("NVDA"),
      tool.analysts("NVDA"),
      job.earnings("NVDA"),
      tool.within(() => true).metric("NVDA"),
    ]);
    await drive(t.clock, all);
    expect(t.starts).toHaveLength(4);
    for (let k = 1; k < t.starts.length; k++) {
      expect(t.starts[k]! - t.starts[k - 1]!).toBeGreaterThanOrEqual(
        SPACING_MS,
      );
    }
  });

  test("a call waiting for its slot past its deadline never starts", async () => {
    const t = setup();
    await t.client.metric("NVDA");
    let live = true;
    const late = t.client.within(() => live).analysts("NVDA");
    live = false;
    await expect(drive(t.clock, late)).rejects.toThrow("deadline passed");
    expect(t.f.urls).toHaveLength(1);
  });
});

describe("eligibility", () => {
  test("only US shares are asked", () => {
    expect(eligible({ market: "US", type: "EQUITY" })).toBe(true);
    for (const [market, type] of [
      ["US", "ETF"],
      ["US", "INDEX"],
      ["US", "FUTURE"],
      ["CCY", "CURRENCY"],
      ["CRYPTO", "CRYPTOCURRENCY"],
      ["FRED", "SERIES"],
      ["XETRA", "EQUITY"],
      ["BVB", "EQUITY"],
    ]) {
      expect(eligible({ market: market!, type: type! })).toBe(false);
    }
    expect(finnhubSymbol({ symbol: "BRK-B" })).toBe("BRK.B");
  });
});

describe("research rows", () => {
  test("NVDA's five sections land with a run each", async () => {
    const t = setup();
    const nvda = share(t.db, "NVDA", NOW);
    const results = await drive(t.clock, refreshResearch(t.ctx, nvda));
    expect(results.map((r) => [r.section, r.status])).toEqual([
      ["metric", "ok"],
      ["analysts", "ok"],
      ["earnings", "ok"],
      ["insider", "ok"],
      ["calendar", "ok"],
    ]);
    expect(t.f.urls.map((u) => u.pathname)).toEqual([
      "/api/v1/stock/metric",
      "/api/v1/stock/recommendation",
      "/api/v1/stock/earnings",
      "/api/v1/stock/insider-sentiment",
      "/api/v1/calendar/earnings",
    ]);
    // insider from 12 months back, the calendar 120 days back to 90 ahead
    expect(t.f.urls[3]!.searchParams.get("from")).toBe("2025-10-25");
    expect(t.f.urls[4]!.searchParams.get("from")).toBe("2026-06-27");
    expect(t.f.urls[4]!.searchParams.get("to")).toBe("2027-01-23");
    expect(readResearch(t.db, nvda.id, "metric")).toHaveLength(1);
    expect(readResearch(t.db, nvda.id, "analysts")).toHaveLength(4);
    expect(
      readResearch(t.db, nvda.id, "earnings").map((r) => r.period),
    ).toEqual(["2026-09-30", "2026-06-30", "2026-03-31"]);
    expect(readResearch(t.db, nvda.id, "insider")).toHaveLength(8);
    expect(readEvents(t.db, "2026-01-01", "2027-12-31")).toHaveLength(1);
    for (const s of ["metric", "analysts", "earnings", "insider", "calendar"]) {
      expect(lastRun(t.db, "finnhub", s, nvda.id)?.status).toBe("ok");
    }
    // a second fetch replaces the one metric row
    await drive(t.clock, refreshResearch(t.ctx, nvda, ["metric"]));
    expect(readResearch(t.db, nvda.id, "metric")).toHaveLength(1);
  });

  test("no data for one share neither errs nor blanks another's rows", async () => {
    let refused = false;
    const t = setup({
      route: (url) =>
        refused && url.searchParams.get("symbol") === "NVDA"
          ? { recordedAt: "", status: 403, headers: {}, body: {} }
          : undefined,
    });
    const nvda = share(t.db, "NVDA", NOW);
    const none = share(t.db, "REFUSED", NOW);
    const empty = share(t.db, "EMPTY", NOW);
    await drive(t.clock, refreshResearch(t.ctx, nvda));
    for (const i of [none, empty]) {
      const results = await drive(t.clock, refreshResearch(t.ctx, i));
      expect(results.every((r) => r.status === "ok" && r.rows === 0)).toBe(
        true,
      );
      const state = sectionState(t.db, i.id, "analysts", t.clock.now());
      expect(state).toMatchObject({ noData: true, stale: [] });
    }
    const before = count(
      t.db,
      "select count(*) as n from research where instrument = ?",
      nvda.id,
    );
    refused = true;
    await drive(t.clock, refreshResearch(t.ctx, nvda));
    expect(
      count(
        t.db,
        "select count(*) as n from research where instrument = ?",
        nvda.id,
      ),
    ).toBe(before);
  });

  test("a conflicting earnings period refuses that section only", async () => {
    const t = setup({
      route: edited("/api/v1/stock/earnings", "NVDA", (b) => {
        b[2].actual = 1.9;
      }),
    });
    const nvda = share(t.db, "NVDA", NOW);
    const results = await drive(t.clock, refreshResearch(t.ctx, nvda));
    expect(results.find((r) => r.section === "earnings")?.status).toBe(
      "failed",
    );
    expect(lastRun(t.db, "finnhub", "earnings", nvda.id)?.error).toBe(
      "malformed answer",
    );
    expect(readResearch(t.db, nvda.id, "earnings")).toEqual([]);
    const now = t.clock.now();
    expect(sectionState(t.db, nvda.id, "earnings", now).stale).toEqual([
      STALE_RESEARCH.none,
      STALE_RESEARCH.failed,
    ]);
    expect(sectionState(t.db, nvda.id, "metric", now).stale).toEqual([]);
  });
});

describe("earnings events", () => {
  const calendar = "/api/v1/calendar/earnings";

  test("keyed by fiscal quarter: a moved date updates the one event, only actuals report it", async () => {
    let edit: (row: any) => void = () => {};
    const t = setup({
      route: edited(calendar, "NVDA", (b) => edit(b.earningsCalendar[0])),
    });
    const reported: EventKey[][] = [];
    const hooks = {
      waited: () => [],
      reported: (_: Db, keys: readonly EventKey[]) => {
        reported.push([...keys]);
      },
    };
    const nvda = share(t.db, "NVDA", NOW);
    const refresh = () =>
      drive(t.clock, refreshResearch(t.ctx, nvda, ["calendar"], { hooks }));
    const event = () => readEvents(t.db, "2026-01-01", "2027-12-31");
    await refresh();
    expect(event()).toHaveLength(1);
    expect(eventStatus(event()[0]!, "2026-10-25")).toBe("scheduled");

    edit = (row) => {
      row.date = "2026-11-19";
    };
    await refresh();
    expect(event()).toHaveLength(1);
    expect(event()[0]).toMatchObject({
      fiscalYear: 2027,
      fiscalQuarter: 3,
      date: "2026-11-19",
      hour: "amc",
      reportedSeenAt: null,
    });
    // the date came and the label says after close: still no results
    expect(eventStatus(event()[0]!, "2026-11-19")).toBe("awaiting results");
    expect(eventStatus(event()[0]!, "2026-11-20")).toBe("awaiting results");

    edit = (row) => {
      row.date = "2026-11-19";
      row.epsActual = 0;
    };
    await refresh();
    const seen = t.clock.now();
    expect(event()[0]).toMatchObject({ epsActual: 0 });
    const seenAt = event()[0]!.reportedSeenAt;
    expect(seenAt).not.toBeNull();
    expect(seenAt!).toBeLessThanOrEqual(seen);
    expect(eventStatus(event()[0]!, "2026-11-19")).toBe("reported");
    expect(reported).toEqual([
      [{ instrument: nvda.id, fiscalYear: 2027, fiscalQuarter: 3 }],
    ]);

    // a later answer missing the actuals keeps them and when they were seen
    edit = (row) => {
      row.date = "2026-11-19";
    };
    await refresh();
    expect(event()[0]).toMatchObject({ epsActual: 0, reportedSeenAt: seenAt });
    expect(reported).toHaveLength(1);
  });

  test("the next event is the earliest from today, or one awaiting results", async () => {
    const t = setup();
    const nvda = share(t.db, "NVDA", NOW);
    await drive(t.clock, refreshResearch(t.ctx, nvda, ["calendar"]));
    expect(nextEvent(t.db, nvda, NOW)?.date).toBe("2026-11-17");
    expect(
      nextEvent(t.db, nvda, Date.parse("2026-11-20T15:00:00Z"))?.date,
    ).toBe("2026-11-17");
    expect(
      nextEvent(t.db, nvda, Date.parse("2026-12-01T15:00:00Z")),
    ).toBeNull();
  });

  test("retention drops rows past 24 months, keeping the metric and waited events", async () => {
    const t = setup();
    const nvda = share(t.db, "NVDA", NOW);
    await drive(t.clock, refreshResearch(t.ctx, nvda));
    const later = Date.parse("2028-10-15T12:00:00Z");
    const insert = t.db.query(
      `insert into events (instrument, fiscal_year, fiscal_quarter, date, hour,
         fetched_at) values (?, ?, ?, ?, '', ?)`,
    );
    insert.run(nvda.id, 2026, 1, "2026-05-01", NOW);
    insert.run(nvda.id, 2026, 2, "2026-08-01", NOW);
    pruneResearch(t.db, later, [
      { instrument: nvda.id, fiscalYear: 2026, fiscalQuarter: 2 },
    ]);
    expect(readResearch(t.db, nvda.id, "metric")).toHaveLength(1);
    // 24 months before 2028-10-15
    for (const kind of ["analysts", "earnings", "insider"] as const) {
      for (const r of readResearch(t.db, nvda.id, kind)) {
        expect(r.period >= "2026-10-15").toBe(true);
      }
    }
    expect(readResearch(t.db, nvda.id, "analysts")).toEqual([]);
    expect(readResearch(t.db, nvda.id, "insider")).toEqual([]);
    expect(
      readEvents(t.db, "2000-01-01", "2100-01-01").map(
        (e) => `${e.fiscalYear}Q${e.fiscalQuarter}`,
      ),
    ).toEqual(["2026Q2", "2027Q3"]);
  });
});

describe("the daily job", () => {
  test("asks each tracked US share's five sections once a day, nothing else", async () => {
    const t = setup();
    for (const s of ["NVDA", "REFUSED", "EMPTY"]) share(t.db, s, NOW);
    share(t.db, "QQQ", NOW, { type: "ETF" });
    share(t.db, "VVSM", NOW, { market: "XETRA" });
    share(t.db, "OLD", NOW - 40 * DAY_MS, { read: true });
    const jobs = finnhubJobs({ ctx: t.ctx, log: silent });
    const first = await drive(t.clock, jobs.tick());
    expect(first.asked.map((a) => a.instrument).sort()).toEqual([
      "US:EMPTY",
      "US:NVDA",
      "US:REFUSED",
    ]);
    expect(first.failed).toEqual([]);
    expect(t.f.urls).toHaveLength(15);
    const symbols = new Set(t.f.urls.map((u) => u.searchParams.get("symbol")));
    expect([...symbols].sort()).toEqual(["EMPTY", "NVDA", "REFUSED"]);
    // the same day, nothing is due
    await t.clock.advance(MINUTE_MS);
    expect((await jobs.tick()).asked).toEqual([]);
    // after the next 23:00 UTC, all again
    await t.clock.advance(2 * 60 * MINUTE_MS);
    const next = await drive(t.clock, jobs.tick());
    expect(next.asked).toHaveLength(3);
    expect(t.f.urls).toHaveLength(30);
  });

  test("a run past its tick's budget stays under 60 calls a minute and finishes on the next tick", async () => {
    const t = setup();
    const names = Array.from({ length: 12 }, (_, k) => `ZZ${k}`);
    for (const s of names) share(t.db, s, NOW);
    const jobs = finnhubJobs({ ctx: t.ctx, log: silent });
    const first = await drive(t.clock, jobs.tick());
    expect(first.asked.length).toBeLessThan(12);
    expect(t.clock.now() - NOW).toBeLessThan(TICK_BUDGET_MS + 10_000);
    await t.clock.advance(MINUTE_MS);
    const second = await drive(t.clock, jobs.tick());
    expect(first.asked.length + second.asked.length).toBe(12);
    expect(t.starts).toHaveLength(60);
    for (const at of t.starts) {
      const window = t.starts.filter((s) => s >= at && s < at + MINUTE_MS);
      expect(window.length).toBeLessThanOrEqual(60);
    }
    for (let k = 1; k < t.starts.length; k++) {
      expect(t.starts[k]! - t.starts[k - 1]!).toBeGreaterThanOrEqual(
        SPACING_MS,
      );
    }
  });

  test("a failed section is stale alone and asked again after an hour", async () => {
    let conflicting = true;
    const t = setup({
      route: async (url) =>
        conflicting
          ? edited("/api/v1/stock/earnings", "NVDA", (b) => {
              b[2].actual = 1.9;
            })(url)
          : undefined,
    });
    const nvda = share(t.db, "NVDA", NOW);
    const lines: string[] = [];
    const jobs = finnhubJobs({
      ctx: t.ctx,
      log: logger(
        t.clock,
        () => [FINNHUB_KEY],
        (l) => lines.push(l),
      )("finnhub"),
    });
    const first = await drive(t.clock, jobs.tick());
    expect(first.failed).toEqual([
      { instrument: nvda.id, section: "earnings", error: "malformed answer" },
    ]);
    const now = t.clock.now();
    expect(sectionState(t.db, nvda.id, "earnings", now).stale).toContain(
      STALE_RESEARCH.failed,
    );
    for (const s of ["metric", "analysts", "insider", "calendar"] as const) {
      expect(sectionState(t.db, nvda.id, s, now).stale).toEqual([]);
    }
    await t.clock.advance(30 * MINUTE_MS);
    expect((await jobs.tick()).asked).toEqual([]);
    conflicting = false;
    await t.clock.advance(31 * MINUTE_MS);
    const retry = await drive(t.clock, jobs.tick());
    expect(retry.asked).toEqual([
      { instrument: nvda.id, sections: ["earnings"] },
    ]);
    expect(
      sectionState(t.db, nvda.id, "earnings", t.clock.now()).stale,
    ).toEqual([]);
    expect(lines.some((l) => l.includes("finnhub section failed"))).toBe(true);
    for (const l of lines) expect(l).not.toContain(FINNHUB_KEY);
  });

  test("a waited event's calendar is asked hourly on its date until reported", async () => {
    let actual: number | null = null;
    const t = setup({
      route: edited("/api/v1/calendar/earnings", "NVDA", (b) => {
        b.earningsCalendar[0].epsActual = actual;
      }),
    });
    const nvda = share(t.db, "NVDA", NOW);
    const key = { instrument: nvda.id, fiscalYear: 2027, fiscalQuarter: 3 };
    let seen = 0;
    const jobs = finnhubJobs({
      ctx: t.ctx,
      log: silent,
      hooks: {
        waited: () => [key],
        reported: () => {
          seen++;
        },
      },
    });
    await drive(t.clock, jobs.tick());
    const calendars = () =>
      t.f.urls.filter((u) => u.pathname.endsWith("/calendar/earnings")).length;
    expect(calendars()).toBe(1);
    // on its date, past the day's refresh
    await t.clock.advance(Date.parse("2026-11-17T14:00:00Z") - t.clock.now());
    await drive(t.clock, jobs.tick());
    expect(calendars()).toBe(2);
    await t.clock.advance(30 * MINUTE_MS);
    await jobs.tick();
    expect(calendars()).toBe(2);
    await t.clock.advance(31 * MINUTE_MS);
    await drive(t.clock, jobs.tick());
    expect(calendars()).toBe(3);
    actual = 2.61;
    await t.clock.advance(61 * MINUTE_MS);
    await drive(t.clock, jobs.tick());
    expect(calendars()).toBe(4);
    expect(seen).toBe(1);
    // reported: no more hourly asks
    await t.clock.advance(61 * MINUTE_MS);
    await jobs.tick();
    expect(calendars()).toBe(4);
  });
});

describe("finnhub source", () => {
  const app = (dir: string, lines: string[] = []) => {
    const store = keys(dir);
    const clock = fakeClock(NOW);
    const { db } = open(":memory:", clock);
    const a = start({
      hostname: "127.0.0.1",
      port: 0,
      bearer: "b".repeat(32),
      clock,
      log: logger(clock, store.values, (l) => lines.push(l)),
      version: "v0.0.0-test",
      db,
      quoteEveryMs: 5 * MINUTE_MS,
      finnhubKey: store.source("finnhub"),
      fetch: async (url) => {
        throw new Error(`no network in tests: ${url}`);
      },
    });
    return { a, db, clock };
  };

  test("off without a key file, and the start log says so", async () => {
    const { a, db } = app(mkdtempSync(join(tmpdir(), "finnhub-off-")));
    try {
      expect(a.finnhub).toBeNull();
      expect(a.finnhubJobs).toBeNull();
      expect(format(0, "markets", "info", "sources", a.sources)).toContain(
        'finnhub="off (no key)"',
      );
    } finally {
      await a.stop();
      db.close();
    }
  });

  test("on with a key file; the key never reaches a log line or a row", async () => {
    const dir = mkdtempSync(join(tmpdir(), "finnhub-on-"));
    writeFileSync(join(dir, "source-finnhub.key"), `${FINNHUB_KEY}\n`);
    const lines: string[] = [];
    const { a, db, clock } = app(dir, lines);
    try {
      expect(a.finnhub).not.toBeNull();
      expect(format(0, "markets", "info", "sources", a.sources)).toContain(
        'finnhub="on (key file)"',
      );
      await a.writer.write((db) => share(db, "NVDA", clock.now()));
      // every call fails with an error quoting the key
      const pass = await drive(clock, a.finnhubJobs!.tick());
      expect(pass.failed).toHaveLength(5);
      for (const f of pass.failed) expect(f.error).toBe("network error");
      expect(lines.length).toBeGreaterThan(0);
      for (const l of lines) expect(l).not.toContain(FINNHUB_KEY);
      for (const table of ["sync_runs", "research", "events"]) {
        const rows = JSON.stringify(db.query(`select * from ${table}`).all());
        expect(rows).not.toContain(FINNHUB_KEY);
      }
    } finally {
      await a.stop();
      db.close();
    }
  });
});
