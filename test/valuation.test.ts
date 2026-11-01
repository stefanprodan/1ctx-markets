// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { jobAbout, jobLabel } from "../src/admin/http.ts";
import { round } from "../src/market/format.ts";
import { upsertInstrument } from "../src/market/instruments.ts";
import { STALE } from "../src/market/stale.ts";
import { markRead } from "../src/market/tracking.ts";
import { markets } from "../src/operations/markets.ts";
import { NO_VALUATION } from "../src/operations/research.ts";
import { DAY_MS, MINUTE_MS } from "../src/runtime/clock.ts";
import { logger, silent } from "../src/runtime/log.ts";
import { finnhub } from "../src/sources/finnhub/client.ts";
import { STALE_RESEARCH } from "../src/sources/finnhub/read.ts";
import {
  DeadlinePassed,
  Paused,
  QueueClosed,
  queue,
  SourceError,
  STOPPED,
} from "../src/sources/source.ts";
import { parseSummary, yahoo } from "../src/sources/yahoo/client.ts";
import {
  PER_US_SHARE,
  readValuation,
  refreshValuation,
  valuationDue,
  valuationFetched,
  valuationJobs,
} from "../src/sources/yahoo/valuation.ts";
import { type Db, open } from "../src/storage/db/index.ts";
import { endRun, startRun } from "../src/storage/runs.ts";
import { writer } from "../src/storage/writer.ts";
import { parseResearch, researchAnswer } from "../src/tools/research.ts";
import { api } from "./helpers/api.ts";
import { fakeClock } from "./helpers/clock.ts";
import { drive, pacedOf } from "./helpers/drive.ts";
import { FINNHUB_KEY, finnhubAnswer } from "./helpers/finnhub.ts";
import { NOW, sources } from "./helpers/sources.ts";
import {
  COOKIE,
  CRUMB,
  chartSymbol,
  clone,
  fakeFetch,
  listed,
  type Recorded,
  recorded,
  summarySymbol,
  yahooSession,
} from "./helpers/yahoo.ts";

// answers first, then Yahoo's session; undefined falls through
type Route = (
  url: URL,
  headers: Headers,
) => Promise<Recorded | undefined> | Recorded | undefined;

const body = (r: { content: { text: string }[] }) =>
  JSON.parse(r.content[0]!.text);

const limited: Recorded = {
  recordedAt: "",
  status: 429,
  headers: {},
  body: {},
};

function client(route: Route = () => undefined) {
  const clock = fakeClock(NOW);
  const session = yahooSession();
  const calls = queue(clock, 2);
  const f = fakeFetch(
    async (url, headers) =>
      (await route(url, headers)) ?? session.answer(url, headers),
  );
  return {
    clock,
    f,
    session,
    calls,
    y: yahoo({ clock, fetch: f.fetch, queue: calls }),
  };
}

const kinds = (urls: URL[]) =>
  urls.map((u) =>
    u.hostname === "fc.yahoo.com"
      ? "cookie"
      : u.pathname === "/v1/test/getcrumb"
        ? "crumb"
        : chartSymbol(u) !== null
          ? `chart ${chartSymbol(u)}`
          : `summary ${summarySymbol(u)}`,
  );

