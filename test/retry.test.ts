// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { failingScopes } from "../src/admin/http.ts";
import { retryFailed } from "../src/admin/retry.ts";
import { spec } from "../src/api/openapi.ts";
import { recordSession } from "../src/market/calendars.ts";
import {
  type InstrumentFields,
  upsertInstrument,
} from "../src/market/instruments.ts";
import { markRead } from "../src/market/tracking.ts";
import { CALL_MS, markets } from "../src/operations/markets.ts";
import { MINUTE_MS } from "../src/runtime/clock.ts";
import { silent } from "../src/runtime/log.ts";
import { bvb, MARKET } from "../src/sources/bvb/client.ts";
import { fetchInstrument } from "../src/sources/bvb/sync.ts";
import { edgar } from "../src/sources/edgar/client.ts";
import { finnhub } from "../src/sources/finnhub/client.ts";
import { fred } from "../src/sources/fred/client.ts";
import { massive } from "../src/sources/massive/client.ts";
import { SourceError } from "../src/sources/source.ts";
import { yahoo } from "../src/sources/yahoo/client.ts";
import { type Db, open } from "../src/storage/db/index.ts";
import { endRun, failRun, startRun } from "../src/storage/runs.ts";
import { writer } from "../src/storage/writer.ts";
import { api, READ_KEY } from "./helpers/api.ts";
import { bvbFetch, wapi } from "./helpers/bvb.ts";
import { fakeClock } from "./helpers/clock.ts";
import { drive, pacedOf } from "./helpers/drive.ts";
import { EDGAR_CONTACT, edgarAnswer } from "./helpers/edgar.ts";
import { FINNHUB_KEY, finnhubAnswer } from "./helpers/finnhub.ts";
import {
  type FakeMassive,
  MASSIVE_HOST,
  MASSIVE_KEY,
  massiveAnswer,
  series,
} from "./helpers/massive.ts";
import { answerSchema, validate } from "./helpers/schema.ts";
import { FRED_KEY, gate, NOW, sources } from "./helpers/sources.ts";
import { chartSymbol, type Recorded, summarySymbol } from "./helpers/yahoo.ts";

const HOUR_MS = 60 * MINUTE_MS;
const BEFORE = NOW - HOUR_MS;

type Off = "finnhub" | "massive" | "edgar" | "fred";

async function setup(
  options: {
    off?: Off[];
    hold?: (url: URL) => Promise<Recorded | undefined> | undefined;
  } = {},
) {
  const clock = fakeClock(NOW);
  const { db } = open(":memory:", clock);
  const fake: FakeMassive = {
    articles: await series("NVDA", 3, BEFORE, MINUTE_MS),
  };
  const s = await sources({
    hold: async (url) =>
      (await options.hold?.(url)) ??
      (await finnhubAnswer(url)) ??
      massiveAnswer(fake, url) ??
      (await edgarAnswer(url)),
  });
  const on = (name: Off) => !options.off?.includes(name);
  const fetch = s.fetch;
  const m = markets({
    db,
    clock,
    writer: writer(db),
    yahoo: yahoo({ clock, fetch }),
    fred: on("fred") ? fred({ clock, key: FRED_KEY, fetch }) : null,
    finnhub: on("finnhub") ? finnhub({ clock, key: FINNHUB_KEY, fetch }) : null,
    massive: on("massive") ? massive({ clock, key: MASSIVE_KEY, fetch }) : null,
    edgar: on("edgar") ? edgar({ clock, contact: EDGAR_CONTACT, fetch }) : null,
    log: silent,
  });
  const retry = () =>
    drive(clock, pacedOf(m), retryFailed(m, failingScopes(db)));
  return { clock, db, m, urls: s.calls.urls, calls: s.calls, retry };
}

