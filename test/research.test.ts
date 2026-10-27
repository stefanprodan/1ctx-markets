// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { DAY_MS, MINUTE_MS } from "../src/clock.ts";
import { open } from "../src/db/index.ts";
import { finnhub } from "../src/finnhub/client.ts";
import { finnhubJobs } from "../src/finnhub/jobs.ts";
import {
  kindColumns,
  NO_DATA,
  NO_EVENTS,
  NOT_COVERED,
  OTHER_LISTING,
  refreshResearch,
  STALE_RESEARCH,
} from "../src/finnhub/store.ts";
import { readInstrument, upsertInstrument } from "../src/instruments.ts";
import { silent } from "../src/log.ts";
import { MAX_TITLE, massive, PAGE_LIMIT } from "../src/massive/client.ts";
import { NEWS_NOT_COVERED, NO_NEWS, STALE_NEWS } from "../src/massive/store.ts";
import { fits, iso, PAGE_BYTES } from "../src/tools/answer.ts";
import {
  eventsAnswer,
  parseEvents,
  UNAVAILABLE_BYTES,
} from "../src/tools/events.ts";
import {
  HEADLINES,
  HTTP_HISTORY,
  parseResearch,
  researchAnswer,
  researchHandler,
  researchTargets,
} from "../src/tools/research.ts";
import { CALL_MS, markets } from "../src/tools/targets.ts";
import { lastReadAt, markRead } from "../src/tracking.ts";
import { writer } from "../src/writer.ts";
import { yahoo } from "../src/yahoo/client.ts";
import { type TestApp, withApp } from "./helpers/app.ts";
import { fakeClock } from "./helpers/clock.ts";
import { drive, pacedOf } from "./helpers/drive.ts";
import { FINNHUB_KEY, finnhubAnswer } from "./helpers/finnhub.ts";
import {
  type FakeMassive,
  MASSIVE_KEY,
  massiveAnswer,
  series,
} from "./helpers/massive.ts";
import { gate, NOW, sources } from "./helpers/sources.ts";
import { clone, listed, type Recorded, recorded } from "./helpers/yahoo.ts";

type Hold = (url: URL) => Promise<Recorded | undefined> | undefined;

async function setup(
  options: {
    hold?: Hold;
    off?: boolean;
    massive?: FakeMassive;
    charts?: Record<string, Recorded>;
  } = {},
) {
  const clock = fakeClock(NOW);
  const { db } = open(":memory:", clock);
  const fake = options.massive;
  const s = await sources({
    charts: options.charts,
    hold: async (url) =>
      (await options.hold?.(url)) ??
      (await finnhubAnswer(url)) ??
      (fake === undefined ? undefined : massiveAnswer(fake, url)),
  });
  const write = writer(db);
  const fh = options.off
    ? null
    : finnhub({ clock, key: FINNHUB_KEY, fetch: s.fetch });
  const ms =
    fake === undefined
      ? null
      : massive({ clock, key: MASSIVE_KEY, fetch: s.fetch });
  const m = markets({
    db,
    clock,
    writer: write,
    yahoo: yahoo({ clock, fetch: s.fetch }),
    fred: null,
    finnhub: fh,
    massive: ms,
    log: silent,
  });
  const finnhubCalls = () =>
    s.calls.urls.filter((u) => u.hostname === "finnhub.io");
  const massiveCalls = () =>
    s.calls.urls.filter((u) => u.hostname === "api.massive.com");
  return {
    clock,
    db,
    m,
    fh,
    ms,
    write,
    calls: s.calls,
    finnhubCalls,
    massiveCalls,
  };
}

const body = (r: { content: { text: string }[] }) =>
  JSON.parse(r.content[0]!.text);

const count = (db: ReturnType<typeof open>["db"], table: string) =>
  (db.query(`select count(*) as n from ${table}`).get() as { n: number }).n;

