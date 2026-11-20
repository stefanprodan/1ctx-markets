// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { recordSession, session } from "../src/market/calendars.ts";
import {
  readInstrument,
  upsertInstrument,
  writeIsin,
} from "../src/market/instruments.ts";
import { EXTENDED } from "../src/market/stale.ts";
import {
  CHART_WAIT_MS,
  lastTradegateClose,
  readExtended,
  tradegateExtended,
  tradegateSession,
} from "../src/operations/extended.ts";
import { CALL_MS, type Markets, markets } from "../src/operations/markets.ts";
import { parseQuote, quotePage } from "../src/operations/quote.ts";
import { silent } from "../src/runtime/log.ts";
import { SourceError, Unreadable } from "../src/sources/source.ts";
import {
  HELD_MS,
  parseRefresh,
  tradegate,
  tradegateNumber,
} from "../src/sources/tradegate/client.ts";
import { yahoo } from "../src/sources/yahoo/client.ts";
import { open } from "../src/storage/db/index.ts";
import { writer } from "../src/storage/writer.ts";
import { fakeClock } from "./helpers/clock.ts";
import { gate } from "./helpers/sources.ts";
import { quote } from "./helpers/world.ts";
import {
  chartSymbol,
  fakeFetch,
  type Recorded,
  recorded,
} from "./helpers/yahoo.ts";

const DIR = join(import.meta.dir, "fixtures", "tradegate");
const fixture = (name: string): Promise<Recorded> =>
  Bun.file(join(DIR, `${name}.json`)).json();

const VUAA = "IE00BFMXXD54";
// made up, its check digit right
const MADE_UP = "ZZXETRA00005";
const at = (time: string) => Date.parse(time);

describe("the Tradegate parser", () => {
  test("reads the recorded answer, a comma string among numbers", async () => {
    const fx = await fixture("refresh-ie00bfmxxd54");
    const now = at(fx.recordedAt);
    expect(parseRefresh(fx.body, now)).toEqual({
      last: 125.345,
      bid: 125.325,
      ask: 125.345,
      high: 126.585,
      low: 125.3,
      close: 126.66,
      volume: 60100,
      fetchedAt: now,
    });
  });

  test("reads numbers sent as text with a decimal point", async () => {
    const fx = await fixture("refresh-ie00bfmxxd54");
    const body = (fx.body as string)
      .replace('"last":125.345', '"last":"125.345"')
      .replace('"low":"125,30"', '"low":"125.30"');
    expect(parseRefresh(body, 1)).toMatchObject({ last: 125.345, low: 125.3 });
  });

  test("reads an indented answer without refresh", async () => {
    const fx = await fixture("refresh-ie00bfmxxd54-indented");
    expect(parseRefresh(fx.body, 1)).toMatchObject({
      last: 125.435,
      bid: 125.415,
      ask: 125.435,
      low: 124.91,
      volume: 71337,
    });
  });

  test("reads every number written with a decimal comma", async () => {
    const fx = await fixture("refresh-ie00bfmxxd54");
    const body = (fx.body as string)
      .replace('"ask":125.345', '"ask":"125,345"')
      .replace('"last":125.345', '"last":"125,345"')
      .replace('"close":126.66', '"close":"126,66"')
      .replace('"stueck":60100', '"stueck":"60100"');
    expect(parseRefresh(body, 1)).toMatchObject({
      last: 125.345,
      ask: 125.345,
      low: 125.3,
      close: 126.66,
      volume: 60100,
    });
  });

  test.each([
    ["55,50", 55.5],
    ["12.50", 12.5],
    ["73", 73],
    [12.5, 12.5],
    ["1,2,3", null],
    ["", null],
    ["n/a", null],
    [null, null],
  ])("reads %p as %p", (raw, want) => {
    expect(tradegateNumber(raw)).toBe(want);
  });

  test("an empty body is no such ISIN", () => {
    for (const body of ["", "  \n"]) {
      const error = (() => {
        try {
          parseRefresh(body, 1);
        } catch (e) {
          return e;
        }
      })();
      expect(error).toBeInstanceOf(SourceError);
      expect((error as SourceError).phrase).toBe("not found");
    }
  });

  test("refuses a page that is not JSON, and one with no last price", () => {
    expect(() => parseRefresh("<html></html>", 1)).toThrow(Unreadable);
    expect(() => parseRefresh('{"bid":1,"last":0}', 1)).toThrow(
      "no last price",
    );
    expect(() => parseRefresh('{"bid":1,"last":"x"}', 1)).toThrow(
      "no last price",
    );
    expect(() => parseRefresh("[1]", 1)).toThrow("not a quote");
  });

  test("a side at zero is no price", () => {
    const q = parseRefresh('{"bid":0,"ask":"0,00","last":10}', 1);
    expect([q.bid, q.ask, q.last]).toEqual([null, null, 10]);
  });
});

