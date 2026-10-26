// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { readBars } from "../src/bars.ts";
import { bvb, MARKET } from "../src/bvb/client.ts";
import { bvbJobs } from "../src/bvb/jobs.ts";
import {
  type BvbContext,
  fetchInstrument,
  refetch,
  sessionOf,
} from "../src/bvb/sync.ts";
import { readSession, recordSession } from "../src/calendars.ts";
import { MINUTE_MS } from "../src/clock.ts";
import { open } from "../src/db/index.ts";
import type { Instrument } from "../src/instruments.ts";
import { silent } from "../src/log.ts";
import { readQuote } from "../src/quotes.ts";
import type { RuleHooks } from "../src/rules/hooks.ts";
import { lastRun } from "../src/runs.ts";
import { JOBS, quoteStale, STALE } from "../src/stale.ts";
import { markRead } from "../src/tracking.ts";
import { writer } from "../src/writer.ts";
import {
  type BvbRoutes,
  bvbFetch,
  bvbRecorded,
  site,
  wapi,
} from "./helpers/bvb.ts";
import { fakeClock } from "./helpers/clock.ts";
import { drive } from "./helpers/drive.ts";
import { clone, type Recorded } from "./helpers/yahoo.ts";

const EVERY = 5 * MINUTE_MS;
const utc = (iso: string) => Date.parse(`${iso}Z`);
// the recorded session: Friday 23 October, 10:00 to 18:00 in Bucharest
// (summer time), as its schedule page gives it
const FRIDAY = {
  start: utc("2026-10-23T07:00:00"),
  end: utc("2026-10-23T15:00:00"),
};

async function setup(start: number, routes: BvbRoutes = {}, rules?: RuleHooks) {
  const clock = fakeClock(start);
  const { db } = open(":memory:", clock);
  const f = await bvbFetch(routes);
  const ctx: BvbContext = {
    db,
    clock,
    bvb: bvb({ clock, fetch: f.fetch }),
    writer: writer(db),
    rules,
  };
  const jobs = bvbJobs({ ctx, quoteEveryMs: EVERY, log: silent });
  const run = <T>(p: Promise<T>) => drive(clock, ctx.bvb, p);
  // fetched inside a read, then read, so the jobs track it
  const add = async (symbol: string): Promise<Instrument> => {
    const i = await run(fetchInstrument(ctx, symbol, null, () => true));
    await ctx.writer.write((db) => markRead(db, [i.id], clock.now()));
    return i;
  };
  return { clock, db, ctx, f, jobs, run, add };
}

const friday = (db: Parameters<typeof recordSession>[0], at: number) =>
  recordSession(db, MARKET, { zone: "Europe/Bucharest", ...FRIDAY }, at);

// a recorded history keeping the bars whose trading date passes keep
function cut(fx: Recorded, keep: (date: string) => boolean): Recorded {
  const out = clone(fx);
  const kept = out.body.t.map((t: number) =>
    keep(new Date(t * 1000).toISOString().slice(0, 10)),
  );
  for (const k of ["t", "o", "h", "l", "c", "v"]) {
    out.body[k] = out.body[k].filter((_: unknown, i: number) => kept[i]);
  }
  return out;
}

const splitsOf = (db: Parameters<typeof recordSession>[0]) =>
  db
    .query<{ date: string; numerator: number }, []>(
      "select date, numerator from splits where instrument = 'BVB:TLV' order by date",
    )
    .all();

