// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { DAY_MS, MINUTE_MS } from "../src/clock.ts";
import { open } from "../src/db/index.ts";
import { fred } from "../src/fred/client.ts";
import { fredJobs } from "../src/fred/jobs.ts";
import { addSeries } from "../src/fred/sync.ts";
import { readInstrument, upsertInstrument } from "../src/instruments.ts";
import { silent } from "../src/log.ts";
import {
  cursor,
  fitPage,
  fits,
  PAGE_BYTES,
  PageOverflow,
  readCursor,
} from "../src/tools/answer.ts";
import { searchPage } from "../src/tools/search.ts";
import {
  CALL_MS,
  type Markets,
  markets,
  readTargets,
  type Target,
} from "../src/tools/targets.ts";
import { lastReadAt, markRead, TRACK_MS, trackedIds } from "../src/tracking.ts";
import { writer } from "../src/writer.ts";
import { yahoo } from "../src/yahoo/client.ts";
import { yahooJobs } from "../src/yahoo/jobs.ts";
import { addInstrument } from "../src/yahoo/sync.ts";
import { fakeClock } from "./helpers/clock.ts";
import { sim, US, XETRA } from "./helpers/sim.ts";
import { FRED_KEY, gate, NOW, sources } from "./helpers/sources.ts";
import { chartSymbol, fakeFetch, type Recorded } from "./helpers/yahoo.ts";

async function setup(
  options: {
    hold?: (url: URL) => Promise<Recorded | undefined> | undefined;
  } = {},
) {
  const clock = fakeClock(NOW);
  const { db } = open(":memory:", clock);
  const s = await sources({ hold: options.hold });
  const write = writer(db);
  const client = yahoo({ clock, fetch: s.fetch });
  const fredClient = fred({ clock, key: FRED_KEY, fetch: s.fetch });
  const m: Markets = markets({
    db,
    clock,
    writer: write,
    yahoo: client,
    fred: fredClient,
    log: silent,
  });
  return {
    clock,
    db,
    m,
    calls: s.calls,
    fredCtx: { db, clock, writer: write, fred: fredClient },
  };
}

const errorOf = (t: Target | undefined) =>
  t !== undefined && "error" in t ? t.error : null;
const idOf = (t: Target | undefined) =>
  t !== undefined && "instrument" in t ? t.instrument.id : null;

const stored = (db: ReturnType<typeof open>["db"], table: string) =>
  (db.query(`select count(*) as n from ${table}`).get() as { n: number }).n;

