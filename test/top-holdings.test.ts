// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { jobAbout, jobLabel } from "../src/admin/http.ts";
import {
  type Instrument,
  readInstrument,
  upsertInstrument,
} from "../src/market/instruments.ts";
import { markRead } from "../src/market/tracking.ts";
import { markets } from "../src/operations/markets.ts";
import { topHoldingsSummary } from "../src/operations/research.ts";
import { DAY_MS, MINUTE_MS } from "../src/runtime/clock.ts";
import { logger, silent } from "../src/runtime/log.ts";
import { STALE_RESEARCH } from "../src/sources/finnhub/read.ts";
import { RETRY_MS } from "../src/sources/history.ts";
import { queue, type SourceError } from "../src/sources/source.ts";
import {
  HOLDING_NAME_MAX,
  parseTopHoldings,
  yahoo,
} from "../src/sources/yahoo/client.ts";
import {
  NO_TOP_HOLDINGS,
  NOT_A_FUND,
  readTopHoldings,
  refreshTopHoldings,
  TOP_ONLY,
  topHoldingsJobs,
} from "../src/sources/yahoo/top-holdings.ts";
import { type Db, open } from "../src/storage/db/index.ts";
import { lastStarted } from "../src/storage/runs.ts";
import { writer } from "../src/storage/writer.ts";
import { parseResearch, researchAnswer } from "../src/tools/research.ts";
import { api } from "./helpers/api.ts";
import { fakeClock } from "./helpers/clock.ts";
import { drive, pacedOf } from "./helpers/drive.ts";
import { gate, NOW, sources } from "./helpers/sources.ts";
import {
  CRUMB,
  clone,
  fakeFetch,
  holdingsAsked,
  listed,
  notFound,
  type Recorded,
  recorded,
  summarySymbol,
  yahooSession,
} from "./helpers/yahoo.ts";

type Route = (
  url: URL,
  headers: Headers,
) => Promise<Recorded | undefined> | Recorded | undefined;

const body = (r: { content: { text: string }[] }) =>
  JSON.parse(r.content[0]!.text);

const failing: Recorded = {
  recordedAt: "",
  status: 500,
  headers: {},
  body: {},
};

const fund = (name: string) =>
  recorded(name).then((fx) => fx.body.quoteSummary.result[0].topHoldings);

const parsed = async (name: string) =>
  parseTopHoldings((await recorded(name)).body, NOW);

// a recorded answer with its top holdings changed by edit
async function edited(name: string, edit: (t: any) => void) {
  const fx = clone(await recorded(name));
  edit(fx.body.quoteSummary.result[0].topHoldings);
  return parseTopHoldings(fx.body, NOW);
}

