// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { upsertInstrument } from "../src/market/instruments.ts";
import {
  INTRADAY_SESSIONS,
  type Point,
  readIntraday,
  storeIntraday,
} from "../src/market/intraday.ts";
import { markRead } from "../src/market/tracking.ts";
import { parseHistory } from "../src/operations/history.ts";
import { type Markets, markets } from "../src/operations/markets.ts";
import { silent } from "../src/runtime/log.ts";
import { parseSpark, yahoo } from "../src/sources/yahoo/client.ts";
import { storeQuotes } from "../src/sources/yahoo/quotes.ts";
import { keyOf } from "../src/sources/yahoo/resolve.ts";
import { type Db, open } from "../src/storage/db/index.ts";
import { writer } from "../src/storage/writer.ts";
import { call, tools } from "../src/tools/index.ts";
import { type FakeClock, fakeClock } from "./helpers/clock.ts";
import { bar, instrument, world } from "./helpers/world.ts";
import { clone, type Recorded, recorded } from "./helpers/yahoo.ts";

const SPARKS = [
  "spark-v7-batch",
  "spark-v7-batch-live-0930",
  "spark-v7-batch-open-1330",
  "spark-v7-batch-live-1430",
  "spark-v7-extended-overnight-0030",
  "spark-v7-extended-post-2122",
  "spark-v7-extended-pre-0830",
];

const entry = (fx: Recorded, symbol: string) =>
  fx.body.spark.result.find((r: any) => r.symbol === symbol).response[0];

const noNetwork = async (url: string): Promise<Response> => {
  throw new Error(`no network in tests: ${url}`);
};

// with a final bar and a read, so a call asks no source
function setup(at: number) {
  const clock = fakeClock(at);
  const { db } = open(":memory:", clock);
  const m = markets({
    db,
    clock,
    writer: writer(db),
    yahoo: yahoo({ clock, fetch: noNetwork }),
    fred: null,
    log: silent,
  });
  return { clock, db, m };
}

function listings(db: Db, fx: Recorded, now: number) {
  for (const r of fx.body.spark.result) {
    const meta = r.response[0].meta;
    const id = keyOf(meta.exchangeName, meta.symbol);
    if (db.query("select 1 from instruments where id = ?").get(id)) continue;
    const [market, symbol] = id.split(":") as [string, string];
    upsertInstrument(
      db,
      {
        market,
        symbol,
        source: "yahoo",
        sourceSymbol: meta.symbol,
        exchange: meta.exchangeName,
        name: symbol,
        type: meta.instrumentType,
        currency: meta.currency || null,
        unit: "per_share",
        zone: meta.exchangeTimezoneName,
      },
      now,
    );
    bar(db, id, "1d", "2026-10-01", 1, true);
    markRead(db, [id], now);
  }
}

async function pass(
  t: { clock: FakeClock; db: Db },
  name: string,
  edit?: (fx: Recorded) => void,
) {
  const fx = clone(await recorded(name));
  edit?.(fx);
  const at = Date.parse(fx.recordedAt);
  if (at > t.clock.now()) await t.clock.advance(at - t.clock.now());
  listings(t.db, fx, t.clock.now());
  storeQuotes(t.db, parseSpark(fx.body, t.clock.now()));
}

const sessions = (db: Db, id: string) =>
  db
    .query<{ session: string; n: number }, [string]>(
      `select session, count(*) as n from intraday where instrument = ?
       group by session order by session`,
    )
    .all(id);

const history = async (m: Markets, input: Record<string, unknown>) => {
  const tool = tools(m).find((t) => t.name === "history")!;
  const r = await call(m, tool, input);
  return { error: r.isError === true, body: JSON.parse(r.content[0]!.text) };
};

