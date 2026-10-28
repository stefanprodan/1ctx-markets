// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "bun:test";
import { refetch } from "../src/admin/refetch.ts";
import { upsertInstrument } from "../src/market/instruments.ts";
import { readQuote } from "../src/market/quotes.ts";
import { markRead } from "../src/market/tracking.ts";
import { markets } from "../src/operations/markets.ts";
import { newsItem } from "../src/operations/research.ts";
import { MINUTE_MS } from "../src/runtime/clock.ts";
import { silent } from "../src/runtime/log.ts";
import { bvb } from "../src/sources/bvb/client.ts";
import { parseDetail } from "../src/sources/bvb/parse.ts";
import { fetchInstrument } from "../src/sources/bvb/sync.ts";
import { finnhub } from "../src/sources/finnhub/client.ts";
import { finnhubJobs } from "../src/sources/finnhub/jobs.ts";
import { readEvents, readResearch } from "../src/sources/finnhub/read.ts";
import {
  NO_HOOKS,
  SECTIONS,
  storeSection,
  upsertEvents,
} from "../src/sources/finnhub/store.ts";
import { refreshResearch } from "../src/sources/finnhub/sync.ts";
import {
  MAX_PUBLISHER,
  MAX_REASONING,
  MAX_TITLE,
  massive,
  PAGE_LIMIT,
} from "../src/sources/massive/client.ts";
import {
  readNews,
  readWalks,
  refreshNews,
} from "../src/sources/massive/store.ts";
import { yahoo } from "../src/sources/yahoo/client.ts";
import { type Db, open } from "../src/storage/db/index.ts";
import { lastRun } from "../src/storage/runs.ts";
import { writer } from "../src/storage/writer.ts";
import { bvbFetch, bvbRecorded, keyed } from "./helpers/bvb.ts";
import { fakeClock } from "./helpers/clock.ts";
import { drive } from "./helpers/drive.ts";
import {
  FINNHUB_KEY,
  finnhubAnswer,
  finnhubFixture,
} from "./helpers/finnhub.ts";
import {
  type FakeMassive,
  MASSIVE_KEY,
  massiveAnswer,
  series,
} from "./helpers/massive.ts";
import { gate, NOW } from "./helpers/sources.ts";
import { clone, fakeFetch, type Recorded } from "./helpers/yahoo.ts";

const HOUR_MS = 60 * MINUTE_MS;
const CALENDAR_PATH = "/api/v1/calendar/earnings";
const noNetwork = async (url: string): Promise<Response> => {
  throw new Error(`no network in tests: ${url}`);
};

function share(db: Db, now: number) {
  const instrument = upsertInstrument(
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
    now,
  );
  markRead(db, [instrument.id], now);
  return instrument;
}

function newsSetup(
  fake: FakeMassive,
  route?: (url: URL) => Recorded | undefined,
) {
  const clock = fakeClock(NOW);
  const { db } = open(":memory:", clock);
  const write = writer(db);
  const f = fakeFetch((url) => route?.(url) ?? massiveAnswer(fake, url));
  const client = massive({ clock, key: MASSIVE_KEY, fetch: f.fetch });
  const ctx = { db, clock, writer: write, massive: client };
  return { clock, db, write, f, client, ctx };
}

test.each([
  ["title", MAX_TITLE],
  ["publisher", MAX_PUBLISHER],
  ["reasoning", MAX_REASONING],
] as const)(
  "a key crossing the %s cap is redacted before storage and answers",
  async (field, cap) => {
    expect(MASSIVE_KEY).toHaveLength(32);
    const [article] = await series("NVDA", 1, NOW, 0);
    const text = "x".repeat(cap - 31) + MASSIVE_KEY;
    if (field === "title") article.title = text;
    else if (field === "publisher") article.publisher = { name: text };
    else article.insights[0].sentiment_reasoning = text;
    const t = newsSetup({ articles: [article] });
    try {
      const instrument = await t.write.write((db) => share(db, t.clock.now()));
      const result = await drive(
        t.clock,
        t.client,
        refreshNews(t.ctx, instrument),
      );
      expect(result).toMatchObject({ status: "ok", rows: 1 });
      const rows = readNews(t.db, instrument.id, t.clock.now(), 10);
      expect(rows).toHaveLength(1);
      expect(rows[0]![field]!.length).toBeLessThanOrEqual(cap);
      const prefix = MASSIVE_KEY.slice(0, -2);
      const stored = JSON.stringify(t.db.query("select * from news").all());
      const answered = JSON.stringify(rows.map(newsItem));
      expect({
        storedKeyPrefix: stored.includes(prefix),
        answeredKeyPrefix: answered.includes(prefix),
      }).toEqual({ storedKeyPrefix: false, answeredKeyPrefix: false });
    } finally {
      t.client.close();
      await t.write.close();
      t.db.close();
    }
  },
);

