// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { dailyRange, upsertBars } from "../src/market/bars.ts";
import { recordSession } from "../src/market/calendars.ts";
import { readInstrument, upsertInstrument } from "../src/market/instruments.ts";
import { lastReadAt, markRead, trackedIds } from "../src/market/tracking.ts";
import { readTargets, storedInstrument } from "../src/operations/targets.ts";
import { seed } from "../src/operations/track.ts";
import { DAY_MS, MINUTE_MS } from "../src/runtime/clock.ts";
import { writeSources } from "../src/sources/bvb/switch.ts";
import { type Db, open } from "../src/storage/db/index.ts";
import { type TestApp, withApp } from "./helpers/app.ts";
import { bothSources } from "./helpers/bvb.ts";
import { fakeClock } from "./helpers/clock.ts";
import { gate, sources } from "./helpers/sources.ts";
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

  test("a restart in the session it was synced in keeps its news and asks no chart", async () => {
    const s = await sources({ charts: await charts() });
    const { db } = open(":memory:", fakeClock(OPEN));
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
            ).run(DJI, OPEN - 3_600_000, OPEN);
          });
        },
        { fetch: s.fetch, start: OPEN, track: ["^DJI"], db },
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
        { fetch: s.fetch, start: OPEN, track: ["^DJI"], db },
      );
    } finally {
      db.close();
    }
  });

  test("a stored value that missed sessions is flagged at once and caught up", async () => {
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
          // flagged for the prune and the jobs, owed for the reads, before
          // the first pass can land
          expect(t.app.tracker.status()).toEqual([
            { value: "^DJI", id: DJI, state: "pending" },
          ]);
          expect([...t.app.markets.tracking.flagged]).toEqual([DJI]);
          expect([...t.app.markets.tracking.owed]).toEqual([DJI]);
          await t.app.tracker.settled();
          expect(lastDate()).toBe("2026-10-27");
          const [asked] = s.calls.charts("^DJI");
          expect(Number(asked!.searchParams.get("period1")) * 1000).toBe(
            Date.parse("2026-06-26T04:00:00Z"),
          );
          expect((await status(t)).track).toEqual([
            { value: "^DJI", id: DJI, state: "tracked" },
          ]);
          expect(t.app.markets.tracking.owed.size).toBe(0);
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

// one daily bar on date, written 60 days before OPEN, as a read long ago left it
function stored(
  db: Db,
  id: string,
  date: string,
  source = "yahoo",
  sourceSymbol = id.slice(id.indexOf(":") + 1),
) {
  const [market, symbol] = id.split(":") as [string, string];
  const bvb = market === "BVB";
  upsertInstrument(
    db,
    {
      market,
      symbol,
      source,
      sourceSymbol,
      exchange: market,
      name: "made up",
      type: "EQUITY",
      currency: bvb ? "RON" : "USD",
      unit: "per_share",
      zone: bvb ? "Europe/Bucharest" : "America/New_York",
    },
    OPEN - 60 * DAY_MS,
  );
  const bar = { date, open: 10, high: 10, low: 10, close: 10, volume: 100 };
  upsertBars(db, id, "1d", [{ ...bar, final: true }], OPEN - 60 * DAY_MS);
}

const NVDA = "US:NVDA";
// the US session the reviewers' probes ran in
const US_SESSION = {
  zone: "America/New_York",
  start: Date.parse("2026-10-28T13:30:00Z"),
  end: Date.parse("2026-10-28T20:00:00Z"),
};

const count = (db: Db, table: string): number =>
  db.query<{ n: number }, []>(`select count(*) as n from ${table}`).get()!.n;

describe("--track at start", () => {
  test("a value that missed sessions keeps its news and is caught up before a read answers", async () => {
    const { db } = open(":memory:", fakeClock(OPEN));
    stored(db, NVDA, "2026-10-05");
    recordSession(db, "US", US_SESSION, OPEN);
    db.query(
      `insert into news (instrument, id, published_at, title, url, fetched_at)
       values (?, 'recent', ?, 't', 'u', ?)`,
    ).run(NVDA, OPEN - DAY_MS, OPEN);
    db.query(
      `insert into news_walks (instrument, walk, cursor, after)
       values (?, 'history', 'cursor', null)`,
    ).run(NVDA);
    const s = await sources();
    try {
      await withApp(
        async (t) => {
          // a read at once, before the tracker's catch-up can land
          const read = readTargets(t.app.markets, ["NVDA"]);
          expect(t.app.tracker.status()).toEqual([
            { value: "NVDA", id: NVDA, state: "pending" },
          ]);
          await t.app.writer.write(() => {});
          expect(count(db, "news")).toBe(1);
          expect(count(db, "news_walks")).toBe(1);
          const [target] = await read;
          expect(target && "instrument" in target).toBe(true);
          expect(dailyRange(db, NVDA)!.last > "2026-10-05").toBe(true);
          await t.app.tracker.settled();
          expect(t.app.tracker.status()[0]!.state).toBe("tracked");
          expect(t.app.markets.tracking.owed.size).toBe(0);
        },
        { fetch: s.fetch, start: OPEN, track: ["NVDA"], db },
      );
    } finally {
      db.close();
    }
  });

  test("a value whose source is off waits for a source switch", async () => {
    const { db } = open(":memory:", fakeClock(OPEN));
    stored(db, "BVB:TLV", "2026-07-01", "bvb", "TLV");
    // the last start had the feed; this one has not
    writeSources(db, ["bvb", "yahoo"], OPEN - DAY_MS);
    const s = await sources({
      charts: { "TLV.RO": listed(await recorded("chart-tlv-ro-bonus-2026")) },
    });
    try {
      await withApp(
        async (t) => {
          expect(t.app.tracker.status()[0]!.id).toBeNull();
          expect(t.app.markets.tracking.flagged.size).toBe(0);
          await t.app.tracker.settled();
          await t.app.sourceSwitch.settled();
          expect(readInstrument(db, "BVB:TLV")!.source).toBe("yahoo");
          await t.clock.advance(PERIOD);
          await t.app.tracker.settled();
          expect(t.app.tracker.status()).toEqual([
            { value: "BVB:TLV", id: "BVB:TLV", state: "tracked" },
          ]);
          const now = t.clock.now();
          expect(
            trackedIds(db, now, t.app.markets.tracking).has("BVB:TLV"),
          ).toBe(true);
        },
        { fetch: s.fetch, start: OPEN, track: ["BVB:TLV"], db },
      );
    } finally {
      db.close();
    }
  });

  test("a read goes ahead of the tracker's queued fetches", async () => {
    const running = gate();
    const waiting = gate();
    const names = ["^FIRST", "^SECOND", "^THIRD", "^FOURTH"];
    const chart = listed(await recorded("chart-dji-5d-1d"));
    const charts = Object.fromEntries(
      names.map((name) => {
        const fx = clone(chart);
        fx.body.chart.result[0].meta.symbol = name;
        return [name, fx];
      }),
    );
    const s = await sources({
      charts,
      hold: (url) => {
        const symbol = chartSymbol(url);
        if (symbol === "^FIRST" || symbol === "^SECOND") return running.hold();
        if (symbol === "^THIRD" || symbol === "^FOURTH") return waiting.hold();
        return undefined;
      },
    });
    await withApp(
      async (t) => {
        try {
          // both slots hold tracker calls, two more wait behind them
          await running.arrived;
          const read = readTargets(t.app.markets, ["NVDA"]);
          running.release();
          await waiting.arrived;
          const order = s.calls.urls.map(
            (u) => chartSymbol(u) ?? u.searchParams.get("q"),
          );
          // the read's search took the first freed slot
          expect(order.slice(0, 3)).toEqual(["^FIRST", "^SECOND", "NVDA"]);
          waiting.release();
          const [target] = await read;
          expect(target && "instrument" in target).toBe(true);
          await t.app.tracker.settled();
        } finally {
          // a held call would hold the stop
          running.release();
          waiting.release();
        }
      },
      { fetch: s.fetch, start: OPEN, track: names },
    );
  });
});

describe("seed", () => {
  const seeded = (db: Db, values: string[], on = { bvb: true, fred: true }) => {
    const flagged = new Set<string>();
    const owed = new Set<string>();
    const states = seed({
      db,
      values,
      on,
      readMs: 30 * DAY_MS,
      flagged,
      owed,
      now: OPEN,
    });
    return { states, flagged, owed };
  };

  test("a value read within the window owes no catch-up", () => {
    const { db } = open(":memory:", fakeClock(OPEN));
    stored(db, NVDA, "2026-10-05");
    recordSession(db, "US", US_SESSION, OPEN);
    markRead(db, [NVDA], OPEN - DAY_MS);
    const s = seeded(db, ["NVDA"]);
    expect(s.states).toEqual([{ value: "NVDA", id: NVDA, state: "tracked" }]);
    expect([...s.flagged]).toEqual([NVDA]);
    expect(s.owed.size).toBe(0);
    db.close();
  });

  test("a value whose source is off or not stored is left to the tracker", () => {
    const { db } = open(":memory:", fakeClock(OPEN));
    stored(db, "BVB:TLV", "2026-10-27", "bvb", "TLV");
    stored(db, "FRED:DGS10", "2026-10-27", "fred", "DGS10");
    const s = seeded(db, ["BVB:TLV", "FRED:DGS10", "^NOPE"], {
      bvb: false,
      fred: false,
    });
    expect(s.states.map((x) => [x.id, x.state])).toEqual([
      [null, "pending"],
      [null, "pending"],
      [null, "pending"],
    ]);
    expect(s.flagged.size).toBe(0);
    db.close();
  });

  test("with the feed on, a feed symbol is found in any case", () => {
    const { db } = open(":memory:", fakeClock(OPEN));
    stored(db, "BVB:BETPLUS", "2026-10-27", "bvb", "BETPlus");
    expect(storedInstrument(db, "betplus", true)?.id).toBe("BVB:BETPLUS");
    expect(storedInstrument(db, "betplus", false)).toBeNull();
    db.close();
  });

  test("a symbol stored by both sources stays pending, then answers candidates", async () => {
    const { db } = open(":memory:", fakeClock(OPEN));
    stored(db, "BVB:TLV", "2026-10-27", "bvb", "TLV");
    stored(db, "US:TLV", "2026-10-27");
    expect(storedInstrument(db, "TLV", true)).toBeNull();
    const f = await bothSources();
    try {
      await withApp(
        async (t) => {
          expect(t.app.tracker.status()[0]!.id).toBeNull();
          await t.app.tracker.settled();
          expect(t.app.tracker.status()).toEqual([
            { value: "TLV", id: null, state: "candidates" },
          ]);
        },
        { fetch: f.fetch, start: OPEN, track: ["TLV"], bvb: true, db },
      );
    } finally {
      db.close();
    }
  });
});
