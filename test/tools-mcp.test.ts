// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { upsertBars } from "../src/bars.ts";
import { ATTRIBUTION, NO_DATA } from "../src/fred/sync.ts";
import { readInstrument, upsertInstrument } from "../src/instruments.ts";
import { PAGE_BYTES } from "../src/tools/answer.ts";
import { BASIS } from "../src/tools/history.ts";
import { FIELD_NAMES } from "../src/tools/screen.ts";
import { lastReadAt, markRead } from "../src/tracking.ts";
import { mcpClient, type TestApp, withApp } from "./helpers/app.ts";
import { FRED_KEY, NOW, sources } from "./helpers/sources.ts";

type Answer = { isError: boolean; text: string; body: any; bytes: number };

// one call's answer: exactly one text part, measured as it was sent
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
  const body = JSON.parse(message);
  expect(body.error).toBeUndefined();
  const result = body.result;
  expect(result.content).toHaveLength(1);
  expect(result.content[0].type).toBe("text");
  const text: string = result.content[0].text;
  expect(Buffer.byteLength(text)).toBeLessThan(PAGE_BYTES);
  expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(PAGE_BYTES);
  expect(Buffer.byteLength(message)).toBeLessThan(PAGE_BYTES);
  return {
    isError: result.isError === true,
    text,
    body: JSON.parse(text),
    bytes: Buffer.byteLength(message),
  };
}

const yahooApp = async (
  fn: (t: TestApp, s: Awaited<ReturnType<typeof sources>>) => Promise<void>,
) => {
  const s = await sources();
  return withApp((t) => fn(t, s), {
    fetch: s.fetch,
    start: NOW,
    fredKey: FRED_KEY,
  });
};

describe("the tool list", () => {
  test("names the seven tools, each short and refusing other arguments", () =>
    withApp(async (t) => {
      const client = await mcpClient(t);
      const { tools } = await client.listTools();
      await client.close();
      expect(tools.map((x) => x.name)).toEqual([
        "quote",
        "history",
        "movers",
        "search",
        "screen",
        "research",
        "events",
      ]);
      // an agent learns the fields from the description alone
      const screen = tools.find((x) => x.name === "screen")!;
      for (const name of FIELD_NAMES) {
        expect(screen.description).toContain(name);
      }
      for (const tool of tools) {
        // 1ctx cuts a description at 1,024
        expect(tool.description!.length).toBeLessThan(1024);
        expect(tool.inputSchema.additionalProperties).toBe(false);
        expect(tool.annotations?.readOnlyHint).toBe(true);
      }
    }));
});

describe("arguments", () => {
  test("are checked before anything is fetched", () =>
    yahooApp(async (t, s) => {
      const bad: [string, unknown, string][] = [
        ["quote", {}, "symbols must be a list of 1 to 100 symbols"],
        ["quote", { symbols: [] }, "symbols must be a list"],
        [
          "quote",
          { symbols: Array(101).fill("NVDA") },
          "symbols must be a list",
        ],
        ["quote", { symbols: [""] }, "symbols[0] must be a non-empty string"],
        ["quote", { symbols: ["NVDA"], limit: 3 }, "unknown argument limit"],
        [
          "quote",
          { symbols: ["NVDA"], next: "5~0000000000" },
          "next does not continue",
        ],
        [
          "history",
          { symbol: "NVDA", interval: "1h" },
          "interval must be one of 1d, 1wk",
        ],
        [
          "history",
          { symbol: "NVDA", from: "2026-02-30" },
          "from must be a date",
        ],
        [
          "history",
          { symbol: "NVDA", from: "2026-03-01", to: "2026-02-01" },
          "from is after to",
        ],
        ["history", { symbols: ["NVDA"] }, "unknown argument symbols"],
        ["search", { query: "  " }, "query must be a non-empty string"],
        ["search", { query: "x".repeat(101) }, "query is longer than 100"],
        ["search", { query: "nvda", market: "US" }, "unknown argument market"],
        [
          "screen",
          { symbols: ["NVDA"], filters: [{ field: "pe", max: 20 }] },
          "filters[0].field must be one of the screen fields",
        ],
        [
          "screen",
          { symbols: ["NVDA"], sort: "relative_return_3m" },
          "relative_return fields need a benchmark",
        ],
        [
          "screen",
          { symbols: ["NVDA"], filters: [{ field: "rsi14", max: 30, or: 1 }] },
          "unknown key or",
        ],
        ["movers", { symbols: ["NVDA"] }, "give min_move_pct"],
        [
          "movers",
          { symbols: ["NVDA"], min_move_pct: 2, direction: "flat" },
          "direction must be one of",
        ],
      ];
      for (const [name, args, message] of bad) {
        const a = await call(t, name, args);
        expect(a.isError).toBe(true);
        expect(a.body.error).toBe("bad_arguments");
        expect(a.body.message).toContain(message);
      }
      expect(s.calls.urls).toHaveLength(0);
    }));
});