describe("a symbol never seen", () => {
  test("two calls naming it at once share one fetch", async () => {
    const t = await setup();
    const [a, b] = await Promise.all([
      readTargets(t.m, ["NVDA"]),
      readTargets(t.m, [" nvda "]),
    ]);
    expect(idOf(a[0])).toBe("US:NVDA");
    expect(idOf(b[0])).toBe("US:NVDA");
    expect(t.calls.searches()).toHaveLength(1);
    expect(t.calls.charts("NVDA")).toHaveLength(1);
    expect(t.calls.sparks()).toHaveLength(1);
    expect(t.m.inflight.size).toBe(0);
  });

  test("not done by the deadline answers timeout and stores nothing", async () => {
    const held = gate();
    const t = await setup({
      hold: (url) => (chartSymbol(url) === "NVDA" ? held.hold() : undefined),
    });
    const read = readTargets(t.m, ["NVDA"]);
    await held.arrived;
    await t.clock.advance(CALL_MS);
    const [target] = await read;
    expect(errorOf(target)).toMatchObject({ error: "timeout" });
    expect(errorOf(target)!.message).toContain("retry this symbol");
    // the fetch goes on after the answer, and lands nothing
    const flights = [...t.m.inflight.values()].map((f) =>
      f.promise.catch(() => {}),
    );
    expect(flights).toHaveLength(1);
    held.release();
    await Promise.all(flights);
    expect(t.calls.sparks()).toHaveLength(1);
    for (const table of ["instruments", "bars", "quotes", "signals"]) {
      expect(stored(t.db, table)).toBe(0);
    }
  });

  test("a source backing off answers rate limited at once", async () => {
    const limited: Recorded = {
      recordedAt: "",
      status: 429,
      headers: {},
      body: "Too Many Requests",
    };
    const t = await setup({
      hold: (url) =>
        url.pathname === "/v1/finance/search"
          ? Promise.resolve(limited)
          : undefined,
    });
    const [first] = await readTargets(t.m, ["NVDA"]);
    expect(errorOf(first)?.error).toBe("rate_limited");
    const asked = t.calls.urls.length;
    // no clock moves: the second read fails while the queue is paused
    const [second] = await readTargets(t.m, ["KO"]);
    expect(errorOf(second)?.error).toBe("rate_limited");
    expect(t.calls.urls.length).toBe(asked);
  });

  test("no count caps the new symbols of a call; only the deadline does", async () => {
    const listings = Array.from({ length: 8 }, (_, k) => XETRA(`S${k}`));
    const s = sim(listings);
    const clock = fakeClock(NOW);
    const { db } = open(":memory:", clock);
    const held = gate();
    const f = fakeFetch((url) =>
      url.pathname === "/v7/finance/spark" &&
      url.searchParams.get("symbols") === "S7.DE"
        ? held.hold().then(() => s.route(url, clock.now()))
        : s.route(url, clock.now()),
    );
    const m = markets({
      db,
      clock,
      writer: writer(db),
      yahoo: yahoo({ clock, fetch: f.fetch }),
      fred: null,
      log: silent,
    });
    const read = readTargets(
      m,
      listings.map((l) => l.symbol),
    );
    await held.arrived;
    await clock.advance(CALL_MS);
    const out = await read;
    expect(out.slice(0, 7).map(idOf)).toEqual(
      Array.from({ length: 7 }, (_, k) => `XETRA:S${k}`),
    );
    expect(errorOf(out[7])).toMatchObject({ error: "timeout" });
    expect(errorOf(out[7])!.message).toContain("retry this symbol");
    held.release();
    await Promise.all(
      [...m.inflight.values()].map((x) => x.promise.catch(() => {})),
    );
    expect(readInstrument(db, "XETRA:S7")).toBeNull();
  });

  test("FRED off answers no data from FRED", async () => {
    const clock = fakeClock(NOW);
    const { db } = open(":memory:", clock);
    const s = await sources();
    const m = markets({
      db,
      clock,
      writer: writer(db),
      yahoo: yahoo({ clock, fetch: s.fetch }),
      fred: null,
      log: silent,
    });
    const [target] = await readTargets(m, ["FRED:DGS10"]);
    expect(errorOf(target)).toEqual({
      error: "no_data",
      message: "no data from FRED",
    });
    expect(s.calls.urls).toHaveLength(0);
  });
});

