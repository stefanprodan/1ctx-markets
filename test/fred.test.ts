// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { start } from "../src/app.ts";
import { readBars } from "../src/bars.ts";
import { MINUTE_MS } from "../src/clock.ts";
import { open } from "../src/db/index.ts";
import {
  fred,
  parseObservations,
  parseSeries,
  SOURCE,
} from "../src/fred/client.ts";
import { dueAt, fredJobs, seriesStale } from "../src/fred/jobs.ts";
import {
  ATTRIBUTION,
  addSeries,
  backfillStart,
  DAILY_ONLY,
  type FredContext,
  NO_DATA,
  Refused,
  refetchSeries,
  unitOf,
} from "../src/fred/sync.ts";
import { readInstrument } from "../src/instruments.ts";
import { keys } from "../src/keys.ts";
import { format, logger, silent } from "../src/log.ts";
import { lastRun } from "../src/runs.ts";
import { QueueClosed, SourceError } from "../src/source.ts";
import { STALE } from "../src/stale.ts";
import { writer } from "../src/writer.ts";
import { fakeClock } from "./helpers/clock.ts";
import { clone, fakeFetch, type Recorded } from "./helpers/yahoo.ts";

const FIXTURES = join(import.meta.dir, "fixtures", "fred");
// made up: no real key is ever read by a test
const KEY = "0f1e2d3c4b5a69788796a5b4c3d2e1f0";
const SERIES = ["DGS10", "BAMLH0A0HYM2", "VIXCLS", "DCOILWTICO"];

const fixture = (name: string): Promise<Recorded> =>
  Bun.file(join(FIXTURES, `${name}.json`)).json();

const isSeries = (u: URL) => u.pathname === "/fred/series";
const isObservations = (u: URL) => u.pathname === "/fred/series/observations";

// the recorded answer for the series a URL names
async function answer(url: URL): Promise<Recorded> {
  const id = url.searchParams.get("series_id")!;
  if (!SERIES.includes(id)) return fixture("observations-unknown");
  if (isSeries(url)) return fixture(`series-${id.toLowerCase()}`);
  if (isObservations(url)) return fixture(`observations-${id.toLowerCase()}`);
  throw new Error(`no fixture for ${url}`);
}

function setup(
  route: (url: URL) => Recorded | Promise<Recorded> = answer,
  start = Date.UTC(2026, 9, 26, 7, 0),
) {
  const clock = fakeClock(start);
  const { db } = open(":memory:", clock);
  const f = fakeFetch(route);
  const ctx: FredContext = {
    db,
    clock,
    writer: writer(db),
    fred: fred({ clock, key: KEY, fetch: f.fetch }),
  };
  return { clock, db, ctx, f };
}

// a recorded observations answer with these values put in by date
async function revised(
  id: string,
  values: Record<string, string>,
): Promise<Recorded> {
  const fx = clone(await fixture(`observations-${id.toLowerCase()}`));
  for (const o of fx.body.observations) {
    if (o.date in values) o.value = values[o.date];
  }
  return fx;
}

const errorOf = async (p: Promise<unknown>): Promise<unknown> =>
  p.then(
    () => {
      throw new Error("resolved");
    },
    (e: unknown) => e,
  );