describe("quote", () => {
  test("fetches a symbol never seen inside the call, tracks it and answers its signals", () =>
    yahooApp(async (t, s) => {
      const a = await call(t, "quote", { symbols: ["NVDA"] });
      expect(a.isError).toBe(false);
      expect(a.body.next).toBeNull();
      expect(a.body.attribution).toBeUndefined();
      const [item] = a.body.items;
      expect(item).toMatchObject({
        input: "NVDA",
        id: "US:NVDA",
        name: "NVIDIA Corporation",
        type: "EQUITY",
        source: "yahoo",
        unit: "per_share",
        currency: "USD",
        kind: "market_quote",
        price: 210.96,
        previous_close: 212.21,
        trade_time: "2026-10-23T20:00:00Z",
        fetched_at: "2026-10-25T21:05:00Z",
      });
      expect(item.change).toBeCloseTo(-1.25, 6);
      expect(item.signals.daily.kind).toMatch(/^(live|final)$/);
      expect(item.signals.daily.date).toBe("2026-10-23");
      expect(item.signals.daily.sma200).toBeNumber();
      expect(item.signals.daily.rsi14).toBeNumber();
      expect(item.signals.daily.ema12).toBeUndefined();
      expect(item.signals.weekly.sma50).toBeNumber();
      expect(Array.isArray(item.stale)).toBe(true);
      expect(lastReadAt(t.db, "US:NVDA")).toBe(NOW);
      // one search, ten years of bars, one quote
      expect(s.calls.searches()).toHaveLength(1);
      expect(s.calls.charts("NVDA")).toHaveLength(1);
      expect(s.calls.sparks()).toHaveLength(1);

      // known now: read again with no source call
      const before = s.calls.urls.length;
      const again = await call(t, "quote", { symbols: ["US:NVDA", "nvda"] });
      expect(again.body.items.map((i: any) => i.id)).toEqual([
        "US:NVDA",
        "US:NVDA",
      ]);
      expect(s.calls.urls.length).toBe(before);
    }));

  test("a name with several listings answers candidates and stores nothing", () =>
    yahooApp(async (t) => {
      const a = await call(t, "quote", { symbols: ["NVIDIA", "NOSUCHNAME"] });
      expect(a.isError).toBe(false);
      const [several, none] = a.body.items;
      expect(several.error).toBe("candidates");
      expect(several.candidates.map((c: any) => c.id)).toContain("US:NVDA");
      expect(several.candidates.map((c: any) => c.id)).toContain("TOR:NVDA");
      expect(none).toMatchObject({ input: "NOSUCHNAME", error: "not_found" });
      expect(readInstrument(t.db, "US:NVDA")).toBeNull();
    }));

  test("a FRED series answers its last observation, a null price and the attribution once", () =>
    yahooApp(async (t) => {
      const a = await call(t, "quote", {
        symbols: ["FRED:DGS10", "fred:dgs10"],
      });
      expect(a.body.attribution).toBe(ATTRIBUTION);
      expect(a.text.split(ATTRIBUTION)).toHaveLength(2);
      for (const item of a.body.items) {
        expect(item).toMatchObject({
          id: "FRED:DGS10",
          kind: "observation",
          price: null,
          observation: { date: "2026-10-22", value: 4.96 },
          unit: "percent",
          trade_time: null,
          change_percent: null,
        });
        expect(item.signals.daily.kind).toBe("final");
      }
    }));

  test("with FRED off answers no data from FRED", () =>
    withApp(async (t) => {
      const a = await call(t, "quote", { symbols: ["FRED:DGS10"] });
      expect(a.isError).toBe(false);
      expect(a.body.items).toEqual([
        { input: "FRED:DGS10", error: "no_data", message: NO_DATA },
      ]);
      expect(a.body.attribution).toBeUndefined();
    }));

  test("pages under 32 KiB by whole items, long UTF-8 names included", () =>
    withApp(async (t) => {
      const name = "Ünïcödé “Holdings” 日本株式会社 \\ ✓ ".repeat(8);
      const ids: string[] = [];
      for (let k = 0; k < 100; k++) {
        const i = upsertInstrument(
          t.db,
          {
            market: "XX",
            symbol: `S${k}`,
            source: "other",
            sourceSymbol: `S${k}`,
            exchange: "XX",
            name: `${name}${k}`,
            type: "EQUITY",
            currency: "EUR",
            unit: "per_share",
            zone: "UTC",
          },
          NOW,
        );
        upsertBars(
          t.db,
          i.id,
          "1d",
          [
            {
              date: "2026-10-23",
              open: 1,
              high: 1,
              low: 1,
              close: 1,
              volume: 1,
              final: true,
            },
          ],
          NOW,
        );
        ids.push(i.id);
      }
      markRead(t.db, ids, NOW);
      const seen: string[] = [];
      let next: string | null = null;
      let pages = 0;
      do {
        const a: Answer = await call(t, "quote", {
          symbols: ids,
          ...(next === null ? {} : { next }),
        });
        expect(a.isError).toBe(false);
        // a page holds as many whole items as fit
        if (a.body.next !== null) {
          expect(a.bytes).toBeGreaterThan(PAGE_BYTES - 2048);
        }
        seen.push(...a.body.items.map((i: any) => i.id));
        next = a.body.next;
        pages++;
      } while (next !== null);
      expect(pages).toBeGreaterThan(2);
      expect(seen).toEqual(ids);
    }));
});

