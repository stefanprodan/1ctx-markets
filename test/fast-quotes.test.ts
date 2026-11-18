// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { readQuote } from "../src/market/quotes.ts";
import { MINUTE_MS } from "../src/runtime/clock.ts";
import type { Log, LogFields, LogLevel } from "../src/runtime/log.ts";
import { silent } from "../src/runtime/log.ts";
import {
  MAX_RETRY_AFTER_MS,
  pauseOf,
  RATE_LIMIT_BACKOFF_MS,
  RateLimited,
  rateLimited,
  SourceError,
} from "../src/sources/source.ts";
import { yahoo } from "../src/sources/yahoo/client.ts";
import {
  FAST_COOLDOWN_MS,
  FAST_HOLD_MS,
  FAST_MS,
  FAST_SPACING_MS,
  FAST_WAIT_MS,
  fastQuotes,
} from "../src/sources/yahoo/fast.ts";
import { yahooJobs } from "../src/sources/yahoo/jobs.ts";
import { open } from "../src/storage/db/index.ts";
import { writer } from "../src/storage/writer.ts";
import { fakeClock } from "./helpers/clock.ts";
import { CRYPTO, sim, US } from "./helpers/sim.ts";
import {
  added,
  chartSymbol,
  fakeFetch,
  notFound,
  type Recorded,
  recorded,
} from "./helpers/yahoo.ts";

type Line = { level: LogLevel; msg: string; fields: LogFields };

function captured(): { log: Log; lines: Line[] } {
  const lines: Line[] = [];
  const at =
    (level: LogLevel) =>
    (msg: string, fields: LogFields = {}) =>
      lines.push({ level, msg, fields });
  return {
    log: { info: at("info"), warn: at("warn"), error: at("error") },
    lines,
  };
}

async function setup(symbols: string[], closed: string[] = []) {
  const clock = fakeClock();
  const { db } = open(":memory:", clock);
  const s = sim([...symbols.map(CRYPTO), ...closed.map(US)]);
  const limited = await recorded("chart-429-chrome-ua");
  let refusal: Recorded | null = null;
  let down = false;
  const sparkAt: { at: number; symbols: string }[] = [];
  const charts: string[] = [];
  const held: (() => void)[] = [];
  const f = fakeFetch((url) => {
    if (down) throw new Error("no route to host");
    const chart = chartSymbol(url);
    if (chart !== null) charts.push(chart);
    // a job's call that holds a queue slot until released
    if (chart === "BUSY") {
      return new Promise<Recorded>((resolve) => {
        held.push(() => resolve(notFound));
      });
    }
    if (url.pathname === "/v7/finance/spark") {
      sparkAt.push({
        at: clock.now(),
        symbols: url.searchParams.get("symbols")!,
      });
      if (refusal !== null) return refusal;
    }
    return s.route(url, clock.now());
  });
  const queueLog = captured();
  const fastLog = captured();
  const client = yahoo({ clock, fetch: f.fetch, log: queueLog.log });
  const ctx = { db, clock, yahoo: client, writer: writer(db) };
  const instruments = [];
  for (const symbol of [...symbols, ...closed]) {
    instruments.push((await added(ctx, symbol)).instrument);
  }
  const fast = fastQuotes({ ...ctx, log: fastLog.log });
  const jobs = yahooJobs({ ctx, quoteEveryMs: 5 * MINUTE_MS, log: silent });
  const sparks = () => sparkAt.length;
  return {
    clock,
    db,
    fast,
    jobs,
    client,
    instruments,
    sparkAt,
    sparks,
    queueLines: queueLog.lines,
    fastLines: fastLog.lines,
    charts,
    refuse(headers: Record<string, string> = {}) {
      refusal = { ...limited, headers: { ...limited.headers, ...headers } };
    },
    answer(r: Recorded) {
      refusal = r;
    },
    allow() {
      refusal = null;
      down = false;
    },
    fail() {
      down = true;
    },
    // both of the queue's slots taken by jobs' calls until released
    busy() {
      const calls = [0, 1].map(() =>
        client.chart("BUSY", 0, 1).catch(() => {}),
      );
      return async () => {
        for (const release of held.splice(0)) release();
        await Promise.all(calls);
      };
    },
  };
}

