// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { upsertInstrument } from "../src/market/instruments.ts";
import { markRead } from "../src/market/tracking.ts";
import { MINUTE_MS } from "../src/runtime/clock.ts";
import type { Log, LogFields } from "../src/runtime/log.ts";
import { massive, parseNews } from "../src/sources/massive/client.ts";
import {
  type MassiveContext,
  refreshNews,
} from "../src/sources/massive/store.ts";
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
import { NOW } from "./helpers/sources.ts";
import { fakeFetch } from "./helpers/yahoo.ts";

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
