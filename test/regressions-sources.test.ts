// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { recordSession, session } from "../src/market/calendars.ts";
import { readInstrument, upsertInstrument } from "../src/market/instruments.ts";
import { markRead } from "../src/market/tracking.ts";
import { fromWallTime, localDate } from "../src/market/zone.ts";
import { OPERATOR } from "../src/operations/who.ts";
import { readRule } from "../src/rules/store.ts";
import { MINUTE_MS } from "../src/runtime/clock.ts";
import type { Log, LogFields } from "../src/runtime/log.ts";
import { silent } from "../src/runtime/log.ts";
import { cftc } from "../src/sources/cftc/client.ts";
import { cftcJobs, marketList } from "../src/sources/cftc/list.ts";
import { massive, parseNews } from "../src/sources/massive/client.ts";
import { massiveJobs } from "../src/sources/massive/jobs.ts";
import {
  type MassiveContext,
  newsState,
  refreshNews,
} from "../src/sources/massive/store.ts";
import { DeadlinePassed } from "../src/sources/source.ts";
import { refetch } from "../src/sources/yahoo/sync.ts";
import { open } from "../src/storage/db/index.ts";
import { lastRun } from "../src/storage/runs.ts";
import { writer } from "../src/storage/writer.ts";
import { cftcAnswer, RECORDED } from "./helpers/cftc.ts";
import { fakeClock } from "./helpers/clock.ts";
import { drive } from "./helpers/drive.ts";
import {
  MASSIVE_KEY,
  massiveAnswer,
  massiveFixture,
  series,
} from "./helpers/massive.ts";
import { type RulesTest, rulesTest } from "./helpers/rules.ts";
import { NOW } from "./helpers/sources.ts";
import {
  clone,
  fakeFetch,
  listed,
  type Recorded,
  recorded,
} from "./helpers/yahoo.ts";

const HOUR_MS = 60 * MINUTE_MS;

function recording(): { log: Log; lines: [string, LogFields?][] } {
  const lines: [string, LogFields?][] = [];
  const push = (msg: string, fields?: LogFields) => lines.push([msg, fields]);
  return { log: { info: push, warn: push, error: push }, lines };
}

describe("a bad Massive article", () => {
  test("drops itself, not its page", async () => {
    const body = (await massiveFixture("news-latest")).body;
    const count = body.results.length;
    body.results[1].article_url = `https://example.com/${"a".repeat(2_100)}`;
    const page = parseNews(body);
    expect(page.articles).toHaveLength(count - 1);
    expect(page.articles.map((a) => a.id)).not.toContain(body.results[1].id);
  });

  test("a page whose every article is bad stays malformed", async () => {
    const body = (await massiveFixture("news-latest")).body;
    for (const a of body.results) a.title = "";
    expect(() => parseNews(body)).toThrow("malformed answer");
  });

  test("the rest of its page is stored, and it is logged once", async () => {
    const clock = fakeClock(NOW);
    const { db } = open(":memory:", clock);
    const articles = await series("NVDA", 5, NOW, HOUR_MS);
    articles[2].id = "x".repeat(300);
    const fake = { articles };
    const f = fakeFetch((url) => massiveAnswer(fake, url));
    const { log, lines } = recording();
    const client = massive({ clock, key: MASSIVE_KEY, fetch: f.fetch, log });
    const ctx: MassiveContext = {
      db,
      clock,
      writer: writer(db),
      massive: client,
    };
    const nvda = upsertInstrument(
      db,
      {
        market: "US",
        symbol: "NVDA",
        source: "yahoo",
        sourceSymbol: "NVDA",
        exchange: "NMS",
        name: "NVDA",
        type: "EQUITY",
        currency: "USD",
        unit: "per_share",
        zone: "America/New_York",
      },
      NOW,
    );
    markRead(db, [nvda.id], NOW);
    const first = await drive(clock, client, refreshNews(ctx, nvda));
    expect(first).toMatchObject({ status: "ok", rows: 4 });
    await clock.advance(30 * MINUTE_MS);
    await drive(clock, client, refreshNews(ctx, nvda));
    const dropped = lines.filter(([m]) => m === "massive article dropped");
    expect(dropped).toHaveLength(1);
    expect(dropped[0]![1]).toEqual({ reason: "no id" });
  });
});

// a chart answer split n:1 on at (seconds), every price divided by n
function splitBy(fx: Recorded, at: number, n: number): Recorded {
  const out = clone(fx);
  const r = out.body.chart.result[0];
  r.events = {
    splits: {
      [at]: { date: at, numerator: n, denominator: 1, splitRatio: `${n}:1` },
    },
  };
  const q = r.indicators.quote[0];
  for (const k of ["open", "high", "low", "close"]) {
    q[k] = q[k].map((v: number | null) => (v === null ? null : v / n));
  }
  return out;
}

// 2026-10-16, inside the recorded window
const OCT16 = 1792157400;