describe("the top holdings read", () => {
  test("keeps the ten in Yahoo's order with their weights as fractions", async () => {
    const qqq = (await parsed("topholdings-qqq")).fund!;
    expect(qqq.holdings).toHaveLength(10);
    expect(qqq.holdings[0]).toEqual({
      symbol: "NVDA",
      name: "NVIDIA Corp",
      weight: 0.0832742,
    });
    expect(qqq.holdings.map((h) => h.symbol)).toEqual([
      "NVDA",
      "AAPL",
      "MSFT",
      "MU",
      "AMD",
      "AMZN",
      "META",
      "GOOGL",
      "GOOG",
      "TSLA",
    ]);
    // a zero sector is not a sector the fund holds
    expect(qqq.sectors.map((s) => s.key)).not.toContain("realestate");
    expect(qqq.sectors).toHaveLength(10);
    expect(qqq.government).toBeNull();
  });

  test("a bare exchange code has no symbol, a suffixed one keeps it", async () => {
    const icga = (await parsed("topholdings-icga-de")).fund!;
    const by = (name: string) => icga.holdings.find((h) => h.name === name);
    expect(by("Tencent Holdings Ltd")?.symbol).toBe("0700.HK");
    expect(by("China Construction Bank Corp Class H")).toEqual({
      symbol: null,
      name: "China Construction Bank Corp Class H",
      weight: 0.0431594,
    });
    expect(icga.holdings.filter((h) => h.symbol === null)).toHaveLength(4);
  });

  test("a negative cash position is kept, bond ratings leave US government out", async () => {
    const vfiax = (await parsed("topholdings-vfiax")).fund!;
    expect(vfiax.positions.cash).toBe(-0.0011999999);
    expect(vfiax.positions.stock).toBe(1.0004001);
    const agg = (await parsed("topholdings-agg")).fund!;
    expect(agg.government).toBe(0.4929);
    expect(agg.ratings.map((r) => r.key)).toEqual(["aa", "aaa", "a", "bbb"]);
    expect(agg.ratings.reduce((s, r) => s + r.weight, 0)).toBeCloseTo(1, 3);
    expect(agg.positions.bond).toBe(0.9918);
    expect(agg.sectors).toEqual([]);
  });

  test("a fund without holdings keeps its sectors, and no ratio is read", async () => {
    const xcha = await parsed("topholdings-xcha-de");
    expect(xcha.fund!.holdings).toEqual([]);
    expect(xcha.fund!.sectors).toHaveLength(11);
    expect(xcha.fund!.positions.stock).toBe(1);
    const all = JSON.stringify([
      xcha,
      await parsed("topholdings-qqq"),
      await parsed("topholdings-agg"),
    ]);
    for (const field of ["priceToEarnings", "duration", "maturity", "maxAge"]) {
      expect(all).not.toContain(field);
    }
    expect((await fund("topholdings-qqq")).equityHoldings).toBeDefined();
  });

  test("an answer with its price alone has no top holdings", async () => {
    for (const name of ["topholdings-tvbetetf-ro", "topholdings-aapl"]) {
      const answer = await parsed(name);
      expect(answer.fund).toBeNull();
    }
    expect((await parsed("topholdings-tvbetetf-ro")).symbol).toBe(
      "TVBETETF.RO",
    );
  });

  test("a weight that is not a fraction drops its row, never reads as zero", async () => {
    const answer = await edited("topholdings-qqq", (t) => {
      t.holdings[1].holdingPercent = { raw: 3, fmt: "300%" };
      t.holdings[2].holdingPercent = {};
      t.sectorWeightings[4].technology = { raw: 60.33 };
      t.bondRatings[0].us_government = { raw: "0.5" };
      t.cashPosition = { raw: 2 };
    });
    const f = answer.fund!;
    expect(f.holdings.map((h) => h.symbol)).toEqual([
      "NVDA",
      "MU",
      "AMD",
      "AMZN",
      "META",
      "GOOGL",
      "GOOG",
      "TSLA",
    ]);
    expect(f.sectors.map((s) => s.key)).not.toContain("technology");
    expect(f.government).toBeNull();
    expect(f.positions.cash).toBeNull();
    expect(f.positions.stock).toBe(0.9976);
  });

  test("a name comes back on one line and cut, a key with a space is dropped", async () => {
    const long = `Alpha\nBeta\t\u0007 ${"x".repeat(200)}`;
    const answer = await edited("topholdings-qqq", (t) => {
      t.holdings[0].holdingName = long;
      t.sectorWeightings.push({ "real estate": { raw: 0.5 } });
      t.sectorWeightings.push({ Energy: { raw: 0.5 } });
    });
    const name = answer.fund!.holdings[0]!.name;
    expect(name).toStartWith("Alpha Beta x");
    expect(name).not.toMatch(/\p{Cc}/u);
    expect(name).toHaveLength(HOLDING_NAME_MAX);
    expect(name).toEndWith("…");
    const keys = answer.fund!.sectors.map((s) => s.key);
    expect(keys).not.toContain("real estate");
    expect(keys).not.toContain("Energy");
  });

  test("a list that is not a list is malformed, an empty one an answer", async () => {
    for (const field of ["holdings", "sectorWeightings", "bondRatings"]) {
      const fx = clone(await recorded("topholdings-qqq"));
      fx.body.quoteSummary.result[0].topHoldings[field] = "not an array";
      expect(() => parseTopHoldings(fx.body, NOW)).toThrow(field);
    }
    const empty = await edited("topholdings-qqq", (t) => {
      t.holdings = [];
    });
    expect(empty.fund!.holdings).toEqual([]);
  });

  test("an answer without a top holdings object is malformed", async () => {
    const fx = clone(await recorded("topholdings-qqq"));
    fx.body.quoteSummary.result[0].topHoldings = "none";
    expect(() => parseTopHoldings(fx.body, NOW)).toThrow("no top holdings");
  });
});