// Friday 20 November 2026, Xetra from 09:00 to 17:30 Berlin (CET)
const FRIDAY = {
  start: at("2026-11-20T08:00:00Z"),
  end: at("2026-11-20T16:30:00Z"),
};

describe("the Tradegate session", () => {
  test.each([
    ["07:00", "2026-11-20T06:00:00Z", "closed"],
    ["08:00", "2026-11-20T07:00:00Z", "pre"],
    ["12:00", "2026-11-20T11:00:00Z", "regular"],
    ["18:00", "2026-11-20T17:00:00Z", "post"],
    ["22:30", "2026-11-20T21:30:00Z", "closed"],
  ])("is %s Berlin on a weekday Xetra trades: %s", (_, now, want) => {
    expect(tradegateSession(at(now), [FRIDAY])).toBe(want as never);
  });

  test.each([
    "2026-11-21T06:00:00Z",
    "2026-11-21T07:00:00Z",
    "2026-11-21T11:00:00Z",
    "2026-11-21T17:00:00Z",
    "2026-11-21T21:30:00Z",
  ])("is closed on a Saturday at %s", (now) => {
    expect(tradegateSession(at(now), [FRIDAY])).toBe("closed");
  });

  test("is closed on a weekday Xetra does not trade", () => {
    const before = {
      start: at("2026-12-23T08:00:00Z"),
      end: at("2026-12-23T16:30:00Z"),
    };
    const after = {
      start: at("2026-12-28T08:00:00Z"),
      end: at("2026-12-28T16:30:00Z"),
    };
    for (const now of ["07:00", "11:00", "17:00"]) {
      expect(
        tradegateSession(at(`2026-12-24T${now}:00Z`), [before, after]),
      ).toBe("closed");
    }
  });

  test("keeps Berlin's hours across the clock change", () => {
    // summer time: 07:30 Berlin is 05:30 UTC
    const day = {
      start: at("2027-06-01T07:00:00Z"),
      end: at("2027-06-01T15:30:00Z"),
    };
    expect(tradegateSession(at("2027-06-01T05:29:00Z"), [day])).toBe("closed");
    expect(tradegateSession(at("2027-06-01T05:30:00Z"), [day])).toBe("pre");
    expect(tradegateSession(at("2027-06-01T19:59:00Z"), [day])).toBe("post");
    expect(tradegateSession(at("2027-06-01T20:00:00Z"), [day])).toBe("closed");
  });

  test("the change is from the Xetra close its late quote has reached", () => {
    const q = {
      last: 105,
      bid: 104.9,
      ask: 105.1,
      high: 106,
      low: 99,
      close: 101,
      volume: 1200,
      fetchedAt: at("2026-11-23T08:01:00Z"),
    };
    const change = (
      session: "pre" | "regular" | "post" | "closed",
      xetra: {
        price: number | null;
        previousClose: number | null;
        time: number | null;
      } | null,
      now: string,
    ) => tradegateExtended(q, session, xetra, [], at(now)).change;
    // Friday's quote, still stored on Monday at 09:01: Friday's close
    const friday = {
      price: 100,
      previousClose: 98,
      time: at("2026-11-20T16:30:00Z"),
    };
    expect(change("pre", friday, "2026-11-23T07:30:00Z")).toBe(5);
    expect(change("regular", friday, "2026-11-23T08:01:00Z")).toBe(5);
    // once it trades today: the previous close in the session
    const monday = {
      price: 104,
      previousClose: 100,
      time: at("2026-11-23T09:00:00Z"),
    };
    expect(change("regular", monday, "2026-11-23T09:15:00Z")).toBe(5);
    // after the close and through the night: today's close
    expect(change("post", monday, "2026-11-23T17:00:00Z")).toBe(1);
    expect(change("closed", monday, "2026-11-23T21:30:00Z")).toBe(1);
    // the close it needs not known, or no quote
    expect(
      change(
        "regular",
        { ...monday, previousClose: null },
        "2026-11-23T09:15:00Z",
      ),
    ).toBeNull();
    expect(change("pre", null, "2026-11-23T07:30:00Z")).toBeNull();
    expect(
      tradegateExtended(q, "post", monday, [], at("2026-11-23T17:00:00Z")),
    ).toMatchObject({ change_percent: round(100 / 104) });
  });
});