describe("fred answers", () => {
  test("series metadata gives units, daily frequency and terms", async () => {
    const want = {
      DGS10: ["percent", false],
      BAMLH0A0HYM2: ["percent", true],
      VIXCLS: ["index_points", false],
      DCOILWTICO: ["unknown", false],
    } as const;
    for (const id of SERIES) {
      const meta = parseSeries(
        (await fixture(`series-${id.toLowerCase()}`)).body,
      );
      expect(meta.id).toBe(id);
      expect(meta.frequencyShort).toBe("D");
      expect(unitOf(meta)).toBe(want[id as keyof typeof want][0]);
      expect(meta.restricted).toBe(want[id as keyof typeof want][1]);
    }
    const dgs10 = parseSeries((await fixture("series-dgs10")).body);
    // 15:16:51 Central daylight time
    expect(dgs10.lastUpdated).toBe(Date.UTC(2026, 9, 23, 20, 16, 51));
    expect(dgs10.unitsShort).toBe("%");
  });

  test("observations parse into closes by date, a dot is no day", async () => {
    const dgs10 = parseObservations(
      (await fixture("observations-dgs10")).body,
      1,
    );
    expect(dgs10.dates).toHaveLength(30);
    expect(dgs10.dates).toContain("2026-10-12");
    expect(dgs10.observations).toHaveLength(29);
    expect(dgs10.observations.map((o) => o.date)).not.toContain("2026-10-12");
    expect(dgs10.observations[0]).toEqual({ date: "2026-09-11", value: 4.96 });
    expect(dgs10.observations.at(-1)).toEqual({
      date: "2026-10-22",
      value: 4.96,
    });
    for (const [id, last, value] of [
      ["vixcls", "2026-10-22", 19.03],
      ["dcoilwtico", "2026-10-20", 107.89],
      ["bamlh0a0hym2", "2026-10-22", 3],
    ] as const) {
      const a = parseObservations(
        (await fixture(`observations-${id}`)).body,
        1,
      );
      expect(a.observations).toHaveLength(30);
      expect(a.observations.at(-1)).toEqual({ date: last, value });
    }
  });

  test("the high-yield fixture holds no real observations", async () => {
    const fx: any = await fixture("observations-bamlh0a0hym2");
    expect(fx.note).toContain("made-up");
    const made = fx.body.observations.map(
      (_: unknown, n: number) => `${(3 + (n % 7) / 10).toFixed(2)}`,
    );
    expect(fx.body.observations.map((o: any) => o.value)).toEqual(made);
  });

  test("the client asks with the key and the latest 30", async () => {
    const { ctx, f } = setup();
    await ctx.fred!.observations("DGS10", { limit: 30 });
    await ctx.fred!.observations("DGS10", { start: "2016-10-24" });
    await ctx.fred!.series("VIXCLS");
    const [latest, since, meta] = f.urls;
    expect(latest!.searchParams.get("sort_order")).toBe("desc");
    expect(latest!.searchParams.get("limit")).toBe("30");
    expect(latest!.searchParams.get("file_type")).toBe("json");
    expect(latest!.searchParams.get("api_key")).toBe(KEY);
    expect(since!.searchParams.get("observation_start")).toBe("2016-10-24");
    expect(since!.searchParams.has("limit")).toBe(false);
    expect(meta!.pathname).toBe("/fred/series");
  });

  test("a bad series and a bad key are distinct fixed errors", async () => {
    const { ctx } = setup(async (url) =>
      url.searchParams.get("series_id") === "DGS10"
        ? fixture("observations-bad-key")
        : fixture("observations-unknown"),
    );
    const unknown = await errorOf(ctx.fred!.series("NOSUCHSERIES"));
    expect(unknown).toBeInstanceOf(SourceError);
    expect((unknown as SourceError).phrase).toBe("not found");
    const bad = await errorOf(ctx.fred!.observations("DGS10", { limit: 30 }));
    expect(bad).toBeInstanceOf(SourceError);
    expect((bad as SourceError).phrase).toBe("key refused");
    expect((bad as Error).message).toBe("key refused");
  });

  test("a fetch error quoting the URL leaves the key out", async () => {
    const { ctx } = setup((url) => {
      throw new Error(`connect failed: ${url}`);
    });
    const error = await errorOf(ctx.fred!.series("DGS10"));
    expect((error as SourceError).phrase).toBe("network error");
    expect(String(error)).not.toContain(KEY);
  });

  test("calls stay under 60 a minute", async () => {
    // read once, so no file read races the settling below
    const fx = await fixture("observations-vixcls");
    const { clock, ctx, f } = setup(() => fx);
    const calls = Array.from({ length: 61 }, () =>
      ctx.fred!.observations("VIXCLS", { limit: 30 }),
    );
    // lets the queued calls settle one by one without moving the clock
    for (let i = 0; i < 1000 && f.urls.length < 60; i++) await clock.advance(0);
    expect(f.urls).toHaveLength(60);
    await clock.advance(MINUTE_MS - 1);
    expect(f.urls).toHaveLength(60);
    await clock.advance(1);
    await Promise.all(calls);
    expect(f.urls).toHaveLength(61);
  });
});

