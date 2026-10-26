// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { start } from "../src/app.ts";
import { DAY_MS, MINUTE_MS } from "../src/clock.ts";
import { type Db, open } from "../src/db/index.ts";
import { type Instrument, upsertInstrument } from "../src/instruments.ts";
import { keys } from "../src/keys.ts";
import { format, logger, silent } from "../src/log.ts";
import {
  checkCursor,
  HOST,
  massive,
  PAGE_LIMIT,
  parseNews,
  SPACING_MS,
  utc,
} from "../src/massive/client.ts";
import { massiveJobs } from "../src/massive/jobs.ts";
import {
  backfillBefore,
  eligible,
  KEPT_MS,
  MAX_PAGES,
  type MassiveContext,
  massiveSymbol,
  newsState,
  OVERLAP_MS,
  pruneNews,
  readNews,
  refreshNews,
  rowFor,
  STALE_NEWS,
} from "../src/massive/store.ts";
import { lastRun } from "../src/runs.ts";
import { SourceError } from "../src/source.ts";
import { markRead } from "../src/tracking.ts";
import { writer } from "../src/writer.ts";
import { fakeClock } from "./helpers/clock.ts";
import { drive } from "./helpers/drive.ts";
import {
  type FakeMassive,
  MASSIVE_KEY,
  made,
  massiveAnswer,
  massiveFixture,
  recordedArticles,
  series,
} from "./helpers/massive.ts";
import { NOW } from "./helpers/sources.ts";
import { fakeFetch } from "./helpers/yahoo.ts";

const HOUR_MS = 60 * MINUTE_MS;