describe("instruments from the feed", () => {
  test("a share, a bond and an index are fetched with history and a quote", async () => {
    const t = await setup(utc("2026-10-23T14:00:00"));
    friday(t.db, t.clock.now());
    const tlv = await t.add("TLV");
    expect(tlv).toMatchObject({
      id: "BVB:TLV",
      source: "bvb",
      sourceSymbol: "TLV",
      type: "EQUITY",
      unit: "per_share",
      currency: "RON",
      zone: "Europe/Bucharest",
    });
    // the instrument page's reference price is the previous close
    expect(readQuote(t.db, "BVB:TLV")).toMatchObject({
      price: 36.18,
      previousClose: 36.4,
      previousCloseField: "reference",
      dayHigh: 36.4,
      dayLow: 35.94,
      time: utc("2026-10-23T14:59:45"),
      source: "bvb",
    });
    expect(readBars(t.db, "BVB:TLV", "1d").length).toBe(30);

    const bond = await t.add("R2807A");
    expect(bond).toMatchObject({ type: "BOND", unit: "percent_of_par" });
    expect(readQuote(t.db, "BVB:R2807A")!.price).toBe(98.9999);

    const bet = await t.add("BET");
    expect(bet).toMatchObject({
      type: "INDEX",
      unit: "index_points",
      currency: null,
    });
    // no trade time on the index page: stored unknown, never the fetch time
    const q = readQuote(t.db, "BVB:BET")!;
    expect(q.time).toBeNull();
    expect(q.previousClose).toBeCloseTo(35018.02, 6);
    expect(q.previousCloseField).toBe("change");
    const [h] = wapi(t.f.urls, "/api/history").filter(
      (u) => u.searchParams.get("symbol") === "BET",
    );
    expect(h!.searchParams.get("currencyCode")).toBe("-");
    expect(
      readBars(t.db, "BVB:BET", "1d").every((b) => b.volume === null),
    ).toBe(true);
  });

  test("an unknown symbol is not found and nothing is stored", async () => {
    const t = await setup(utc("2026-10-23T14:00:00"));
    await expect(
      t.run(fetchInstrument(t.ctx, "ZZZZ", null, () => true)),
    ).rejects.toThrow("not found");
    expect(t.db.query("select count(*) as n from instruments").get()).toEqual({
      n: 0,
    });
  });
});