describe("fast quotes", () => {
  test("a fresh quote makes no call; an older one makes one, shared by readers at once", async () => {
    const t = await setup(["C0-USD"]);
    const [c0] = t.instruments;
    expect(await t.fast.refresh(c0!)).toBe(true);
    const before = t.sparks();
    await t.clock.advance(FAST_MS - 1);
    expect(await t.fast.refresh(c0!)).toBe(true);
    expect(t.sparks()).toBe(before);
    await t.clock.advance(1);
    const was = readQuote(t.db, c0!.id)!.fetchedAt;
    const both = await Promise.all([t.fast.refresh(c0!), t.fast.refresh(c0!)]);
    expect(both).toEqual([true, true]);
    expect(t.sparks()).toBe(before + 1);
    expect(readQuote(t.db, c0!.id)!.fetchedAt).toBeGreaterThan(was);
  });

  test("past the cap an instrument gets no call; calls start spaced apart", async () => {
    const t = await setup(["C0-USD", "C1-USD", "C2-USD", "C3-USD"]);
    await t.clock.advance(FAST_MS);
    const before = t.sparks();
    const [a, b, c, d] = t.instruments;
    const asked = Promise.all([a, b, c].map((i) => t.fast.refresh(i!)));
    await t.clock.advance(2 * FAST_SPACING_MS);
    expect(await asked).toEqual([true, true, true]);
    expect(await t.fast.refresh(d!)).toBe(false);
    const calls = t.sparkAt.slice(before);
    expect(calls.map((c) => c.symbols)).toEqual(["C0-USD", "C1-USD", "C2-USD"]);
    const starts = calls.map((c) => c.at);
    expect(starts[1]! - starts[0]!).toBe(FAST_SPACING_MS);
    expect(starts[2]! - starts[1]!).toBe(FAST_SPACING_MS);
    // a page that stopped asking frees its slot
    await t.clock.advance(FAST_HOLD_MS);
    expect(await t.fast.refresh(d!)).toBe(true);
  });

  test("a page left frees its place for the next at once", async () => {
    const t = await setup(["C0-USD", "C1-USD", "C2-USD", "C3-USD"]);
    const [a, b, c, d] = t.instruments;
    const asked = Promise.all([a, b, c].map((i) => t.fast.refresh(i!)));
    await t.clock.advance(2 * FAST_SPACING_MS);
    expect(await asked).toEqual([true, true, true]);
    // one never refreshed fast frees nothing
    t.fast.release(d!);
    t.fast.release({ ...d!, id: "US:ZZNOTHING" });
    expect(await t.fast.refresh(d!)).toBe(false);
    const before = t.sparks();
    t.fast.release(b!);
    const next = t.fast.refresh(d!);
    await t.clock.advance(FAST_SPACING_MS);
    expect(await next).toBe(true);
    expect(t.sparks()).toBe(before + 1);
    expect(await t.fast.refresh(b!)).toBe(false);
  });

  test("a closed market and another source make no call", async () => {
    const t = await setup([], ["AAPL"]);
    const [aapl] = t.instruments;
    await t.clock.advance(FAST_MS);
    const before = t.sparks();
    expect(await t.fast.refresh(aapl!)).toBe(false);
    expect(await t.fast.refresh({ ...aapl!, source: "fred" })).toBe(false);
    expect(t.sparks()).toBe(before);
  });

  test("a 429 backs the queue off, logged once, and pauses fast refresh past its end", async () => {
    const t = await setup(["C0-USD"]);
    const [c0] = t.instruments;
    await t.clock.advance(FAST_MS);
    const at = t.clock.now();
    t.refuse();
    expect(await t.fast.refresh(c0!)).toBe(false);
    expect(t.client.backoff()).toEqual({
      until: at + RATE_LIMIT_BACKOFF_MS,
      after: "rate limited",
    });
    const until = new Date(at + RATE_LIMIT_BACKOFF_MS).toISOString();
    expect(t.queueLines).toEqual([
      {
        level: "warn",
        msg: "source backing off",
        fields: { source: "yahoo", reason: "rate limited", until },
      },
    ]);
    expect(t.fastLines).toEqual([
      {
        level: "info",
        msg: "yahoo fast refresh paused",
        fields: {
          until: new Date(
            at + RATE_LIMIT_BACKOFF_MS + FAST_COOLDOWN_MS,
          ).toISOString(),
        },
      },
    ]);
    t.allow();
    const refused = t.sparks();
    await t.clock.advance(FAST_MS);
    expect(await t.fast.refresh(c0!)).toBe(false);
    expect(t.sparks()).toBe(refused);
    // the pass goes again once the back-off ends, the resume logged once
    await t.clock.advance(RATE_LIMIT_BACKOFF_MS);
    expect(t.queueLines.map((l) => [l.level, l.msg, l.fields])).toEqual([
      [
        "warn",
        "source backing off",
        { source: "yahoo", reason: "rate limited", until },
      ],
      ["info", "source resumed", { source: "yahoo" }],
    ]);
    expect((await t.jobs.quoteTick()).quoted).toEqual(["CRYPTO"]);
    expect(t.sparks()).toBe(refused + 1);
    // fast refresh waits out its cool-down after the back-off
    await t.clock.advance(FAST_COOLDOWN_MS - 2 * FAST_MS);
    expect(await t.fast.refresh(c0!)).toBe(false);
    expect(t.sparks()).toBe(refused + 1);
    await t.clock.advance(2 * FAST_MS);
    expect(await t.fast.refresh(c0!)).toBe(true);
    expect(t.sparks()).toBe(refused + 2);
    expect(t.fastLines).toHaveLength(1);
    expect(t.queueLines).toHaveLength(2);
  });

  test("a busy queue never holds the page: past its wait it answers the stored quote", async () => {
    const t = await setup(["C0-USD"]);
    const [c0] = t.instruments;
    await t.clock.advance(FAST_MS);
    const before = t.sparks();
    const was = readQuote(t.db, c0!.id)?.fetchedAt ?? null;
    const release = t.busy();
    const asked = t.fast.refresh(c0!);
    await t.clock.advance(FAST_WAIT_MS);
    expect(await asked).toBe(true);
    expect(t.sparks()).toBe(before);
    expect(readQuote(t.db, c0!.id)?.fetchedAt ?? null).toBe(was);
    // the call given up never goes out once the slots free
    await release();
    await t.clock.advance(0);
    expect(t.sparks()).toBe(before);
    expect(t.client.backoff()).toBeNull();
  });

  test("a symbol Yahoo refuses on spark is asked on its chart, never backing off", async () => {
    const t = await setup(["C0-USD"]);
    const [c0] = t.instruments;
    await t.clock.advance(FAST_MS);
    t.answer({
      recordedAt: "",
      status: 200,
      headers: { "content-type": "application/json" },
      body: { spark: { result: null, error: { code: "Not Found" } } },
    });
    const charts = t.charts.length;
    expect(await t.fast.refresh(c0!)).toBe(true);
    expect(t.charts.slice(charts)).toEqual(["C0-USD"]);
    expect(t.client.backoff()).toBeNull();
    expect(readQuote(t.db, c0!.id)!.fetchedAt).toBe(t.clock.now());
    expect(t.fastLines).toEqual([]);
  });

  test("a back-off other than a rate limit pauses fast refresh only while it lasts", async () => {
    const t = await setup(["C0-USD"]);
    const [c0] = t.instruments;
    await t.clock.advance(FAST_MS);
    t.fail();
    expect(await t.fast.refresh(c0!)).toBe(false);
    const paused = t.client.backoff();
    expect(paused?.after).toBe("network error");
    t.allow();
    await t.clock.advance(FAST_MS);
    expect(await t.fast.refresh(c0!)).toBe(false);
    await t.clock.advance(paused!.until - t.clock.now());
    const before = t.sparks();
    expect(await t.fast.refresh(c0!)).toBe(true);
    expect(t.sparks()).toBe(before + 1);
  });

  test("a 429 with Retry-After backs off that long when longer", async () => {
    const t = await setup(["C0-USD"]);
    const [c0] = t.instruments;
    await t.clock.advance(FAST_MS);
    const at = t.clock.now();
    t.refuse({ "retry-after": "600" });
    expect(await t.fast.refresh(c0!)).toBe(false);
    expect(t.client.backoff()?.until).toBe(at + 10 * MINUTE_MS);
  });
});