function client(route: Route = () => undefined) {
  const clock = fakeClock(NOW);
  const session = yahooSession();
  const calls = queue(clock, 2);
  const f = fakeFetch(
    async (url, headers) =>
      (await route(url, headers)) ?? session.answer(url, headers),
  );
  return { f, session, y: yahoo({ clock, fetch: f.fetch, queue: calls }) };
}

const asks = (urls: URL[]) =>
  urls.map((u) =>
    u.hostname === "fc.yahoo.com"
      ? "cookie"
      : u.pathname === "/v1/test/getcrumb"
        ? "crumb"
        : `${summarySymbol(u)} ${u.searchParams.get("modules")}`,
  );

describe("the top holdings call", () => {
  test("shares the valuation's session, whose answers do not change", async () => {
    const { f, y, session } = client();
    const before = await y.valuation("TSM");
    expect((await y.topHoldings("QQQ")).fund?.holdings).toHaveLength(10);
    session.revoke();
    expect((await y.topHoldings("ICGA.DE")).symbol).toBe("ICGA.DE");
    const after = await y.valuation("TSM");
    expect({ ...after, fetchedAt: 0 }).toEqual({ ...before, fetchedAt: 0 });
    expect(asks(f.urls)).toEqual([
      "cookie",
      "crumb",
      "TSM defaultKeyStatistics,price",
      "QQQ topHoldings,price",
      "ICGA.DE topHoldings,price",
      "cookie",
      "crumb",
      "ICGA.DE topHoldings,price",
      "TSM defaultKeyStatistics,price",
    ]);
    expect(y.backoff()).toBeNull();
  });

  test("an answer naming another symbol is malformed, a 500 a source error", async () => {
    const other = client(async (url) => {
      if (summarySymbol(url) === null) return undefined;
      const fx = clone(await recorded("topholdings-qqq"));
      fx.body.quoteSummary.result[0].price.symbol = "QQQM";
      return fx;
    });
    const error = await other.y.topHoldings("QQQ").catch((e: unknown) => e);
    expect((error as SourceError).phrase).toBe("malformed answer");
    const down = client((url) =>
      summarySymbol(url) === null ? undefined : failing,
    );
    const failed = await down.y.topHoldings("QQQ").catch((e: unknown) => e);
    expect((failed as SourceError).phrase).toBe("source error");
    expect(String(failed)).not.toContain(CRUMB);
    expect(down.y.backoff()).toBeNull();
  });
});

const stored = (
  db: Db,
  symbol: string,
  fields: Partial<Parameters<typeof upsertInstrument>[1]> = {},
): Instrument =>
  upsertInstrument(
    db,
    {
      market: "US",
      symbol,
      source: "yahoo",
      sourceSymbol: symbol,
      exchange: "PCX",
      name: symbol,
      type: "ETF",
      currency: "USD",
      unit: "per_share",
      zone: "America/New_York",
      ...fields,
    },
    NOW,
  );