function add(db: Db, symbol: string, fields: Partial<InstrumentFields> = {}) {
  const i = upsertInstrument(
    db,
    {
      market: "US",
      symbol,
      source: "yahoo",
      sourceSymbol: symbol,
      exchange: "NMS",
      name: symbol,
      type: "EQUITY",
      currency: "USD",
      unit: "per_share",
      zone: "America/New_York",
      ...fields,
    },
    BEFORE,
  );
  markRead(db, [i.id], BEFORE);
  return i;
}

const series10 = (db: Db) =>
  add(db, "DGS10", {
    market: "FRED",
    source: "fred",
    exchange: "FRED",
    type: "SERIES",
    currency: null,
    unit: "percent",
    zone: "UTC",
  });

function fail(db: Db, source: string, job: string, scope: string, at = BEFORE) {
  failRun(
    db,
    startRun(db, source, job, at, scope),
    at,
    new SourceError("source error"),
  );
}

function ok(db: Db, source: string, job: string, scope: string) {
  endRun(db, startRun(db, source, job, BEFORE, scope), BEFORE, 1);
}

const failing = (db: Db) =>
  failingScopes(db)
    .map((f) => `${f.source}/${f.job} ${f.scope}`)
    .sort();

const runs = (db: Db, source: string, job: string) =>
  (
    db
      .query("select count(*) as n from sync_runs where source = ? and job = ?")
      .get(source, job) as { n: number }
  ).n;