describe("rate limit answers", () => {
  const limited = (headers: Record<string, string>) =>
    new Response("", { status: 429, headers });
  const NOW = Date.parse("2026-11-18T12:00:00Z");

  test("Retry-After in seconds or as a date, and none", () => {
    expect(rateLimited(limited({ "retry-after": "120" }), NOW).waitMs).toBe(
      120_000,
    );
    expect(
      rateLimited(
        limited({ "retry-after": "Wed, 18 Nov 2026 12:20:00 GMT" }),
        NOW,
      ).waitMs,
    ).toBe(20 * MINUTE_MS);
    expect(rateLimited(limited({}), NOW).waitMs).toBeNull();
    expect(
      rateLimited(limited({ "retry-after": "soon" }), NOW).waitMs,
    ).toBeNull();
  });

  test("the pause is at least the rate limit's back-off, and at most the cap", () => {
    expect(pauseOf(new RateLimited(60_000))).toBe(RATE_LIMIT_BACKOFF_MS);
    expect(pauseOf(new RateLimited(600_000))).toBe(600_000);
    expect(pauseOf(new RateLimited(48 * 60 * MINUTE_MS))).toBe(
      MAX_RETRY_AFTER_MS,
    );
    expect(pauseOf(new SourceError("rate limited"))).toBe(
      RATE_LIMIT_BACKOFF_MS,
    );
  });
});
