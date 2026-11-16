// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { readInstrument, upsertInstrument } from "../src/market/instruments.ts";
import { markRead } from "../src/market/tracking.ts";
import { OPERATOR } from "../src/operations/who.ts";
import { readRule } from "../src/rules/store.ts";
import { MINUTE_MS } from "../src/runtime/clock.ts";
import type { Log, LogFields } from "../src/runtime/log.ts";
import { massive, parseNews } from "../src/sources/massive/client.ts";
import {
  type MassiveContext,
  refreshNews,
} from "../src/sources/massive/store.ts";
import { refetch } from "../src/sources/yahoo/sync.ts";
import { open } from "../src/storage/db/index.ts";
import { writer } from "../src/storage/writer.ts";
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