describe("tracking", () => {
  test("a read renews it, a search does not, and 30 days end it", async () => {
    const t = await setup();
    await readTargets(t.m, ["NVDA"]);
    expect(lastReadAt(t.db, "US:NVDA")).toBe(NOW);
    await t.clock.advance(DAY_MS);
    await readTargets(t.m, ["US:NVDA"]);
    expect(lastReadAt(t.db, "US:NVDA")).toBe(NOW + DAY_MS);
    await t.clock.advance(DAY_MS);
    await searchPage(t.m, { query: "NVDA", next: null });
    expect(lastReadAt(t.db, "US:NVDA")).toBe(NOW + DAY_MS);
    const read = NOW + DAY_MS;
    expect(trackedIds(t.db, read + TRACK_MS - 1).has("US:NVDA")).toBe(true);
    expect(trackedIds(t.db, read + TRACK_MS).has("US:NVDA")).toBe(false);
  });

  test("an instrument no read kept is caught up by the next read", async () => {
    const t = await setup();
    await readTargets(t.m, ["NVDA"]);
    await t.clock.advance(TRACK_MS + DAY_MS);
    const charts = t.calls.charts("NVDA").length;
    const sparks = t.calls.sparks().length;
    const [target] = await readTargets(t.m, ["US:NVDA"]);
    expect(idOf(target)).toBe("US:NVDA");
    expect(t.calls.charts("NVDA")).toHaveLength(charts + 1);
    expect(t.calls.sparks()).toHaveLength(sparks + 1);
    expect(lastReadAt(t.db, "US:NVDA")).toBe(t.clock.now());
  });

  test("the Yahoo jobs sync only tracked instruments, and backfill any", async () => {
    const utc = (iso: string) => Date.parse(`${iso}Z`);
    const s = sim([US("U0"), US("U1"), US("U2")]);
    const clock = fakeClock(utc("2026-10-26T17:58"));
    const { db } = open(":memory:", clock);
    const f = fakeFetch((url) => s.route(url, clock.now()));
    const ctx = {
      db,
      clock,
      yahoo: yahoo({ clock, fetch: f.fetch }),
      writer: writer(db),
    };
    await addInstrument(ctx, "U0");
    await addInstrument(ctx, "U1");
    markRead(db, ["US:U0"], clock.now());
    // read once, 31 days ago
    markRead(db, ["US:U1"], clock.now() - TRACK_MS - DAY_MS);
    // never read and never backfilled
    upsertInstrument(
      db,
      {
        market: "US",
        symbol: "U2",
        source: "yahoo",
        sourceSymbol: "U2",
        exchange: "NMS",
        name: null,
        type: "EQUITY",
        currency: "USD",
        unit: "per_share",
        zone: "America/New_York",
      },
      clock.now(),
    );
    const jobs = yahooJobs({ ctx, quoteEveryMs: 5 * MINUTE_MS, log: silent });
    const before = f.urls.length;
    await clock.advance(2 * MINUTE_MS);
    await jobs.tick();
    const asked = f.urls.slice(before);
    const sparked = asked
      .filter((u) => u.pathname === "/v7/finance/spark")
      .flatMap((u) => u.searchParams.get("symbols")!.split(","));
    expect(sparked).toEqual(["U0"]);
    const charted = asked.map(chartSymbol).filter((x) => x !== null);
    expect(charted).toEqual(["U0"]);
    // the bars of an untracked instrument are kept
    expect(stored(db, "bars where instrument = 'US:U1'")).toBeGreaterThan(0);
    expect(await jobs.backfillTurn()).toBe("US:U2");
  });

  test("the FRED job fetches only tracked series", async () => {
    const t = await setup();
    const ctx = t.fredCtx;
    await addSeries(ctx, "DGS10");
    await addSeries(ctx, "VIXCLS");
    markRead(t.db, ["FRED:DGS10"], t.clock.now());
    const sync = fredJobs({ ctx, log: silent });
    await t.clock.advance(Date.UTC(2026, 9, 26, 23, 0) - t.clock.now());
    const pass = await sync.tick();
    expect(pass?.failed).toEqual([]);
    expect(pass?.changed.map((c) => c.instrument) ?? []).not.toContain(
      "FRED:VIXCLS",
    );
    expect(
      t.db
        .query("select scope from sync_runs where source = 'fred' order by id")
        .all(),
    ).toEqual([{ scope: "FRED:DGS10" }]);
  });
});

describe("pages", () => {
  const items = (n: number, name: string) =>
    Array.from({ length: n }, (_, k) => ({ k, name: `${name}${k}` }));

  test("hold whole items under 32 KiB, quoting and UTF-8 counted", () => {
    // quotes and backslashes double once the text is quoted in the result
    for (const name of [
      '"\\'.repeat(40),
      "日本語✓".repeat(30),
      "x".repeat(200),
    ]) {
      const all = items(400, name);
      let offset = 0;
      while (offset < all.length) {
        const page = fitPage(all.slice(offset), (count) => ({
          next: offset + count < all.length ? String(offset + count) : null,
        }));
        expect(fits(page.text)).toBe(true);
        expect(Buffer.byteLength(page.text)).toBeLessThanOrEqual(PAGE_BYTES);
        const body = JSON.parse(page.text);
        expect(body.items).toEqual(all.slice(offset, offset + page.count));
        expect(page.count).toBeGreaterThan(0);
        // the next item would not have fit
        if (offset + page.count < all.length) {
          const more = JSON.stringify({
            ...body,
            items: all.slice(offset, offset + page.count + 1),
          });
          expect(fits(more)).toBe(false);
        }
        offset += page.count;
      }
    }
  });

  test("an item longer than a page is refused", () => {
    expect(() =>
      fitPage([{ name: "x".repeat(PAGE_BYTES) }], () => ({ next: null })),
    ).toThrow(PageOverflow);
    expect(JSON.parse(fitPage([], () => ({ next: null })).text)).toEqual({
      next: null,
      items: [],
    });
  });

  test("a cursor continues only the arguments it was made for", () => {
    const next = cursor("40", ["A", "B"]);
    expect(readCursor(next, ["A", "B"])).toBe("40");
    expect(readCursor(next, ["A", "C"])).toBeNull();
    expect(readCursor("40", ["A", "B"])).toBeNull();
  });
});