function setup(fake: FakeMassive = { articles: [] }) {
  const clock = fakeClock(NOW);
  const { db } = open(":memory:", clock);
  const write = writer(db);
  // the fake clock's time at each call's start
  const starts: number[] = [];
  const f = fakeFetch((url) => {
    starts.push(clock.now());
    return massiveAnswer(fake, url);
  });
  const client = massive({ clock, key: MASSIVE_KEY, fetch: f.fetch });
  const ctx: MassiveContext = { db, clock, writer: write, massive: client };
  const go = <T>(p: Promise<T>) => drive(clock, client, p);
  return { clock, db, write, f, starts, client, ctx, fake, go };
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

const newsRows = (db: Db, id: string) =>
  count(db, "select count(*) as n from news where instrument = ?", id);

describe("massive answers", () => {
  test("the recordings parse, each ticker keeping its own sentiment", async () => {
    for (const name of [
      "news-latest",
      "news-latest-page2",
      "news-nvda-older",
      "news-nvda-year-old",
    ]) {
      const fx = await massiveFixture(name);
      const page = parseNews(fx.body);
      expect(page.articles).toHaveLength(fx.body.count);
      // the recorded cursors are Massive's own and hold no key
      expect(checkCursor(page.next!, HOST, MASSIVE_KEY).pathname).toBe(
        "/v2/reference/news",
      );
    }
    const [first, , third] = parseNews(
      (await massiveFixture("news-nvda-older")).body,
    ).articles;
    expect(first).toMatchObject({
      id: "f18cb22b7d36e9adc6ec926b1cd5a576a3a565625b96fd32374e367374c14087",
      publishedAt: Date.parse("2026-08-31T23:15:00Z"),
      publisher: "The Motley Fool",
    });
    expect(first!.url).toStartWith("https://www.fool.com/");
    expect(rowFor(first!, "NVDA", NOW)).toMatchObject({
      sentiment: "positive",
      reasoning: expect.stringContaining("106% year-over-year"),
    });
    expect(rowFor(first!, "GOOG", NOW)?.sentiment).toBe("negative");
    expect(rowFor(third!, "NVDA", NOW)?.sentiment).toBe("neutral");
    expect(rowFor(third!, "VOO", NOW)?.sentiment).toBe("positive");
  });

  test("only an exact ticker matches, and no insight is no sentiment", async () => {
    const [jpm] = parseNews(
      (await massiveFixture("news-nvda-year-old")).body,
    ).articles;
    expect(jpm!.tickers).toContain("JPMpC");
    expect(rowFor(jpm!, "JPM", NOW)?.sentiment).toBe("neutral");
    expect(rowFor(jpm!, "JP", NOW)).toBeNull();
    expect(rowFor(jpm!, "JPMP", NOW)).toBeNull();
    expect(rowFor(jpm!, "nvda", NOW)).toBeNull();
    // listed, with no insight for it: null, never neutral by default
    const listed = { ...jpm!, tickers: [...jpm!.tickers, "TLV"] };
    expect(rowFor(listed, "TLV", NOW)).toMatchObject({
      sentiment: null,
      reasoning: null,
    });
    // a word Massive does not use is no sentiment either
    const body = (await massiveFixture("news-nvda-older")).body;
    body.results[0].insights[0].sentiment = "bullish";
    expect(
      rowFor(parseNews(body).articles[0]!, "NVDA", NOW)?.sentiment,
    ).toBeNull();
  });

  test("a malformed answer is an error, never an empty page", async () => {
    expect(() => parseNews({ results: "no" })).toThrow("malformed answer");
    const body = (await massiveFixture("news-latest")).body;
    delete body.results[1].published_utc;
    expect(() => parseNews(body)).toThrow("malformed answer");
    expect(() => parseNews({ status: "ERROR" })).toThrow("source error");
    const bad = (await massiveFixture("news-latest")).body;
    bad.results[0].article_url = "javascript:alert(1)";
    expect(() => parseNews(bad)).toThrow("malformed answer");
  });

  test("a cursor goes out only to Massive's own news path, with no key in it", () => {
    const ok = `${HOST}/v2/reference/news?cursor=abc`;
    expect(checkCursor(ok, HOST, MASSIVE_KEY).href).toBe(ok);
    for (const bad of [
      "http://api.massive.com/v2/reference/news?cursor=abc",
      "https://api.massive.com.evil.example/v2/reference/news?cursor=abc",
      "https://evil.example/v2/reference/news?cursor=abc",
      "https://api.massive.com/v3/reference/tickers?cursor=abc",
      "https://user:pw@api.massive.com/v2/reference/news?cursor=abc",
      "https://api.massive.com/v2/reference/news?cursor=abc&apiKey=x",
      "https://api.massive.com/v2/reference/news?cursor=abc&APIKEY=x",
      `https://api.massive.com/v2/reference/news?cursor=${MASSIVE_KEY}`,
      "not a url",
    ]) {
      expect(() => checkCursor(bad, HOST, MASSIVE_KEY)).toThrow(
        "malformed answer",
      );
    }
  });

  test("a page naming a foreign next_url is refused, and nothing is sent there", async () => {
    const t = setup({
      articles: await series("NVDA", 150, NOW - HOUR_MS, HOUR_MS),
      nextUrl: (c) => `https://evil.example/v2/reference/news?cursor=${c}`,
    });
    const error = await t.go(
      t.client
        .news({ ticker: "NVDA", after: NOW - KEPT_MS })
        .catch((e: unknown) => e),
    );
    expect(String(error)).toContain("malformed answer");
    await expect(
      t.client.next("https://evil.example/v2/reference/news?cursor=x"),
    ).rejects.toThrow("malformed answer");
    for (const url of t.f.urls) expect(url.hostname).toBe("api.massive.com");
  });

  test("the key goes only in its header, never in a URL or an error", async () => {
    const t = setup({ articles: await series("NVDA", 3, NOW, HOUR_MS) });
    const page = await t.go(
      t.client.news({ ticker: "NVDA", after: NOW - DAY_MS }),
    );
    expect(page.articles).toHaveLength(3);
    const url = t.f.urls[0]!;
    expect(url.pathname).toBe("/v2/reference/news");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      ticker: "NVDA",
      "published_utc.gt": "2026-10-24T21:05:00Z",
      order: "desc",
      sort: "published_utc",
      limit: String(PAGE_LIMIT),
    });
    for (const h of t.f.headers) {
      expect(h.get("authorization")).toBe(`Bearer ${MASSIVE_KEY}`);
    }
    const failing = massive({
      clock: t.clock,
      key: MASSIVE_KEY,
      fetch: async (u) => {
        throw new Error(`fetch failed for ${u} with ${MASSIVE_KEY}`);
      },
    });
    const error = await drive(
      t.clock,
      failing,
      failing
        .news({ ticker: "NVDA", after: NOW - DAY_MS })
        .catch((e: unknown) => e),
    );
    expect(error).toBeInstanceOf(SourceError);
    expect(String(error)).toBe("SourceError: network error");
    for (const u of t.f.urls) expect(u.href).not.toContain(MASSIVE_KEY);
  });

  test("a 429 pauses the source, and a tool then fails at once asking nothing", async () => {
    const t = setup({ articles: [], status: 429 });
    await expect(
      t.client.news({ ticker: "NVDA", after: NOW - DAY_MS }),
    ).rejects.toThrow("rate limited");
    const asked = t.f.urls.length;
    await expect(
      t.client.failFast().news({ ticker: "NVDA", after: NOW - DAY_MS }),
    ).rejects.toThrow("rate limited");
    expect(t.f.urls).toHaveLength(asked);
    t.fake.status = 401;
    await t.clock.advance(5 * MINUTE_MS);
    await expect(
      t.client.news({ ticker: "NVDA", after: NOW - DAY_MS }),
    ).rejects.toThrow("key refused");
  });
});