test("a detail quote naming another listing is refused without changing prices or evaluating rules", async () => {
  const clock = fakeClock(Date.parse("2026-10-27T16:10:00Z"));
  const { db } = open(":memory:", clock);
  const write = writer(db);
  const wrong = keyed(await bvbRecorded("detail-bond-r2807a"));
  wrong.body = (wrong.body as string).replace(
    /(<span class="date small">)[^<]*(<\/span>)/,
    (_match, start, end) => `${start}27.10.2026 17:59:59${end}`,
  );
  expect(parseDetail(wrong.body, clock.now())).toMatchObject({
    symbol: "R2807A",
    price: 98.9999,
  });
  let mismatched = false;
  const f = await bvbFetch({
    hold: (url) =>
      mismatched && url.searchParams.get("s") === "TLV" ? wrong : undefined,
  });
  const client = bvb({ clock, fetch: f.fetch });
  const unused = yahoo({ clock, fetch: noNetwork });
  const ctx = { db, clock, writer: write, bvb: client };
  const evaluated: { id: string; price: number | null }[] = [];
  const m = markets({
    ...ctx,
    yahoo: unused,
    fred: null,
    log: silent,
    rules: {
      rescaled() {},
      evaluate(db, ids) {
        for (const id of ids) {
          evaluated.push({ id, price: readQuote(db, id)?.price ?? null });
        }
      },
    },
  });
  try {
    const instrument = await drive(
      clock,
      client,
      fetchInstrument(ctx, "TLV", "BVB:TLV", () => true),
    );
    expect(instrument).toMatchObject({ type: "EQUITY", unit: "per_share" });
    const before = readQuote(db, instrument.id)!;
    expect(before.price).toBe(36.18);
    mismatched = true;
    const result = await drive(
      clock,
      client,
      refetch(m, [instrument], { parts: ["quotes"], sections: [] }),
    );
    expect(f.urls.at(-1)!.searchParams.get("s")).toBe("TLV");
    expect({
      status: result[0]!.status,
      price: readQuote(db, instrument.id)!.price,
      evaluated,
    }).toEqual({ status: "failed", price: before.price, evaluated: [] });
    expect(readQuote(db, instrument.id)).toEqual(before);
  } finally {
    client.close();
    await write.close();
    db.close();
  }
});

test("an older research batch cannot revert a newer market calendar answer", async () => {
  const clock = fakeClock(Date.parse("2026-10-27T20:30:00Z"));
  const { db } = open(":memory:", clock);
  const write = writer(db);
  const held = gate();
  const old = clone(await finnhubFixture("calendar-earnings-nvda"));
  Object.assign(old.body.earningsCalendar[0], {
    year: 2026,
    quarter: 3,
    date: "2026-10-26",
    hour: "amc",
    epsEstimate: 0.5,
  });
  const newer = clone(await finnhubFixture("calendar-earnings-two-days"));
  newer.body.earningsCalendar = [
    {
      ...old.body.earningsCalendar[0],
      date: "2026-10-27",
      hour: "bmo",
      epsEstimate: 0.75,
    },
  ];
  let holdMetric = false;
  let marketFetchedAt = 0;
  const f = fakeFetch(async (url) => {
    if (url.pathname === CALENDAR_PATH) {
      if (url.searchParams.has("symbol")) return old;
      marketFetchedAt = clock.now();
      return newer;
    }
    if (holdMetric && url.pathname === "/api/v1/stock/metric") {
      await held.hold();
    }
    return finnhubAnswer(url);
  });
  const client = finnhub({ clock, key: FINNHUB_KEY, fetch: f.fetch });
  const ctx = { db, clock, writer: write, finnhub: client };
  try {
    const instrument = await write.write((db) => share(db, clock.now()));
    // Fresh section runs keep the tick from starting a second daily batch.
    await drive(clock, client, refreshResearch(ctx, instrument));
    expect(readEvents(db, "2026-10-26", "2026-10-27")).toHaveLength(1);
    const firstCall = f.urls.length;
    holdMetric = true;
    const research = refreshResearch(ctx, instrument);
    await drive(clock, client, held.arrived);
    const jobs = finnhubJobs({ ctx, log: silent });
    const tick = jobs.tick();
    held.release();
    const [sections, pass] = await drive(
      clock,
      client,
      Promise.all([research, tick]),
    );
    expect(sections.every((s) => s.status === "ok")).toBe(true);
    expect(pass).toEqual({
      market: { rows: 1, reported: [] },
      asked: [],
      failed: [],
    });
    expect(f.urls.slice(firstCall).map((url) => url.pathname)).toEqual([
      CALENDAR_PATH,
      "/api/v1/stock/metric",
      CALENDAR_PATH,
      "/api/v1/stock/recommendation",
      "/api/v1/stock/earnings",
      "/api/v1/stock/insider-sentiment",
    ]);
    expect(lastRun(db, "finnhub", "market-calendar", "US")?.status).toBe("ok");
    const [event] = readEvents(db, "2026-10-26", "2026-10-27");
    expect(event).toMatchObject({
      date: "2026-10-27",
      hour: "bmo",
      epsEstimate: 0.75,
      fetchedAt: marketFetchedAt,
    });
  } finally {
    held.release();
    client.close();
    await write.close();
    db.close();
  }
});