describe("fred series", () => {
  test("a new series backfills ten years of final close-only bars", async () => {
    const { ctx, db, f } = setup();
    const added = await addSeries(ctx, "FRED:DGS10");
    expect(added.kind).toBe("added");
    const start = f.urls.find(isObservations)!;
    expect(start.searchParams.get("observation_start")).toBe("2016-10-24");
    expect(backfillStart(ctx.clock.now())).toBe("2016-10-24");

    const instrument = readInstrument(db, "FRED:DGS10")!;
    expect(instrument).toMatchObject({
      market: "FRED",
      symbol: "DGS10",
      source: SOURCE,
      sourceSymbol: "DGS10",
      currency: null,
      unit: "percent",
      zone: "UTC",
    });
    const bars = readBars(db, "FRED:DGS10", "1d");
    expect(bars).toHaveLength(29);
    expect(bars.map((b) => b.date)).not.toContain("2026-10-12");
    expect(bars.at(-1)).toEqual({
      date: "2026-10-22",
      open: null,
      high: null,
      low: null,
      close: 4.96,
      volume: null,
      final: true,
    });
    expect(bars.every((b) => b.final)).toBe(true);
    // weeks are built from the days; the one holding the last ended Sunday
    const weeks = readBars(db, "FRED:DGS10", "1wk");
    expect(weeks.at(-1)).toMatchObject({
      date: "2026-10-19",
      close: 4.96,
      final: true,
    });
    const quotes = db
      .query<{ n: number }, []>("select count(*) as n from quotes")
      .get()!.n;
    expect(quotes).toBe(0);

    // stored with bars, a second add asks nothing
    const calls = f.urls.length;
    expect((await addSeries(ctx, "dgs10")).kind).toBe("known");
    expect(f.urls).toHaveLength(calls);
  });

  test("units come from the series", async () => {
    const { ctx, db } = setup();
    for (const id of ["VIXCLS", "DCOILWTICO", "BAMLH0A0HYM2"]) {
      await addSeries(ctx, id);
    }
    expect(readInstrument(db, "FRED:VIXCLS")!.unit).toBe("index_points");
    expect(readInstrument(db, "FRED:DCOILWTICO")!.unit).toBe("unknown");
    // restricted terms still store it for the server's own callers
    expect(readInstrument(db, "FRED:BAMLH0A0HYM2")!.unit).toBe("percent");
    expect(readBars(ctx.db, "FRED:BAMLH0A0HYM2", "1d")).toHaveLength(30);
  });

  test("a series that is not daily is refused and nothing stored", async () => {
    const { ctx, db, f } = setup(async (url) => {
      if (isSeries(url)) {
        const fx = clone(await fixture("series-dgs10"));
        fx.body.seriess[0].frequency_short = "W";
        return fx;
      }
      return answer(url);
    });
    const error = await errorOf(addSeries(ctx, "DGS10"));
    expect(error).toBeInstanceOf(Refused);
    expect((error as Error).message).toBe(DAILY_ONLY);
    expect(f.urls.filter(isObservations)).toHaveLength(0);
    expect(readInstrument(db, "FRED:DGS10")).toBeNull();
  });

  test("an unknown series stores nothing", async () => {
    const { ctx, db } = setup();
    const error = await errorOf(addSeries(ctx, "NOSUCHSERIES"));
    expect((error as SourceError).phrase).toBe("not found");
    expect(readInstrument(db, "FRED:NOSUCHSERIES")).toBeNull();
  });

  test("a revised value replaces the stored one and says from when", async () => {
    let values: Record<string, string> = {};
    const { ctx, db } = setup((url) =>
      isObservations(url) ? revised("DGS10", values) : answer(url),
    );
    await addSeries(ctx, "DGS10");
    const instrument = readInstrument(db, "FRED:DGS10")!;

    const same = await refetchSeries(ctx, instrument);
    expect(same).toEqual({ rows: 29, changedFrom: null });

    values = { "2026-10-20": "5.02", "2026-10-21": "5.13" };
    const changed = await refetchSeries(ctx, instrument);
    expect(changed.changedFrom).toBe("2026-10-20");
    const bars = readBars(db, "FRED:DGS10", "1d", "2026-10-20");
    expect(bars.map((b) => [b.date, b.close, b.final])).toEqual([
      ["2026-10-20", 5.02, true],
      ["2026-10-21", 5.13, true],
      ["2026-10-22", 4.96, true],
    ]);

    // a value withdrawn to "." is no day any more
    values = { "2026-10-16": "." };
    const gone = await refetchSeries(ctx, instrument);
    expect(gone.changedFrom).toBe("2026-10-16");
    expect(readBars(db, "FRED:DGS10", "1d").map((b) => b.date)).not.toContain(
      "2026-10-16",
    );
  });

  test("after a gap longer than 30 observations it asks from the last day", async () => {
    let backfilled = false;
    const { ctx, db, f } = setup(async (url) => {
      const fx = await answer(url);
      if (!isObservations(url)) return fx;
      const out = clone(fx);
      // newest first: the backfill held the oldest five days, and the
      // latest answer reaches back only ten
      if (!backfilled) out.body.observations = out.body.observations.slice(-5);
      else if (url.searchParams.has("limit")) {
        out.body.observations = out.body.observations.slice(0, 10);
      }
      // each reply whole for what it holds
      out.body.count = out.body.observations.length;
      return out;
    });
    await addSeries(ctx, "VIXCLS");
    expect(readBars(db, "FRED:VIXCLS", "1d")).toHaveLength(5);
    backfilled = true;
    const before = f.urls.length;
    await refetchSeries(ctx, readInstrument(db, "FRED:VIXCLS")!);
    const asked = f.urls.slice(before);
    expect(asked).toHaveLength(2);
    expect(asked[0]!.searchParams.get("limit")).toBe("30");
    expect(asked[1]!.searchParams.get("observation_start")).toBe("2026-09-17");
    expect(readBars(db, "FRED:VIXCLS", "1d")).toHaveLength(30);
  });

  test("source off answers no data from FRED", async () => {
    const { ctx, f } = setup();
    const off = await addSeries({ ...ctx, fred: null }, "DGS10");
    expect(off).toEqual({ kind: "off", message: NO_DATA });
    expect(NO_DATA).toBe("no data from FRED");
    expect(f.urls).toHaveLength(0);
  });

  test("the attribution is FRED's sentence", () => {
    expect(ATTRIBUTION).toBe(
      "This product uses the FRED® API but is not endorsed or certified by the Federal Reserve Bank of St. Louis",
    );
  });
});