describe("eligibility", () => {
  test("US shares and ETFs only, a class share in Massive's form", () => {
    expect(eligible({ market: "US", type: "EQUITY" })).toBe(true);
    expect(eligible({ market: "US", type: "ETF" })).toBe(true);
    for (const [market, type] of [
      ["US", "INDEX"],
      ["US", "FUTURE"],
      ["CCY", "CURRENCY"],
      ["CRYPTO", "CRYPTOCURRENCY"],
      ["FRED", "SERIES"],
      ["XETRA", "ETF"],
      ["BVB", "EQUITY"],
    ]) {
      expect(eligible({ market: market!, type: type! })).toBe(false);
    }
    expect(massiveSymbol({ symbol: "BRK-B" })).toBe("BRK.B");
  });
});

describe("news per ticker", () => {
  test("the first run asks the last 30 days, then from the newest stored less the overlap, never storing one twice", async () => {
    const t = setup({ articles: await series("NVDA", 20, NOW, HOUR_MS) });
    const nvda = share(t.db, "NVDA", NOW);
    const first = await t.go(refreshNews(t.ctx, nvda));
    expect(first).toMatchObject({ status: "ok", rows: 20, complete: true });
    expect(t.f.urls[0]!.searchParams.get("published_utc.gt")).toBe(
      "2026-09-25T21:05:00Z",
    );
    expect(newsRows(t.db, nvda.id)).toBe(20);
    expect(backfillBefore(t.db, nvda.id)).toBeNull();
    expect(lastRun(t.db, "massive", "news", nvda.id)).toMatchObject({
      status: "ok",
      rows: 20,
    });

    // two new ones, and one published late with an earlier time
    t.fake.articles.push(
      ...(await series("NVDA", 2, NOW + 25 * MINUTE_MS, MINUTE_MS, 100)),
      ...(await series("NVDA", 1, NOW - 90 * MINUTE_MS, 0, 200)),
    );
    await t.clock.advance(30 * MINUTE_MS);
    const second = await t.go(refreshNews(t.ctx, nvda));
    expect(t.f.urls[1]!.searchParams.get("published_utc.gt")).toBe(
      utc(NOW - OVERLAP_MS),
    );
    // the overlap answers the stored ones again; they stay one row each
    expect(second.rows).toBe(5);
    expect(newsRows(t.db, nvda.id)).toBe(23);
    const ids = readNews(t.db, nvda.id, 100).map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("an article whose tickers only start with the symbol is not its news", async () => {
    const [base] = await recordedArticles();
    const t = setup({
      prefix: true,
      articles: [
        made(base, 1, NOW - HOUR_MS, {
          tickers: ["JPM", "JPMpC"],
          insights: [
            { ticker: "JPMpC", sentiment: "negative" },
            { ticker: "JPM", sentiment: "positive", sentiment_reasoning: "r" },
          ],
        }),
        made(base, 2, NOW - 2 * HOUR_MS, {
          tickers: ["JPMpC", "JPMpD"],
          insights: [{ ticker: "JPMpC", sentiment: "negative" }],
        }),
      ],
    });
    const jpm = share(t.db, "JPM", NOW);
    await t.go(refreshNews(t.ctx, jpm));
    const rows = readNews(t.db, jpm.id, 10);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ sentiment: "positive", reasoning: "r" });
  });

  test("a walk follows next_url only while its pages are newer than the floor", async () => {
    const t = setup({
      ignoreAfter: true,
      articles: await series("NVDA", 150, NOW, 6 * HOUR_MS),
    });
    const nvda = share(t.db, "NVDA", NOW);
    await t.go(refreshNews(t.ctx, nvda));
    // 120 articles inside 30 days at one every 6 hours: two pages, the
    // second reaching past the floor, and nothing older kept
    expect(t.f.urls).toHaveLength(2);
    expect(t.f.urls[1]!.searchParams.has("cursor")).toBe(true);
    expect(newsRows(t.db, nvda.id)).toBe(120);
    expect(backfillBefore(t.db, nvda.id)).toBeNull();
  });

  test("more than a run's pages go on below where it stopped on the next runs", async () => {
    const total = MAX_PAGES * PAGE_LIMIT + 120;
    const t = setup({
      articles: await series("NVDA", total, NOW, 2 * 60_000 * 25),
    });
    const nvda = share(t.db, "NVDA", NOW);
    const first = await t.go(refreshNews(t.ctx, nvda));
    expect(first).toMatchObject({
      status: "ok",
      rows: MAX_PAGES * PAGE_LIMIT,
      pages: MAX_PAGES,
      complete: false,
    });
    const before = backfillBefore(t.db, nvda.id);
    expect(before).toBe(
      Math.min(...readNews(t.db, nvda.id, 1000).map((r) => r.publishedAt)),
    );
    expect(newsState(t.db, nvda.id, t.clock.now()).stale).toEqual([
      STALE_NEWS.older,
    ]);

    await t.clock.advance(30 * MINUTE_MS);
    const asked = t.f.urls.length;
    const second = await t.go(refreshNews(t.ctx, nvda));
    expect(second).toMatchObject({ status: "ok", complete: true });
    const urls = t.f.urls.slice(asked);
    // the top first, then down from where the first run stopped
    expect(urls[0]!.searchParams.has("published_utc.lt")).toBe(false);
    expect(urls[1]!.searchParams.get("published_utc.lt")).toBe(utc(before!));
    const inWindow = t.fake.articles.filter(
      (a) => Date.parse(a.published_utc) > NOW + 30 * MINUTE_MS - KEPT_MS,
    ).length;
    expect(newsRows(t.db, nvda.id)).toBeGreaterThanOrEqual(inWindow);
    expect(backfillBefore(t.db, nvda.id)).toBeNull();
    expect(newsState(t.db, nvda.id, t.clock.now()).stale).toEqual([]);
  });

  test("one failing ticker is stale alone and keeps the pages it got", async () => {
    const t = setup({ articles: await series("NVDA", 5, NOW, HOUR_MS) });
    const nvda = share(t.db, "NVDA", NOW);
    const amd = share(t.db, "AMD", NOW);
    await t.go(refreshNews(t.ctx, nvda));
    t.fake.status = 500;
    const failed = await t.go(refreshNews(t.ctx, amd));
    expect(failed).toMatchObject({ status: "failed", rows: 0 });
    expect(lastRun(t.db, "massive", "news", amd.id)?.error).toBe(
      "source error",
    );
    const now = t.clock.now();
    expect(newsState(t.db, amd.id, now).stale).toEqual([
      STALE_NEWS.none,
      STALE_NEWS.failed,
    ]);
    expect(newsState(t.db, nvda.id, now).stale).toEqual([]);
    expect(newsRows(t.db, nvda.id)).toBe(5);
    // an hour on without a good run, its news is pending
    expect(newsState(t.db, nvda.id, now + 61 * MINUTE_MS).stale).toEqual([
      STALE_NEWS.pending,
    ]);
  });

  test("retention keeps 30 days by published time, and tracked tickers only", async () => {
    const t = setup({
      articles: [
        ...(await series("NVDA", 3, NOW, 10 * DAY_MS)),
        ...(await series("AMD", 2, NOW, DAY_MS, 50)),
      ],
    });
    const nvda = share(t.db, "NVDA", NOW);
    const amd = share(t.db, "AMD", NOW - 20 * DAY_MS);
    await t.go(refreshNews(t.ctx, nvda));
    await t.go(refreshNews(t.ctx, amd));
    expect(newsRows(t.db, nvda.id)).toBe(3);
    expect(newsRows(t.db, amd.id)).toBe(2);
    const later = NOW + 15 * DAY_MS;
    pruneNews(t.db, later, new Set([nvda.id]));
    // 0, 10 and 20 days old at NOW: 15 days on, the 20-day one is past 30
    expect(readNews(t.db, nvda.id, 10).map((r) => r.publishedAt)).toEqual([
      NOW,
      NOW - 10 * DAY_MS,
    ]);
    expect(newsRows(t.db, amd.id)).toBe(0);
  });
});

