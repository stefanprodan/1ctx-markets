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
  parseAnalysts,
  parseCalendar,
  parseEarnings,
  parseMarketCalendar,
  SPACING_MS,
} from "../src/finnhub/client.ts";
import { finnhubJobs, RETRY_MS, TICK_BUDGET_MS } from "../src/finnhub/jobs.ts";
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
  SECTIONS,
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
import { drive } from "./helpers/drive.ts";
import {
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
    const d = <T>(p: Promise<T>) => drive(t.clock, t.client, p);
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
        reported: false,
      },
    ]);
  });

  test.each([["VVSM.DE"], ["TLV.RO"]])(
    "%s is no data on every call, never an error",
    async (symbol) => {
      const t = setup();
      const answers = await drive(
        t.clock,
        t.client,
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

  test("a malformed or conflicting answer is an error, mixed symbols no data", async () => {
    const nvda = async (name: string) => (await finnhubFixture(name)).body;
    expect(() => parseEarnings({ not: "a list" }, "NVDA")).toThrow(
      "malformed answer",
    );
    const conflicting = clone(await nvda("earnings-nvda"));
    conflicting[2].actual = 1.9;
    expect(() => parseEarnings(conflicting, "NVDA")).toThrow(
      "2026-06-30 answered twice",
    );
    const none = { data: null, listing: null };
    // the asked symbol beside another, and two others
    const row = clone(await nvda("earnings-nvda"));
    row[1].symbol = "AMD";
    expect(parseEarnings(row, "NVDA")).toEqual(none);
    const two = clone(await nvda("recommendation-nvda"));
    two[0].symbol = "AMD";
    for (const r of two.slice(1)) r.symbol = "INTC";
    expect(parseAnalysts(two, "NVDA")).toEqual(none);
    // a part naming no symbol is the asked one's
    const unnamed = clone(await nvda("recommendation-nvda"));
    for (const r of unnamed) r.symbol = "AMD";
    delete unnamed[1].symbol;
    expect(parseAnalysts(unnamed, "NVDA")).toEqual(none);
    for (const odd of ["AMD US", "", "A".repeat(21), 7]) {
      const other = clone(await nvda("calendar-earnings-nvda"));
      other.earningsCalendar[0].symbol = odd;
      expect(() => parseCalendar(other, "NVDA")).toThrow("malformed answer");
    }
    const t = setup({
      route: edited("/api/v1/stock/recommendation", "NVDA", (b) => {
        b[0].buy = "41";
      }),
    });
    await expect(t.client.analysts("NVDA")).rejects.toThrow("malformed answer");
  });

  test("the whole-market calendar parses every row, by symbol, each its own listing's", async () => {
    for (const [name, rows] of [
      ["calendar-earnings-two-days", 285],
      ["calendar-earnings-week", 934],
    ] as const) {
      const fx = await finnhubFixture(name);
      const parsed = parseMarketCalendar(fx.body);
      expect(parsed.listing).toBeNull();
      const all = [...parsed.data!.values()].flat();
      expect(all).toHaveLength(rows);
      expect(parsed.data!.get("HOOD")).toEqual([
        {
          fiscalYear: 2026,
          fiscalQuarter: 3,
          date: "2026-10-27",
          hour: "amc",
          epsEstimate: 0.5684,
          epsActual: null,
          revenueEstimate: 1450566571,
          revenueActual: null,
          reported: false,
        },
      ]);
    }
    // a class share keeps Finnhub's dotted symbol
    const week = parseMarketCalendar(
      (await finnhubFixture("calendar-earnings-week")).body,
    );
    expect(week.data!.has("MOG.A")).toBe(true);
    // a malformed envelope is an error; a symbol's bad row drops it alone
    expect(() => parseMarketCalendar({})).toThrow("malformed answer");
    const fx = clone(await finnhubFixture("calendar-earnings-two-days"));
    fx.body.earningsCalendar.find((r: any) => r.symbol === "HOOD").quarter = 7;
    const parsed = parseMarketCalendar(fx.body);
    expect(parsed.data!.has("HOOD")).toBe(false);
    expect(parsed.data!.size).toBeGreaterThan(200);
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
      t.client,
      t.client.earnings("NVDA").catch((e: unknown) => e),
    );
    expect(error).toBeInstanceOf(SourceError);
    expect(String(error)).toBe("SourceError: network error");
    for (const url of t.f.urls) expect(url.href).not.toContain(FINNHUB_KEY);
    for (const h of t.f.headers) {
      expect(h.get("x-finnhub-token")).toBe(FINNHUB_KEY);
    }
  });

  test("an answer of an odd shape fails alone; one not JSON pauses the source", async () => {
    let body: unknown = { not: "a list" };
    const t = setup({
      route: (url) =>
        url.pathname.endsWith("/stock/recommendation")
          ? { recordedAt: "", status: 200, headers: {}, body }
          : undefined,
    });
    await expect(
      drive(t.clock, t.client, t.client.analysts("NVDA")),
    ).rejects.toThrow("malformed answer");
    // the next call starts at its spacing, not after a back-off
    await drive(t.clock, t.client, t.client.failFast().metric("NVDA"));
    expect(t.starts).toEqual([NOW, NOW + SPACING_MS]);
    body = "<html>consent</html>";
    await expect(
      drive(t.clock, t.client, t.client.analysts("NVDA")),
    ).rejects.toThrow("malformed answer");
    const asked = t.f.urls.length;
    await expect(t.client.failFast().metric("NVDA")).rejects.toThrow(
      "backing off",
    );
    expect(t.f.urls).toHaveLength(asked);
  });

  test("a 401 is a refused key and a 429 pauses the source", async () => {
    let status = 401;
    const t = setup({
      route: () => ({ recordedAt: "", status, headers: {}, body: {} }),
    });
    await expect(t.client.metric("NVDA")).rejects.toThrow("key refused");
    status = 429;
    await expect(
      drive(t.clock, t.client, t.client.analysts("NVDA")),
    ).rejects.toThrow("rate limited");
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
    await drive(t.clock, t.client, all);
    expect(t.starts).toHaveLength(4);
    for (let k = 1; k < t.starts.length; k++) {
      expect(t.starts[k]! - t.starts[k - 1]!).toBeGreaterThanOrEqual(
        SPACING_MS,
      );
    }
  });

  test("driving the clock moves it only to the limiter's due times, never under a slow call", async () => {
    // each answer takes many event-loop turns, as on a slow machine
    const t = setup({
      route: async () => {
        for (let k = 0; k < 5_000; k++) {
          await new Promise<void>((resolve) => setImmediate(resolve));
        }
        return undefined;
      },
    });
    const [metric, analysts] = await drive(
      t.clock,
      t.client,
      Promise.all([t.client.metric("NVDA"), t.client.analysts("NVDA")]),
    );
    // neither call's 30 s timeout fired while it ran
    expect(metric.data).not.toBeNull();
    expect(analysts.data).not.toBeNull();
    expect(t.starts).toEqual([NOW, NOW + SPACING_MS]);
    expect(t.clock.now()).toBe(NOW + SPACING_MS);
  });

  test("a call dropped past its deadline leaves its slot to the next", async () => {
    const t = setup();
    await t.client.metric("NVDA");
    // its deadline passes while it waits for its slot
    const late = t.client
      .within(() => t.clock.now() < NOW + SPACING_MS / 2)
      .analysts("NVDA");
    const next = t.client.earnings("NVDA");
    const [dropped, asked] = await drive(
      t.clock,
      t.client,
      Promise.allSettled([late, next]),
    );
    expect(dropped.status).toBe("rejected");
    expect(asked.status).toBe("fulfilled");
    // the next call starts in the dropped one's slot, not one later
    expect(t.starts).toEqual([NOW, NOW + SPACING_MS]);
  });

  test("a call waiting for its slot past its deadline never starts", async () => {
    const t = setup();
    await t.client.metric("NVDA");
    let live = true;
    const late = t.client.within(() => live).analysts("NVDA");
    live = false;
    await expect(drive(t.clock, t.client, late)).rejects.toThrow(
      "deadline passed",
    );
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
    const results = await drive(
      t.clock,
      t.client,
      refreshResearch(t.ctx, nvda),
    );
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
    await drive(t.clock, t.client, refreshResearch(t.ctx, nvda, ["metric"]));
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
    await drive(t.clock, t.client, refreshResearch(t.ctx, nvda));
    for (const i of [none, empty]) {
      const results = await drive(t.clock, t.client, refreshResearch(t.ctx, i));
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
    await drive(t.clock, t.client, refreshResearch(t.ctx, nvda));
    expect(
      count(
        t.db,
        "select count(*) as n from research where instrument = ?",
        nvda.id,
      ),
    ).toBe(before);
  });

  test("an ADR answered as its home listing keeps what holds for any listing", async () => {
    const t = setup();
    const tsm = share(t.db, "TSM", NOW);
    const nvda = share(t.db, "NVDA", NOW);
    const reported: EventKey[][] = [];
    const hooks = {
      waited: () => [],
      reported: (_: Db, keys: readonly EventKey[]) => {
        reported.push([...keys]);
      },
    };
    const results = await drive(
      t.clock,
      t.client,
      refreshResearch(t.ctx, tsm, undefined, { hooks }),
    );
    expect(
      results.map((r) => [r.section, r.status === "ok" ? r.rows : r.status]),
    ).toEqual([
      ["metric", 1],
      ["analysts", 4],
      ["earnings", 0],
      ["insider", 8],
      ["calendar", 2],
    ]);
    const [metric] = readResearch(t.db, tsm.id, "metric");
    expect(metric).toMatchObject({
      listing: "2330.TW",
      eps_growth_ttm_yoy: 60.55,
      revenue_growth_ttm_yoy: 36.17,
      net_margin_ttm: 51.53,
      roe_ttm: 41.19,
      current_ratio_quarterly: 2.5841,
      debt_to_equity_quarterly: 0.1405,
      forward_pe: null,
      forward_peg: null,
      pe_ttm: null,
      ps_ttm: null,
      pb: null,
      dividend_yield_ttm: null,
      beta: null,
    });
    const analysts = readResearch(t.db, tsm.id, "analysts");
    expect(analysts).toHaveLength(4);
    expect(analysts[0]).toMatchObject({
      period: "2026-10-01",
      listing: "2330.TW",
      strong_buy: 12,
      buy: 28,
      hold: 2,
    });
    expect(readResearch(t.db, tsm.id, "earnings")).toEqual([]);
    expect(sectionState(t.db, tsm.id, "earnings", t.clock.now()).noData).toBe(
      true,
    );
    // TSM's insider answer names TSM: its own
    const insider = readResearch(t.db, tsm.id, "insider");
    expect(insider).toHaveLength(8);
    expect(insider.every((r) => r.listing === null)).toBe(true);
    const events = readEvents(t.db, "2000-01-01", "2100-01-01");
    expect(events).toMatchObject([
      {
        fiscalYear: 2026,
        fiscalQuarter: 3,
        date: "2026-10-15",
        hour: "bmo",
        listing: "2330.TW",
        epsEstimate: null,
        epsActual: null,
        revenueEstimate: null,
        revenueActual: null,
      },
      {
        fiscalYear: 2026,
        fiscalQuarter: 4,
        date: "2027-01-13",
        listing: "2330.TW",
        epsEstimate: null,
        reportedSeenAt: null,
      },
    ]);
    // reported from actuals it does not store
    expect(events[0]!.reportedSeenAt).not.toBeNull();
    expect(eventStatus(events[0]!, "2026-10-26")).toBe("reported");
    expect(eventStatus(events[1]!, "2026-10-26")).toBe("scheduled");
    expect(eventStatus(events[1]!, "2027-01-13")).toBe("awaiting results");
    expect(reported).toEqual([
      [{ instrument: tsm.id, fiscalYear: 2026, fiscalQuarter: 3 }],
    ]);
    await drive(t.clock, t.client, refreshResearch(t.ctx, nvda, ["metric"]));
    expect(t.starts[5]! - t.starts[4]!).toBe(SPACING_MS);
  });

  test("rows of another listing replace the share's own, and the reverse", async () => {
    let home = true;
    // NVDA answered as if by another listing, then by its own again
    const t = setup({
      route: async (url) => {
        if (!home || url.searchParams.get("symbol") !== "NVDA") return;
        const fx = clone((await finnhubAnswer(url))!);
        const b = fx.body;
        const parts = Array.isArray(b) ? b : [b, ...(b.earningsCalendar ?? [])];
        for (const part of parts) part.symbol = "NVDA.XX";
        return fx;
      },
    });
    const nvda = share(t.db, "NVDA", NOW);
    const held: EventKey = {
      instrument: nvda.id,
      fiscalYear: 2026,
      fiscalQuarter: 2,
    };
    const hooks = { waited: () => [held] };
    // rows stored as the share's own, as before listings were told apart
    const insert = t.db.query(
      `insert into research (instrument, kind, period, eps_actual, fetched_at)
       values (?, 'earnings', ?, 100, ?)`,
    );
    insert.run(nvda.id, "2025-03-31", NOW);
    t.db
      .query(
        `insert into research (instrument, kind, period, buy, fetched_at)
         values (?, 'analysts', '2025-01-01', 9, ?)`,
      )
      .run(nvda.id, NOW);
    const event = t.db.query(
      `insert into events (instrument, fiscal_year, fiscal_quarter, date, hour,
         eps_actual, reported_seen_at, fetched_at)
       values (?, ?, ?, ?, '', 1, ?, ?)`,
    );
    event.run(nvda.id, 2026, 1, "2026-05-20", NOW, NOW);
    event.run(nvda.id, 2026, 2, "2026-08-20", NOW, NOW);
    const all = ["metric", "analysts", "earnings", "calendar"] as const;
    await drive(
      t.clock,
      t.client,
      refreshResearch(t.ctx, nvda, all, { hooks }),
    );
    const listings = (kind: "metric" | "analysts" | "earnings") =>
      readResearch(t.db, nvda.id, kind).map((r) => r.listing);
    expect(listings("metric")).toEqual(["NVDA.XX"]);
    expect(listings("analysts")).toEqual(Array(4).fill("NVDA.XX"));
    expect(listings("earnings")).toEqual([]);
    const events = () =>
      readEvents(t.db, "2000-01-01", "2100-01-01").map((e) => ({
        q: `${e.fiscalYear} Q${e.fiscalQuarter}`,
        listing: e.listing,
        epsActual: e.epsActual,
      }));
    // the waited event stays as it was
    expect(events()).toEqual([
      { q: "2026 Q2", listing: null, epsActual: 1 },
      { q: "2027 Q3", listing: "NVDA.XX", epsActual: null },
    ]);
    home = false;
    await drive(
      t.clock,
      t.client,
      refreshResearch(t.ctx, nvda, all, { hooks }),
    );
    expect(listings("metric")).toEqual([null]);
    expect(listings("analysts")).toEqual(Array(4).fill(null));
    expect(listings("earnings")).toEqual(Array(3).fill(null));
    expect(events()).toEqual([
      { q: "2026 Q2", listing: null, epsActual: 1 },
      { q: "2027 Q3", listing: null, epsActual: null },
    ]);
  });

  test("the share's own actuals replace an event of another listing", async () => {
    const t = setup({
      route: edited("/api/v1/calendar/earnings", "NVDA", (b) => {
        for (const r of b.earningsCalendar) {
          r.epsActual = 1.5;
          r.revenueActual = 1e10;
        }
      }),
    });
    const nvda = share(t.db, "NVDA", NOW);
    t.db
      .query(
        `insert into events (instrument, fiscal_year, fiscal_quarter, date,
           hour, reported_seen_at, listing, fetched_at)
         values (?, 2027, 3, '2026-11-17', '', ?, 'NVDA.XX', ?)`,
      )
      .run(nvda.id, NOW, NOW);
    await drive(t.clock, t.client, refreshResearch(t.ctx, nvda, ["calendar"]));
    expect(readEvents(t.db, "2000-01-01", "2100-01-01")).toMatchObject([
      {
        fiscalYear: 2027,
        fiscalQuarter: 3,
        listing: null,
        epsActual: 1.5,
        revenueActual: 1e10,
        reportedSeenAt: NOW,
      },
    ]);
  });

  test("a symbol of null is a malformed answer", () => {
    expect(() =>
      parseAnalysts(
        [
          {
            symbol: null,
            period: "2026-10-01",
            strongBuy: 1,
            buy: 1,
            hold: 0,
            sell: 0,
            strongSell: 0,
          },
        ],
        "NVDA",
      ),
    ).toThrow("malformed answer");
  });

  test("a later answer leaving out an earnings actual keeps it", async () => {
    let drop = false;
    const t = setup({
      route: edited("/api/v1/stock/earnings", "NVDA", (b) => {
        if (drop) for (const r of b) r.actual = r.surprise = null;
      }),
    });
    const nvda = share(t.db, "NVDA", NOW);
    await drive(t.clock, t.client, refreshResearch(t.ctx, nvda, ["earnings"]));
    const before = readResearch(t.db, nvda.id, "earnings")[0]!;
    expect(before.eps_actual).toBe(2.22);
    drop = true;
    await drive(t.clock, t.client, refreshResearch(t.ctx, nvda, ["earnings"]));
    const after = readResearch(t.db, nvda.id, "earnings")[0]!;
    expect(after).toMatchObject({
      eps_actual: 2.22,
      surprise: before.surprise,
      eps_estimate: before.eps_estimate,
    });
  });

  test("rows kept from an earlier answer say the last one had no data", async () => {
    let refused = false;
    const t = setup({
      route: (url) =>
        refused && url.pathname.endsWith("/stock/recommendation")
          ? { recordedAt: "", status: 403, headers: {}, body: {} }
          : undefined,
    });
    const nvda = share(t.db, "NVDA", NOW);
    await drive(t.clock, t.client, refreshResearch(t.ctx, nvda, ["analysts"]));
    expect(
      sectionState(t.db, nvda.id, "analysts", t.clock.now()).stale,
    ).toEqual([]);
    refused = true;
    await drive(t.clock, t.client, refreshResearch(t.ctx, nvda, ["analysts"]));
    expect(readResearch(t.db, nvda.id, "analysts")).toHaveLength(4);
    expect(
      sectionState(t.db, nvda.id, "analysts", t.clock.now()),
    ).toMatchObject({ noData: true, stale: [STALE_RESEARCH.noData] });
    // a share that never had rows answers no data with no such reason
    const none = share(t.db, "EMPTY", NOW);
    await drive(t.clock, t.client, refreshResearch(t.ctx, none, ["analysts"]));
    expect(
      sectionState(t.db, none.id, "analysts", t.clock.now()).stale,
    ).toEqual([]);
  });

  test("a conflicting earnings period refuses that section only", async () => {
    const t = setup({
      route: edited("/api/v1/stock/earnings", "NVDA", (b) => {
        b[2].actual = 1.9;
      }),
    });
    const nvda = share(t.db, "NVDA", NOW);
    const results = await drive(
      t.clock,
      t.client,
      refreshResearch(t.ctx, nvda),
    );
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
      drive(
        t.clock,
        t.client,
        refreshResearch(t.ctx, nvda, ["calendar"], { hooks }),
      );
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
    await drive(t.clock, t.client, refreshResearch(t.ctx, nvda, ["calendar"]));
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
    await drive(t.clock, t.client, refreshResearch(t.ctx, nvda));
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
    const first = await drive(t.clock, t.client, jobs.tick());
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
    const next = await drive(t.clock, t.client, jobs.tick());
    expect(next.asked).toHaveLength(3);
    expect(t.f.urls).toHaveLength(30);
  });

  test("a run past its tick's budget stays under 60 calls a minute and finishes on the next tick", async () => {
    const t = setup();
    const names = Array.from({ length: 12 }, (_, k) => `ZZ${k}`);
    for (const s of names) share(t.db, s, NOW);
    const jobs = finnhubJobs({ ctx: t.ctx, log: silent });
    const first = await drive(t.clock, t.client, jobs.tick());
    expect(first.asked.length).toBeLessThan(12);
    expect(t.clock.now() - NOW).toBeLessThan(TICK_BUDGET_MS + 10_000);
    await t.clock.advance(MINUTE_MS);
    const second = await drive(t.clock, t.client, jobs.tick());
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
    const first = await drive(t.clock, t.client, jobs.tick());
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
    const retry = await drive(t.clock, t.client, jobs.tick());
    expect(retry.asked).toEqual([
      { instrument: nvda.id, sections: ["earnings"] },
    ]);
    expect(
      sectionState(t.db, nvda.id, "earnings", t.clock.now()).stale,
    ).toEqual([]);
    expect(lines.some((l) => l.includes("finnhub section failed"))).toBe(true);
    for (const l of lines) expect(l).not.toContain(FINNHUB_KEY);
  });
});

describe("the market calendar", () => {
  // after the US close on a day the recordings hold reporters for, two
  // hours before the daily refresh
  const AT = Date.parse("2026-10-27T20:30:00Z");
  const isMarket = (u: URL) =>
    u.pathname === "/api/v1/calendar/earnings" && !u.searchParams.has("symbol");

  // the market recordings with their rows edited, every other answer as
  // the helper gives it, a made-up share answering as NVDA
  function marketSetup(
    options: {
      rows?: (rows: any[]) => void;
      fail?: () => boolean;
      start?: number;
      route?: Route;
    } = {},
  ) {
    return setup({
      start: options.start ?? AT,
      route: async (url) => {
        const routed = await options.route?.(url);
        if (routed !== undefined) return routed;
        if (isMarket(url)) {
          if (options.fail?.()) {
            return { recordedAt: "", status: 500, headers: {}, body: {} };
          }
          const fx = clone((await finnhubAnswer(url))!);
          options.rows?.(fx.body.earningsCalendar);
          return fx;
        }
        return finnhubAnswer(url, { HOOD: "nvda", AAT: "nvda" });
      },
    });
  }

  const row = (rows: any[], symbol: string) =>
    rows.find((r) => r.symbol === symbol);

  // a stored event of the share's own listing, not yet reported
  const stored = (db: Db, id: string, date: string, quarter = 3) =>
    db
      .query(
        `insert into events (instrument, fiscal_year, fiscal_quarter, date,
           hour, eps_estimate, fetched_at) values (?, 2026, ?, ?, 'amc', 0.5, ?)`,
      )
      .run(id, quarter, date, AT - DAY_MS);

  // every section fetched well, so the daily refresh asks nothing today
  const fresh = (db: Db, id: string) => {
    for (const s of SECTIONS) {
      db.query(
        `insert into sync_runs (source, job, scope, started_at, ended_at,
           status, rows) values ('finnhub', ?, ?, ?, ?, 'ok', 1)`,
      ).run(s, id, AT - 60 * MINUTE_MS, AT - 60 * MINUTE_MS);
    }
  };

  const reporting = (db: Db, symbol: string, date = "2026-10-27") => {
    const i = share(db, symbol, AT);
    stored(db, i.id, date);
    fresh(db, i.id);
    return i;
  };

  const marketCalls = (t: { f: { urls: URL[] } }) => t.f.urls.filter(isMarket);

  test("a reporting share's actual comes from one market call, then its earnings once", async () => {
    let actual: number | null = null;
    const t = marketSetup({
      rows: (rows) => {
        row(rows, "HOOD").epsActual = actual;
      },
    });
    const hood = reporting(t.db, "HOOD");
    const jobs = finnhubJobs({ ctx: t.ctx, log: silent });
    // no actual yet: the event waits
    const first = await drive(t.clock, t.client, jobs.tick());
    expect(first.market).toEqual({ rows: 1, reported: [] });
    expect(marketCalls(t).map((u) => u.search)).toEqual([
      "?from=2026-10-26&to=2026-10-27",
    ]);
    expect(t.f.urls).toHaveLength(1);
    actual = 0.61;
    await t.clock.advance(60 * MINUTE_MS);
    const second = await drive(t.clock, t.client, jobs.tick());
    expect(second.market).toEqual({ rows: 1, reported: [hood.id] });
    expect(second.asked).toEqual([
      { instrument: hood.id, sections: ["earnings"] },
    ]);
    const [e] = readEvents(t.db, "2026-10-27", "2026-10-27");
    expect(e).toMatchObject({
      instrument: hood.id,
      epsActual: 0.61,
      epsEstimate: 0.5684,
      listing: null,
    });
    expect(e!.reportedSeenAt).not.toBeNull();
    expect(readResearch(t.db, hood.id, "earnings").length).toBeGreaterThan(0);
    expect(
      t.f.urls.map((u) => `${u.pathname}?${u.searchParams.get("symbol")}`),
    ).toEqual([
      "/api/v1/calendar/earnings?null",
      "/api/v1/calendar/earnings?null",
      "/api/v1/stock/earnings?HOOD",
    ]);
    // reported: nothing else waits, so the next hour asks nothing
    await t.clock.advance(60 * MINUTE_MS);
    const third = await drive(t.clock, t.client, jobs.tick());
    expect(third).toEqual({ market: null, asked: [], failed: [] });
    expect(t.f.urls).toHaveLength(3);
  });

  test("no tracked share in its window makes no market call", async () => {
    const t = marketSetup();
    // reports in two days
    reporting(t.db, "HOOD", "2026-10-29");
    // reports today, but read too long ago to be tracked
    const old = share(t.db, "AAT", AT - 40 * DAY_MS);
    stored(t.db, old.id, "2026-10-27");
    // reported already
    const done = reporting(t.db, "AB");
    t.db
      .query("update events set reported_seen_at = ? where instrument = ?")
      .run(AT - MINUTE_MS, done.id);
    // reports today, but not a share
    const etf = share(t.db, "QQQ", AT, { type: "ETF" });
    stored(t.db, etf.id, "2026-10-27");
    fresh(t.db, etf.id);
    const jobs = finnhubJobs({ ctx: t.ctx, log: silent });
    const pass = await drive(t.clock, t.client, jobs.tick());
    expect(pass.market).toBeNull();
    expect(marketCalls(t)).toEqual([]);
  });

  test("an event two local days ago is not waited on, one yesterday is", async () => {
    const t = marketSetup();
    const hood = reporting(t.db, "HOOD", "2026-10-25");
    const jobs = finnhubJobs({ ctx: t.ctx, log: silent });
    await drive(t.clock, t.client, jobs.tick());
    expect(marketCalls(t)).toEqual([]);
    t.db
      .query("update events set date = '2026-10-26' where instrument = ?")
      .run(hood.id);
    await t.clock.advance(MINUTE_MS);
    await drive(t.clock, t.client, jobs.tick());
    expect(marketCalls(t)).toHaveLength(1);
  });

  test("ticks inside an hour make one call; a failed one waits the retry", async () => {
    let failing = false;
    const t = marketSetup({ fail: () => failing });
    reporting(t.db, "HOOD");
    const jobs = finnhubJobs({ ctx: t.ctx, log: silent });
    await drive(t.clock, t.client, jobs.tick());
    await t.clock.advance(30 * MINUTE_MS);
    await drive(t.clock, t.client, jobs.tick());
    expect(marketCalls(t)).toHaveLength(1);
    await t.clock.advance(31 * MINUTE_MS);
    failing = true;
    const failed = await drive(t.clock, t.client, jobs.tick());
    expect(failed.market).toEqual({ error: "source error" });
    expect(marketCalls(t)).toHaveLength(2);
    const run = lastRun(t.db, "finnhub", "market-calendar", "US");
    expect(run).toMatchObject({ status: "failed", error: "source error" });
    failing = false;
    await t.clock.advance(RETRY_MS - 2 * MINUTE_MS);
    await drive(t.clock, t.client, jobs.tick());
    expect(marketCalls(t)).toHaveLength(2);
    await t.clock.advance(3 * MINUTE_MS);
    const retry = await drive(t.clock, t.client, jobs.tick());
    expect(retry.market).toEqual({ rows: 1, reported: [] });
    expect(marketCalls(t)).toHaveLength(3);
  });

  test("only stored events of tracked shares change; a missing row changes none", async () => {
    const t = marketSetup({
      rows: (rows) => {
        // a quarter the share has no event for
        row(rows, "AAT").quarter = 2;
        // a share missing from this answer
        rows.splice(rows.indexOf(row(rows, "HOOD")), 1);
      },
    });
    const hood = reporting(t.db, "HOOD");
    const aat = reporting(t.db, "AAT");
    const instruments = count(t.db, "select count(*) as n from instruments");
    const before = readEvents(t.db, "2000-01-01", "2100-01-01");
    const jobs = finnhubJobs({ ctx: t.ctx, log: silent });
    const pass = await drive(t.clock, t.client, jobs.tick());
    expect(pass.market).toEqual({ rows: 0, reported: [] });
    expect(marketCalls(t)).toHaveLength(1);
    // AB and every other reporter in the answer is not tracked
    expect(count(t.db, "select count(*) as n from instruments")).toBe(
      instruments,
    );
    expect(readEvents(t.db, "2000-01-01", "2100-01-01")).toEqual(before);
    expect(before.map((e) => e.instrument).sort()).toEqual([aat.id, hood.id]);
  });

  test("a symbol whose rows conflict is left out alone", async () => {
    const t = marketSetup({
      rows: (rows) => {
        const aat = row(rows, "AAT");
        rows.push({ ...aat, date: "2026-10-28" });
        row(rows, "HOOD").epsActual = 0.61;
      },
    });
    const hood = reporting(t.db, "HOOD");
    const aat = reporting(t.db, "AAT");
    const jobs = finnhubJobs({ ctx: t.ctx, log: silent });
    const pass = await drive(t.clock, t.client, jobs.tick());
    expect(pass.market).toEqual({ rows: 1, reported: [hood.id] });
    const events = readEvents(t.db, "2026-10-27", "2026-10-28");
    expect(events.find((e) => e.instrument === aat.id)).toMatchObject({
      date: "2026-10-27",
      epsEstimate: 0.5,
    });
  });

  test("an event of another listing is asked by its share's calendar hourly, never the market", async () => {
    let actual: number | null = null;
    const t = marketSetup({
      route: edited("/api/v1/calendar/earnings", "TSM", (b) => {
        b.earningsCalendar[0].date = "2026-10-27";
        b.earningsCalendar[0].epsActual = actual;
      }),
    });
    const tsm = share(t.db, "TSM", AT);
    t.db
      .query(
        `insert into events (instrument, fiscal_year, fiscal_quarter, date,
           hour, listing, fetched_at)
         values (?, 2026, 4, '2026-10-27', 'bmo', '2330.TW', ?)`,
      )
      .run(tsm.id, AT - DAY_MS);
    fresh(t.db, tsm.id);
    const key = { instrument: tsm.id, fiscalYear: 2026, fiscalQuarter: 4 };
    let seen = 0;
    const jobs = finnhubJobs({
      ctx: t.ctx,
      log: silent,
      hooks: {
        waited: () => [key],
        // the answer's past quarter is seen too, on the first ask
        reported: (_db, events) => {
          seen += events.filter((k) => k.fiscalQuarter === 4).length;
        },
      },
    });
    const calendars = () =>
      t.f.urls.filter(
        (u) =>
          u.pathname === "/api/v1/calendar/earnings" &&
          u.searchParams.get("symbol") === "TSM",
      ).length;
    const first = await drive(t.clock, t.client, jobs.tick());
    expect(first.asked).toEqual([
      { instrument: tsm.id, sections: ["calendar"] },
    ]);
    expect(calendars()).toBe(1);
    await t.clock.advance(30 * MINUTE_MS);
    await drive(t.clock, t.client, jobs.tick());
    expect(calendars()).toBe(1);
    actual = 33.1;
    await t.clock.advance(31 * MINUTE_MS);
    await drive(t.clock, t.client, jobs.tick());
    expect(calendars()).toBe(2);
    expect(seen).toBe(1);
    const [e] = readEvents(t.db, "2026-10-27", "2026-10-27");
    expect(e).toMatchObject({ listing: "2330.TW", epsActual: null });
    expect(e!.reportedSeenAt).not.toBeNull();
    // reported: neither its calendar nor the market is asked again
    await t.clock.advance(61 * MINUTE_MS);
    await drive(t.clock, t.client, jobs.tick());
    expect(calendars()).toBe(2);
    expect(seen).toBe(1);
    expect(marketCalls(t)).toEqual([]);
  });

  test("first sightings past one tick's budget get their earnings on the next tick, each once", async () => {
    const names = Array.from({ length: 50 }, (_, k) => `ZZ${k}`);
    const t = marketSetup({
      rows: (rows) => {
        const hood = row(rows, "HOOD");
        for (const symbol of names) {
          rows.push({ ...hood, symbol, epsActual: 0.7 });
        }
      },
    });
    for (const s of names) reporting(t.db, s);
    const jobs = finnhubJobs({ ctx: t.ctx, log: silent });
    const earnings = () =>
      t.f.urls
        .filter((u) => u.pathname === "/api/v1/stock/earnings")
        .map((u) => u.searchParams.get("symbol"));
    const first = await drive(t.clock, t.client, jobs.tick());
    expect(first.market).toMatchObject({ rows: 50 });
    expect(earnings().length).toBeLessThan(50);
    await t.clock.advance(MINUTE_MS);
    const second = await drive(t.clock, t.client, jobs.tick());
    expect(second.market).toBeNull();
    expect(earnings().sort()).toEqual([...names].sort());
    // each earnings ran after its sighting: none is asked again
    await t.clock.advance(MINUTE_MS);
    const third = await drive(t.clock, t.client, jobs.tick());
    expect(third.asked).toEqual([]);
    expect(marketCalls(t)).toHaveLength(1);
  });

  test("a waited event's first sighting calls the reported hook once, in the market write", async () => {
    const t = marketSetup({
      rows: (rows) => {
        row(rows, "HOOD").epsActual = 0.61;
      },
    });
    const hood = reporting(t.db, "HOOD");
    const key = { instrument: hood.id, fiscalYear: 2026, fiscalQuarter: 3 };
    const seen: { events: readonly EventKey[]; calls: number }[] = [];
    const jobs = finnhubJobs({
      ctx: t.ctx,
      log: silent,
      hooks: {
        waited: () => [key],
        reported: (db, events) => {
          // the event is written when the hook reads it
          expect(
            (
              db
                .query(
                  "select reported_seen_at as at from events where instrument = ?",
                )
                .get(hood.id) as { at: number | null }
            ).at,
          ).not.toBeNull();
          seen.push({ events, calls: t.f.urls.length });
        },
      },
    });
    await drive(t.clock, t.client, jobs.tick());
    await t.clock.advance(60 * MINUTE_MS);
    await drive(t.clock, t.client, jobs.tick());
    expect(seen).toEqual([{ events: [key], calls: 1 }]);
    expect(isMarket(t.f.urls[0]!)).toBe(true);
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
      const pass = await drive(clock, a.finnhub!, a.finnhubJobs!.tick());
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