describe("a spark answer's points", () => {
  test("are each entry's closes, nulls dropped, as the recording ends", async () => {
    for (const name of SPARKS) {
      const fx = await recorded(name);
      const answer = parseSpark(fx.body, 1);
      for (const q of answer.quotes) {
        const raw = entry(fx, q.symbol);
        const kept = raw.timestamp.filter(
          (_: number, k: number) => raw.indicators.quote[0].close[k] !== null,
        );
        expect([name, q.symbol, q.points.map((p) => p.at)]).toEqual([
          name,
          q.symbol,
          kept.map((s: number) => s * 1000),
        ]);
      }
    }
    // a null close is left out: EURUSD=X's last is one
    const batch = parseSpark((await recorded("spark-v7-batch")).body, 1);
    const eur = batch.quotes.find((q) => q.symbol === "EURUSD=X")!;
    expect(eur.points).toHaveLength(223);
    expect(eur.points.every((p) => p.close !== null)).toBe(true);
  });

  test("end at the trade while open and on the grid once closed", async () => {
    const live = parseSpark(
      (await recorded("spark-v7-batch-live-1430")).body,
      1,
    );
    const nvda = live.quotes.find((q) => q.symbol === "NVDA")!;
    expect(new Date(nvda.points.at(-1)!.at).toISOString()).toBe(
      "2026-10-26T14:31:03.000Z",
    );
    expect(nvda.points.at(-1)!.at).toBe(nvda.time);
    const post = parseSpark(
      (await recorded("spark-v7-extended-post-2122")).body,
      1,
    );
    const vwce = post.quotes.find((q) => q.symbol === "VWCE.DE")!;
    expect(new Date(vwce.points.at(-1)!.at).toISOString()).toBe(
      "2026-10-27T16:30:00.000Z",
    );
    expect(vwce.time).toBe(Date.parse("2026-10-27T16:36:00Z"));
  });

  test("are none for an entry with no timestamps or bad columns, which keeps its quote", async () => {
    const fx = clone(await recorded("spark-v7-batch"));
    delete entry(fx, "NVDA").timestamp;
    entry(fx, "TLV.RO").indicators.quote[0].close.pop();
    // whole seconds, but past any date a zone can name
    entry(fx, "VVSM.DE").timestamp[3] = 9_000_000_000_000;
    const answer = parseSpark(fx.body, 1);
    expect(answer.skipped).toEqual([]);
    for (const symbol of ["NVDA", "TLV.RO", "VVSM.DE"]) {
      const q = answer.quotes.find((q) => q.symbol === symbol)!;
      expect(q.price).toBeGreaterThan(0);
      expect(q.points).toEqual([]);
    }
    const t = setup(Date.parse(fx.recordedAt));
    listings(t.db, fx, t.clock.now());
    storeQuotes(t.db, answer);
    const quoted = t.db
      .query("select instrument from quotes order by instrument")
      .all();
    expect(quoted).toContainEqual({ instrument: "XETRA:VVSM" });
    expect(sessions(t.db, "XETRA:VVSM")).toEqual([]);
  });
});

describe("storing points", () => {
  test("a pass replaces its session, a new session adds one, and none older than five stay", async () => {
    const t = setup(Date.parse("2026-10-25T21:04:01Z"));
    await pass(t, "spark-v7-batch");
    expect(sessions(t.db, "XETRA:VVSM")).toEqual([
      { session: "2026-10-23", n: 98 },
    ]);
    await pass(t, "spark-v7-batch-live-0930");
    await pass(t, "spark-v7-batch-live-1430");
    expect(sessions(t.db, "XETRA:VVSM")).toEqual([
      { session: "2026-10-23", n: 98 },
      { session: "2026-10-26", n: 75 },
    ]);
    // five days stored by hand, then a sixth
    const day = (d: string): Point[] => [
      { at: Date.parse(`${d}T12:00:00Z`), close: 1 },
      { at: Date.parse(`${d}T12:05:00Z`), close: 2 },
    ];
    for (const d of ["2026-10-27", "2026-10-28", "2026-10-29"]) {
      storeIntraday(t.db, "XETRA:VVSM", "Europe/Berlin", day(d), 1);
    }
    expect(sessions(t.db, "XETRA:VVSM")).toHaveLength(INTRADAY_SESSIONS);
    storeIntraday(t.db, "XETRA:VVSM", "Europe/Berlin", day("2026-10-30"), 1);
    expect(sessions(t.db, "XETRA:VVSM").map((s) => s.session)).toEqual([
      "2026-10-26",
      "2026-10-27",
      "2026-10-28",
      "2026-10-29",
      "2026-10-30",
    ]);
  });

  test("an answer with no points deletes none, and an older one stores none", async () => {
    const t = setup(Date.parse("2026-10-26T09:30:00Z"));
    await pass(t, "spark-v7-batch-live-1430");
    const before = sessions(t.db, "US:NVDA");
    expect(before).toEqual([{ session: "2026-10-26", n: 14 }]);
    // a later trade with no series
    await t.clock.advance(60_000);
    await pass(t, "spark-v7-batch-live-1430", (fx) => {
      fx.recordedAt = new Date(t.clock.now()).toISOString();
      const nvda = entry(fx, "NVDA");
      nvda.meta.regularMarketTime += 60;
      delete nvda.timestamp;
      nvda.indicators.quote[0] = {};
    });
    expect(sessions(t.db, "US:NVDA")).toEqual(before);
    // the 09:30 answer is older than the stored quote
    const old = await recorded("spark-v7-batch-live-0930");
    storeQuotes(t.db, parseSpark(old.body, t.clock.now()));
    expect(sessions(t.db, "XETRA:VVSM")).toEqual([
      { session: "2026-10-26", n: 75 },
    ]);
  });

  test("a point's session is its market's date, never the UTC one", async () => {
    const t = setup(Date.parse("2026-10-25T21:04:01Z"));
    await pass(t, "spark-v7-batch");
    // EURUSD=X's Friday starts Thursday 23:00 UTC
    const eur = readIntraday(t.db, "CCY:EURUSD=X", "2026-10-01", "2026-10-31");
    expect(eur[0]).toMatchObject({
      session: "2026-10-23",
      at: Date.parse("2026-10-22T23:00:00Z"),
    });
    expect(new Set(eur.map((p) => p.session))).toEqual(new Set(["2026-10-23"]));
    // before the open the answer is the day before's session
    await pass(t, "spark-v7-extended-post-2122");
    await pass(t, "spark-v7-extended-overnight-0030");
    await pass(t, "spark-v7-extended-pre-0830");
    expect(sessions(t.db, "US:HOOD")).toEqual([
      { session: "2026-10-27", n: 79 },
    ]);
    // crypto's day is UTC's
    expect(sessions(t.db, "CRYPTO:BTC-USD")).toEqual([
      { session: "2026-10-27", n: 258 },
      { session: "2026-10-28", n: 103 },
    ]);
    // a US close after midnight UTC is still that evening's session
    storeIntraday(
      t.db,
      "US:HOOD",
      "America/New_York",
      [{ at: Date.parse("2026-10-28T00:30:00Z"), close: 1 }],
      1,
    );
    expect(sessions(t.db, "US:HOOD")).toEqual([
      { session: "2026-10-27", n: 1 },
    ]);
  });
});