describe("history", () => {
  test("bars oldest first with their final flag, signals, basis and relative return", () =>
    yahooApp(async (t) => {
      const a = await call(t, "history", {
        symbol: "NVDA",
        from: "2026-09-01",
        to: "2026-10-23",
        benchmark: "^GSPC",
      });
      expect(a.isError).toBe(false);
      expect(a.body).toMatchObject({
        id: "US:NVDA",
        interval: "1d",
        from: "2026-09-01",
        to: "2026-10-23",
        basis: BASIS,
        next: null,
      });
      const dates = a.body.bars.map((b: any) => b.date);
      expect(dates[0]).toBe("2026-09-01");
      expect(dates.at(-1)).toBe("2026-10-23");
      expect([...dates].sort()).toEqual(dates);
      expect(a.body.bars[0].final).toBe(true);
      expect(a.body.bars[0].signals.kind).toBe("final");
      expect(a.body.bars[0].signals.sma50).toBeNumber();
      const rel = a.body.relative;
      expect(rel.benchmark).toMatchObject({ id: "SNP:^GSPC", currency: "USD" });
      expect(rel.at).toBe("2026-10-23");
      expect(rel.returns.map((r: any) => r.months)).toEqual([1, 3]);
      const one = rel.returns[0];
      expect(one.relative).toBeNumber();
      // the 23rd is not final yet, and ^GSPC has no live price of that day
      expect(one.instrument).toMatchObject({
        currency: "USD",
        to: "2026-10-22",
      });
      expect(one.live).toBe(false);
      expect(one.benchmark.currency).toBe("USD");
      expect(one.note).toContain("FX conversion excluded");
      // the benchmark counts as read
      expect(lastReadAt(t.db, "SNP:^GSPC")).toBe(NOW);
      // with its own fetch time and staleness
      expect(rel.benchmark.fetched_at).toBe("2026-10-25T21:05:00Z");
      expect(rel.benchmark.stale).toEqual([]);
      expect(rel.stale).toEqual([]);
      t.db.query("delete from quotes where instrument = 'SNP:^GSPC'").run();
      const stale = await call(t, "history", {
        symbol: "NVDA",
        from: "2026-09-01",
        to: "2026-10-23",
        benchmark: "^GSPC",
      });
      expect(stale.body.relative.benchmark.stale).toEqual(["no quote yet"]);
      expect(stale.body.relative.stale).toEqual(["benchmark: no quote yet"]);
    }));

  test("pages ascending and next continues only the same arguments", () =>
    yahooApp(async (t) => {
      const args = { symbol: "NVDA", from: "2021-01-01", to: "2026-10-23" };
      const dates: string[] = [];
      let next: string | null = null;
      let pages = 0;
      do {
        const a: Answer = await call(t, "history", {
          ...args,
          ...(next === null ? {} : { next }),
        });
        dates.push(...a.body.bars.map((b: any) => b.date));
        next = a.body.next;
        pages++;
        if (pages === 1) {
          const other = await call(t, "history", {
            ...args,
            interval: "1wk",
            next,
          });
          expect(other.body.error).toBe("bad_arguments");
        }
      } while (next !== null);
      expect(pages).toBeGreaterThan(5);
      expect(dates).toHaveLength(1255);
      expect(new Set(dates).size).toBe(dates.length);
      expect([...dates].sort()).toEqual(dates);
    }));

  test("an unknown symbol is an error in the same one-part form", () =>
    yahooApp(async (t) => {
      const a = await call(t, "history", { symbol: "NOSUCHNAME" });
      expect(a.isError).toBe(true);
      expect(a.body).toMatchObject({ input: "NOSUCHNAME", error: "not_found" });
    }));
});