describe("the session", () => {
  test("the schedule gives a session ending at 18:00 in the exchange's zone", async () => {
    const s = sessionOf(
      "Europe/Bucharest",
      {
        status: "open",
        start: 10 * 60 * MINUTE_MS,
        end: 18 * 60 * MINUTE_MS,
        fetchedAt: 0,
      },
      utc("2026-10-26T07:00:00"),
    );
    // winter time from 25 October: 10:00 and 18:00 are 08:00 and 16:00 UTC
    expect(s).toEqual({
      zone: "Europe/Bucharest",
      start: utc("2026-10-26T08:00:00"),
      end: utc("2026-10-26T16:00:00"),
    });
  });

  test("an open status records the day's session and quoting starts", async () => {
    const t = await setup(utc("2026-10-23T14:00:00"), { open: true });
    friday(t.db, t.clock.now());
    await t.add("TLV");
    // Monday 09:00 in Bucharest, before the open: Friday's missed close
    // pass first, then the day's check
    await t.clock.advance(utc("2026-10-26T07:00:00") - t.clock.now());
    expect(await t.run(t.jobs.quoteTick())).toEqual({
      quoted: true,
      checked: false,
    });
    expect(await t.run(t.jobs.quoteTick())).toEqual({
      quoted: false,
      checked: true,
    });
    expect(readSession(t.db, MARKET)).toMatchObject({
      start: utc("2026-10-26T08:00:00"),
      end: utc("2026-10-26T16:00:00"),
    });
    await t.run(t.clock.advance(utc("2026-10-26T08:00:00") - t.clock.now()));
    const opened = await t.run(t.jobs.quoteTick());
    expect(opened.quoted).toBe(true);
  });

  test("a closed status takes no quotes and checks again at the local start", async () => {
    const t = await setup(utc("2026-10-23T14:00:00"));
    friday(t.db, t.clock.now());
    await t.add("TLV");
    const quoteRuns = () =>
      t.db
        .query("select count(*) as n from sync_runs where job = 'quotes'")
        .get();
    // Monday 09:00 in Bucharest, the page still closed: Friday's missed
    // close pass, then its daily check, which is overdue
    await t.clock.advance(utc("2026-10-26T07:00:00") - t.clock.now());
    expect((await t.run(t.jobs.quoteTick())).quoted).toBe(true);
    const before = readQuote(t.db, "BVB:TLV");
    expect(await t.run(t.jobs.quoteTick())).toEqual({
      quoted: false,
      checked: true,
    });
    expect(readSession(t.db, MARKET)!.start).toBe(FRIDAY.start);
    // the next check is at the local start, then hourly, not each period
    await t.clock.advance(5 * MINUTE_MS);
    expect((await t.run(t.jobs.quoteTick())).checked).toBe(false);
    await t.clock.advance(utc("2026-10-26T08:00:00") - t.clock.now());
    expect((await t.run(t.jobs.quoteTick())).checked).toBe(true);
    await t.clock.advance(30 * MINUTE_MS);
    expect((await t.run(t.jobs.quoteTick())).checked).toBe(false);
    await t.clock.advance(30 * MINUTE_MS);
    expect((await t.run(t.jobs.quoteTick())).checked).toBe(true);
    expect(
      site(t.f.urls, "/TradingAndStatistics/TradingSessionSchedule").length,
    ).toBe(3);
    expect(quoteRuns()).toEqual({ n: 1 });
    expect(readQuote(t.db, "BVB:TLV")).toEqual(before);
  });

  test("a market with no session yet is checked at once, then at its local start", async () => {
    const t = await setup(utc("2026-10-25T20:00:00"));
    // added on Sunday evening with no session stored
    await t.add("TLV");
    expect(readSession(t.db, MARKET)).toBeNull();
    expect((await t.run(t.jobs.quoteTick())).checked).toBe(true);
    await t.clock.advance(60 * MINUTE_MS);
    expect((await t.run(t.jobs.quoteTick())).checked).toBe(false);
    // Monday 10:00 in Bucharest
    await t.clock.advance(utc("2026-10-26T08:00:00") - t.clock.now());
    expect((await t.run(t.jobs.quoteTick())).checked).toBe(true);
  });
});