describe("the top holdings job", () => {
  function setup(route: Route = () => undefined) {
    const clock = fakeClock(NOW);
    const { db } = open(":memory:", clock);
    const session = yahooSession();
    const f = fakeFetch(
      async (url, headers) =>
        (await route(url, headers)) ?? session.answer(url, headers),
    );
    const lines: string[] = [];
    const y = yahoo({ clock, fetch: f.fetch });
    const ctx = { db, clock, writer: writer(db), yahoo: y };
    const log = logger(
      clock,
      () => [],
      (line) => lines.push(line),
    )("yahoo");
    stored(db, "QQQ");
    stored(db, "VFIAX", { type: "MUTUALFUND", exchange: "NAS" });
    stored(db, "NVDA", { type: "EQUITY", exchange: "NMS" });
    stored(db, "FND", { source: "owner", market: "FUND", type: "FUND" });
    stored(db, "TVBETETF", {
      market: "RO",
      source: "bvb",
      exchange: "BVB",
      currency: "RON",
      zone: "Europe/Bucharest",
    });
    const ids = ["US:QQQ", "US:VFIAX", "US:NVDA", "FUND:FND", "RO:TVBETETF"];
    markRead(db, ids, NOW);
    const summaries = () =>
      f.urls.filter((u) => summarySymbol(u) !== null).map(summarySymbol);
    // no Finnhub: the job is Yahoo's alone
    const m = markets({
      db,
      clock,
      writer: ctx.writer,
      yahoo: y,
      fred: null,
      log: silent,
    });
    return {
      clock,
      db,
      ctx,
      m,
      lines,
      summaries,
      jobs: topHoldingsJobs({ ctx, log }),
    };
  }

  test("asks each tracked fund Yahoo prices once a day, with Finnhub off", async () => {
    const t = setup();
    expect((await t.jobs.tick()).asked).toEqual(["US:QQQ", "US:VFIAX"]);
    expect((await t.jobs.tick()).asked).toEqual([]);
    expect(readTopHoldings(t.db, "US:QQQ")?.holdings).toHaveLength(10);
    // past the next 23:00 UTC
    await t.clock.advance(DAY_MS);
    expect((await t.jobs.tick()).asked).toEqual(["US:QQQ", "US:VFIAX"]);
    expect(t.summaries()).toEqual(["QQQ", "VFIAX", "QQQ", "VFIAX"]);
  });

  test("a fund another source prices is never asked, and Yahoo has none for it", async () => {
    const t = setup();
    await t.jobs.tick();
    expect(t.summaries()).not.toContain("TVBETETF");
    const bvb = readInstrumentOf(t.db, "RO:TVBETETF");
    expect(topHoldingsSummary(t.m, bvb, undefined)).toEqual({
      source: "yahoo",
      message: NO_TOP_HOLDINGS,
    });
    // an owner-priced fund is no fund Yahoo lists, so it has no answer
    const owned = readInstrumentOf(t.db, "FUND:FND");
    expect(topHoldingsSummary(t.m, owned, undefined)).toBeUndefined();
  });

  test("a 404 deletes the rows and is an answer, asked again the next day", async () => {
    let gone = false;
    const t = setup((url) =>
      gone && summarySymbol(url) === "QQQ" ? notFound : undefined,
    );
    await t.jobs.tick();
    await t.clock.advance(DAY_MS);
    gone = true;
    const pass = await t.jobs.tick();
    expect(pass.failed).toEqual([]);
    expect(readTopHoldings(t.db, "US:QQQ")).toBeNull();
    const rows = t.db
      .query<{ n: number }, []>(
        `select (select count(*) from fund_top_holding_rows where instrument = 'US:QQQ')
           + (select count(*) from fund_weights where instrument = 'US:QQQ') as n`,
      )
      .get()!;
    expect(rows.n).toBe(0);
    const qqq = readInstrumentOf(t.db, "US:QQQ");
    expect(topHoldingsSummary(t.m, qqq, undefined)).toEqual({
      source: "yahoo",
      message: NO_TOP_HOLDINGS,
      fetched_at: expect.any(String),
      stale: [],
    });
    expect((await t.jobs.tick()).asked).toEqual([]);
  });

  test("a fund Yahoo answers with its price alone keeps nothing, and runs well", async () => {
    const t = setup();
    const listed = stored(t.db, "TVBETETF.RO", {
      market: "RO",
      exchange: "BVB",
      currency: "RON",
      zone: "Europe/Bucharest",
    });
    expect(await refreshTopHoldings(t.ctx, listed)).toEqual({
      status: "ok",
      rows: 0,
    });
    expect(topHoldingsSummary(t.m, listed, undefined)).toMatchObject({
      message: NO_TOP_HOLDINGS,
    });
  });

  test("a fund with rows stored keeps them when Yahoo drops the module", async () => {
    let dropped = false;
    const t = setup(async (url) =>
      dropped && summarySymbol(url) === "QQQ"
        ? recorded("topholdings-tvbetetf-ro").then((fx) => {
            const out = clone(fx);
            out.body.quoteSummary.result[0].price.symbol = "QQQ";
            return out;
          })
        : undefined,
    );
    await t.jobs.tick();
    await t.clock.advance(DAY_MS);
    dropped = true;
    expect((await t.jobs.tick()).failed).toEqual([
      { instrument: "US:QQQ", error: "malformed answer" },
    ]);
    expect(readTopHoldings(t.db, "US:QQQ")?.holdings).toHaveLength(10);
    const qqq = readInstrumentOf(t.db, "US:QQQ");
    expect(topHoldingsSummary(t.m, qqq, undefined)).toMatchObject({
      stale: [STALE_RESEARCH.failed],
    });
  });

  test("a fund with rows stored keeps them when Yahoo answers an empty module", async () => {
    let empty = false;
    const t = setup(async (url) => {
      if (!empty || summarySymbol(url) !== "QQQ") return undefined;
      const out = clone(await recorded("topholdings-qqq"));
      out.body.quoteSummary.result[0].topHoldings = { maxAge: 1 };
      return out;
    });
    await t.jobs.tick();
    await t.clock.advance(DAY_MS);
    empty = true;
    expect((await t.jobs.tick()).failed).toEqual([
      { instrument: "US:QQQ", error: "malformed answer" },
    ]);
    expect(readTopHoldings(t.db, "US:QQQ")?.holdings).toHaveLength(10);
    const fx = clone(await recorded("topholdings-qqq"));
    fx.body.quoteSummary.result[0].topHoldings = { maxAge: 1 };
    expect(parseTopHoldings(fx.body, NOW).fund).toBeNull();
  });

  test("a failure keeps the rows and their time, waits an hour and logs no session", async () => {
    let down = false;
    const t = setup((url) =>
      down && summarySymbol(url) !== null ? failing : undefined,
    );
    await t.jobs.tick();
    const fetchedAt = readTopHoldings(t.db, "US:QQQ")!.fetchedAt;
    await t.clock.advance(DAY_MS);
    down = true;
    expect((await t.jobs.tick()).failed).toEqual([
      { instrument: "US:QQQ", error: "source error" },
      { instrument: "US:VFIAX", error: "source error" },
    ]);
    expect(readTopHoldings(t.db, "US:QQQ")?.fetchedAt).toBe(fetchedAt);
    expect(t.ctx.yahoo.backoff()).toBeNull();
    expect((await t.jobs.tick()).asked).toEqual([]);
    await t.clock.advance(RETRY_MS + MINUTE_MS);
    expect((await t.jobs.tick()).asked).toEqual(["US:QQQ", "US:VFIAX"]);
    expect(t.lines.some((l) => l.includes("top holdings failed"))).toBe(true);
    for (const line of t.lines) {
      expect(line).not.toContain(CRUMB);
      expect(line).not.toContain("made-up-session");
    }
  });

  test("a tick waiting on another fetch asks nothing that fetch stored", async () => {
    const t = setup();
    const qqq = readInstrumentOf(t.db, "US:QQQ");
    const [inline] = await Promise.all([
      refreshTopHoldings(t.ctx, qqq),
      t.jobs.tick(),
    ]);
    expect(inline?.status).toBe("ok");
    expect(t.summaries()).toEqual(["QQQ", "VFIAX"]);
  });

  test("the status page names the job in plain words", () => {
    expect(jobLabel("yahoo", "top_holdings")).toBe("Top holdings");
    expect(jobAbout("yahoo", "top_holdings")).toContain("mutual fund");
  });
});

