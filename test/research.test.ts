// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { open } from "../src/db/index.ts";
import { finnhub } from "../src/finnhub/client.ts";
import { NO_DATA, NO_EVENTS, NOT_COVERED } from "../src/finnhub/store.ts";
import { silent } from "../src/log.ts";
import { PAGE_BYTES } from "../src/tools/answer.ts";
import { eventsAnswer, parseEvents } from "../src/tools/events.ts";
import {
  NEWS_PENDING,
  parseResearch,
  researchAnswer,
  researchTargets,
} from "../src/tools/research.ts";
import { CALL_MS, markets } from "../src/tools/targets.ts";
import { lastReadAt } from "../src/tracking.ts";
import { writer } from "../src/writer.ts";
import { yahoo } from "../src/yahoo/client.ts";
import { type TestApp, withApp } from "./helpers/app.ts";
import { fakeClock } from "./helpers/clock.ts";
import { drive, FINNHUB_KEY, finnhubAnswer } from "./helpers/finnhub.ts";
import { gate, NOW, sources } from "./helpers/sources.ts";
import type { Recorded } from "./helpers/yahoo.ts";

type Hold = (url: URL) => Promise<Recorded | undefined> | undefined;

async function setup(options: { hold?: Hold; off?: boolean } = {}) {
  const clock = fakeClock(NOW);
  const { db } = open(":memory:", clock);
  const s = await sources({
    hold: async (url) => (await options.hold?.(url)) ?? finnhubAnswer(url),
  });
  const write = writer(db);
  const m = markets({
    db,
    clock,
    writer: write,
    yahoo: yahoo({ clock, fetch: s.fetch }),
    fred: null,
    finnhub: options.off
      ? null
      : finnhub({ clock, key: FINNHUB_KEY, fetch: s.fetch }),
    log: silent,
  });
  const finnhubCalls = () =>
    s.calls.urls.filter((u) => u.hostname === "finnhub.io");
  return { clock, db, m, calls: s.calls, finnhubCalls };
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
    expect(b.news).toEqual({ message: NEWS_PENDING });
    expect(finnhubCalls()).toHaveLength(5);
    expect(lastReadAt(db, "US:NVDA")).not.toBeNull();
    await researchAnswer(m, parseResearch({ symbol: "US:NVDA" }));
    expect(finnhubCalls()).toHaveLength(5);
  });

  test("two reads naming the same new share share one fetch", async () => {
    const { clock, m, finnhubCalls } = await setup();
    await drive(
      clock,
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
    await drive(clock, held.arrived);
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
        researchAnswer(t.m, parseResearch({ symbol: "^GSPC" })),
      ),
    );
    expect(index.research).toEqual({ source: "finnhub", message: NOT_COVERED });
    expect(t.finnhubCalls()).toHaveLength(0);

    const off = await setup({ off: true });
    const nvda = body(
      await drive(
        off.clock,
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
  options: { off?: boolean } = {},
) {
  const s = await sources({ hold: (url) => finnhubAnswer(url) });
  return withApp(
    async (t) => {
      await drive(t.clock, researchTargets(t.app.markets, ["NVDA"]));
      await fn(t, s.calls.urls);
    },
    {
      fetch: s.fetch,
      start: NOW,
      ...(options.off ? {} : { finnhubKey: FINNHUB_KEY }),
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
      expect(news.body.message).toBe(NEWS_PENDING);
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
