// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { type App, start } from "../src/app.ts";
import { readBars } from "../src/market/bars.ts";
import { Moved, readInstrument } from "../src/market/instruments.ts";
import { readQuote } from "../src/market/quotes.ts";
import { barsStale, quoteStale, STALE, SWITCH } from "../src/market/stale.ts";
import { readTargets } from "../src/operations/targets.ts";
import { MINUTE_MS } from "../src/runtime/clock.ts";
import { keys, requireBearer } from "../src/runtime/keys.ts";
import { logger } from "../src/runtime/log.ts";
import { bvb, MARKET } from "../src/sources/bvb/client.ts";
import { readSources } from "../src/sources/bvb/switch.ts";
import { fetchInstrument } from "../src/sources/bvb/sync.ts";
import type { Fetch } from "../src/sources/source.ts";
import { backfill, catchUp, refetch } from "../src/sources/yahoo/sync.ts";
import { type Db, open } from "../src/storage/db/index.ts";
import { lastStarted, startRun } from "../src/storage/runs.ts";
import { writer } from "../src/storage/writer.ts";
import { SECRETS } from "./helpers/app.ts";
import { bothSources, bvbRecorded, wapi } from "./helpers/bvb.ts";
import { type FakeClock, fakeClock } from "./helpers/clock.ts";
import { drive } from "./helpers/drive.ts";
import { gate, NOW } from "./helpers/sources.ts";
import { clone, listed, type Recorded, recorded } from "./helpers/yahoo.ts";

const charts = async (): Promise<Record<string, Recorded>> => ({
  "TLV.RO": listed(await recorded("chart-tlv-ro-bonus-2026")),
});

// the feed's history over the same weeks as Yahoo's recorded chart
async function sameWeeks(): Promise<
  (url: URL) => Promise<Recorded> | undefined
> {
  const fx = await bvbRecorded("wapi-history-tlv-1d-bonus-2026");
  return (url) =>
    url.hostname === "wapi.bvb.ro" && url.pathname === "/api/history"
      ? Promise.resolve(fx)
      : undefined;
}

// Yahoo's recorded chart from its sixteenth row, listed from there
async function lateChart(): Promise<Recorded> {
  const fx = clone(await recorded("chart-tlv-ro-bonus-2026"));
  const result = fx.body.chart.result[0];
  result.timestamp = result.timestamp.slice(15);
  const q = result.indicators.quote[0];
  for (const k of ["open", "high", "low", "close", "volume"]) {
    q[k] = q[k].slice(15);
  }
  return listed(fx);
}

function boot(db: Db, clock: FakeClock, fetch: Fetch, feed: boolean): App {
  const store = keys(SECRETS);
  return start({
    hostname: "127.0.0.1",
    port: 0,
    bearer: requireBearer(store),
    clock,
    log: logger(clock, store.values, () => {}),
    version: "v0.0.0-test",
    db,
    quoteEveryMs: 5 * MINUTE_MS,
    bvb: feed,
    fetch,
  });
}

// the switch's calls wait on the feed's spacing, so the clock follows it
const settle = (app: App, clock: FakeClock) =>
  app.bvb === null
    ? app.sourceSwitch.settled()
    : drive(clock, app.bvb, app.sourceSwitch.settled());

async function withTlv(clock: FakeClock, db: Db, fetch: Fetch) {
  const app = boot(db, clock, fetch, false);
  const [t] = await readTargets(app.markets, ["TLV.RO"]);
  expect("instrument" in t! && t.instrument.id).toBe("BVB:TLV");
  await app.stop();
}