describe("fred job", () => {
  test("runs at 23:00 UTC each day with a run per series", async () => {
    const { clock, ctx, db, f } = setup();
    await addSeries(ctx, "DGS10");
    await addSeries(ctx, "VIXCLS");
    const sync = fredJobs({ ctx, log: silent });
    // a tick each minute up to until, as the scheduler runs them
    const passes: number[] = [];
    const runTo = async (until: number) => {
      while (clock.now() + MINUTE_MS <= until) {
        await clock.advance(MINUTE_MS);
        if ((await sync.tick()) !== null) passes.push(clock.now());
      }
    };
    const latest = () =>
      f.urls.filter((u) => u.searchParams.get("limit") === "30").length;

    // added after yesterday's 23:00, so nothing is due until tonight
    await runTo(Date.UTC(2026, 9, 28, 0, 0));
    expect(passes).toEqual([
      Date.UTC(2026, 9, 26, 23, 0),
      Date.UTC(2026, 9, 27, 23, 0),
    ]);
    expect(latest()).toBe(4);
    for (const [scope, rows] of [
      ["FRED:DGS10", 29],
      ["FRED:VIXCLS", 30],
    ] as const) {
      const run = lastRun(db, SOURCE, "bars", scope)!;
      expect(run).toMatchObject({ status: "ok", scope, rows });
      expect(run.startedAt).toBe(Date.UTC(2026, 9, 27, 23, 0));
    }
    expect(lastRun(db, SOURCE, "bars", null)).toBeNull();
  });

  test("a pass missed while down runs on the first tick", async () => {
    const { clock, ctx, db } = setup();
    await addSeries(ctx, "DGS10");
    const sync = fredJobs({ ctx, log: silent });
    // down from Monday morning to Tuesday morning, past 23:00
    await clock.advance(Date.UTC(2026, 9, 27, 7, 0) - clock.now());
    expect(dueAt(clock.now())).toBe(Date.UTC(2026, 9, 26, 23, 0));
    expect((await sync.tick())?.failed).toEqual([]);
    expect(lastRun(db, SOURCE, "bars", "FRED:DGS10")?.startedAt).toBe(
      Date.UTC(2026, 9, 27, 7, 0),
    );
    expect(await sync.tick()).toBeNull();
  });

  test("a series that fails every night is stale alone", async () => {
    let dead = false;
    const { clock, ctx, db, f } = setup((url) =>
      dead && url.searchParams.get("series_id") === "VIXCLS"
        ? fixture("observations-unknown")
        : answer(url),
    );
    const sync = fredJobs({ ctx, log: silent });
    const before = { id: "FRED:DGS10", source: SOURCE, addedAt: 0 };
    expect(seriesStale(db, before, clock.now())).toEqual([STALE.noHistory]);
    await addSeries(ctx, "DGS10");
    await addSeries(ctx, "VIXCLS");
    const dgs10 = readInstrument(db, "FRED:DGS10")!;
    const vix = readInstrument(db, "FRED:VIXCLS")!;
    expect(seriesStale(db, dgs10, clock.now())).toEqual([]);

    await clock.advance(Date.UTC(2026, 9, 26, 23, 0) - clock.now());
    expect(seriesStale(db, dgs10, clock.now())).toEqual([STALE.barsPending]);
    dead = true;
    expect((await sync.tick())?.failed).toEqual([
      { instrument: "FRED:VIXCLS", error: "not found" },
    ]);
    expect(seriesStale(db, dgs10, clock.now())).toEqual([]);
    expect(seriesStale(db, vix, clock.now())).toEqual([
      STALE.barsFailed,
      STALE.barsPending,
    ]);

    // the failed series waits before it is asked again; the other is done
    const asked = () => f.urls.length;
    const calls = asked();
    expect(await sync.tick()).toBeNull();
    await clock.advance(60 * MINUTE_MS);
    const retry = await sync.tick();
    expect(retry?.failed.map((x) => x.instrument)).toEqual(["FRED:VIXCLS"]);
    expect(asked()).toBe(calls + 1);

    // the next night it fails again, and only it is stale
    await clock.advance(Date.UTC(2026, 9, 27, 23, 0) - clock.now());
    const night = await sync.tick();
    expect(night?.failed.map((x) => x.instrument)).toEqual(["FRED:VIXCLS"]);
    expect(seriesStale(db, dgs10, clock.now())).toEqual([]);
    expect(seriesStale(db, vix, clock.now())).toEqual([
      STALE.barsFailed,
      STALE.barsPending,
    ]);

    // once it answers again it is fresh
    dead = false;
    await clock.advance(60 * MINUTE_MS);
    expect((await sync.tick())?.failed).toEqual([]);
    expect(seriesStale(db, vix, clock.now())).toEqual([]);
  });
});