describe("retry failed jobs", () => {
  test("each failed instrument asks only its failed part, and a good answer clears it", async () => {
    const t = await setup();
    add(t.db, "NVDA");
    add(t.db, "TSM");
    add(t.db, "QQQ", { type: "ETF" });
    add(t.db, "AAPL");
    series10(t.db);
    // Finnhub answers TSM from a foreign listing
    t.db
      .query(
        `insert into research (instrument, kind, period, listing, fetched_at)
         values ('US:TSM', 'metric', '2026-10-25', '2330.TW', ?)`,
      )
      .run(BEFORE);
    ok(t.db, "finnhub", "metric", "US:TSM");
    for (const [source, job, scope] of [
      ["massive", "news", "US:NVDA"],
      ["finnhub", "metric", "US:NVDA"],
      ["finnhub", "calendar", "US:NVDA"],
      ["edgar", "filings", "US:NVDA"],
      ["yahoo", "bars", "US:NVDA"],
      ["yahoo", "backfill", "US:NVDA"],
      ["yahoo", "valuation", "US:TSM"],
      ["yahoo", "top_holdings", "US:QQQ"],
      ["fred", "bars", "FRED:DGS10"],
      // a market's own jobs, asked again by their own schedule
      ["yahoo", "quotes", "US"],
      ["yahoo", "bars", "US"],
      ["finnhub", "market-calendar", "US"],
      // never failed by a job: a good bars run writes it only while owed
      ["yahoo", "owed", "US:NVDA"],
    ] as const) {
      fail(t.db, source, job, scope);
    }
    ok(t.db, "finnhub", "analysts", "US:NVDA");
    ok(t.db, "massive", "news", "US:AAPL");
    expect(await t.retry()).toEqual({
      asked: 9,
      fetched: 9,
      failed: 0,
      left_out: 4,
    });
    expect(failing(t.db)).toEqual([
      "finnhub/market-calendar US",
      "yahoo/bars US",
      "yahoo/owed US:NVDA",
      "yahoo/quotes US",
    ]);
    const finnhubAsked = t.urls
      .filter((u) => u.hostname === "finnhub.io")
      .map((u) => `${u.pathname} ${u.searchParams.get("symbol")}`)
      .sort();
    expect(finnhubAsked).toEqual([
      "/api/v1/calendar/earnings NVDA",
      "/api/v1/stock/metric NVDA",
    ]);
    const news = t.urls.filter((u) => u.hostname === MASSIVE_HOST);
    expect(news.map((u) => u.searchParams.get("ticker"))).toEqual(["NVDA"]);
    const sec = t.urls.filter((u) => u.hostname === "data.sec.gov");
    expect(sec).toHaveLength(1);
    expect(t.calls.sparks()).toEqual([]);
    expect(
      [...new Set(t.calls.charts().map((u) => chartSymbol(u)))].sort(),
    ).toEqual(["NVDA"]);
    expect(
      [...new Set(t.calls.summaries().map((u) => summarySymbol(u)))].sort(),
    ).toEqual(["QQQ", "TSM"]);
    const fredAsked = t.urls.filter((u) => u.hostname === "api.stlouisfed.org");
    expect(fredAsked.length).toBeGreaterThan(0);
    expect(
      fredAsked.every((u) => u.searchParams.get("series_id") === "DGS10"),
    ).toBe(true);
  });

  test("nothing failing asks nothing", async () => {
    const t = await setup();
    add(t.db, "NVDA");
    ok(t.db, "massive", "news", "US:NVDA");
    fail(t.db, "yahoo", "quotes", "US");
    expect(await t.retry()).toEqual({
      asked: 0,
      fetched: 0,
      failed: 0,
      left_out: 1,
    });
    expect(t.urls).toEqual([]);
  });

  test("a source that is off is left out, its failure kept", async () => {
    const t = await setup({ off: ["massive", "edgar", "fred", "finnhub"] });
    add(t.db, "NVDA");
    series10(t.db);
    fail(t.db, "massive", "news", "US:NVDA");
    fail(t.db, "edgar", "filings", "US:NVDA");
    fail(t.db, "finnhub", "insider", "US:NVDA");
    fail(t.db, "fred", "bars", "FRED:DGS10");
    // an instrument no longer stored names nothing to ask
    fail(t.db, "yahoo", "top_holdings", "US:GONE");
    expect(await t.retry()).toEqual({
      asked: 0,
      fetched: 0,
      failed: 0,
      left_out: 5,
    });
    expect(t.urls).toEqual([]);
    expect(failing(t.db)).toHaveLength(5);
  });

  test("a failure records a failed run with its phrase, as the job would", async () => {
    const t = await setup({
      hold: async (url) =>
        url.hostname === "finnhub.io"
          ? { recordedAt: "", status: 500, headers: {}, body: {} }
          : undefined,
    });
    add(t.db, "ZZZZ");
    fail(t.db, "finnhub", "earnings", "US:ZZZZ");
    expect(await t.retry()).toEqual({
      asked: 1,
      fetched: 0,
      failed: 1,
      left_out: 0,
    });
    expect(runs(t.db, "finnhub", "earnings")).toBe(2);
    const [row] = failingScopes(t.db);
    expect(row).toMatchObject({ job: "earnings", scope: "US:ZZZZ" });
    expect(row!.endedAt).toBeGreaterThanOrEqual(NOW);
  });

  test("a failed history asked again fails only its own row", async () => {
    const t = await setup({
      hold: async (url) =>
        url.hostname.includes("yahoo")
          ? { recordedAt: "", status: 500, headers: {}, body: {} }
          : undefined,
    });
    add(t.db, "ZZZZ");
    fail(t.db, "yahoo", "backfill", "US:ZZZZ");
    expect(await t.retry()).toMatchObject({ asked: 1, failed: 1 });
    expect(failing(t.db)).toEqual(["yahoo/backfill US:ZZZZ"]);
    expect(runs(t.db, "yahoo", "backfill")).toBe(2);
    expect(runs(t.db, "yahoo", "bars")).toBe(0);
  });

  test("the deadline stops what is left without recording a run", async () => {
    const held = gate();
    const t = await setup({
      hold: (url) =>
        url.hostname === "finnhub.io" || url.hostname === MASSIVE_HOST
          ? held.hold()
          : undefined,
    });
    add(t.db, "NVDA");
    fail(t.db, "finnhub", "metric", "US:NVDA");
    fail(t.db, "massive", "news", "US:NVDA");
    const answer = retryFailed(t.m, failingScopes(t.db));
    await drive(t.clock, pacedOf(t.m), held.arrived);
    await t.clock.advance(CALL_MS);
    expect(await answer).toEqual({
      asked: 2,
      fetched: 0,
      failed: 2,
      left_out: 0,
    });
    held.release();
    await drive(t.clock, pacedOf(t.m), Promise.resolve());
    expect(runs(t.db, "finnhub", "metric")).toBe(1);
    expect(runs(t.db, "massive", "news")).toBe(1);
    expect(failing(t.db)).toEqual([
      "finnhub/metric US:NVDA",
      "massive/news US:NVDA",
    ]);
  });

  test("the route takes the admin key and no body, and answers counts only", async () => {
    const t = await setup();
    add(t.db, "NVDA");
    fail(t.db, "massive", "news", "US:NVDA");
    const handle = api(t.m);
    const url = "http://markets.test/api/v1/status/retry";
    const agent = await handle(
      new Request(url, {
        method: "POST",
        headers: { authorization: `Bearer ${READ_KEY}` },
      }),
    );
    expect(agent.status).toBe(403);
    const refused: Request[] = [
      new Request(url, { method: "POST", body: "{}" }),
      new Request(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ parts: ["news"] }),
      }),
      new Request(`${url}?x=1`, { method: "POST" }),
    ];
    for (const req of refused) {
      const res = await handle(req);
      expect([req.url, res.status]).toEqual([req.url, 400]);
    }
    expect((await handle(new Request(url))).status).toBe(405);
    // none of those asked anything
    expect(t.urls).toEqual([]);
    expect(failing(t.db)).toEqual(["massive/news US:NVDA"]);
    const res = await drive(
      t.clock,
      pacedOf(t.m),
      handle(new Request(url, { method: "POST" })),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ asked: 1, fetched: 1, failed: 0, left_out: 0 });
    expect(
      validate(body, answerSchema(spec, "POST", "/status/retry", 200)!, spec),
    ).toEqual([]);
    expect(failing(t.db)).toEqual([]);
  });
});