describe("the quote summary", () => {
  test("reads EPS and PEG per US share behind one session", async () => {
    const { f, y } = client();
    expect(await y.valuation("TSM")).toMatchObject({
      symbol: "TSM",
      currency: "USD",
      epsTtm: 15.43,
      epsForward: 23.38529,
      peg: 0.73,
    });
    await y.valuation("ASML");
    expect(kinds(f.urls)).toEqual([
      "cookie",
      "crumb",
      "summary TSM",
      "summary ASML",
    ]);
    expect(f.headers[1]!.get("cookie")).toBe(`${COOKIE}1`);
    expect(f.headers[2]!.get("cookie")).toBe(`${COOKIE}1`);
    expect(f.urls[2]!.searchParams.get("crumb")).toBe(`${CRUMB}1`);
  });

  test("a missing or non-number figure is null, never zero", async () => {
    const fx = await recorded("quotesummary-tsm");
    const stats = fx.body.quoteSummary.result[0].defaultKeyStatistics;
    delete stats.pegRatio;
    stats.forwardEps = {};
    stats.trailingEps = { raw: "15.43", fmt: "15.43" };
    expect(parseSummary(fx.body, NOW)).toMatchObject({
      epsTtm: null,
      epsForward: null,
      peg: null,
    });
  });

  test("a dropped crumb is asked again once, with a new cookie and its crumb", async () => {
    const { f, y, session } = client();
    await y.valuation("TSM");
    session.revoke();
    expect((await y.valuation("TSM")).epsTtm).toBe(15.43);
    expect(kinds(f.urls)).toEqual([
      "cookie",
      "crumb",
      "summary TSM",
      "summary TSM",
      "cookie",
      "crumb",
      "summary TSM",
    ]);
    expect(f.urls[3]!.searchParams.get("crumb")).toBe(`${CRUMB}1`);
    expect(f.headers[5]!.get("cookie")).toBe(`${COOKIE}2`);
    expect(f.headers[6]!.get("cookie")).toBe(`${COOKIE}2`);
    expect(f.urls[6]!.searchParams.get("crumb")).toBe(`${CRUMB}2`);
    expect(y.backoff()).toBeNull();
  });

  test("a second refusal fails the call alone: the queue prices share never backs off", async () => {
    const nvda = await recorded("chart-nvda-5d-1d");
    const { f, y } = client((url) =>
      summarySymbol(url) !== null
        ? recorded("quotesummary-no-crumb")
        : chartSymbol(url) === "NVDA"
          ? nvda
          : undefined,
    );
    const error = await y.valuation("TSM").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SourceError);
    expect((error as SourceError).phrase).toBe("source error");
    expect(String(error)).not.toContain(CRUMB);
    expect(String(error)).not.toContain("made-up-session");
    expect(kinds(f.urls)).toHaveLength(6);
    expect(y.backoff()).toBeNull();
    // a read that fails at once in a back-off still gets its chart
    const chart = await y.failFast().chart("NVDA", NOW - 5 * DAY_MS, NOW);
    expect(chart.symbol).toBe("NVDA");
  });

  test("a back-off another call set holds every session request", async () => {
    const { f, y } = client(async (url) => {
      if (chartSymbol(url) !== null) return limited;
      // a chart answers 429 while the session is being fetched
      if (url.hostname === "fc.yahoo.com") {
        await y.chart("NVDA", NOW - DAY_MS, NOW).catch(() => {});
      }
      return undefined;
    });
    const error = await y.valuation("TSM").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Paused);
    expect((error as Paused).phrase).toBe("rate limited");
    expect(kinds(f.urls)).toEqual(["cookie", "chart NVDA"]);
    // and a read in that back-off asks nothing at all
    const read = await y
      .failFast()
      .valuation("TSM")
      .catch((e: unknown) => e);
    expect(read).toBeInstanceOf(Paused);
    expect(kinds(f.urls)).toEqual(["cookie", "chart NVDA"]);
  });

  test("the deadline and shutdown are checked before each session request", async () => {
    let live = true;
    const late = client((url) => {
      if (url.hostname === "fc.yahoo.com") live = false;
      return undefined;
    });
    const error = await late.y
      .within(() => live)
      .valuation("TSM")
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DeadlinePassed);
    expect(kinds(late.f.urls)).toEqual(["cookie"]);

    const closing = client((url) => {
      if (url.hostname === "fc.yahoo.com") closing.calls.close();
      return undefined;
    });
    const closed = await closing.y.valuation("TSM").catch((e: unknown) => e);
    expect(closed).toBeInstanceOf(QueueClosed);
    expect(kinds(closing.f.urls)).toEqual(["cookie"]);
  });

  test("an answer naming another listing is malformed", async () => {
    const { y } = client(async (url, headers) => {
      if (summarySymbol(url) === null) return undefined;
      const fx = clone(await yahooSessionAnswer(url, headers));
      fx.body.quoteSummary.result[0].price.symbol = "2330.TW";
      return fx;
    });
    const error = await y.valuation("TSM").catch((e: unknown) => e);
    expect((error as SourceError).phrase).toBe("malformed answer");
  });
});