describe("quotes from the list pages", () => {
  test("a pass reads each page once and an instrument page once a day", async () => {
    const t = await setup(utc("2026-10-23T14:00:00"));
    friday(t.db, t.clock.now());
    await t.add("TLV");
    await t.add("R2807A");
    await t.add("BET");
    const before = t.f.urls.length;
    expect((await t.run(t.jobs.quoteTick())).quoted).toBe(true);
    const pass = t.f.urls.slice(before).map((u) => u.pathname);
    expect(pass).toEqual([
      "/FinancialInstruments/Markets/Shares",
      "/FinancialInstruments/Markets/Bonds",
      "/TradingAndStatistics/Trading/MarketsToday",
    ]);
    expect(lastRun(t.db, "bvb", JOBS.quotes, MARKET)!.status).toBe("ok");
    // bonds stay in percent of par, as quoted
    expect(readQuote(t.db, "BVB:R2807A")!.price).toBe(98.9999);
    expect(
      quoteStale(t.db, {
        id: "BVB:TLV",
        source: "bvb",
        market: MARKET,
        addedAt: 0,
      }),
    ).toEqual([]);
  });

  test("a later trading day's price takes its previous close from the instrument page", async () => {
    const t = await setup(utc("2026-10-23T14:00:00"));
    friday(t.db, t.clock.now());
    await t.add("TLV");
    // the stored quote is Thursday's: the list's Friday row needs Friday's reference
    t.db
      .query(
        "update quotes set time = ?, previous_close = 35.5, change = 0.68 where instrument = 'BVB:TLV'",
      )
      .run(utc("2026-10-22T14:00:00"));
    const details = () =>
      site(
        t.f.urls,
        "/FinancialInstruments/Details/FinancialInstrumentsDetails.aspx",
      ).length;
    const before = details();
    await t.run(t.jobs.quoteTick());
    expect(details()).toBe(before + 1);
    expect(readQuote(t.db, "BVB:TLV")!.previousClose).toBe(36.4);
    // the same day again keeps it, with no instrument page
    await t.clock.advance(EVERY);
    await t.run(t.jobs.quoteTick());
    expect(details()).toBe(before + 1);
  });

  test("an index quote fetched after the close keeps its session's live row", async () => {
    const t = await setup(utc("2026-10-23T14:00:00"), { open: true });
    friday(t.db, t.clock.now());
    await t.add("BET");
    const live = () =>
      t.db
        .query<{ date: string; quoteTime: number }, []>(
          "select date, quote_time as quoteTime from signals where instrument = 'BVB:BET' and kind = 'live' and interval = '1d'",
        )
        .all();
    expect(live().map((r) => r.date)).toEqual(["2026-10-23"]);
    // the pass after the close, past the live rows' margin
    await t.clock.advance(utc("2026-10-23T15:15:30") - t.clock.now());
    expect((await t.run(t.jobs.quoteTick())).quoted).toBe(true);
    const q = readQuote(t.db, "BVB:BET")!;
    expect(q.fetchedAt).toBeGreaterThan(utc("2026-10-23T15:15:00"));
    // the quote keeps no time; its live row is dated at the session's end
    expect(q.time).toBeNull();
    expect(live()).toEqual([{ date: "2026-10-23", quoteTime: FRIDAY.end }]);
  });

  test("a page the client cannot read fails the run and marks the rows stale", async () => {
    const shares = await bvbRecorded("shares-list");
    const broken: Recorded = clone(shares);
    broken.body = (broken.body as string).replace('id="gv"', 'id="moved"');
    let fail = false;
    const t = await setup(utc("2026-10-23T14:00:00"), {
      hold: (url) =>
        fail && url.pathname.endsWith("/Shares") ? broken : undefined,
    });
    friday(t.db, t.clock.now());
    const tlv = await t.add("TLV");
    const stored = readQuote(t.db, tlv.id);
    fail = true;
    await t.run(t.jobs.quoteTick());
    expect(lastRun(t.db, "bvb", JOBS.quotes, MARKET)).toMatchObject({
      status: "failed",
      error: "malformed answer",
    });
    expect(quoteStale(t.db, tlv)).toContain(STALE.quotesFailed);
    // never empty rows: the stored quote stays as it was
    expect(readQuote(t.db, tlv.id)).toEqual(stored);
  });
});