test("an unrecognized news page fails without discarding unfinished history", async () => {
  const total = PAGE_LIMIT + 5;
  const fake = { articles: await series("NVDA", total, NOW, HOUR_MS) };
  let malformedCursor = false;
  const t = newsSetup(fake, (url) =>
    malformedCursor && url.searchParams.has("cursor")
      ? { recordedAt: "", status: 200, headers: {}, body: {} }
      : undefined,
  );
  try {
    const instrument = await t.write.write((db) => share(db, t.clock.now()));
    const first = await drive(
      t.clock,
      t.client,
      refreshNews(t.ctx, instrument, { maxPages: 1 }),
    );
    expect(first).toMatchObject({
      status: "ok",
      rows: PAGE_LIMIT,
      complete: false,
    });
    const saved = readWalks(t.db, instrument.id).history;
    expect(saved?.cursor).toBeString();
    malformedCursor = true;
    await t.clock.advance(30 * MINUTE_MS);
    const broken = await drive(
      t.clock,
      t.client,
      refreshNews(t.ctx, instrument, { maxPages: 1 }),
    );
    expect(t.f.urls.at(-1)!.href).toBe(saved!.cursor!);
    const afterBroken = readWalks(t.db, instrument.id).history;
    const run = lastRun(t.db, "massive", "news", instrument.id);
    malformedCursor = false;
    await t.clock.advance(30 * MINUTE_MS);
    await drive(t.clock, t.client, refreshNews(t.ctx, instrument));
    expect({
      status: broken.status,
      runStatus: run?.status,
      error: run?.error,
      history: afterBroken,
      recoveredArticles: readNews(t.db, instrument.id, t.clock.now(), total)
        .length,
    }).toEqual({
      status: "failed",
      runStatus: "failed",
      error: "malformed answer",
      history: saved,
      recoveredArticles: total,
    });
  } finally {
    t.client.close();
    await t.write.close();
    t.db.close();
  }
});

test("an invalid fiscal year fails only the calendar and preserves valid research sections", async () => {
  const clock = fakeClock(NOW);
  const { db } = open(":memory:", clock);
  const write = writer(db);
  const invalid = clone(await finnhubFixture("calendar-earnings-nvda"));
  invalid.body.earningsCalendar[0].year = 0;
  const f = fakeFetch((url) =>
    url.pathname === CALENDAR_PATH ? invalid : finnhubAnswer(url),
  );
  const client = finnhub({ clock, key: FINNHUB_KEY, fetch: f.fetch });
  const ctx = { db, clock, writer: write, finnhub: client };
  try {
    const instrument = await write.write((db) => share(db, clock.now()));
    const error = await drive(
      clock,
      client,
      refreshResearch(ctx, instrument).then(
        () => null,
        (error: unknown) => String(error),
      ),
    );
    expect(f.urls.map((url) => url.pathname)).toEqual([
      CALENDAR_PATH,
      "/api/v1/stock/metric",
      "/api/v1/stock/recommendation",
      "/api/v1/stock/earnings",
      "/api/v1/stock/insider-sentiment",
    ]);
    expect({
      error,
      runs: SECTIONS.map(
        (section) => lastRun(db, "finnhub", section, instrument.id)?.status,
      ),
      rows: (["metric", "analysts", "earnings", "insider"] as const).map(
        (kind) => readResearch(db, instrument.id, kind).length,
      ),
      calendarError: lastRun(db, "finnhub", "calendar", instrument.id)?.error,
      events: readEvents(db, "2026-01-01", "2027-12-31").length,
    }).toEqual({
      error: null,
      runs: ["ok", "ok", "ok", "ok", "failed"],
      rows: [1, 4, 3, 8],
      calendarError: "malformed answer",
      events: 0,
    });
  } finally {
    client.close();
    await write.close();
    db.close();
  }
});

test("an older answer under another listing keeps the newer events", () => {
  const { db } = open(":memory:", fakeClock(NOW));
  try {
    const instrument = share(db, NOW);
    const event = (date: string) => ({
      fiscalYear: 2026,
      fiscalQuarter: 3,
      date,
      hour: "amc",
      epsEstimate: 1,
      epsActual: null,
      revenueEstimate: null,
      revenueActual: null,
      reported: false,
    });
    upsertEvents(db, instrument.id, [event("2026-11-05")], null, NOW + 3000);
    storeSection(
      db,
      instrument.id,
      {
        section: "calendar",
        answer: {
          data: [{ ...event("2026-11-01"), epsEstimate: null }],
          listing: "NVDA.MX",
          fetchedAt: NOW + 2000,
        },
      },
      NO_HOOKS,
    );
    expect(readEvents(db, "2026-10-01", "2026-12-31")).toMatchObject([
      { date: "2026-11-05", listing: null, fetchedAt: NOW + 3000 },
    ]);
  } finally {
    db.close();
  }
});