// the recorded summary, whatever pair was sent
const yahooSessionAnswer = (url: URL, _: Headers) =>
  recorded(
    summarySymbol(url) === "ASML" ? "quotesummary-asml" : "quotesummary-tsm",
  );

const share = (db: Db, symbol: string) =>
  upsertInstrument(
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
    },
    NOW,
  );

// Finnhub's metric as stored, answered from listing (null: its own),
// refreshed at the given time
function metric(db: Db, id: string, listing: string | null, at = NOW) {
  db.query(
    `insert into research (instrument, kind, period, listing, fetched_at)
     values (?, 'metric', '2026-10-25', ?, ?)
     on conflict (instrument, kind, period) do update set
       listing = excluded.listing, fetched_at = excluded.fetched_at`,
  ).run(id, listing, at);
  endRun(db, startRun(db, "finnhub", "metric", at, id), at, 1);
}

describe("the valuation job", () => {
  function setup(route: Route = () => undefined) {
    const clock = fakeClock(NOW);
    const { db } = open(":memory:", clock);
    const session = yahooSession();
    const f = fakeFetch(
      async (url, headers) =>
        (await route(url, headers)) ?? session.answer(url, headers),
    );
    const lines: string[] = [];
    const ctx = {
      db,
      clock,
      writer: writer(db),
      yahoo: yahoo({ clock, fetch: f.fetch }),
    };
    const log = logger(
      clock,
      () => [],
      (line) => lines.push(line),
    )("yahoo");
    for (const [symbol, listing] of [
      ["TSM", "2330.TW"],
      ["GOOG", "GOOGL"],
      ["NVDA", null],
    ] as const) {
      share(db, symbol);
      metric(db, `US:${symbol}`, listing);
    }
    markRead(db, ["US:TSM", "US:GOOG", "US:NVDA"], NOW);
    const summaries = () =>
      f.urls.filter((u) => summarySymbol(u) !== null).map(summarySymbol);
    return {
      clock,
      db,
      f,
      ctx,
      lines,
      session,
      summaries,
      jobs: valuationJobs({ ctx, log }),
    };
  }

  test("asks only a share answered from a foreign listing, once a day after its metric", async () => {
    const t = setup();
    expect((await t.jobs.tick()).asked).toEqual(["US:TSM"]);
    expect((await t.jobs.tick()).asked).toEqual([]);
    expect(readValuation(t.db, "US:TSM")).toMatchObject({
      epsTtm: 15.43,
      peg: 0.73,
      currency: "USD",
    });
    // past the next 23:00 UTC, but before the metric's daily refresh
    await t.clock.advance(DAY_MS);
    expect((await t.jobs.tick()).asked).toEqual([]);
    for (const id of ["US:TSM", "US:GOOG", "US:NVDA"]) {
      metric(t.db, id, id === "US:TSM" ? "2330.TW" : null, t.clock.now());
    }
    expect((await t.jobs.tick()).asked).toEqual(["US:TSM"]);
    expect(t.summaries()).toEqual(["TSM", "TSM"]);
  });

  test("a tick waiting on a call's fetch asks nothing that fetch stored", async () => {
    const t = setup();
    const tsm = { id: "US:TSM", sourceSymbol: "TSM", currency: "USD" };
    const [inline, pass] = await Promise.all([
      refreshValuation(t.ctx, tsm as never, {
        due: (db) => !valuationFetched(db, "US:TSM"),
      }),
      t.jobs.tick(),
    ]);
    expect(inline).toEqual({ status: "ok", rows: 1 });
    expect(pass.asked).toEqual([]);
    expect(t.summaries()).toEqual(["TSM"]);
  });

  test("a failure keeps the row and logs no cookie or crumb", async () => {
    let refuse = false;
    const t = setup((url) =>
      refuse && summarySymbol(url) !== null
        ? recorded("quotesummary-no-crumb")
        : undefined,
    );
    await t.jobs.tick();
    await t.clock.advance(DAY_MS);
    metric(t.db, "US:TSM", "2330.TW", t.clock.now());
    refuse = true;
    expect((await t.jobs.tick()).failed).toEqual([
      { instrument: "US:TSM", error: "source error" },
    ]);
    expect(readValuation(t.db, "US:TSM")?.epsTtm).toBe(15.43);
    expect(t.lines.some((l) => l.includes("valuation failed"))).toBe(true);
    for (const line of t.lines) {
      expect(line).not.toContain(CRUMB);
      expect(line).not.toContain("made-up-session");
    }
  });

  test("a failed share waits an hour, an interrupted run too, a stopped one not", async () => {
    const t = setup((url) =>
      summarySymbol(url) !== null
        ? recorded("quotesummary-no-crumb")
        : undefined,
    );
    const pass = await t.jobs.tick();
    expect(pass.failed).toEqual([
      { instrument: "US:TSM", error: "source error" },
    ]);
    expect(t.ctx.yahoo.backoff()).toBeNull();
    expect((await t.jobs.tick()).asked).toEqual([]);
    const run = (error: string) => {
      const at = t.clock.now();
      const id = startRun(t.db, "yahoo", "valuation", at, "US:TSM");
      t.db
        .query(
          "update sync_runs set status = 'failed', ended_at = ?, error = ? where id = ?",
        )
        .run(at, error, id);
    };
    await t.clock.advance(61 * MINUTE_MS);
    run("interrupted");
    expect(valuationDue(t.db, "US:TSM", t.clock.now())).toBe(false);
    await t.clock.advance(MINUTE_MS);
    run(STOPPED);
    expect(valuationDue(t.db, "US:TSM", t.clock.now())).toBe(true);
  });

  test("an answer in another currency than the instrument's keeps nothing", async () => {
    const t = setup(async (url, headers) => {
      if (summarySymbol(url) === null) return undefined;
      const fx = clone(await yahooSessionAnswer(url, headers));
      fx.body.quoteSummary.result[0].price.currency = "TWD";
      return fx;
    });
    const tsm = { id: "US:TSM", sourceSymbol: "TSM", currency: "USD" };
    expect(await refreshValuation(t.ctx, tsm as never)).toEqual({
      status: "ok",
      rows: 0,
    });
    expect(readValuation(t.db, "US:TSM")).toBeNull();
  });

  test("the status page names the job in plain words", () => {
    expect(jobLabel("yahoo", "valuation")).toBe("ADR valuations");
    expect(jobAbout("yahoo", "valuation")).toContain("foreign listing");
  });
});