describe("history with interval 5m", () => {
  test("answers the newest session by default, and from and to as session dates", async () => {
    const t = setup(Date.parse("2026-10-25T21:04:01Z"));
    await pass(t, "spark-v7-batch");
    await pass(t, "spark-v7-batch-live-1430");
    const today = await history(t.m, { symbol: "XETRA:VVSM", interval: "5m" });
    expect(today.error).toBe(false);
    expect(today.body).toMatchObject({
      id: "XETRA:VVSM",
      interval: "5m",
      from: "2026-10-26",
      to: "2026-10-26",
      session: { state: "open" },
      next: null,
    });
    expect(today.body.sessions).toEqual([
      { session: "2026-10-26", fetched_at: "2026-10-26T14:31:04Z" },
    ]);
    expect(today.body.points).toHaveLength(75);
    expect(today.body.points[0]).toEqual({
      at: "2026-10-26T08:00:00Z",
      session: "2026-10-26",
      close: expect.any(Number),
      final: true,
    });
    // the open session's newest point is still moving
    expect(today.body.points.at(-1).final).toBe(false);
    const both = await history(t.m, {
      symbol: "XETRA:VVSM",
      interval: "5m",
      from: "2026-10-20",
    });
    expect(both.body.points).toHaveLength(98 + 75);
    const friday = await history(t.m, {
      symbol: "XETRA:VVSM",
      interval: "5m",
      to: "2026-10-23",
    });
    expect(friday.body).toMatchObject({ from: "2026-10-23", to: "2026-10-23" });
    expect(friday.body.points).toHaveLength(98);
    expect(friday.body.points.every((p: any) => p.final)).toBe(true);
  });

  test("measures from the quote's previous close for the newest session, else the daily close before the first", async () => {
    const t = setup(Date.parse("2026-10-25T21:04:01Z"));
    await pass(t, "spark-v7-batch");
    await pass(t, "spark-v7-batch-live-1430");
    const quoted = t.db
      .query<{ p: number }, []>(
        "select previous_close as p from quotes where instrument = 'XETRA:VVSM'",
      )
      .get()!.p;
    const today = await history(t.m, { symbol: "XETRA:VVSM", interval: "5m" });
    expect(today.body.previous_close).toBe(quoted);
    const both = await history(t.m, {
      symbol: "XETRA:VVSM",
      interval: "5m",
      from: "2026-10-20",
    });
    // the bar the world helper stores on 2026-10-01
    expect(both.body.previous_close).toBe(1);
    // a quote already in the next session never measures this one
    t.db
      .query(
        "update quotes set time = ?, previous_close = 999 where instrument = 'XETRA:VVSM'",
      )
      .run(Date.parse("2026-10-27T08:01:00Z"));
    const rolled = await history(t.m, {
      symbol: "XETRA:VVSM",
      interval: "5m",
    });
    expect(rolled.body.to).toBe("2026-10-26");
    expect(rolled.body.previous_close).toBe(1);
  });

  test("a closed session's newest point is final; crypto's newest never is", async () => {
    const t = setup(Date.parse("2026-10-27T21:22:55Z"));
    await pass(t, "spark-v7-extended-post-2122");
    const vwce = await history(t.m, { symbol: "XETRA:VWCE", interval: "5m" });
    expect(vwce.body.session.state).toBe("closed");
    expect(vwce.body.points.every((p: any) => p.final)).toBe(true);
    const btc = await history(t.m, {
      symbol: "CRYPTO:BTC-USD",
      interval: "5m",
    });
    expect(btc.body.points.at(-1).final).toBe(false);
    expect(btc.body.points.filter((p: any) => !p.final)).toHaveLength(1);
  });

  test("pages past 32 KiB with next, no point repeated or lost", async () => {
    const t = setup(Date.parse("2026-10-30T12:00:00Z"));
    await pass(t, "spark-v7-batch");
    const id = "CRYPTO:SOL-USD";
    const all: number[] = [];
    for (const d of ["26", "27", "28", "29", "30"]) {
      const day = Date.parse(`2026-10-${d}T00:00:00Z`);
      const points = Array.from({ length: 288 }, (_, k) => ({
        at: day + k * 300_000,
        close: 123.456789 + k,
      }));
      all.push(...points.map((p) => p.at));
      storeIntraday(t.db, id, "UTC", points, t.clock.now());
    }
    const input = { symbol: id, interval: "5m", from: "2026-10-01" };
    const seen: string[] = [];
    let next: string | null = null;
    let pages = 0;
    do {
      const page = await history(
        t.m,
        next === null ? input : { ...input, next },
      );
      expect(page.error).toBe(false);
      seen.push(...page.body.points.map((p: any) => p.at));
      next = page.body.next;
      pages++;
    } while (next !== null && pages < 20);
    expect(pages).toBeGreaterThan(1);
    expect(seen).toEqual(
      all.map((at) => `${new Date(at).toISOString().slice(0, 19)}Z`),
    );
    // a cursor continues only its own arguments
    const first = await history(t.m, input);
    const other = await history(t.m, {
      ...input,
      from: "2026-10-02",
      next: first.body.next,
    });
    expect(other.body.error).toBe("bad_arguments");
    // the next point cleared: the walk is refused, never ended in silence
    t.db.query("delete from intraday").run();
    const gone = await history(t.m, { ...input, next: first.body.next });
    expect(gone.body).toMatchObject({
      error: "bad_arguments",
      message: "next does not continue these arguments",
    });
  });

  test("extended is asked with 5m only, and a failed read keeps the answer", async () => {
    expect(() =>
      parseHistory({ symbol: "NVDA", interval: "1d", extended: true }),
    ).toThrow("extended is taken with interval 5m only");
    expect(() =>
      parseHistory({ symbol: "NVDA", interval: "5m", extended: "yes" }),
    ).toThrow("extended must be true or false");
    const t = setup(Date.parse("2026-10-27T21:22:55Z"));
    await pass(t, "spark-v7-extended-post-2122");
    const plain = await history(t.m, { symbol: "US:HOOD", interval: "5m" });
    expect(plain.body).not.toHaveProperty("extended_points");
    // the read reaches no network here: it fails and the points stand
    const asked = await history(t.m, {
      symbol: "US:HOOD",
      interval: "5m",
      extended: true,
    });
    expect(asked.error).toBe(false);
    expect(asked.body.extended_points).toEqual([]);
    expect(asked.body.points).toEqual(plain.body.points);
  });

  test("refuses benchmark, and answers no_data for a source without points or a range without any", async () => {
    expect(() =>
      parseHistory({ symbol: "NVDA", interval: "5m", benchmark: "^GSPC" }),
    ).toThrow("benchmark is not taken with interval 5m");
    const t = setup(Date.parse("2026-10-25T21:04:01Z"));
    await pass(t, "spark-v7-batch");
    const none = await history(t.m, {
      symbol: "XETRA:VVSM",
      interval: "5m",
      from: "2026-09-01",
      to: "2026-09-30",
    });
    expect(none).toEqual({
      error: true,
      body: {
        input: "XETRA:VVSM",
        error: "no_data",
        message: "no 5-minute closes stored from 2026-09-01 to 2026-09-30",
      },
    });
    t.db.query("delete from intraday").run();
    const empty = await history(t.m, { symbol: "XETRA:VVSM", interval: "5m" });
    expect(empty.body.error).toBe("no_data");
    const w = world();
    instrument(w.db, "XX:A");
    bar(w.db, "XX:A", "1d", "2026-10-22", 1, true);
    const other = await history(w.m, { symbol: "XX:A", interval: "5m" });
    expect(other.body).toEqual({
      input: "XX:A",
      error: "no_data",
      message: "this instrument's source gives no 5-minute closes",
    });
  });
});