describe("screen", () => {
  test("filters and ranks over a benchmark, tracking every symbol named and the benchmark", () =>
    yahooApp(async (t, s) => {
      const a = await call(t, "screen", {
        symbols: ["NVDA", "FRED:DGS10", "NOSUCHNAME"],
        benchmark: "^GSPC",
        filters: [{ field: "rsi14", min: 0, max: 100 }],
        sort: "relative_return_1m",
        order: "desc",
      });
      expect(a.isError).toBe(false);
      expect(a.body).toMatchObject({
        benchmark: { id: "SNP:^GSPC", currency: "USD", stale: [] },
        sort: { field: "relative_return_1m", order: "desc" },
        counts: { matched: 1, not_matched: 0, unavailable: 1, errors: 1 },
        next: null,
      });
      const [nvda, dgs10, none] = a.body.items;
      expect(nvda).toMatchObject({
        id: "US:NVDA",
        status: "matched",
        kind: "market_quote",
        price: 210.96,
        trade_time: "2026-10-23T20:00:00Z",
        fetched_at: "2026-10-25T21:05:00Z",
      });
      expect(nvda.fields.rsi14).toMatchObject({
        kind: "live",
        date: "2026-10-23",
      });
      expect(nvda.fields.relative_return_1m.unit).toBe("percentage points");
      // a yield's level against an index's price has no common unit
      expect(dgs10).toMatchObject({
        id: "FRED:DGS10",
        status: "unavailable",
        missing: ["relative_return_1m"],
      });
      expect(none).toMatchObject({ input: "NOSUCHNAME", error: "not_found" });
      for (const id of ["US:NVDA", "FRED:DGS10", "SNP:^GSPC"]) {
        expect(lastReadAt(t.db, id)).toBe(NOW);
      }
      expect(s.calls.charts("NVDA")).toHaveLength(1);
    }));

  test("a FRED series matches on its final rows, never on a distance to an average", () =>
    yahooApp(async (t) => {
      const a = await call(t, "screen", {
        symbols: ["FRED:DGS10", "NVDA"],
        filters: [
          { field: "rsi14", min: 0 },
          { field: "distance_weekly_sma200", min: -100 },
        ],
      });
      expect(a.body.counts).toMatchObject({ matched: 1, unavailable: 1 });
      expect(a.body.items[0].id).toBe("US:NVDA");
      expect(a.body.items[0].fields.distance_weekly_sma200.kind).toBe("live");
      expect(a.body.items[1]).toMatchObject({
        id: "FRED:DGS10",
        status: "unavailable",
        missing: ["distance_weekly_sma200"],
      });
      const rsi = await call(t, "screen", {
        symbols: ["FRED:DGS10"],
        filters: [{ field: "rsi14", min: 0 }],
      });
      expect(rsi.body.items[0]).toMatchObject({
        id: "FRED:DGS10",
        status: "matched",
        kind: "observation",
        price: null,
        observation: { date: "2026-10-22", value: 4.96 },
      });
      expect(rsi.body.items[0].fields.rsi14.kind).toBe("final");
      expect(rsi.body.attribution).toBe(ATTRIBUTION);
    }));
});

