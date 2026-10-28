// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { readInstrument } from "../src/market/instruments.ts";
import { lastReadAt, trackedIds } from "../src/market/tracking.ts";
import { MINUTE_MS } from "../src/runtime/clock.ts";
import { open } from "../src/storage/db/index.ts";
import { type TestApp, withApp } from "./helpers/app.ts";
import { fakeClock } from "./helpers/clock.ts";
import { sources } from "./helpers/sources.ts";
import {
  backTo,
  chartSymbol,
  clone,
  listed,
  type Recorded,
  recorded,
} from "./helpers/yahoo.ts";

// the index and futures charts were recorded at 07:45 UTC on 28 October
const NOW = Date.parse("2026-10-28T08:00:00Z");
// the Dow open, so each quote pass asks for it
const OPEN = Date.parse("2026-10-28T14:00:00Z");
const PERIOD = 5 * MINUTE_MS;
const DJI = "DJI:^DJI";
const GOLD = "CMX:GC=F";

async function charts(): Promise<Record<string, Recorded>> {
  return {
    "^DJI": listed(await recorded("chart-dji-5d-1d")),
    "GC=F": listed(await recorded("chart-gc-f-5d-1d")),
  };
}

const bars = (t: TestApp, id: string): number =>
  t.db
    .query<{ n: number }, [string]>(
      "select count(*) as n from bars where instrument = ? and interval = '1d'",
    )
    .get(id)!.n;

const status = async (t: TestApp): Promise<any> =>
  (
    await fetch(`${t.url}/api/v1/admin/status`, {
      headers: { authorization: `Bearer ${t.admin}` },
    })
  ).json();

const notResolved = (t: TestApp, value: string): string[] =>
  t.lines.filter(
    (l) =>
      l.includes("track value not resolved") && l.includes(`value=${value} `),
  );