describe("research inside the call", () => {
  test("a share never researched is fetched within the deadline, then read from the store", async () => {
    const t = setup();
    const { clock, db, m, finnhubCalls } = await t;
    const answer = await drive(
      clock,
      pacedOf(m),
      researchAnswer(m, parseResearch({ symbol: "NVDA" })),
    );
    expect(clock.now() - NOW).toBeLessThan(CALL_MS);
    expect(answer.isError).toBeUndefined();
    const b = body(answer);
    expect(b).toMatchObject({ id: "US:NVDA", section: "overview" });
    expect(b.quote.price).toBeNumber();
    expect(b.quote.signals.daily).not.toBeNull();
    expect(b.research.metric).toMatchObject({
      forward_pe: 17.0219,
      pe_ttm: 26.3592,
      beta: 2.26942,
      stale: [],
    });
    expect(b.research.analysts).toMatchObject({
      period: "2026-10-01",
      strong_buy: 25,
      buy: 41,
    });
    expect(b.research.earnings).toMatchObject({
      period: "2026-09-30",
      eps_actual: 2.22,
      surprise_percent: 3.8159,
    });
    expect(b.research.insider).toMatchObject({
      period: "2026-10-01",
      change: -500000,
      mspr: -100,
    });
    expect(b.research.next_event).toMatchObject({
      fiscal_year: 2027,
      fiscal_quarter: 3,
      date: "2026-11-17",
      hour: "amc",
      status: "scheduled",
    });
    expect(b.news).toEqual({ source: "massive", message: NO_NEWS });
    expect(finnhubCalls()).toHaveLength(5);
    expect(lastReadAt(db, "US:NVDA")).not.toBeNull();
    await researchAnswer(m, parseResearch({ symbol: "US:NVDA" }));
    expect(finnhubCalls()).toHaveLength(5);
  });

  test("two reads naming the same new share share one fetch", async () => {
    const { clock, m, finnhubCalls } = await setup();
    await drive(
      clock,
      pacedOf(m),
      Promise.all([
        researchTargets(m, ["NVDA"]),
        researchTargets(m, ["US:NVDA", "nvda"]),
      ]),
    );
    expect(finnhubCalls()).toHaveLength(5);
  });

  test("not done by the deadline answers timeout and stores nothing", async () => {
    const held = gate();
    const { clock, db, m, finnhubCalls } = await setup({
      hold: (url) =>
        url.pathname === "/api/v1/stock/earnings" ? held.hold() : undefined,
    });
    const answer = researchAnswer(m, parseResearch({ symbol: "NVDA" }));
    await drive(clock, pacedOf(m), held.arrived);
    await clock.advance(CALL_MS);
    const b = body(await answer);
    expect(b.research).toMatchObject({ error: "timeout" });
    expect(b.research.message).toContain("retry this symbol");
    // the quote came in time and is answered
    expect(b.quote.price).toBeNumber();
    const flights = [...m.inflight.values()].map((f) =>
      f.promise.catch(() => {}),
    );
    held.release();
    await Promise.all(flights);
    expect(finnhubCalls()).toHaveLength(3);
    expect(count(db, "research")).toBe(0);
    expect(count(db, "events")).toBe(0);
    expect(
      db.query("select * from sync_runs where source = 'finnhub'").all(),
    ).toEqual([]);
  });

  test("an index is not asked, and Finnhub off answers no data", async () => {
    const t = await setup();
    const index = body(
      await drive(
        t.clock,
        pacedOf(t.m),
        researchAnswer(t.m, parseResearch({ symbol: "^GSPC" })),
      ),
    );
    expect(index.research).toEqual({ source: "finnhub", message: NOT_COVERED });
    expect(t.finnhubCalls()).toHaveLength(0);

    const off = await setup({ off: true });
    const nvda = body(
      await drive(
        off.clock,
        pacedOf(off.m),
        researchAnswer(off.m, parseResearch({ symbol: "NVDA" })),
      ),
    );
    expect(nvda.research).toEqual({ source: "finnhub", message: NO_DATA });
    expect(nvda.quote.price).toBeNumber();
    const events = body(
      await eventsAnswer(
        off.m,
        parseEvents({ from: "2026-10-01", to: "2026-12-31" }),
      ),
    );
    expect(events).toMatchObject({ message: NO_EVENTS, events: [] });
  });
});

type Answer = { isError: boolean; body: any; bytes: number };