describe("a split and MACD", () => {
  const create = async (t: RulesTest, when: string): Promise<number> => {
    const r = await t.edit({ action: "create", symbol: "NVDA", when });
    expect(r.error).toBe(false);
    return r.body.alert.id;
  };
  const rule = (t: RulesTest, id: number) => readRule(t.db, OPERATOR, id)!;

  test("a sign against 0 is not paused; a level is", async () => {
    const t = await rulesTest();
    const sign = await create(t, "macd_histogram > 0");
    const signal = await create(t, "macd_signal < 0");
    const level = await create(t, "macd > 1.5");
    const history = listed(await recorded("chart-nvda-5y-1d"));
    const window = await recorded("chart-nvda-5d-1d");
    const answers = [splitBy(window, OCT16, 4), splitBy(history, OCT16, 4)];
    t.charts.set("NVDA", () => answers.shift()!);
    await refetch(t.ctx, readInstrument(t.db, "US:NVDA")!);
    expect(answers).toHaveLength(0);
    expect(rule(t, sign).paused).toBeNull();
    expect(rule(t, signal).paused).toBeNull();
    expect(rule(t, level).paused).toBe("split");
  });

  test("a sign against 0 is unknown while the bars are pending", async () => {
    const t = await rulesTest();
    const sign = await create(t, "macd_histogram > 0");
    await t.clock.advance(Date.parse("2026-10-26T13:35:00Z") - t.clock.now());
    await t.quote("NVDA", {
      price: 52.7,
      sessionDays: 3,
      time: Date.parse("2026-10-26T13:31:00Z"),
    });
    expect(rule(t, sign).lastResult).toBe("unknown");
  });
});

describe("the CFTC market list job", () => {
  test("a reader's deadline in a joined fetch is not the job's failure", async () => {
    const clock = fakeClock(RECORDED);
    const { db } = open(":memory:", clock);
    const f = fakeFetch((url) => cftcAnswer(url));
    const client = cftc({ clock, fetch: f.fetch });
    const list = marketList(clock);
    const { log, lines } = recording();
    const job = cftcJobs({
      clock,
      writer: writer(db),
      cftc: client,
      list,
      log,
    });
    // a call just made, so the reader's next one waits for its slot
    await drive(clock, client, client.markets("financial", "2023-01-01"));
    let alive = true;
    const read = list.fetch(
      client.within(() => alive),
      "disaggregated",
    );
    read.catch(() => {});
    const tick = job.tick();
    for (let k = 0; k < 5; k++) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    alive = false;
    await drive(clock, client, tick);
    await expect(read).rejects.toBeInstanceOf(DeadlinePassed);
    expect(lastRun(db, "cftc", "markets", "disaggregated")).toMatchObject({
      status: "ok",
    });
    expect(list.held("disaggregated")).not.toBeNull();
    expect(lines.filter(([m]) => m === "cftc markets failed")).toEqual([]);
  });
});

// New York: Friday 13 November 2026 is a session, the weekend is not, and
// Thanksgiving (26 November) is a holiday the source shows no session for
const ZONE = "America/New_York";
const at = (date: string, time: string) =>
  fromWallTime(ZONE, Date.parse(`${date}T${time}:00Z`));
const regular = (date: string) =>
  session(ZONE, at(date, "09:30"), at(date, "16:00"));

describe("Massive news on a day with no session", () => {
  async function newsWorld(start: number) {
    const clock = fakeClock(start);
    const { db } = open(":memory:", clock);
    const fake = { articles: await series("NVDA", 3, start, HOUR_MS) };
    const f = fakeFetch((url) => massiveAnswer(fake, url));
    const client = massive({ clock, key: MASSIVE_KEY, fetch: f.fetch });
    const ctx: MassiveContext = {
      db,
      clock,
      writer: writer(db),
      massive: client,
    };
    const nvda = upsertInstrument(
      db,
      {
        market: "US",
        symbol: "NVDA",
        source: "yahoo",
        sourceSymbol: "NVDA",
        exchange: "NMS",
        name: "NVDA",
        type: "EQUITY",
        currency: "USD",
        unit: "per_share",
        zone: ZONE,
      },
      start,
    );
    const jobs = massiveJobs({ ctx, log: silent });
    // the calls of each local day, a tick a minute until to
    const calls = new Map<string, number>();
    const run = async (to: number) => {
      while (clock.now() < to) {
        markRead(db, [nvda.id], clock.now());
        const before = f.urls.length;
        const day = localDate(ZONE, clock.now());
        await drive(clock, client, jobs.tick());
        calls.set(day, (calls.get(day) ?? 0) + f.urls.length - before);
        const minute = Math.floor(clock.now() / MINUTE_MS + 1) * MINUTE_MS;
        await clock.advance(minute - clock.now());
      }
    };
    const record = (date: string) =>
      recordSession(db, "US", regular(date), clock.now());
    return { clock, db, nvda, run, record, calls };
  }

  test("is asked every 2 hours, and every 30 minutes on a session day", async () => {
    const w = await newsWorld(at("2026-11-13", "00:00"));
    w.record("2026-11-13");
    await w.run(at("2026-11-16", "09:30"));
    // the source shows Monday's session at its start
    w.record("2026-11-16");
    await w.run(at("2026-11-17", "00:00"));
    expect(Object.fromEntries(w.calls)).toEqual({
      "2026-11-13": 48,
      "2026-11-14": 26,
      "2026-11-15": 26,
      "2026-11-16": 48,
    });
  });

  test("a holiday the source shows no session for is a quiet day", async () => {
    const w = await newsWorld(at("2026-11-25", "00:00"));
    w.record("2026-11-25");
    await w.run(at("2026-11-27", "00:00"));
    expect(w.calls.get("2026-11-25")).toBe(48);
    expect(w.calls.get("2026-11-26")).toBe(26);
  });

  test("weekend news a period old never reads pending", async () => {
    const w = await newsWorld(at("2026-11-14", "12:00"));
    w.record("2026-11-13");
    await w.run(at("2026-11-14", "12:01"));
    await w.clock.advance(119 * MINUTE_MS);
    expect(newsState(w.db, w.nvda.id, w.clock.now()).stale).toEqual([]);
    // a session day keeps the 30 minutes' threshold
    w.record("2026-11-16");
    await w.clock.advance(at("2026-11-16", "10:00") - w.clock.now());
    expect(newsState(w.db, w.nvda.id, w.clock.now()).stale).toEqual([
      "news sync pending",
    ]);
  });
});