const readInstrumentOf = (db: Db, id: string): Instrument =>
  readInstrument(db, id)!;

describe("the top holdings answer", () => {
  async function setup(options: { hold?: Route } = {}) {
    const clock = fakeClock(NOW);
    const { db } = open(":memory:", clock);
    const chart = listed(await recorded("chart-nvda-5y-1d"));
    const charts: Record<string, Recorded> = {};
    for (const [symbol, type] of [
      ["QQQ", "ETF"],
      ["VFIAX", "MUTUALFUND"],
    ] as const) {
      const c = clone(chart);
      c.body.chart.result[0].meta.symbol = symbol;
      c.body.chart.result[0].meta.instrumentType = type;
      charts[symbol] = c;
    }
    const s = await sources({
      charts,
      hold: async (url) => options.hold?.(url, new Headers()),
    });
    const m = markets({
      db,
      clock,
      writer: writer(db),
      yahoo: yahoo({ clock, fetch: s.fetch }),
      fred: null,
      log: silent,
    });
    stored(db, "QQQ");
    stored(db, "VFIAX", { type: "MUTUALFUND", exchange: "NAS" });
    stored(db, "NVDA", { type: "EQUITY", exchange: "NMS" });
    const ask = async (args: Record<string, unknown>) =>
      drive(clock, pacedOf(m), researchAnswer(m, parseResearch(args)));
    const tool = async (symbol: string, section?: string) =>
      body(await ask({ symbol, ...(section ? { section } : {}) }));
    const rest = async (path: string) => {
      const res = await drive(
        clock,
        pacedOf(m),
        api(m)(new Request(`http://markets.test/api/v1/${path}`)),
      );
      return (await res.json()) as any;
    };
    const holdings = () =>
      s.calls
        .summaries()
        .filter((u) => holdingsAsked(u))
        .map(summarySymbol);
    return { clock, db, m, ask, tool, rest, holdings };
  }

  test("a fund never fetched is fetched in the call, in percent, ids joined", async () => {
    const t = await setup();
    const answer = await t.tool("QQQ", "top_holdings");
    expect(answer).toMatchObject({
      id: "US:QQQ",
      section: "top_holdings",
      source: "yahoo",
      stale: [],
      top_weight_percent: 46.69,
      assets: {
        stock_percent: 99.76,
        bond_percent: 0,
        cash_percent: 0.24,
        other_percent: 0,
        preferred_percent: 0,
        convertible_percent: 0,
      },
      bond_ratings: [],
      government_bonds_percent: null,
      note: TOP_ONLY,
    });
    expect(answer.top[0]).toEqual({
      rank: 1,
      symbol: "NVDA",
      id: "US:NVDA",
      name: "NVIDIA Corp",
      weight_percent: 8.33,
    });
    // a symbol no stored instrument has is no id
    expect(answer.top[1]).toMatchObject({ symbol: "AAPL", id: null });
    expect(answer.sectors[0]).toEqual({
      sector: "technology",
      weight_percent: 60.33,
    });
    expect(answer.sectors.map((s: any) => s.sector)).not.toContain(
      "realestate",
    );
    expect(JSON.stringify(answer)).not.toContain("equityHoldings");
    expect(JSON.stringify(answer)).not.toContain(CRUMB);
    expect(t.holdings()).toEqual(["QQQ"]);
    // stored now: the next call asks nothing
    const vfiax = await t.tool("VFIAX", "top_holdings");
    expect(vfiax.assets.cash_percent).toBe(-0.12);
    await t.tool("QQQ", "top_holdings");
    expect(t.holdings()).toEqual(["QQQ", "VFIAX"]);
    // a day on, no refresh since the 23:00 UTC due time
    await t.clock.advance(DAY_MS);
    expect((await t.tool("QQQ", "top_holdings")).stale).toEqual([
      STALE_RESEARCH.pending,
    ]);
  });

  test("a fund's overview carries it beside the quote, a share's has none", async () => {
    const t = await setup();
    const qqq = await t.tool("QQQ");
    expect(Object.keys(qqq).slice(0, 7)).toEqual([
      "id",
      "name",
      "type",
      "currency",
      "section",
      "quote",
      "top_holdings",
    ]);
    expect(qqq.top_holdings.top).toHaveLength(10);
    const nvda = await t.tool("NVDA");
    expect(nvda).not.toContainKey("top_holdings");
    expect(await t.tool("NVDA", "top_holdings")).toMatchObject({
      id: "US:NVDA",
      source: "yahoo",
      message: NOT_A_FUND,
    });
    expect(t.holdings()).toEqual(["QQQ"]);
    const paged = t.ask({ symbol: "QQQ", section: "top_holdings", next: "x" });
    await expect(paged).rejects.toThrow("top_holdings has no next page");
  });

  test("a fund Yahoo has none for says so, and is asked again only the next day", async () => {
    const t = await setup({
      hold: (url) => (summarySymbol(url) === "QQQ" ? notFound : undefined),
    });
    const answer = await t.tool("QQQ", "top_holdings");
    expect(answer).toMatchObject({ message: NO_TOP_HOLDINGS, stale: [] });
    expect(answer).not.toContainKey("error");
    await t.tool("QQQ", "top_holdings");
    expect(t.holdings()).toEqual(["QQQ"]);
  });

  test("a fund that failed within the retry wait is not asked again inline", async () => {
    let down = true;
    const t = await setup({
      hold: (url) => (down && holdingsAsked(url) ? failing : undefined),
    });
    const first = await t.tool("QQQ", "top_holdings");
    expect(first).toMatchObject({
      error: "source_error",
      stale: [STALE_RESEARCH.none, STALE_RESEARCH.failed],
      top: [],
    });
    down = false;
    const again = await t.tool("QQQ", "top_holdings");
    expect(again).not.toContainKey("error");
    expect(again.stale).toEqual([STALE_RESEARCH.none, STALE_RESEARCH.failed]);
    expect((await t.rest("instruments/QQQ")).top_holdings.stale).toEqual(
      again.stale,
    );
    expect(t.holdings()).toEqual(["QQQ"]);
    await t.clock.advance(RETRY_MS);
    expect((await t.tool("QQQ", "top_holdings")).top).toHaveLength(10);
    expect(t.holdings()).toEqual(["QQQ", "QQQ"]);
  });

  test("a fetch past the deadline says it is pending, and its late failure gates the next", async () => {
    const held = gate();
    const t = await setup({
      hold: async (url) => {
        if (!holdingsAsked(url)) return undefined;
        await held.hold();
        return failing;
      },
    });
    const call = t.ask({ symbol: "QQQ", section: "top_holdings" });
    await held.arrived;
    await t.clock.advance(t.m.callMs);
    const late = body(await call);
    expect(late).toMatchObject({ error: "timeout", top: [] });
    expect(late.stale).toEqual([STALE_RESEARCH.none, STALE_RESEARCH.pending]);
    held.release();
    await t.m.inflight.get("top_holdings:US:QQQ")?.promise.catch(() => {});
    expect(lastStarted(t.db, "yahoo", "top_holdings", "US:QQQ")?.status).toBe(
      "failed",
    );
    await t.tool("QQQ", "top_holdings");
    expect(t.holdings()).toEqual(["QQQ"]);
  });

  test("the instrument route fetches a fund's top holdings beside its quote", async () => {
    const t = await setup();
    const route = await t.rest("instruments/QQQ");
    expect(route.quote.id).toBe("US:QQQ");
    const {
      id: _,
      name: __,
      type: ___,
      currency: ____,
      section: _____,
      ...tool
    } = await t.tool("QQQ", "top_holdings");
    expect(route.top_holdings).toEqual(tool);
    expect(t.holdings()).toEqual(["QQQ"]);
    expect(await t.rest("instruments/NVDA")).not.toContainKey("top_holdings");
  });

  test("the research route answers it only when asked, as the tool does", async () => {
    const t = await setup();
    const plain = await t.rest("research?symbols=QQQ,NVDA");
    for (const item of plain.research) {
      expect(item).not.toContainKey("top_holdings");
    }
    expect(t.holdings()).toEqual([]);
    const asked = await t.rest(
      "research?symbols=QQQ,NVDA&sections=top_holdings",
    );
    const [qqq, nvda] = asked.research;
    expect(Object.keys(qqq)).toEqual(["input", "id", "top_holdings"]);
    const {
      id: _,
      name: __,
      type: ___,
      currency: ____,
      section: _____,
      ...tool
    } = await t.tool("QQQ", "top_holdings");
    expect(qqq.top_holdings).toEqual(tool);
    expect(nvda.top_holdings).toEqual({ source: "yahoo", message: NOT_A_FUND });
    expect(t.holdings()).toEqual(["QQQ"]);
  });

  test("the refetch part asks a fund again, anything else is not covered", async () => {
    const t = await setup();
    await t.tool("QQQ", "top_holdings");
    const refetch = async (symbol: string) => {
      const res = await drive(
        t.clock,
        pacedOf(t.m),
        api(t.m)(
          new Request(
            `http://markets.test/api/v1/instruments/${symbol}/refetch`,
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ parts: ["top_holdings"] }),
            },
          ),
        ),
      );
      return ((await res.json()) as any).parts;
    };
    expect(await refetch("QQQ")).toEqual([
      { part: "top_holdings", status: "fetched", rows: 21 },
    ]);
    expect(await refetch("NVDA")).toEqual([
      { part: "top_holdings", status: "not covered" },
    ]);
    expect(t.holdings()).toEqual(["QQQ", "QQQ"]);
  });
});
