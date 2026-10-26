// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { type App, start } from "../src/app.ts";
import { readBars } from "../src/bars.ts";
import { MARKET } from "../src/bvb/client.ts";
import { readSources } from "../src/bvb/switch.ts";
import { MINUTE_MS } from "../src/clock.ts";
import { type Db, open } from "../src/db/index.ts";
import { readInstrument } from "../src/instruments.ts";
import { keys, requireBearer } from "../src/keys.ts";
import { logger } from "../src/log.ts";
import { readQuote } from "../src/quotes.ts";
import { lastStarted, startRun } from "../src/runs.ts";
import type { Fetch } from "../src/source.ts";
import { barsStale, quoteStale, STALE, SWITCH } from "../src/stale.ts";
import { readTargets } from "../src/tools/targets.ts";
import { SECRETS } from "./helpers/app.ts";
import { bothSources, wapi } from "./helpers/bvb.ts";
import { type FakeClock, fakeClock } from "./helpers/clock.ts";
import { drive } from "./helpers/drive.ts";
import { gate, NOW } from "./helpers/sources.ts";
import { listed, type Recorded, recorded } from "./helpers/yahoo.ts";

const charts = async (): Promise<Record<string, Recorded>> => ({
  "TLV.RO": listed(await recorded("chart-tlv-ro-bonus-2026")),
});

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
    const f = await bothSources({ charts: await charts() });
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
    const plain = await bothSources({ charts: await charts() });
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

  test("a switch a crash left running is redone even with the sources written", async () => {
    const clock = fakeClock(NOW);
    const { db } = open(":memory:", clock);
    const f = await bothSources({ charts: await charts() });
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