describe("the valuation answer", () => {
  async function setup(options: { hold?: Route } = {}) {
    const clock = fakeClock(NOW);
    const { db } = open(":memory:", clock);
    const chart = listed(await recorded("chart-nvda-5y-1d"));
    const charts: Record<string, Recorded> = {};
    for (const symbol of ["TSM", "GOOG"]) {
      const c = clone(chart);
      c.body.chart.result[0].meta.symbol = symbol;
      charts[symbol] = c;
    }
    // TSM answered as its home listing, GOOG as its other share class
    const s = await sources({
      charts,
      hold: async (url) => {
        const held = await options.hold?.(url, new Headers());
        if (held !== undefined) return held;
        const fx = await finnhubAnswer(url, { GOOG: "nvda" });
        if (fx?.status !== 200 || url.searchParams.get("symbol") !== "GOOG") {
          return fx;
        }
        const out = clone(fx);
        if (out.body?.symbol !== undefined) out.body.symbol = "GOOGL";
        return out;
      },
    });
    const m = markets({
      db,
      clock,
      writer: writer(db),
      yahoo: yahoo({ clock, fetch: s.fetch }),
      fred: null,
      finnhub: finnhub({ clock, key: FINNHUB_KEY, fetch: s.fetch }),
      log: silent,
    });
    for (const symbol of ["TSM", "GOOG"]) share(db, symbol);
    const overview = async (symbol: string) =>
      body(
        await drive(
          clock,
          pacedOf(m),
          researchAnswer(m, parseResearch({ symbol })),
        ),
      );
    return { clock, db, m, calls: s.calls, overview };
  }

  test("a foreign listing's share gets Yahoo's figures inline, P/E at the quote's price", async () => {
    const t = await setup();
    const first = await t.overview("TSM");
    expect(first.research.metric).toMatchObject({
      listing: "2330.TW",
      pe_ttm: null,
    });
    const price = first.quote.price as number;
    expect(JSON.stringify(first)).not.toContain(CRUMB);
    expect(JSON.stringify(first)).not.toContain("made-up-session");
    expect(first.valuation).toEqual({
      source: "yahoo",
      fetched_at: expect.any(String),
      stale: [],
      currency: "USD",
      pe_ttm: round(price / 15.43),
      forward_pe: round(price / 23.38529),
      forward_peg: 0.73,
      eps_ttm: 15.43,
      eps_forward: 23.3853,
      note: PER_US_SHARE,
    });

    t.db
      .query("update quotes set price = ? where instrument = ?")
      .run(308.6, "US:TSM");
    t.db.query("update valuations set eps_forward = 0").run();
    const repriced = await t.overview("TSM");
    expect(repriced.valuation).toMatchObject({
      pe_ttm: 20,
      forward_pe: null,
      eps_forward: 0,
    });
    t.db.query("update valuations set eps_ttm = -1.5").run();
    expect((await t.overview("TSM")).valuation).toMatchObject({
      pe_ttm: null,
      eps_ttm: -1.5,
    });
    expect(t.calls.summaries()).toHaveLength(1);

    // a day on, no refresh since the 23:00 UTC due time
    await t.clock.advance(DAY_MS);
    expect((await t.overview("TSM")).valuation.stale).toEqual([
      STALE_RESEARCH.pending,
    ]);
  });

  test("a P/E on a stale quote says so, a missing P/E does not", async () => {
    const t = await setup();
    await t.overview("TSM");
    const at = t.clock.now() + 1000;
    t.db
      .query(
        `insert into sync_runs (source, job, scope, started_at, ended_at,
           status, error) values ('yahoo', 'quotes', 'US', ?1, ?1, 'failed',
           'source error')`,
      )
      .run(at);
    await t.clock.advance(2000);
    const stale = `quote: ${STALE.quotesFailed}`;
    expect((await t.overview("TSM")).valuation.stale).toEqual([stale]);
    t.db
      .query("update valuations set eps_ttm = null, eps_forward = null")
      .run();
    expect((await t.overview("TSM")).valuation.stale).toEqual([]);
  });

  test("a share Yahoo has no summary for says so, not that the symbol is unknown", async () => {
    const t = await setup({
      hold: (url) =>
        summarySymbol(url) !== null
          ? {
              recordedAt: "",
              status: 404,
              headers: {},
              body: {
                quoteSummary: { result: null, error: { code: "Not Found" } },
              },
            }
          : undefined,
    });
    const overview = await t.overview("TSM");
    expect(overview.quote.price).toBeNumber();
    expect(overview.valuation).toMatchObject({
      error: "not_found",
      message: NO_VALUATION,
      eps_ttm: null,
    });
  });

  test("a share Finnhub answers as itself or as another class gets none", async () => {
    const t = await setup();
    const goog = await t.overview("GOOG");
    expect(goog.research.metric.listing).toBe("GOOGL");
    expect(goog).not.toContainKey("valuation");
    expect(t.calls.summaries()).toEqual([]);
  });

  test("the research route answers the tool's valuation, with the metric", async () => {
    const t = await setup();
    const tool = await t.overview("TSM");
    const ask = async (query: string) => {
      const res = await drive(
        t.clock,
        pacedOf(t.m),
        api(t.m)(new Request(`http://markets.test/api/v1/research?${query}`)),
      );
      return ((await res.json()) as { research: any[] }).research;
    };
    const [tsm, goog] = await ask("symbols=TSM,GOOG");
    expect(tsm.valuation).toEqual(tool.valuation);
    expect(goog).not.toContainKey("valuation");
    const [analysts] = await ask("symbols=TSM&sections=analysts");
    expect(analysts).not.toContainKey("valuation");
    expect(t.calls.summaries()).toHaveLength(1);
  });
});