const round = (v: number) => Number(v.toPrecision(6));

type Answer = Recorded | "hold" | "throw";

// a Xetra listing with its quote, Xetra's session stored as given
async function setup(
  options: {
    now?: number;
    isin?: string | null;
    session?: { start: number; end: number };
    chart?: Recorded;
    // the chart waits until released
    chartHeld?: ReturnType<typeof gate>;
    // the stored Xetra quote's trade time
    traded?: number;
    currency?: string;
    symbol?: string;
  } = {},
) {
  const page = await fixture("refresh-ie00bfmxxd54");
  const clock = fakeClock(options.now ?? at(page.recordedAt));
  const { db } = open(":memory:", clock);
  const symbol = options.symbol ?? "VUAA";
  const id = `XETRA:${symbol}`;
  upsertInstrument(
    db,
    {
      market: "XETRA",
      symbol,
      source: "yahoo",
      sourceSymbol: `${symbol}.DE`,
      exchange: "GER",
      name: symbol,
      type: "ETF",
      currency: options.currency ?? "EUR",
      unit: "per_share",
      zone: "Europe/Berlin",
    },
    clock.now(),
  );
  const isin = options.isin === undefined ? VUAA : options.isin;
  if (isin !== null) writeIsin(db, id, isin, clock.now());
  db.query("update instruments set last_read_at = ?").run(clock.now());
  // stored days, so a quote reads it without a fetch
  for (const date of ["2026-10-26", "2026-10-27", "2026-11-19", "2026-11-20"]) {
    db.query(
      `insert into bars (instrument, interval, date, open, high, low, close,
         volume, final, fetched_at) values (?, '1d', ?, 126, 126, 126, 126, 1000, 1, ?)`,
    ).run(id, date, clock.now());
  }
  quote(db, id, 126.2, 126.66);
  // traded today, as the quote pass stores it
  db.query("update quotes set time = ?").run(options.traded ?? clock.now());
  const s = options.session ?? FRIDAY;
  recordSession(db, "XETRA", session("Europe/Berlin", s.start, s.end), s.start);
  const held = gate();
  const answers: Answer[] = [];
  const tg = fakeFetch(async (url) => {
    const next = answers.shift() ?? page;
    if (next === "hold") {
      await held.hold();
      return page;
    }
    if (next === "throw") throw new Error("down");
    expect(url.searchParams.get("isin")).toBe(isin!);
    return next;
  });
  const y = fakeFetch(async (url) => {
    await options.chartHeld?.hold();
    return options.chart !== undefined && chartSymbol(url) === `${symbol}.DE`
      ? options.chart
      : undefined;
  });
  const m: Markets = markets({
    db,
    clock,
    writer: writer(db),
    yahoo: yahoo({ clock, fetch: y.fetch }),
    fred: null,
    tradegate: tradegate({ clock, fetch: tg.fetch }),
    log: silent,
  });
  const read = async () =>
    (
      await readExtended(m, [readInstrument(db, id)!], clock.now() + CALL_MS)
    ).get(id)!;
  return { clock, db, m, id, read, answers, held, tg, y };
}