describe("movers", () => {
  test("answers live moves, and a FRED series never moves", () =>
    yahooApp(async (t) => {
      const a = await call(t, "movers", {
        symbols: ["NVDA", "^GSPC", "FRED:DGS10"],
        min_move_pct: 0.5,
        direction: "down",
      });
      expect(a.isError).toBe(false);
      // NVDA -1.25 from 212.21 is -0.589%; ^GSPC -0.467%
      expect(a.body.counts).toEqual({
        matched: 1,
        not_matched: 1,
        unavailable: 1,
        errors: 0,
      });
      expect(a.body.items[0]).toMatchObject({
        id: "US:NVDA",
        status: "matched",
        price: 210.96,
        previous_close: 212.21,
        trade_time: "2026-10-23T20:00:00Z",
      });
      expect(a.body.items[0].change_percent).toBeCloseTo(
        (-1.25 / 212.21) * 100,
        4,
      );
      expect(a.body.items[1]).toMatchObject({
        id: "FRED:DGS10",
        status: "unavailable",
        reason: "a FRED series has no live quote, so it never moves",
      });
      expect(a.body.attribution).toBeUndefined();
      for (const id of ["US:NVDA", "SNP:^GSPC", "FRED:DGS10"]) {
        expect(lastReadAt(t.db, id)).toBe(NOW);
      }
    }));

  test("pages under 32 KiB by whole items", () =>
    withApp(async (t) => {
      const name = "Ünïcödé “Holdings” 日本株式会社 \\ ✓ ".repeat(12);
      const ids: string[] = [];
      for (let k = 0; k < 100; k++) {
        const i = upsertInstrument(
          t.db,
          {
            market: "XX",
            symbol: `S${k}`,
            source: "other",
            sourceSymbol: `S${k}`,
            exchange: "XX",
            name: `${name}${k}`,
            type: "EQUITY",
            currency: "EUR",
            unit: "per_share",
            zone: "UTC",
          },
          NOW,
        );
        upsertBars(
          t.db,
          i.id,
          "1d",
          [
            {
              date: "2026-10-23",
              open: 1,
              high: 1,
              low: 1,
              close: 1,
              volume: 1,
              final: true,
            },
          ],
          NOW,
        );
        t.db
          .query(
            `insert into signals (instrument, interval, date, kind, computed_at)
             values (?, '1d', '2026-10-23', 'final', ?)`,
          )
          .run(i.id, NOW);
        t.db
          .query(
            `insert into quotes (instrument, price, previous_close,
               previous_close_field, change, change_percent, time, source,
               fetched_at)
             values (?, ?, 1, 'previousClose', ?, ?, ?, 'other', ?)`,
          )
          .run(i.id, 1 + k / 100, k / 100, k, NOW, NOW);
        ids.push(i.id);
      }
      const seen: string[] = [];
      let next: string | null = null;
      let pages = 0;
      do {
        const a: Answer = await call(t, "movers", {
          symbols: ids,
          min_move_pct: 0,
          ...(next === null ? {} : { next }),
        });
        expect(a.isError).toBe(false);
        expect(a.body.counts.matched).toBe(100);
        if (a.body.next !== null) {
          expect(a.bytes).toBeGreaterThan(PAGE_BYTES - 2048);
        }
        seen.push(...a.body.items.map((i: any) => i.id));
        next = a.body.next;
        pages++;
      } while (next !== null);
      expect(pages).toBeGreaterThan(1);
      // largest move first
      expect(seen).toEqual([...ids].reverse());
    }));
});