describe("retry failed jobs on the Bucharest feed", () => {
  const utc = (iso: string) => Date.parse(`${iso}Z`);

  test("a failed bars run of a feed instrument is cleared by its bars", async () => {
    const clock = fakeClock(utc("2026-10-23T14:00:00"));
    const { db } = open(":memory:", clock);
    const f = await bvbFetch();
    const exchange = bvb({ clock, fetch: f.fetch });
    const w = writer(db);
    recordSession(
      db,
      MARKET,
      {
        zone: "Europe/Bucharest",
        start: utc("2026-10-23T07:00:00"),
        end: utc("2026-10-23T15:00:00"),
      },
      clock.now(),
    );
    const ctx = { db, clock, bvb: exchange, writer: w };
    const tlv = await drive(
      clock,
      exchange,
      fetchInstrument(ctx, "TLV", null, () => true),
    );
    await clock.advance(MINUTE_MS);
    fail(db, "bvb", "bars", tlv.id, clock.now());
    fail(db, "bvb", "bars", MARKET, clock.now());
    await clock.advance(MINUTE_MS);
    const m = markets({
      db,
      clock,
      writer: w,
      yahoo: yahoo({
        clock,
        fetch: async () => {
          throw new Error("no Yahoo call expected");
        },
      }),
      fred: null,
      bvb: exchange,
      log: silent,
    });
    const before = wapi(f.urls, "/api/history").length;
    expect(
      await drive(clock, exchange, retryFailed(m, failingScopes(db))),
    ).toEqual({ asked: 1, fetched: 1, failed: 0, left_out: 1 });
    expect(wapi(f.urls, "/api/history").length).toBeGreaterThan(before);
    expect(failing(db)).toEqual([`bvb/bars ${MARKET}`]);
  });
});