describe("bars from the chart feed", () => {
  test("a new session refetches the last 30 days and finalises the day", async () => {
    const t = await setup(utc("2026-10-23T14:00:00"));
    friday(t.db, t.clock.now());
    await t.add("TLV");
    expect(readBars(t.db, "BVB:TLV", "1d").at(-1)).toMatchObject({
      date: "2026-10-23",
      final: false,
    });
    recordSession(
      t.db,
      MARKET,
      {
        zone: "Europe/Bucharest",
        start: utc("2026-10-26T08:00:00"),
        end: utc("2026-10-26T16:00:00"),
      },
      utc("2026-10-26T08:00:00"),
    );
    await t.clock.advance(utc("2026-10-26T08:01:00") - t.clock.now());
    const done = await t.run(t.jobs.barTick());
    expect(done).toEqual(["BVB:TLV"]);
    expect(readBars(t.db, "BVB:TLV", "1d").at(-1)).toMatchObject({
      date: "2026-10-23",
      final: true,
    });
    const asked = wapi(t.f.urls, "/api/history").at(-1)!;
    const from = Number(asked.searchParams.get("from")) * 1000;
    expect(t.clock.now() - from).toBeGreaterThanOrEqual(30 * 86_400_000);
    expect(lastRun(t.db, "bvb", JOBS.bars, MARKET)!.status).toBe("ok");
  });

  test("a final close that moved refetches the whole history as a rescale", async () => {
    const adjusted = await bvbRecorded("wapi-history-tlv-1d-bonus-2026");
    const raw = await bvbRecorded("wapi-history-tlv-1d-bonus-2026-unadjusted");
    let answer = raw;
    const paused: string[] = [];
    const rules: RuleHooks = {
      evaluate() {},
      rescaled: (_db, id) => {
        paused.push(id);
      },
    };
    // Monday 3 August, after TLV's bonus issue of 16 July
    const t = await setup(
      utc("2026-08-03T07:00:00"),
      { hold: (url) => (url.pathname === "/api/history" ? answer : undefined) },
      rules,
    );
    recordSession(
      t.db,
      MARKET,
      {
        zone: "Europe/Bucharest",
        start: utc("2026-08-03T07:00:00"),
        end: utc("2026-08-03T15:00:00"),
      },
      t.clock.now(),
    );
    const tlv = await t.add("TLV");
    const volumeRatios = () =>
      t.db
        .query<{ v: number | null }, []>(
          "select volume_ratio as v from signals where instrument = 'BVB:TLV' and interval = '1d' and kind = 'final' and date >= '2026-07-20'",
        )
        .all()
        .map((r) => r.v);
    expect(volumeRatios().every((v) => v !== null)).toBe(true);
    expect(readBars(t.db, "BVB:TLV", "1d")[0]!.close).toBe(37.18);
    answer = adjusted;
    const before = wapi(t.f.urls, "/api/history").length;
    await t.run(refetch(t.ctx, tlv));
    // the 30-day window, then the whole history
    expect(wapi(t.f.urls, "/api/history").length).toBe(before + 2);
    expect(paused).toEqual(["BVB:TLV", "BVB:TLV"]);
    const bars = readBars(t.db, "BVB:TLV", "1d");
    expect(bars[0]!.close).toBe(32.4933);
    // volumes stay as the feed gives them
    expect(bars[0]!.volume).toBe(606910);
    const split = t.db
      .query<{ date: string; numerator: number }, []>(
        "select date, numerator from splits where instrument = 'BVB:TLV'",
      )
      .get()!;
    expect(split.date).toBe("2026-07-16");
    expect(split.numerator).toBeCloseTo(1.14424, 4);
    // volume ratios spanning the issue are left out
    expect(volumeRatios().every((v) => v === null)).toBe(true);
    // the same answer again refetches only the window
    const again = wapi(t.f.urls, "/api/history").length;
    await t.run(refetch(t.ctx, tlv));
    expect(wapi(t.f.urls, "/api/history").length).toBe(again + 1);
  });

  test("a rescale seen before its first bar is dated on its session and pauses rules", async () => {
    // stored before the bonus issue of 16 July, adjusted on its morning
    const before = (fx: Recorded) => cut(fx, (d) => d < "2026-07-16");
    const adjusted = before(
      await bvbRecorded("wapi-history-tlv-1d-bonus-2026"),
    );
    let answer = before(
      await bvbRecorded("wapi-history-tlv-1d-bonus-2026-unadjusted"),
    );
    const paused: string[] = [];
    const rules: RuleHooks = {
      evaluate() {},
      rescaled: (_db, id) => {
        paused.push(id);
      },
    };
    const t = await setup(
      utc("2026-07-15T14:00:00"),
      { hold: (url) => (url.pathname === "/api/history" ? answer : undefined) },
      rules,
    );
    const day = (date: string) =>
      recordSession(
        t.db,
        MARKET,
        {
          zone: "Europe/Bucharest",
          start: utc(`${date}T07:00:00`),
          end: utc(`${date}T15:00:00`),
        },
        t.clock.now(),
      );
    day("2026-07-15");
    const tlv = await t.add("TLV");
    // the stored last day is not final yet
    expect(readBars(t.db, "BVB:TLV", "1d").at(-1)).toMatchObject({
      date: "2026-07-15",
      final: false,
    });
    await t.clock.advance(utc("2026-07-16T07:00:30") - t.clock.now());
    day("2026-07-16");
    answer = adjusted;
    await t.run(refetch(t.ctx, tlv));
    expect(paused).toContain("BVB:TLV");
    expect(splitsOf(t.db)).toEqual([
      { date: "2026-07-16", numerator: expect.closeTo(1.14424, 4) },
    ]);
  });

  test("unrelated corrections refetch the history without a rescale", async () => {
    let answer: Recorded = await bvbRecorded("wapi-history-tlv-1d");
    const paused: string[] = [];
    const rules: RuleHooks = {
      evaluate() {},
      rescaled: (_db, id) => {
        paused.push(id);
      },
    };
    const t = await setup(
      utc("2026-10-23T14:00:00"),
      { hold: (url) => (url.pathname === "/api/history" ? answer : undefined) },
      rules,
    );
    friday(t.db, t.clock.now());
    const tlv = await t.add("TLV");
    const corrected = clone(answer);
    // three final days in the window, each moved its own way
    corrected.body.c[12] *= 1.01;
    corrected.body.c[13] *= 0.98;
    corrected.body.c[14] *= 1.03;
    answer = corrected;
    const before = wapi(t.f.urls, "/api/history").length;
    await t.run(refetch(t.ctx, tlv));
    expect(wapi(t.f.urls, "/api/history").length).toBe(before + 2);
    expect(paused).toEqual([]);
    expect(splitsOf(t.db)).toEqual([]);
    expect(readBars(t.db, "BVB:TLV", "1d")[14]!.close).toBeCloseTo(
      corrected.body.c[14],
      6,
    );
  });

  test("a rescaled whole history short of the stored last day is refused", async () => {
    const adjusted = await bvbRecorded("wapi-history-tlv-1d-bonus-2026");
    let answer = await bvbRecorded("wapi-history-tlv-1d-bonus-2026-unadjusted");
    const t = await setup(utc("2026-08-03T07:00:00"), {
      hold: (url) => (url.pathname === "/api/history" ? answer : undefined),
    });
    recordSession(
      t.db,
      MARKET,
      {
        zone: "Europe/Bucharest",
        start: utc("2026-08-03T07:00:00"),
        end: utc("2026-08-03T15:00:00"),
      },
      t.clock.now(),
    );
    const tlv = await t.add("TLV");
    const stored = readBars(t.db, "BVB:TLV", "1d");
    // adjusted, and a week short of the stored 31 July
    answer = cut(adjusted, (d) => d < "2026-07-25");
    await expect(t.run(refetch(t.ctx, tlv))).rejects.toThrow(
      "malformed answer",
    );
    expect(readBars(t.db, "BVB:TLV", "1d")).toEqual(stored);
  });

  test("a whole history short of the stored one is refused", async () => {
    let answer: Recorded = await bvbRecorded("wapi-history-tlv-1d");
    const t = await setup(utc("2026-10-23T14:00:00"), {
      hold: (url) => (url.pathname === "/api/history" ? answer : undefined),
    });
    friday(t.db, t.clock.now());
    const tlv = await t.add("TLV");
    // a close moved and the answer stops weeks before the stored days
    const short = clone(answer);
    for (const k of ["t", "o", "h", "l", "c", "v"]) {
      short.body[k] = short.body[k].slice(0, 10);
    }
    // 24 September, inside the 30-day window
    short.body.c[8] += 1;
    answer = short;
    await expect(t.run(refetch(t.ctx, tlv))).rejects.toThrow(
      "malformed answer",
    );
    expect(readBars(t.db, "BVB:TLV", "1d").length).toBe(30);
  });
});