describe("fred source", () => {
  test("off without a key file, and the start log says so", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fred-off-"));
    const store = keys(dir);
    expect(store.source("fred")).toBeNull();
    const clock = fakeClock();
    const { db } = open(":memory:", clock);
    const app = start({
      hostname: "127.0.0.1",
      port: 0,
      bearer: "b".repeat(32),
      clock,
      log: () => silent,
      version: "v0.0.0-test",
      db,
      quoteEveryMs: 5 * MINUTE_MS,
      fredKey: store.source("fred"),
      fetch: async (url) => {
        throw new Error(`no network in tests: ${url}`);
      },
    });
    try {
      expect(app.fred).toBeNull();
      expect(app.fredJobs).toBeNull();
      expect(format(0, "markets", "info", "sources", app.sources)).toContain(
        'fred="off (no key)"',
      );
    } finally {
      await app.stop();
      db.close();
    }
  });

  test("on with a key file; the key never reaches a log line or a row", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fred-on-"));
    writeFileSync(join(dir, "source-fred.key"), `${KEY}\n`);
    const store = keys(dir);
    const clock = fakeClock();
    const lines: string[] = [];
    const { db } = open(":memory:", clock);
    let failing = false;
    const app = start({
      hostname: "127.0.0.1",
      port: 0,
      bearer: "b".repeat(32),
      clock,
      log: logger(clock, store.values, (line) => lines.push(line)),
      version: "v0.0.0-test",
      db,
      quoteEveryMs: 5 * MINUTE_MS,
      fredKey: store.source("fred"),
      fetch: async (raw) => {
        const url = new URL(raw);
        if (url.hostname !== "api.stlouisfed.org") {
          throw new Error(`no network in tests: ${raw}`);
        }
        if (failing) throw new Error(`fetch failed for ${raw}`);
        const fx = await answer(url);
        return new Response(JSON.stringify(fx.body), { status: fx.status });
      },
    });
    try {
      expect(app.fred).not.toBeNull();
      expect(format(0, "markets", "info", "sources", app.sources)).toContain(
        'fred="on (key file)"',
      );
      const ctx = { db, clock, writer: app.writer, fred: app.fred };
      await addSeries(ctx, "DGS10");
      failing = true;
      const pass = await app.fredJobs!.pass();
      expect(pass.failed).toEqual([
        { instrument: "FRED:DGS10", error: "network error" },
      ]);
      expect(lastRun(db, SOURCE, "bars", "FRED:DGS10")?.error).toBe(
        "network error",
      );
      // a line that quotes a URL with the key is masked too
      logger(clock, store.values, (line) => lines.push(line))("fred").warn(
        `asked https://api.stlouisfed.org/fred/series?api_key=${KEY}`,
      );
      expect(lines.length).toBeGreaterThan(1);
      for (const line of lines) expect(line).not.toContain(KEY);
      for (const table of ["sync_runs", "instruments", "bars"]) {
        const rows = JSON.stringify(db.query(`select * from ${table}`).all());
        expect(rows).not.toContain(KEY);
      }
    } finally {
      await app.stop();
      db.close();
    }
  });
});