describe("the news job", () => {
  test("asks each tracked US share and ETF every 30 minutes, nothing else", async () => {
    const t = setup({
      articles: [
        ...(await series("NVDA", 3, NOW, HOUR_MS)),
        ...(await series("QQQ", 2, NOW, HOUR_MS, 10)),
      ],
    });
    share(t.db, "NVDA", NOW);
    share(t.db, "QQQ", NOW, { type: "ETF" });
    share(t.db, "^GSPC", NOW, { type: "INDEX" });
    share(t.db, "VVSM", NOW, { market: "XETRA", type: "ETF" });
    share(t.db, "OLD", NOW - 40 * DAY_MS);
    const jobs = massiveJobs({ ctx: t.ctx, log: silent });
    const first = await t.go(jobs.tick());
    expect(first.asked.map((a) => a.instrument).sort()).toEqual([
      "US:NVDA",
      "US:QQQ",
    ]);
    expect(t.f.urls.map((u) => u.searchParams.get("ticker")).sort()).toEqual([
      "NVDA",
      "QQQ",
    ]);
    // one call a ticker a run: within the period nothing is due
    await t.clock.advance(20 * MINUTE_MS);
    expect((await jobs.tick()).asked).toEqual([]);
    await t.clock.advance(10 * MINUTE_MS);
    const next = await t.go(jobs.tick());
    expect(next.asked).toHaveLength(2);
    expect(t.f.urls).toHaveLength(4);
  });

  test("a job and a tool share one limiter, 13 s between starts", async () => {
    const t = setup({
      articles: [
        ...(await series("NVDA", 3, NOW, HOUR_MS)),
        ...(await series("AMD", 3, NOW, HOUR_MS, 10)),
        ...(await series("TSLA", 3, NOW, HOUR_MS, 20)),
      ],
    });
    const [nvda, amd] = ["NVDA", "AMD"].map((s) => share(t.db, s, NOW));
    const tool = t.client.within(() => true);
    await t.go(
      Promise.all([
        refreshNews(t.ctx, nvda!),
        refreshNews(t.ctx, amd!, { client: tool, maxPages: 1 }),
        t.client.failFast().news({ ticker: "TSLA", after: NOW - DAY_MS }),
      ]),
    );
    expect(t.starts).toHaveLength(3);
    for (let k = 1; k < t.starts.length; k++) {
      expect(t.starts[k]! - t.starts[k - 1]!).toBeGreaterThanOrEqual(
        SPACING_MS,
      );
    }
  });

  test("a tick asks no page past its budget; the rest come next tick", async () => {
    const names = Array.from({ length: 8 }, (_, k) => `ZZ${k}`);
    const articles: any[] = [];
    for (const [k, s] of names.entries()) {
      articles.push(...(await series(s, 2, NOW, HOUR_MS, k * 10)));
    }
    const t = setup({ articles });
    for (const s of names) share(t.db, s, NOW);
    const jobs = massiveJobs({ ctx: t.ctx, log: silent });
    const first = await t.go(jobs.tick());
    expect(first.asked.length).toBeLessThan(8);
    expect(t.clock.now() - NOW).toBeLessThan(MINUTE_MS);
    await t.clock.advance(MINUTE_MS);
    const second = await t.go(jobs.tick());
    await t.clock.advance(MINUTE_MS);
    const third = await t.go(jobs.tick());
    expect(
      new Set(
        [...first.asked, ...second.asked, ...third.asked].map(
          (a) => a.instrument,
        ),
      ).size,
    ).toBe(8);
    // a ticker the budget cut before its page has no run
    expect(
      count(
        t.db,
        "select count(*) as n from sync_runs where source = 'massive'",
      ),
    ).toBe(8);
  });
});