describe("--track", () => {
  test("a value not stored is fetched on start and tracked with no read", async () => {
    const s = await sources({ charts: await charts() });
    await withApp(
      async (t) => {
        await t.app.tracker.settled();
        for (const id of [DJI, GOLD]) {
          expect(bars(t, id)).toBeGreaterThan(0);
          expect(lastReadAt(t.db, id)).toBeNull();
        }
        expect(readInstrument(t.db, DJI)?.unit).toBe("index_points");
        expect(readInstrument(t.db, GOLD)?.unit).toBe("unknown");
        const now = t.clock.now();
        const tracked = trackedIds(t.db, now, t.app.markets.tracking);
        expect([...tracked].sort()).toEqual([GOLD, DJI].sort());
        // no read and no rule names them
        expect(trackedIds(t.db, now).size).toBe(0);
        const b = await status(t);
        expect(b.tracked).toBe(2);
        expect(b.track).toEqual([
          { value: "^DJI", id: DJI, state: "tracked" },
          { value: "GC=F", id: GOLD, state: "tracked" },
        ]);
        // resolved once: a later period asks nothing more of it
        const asked = s.calls.charts("^DJI").length;
        await t.clock.advance(PERIOD);
        await t.app.tracker.settled();
        expect(s.calls.searches()).toHaveLength(0);
        expect(s.calls.charts("^DJI").length).toBe(asked);
      },
      { fetch: s.fetch, start: NOW, track: ["^DJI", "GC=F"] },
    );
  });

  test("a value with no answer is logged once and retried each period", async () => {
    let listedNow = false;
    const unknown = await recorded("chart-unknown-symbol");
    const s = await sources({
      charts: await charts(),
      hold: async (url) =>
        chartSymbol(url) === "^DJI" && !listedNow ? unknown : undefined,
    });
    await withApp(
      async (t) => {
        await t.app.tracker.settled();
        expect(notResolved(t, "^DJI")).toHaveLength(1);
        expect(notResolved(t, "^DJI")[0]).toContain("error=not_found");
        expect((await status(t)).track).toEqual([
          { value: "^DJI", id: null, state: "not_found" },
        ]);
        const asked = s.calls.charts("^DJI").length;
        await t.clock.advance(PERIOD);
        await t.app.tracker.settled();
        expect(s.calls.charts("^DJI").length).toBeGreaterThan(asked);
        // the same reason again is not logged again
        expect(notResolved(t, "^DJI")).toHaveLength(1);
        listedNow = true;
        await t.clock.advance(PERIOD);
        await t.app.tracker.settled();
        expect((await status(t)).track).toEqual([
          { value: "^DJI", id: DJI, state: "tracked" },
        ]);
        expect(bars(t, DJI)).toBeGreaterThan(0);
        expect(trackedIds(t.db, t.clock.now(), t.app.markets.tracking)).toEqual(
          new Set([DJI]),
        );
      },
      { fetch: s.fetch, start: NOW, track: ["^DJI"] },
    );
  });

  test("candidates are logged with their ids and never retried", async () => {
    const s = await sources();
    await withApp(
      async (t) => {
        await t.app.tracker.settled();
        const [line] = notResolved(t, "NVIDIA");
        expect(line).toContain("error=candidates");
        expect(line).toContain("US:NVDA");
        expect(line).toContain("retried=false");
        const asked = s.calls.urls.length;
        await t.clock.advance(PERIOD);
        await t.app.tracker.settled();
        expect(s.calls.searches()).toHaveLength(1);
        expect(s.calls.urls.length).toBe(asked);
        expect((await status(t)).track).toEqual([
          { value: "NVIDIA", id: null, state: "candidates" },
        ]);
      },
      { fetch: s.fetch, start: NOW, track: ["NVIDIA"] },
    );
  });

  test("a Bucharest value with the feed off is logged and skipped", async () => {
    const s = await sources();
    await withApp(
      async (t) => {
        await t.app.tracker.settled();
        const [line] = notResolved(t, "BVB:BET");
        expect(line).toContain("error=no_data");
        const asked = s.calls.urls.length;
        await t.clock.advance(PERIOD);
        await t.app.tracker.settled();
        expect(s.calls.urls.length).toBe(asked);
        expect((await status(t)).track).toEqual([
          { value: "BVB:BET", id: null, state: "no_data" },
        ]);
      },
      { fetch: s.fetch, start: NOW, track: ["BVB:BET"] },
    );
  });

  test("a start without the value untracks it and keeps its bars", async () => {
    const s = await sources({ charts: await charts() });
    const { db } = open(":memory:", fakeClock(NOW));
    try {
      let stored = 0;
      await withApp(
        async (t) => {
          await t.app.tracker.settled();
          stored = bars(t, DJI);
          expect(stored).toBeGreaterThan(0);
        },
        { fetch: s.fetch, start: NOW, track: ["^DJI"], db },
      );
      await withApp(
        async (t) => {
          await t.app.tracker.settled();
          const now = t.clock.now();
          expect(trackedIds(t.db, now, t.app.markets.tracking).size).toBe(0);
          expect(bars(t, DJI)).toBe(stored);
          expect((await status(t)).track).toEqual([]);
        },
        { fetch: s.fetch, start: NOW, db },
      );
    } finally {
      db.close();
    }
  });

  test("a restart with the value stored keeps its news and asks no chart", async () => {
    const s = await sources({ charts: await charts() });
    const { db } = open(":memory:", fakeClock(NOW));
    const news = () =>
      db.query<{ n: number }, []>("select count(*) as n from news").get()!.n;
    try {
      await withApp(
        async (t) => {
          await t.app.tracker.settled();
          await t.app.writer.write((d) => {
            d.query(
              `insert into news (instrument, id, published_at, title, url,
                 fetched_at) values (?, 'n1', ?, 't', 'u', ?)`,
            ).run(DJI, NOW - 3_600_000, NOW);
          });
        },
        { fetch: s.fetch, start: NOW, track: ["^DJI"], db },
      );
      const asked = s.calls.charts("^DJI").length;
      await withApp(
        async (t) => {
          // tracked before any call: the startup prune and reads see it
          expect((await status(t)).track).toEqual([
            { value: "^DJI", id: DJI, state: "tracked" },
          ]);
          await t.app.tracker.settled();
          await t.app.writer.write(() => {});
          expect(news()).toBe(1);
          expect(s.calls.charts("^DJI").length).toBe(asked);
          expect(lastReadAt(t.db, DJI)).toBeNull();
        },
        { fetch: s.fetch, start: NOW, track: ["^DJI"], db },
      );
    } finally {
      db.close();
    }
  });

  test("a stored value further behind than the refetch window is caught up at start", async () => {
    const then = Date.parse("2026-07-01T08:00:00Z");
    const full = listed(
      backTo(await recorded("chart-dji-5d-1d"), "2026-05-04"),
    );
    // the same listing as answered on 1 July, its last day 26 June
    const old = clone(full);
    const r = old.body.chart.result[0];
    const keep = r.timestamp.filter(
      (at: number) => at * 1000 < Date.parse("2026-06-27T00:00:00Z"),
    ).length;
    r.timestamp = r.timestamp.slice(0, keep);
    for (const k of ["open", "high", "low", "close", "volume"]) {
      r.indicators.quote[0][k] = r.indicators.quote[0][k].slice(0, keep);
    }
    const { db } = open(":memory:", fakeClock(then));
    const lastDate = () =>
      db
        .query<{ d: string }, [string]>(
          "select max(date) as d from bars where instrument = ? and interval = '1d'",
        )
        .get(DJI)!.d;
    try {
      const first = await sources({ charts: { "^DJI": old } });
      await withApp(
        async (t) => {
          await t.app.tracker.settled();
        },
        { fetch: first.fetch, start: then, track: ["^DJI"], db },
      );
      expect(lastDate()).toBe("2026-06-26");
      const s = await sources({ charts: { "^DJI": full } });
      await withApp(
        async (t) => {
          // not seeded, checked before the first pass can land
          expect(t.app.tracker.status()).toEqual([
            { value: "^DJI", id: null, state: "pending" },
          ]);
          expect(t.app.markets.tracking.flagged.size).toBe(0);
          await t.app.tracker.settled();
          expect(lastDate()).toBe("2026-10-27");
          const [asked] = s.calls.charts("^DJI");
          expect(Number(asked!.searchParams.get("period1")) * 1000).toBe(
            Date.parse("2026-06-26T04:00:00Z"),
          );
          expect((await status(t)).track).toEqual([
            { value: "^DJI", id: DJI, state: "tracked" },
          ]);
          expect(lastReadAt(t.db, DJI)).toBeNull();
        },
        { fetch: s.fetch, start: NOW, track: ["^DJI"], db },
      );
    } finally {
      db.close();
    }
  });

  test("a flagged instrument deleted by the operator is fetched again", async () => {
    const s = await sources({ charts: await charts() });
    await withApp(
      async (t) => {
        await t.app.tracker.settled();
        const deleted = await fetch(
          `${t.url}/api/v1/admin/instruments/${encodeURIComponent(DJI)}`,
          {
            method: "DELETE",
            headers: { authorization: `Bearer ${t.admin}` },
          },
        );
        expect(deleted.status).toBe(200);
        expect(bars(t, DJI)).toBe(0);
        await t.clock.advance(PERIOD);
        await t.app.tracker.settled();
        expect(bars(t, DJI)).toBeGreaterThan(0);
        expect((await status(t)).track).toEqual([
          { value: "^DJI", id: DJI, state: "tracked" },
        ]);
        expect(trackedIds(t.db, t.clock.now(), t.app.markets.tracking)).toEqual(
          new Set([DJI]),
        );
      },
      { fetch: s.fetch, start: NOW, track: ["^DJI"] },
    );
  });

  test("the quote job asks for a flagged instrument with no read or rule", async () => {
    const s = await sources({ charts: await charts() });
    await withApp(
      async (t) => {
        await t.app.tracker.settled();
        const before = s.calls.sparks().length;
        await t.clock.advance(PERIOD);
        const asked = s.calls
          .sparks()
          .slice(before)
          .flatMap((u) => u.searchParams.get("symbols")!.split(","));
        expect(asked).toContain("^DJI");
        expect(lastReadAt(t.db, DJI)).toBeNull();
      },
      { fetch: s.fetch, start: OPEN, track: ["^DJI"] },
    );
  });
});