const body = (text: string): Recorded => ({
  recordedAt: "",
  status: 200,
  headers: {},
  body: text,
});

describe("a Xetra listing's extended quote", () => {
  test("is Tradegate's while Xetra trades, with its quote and range", async () => {
    const t = await setup();
    const read = await t.read();
    expect(read).toEqual({
      extended: {
        session: "regular",
        price: 125.345,
        change: round(125.345 - 126.66),
        change_percent: round(((125.345 - 126.66) / 126.66) * 100),
        time: "2026-11-20T13:07:00Z",
        bid: 125.325,
        ask: 125.345,
        day_high: 126.585,
        day_low: 125.3,
        volume: 60100,
        tradegate_close: 126.66,
        source: "tradegate",
      },
      reason: null,
      opens: null,
    });
    // Xetra's own chart is not asked while it trades
    expect(t.y.urls).toHaveLength(0);
    expect(t.tg.urls).toHaveLength(1);
    expect(t.tg.urls[0]!.href).toBe(
      `https://www.tradegatebsx.com/refresh.php?isin=${VUAA}`,
    );
  });

  test("is answered in the quote beside the regular price, left as it was", async () => {
    const t = await setup();
    const page = (extended: boolean) =>
      quotePage(t.m, parseQuote({ symbols: [t.id], extended }));
    const plain = JSON.parse(await page(false)).items[0];
    const asked = JSON.parse(await page(true)).items[0];
    expect(asked.extended.source).toBe("tradegate");
    expect(asked.extended_reason).toBeNull();
    const { extended, extended_reason, opens, ...regular } = asked;
    expect(regular).toEqual(plain);
    expect(asked.price).toBe(126.2);
  });

  test("names Xetra's day and next open from the chart while Xetra is closed", async () => {
    // 07:45 Berlin, the chart recorded that morning names the day's session
    const chart = await recorded("chart-vwce-de-1d-1m-prepost-pre-0830");
    const t = await setup({
      now: at("2026-10-28T06:45:00Z"),
      symbol: "VWCE",
      isin: MADE_UP,
      chart,
      // the stored session is the day before's
      session: {
        start: at("2026-10-27T08:00:00Z"),
        end: at("2026-10-27T16:30:00Z"),
      },
    });
    const read = await t.read();
    expect(read.extended).toMatchObject({
      session: "pre",
      source: "tradegate",
      time: "2026-10-28T06:45:00Z",
    });
    expect(read.opens).toBe("2026-10-28T08:00:00Z");
    expect(t.y.urls).toHaveLength(1);
  });

  test("a hanging chart never hides Tradegate's answer", async () => {
    const chartHeld = gate();
    // 20:00 Berlin, Xetra closed, Tradegate trading
    const t = await setup({ now: at("2026-11-20T19:00:00Z"), chartHeld });
    const page = t.read();
    await chartHeld.arrived;
    await t.clock.advance(CHART_WAIT_MS);
    const read = await page;
    expect(read.extended).toMatchObject({
      session: "post",
      source: "tradegate",
      time: "2026-11-20T19:00:00Z",
    });
    chartHeld.release();
  });

  test("closed, its time is the last Tradegate close of a Xetra day", async () => {
    // Saturday noon Berlin, Friday's session stored, the chart failing
    const t = await setup({ now: at("2026-11-21T11:00:00Z") });
    const read = await t.read();
    expect(read.extended).toMatchObject({
      session: "closed",
      time: "2026-11-20T21:00:00Z",
    });
    // after 22:00 on a trading day it is that evening's
    expect(lastTradegateClose(at("2026-11-20T21:30:00Z"), [FRIDAY])).toBe(
      at("2026-11-20T21:00:00Z"),
    );
    // before 07:30 the evening before's, none when no earlier day is known
    const thursday = {
      start: at("2026-11-19T08:00:00Z"),
      end: at("2026-11-19T16:30:00Z"),
    };
    expect(
      lastTradegateClose(at("2026-11-20T05:00:00Z"), [thursday, FRIDAY]),
    ).toBe(at("2026-11-19T21:00:00Z"));
    expect(lastTradegateClose(at("2026-11-20T05:00:00Z"), [FRIDAY])).toBeNull();
  });

  test("a failed chart before the open still reads pre from a stored session naming today", async () => {
    // 08:00 Berlin; the session stored ahead of its start
    const t = await setup({ now: at("2026-11-20T07:00:00Z") });
    const read = await t.read();
    expect(t.y.urls).toHaveLength(1);
    expect(read.extended).toMatchObject({
      session: "pre",
      source: "tradegate",
    });
  });

  test("a failed chart keeps the days a chart read before named", async () => {
    const chart = await recorded("chart-vwce-de-1d-1m-prepost-pre-0830");
    const t = await setup({
      now: at("2026-10-28T06:45:00Z"),
      symbol: "VWCE",
      isin: MADE_UP,
      chart,
      session: {
        start: at("2026-10-27T08:00:00Z"),
        end: at("2026-10-27T16:30:00Z"),
      },
    });
    await t.read();
    // the held chart past its period, and the next one failing
    const held = t.m.extended.get(t.id)!;
    t.m.extended.set(t.id, { ...held, until: t.clock.now() });
    await t.clock.advance(HELD_MS);
    t.y.urls.length = 0;
    const read = await t.read();
    expect(read.extended).toMatchObject({ session: "pre" });
    expect(read.opens).toBe("2026-10-28T08:00:00Z");
  });

  test("a Tradegate failure keeps the chart's next open", async () => {
    const chart = await recorded("chart-vwce-de-1d-1m-prepost-pre-0830");
    const t = await setup({
      now: at("2026-10-28T06:45:00Z"),
      symbol: "VWCE",
      isin: MADE_UP,
      chart,
      session: {
        start: at("2026-10-27T08:00:00Z"),
        end: at("2026-10-27T16:30:00Z"),
      },
    });
    t.answers.push(body(""));
    expect(await t.read()).toEqual({
      extended: null,
      reason: EXTENDED.notListed,
      opens: "2026-10-28T08:00:00Z",
    });
  });

  test("a listing not in EUR is not Tradegate's and asks nothing", async () => {
    const t = await setup({ currency: "USD" });
    expect(await t.read()).toEqual({
      extended: null,
      reason: EXTENDED.notListed,
      opens: null,
    });
    expect(t.tg.urls).toHaveLength(0);
  });

  test("an answer just before the deadline is kept, the chart's wait cut short", async () => {
    const chartHeld = gate();
    const t = await setup({ now: at("2026-11-20T19:00:00Z"), chartHeld });
    t.answers.push("hold");
    const page = t.read();
    await t.held.arrived;
    // Tradegate answers 200 ms before the deadline, the chart still out
    await t.clock.advance(CALL_MS - 200);
    t.held.release();
    await t.clock.advance(200);
    const read = await page;
    expect(read.extended).toMatchObject({ source: "tradegate" });
    chartHeld.release();
  });

  test("a held quote is classed at the time of the answer", async () => {
    // 08:59:50 Berlin, before Xetra's open, the session stored ahead
    const t = await setup({
      now: at("2026-11-20T07:59:50Z"),
      traded: at("2026-11-19T16:30:00Z"),
    });
    expect((await t.read()).extended).toMatchObject({ session: "pre" });
    await t.clock.advance(10_000);
    const read = await t.read();
    expect(t.tg.urls).toHaveLength(1);
    expect(read.extended).toMatchObject({
      session: "regular",
      time: "2026-11-20T07:59:50Z",
    });
  });

  test("a held quote read after 22:00 takes that day's close", async () => {
    // 21:59:55 Berlin, then read from the cache past Tradegate's close
    const t = await setup({
      now: at("2026-11-20T20:59:55Z"),
      traded: at("2026-11-20T16:30:00Z"),
    });
    expect((await t.read()).extended).toMatchObject({ session: "post" });
    await t.clock.advance(10_000);
    const read = await t.read();
    expect(t.tg.urls).toHaveLength(1);
    expect(read.extended).toMatchObject({
      session: "closed",
      time: "2026-11-20T21:00:00Z",
    });
  });

  test("without an ISIN says so whatever the chart did", async () => {
    // Xetra closed and its chart failing
    const t = await setup({ isin: null, now: at("2026-11-20T19:00:00Z") });
    expect(await t.read()).toEqual({
      extended: null,
      reason: EXTENDED.noIsin,
      opens: null,
    });
    expect(t.y.urls).toHaveLength(1);
    expect(t.tg.urls).toHaveLength(0);
  });

  test("without an ISIN says so", async () => {
    const t = await setup({ isin: null });
    expect(await t.read()).toEqual({
      extended: null,
      reason: EXTENDED.noIsin,
      opens: null,
    });
    expect(t.tg.urls).toHaveLength(0);
  });

  test("an ISIN Tradegate does not list answers not on Tradegate", async () => {
    const t = await setup();
    t.answers.push(body(""));
    expect((await t.read()).reason).toBe(EXTENDED.notListed);
  });

  test.each([
    ["a page that is not JSON", "<html>busy</html>"],
    ["a payload with no last price", '{"bid":1}'],
  ])("%s answers a failed fetch, the regular quote intact", async (_, raw) => {
    const t = await setup();
    t.answers.push(body(raw));
    const [item] = JSON.parse(
      await quotePage(t.m, parseQuote({ symbols: [t.id], extended: true })),
    ).items;
    expect(item.extended).toBeNull();
    expect(item.extended_reason).toBe(EXTENDED.failed);
    expect(item.price).toBe(126.2);
    expect(item.previous_close).toBe(126.66);
  });

  test("an error status answers a failed fetch", async () => {
    const t = await setup();
    t.answers.push({ ...body("oops"), status: 502 });
    expect((await t.read()).reason).toBe(EXTENDED.failed);
  });

  test("past the deadline answers not fetched in time, the regular quote intact", async () => {
    const t = await setup();
    t.answers.push("hold");
    const page = quotePage(
      t.m,
      parseQuote({ symbols: [t.id], extended: true }),
    );
    await t.held.arrived;
    await t.clock.advance(CALL_MS);
    const [item] = JSON.parse(await page).items;
    expect(item.extended).toBeNull();
    expect(item.extended_reason).toBe(EXTENDED.timeout);
    expect(item.price).toBe(126.2);
    t.held.release();
  });

  test("is fetched once per ISIN in 15 seconds, and calls at once share one", async () => {
    const t = await setup();
    const [a, b] = await Promise.all([t.read(), t.read()]);
    expect(a).toEqual(b);
    expect(t.tg.urls).toHaveLength(1);
    await t.clock.advance(HELD_MS - 1);
    await t.read();
    expect(t.tg.urls).toHaveLength(1);
    await t.clock.advance(1);
    await t.read();
    expect(t.tg.urls).toHaveLength(2);
  });

  test("never keeps a failed fetch", async () => {
    const t = await setup();
    t.answers.push("throw");
    expect((await t.read()).reason).toBe(EXTENDED.failed);
    // the failure backs the source off; once over, the next call fetches
    await t.clock.advance(60_000);
    expect((await t.read()).extended?.source).toBe("tradegate");
    expect(t.tg.urls).toHaveLength(2);
  });
});