describe("massive source", () => {
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
      massiveKey: store.source("massive"),
      fetch: async (url) => {
        throw new Error(`no network in tests: ${url} ${MASSIVE_KEY}`);
      },
    });
    return { a, db, clock };
  };

  test("off without a key file, and the start log says so", async () => {
    const { a, db } = app(mkdtempSync(join(tmpdir(), "massive-off-")));
    try {
      expect(a.massive).toBeNull();
      expect(a.massiveJobs).toBeNull();
      expect(format(0, "markets", "info", "sources", a.sources)).toContain(
        'massive="off (no key)"',
      );
    } finally {
      await a.stop();
      db.close();
    }
  });

  test("on with a key file; the key never reaches a log line or a row", async () => {
    const dir = mkdtempSync(join(tmpdir(), "massive-on-"));
    writeFileSync(join(dir, "source-massive.key"), `${MASSIVE_KEY}\n`);
    const lines: string[] = [];
    const { a, db, clock } = app(dir, lines);
    try {
      expect(a.massive).not.toBeNull();
      expect(format(0, "markets", "info", "sources", a.sources)).toContain(
        'massive="on (key file)"',
      );
      await a.writer.write((db) => {
        share(db, "NVDA", clock.now());
        share(db, "AMD", clock.now());
      });
      // every call fails with an error quoting the key
      const pass = await drive(clock, a.massive!, a.massiveJobs!.tick());
      expect(pass.failed.length).toBeGreaterThan(0);
      for (const f of pass.failed) expect(f.error).toBe("network error");
      expect(lines.length).toBeGreaterThan(0);
      for (const l of lines) expect(l).not.toContain(MASSIVE_KEY);
      for (const table of ["sync_runs", "news", "news_backfill"]) {
        const rows = JSON.stringify(db.query(`select * from ${table}`).all());
        expect(rows).not.toContain(MASSIVE_KEY);
      }
    } finally {
      await a.stop();
      db.close();
    }
  });
});