describe("fred answers are checked", () => {
  const observations = async (edit: (body: any) => void) => {
    const fx = clone(await fixture("observations-dgs10"));
    edit(fx.body);
    return fx.body;
  };
  const phraseOf = (fn: () => unknown) => {
    try {
      fn();
    } catch (e) {
      return (e as SourceError).phrase;
    }
    return null;
  };

  test("the key is cut from every text an answer echoes", async () => {
    // a made-up key that percent-encoding changes
    const key = "k3y+with/slash=end";
    const encoded = encodeURIComponent(key).toLowerCase();
    const clock = fakeClock();
    const f = fakeFetch(async () => {
      const fx = clone(await fixture("series-dgs10"));
      const s = fx.body.seriess[0];
      s.title = `Yield ${key}`;
      s.notes = `see https://x?api_key=${encoded} and ${key}`;
      s.units = `Percent ${key}`;
      return fx;
    });
    const meta = await fred({ clock, key, fetch: f.fetch }).series("DGS10");
    const text = JSON.stringify(meta);
    expect(text).not.toContain(key);
    expect(text.toLowerCase()).not.toContain(encoded);
    expect(meta.title).toBe("Yield REDACTED");
    expect(meta.notes).toBe("see https://x?api_key=REDACTED and REDACTED");
  });

  test("another series answering is a fixed error naming neither", async () => {
    const { ctx, db } = setup(async (url) => {
      if (!isSeries(url)) return answer(url);
      const fx = clone(await fixture("series-dgs10"));
      fx.body.seriess[0].id = "VIXCLS";
      return fx;
    });
    const error = (await errorOf(addSeries(ctx, "DGS10"))) as SourceError;
    expect(error.phrase).toBe("malformed answer");
    expect(error.message).not.toContain("DGS10");
    expect(error.message).not.toContain("VIXCLS");
    expect(readInstrument(db, "FRED:DGS10")).toBeNull();
  });

  test("a reply with fewer rows than its count writes nothing", async () => {
    let cut = false;
    const { ctx, db } = setup(async (url) => {
      const fx = await answer(url);
      if (!cut || !isObservations(url)) return fx;
      const out = clone(fx);
      out.body.observations = out.body.observations.slice(0, 10);
      return out;
    });
    await addSeries(ctx, "DGS10");
    const stored = readBars(db, "FRED:DGS10", "1d");
    cut = true;
    const pass = await fredJobs({ ctx, log: silent }).pass();
    expect(pass.failed).toEqual([
      { instrument: "FRED:DGS10", error: "malformed answer" },
    ]);
    expect(readBars(db, "FRED:DGS10", "1d")).toEqual(stored);
    expect(lastRun(db, SOURCE, "bars", "FRED:DGS10")?.status).toBe("failed");
    // the last page of a series is short and whole
    const tail = await observations((b) => {
      b.count = 35;
      b.offset = 30;
      b.observations = b.observations.slice(0, 5);
    });
    expect(parseObservations(tail, 1).dates).toHaveLength(5);
    const short = await observations((b) => {
      b.observations = b.observations.slice(0, 29);
    });
    expect(phraseOf(() => parseObservations(short, 1))).toBe(
      "malformed answer",
    );
  });

  test("a date answered twice is malformed, a dot included", async () => {
    for (const value of ["5.00", "."]) {
      const body = await observations((b) => {
        b.observations.push({ ...b.observations[0], value });
        b.count += 1;
        b.limit += 1;
      });
      expect(phraseOf(() => parseObservations(body, 1))).toBe(
        "malformed answer",
      );
    }
  });

  test("only plain decimals are values", async () => {
    for (const value of ["0x10", "1e3", "", " 5", "+5", "Infinity", "5."]) {
      const body = await observations((b) => {
        b.observations[0].value = value;
      });
      expect(phraseOf(() => parseObservations(body, 1))).toBe(
        "malformed answer",
      );
    }
    const ok = await observations((b) => {
      b.observations[0].value = "-0.25";
    });
    expect(parseObservations(ok, 1).observations.at(-1)?.value).toBe(-0.25);
  });

  test("the id asked for is the key, whatever case FRED answers", async () => {
    const { ctx, db } = setup(async (url) => {
      if (!isSeries(url)) return answer(url);
      const fx = clone(await fixture("series-dgs10"));
      fx.body.seriess[0].id = "dgs10";
      return fx;
    });
    await addSeries(ctx, "FRED:dgs10");
    expect(readInstrument(db, "FRED:DGS10")).toMatchObject({
      symbol: "DGS10",
      sourceSymbol: "DGS10",
    });
  });

  test("ten years before 29 February backfills from 28 February", () => {
    // 2018-02-28 is a Wednesday
    expect(backfillStart(Date.UTC(2028, 1, 29, 12))).toBe("2018-02-26");
  });

  test("closing the source cancels a call waiting for its slot", async () => {
    const fx = await fixture("observations-vixcls");
    const { clock, ctx, f } = setup(() => fx);
    const calls = Array.from({ length: 61 }, () =>
      ctx.fred!.observations("VIXCLS", { limit: 30 }).then(
        () => null,
        (e: unknown) => e,
      ),
    );
    for (let i = 0; i < 1000 && f.urls.length < 60; i++) await clock.advance(0);
    expect(f.urls).toHaveLength(60);
    ctx.fred!.close();
    await clock.advance(2 * MINUTE_MS);
    const results = await Promise.all(calls);
    expect(f.urls).toHaveLength(60);
    expect(results.at(-1)).toBeInstanceOf(QueueClosed);
  });
});