describe("search", () => {
  test("answers stored and Yahoo candidates, fetching no prices and tracking nothing", () =>
    yahooApp(async (t, s) => {
      await call(t, "quote", { symbols: ["NVDA"] });
      await t.clock.advance(1000);
      const charts = s.calls.charts().length;
      const sparks = s.calls.sparks().length;
      const a = await call(t, "search", { query: "nvidia" });
      expect(a.isError).toBe(false);
      const ids = a.body.candidates.map((c: any) => c.id);
      expect(ids[0]).toBe("US:NVDA");
      expect(a.body.candidates[0].stored).toBe(true);
      expect(ids).toContain("TOR:NVDA");
      expect(new Set(ids).size).toBe(ids.length);
      expect(s.calls.charts()).toHaveLength(charts);
      expect(s.calls.sparks()).toHaveLength(sparks);
      expect(lastReadAt(t.db, "US:NVDA")).toBe(NOW);
      expect(readInstrument(t.db, "TOR:NVDA")).toBeNull();
    }));

  test("FRED matches only as FRED:<id>, and answers the series without data", () =>
    yahooApp(async (t, s) => {
      const a = await call(t, "search", { query: "FRED:DGS10" });
      expect(a.body.candidates).toEqual([
        expect.objectContaining({
          id: "FRED:DGS10",
          source: "fred",
          stored: false,
        }),
      ]);
      expect(s.calls.urls.map((u) => u.pathname)).toEqual(["/fred/series"]);
      expect(readInstrument(t.db, "FRED:DGS10")).toBeNull();
    }));
});

describe("GET /quotes", () => {
  const get = (t: TestApp, query: string, init: RequestInit = {}) =>
    fetch(`${t.url}/quotes${query}`, {
      ...init,
      headers: { authorization: `Bearer ${t.bearer}`, ...init.headers },
    });

  test("answers the smaller projection as JSON, never cached", () =>
    yahooApp(async (t) => {
      const res = await get(t, "?symbols=NVDA,FRED:DGS10");
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("application/json");
      expect(res.headers.get("cache-control")).toBe("no-store");
      const body: any = await res.json();
      expect(body.attribution).toBe(ATTRIBUTION);
      expect(body.next).toBeNull();
      const [nvda, dgs10] = body.items;
      expect(Object.keys(nvda).sort()).toEqual(
        [
          "input",
          "id",
          "kind",
          "price",
          "previous_close",
          "change",
          "change_percent",
          "unit",
          "currency",
          "trade_time",
          "fetched_at",
          "stale",
          "sma",
        ].sort(),
      );
      expect(nvda).toMatchObject({
        id: "US:NVDA",
        kind: "market_quote",
        price: 210.96,
      });
      expect(Object.keys(nvda.sma.daily).sort()).toEqual([
        "date",
        "kind",
        "sma200",
        "sma50",
      ]);
      expect(nvda.sma.weekly.sma50).toBeNumber();
      expect(dgs10).toMatchObject({
        id: "FRED:DGS10",
        kind: "observation",
        price: null,
        observation: { date: "2026-10-22", value: 4.96 },
      });
      expect(lastReadAt(t.db, "US:NVDA")).toBe(NOW);
    }));

  test("401 without the bearer, 405 for other methods, 400 for bad arguments", () =>
    yahooApp(async (t, s) => {
      const none = await fetch(`${t.url}/quotes?symbols=NVDA`);
      expect(none.status).toBe(401);
      const post = await get(t, "?symbols=NVDA", { method: "POST" });
      expect(post.status).toBe(405);
      expect(post.headers.get("allow")).toBe("GET");
      for (const query of [
        "",
        "?symbols=",
        "?symbols=NVDA,,AMD",
        "?symbols=NVDA&symbols=AMD",
        "?symbols=NVDA&limit=1",
        "?symbols=NVDA&next=bogus",
        `?symbols=${Array(101).fill("A").join(",")}`,
      ]) {
        const res = await get(t, query);
        expect(res.status).toBe(400);
        expect(res.headers.get("cache-control")).toBe("no-store");
        expect(((await res.json()) as any).error).toBe("bad_arguments");
      }
      expect(s.calls.urls).toHaveLength(0);
    }));
});