async function call(t: TestApp, name: string, args: unknown): Promise<Answer> {
  const res = await fetch(`${t.url}/mcp`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${t.bearer}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2025-06-18",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
  expect(res.status).toBe(200);
  const raw = await res.text();
  const message = raw.match(/^data: (.*)$/m)?.[1] ?? raw;
  const result = JSON.parse(message).result;
  expect(result.content).toHaveLength(1);
  const text: string = result.content[0].text;
  expect(Buffer.byteLength(message)).toBeLessThan(PAGE_BYTES);
  return {
    isError: result.isError === true,
    body: JSON.parse(text),
    bytes: Buffer.byteLength(message),
  };
}

// an app on the recordings with NVDA read and researched
async function researchApp(
  fn: (t: TestApp, urls: URL[]) => Promise<void>,
  options: { off?: boolean; massive?: FakeMassive } = {},
) {
  const fake = options.massive;
  const s = await sources({
    hold: async (url) =>
      (await finnhubAnswer(url)) ??
      (fake === undefined ? undefined : massiveAnswer(fake, url)),
  });
  return withApp(
    async (t) => {
      await drive(
        t.clock,
        pacedOf(t.app.markets),
        researchTargets(t.app.markets, ["NVDA"]),
      );
      await fn(t, s.calls.urls);
    },
    {
      fetch: s.fetch,
      start: NOW,
      ...(options.off ? {} : { finnhubKey: FINNHUB_KEY }),
      ...(fake === undefined ? {} : { massiveKey: MASSIVE_KEY }),
    },
  );
}

const MONTHS = (n: number) =>
  Array.from({ length: n }, (_, k) => {
    const d = new Date(Date.UTC(2026, 9 - k, 1));
    return d.toISOString().slice(0, 10);
  });

describe("the research and events tools", () => {
  test("check their arguments before anything is fetched", () =>
    researchApp(async (t, urls) => {
      const asked = urls.length;
      const bad: [string, unknown, string][] = [
        ["research", {}, "symbol must be a non-empty string"],
        [
          "research",
          { symbol: "NVDA", section: "valuation" },
          "section must be one of overview, analysts, earnings, insiders, news",
        ],
        ["research", { symbol: "NVDA", limit: 3 }, "unknown argument limit"],
        [
          "research",
          { symbol: "NVDA", next: "x~0000000000" },
          "overview has no next page",
        ],
        [
          "research",
          { symbol: "NVDA", section: "earnings", next: "x~0000000000" },
          "next does not continue",
        ],
        ["events", { from: "2026-10-01" }, "to must be a date"],
        ["events", { to: "2026-10-01" }, "from must be a date"],
        [
          "events",
          { from: "2026-11-01", to: "2026-10-01" },
          "from is after to",
        ],
        [
          "events",
          { from: "2026-10-01", to: "2026-11-01", symbols: [] },
          "symbols must be a list of 1 to 100",
        ],
      ];
      for (const [name, args, message] of bad) {
        const a = await call(t, name, args);
        expect(a.isError).toBe(true);
        expect(a.body.error).toBe("bad_arguments");
        expect(a.body.message).toContain(message);
      }
      expect(urls).toHaveLength(asked);
    }));

  test("research sections page their history newest first, each page under 32 KiB", () =>
    researchApp(async (t) => {
      const periods = MONTHS(600);
      const insert = t.db.query(
        `insert or replace into research (instrument, kind, period,
           insider_change, mspr, fetched_at) values ('US:NVDA', 'insider', ?, ?, ?, ?)`,
      );
      for (const [k, p] of periods.entries())
        insert.run(p, -1000 * k, -50, NOW);
      const seen: string[] = [];
      let next: string | null = null;
      let pages = 0;
      do {
        const a = await call(t, "research", {
          symbol: "US:NVDA",
          section: "insiders",
          ...(next === null ? {} : { next }),
        });
        expect(a.isError).toBe(false);
        expect(a.body).toMatchObject({ id: "US:NVDA", section: "insiders" });
        expect(a.body.stale).toEqual([]);
        for (const r of a.body.rows) seen.push(r.period);
        next = a.body.next;
        pages++;
      } while (next !== null && pages < 20);
      expect(pages).toBeGreaterThan(1);
      expect(seen).toEqual(periods);
      const earnings = await call(t, "research", {
        symbol: "US:NVDA",
        section: "earnings",
      });
      expect(earnings.body.rows.map((r: any) => r.period)).toEqual([
        "2026-09-30",
        "2026-06-30",
        "2026-03-31",
      ]);
      const news = await call(t, "research", {
        symbol: "US:NVDA",
        section: "news",
      });
      expect(news.body.message).toBe(NO_NEWS);
    }));

  test("events answers a range with each status, paged", () =>
    researchApp(async (t) => {
      const a = await call(t, "events", {
        from: "2026-10-01",
        to: "2026-12-31",
      });
      expect(a.isError).toBe(false);
      expect(a.body.events).toEqual([
        expect.objectContaining({
          id: "US:NVDA",
          fiscal_year: 2027,
          fiscal_quarter: 3,
          date: "2026-11-17",
          hour: "amc",
          status: "scheduled",
          eps_estimate: 2.5263,
          eps_actual: null,
          revenue_estimate: 111356225808,
          currency: "USD",
          stale: [],
        }),
      ]);
      const outside = await call(t, "events", {
        from: "2026-12-01",
        to: "2026-12-31",
      });
      expect(outside.body.events).toEqual([]);
      const named = await call(t, "events", {
        from: "2026-10-01",
        to: "2026-12-31",
        symbols: ["NVDA", "^GSPC"],
      });
      expect(named.body.events).toHaveLength(1);
      expect(named.body.unavailable).toEqual([
        { input: "^GSPC", id: "SNP:^GSPC", message: NOT_COVERED },
      ]);

      const insert = t.db.query(
        `insert into events (instrument, fiscal_year, fiscal_quarter, date,
           hour, eps_estimate, eps_actual, reported_seen_at, fetched_at)
         values ('US:NVDA', ?, ?, ?, 'bmo', 1, ?, ?, ?)`,
      );
      for (let k = 0; k < 400; k++) {
        const year = 1900 + Math.floor(k / 4);
        const date = `${year}-${String((k % 4) * 3 + 1).padStart(2, "0")}-15`;
        const reported = k % 2 === 1;
        insert.run(
          year,
          (k % 4) + 1,
          date,
          reported ? 0 : null,
          reported ? NOW : null,
          NOW,
        );
      }
      const seen: string[] = [];
      let next: string | null = null;
      let pages = 0;
      do {
        const p = await call(t, "events", {
          from: "1899-01-01",
          to: "2100-01-01",
          ...(next === null ? {} : { next }),
        });
        for (const e of p.body.events) {
          seen.push(`${e.fiscal_year}Q${e.fiscal_quarter}`);
          if (e.fiscal_year < 2027) {
            expect(e.status).toBe(
              e.eps_actual === null ? "awaiting results" : "reported",
            );
          }
        }
        next = p.body.next;
        pages++;
      } while (next !== null && pages < 20);
      expect(pages).toBeGreaterThan(1);
      expect(seen).toHaveLength(401);
      expect(new Set(seen).size).toBe(401);
    }));

  test("Finnhub off answers no data and no event source", () =>
    researchApp(
      async (t) => {
        const r = await call(t, "research", { symbol: "US:NVDA" });
        expect(r.body.research).toEqual({
          source: "finnhub",
          message: NO_DATA,
        });
        const e = await call(t, "events", {
          from: "2026-10-01",
          to: "2026-12-31",
        });
        expect(e.body.message).toBe(NO_EVENTS);
      },
      { off: true },
    ));
});

describe("GET /research", () => {
  const get = (t: TestApp, query: string, init: RequestInit = {}) =>
    fetch(`${t.url}/research${query}`, {
      ...init,
      headers: { authorization: `Bearer ${t.bearer}` },
    });

  test("answers compact summaries, at most five symbols", () =>
    researchApp(async (t) => {
      const ok = await get(t, "?symbols=US:NVDA,^GSPC");
      expect(ok.status).toBe(200);
      expect(ok.headers.get("content-type")).toBe("application/json");
      const raw = await ok.text();
      expect(Buffer.byteLength(raw)).toBeLessThan(PAGE_BYTES);
      const { items } = JSON.parse(raw);
      expect(items[0]).toMatchObject({
        input: "US:NVDA",
        id: "US:NVDA",
        kind: "market_quote",
        research: {
          source: "finnhub",
          metric: { forward_pe: 17.0219 },
          analysts: { period: "2026-10-01" },
          next_event: { date: "2026-11-17", status: "scheduled" },
        },
      });
      expect(items[0].price).toBeNumber();
      expect(items[1].research).toEqual({
        source: "finnhub",
        message: NOT_COVERED,
      });
      expect(lastReadAt(t.db, "SNP:^GSPC")).not.toBeNull();

      for (const query of [
        "",
        "?symbols=A,B,C,D,E,F",
        "?symbols=NVDA&symbols=AMD",
        "?symbols=NVDA&section=earnings",
        "?symbols=NVDA,",
      ]) {
        const bad = await get(t, query);
        expect(bad.status).toBe(400);
        expect(((await bad.json()) as { error: string }).error).toBe(
          "bad_arguments",
        );
      }
      const post = await get(t, "?symbols=NVDA", { method: "POST" });
      expect(post.status).toBe(405);
      const none = await fetch(`${t.url}/research?symbols=NVDA`);
      expect(none.status).toBe(401);
    }));
});

const HOUR_MS = 60 * MINUTE_MS;

describe("news inside the call", () => {
  test("a share never asked for news gets its newest page within the deadline, then reads the store", async () => {
    const t = await setup({
      massive: { articles: await series("NVDA", 120, NOW, HOUR_MS) },
    });
    const answer = await drive(
      t.clock,
      pacedOf(t.m),
      researchAnswer(t.m, parseResearch({ symbol: "NVDA" })),
    );
    expect(t.clock.now() - NOW).toBeLessThan(CALL_MS);
    const b = body(answer);
    expect(b.news).toMatchObject({
      source: "massive",
      fetched_at: "2026-10-25T21:05:00Z",
      // the first page is in; the rest of its 30 days come with the job
      stale: [STALE_NEWS.older],
    });
    expect(b.news.headlines).toHaveLength(HEADLINES);
    expect(b.news.headlines[0]).toEqual({
      published_at: "2026-10-25T21:05:00Z",
      title: expect.stringContaining("Jensen Huang"),
      publisher: "The Motley Fool",
      sentiment: "positive",
      truncated: false,
    });
    expect(t.massiveCalls()).toHaveLength(1);
    expect(t.massiveCalls()[0]!.searchParams.get("published_utc.gt")).toBe(
      "2026-09-25T21:05:00Z",
    );
    expect(count(t.db, "news")).toBe(100);
    await drive(
      t.clock,
      pacedOf(t.m),
      researchAnswer(t.m, parseResearch({ symbol: "US:NVDA" })),
    );
    expect(t.massiveCalls()).toHaveLength(1);
  });

  test("not done by the deadline answers timeout and stores nothing", async () => {
    const held = gate();
    const t = await setup({
      massive: { articles: await series("NVDA", 3, NOW, HOUR_MS) },
      hold: (url) =>
        url.hostname === "api.massive.com" ? held.hold() : undefined,
    });
    const answer = researchAnswer(t.m, parseResearch({ symbol: "NVDA" }));
    await drive(t.clock, pacedOf(t.m), held.arrived);
    await t.clock.advance(CALL_MS);
    const b = body(await answer);
    expect(b.news).toMatchObject({ source: "massive", error: "timeout" });
    const flights = [...t.m.inflight.values()].map((f) =>
      f.promise.catch(() => {}),
    );
    held.release();
    await Promise.all(flights);
    expect(count(t.db, "news")).toBe(0);
    expect(
      t.db.query("select * from sync_runs where source = 'massive'").all(),
    ).toEqual([]);
  });

  test("an index is not asked, and Massive off answers no news source", async () => {
    const t = await setup({ massive: { articles: [] } });
    const index = body(
      await drive(
        t.clock,
        pacedOf(t.m),
        researchAnswer(t.m, parseResearch({ symbol: "^GSPC" })),
      ),
    );
    expect(index.news).toEqual({
      source: "massive",
      message: NEWS_NOT_COVERED,
    });
    expect(t.massiveCalls()).toHaveLength(0);
    const off = await setup();
    const news = body(
      await drive(
        off.clock,
        pacedOf(off.m),
        researchAnswer(
          off.m,
          parseResearch({ symbol: "NVDA", section: "news" }),
        ),
      ),
    );
    expect(news).toMatchObject({ section: "news", message: NO_NEWS });
    expect(news.articles).toEqual([]);
  });
});

// a made-up US share stored, so a bare symbol needs no search
const usShare = (db: ReturnType<typeof open>["db"], symbol: string) =>
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

// NVDA's chart answered as other made-up US shares
async function shares(symbols: readonly string[]) {
  const nvda = listed(await recorded("chart-nvda-5y-1d"));
  const out: Record<string, Recorded> = {};
  for (const s of symbols) {
    const c = clone(nvda);
    c.body.chart.result[0].meta.symbol = s;
    out[s] = c;
  }
  return out;
}

describe("events inside the call", () => {
  const range = { from: "2026-10-01", to: "2026-12-31" };

  test("a research pass cut after its first section leaves the calendar to the next call", async () => {
    let limited = true;
    const t = await setup({
      hold: (url) =>
        limited && url.pathname === "/api/v1/stock/recommendation"
          ? Promise.resolve({
              recordedAt: "",
              status: 429,
              headers: {},
              body: {},
            })
          : undefined,
    });
    const first = body(
      await drive(
        t.clock,
        pacedOf(t.m),
        researchAnswer(t.m, parseResearch({ symbol: "NVDA" })),
      ),
    );
    expect(first.research).toMatchObject({ error: "rate_limited" });
    expect(t.finnhubCalls()).toHaveLength(2);
    limited = false;
    await t.clock.advance(5 * MINUTE_MS);
    const events = body(
      await drive(
        t.clock,
        pacedOf(t.m),
        eventsAnswer(t.m, parseEvents({ ...range, symbols: ["NVDA"] })),
      ),
    );
    expect(events.events).toEqual([
      expect.objectContaining({ id: "US:NVDA", date: "2026-11-17" }),
    ]);
    expect(events.unavailable).toBeUndefined();
    expect(t.finnhubCalls().map((u) => u.pathname)).toEqual([
      "/api/v1/stock/metric",
      "/api/v1/stock/recommendation",
      "/api/v1/calendar/earnings",
    ]);
    // a history section fetches only itself
    await drive(
      t.clock,
      pacedOf(t.m),
      researchAnswer(
        t.m,
        parseResearch({ symbol: "NVDA", section: "insiders" }),
      ),
    );
    expect(t.finnhubCalls().at(-1)?.pathname).toBe(
      "/api/v1/stock/insider-sentiment",
    );
    expect(t.finnhubCalls()).toHaveLength(4);
  });

  test("a share whose calendar never ended well is listed under unavailable", async () => {
    const t = await setup({
      hold: (url) =>
        url.pathname === "/api/v1/calendar/earnings"
          ? Promise.resolve({
              recordedAt: "",
              status: 200,
              headers: {},
              body: { earningsCalendar: "none" },
            })
          : undefined,
    });
    const named = body(
      await drive(
        t.clock,
        pacedOf(t.m),
        eventsAnswer(t.m, parseEvents({ ...range, symbols: ["NVDA"] })),
      ),
    );
    expect(named.events).toEqual([]);
    expect(named.unavailable).toEqual([
      {
        input: "NVDA",
        id: "US:NVDA",
        error: "source_error",
        message:
          "no calendar yet: its fetch failed (malformed answer); retry this symbol later",
      },
    ]);
    // a tracked share the jobs have not reached yet
    markRead(t.db, [usShare(t.db, "ZZQ").id], NOW);
    const tracked = body(await eventsAnswer(t.m, parseEvents(range)));
    expect(tracked.unavailable).toEqual([
      expect.objectContaining({ input: "US:NVDA", error: "source_error" }),
      {
        input: "US:ZZQ",
        id: "US:ZZQ",
        message: "no calendar yet: never fetched; retry this symbol later",
      },
    ]);
  });

  test("rows of another listing carry it and one note; a share's own neither", async () => {
    const t = await setup({ charts: await shares(["TSM"]) });
    usShare(t.db, "TSM");
    const other = { listing: "2330.TW", note: OTHER_LISTING };
    const ev = body(
      await drive(
        t.clock,
        pacedOf(t.m),
        eventsAnswer(
          t.m,
          parseEvents({
            from: "2026-10-01",
            to: "2027-01-31",
            symbols: ["TSM", "NVDA"],
          }),
        ),
      ),
    );
    expect(ev.unavailable).toBeUndefined();
    expect(ev.events).toMatchObject([
      {
        id: "US:TSM",
        date: "2026-10-15",
        status: "reported",
        eps_estimate: null,
        eps_actual: null,
        revenue_actual: null,
        ...other,
      },
      { id: "US:NVDA", date: "2026-11-17", status: "scheduled" },
      { id: "US:TSM", date: "2027-01-13", status: "scheduled", ...other },
    ]);
    expect(ev.events[1]).not.toContainKey("listing");
    expect(ev.events[1]).not.toContainKey("note");

    const overview = body(
      await drive(
        t.clock,
        pacedOf(t.m),
        researchAnswer(t.m, parseResearch({ symbol: "TSM" })),
      ),
    );
    expect(overview.research.metric).toMatchObject({
      ...other,
      roe_ttm: 41.19,
      pe_ttm: null,
    });
    expect(overview.research.analysts).toMatchObject({ ...other, buy: 28 });
    expect(overview.research.earnings).toEqual(
      expect.objectContaining({ period: null, message: NO_DATA }),
    );
    expect(overview.research.earnings).not.toContainKey("listing");
    expect(overview.research.insider).not.toContainKey("listing");
    expect(overview.research.next_event).toMatchObject({
      date: "2027-01-13",
      ...other,
    });
    const analysts = body(
      await researchAnswer(
        t.m,
        parseResearch({ symbol: "TSM", section: "analysts" }),
      ),
    );
    expect(analysts).toMatchObject(other);
    expect(analysts.rows).toHaveLength(4);
    expect(analysts.rows[0]).not.toContainKey("listing");
    const insiders = body(
      await researchAnswer(
        t.m,
        parseResearch({ symbol: "TSM", section: "insiders" }),
      ),
    );
    expect(insiders.rows).toHaveLength(8);
    expect(insiders).not.toContainKey("listing");

    const res = await drive(
      t.clock,
      pacedOf(t.m),
      researchHandler(t.m)(
        new Request("http://markets.test/research?symbols=TSM,NVDA"),
      ),
    );
    const { items } = (await res.json()) as { items: any[] };
    expect(items[0].research.metric).toMatchObject(other);
    expect(items[0].research.next_event).toMatchObject(other);
    // counts hold for any listing; per-share figures of another do not
    const { analysts: a, earnings: e, insider: i } = items[0].research;
    expect(a).toMatchObject(other);
    expect(a.history).toHaveLength(2);
    expect(a.history[0]).not.toContainKey("listing");
    expect(e.history).toEqual([]);
    expect(i.history).toHaveLength(3);
    expect(i).not.toContainKey("listing");
    for (const s of ["metric", "analysts", "earnings", "insider"]) {
      expect(items[1].research[s]).not.toContainKey("listing");
      expect(items[1].research[s]).not.toContainKey("note");
    }
    expect(items[1].research.next_event).not.toContainKey("listing");
  });

  test("a share whose calendar turned to no data is listed beside its kept events", async () => {
    let deny = false;
    const t = await setup({
      hold: (url) =>
        deny && url.pathname === "/api/v1/calendar/earnings"
          ? Promise.resolve({
              recordedAt: "",
              status: 403,
              headers: {},
              body: {},
            })
          : undefined,
    });
    const ask = (from: string, to: string) =>
      eventsAnswer(t.m, parseEvents({ from, to, symbols: ["NVDA"] }));
    await drive(t.clock, pacedOf(t.m), ask("2026-10-01", "2026-12-31"));
    deny = true;
    await drive(
      t.clock,
      pacedOf(t.m),
      refreshResearch(
        { db: t.db, clock: t.clock, writer: t.write, finnhub: t.fh! },
        readInstrument(t.db, "US:NVDA")!,
        ["calendar"],
      ),
    );
    const note = [{ input: "NVDA", id: "US:NVDA", message: NO_DATA }];
    const kept = body(await ask("2026-10-01", "2026-12-31"));
    expect(kept.events.map((e: { date: string }) => e.date)).toEqual([
      "2026-11-17",
    ]);
    expect(kept.unavailable).toEqual(note);
    const later = body(await ask("2027-01-01", "2027-03-31"));
    expect(later.events).toEqual([]);
    expect(later.unavailable).toEqual(note);
  });

  test("an overview and events for one new share ask its calendar once", async () => {
    const t = await setup();
    await drive(
      t.clock,
      pacedOf(t.m),
      Promise.all([
        researchAnswer(t.m, parseResearch({ symbol: "NVDA" })),
        eventsAnswer(t.m, parseEvents({ ...range, symbols: ["NVDA"] })),
      ]),
    );
    const paths = t.finnhubCalls().map((u) => u.pathname);
    expect(paths.filter((p) => p === "/api/v1/calendar/earnings")).toHaveLength(
      1,
    );
    expect(paths).toHaveLength(5);
  });

  test("events for eleven shares asks one calendar each", async () => {
    const symbols = Array.from({ length: 11 }, (_, k) => `ZZ${k}`);
    const t = await setup({ charts: await shares(symbols) });
    for (const s of symbols) usShare(t.db, s);
    const b = body(
      await drive(
        t.clock,
        pacedOf(t.m),
        eventsAnswer(t.m, parseEvents({ ...range, symbols })),
      ),
    );
    // each answers 403, which is no data for its calendar
    expect(b.unavailable).toEqual(
      symbols.map((s) => ({ input: s, id: `US:${s}`, message: NO_DATA })),
    );
    expect(t.finnhubCalls()).toHaveLength(11);
    expect(new Set(t.finnhubCalls().map((u) => u.pathname))).toEqual(
      new Set(["/api/v1/calendar/earnings"]),
    );
  });
});

describe("a call refused while a source backs off", () => {
  test("names the back-off, never the phrase as its own answer's", async () => {
    let consent = true;
    const t = await setup({
      hold: (url) =>
        consent && url.hostname === "finnhub.io"
          ? Promise.resolve({
              recordedAt: "",
              status: 200,
              headers: {},
              body: "<html>consent</html>",
            })
          : undefined,
    });
    await expect(t.fh!.metric("NVDA")).rejects.toThrow("malformed answer");
    consent = false;
    const b = body(
      await drive(
        t.clock,
        pacedOf(t.m),
        researchAnswer(t.m, parseResearch({ symbol: "NVDA" })),
      ),
    );
    expect(b.research).toMatchObject({
      error: "source_error",
      message:
        "the source is backing off after malformed answer; retry this symbol later",
    });
  });

  const limited = (url: URL, host: string): Promise<Recorded> | undefined =>
    url.hostname === host
      ? Promise.resolve({ recordedAt: "", status: 429, headers: {}, body: {} })
      : undefined;

  test("records no Finnhub run, so the job is not held off", async () => {
    let refuse = true;
    const t = await setup({
      hold: (url) => (refuse ? limited(url, "finnhub.io") : undefined),
    });
    // a job's call is rate limited: the source backs off
    await expect(t.fh!.metric("NVDA")).rejects.toThrow("rate limited");
    refuse = false;
    const b = body(
      await drive(
        t.clock,
        pacedOf(t.m),
        researchAnswer(t.m, parseResearch({ symbol: "NVDA" })),
      ),
    );
    expect(b.research).toMatchObject({ error: "rate_limited" });
    expect(t.finnhubCalls()).toHaveLength(1);
    expect(
      t.db.query("select * from sync_runs where source = 'finnhub'").all(),
    ).toEqual([]);
    // once the back-off is over, the job asks every section
    await t.clock.advance(5 * MINUTE_MS);
    const jobs = finnhubJobs({
      ctx: { db: t.db, clock: t.clock, writer: t.write, finnhub: t.fh },
      log: silent,
    });
    const pass = await drive(t.clock, t.fh!, jobs.tick());
    expect(pass.asked).toEqual([
      {
        instrument: "US:NVDA",
        sections: ["metric", "analysts", "earnings", "insider", "calendar"],
      },
    ]);
    expect(pass.failed).toEqual([]);
  });

  test("records no Massive run, so the next read fetches it", async () => {
    let refuse = true;
    const t = await setup({
      massive: { articles: await series("NVDA", 3, NOW, HOUR_MS) },
      hold: (url) => (refuse ? limited(url, "api.massive.com") : undefined),
    });
    await expect(
      t.ms!.news({ ticker: "NVDA", after: NOW - DAY_MS }),
    ).rejects.toThrow("rate limited");
    refuse = false;
    const b = body(
      await drive(
        t.clock,
        pacedOf(t.m),
        researchAnswer(t.m, parseResearch({ symbol: "NVDA", section: "news" })),
      ),
    );
    expect(b).toMatchObject({ source: "massive", error: "rate_limited" });
    expect(t.massiveCalls()).toHaveLength(1);
    expect(
      t.db.query("select * from sync_runs where source = 'massive'").all(),
    ).toEqual([]);
    await t.clock.advance(5 * MINUTE_MS);
    const again = body(
      await drive(
        t.clock,
        pacedOf(t.m),
        researchAnswer(t.m, parseResearch({ symbol: "NVDA", section: "news" })),
      ),
    );
    expect(again.articles).toHaveLength(3);
    expect(again.stale).toEqual([]);
  });
});

describe("the research news section", () => {
  test("pages the ticker's articles newest first, each page under 32 KiB", async () => {
    const articles = await series("NVDA", 150, NOW, HOUR_MS);
    await researchApp(
      async (t) => {
        const seen: any[] = [];
        let next: string | null = null;
        let pages = 0;
        do {
          const a = await call(t, "research", {
            symbol: "US:NVDA",
            section: "news",
            ...(next === null ? {} : { next }),
          });
          expect(a.isError).toBe(false);
          expect(a.body).toMatchObject({
            id: "US:NVDA",
            section: "news",
            source: "massive",
            fetched_at: expect.stringMatching(/^2026-10-25T21:05:\d\dZ$/),
            stale: [STALE_NEWS.older],
          });
          seen.push(...a.body.articles);
          next = a.body.next;
          pages++;
        } while (next !== null && pages < 20);
        expect(pages).toBeGreaterThan(1);
        // the first page inside the call; older ones come with the job
        expect(seen).toHaveLength(PAGE_LIMIT);
        const times = seen.map((a) => Date.parse(a.published_at));
        expect(times).toEqual([...times].sort((x, y) => y - x));
        expect(new Set(seen.map((a) => a.title)).size).toBe(PAGE_LIMIT);
        expect(seen[0]).toEqual({
          published_at: "2026-10-25T21:05:00Z",
          title: expect.stringContaining("Jensen Huang"),
          publisher: "The Motley Fool",
          url: expect.stringMatching(/^https:\/\/www\.fool\.com\//),
          sentiment: "positive",
          reasoning: expect.stringContaining("106% year-over-year"),
          truncated: false,
        });
        const bad = await call(t, "research", {
          symbol: "US:NVDA",
          section: "news",
          next: "nope~0000000000",
        });
        expect(bad.body.message).toContain("next does not continue");
      },
      { massive: { articles } },
    );
  });
});

describe("answers held to a page", () => {
  test("a section that answered no data keeps its rows and says so", async () => {
    let refused = false;
    const t = await setup({
      hold: (url) =>
        refused && url.pathname.endsWith("/stock/recommendation")
          ? Promise.resolve({
              recordedAt: "",
              status: 403,
              headers: {},
              body: {},
            })
          : undefined,
    });
    await drive(t.clock, pacedOf(t.m), researchTargets(t.m, ["NVDA"]));
    refused = true;
    const nvda = readInstrument(t.db, "US:NVDA")!;
    await drive(
      t.clock,
      t.fh!,
      refreshResearch(
        { db: t.db, clock: t.clock, writer: t.write, finnhub: t.fh },
        nvda,
        ["analysts"],
      ),
    );
    const section = body(
      await researchAnswer(
        t.m,
        parseResearch({ symbol: "US:NVDA", section: "analysts" }),
      ),
    );
    expect(section.rows).toHaveLength(4);
    expect(section.stale).toEqual([STALE_RESEARCH.noData]);
    const overview = body(
      await researchAnswer(t.m, parseResearch({ symbol: "US:NVDA" })),
    );
    expect(overview.research.analysts.stale).toEqual([STALE_RESEARCH.noData]);
  });

  test("the overview with the longest text a headline keeps fits a page", async () => {
    const articles = await series("NVDA", 10, NOW, HOUR_MS);
    for (const a of articles) {
      a.title = "t".repeat(5_000);
      a.publisher = { name: "p".repeat(5_000) };
    }
    const t = await setup({ massive: { articles } });
    const answer = await drive(
      t.clock,
      pacedOf(t.m),
      researchAnswer(t.m, parseResearch({ symbol: "NVDA" })),
    );
    expect(fits(answer.content[0]!.text)).toBe(true);
    const b = body(answer);
    expect(b.news.headlines).toHaveLength(HEADLINES);
    expect(b.news.headlines[0]).toMatchObject({ truncated: true });
    expect(b.news.headlines[0].title).toHaveLength(MAX_TITLE);
  });

  test("events lists what fits of the unavailable symbols and counts the rest", async () => {
    const t = await setup();
    // long names no listing matches: their notes outgrow the share
    const symbols = Array.from(
      { length: 100 },
      (_, k) => `ZZQ${k}${"X".repeat(90)}`,
    );
    const answer = await drive(
      t.clock,
      pacedOf(t.m),
      eventsAnswer(
        t.m,
        parseEvents({ from: "2026-10-01", to: "2026-12-31", symbols }),
      ),
    );
    const text = answer.content[0]!.text;
    expect(fits(text)).toBe(true);
    const b = JSON.parse(text);
    expect(b.unavailable.length).toBeGreaterThan(0);
    expect(b.unavailable.length + b.unavailable_more).toBe(100);
    expect(b.unavailable_more).toBeGreaterThan(0);
    expect(
      Buffer.byteLength(JSON.stringify(b.unavailable)),
    ).toBeLessThanOrEqual(UNAVAILABLE_BYTES);
  });
});

describe("GET /research history", () => {
  const ask = async (t: Awaited<ReturnType<typeof setup>>, symbols: string) => {
    const res = await drive(
      t.clock,
      pacedOf(t.m),
      researchHandler(t.m)(
        new Request(`http://markets.test/research?symbols=${symbols}`),
      ),
    );
    expect(res.status).toBe(200);
    const raw = await res.text();
    return { raw, items: JSON.parse(raw).items as any[] };
  };

  // made-up shares answered as the full recording
  const full = (symbols: readonly string[]) =>
    Object.fromEntries(symbols.map((s) => [s, "nvda"]));

  const addQuarters = (
    db: ReturnType<typeof open>["db"],
    id: string,
    periods: readonly string[],
  ) => {
    const insert = db.query(
      `insert or replace into research (instrument, kind, period,
         eps_estimate, eps_actual, surprise, surprise_percent, fetched_at)
       values (?, 'earnings', ?, 1, 1.02, 0.02, 2, ?)`,
    );
    for (const p of periods) insert.run(id, p, NOW);
  };

  test("insider history holds the newest months that have a row", async () => {
    const t = await setup({
      charts: await shares(["TWO", "EMPTY"]),
      hold: async (url) => {
        const a = await finnhubAnswer(url, full(["TWO"]));
        if (
          a !== undefined &&
          url.searchParams.get("symbol") === "TWO" &&
          url.pathname.endsWith("/insider-sentiment")
        ) {
          a.body.data = a.body.data.slice(-2);
        }
        return a;
      },
    });
    for (const s of ["TWO", "EMPTY"]) usShare(t.db, s);
    await drive(t.clock, pacedOf(t.m), researchTargets(t.m, ["NVDA"]));
    const periods = MONTHS(19);
    const insert = t.db.query(
      `insert or replace into research (instrument, kind, period,
         insider_change, mspr, fetched_at) values ('US:NVDA', 'insider', ?, ?, ?, ?)`,
    );
    for (const [k, p] of periods.entries()) {
      insert.run(p, -1000 * (k + 1), -50, NOW);
    }

    const { items } = await ask(t, "NVDA,TWO,EMPTY");
    const [nvda, two, empty] = items.map((i) => i.research.insider);
    expect(nvda.history).toEqual(
      periods.slice(0, 3).map((period, k) => ({
        period,
        change: -1000 * (k + 1),
        mspr: -50,
        fetched_at: iso(NOW),
      })),
    );
    expect(nvda.period).toBe(periods[0]);
    expect(nvda.mspr).toBe(-50);
    expect(two.history.map((r: any) => r.period)).toEqual([
      "2026-10-01",
      "2026-09-01",
    ]);
    expect(empty).toMatchObject({ period: null, message: NO_DATA });
    expect(empty.history).toEqual([]);
  });

  test("earnings answers four quarters and analysts two months, newest first", async () => {
    const t = await setup();
    await drive(t.clock, pacedOf(t.m), researchTargets(t.m, ["NVDA"]));
    addQuarters(t.db, "US:NVDA", ["2025-12-31", "2025-09-30"]);
    const { items } = await ask(t, "NVDA");
    const { analysts, earnings, metric } = items[0].research;
    expect(
      earnings.history.map((r: any) => [r.period, r.surprise_percent]),
    ).toEqual([
      ["2026-09-30", 3.8159],
      ["2026-06-30", 4.341],
      ["2026-03-31", 3.6203],
      ["2025-12-31", 2],
    ]);
    expect(earnings).toMatchObject({
      period: "2026-09-30",
      surprise_percent: 3.8159,
    });
    expect(analysts.history.map((r: any) => r.period)).toEqual([
      "2026-10-01",
      "2026-09-01",
    ]);
    expect(analysts.history[0]).toEqual({
      period: "2026-10-01",
      strong_buy: analysts.strong_buy,
      buy: analysts.buy,
      hold: analysts.hold,
      sell: analysts.sell,
      strong_sell: analysts.strong_sell,
      fetched_at: analysts.fetched_at,
    });
    expect(metric).not.toContainKey("history");
    const overview = body(
      await researchAnswer(t.m, parseResearch({ symbol: "NVDA" })),
    );
    expect(overview.research.earnings).not.toContainKey("history");
  });

  test("five shares with full history and the longest numbers fit a page", async () => {
    const symbols = ["ZZA", "ZZB", "ZZC", "ZZD", "ZZE"];
    const t = await setup({
      charts: await shares(symbols),
      hold: (url) => finnhubAnswer(url, full(symbols)),
    });
    for (const s of symbols) usShare(t.db, s);
    // one share a call: five need more Finnhub calls than one deadline holds
    for (const s of symbols) {
      await drive(t.clock, pacedOf(t.m), researchTargets(t.m, [s]));
    }
    for (const s of symbols) addQuarters(t.db, `US:${s}`, ["2025-12-31"]);
    // six significant digits at their widest; counts are whole
    for (const kind of ["metric", "analysts", "earnings", "insider"] as const) {
      const value = kind === "analysts" ? 123456789 : -1.23457e-15;
      const set = kindColumns(kind).map((c) => `${c} = ${value}`);
      t.db
        .query(`update research set ${set.join(", ")} where kind = ?`)
        .run(kind);
    }
    const { raw, items } = await ask(t, symbols.join(","));
    expect(fits(raw)).toBe(true);
    for (const i of items) {
      const r = i.research;
      expect(r.analysts.history).toHaveLength(HTTP_HISTORY.analysts);
      expect(r.earnings.history).toHaveLength(HTTP_HISTORY.earnings);
      expect(r.insider.history).toHaveLength(HTTP_HISTORY.insider);
      expect(r.insider.mspr).toBe(-1.23457e-15);
    }
  });
});