describe("switching the Bucharest market's source", () => {
  test("the flag moves the market to the feed and back, and the same flags move nothing", async () => {
    const clock = fakeClock(NOW);
    const { db } = open(":memory:", clock);
    const f = await bothSources({
      charts: await charts(),
      hold: await sameWeeks(),
    });
    await withTlv(clock, db, f.fetch);
    expect(readSources(db)).toEqual(["yahoo"]);
    const yahooBars = readBars(db, "BVB:TLV", "1d").length;

    const on = boot(db, clock, f.fetch, true);
    await settle(on, clock);
    await on.stop();
    expect(readInstrument(db, "BVB:TLV")).toMatchObject({
      source: "bvb",
      sourceSymbol: "TLV",
    });
    // the whole history is the feed's, none of Yahoo's left
    expect(readBars(db, "BVB:TLV", "1d").length).toBe(30);
    expect(readQuote(db, "BVB:TLV")!.source).toBe("bvb");
    expect(readSources(db)).toEqual(["bvb", "yahoo"]);
    expect(wapi(f.exchange, "/api/history")).toHaveLength(1);

    const again = boot(db, clock, f.fetch, true);
    await settle(again, clock);
    await again.stop();
    expect(wapi(f.exchange, "/api/history")).toHaveLength(1);

    const off = boot(db, clock, f.fetch, false);
    await settle(off, clock);
    await off.stop();
    expect(readInstrument(db, "BVB:TLV")).toMatchObject({
      source: "yahoo",
      sourceSymbol: "TLV.RO",
    });
    expect(readBars(db, "BVB:TLV", "1d").length).toBe(yahooBars);
    expect(readQuote(db, "BVB:TLV")!.source).toBe("yahoo");
    expect(readSources(db)).toEqual(["yahoo"]);
    db.close();
  });

  test("a restart during a switch redoes the refetch", async () => {
    const clock = fakeClock(NOW);
    const { db } = open(":memory:", clock);
    const plain = await bothSources({
      charts: await charts(),
      hold: await sameWeeks(),
    });
    await withTlv(clock, db, plain.fetch);

    const g = gate();
    const held = await bothSources({
      charts: await charts(),
      hold: (url) =>
        url.hostname === "wapi.bvb.ro" && url.pathname === "/api/history"
          ? g.hold()
          : undefined,
    });
    const first = boot(db, clock, held.fetch, true);
    await drive(clock, first.bvb!, g.arrived);
    const tlv = readInstrument(db, "BVB:TLV")!;
    // stale until the switch lands
    expect(quoteStale(db, tlv)).toContain(STALE.switchPending);
    expect(barsStale(db, tlv, clock.now())).toContain(STALE.switchPending);
    const stopping = first.stop();
    g.release();
    await stopping;
    expect(readSources(db)).toEqual(["yahoo"]);
    expect(readInstrument(db, "BVB:TLV")!.source).toBe("yahoo");
    expect(lastStarted(db, SWITCH.source, SWITCH.job, MARKET)!.status).toBe(
      "failed",
    );

    const second = boot(db, clock, plain.fetch, true);
    await settle(second, clock);
    await second.stop();
    expect(readInstrument(db, "BVB:TLV")!.source).toBe("bvb");
    expect(readSources(db)).toEqual(["bvb", "yahoo"]);
    expect(quoteStale(db, readInstrument(db, "BVB:TLV")!)).not.toContain(
      STALE.switchPending,
    );
    db.close();
  });

  test("a listing whose new history is short of the stored one stays on its old source", async () => {
    const clock = fakeClock(NOW);
    const { db } = open(":memory:", clock);
    // the feed's recent weeks only, after Yahoo's stored July
    const short = await bothSources({ charts: await charts() });
    await withTlv(clock, db, short.fetch);
    const yahooBars = readBars(db, "BVB:TLV", "1d");
    const on = boot(db, clock, short.fetch, true);
    await settle(on, clock);
    await on.stop();
    const kept = readInstrument(db, "BVB:TLV")!;
    expect(kept).toMatchObject({ source: "yahoo", sourceSymbol: "TLV.RO" });
    expect(readBars(db, "BVB:TLV", "1d")).toEqual(yahooBars);
    expect(readQuote(db, "BVB:TLV")!.source).toBe("yahoo");
    // the switch lands for the rest, so nothing stays pending
    expect(readSources(db)).toEqual(["bvb", "yahoo"]);
    expect(lastStarted(db, SWITCH.source, SWITCH.job, MARKET)!.status).toBe(
      "ok",
    );
    expect(quoteStale(db, kept)).not.toContain(STALE.switchPending);
    db.close();
  });

  test("a feed listing Yahoo's history falls short of stays on the feed, its source off", async () => {
    const clock = fakeClock(NOW);
    const { db } = open(":memory:", clock);
    const full = await bothSources({
      charts: await charts(),
      hold: await sameWeeks(),
    });
    await withTlv(clock, db, full.fetch);
    const feed = boot(db, clock, full.fetch, true);
    await settle(feed, clock);
    await feed.stop();
    const feedBars = readBars(db, "BVB:TLV", "1d");
    expect(readInstrument(db, "BVB:TLV")!.source).toBe("bvb");
    // Yahoo's chart starts weeks after the feed's stored days
    const late = await bothSources({
      charts: { "TLV.RO": await lateChart() },
    });
    const off = boot(db, clock, late.fetch, false);
    await settle(off, clock);
    await off.stop();
    const kept = readInstrument(db, "BVB:TLV")!;
    expect(kept.source).toBe("bvb");
    expect(readBars(db, "BVB:TLV", "1d")).toEqual(feedBars);
    expect(readSources(db)).toEqual(["yahoo"]);
    expect(quoteStale(db, kept)).toContain(STALE.sourceOff);
    db.close();
  });

  test("a feed listing kept with the feed off is stale as its source is off", async () => {
    const clock = fakeClock(NOW);
    const { db } = open(":memory:", clock);
    const f = await bothSources({ charts: await charts() });
    const on = boot(db, clock, f.fetch, true);
    await settle(on, clock);
    const [t] = await drive(
      clock,
      on.bvb!,
      readTargets(on.markets, ["BVB:R2807A"]),
    );
    expect("instrument" in t! && t.instrument.id).toBe("BVB:R2807A");
    await on.stop();
    const bond = () => readInstrument(db, "BVB:R2807A")!;
    expect(quoteStale(db, bond())).not.toContain(STALE.sourceOff);

    const off = boot(db, clock, f.fetch, false);
    await settle(off, clock);
    await off.stop();
    // Yahoo has no bond: it stays the feed's, with its last quote
    expect(bond().source).toBe("bvb");
    expect(readQuote(db, "BVB:R2807A")).not.toBeNull();
    expect(quoteStale(db, bond())).toContain(STALE.sourceOff);
    expect(barsStale(db, bond(), clock.now())).toContain(STALE.sourceOff);
    db.close();
  });

  test("work begun on the old source writes nothing into an instrument the switch moved", async () => {
    const clock = fakeClock(NOW);
    const { db } = open(":memory:", clock);
    const f = await bothSources({
      charts: await charts(),
      hold: await sameWeeks(),
    });
    await withTlv(clock, db, f.fetch);
    // as a Yahoo pass or tool read it before the switch
    const before = readInstrument(db, "BVB:TLV")!;
    const on = boot(db, clock, f.fetch, true);
    await settle(on, clock);
    const bars = readBars(db, "BVB:TLV", "1d");
    const ctx = { db, clock, yahoo: on.yahoo, writer: on.writer };
    await expect(refetch(ctx, before)).rejects.toBeInstanceOf(Moved);
    await expect(backfill(ctx, before)).rejects.toBeInstanceOf(Moved);
    await expect(catchUp(ctx, before, () => true)).rejects.toBeInstanceOf(
      Moved,
    );
    await on.stop();
    expect(readBars(db, "BVB:TLV", "1d")).toEqual(bars);
    expect(readInstrument(db, "BVB:TLV")!.source).toBe("bvb");
    db.close();
  });

  test("a feed fetch of a key stored from Yahoo leaves it to the switch", async () => {
    const clock = fakeClock(NOW);
    const { db } = open(":memory:", clock);
    const f = await bothSources({ charts: await charts() });
    await withTlv(clock, db, f.fetch);
    const bars = readBars(db, "BVB:TLV", "1d");
    const exchange = bvb({ clock, fetch: f.fetch });
    const ctx = { db, clock, bvb: exchange, writer: writer(db) };
    await expect(
      drive(
        clock,
        exchange,
        fetchInstrument(ctx, "TLV", "BVB:TLV", () => true),
      ),
    ).rejects.toBeInstanceOf(Moved);
    expect(readInstrument(db, "BVB:TLV")).toMatchObject({
      source: "yahoo",
      sourceSymbol: "TLV.RO",
    });
    expect(readBars(db, "BVB:TLV", "1d")).toEqual(bars);
    db.close();
  });

  test("a switch a crash left running is redone even with the sources written", async () => {
    const clock = fakeClock(NOW);
    const { db } = open(":memory:", clock);
    const f = await bothSources({
      charts: await charts(),
      hold: await sameWeeks(),
    });
    await withTlv(clock, db, f.fetch);
    db.query("insert into sources (name, since) values ('bvb', 0)").run();
    startRun(db, SWITCH.source, SWITCH.job, clock.now(), MARKET);
    const app = boot(db, clock, f.fetch, true);
    await settle(app, clock);
    await app.stop();
    expect(readInstrument(db, "BVB:TLV")!.source).toBe("bvb");
    expect(lastStarted(db, SWITCH.source, SWITCH.job, MARKET)!.status).toBe(
      "ok",
    );
    db.close();
  });
});
