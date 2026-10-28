// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { spec } from "../src/api/openapi.ts";
import { rebuildWeeks } from "../src/market/bars.ts";
import {
  readSession,
  recordSession,
  session,
} from "../src/market/calendars.ts";
import { iso, round } from "../src/market/format.ts";
import { readInstrument, upsertInstrument } from "../src/market/instruments.ts";
import { STALE } from "../src/market/stale.ts";
import { markRead } from "../src/market/tracking.ts";
import { extendedPoints, latestExtended } from "../src/operations/extended.ts";
import { CALL_MS, type Markets, markets } from "../src/operations/markets.ts";
import { moversAnswer, parseMovers } from "../src/operations/movers.ts";
import { parseQuote, quotePage } from "../src/operations/quote.ts";
import { parseRules, rulesAnswer } from "../src/operations/rules.ts";
import { silent } from "../src/runtime/log.ts";
import { recomputeSignals, refreshLive } from "../src/signals/store.ts";
import {
  INTRADAY_RANGE,
  parseIntraday,
  parseSpark,
  yahoo,
} from "../src/sources/yahoo/client.ts";
import { storeQuotes } from "../src/sources/yahoo/quotes.ts";
import { open } from "../src/storage/db/index.ts";
import { writer } from "../src/storage/writer.ts";
import { api } from "./helpers/api.ts";
import { fakeClock } from "./helpers/clock.ts";
import { answerSchema, validate } from "./helpers/schema.ts";
import { gate } from "./helpers/sources.ts";
import { bar, FINAL, instrument, listing, world } from "./helpers/world.ts";
import {
  chartSymbol,
  clone,
  fakeFetch,
  type Recorded,
  recorded,
} from "./helpers/yahoo.ts";

// recorded in the US post window, about 80 minutes after the close
const POST = "post-2122";
// recorded overnight, after the post window, and in the pre window
const OVERNIGHT = "overnight-0030";
const PRE = "pre-0830";

const LISTINGS = [
  { id: "US:HOOD", symbol: "HOOD", exchange: "NMS", zone: "America/New_York" },
  {
    id: "XETRA:VWCE",
    symbol: "VWCE.DE",
    exchange: "GER",
    zone: "Europe/Berlin",
  },
  { id: "CRYPTO:BTC-USD", symbol: "BTC-USD", exchange: "CCC", zone: "UTC" },
  {
    id: "BVB:TLV",
    symbol: "TLV.RO",
    exchange: "BVB",
    zone: "Europe/Bucharest",
  },
];
const DAYS = [
  "2026-10-19",
  "2026-10-20",
  "2026-10-21",
  "2026-10-22",
  "2026-10-23",
  "2026-10-26",
];
const SYMBOLS = LISTINGS.map((l) => l.symbol);
const IDS = LISTINGS.map((l) => l.id);

const chartName = (symbol: string, window = POST) =>
  `chart-${symbol.toLowerCase().replace(".", "-")}-1d-1m-prepost-${window}`;
const hoodChart = (window = POST) => `chart-hood-2d-1m-prepost-${window}`;

const intraday = (url: URL) =>
  url.searchParams.get("includePrePost") === "true";

// a quote fetches nothing but the extended charts
async function setup(
  options: {
    hold?: (url: URL) => Promise<undefined> | undefined;
    window?: string;
  } = {},
) {
  const window = options.window ?? POST;
  const spark = await recorded(`spark-v7-extended-${window}`);
  const charts = new Map<string, Recorded>();
  // the others have one-day recordings only, and only some windows: just
  // their flag is read; loaded up front so a held chart is the only wait
  for (const s of SYMBOLS) {
    const fx = await recorded(chartName(s, window)).catch(() => undefined);
    if (fx !== undefined) charts.set(s, fx);
  }
  charts.set("HOOD", await recorded(hoodChart(window)));
  const hoodAsked = new URL(
    (charts.get("HOOD") as Recorded & { request: { url: string } }).request.url,
  ).searchParams;
  const clock = fakeClock(Date.parse(charts.get("HOOD")!.recordedAt));
  const { db } = open(":memory:", clock);
  const f = fakeFetch(async (url) => {
    await options.hold?.(url);
    const symbol = chartSymbol(url);
    if (symbol === "HOOD" && intraday(url)) {
      for (const [k, v] of hoodAsked) {
        if (url.searchParams.get(k) !== v) return undefined;
      }
    }
    if (symbol !== null && intraday(url)) return charts.get(symbol);
    if (url.pathname === "/v7/finance/spark") return spark;
    return undefined;
  });
  const client = yahoo({ clock, fetch: f.fetch });
  const now = clock.now();
  for (const l of LISTINGS) {
    const [market, symbol] = l.id.split(":") as [string, string];
    upsertInstrument(
      db,
      {
        market,
        symbol,
        source: "yahoo",
        sourceSymbol: l.symbol,
        exchange: l.exchange,
        name: symbol,
        type: "EQUITY",
        currency: "USD",
        unit: "per_share",
        zone: l.zone,
      },
      now,
    );
    // a final week and a day, so the stored signals are current
    for (const date of DAYS) {
      db.query(
        `insert into bars (instrument, interval, date, open, high, low, close,
           volume, final, fetched_at) values (?, '1d', ?, 90, 90, 90, 90, 1000, 1, ?)`,
      ).run(l.id, date, now);
    }
  }
  // the quote job's write, without telling the client the flags
  storeQuotes(db, parseSpark(spark.body, now));
  for (const l of LISTINGS) {
    const i = readInstrument(db, l.id)!;
    rebuildWeeks(db, l.id, readSession(db, i.market), now);
    recomputeSignals(db, l.id, now);
    refreshLive(db, i, now);
  }
  markRead(db, IDS, now);
  const m: Markets = markets({
    db,
    clock,
    writer: writer(db),
    yahoo: client,
    fred: null,
    log: silent,
  });
  const charted = (symbol?: string) =>
    f.urls.filter(
      (u) => intraday(u) && (symbol === undefined || chartSymbol(u) === symbol),
    );
  return { clock, db, m, client, charted, charts };
}

const text = (m: Markets, args: object) =>
  quotePage(m, parseQuote({ symbols: IDS, ...args }));

async function ask(m: Markets, args: object = { extended: true }) {
  return JSON.parse(await text(m, args)).items as any[];
}

const byId = (items: any[], id: string) => items.find((i) => i.id === id);

// HOOD's last post bar in the recording, against its regular close
const HOOD_CLOSE = 94.56;
// the two-day recording's last bar, 21:22:50 UTC at 89.69
const HOOD_LAST = 89.69;
const HOOD = {
  session: "post",
  price: HOOD_LAST,
  change: round(HOOD_LAST - HOOD_CLOSE),
  change_percent: round(((HOOD_LAST - HOOD_CLOSE) / HOOD_CLOSE) * 100),
  time: "2026-10-27T21:22:50Z",
};

const against = (session: "pre" | "post", at: number, time: string) => ({
  session,
  price: at,
  change: round(at - HOOD_CLOSE),
  change_percent: round(((at - HOOD_CLOSE) / HOOD_CLOSE) * 100),
  time,
});
// overnight the evening's last post bar stands; then the morning's pre bar
const HOOD_OVERNIGHT = against("post", 87.3423, "2026-10-27T23:59:59Z");
const HOOD_PRE = against("pre", 86.79, "2026-10-28T08:29:56Z");

describe("quote extended", () => {
  test("the quotes route answers the tool's extended per item, only when asked", async () => {
    const t = await setup();
    await t.client.spark(SYMBOLS);
    const get = async (query: string) => {
      const res = await api(t.m)(
        new Request(
          `http://markets.test/api/v1/quotes?symbols=${IDS.join(",")}${query}`,
        ),
      );
      expect(res.status).toBe(200);
      const body: any = await res.json();
      const schema = answerSchema(spec, "GET", "/quotes", 200)!;
      expect(validate(body, schema, spec)).toEqual([]);
      return body.items as any[];
    };
    const asked = await get("&extended=true");
    const tool = await ask(t.m);
    expect(byId(asked, "US:HOOD").extended).toEqual(HOOD);
    for (const [k, item] of asked.entries()) {
      expect(item.extended).toEqual(tool[k].extended);
      expect(item.stale).toEqual(tool[k].stale);
    }
    for (const query of ["", "&extended=false"]) {
      for (const item of await get(query)) {
        expect(item).not.toContainKey("extended");
        expect(item.stale).toEqual([]);
      }
    }
    // one chart for the period, whichever surface asked first
    expect(t.charted("HOOD")).toHaveLength(1);
  });

  test("answers the last post bar of a listing that trades after hours", async () => {
    const t = await setup();
    await t.client.spark(SYMBOLS);
    const items = await ask(t.m);
    const hood = byId(items, "US:HOOD");
    expect(hood.extended).toEqual(HOOD);
    expect(hood.stale).toEqual([]);
    // the regular quote stays the regular session's
    expect(hood.price).toBe(HOOD_CLOSE);
    for (const id of ["XETRA:VWCE", "CRYPTO:BTC-USD", "BVB:TLV"]) {
      const item = byId(items, id);
      expect(item.extended).toBeNull();
      expect(item.stale).toEqual([STALE.extendedNone]);
    }
    // the spark answer's flag spares the others a chart
    expect(t.charted()).toHaveLength(1);
    expect(t.charted("HOOD")).toHaveLength(1);
    const url = t.charted("HOOD")[0]!;
    expect(url.searchParams.get("interval")).toBe("1m");
    expect(url.searchParams.get("range")).toBe(INTRADAY_RANGE);
  });

  test("learns the flag from the chart of a listing no spark answer named", async () => {
    const t = await setup();
    const items = await ask(t.m);
    expect(byId(items, "US:HOOD").extended).toEqual(HOOD);
    for (const id of ["XETRA:VWCE", "BVB:TLV"]) {
      expect(byId(items, id).extended).toBeNull();
      expect(byId(items, id).stale).toEqual([STALE.extendedNone]);
    }
    // crypto never closes, so it is never asked
    expect(t.charted("BTC-USD")).toHaveLength(0);
    expect(t.charted()).toHaveLength(3);
    // the next period asks again only the listing that has extended trading
    await t.clock.advance(t.m.quoteEveryMs);
    await ask(t.m);
    expect(t.charted("HOOD")).toHaveLength(2);
    expect(t.charted()).toHaveLength(4);
  });

  test("is fetched once per listing in a quote period", async () => {
    const t = await setup();
    await t.client.spark(SYMBOLS);
    const [first, second] = await Promise.all([ask(t.m), ask(t.m)]);
    expect(byId(first!, "US:HOOD").extended).toEqual(HOOD);
    expect(byId(second!, "US:HOOD").extended).toEqual(HOOD);
    await ask(t.m);
    expect(t.charted("HOOD")).toHaveLength(1);
    await t.clock.advance(t.m.quoteEveryMs);
    await ask(t.m);
    expect(t.charted("HOOD")).toHaveLength(2);
    // overnight, the last post bar is still the newest price
    await t.clock.advance(Date.parse("2026-10-28T01:00:00Z") - t.clock.now());
    const night = await ask(t.m);
    expect(t.charted("HOOD")).toHaveLength(3);
    expect(byId(night, "US:HOOD").extended).toEqual(HOOD);
  });

  test.each([
    ["after the post window", OVERNIGHT, HOOD_OVERNIGHT],
    ["in the pre window", PRE, HOOD_PRE],
  ])("answers the latest extended bar %s", async (_, window, expected) => {
    const t = await setup({ window });
    await t.client.spark(SYMBOLS);
    const items = await ask(t.m);
    const hood = byId(items, "US:HOOD");
    expect(hood.extended).toEqual(expected);
    expect(hood.price).toBe(HOOD_CLOSE);
    for (const id of ["XETRA:VWCE", "CRYPTO:BTC-USD", "BVB:TLV"]) {
      const item = byId(items, id);
      expect(item.extended).toBeNull();
      expect(item.stale).toContain(STALE.extendedNone);
    }
    expect(t.charted()).toHaveLength(1);
    expect(t.charted("HOOD")[0]!.searchParams.get("range")).toBe(
      INTRADAY_RANGE,
    );
  });

  test("is not reported for a listing another source prices", async () => {
    const w = world();
    listing(w.db, "XX:A");
    instrument(w.db, "FRED:DGS10");
    bar(w.db, "FRED:DGS10", "1d", FINAL, 4.2, true);
    // a FRED series no read kept would be fetched again
    w.db.query("update instruments set last_read_at = ?").run(w.clock.now());
    const items = JSON.parse(
      await quotePage(
        w.m,
        parseQuote({ symbols: ["XX:A", "FRED:DGS10"], extended: true }),
      ),
    ).items;
    for (const item of items) {
      expect(item.extended).toBeNull();
      expect(item.stale).toContain(STALE.extendedUnreported);
      expect(item.stale).not.toContain(STALE.extendedNone);
    }
  });

  test("leaves the answer as it was when not asked", async () => {
    const t = await setup();
    await t.client.spark(SYMBOLS);
    const before = await text(t.m, {});
    expect(await text(t.m, { extended: false })).toBe(before);
    await ask(t.m);
    expect(await text(t.m, {})).toBe(before);
    for (const item of JSON.parse(before).items) {
      expect(item).not.toContainKey("extended");
    }
    expect(t.charted()).toHaveLength(1);
  });

  test("answers null in the regular session without a chart", async () => {
    const t = await setup();
    const now = t.clock.now();
    recordSession(
      t.db,
      "US",
      session("America/New_York", now - 60_000, now + 60_000),
      now,
    );
    const hood = byId(await ask(t.m), "US:HOOD");
    expect(hood.extended).toBeNull();
    expect(hood.stale).toEqual([STALE.extendedOpen]);
    expect(t.charted("HOOD")).toHaveLength(0);
  });

  test("past the deadline answers null with a timeout and fails nothing else", async () => {
    const held = gate();
    const t = await setup({
      hold: (url) =>
        chartSymbol(url) === "HOOD" && intraday(url) ? held.hold() : undefined,
    });
    const page = ask(t.m);
    await held.arrived;
    await t.clock.advance(CALL_MS);
    const items = await page;
    const hood = byId(items, "US:HOOD");
    expect(hood.extended).toBeNull();
    expect(hood.stale).toEqual([STALE.extendedTimeout]);
    expect(hood.price).toBe(HOOD_CLOSE);
    expect(byId(items, "XETRA:VWCE").stale).toEqual([STALE.extendedNone]);
    held.release();
  });

  test("leaves signals, movers and rules on the regular price", async () => {
    const t = await setup();
    await t.client.spark(SYMBOLS);
    const tables = () =>
      ["quotes", "bars", "signals", "alerts"].map((table) =>
        t.db.query(`select * from ${table}`).all(),
      );
    const stored = tables();
    const plain = byId(await ask(t.m, {}), "US:HOOD");
    const asked = byId(await ask(t.m), "US:HOOD");
    expect(asked.extended).toEqual(HOOD);
    expect(tables()).toEqual(stored);
    const { extended, stale, ...regular } = asked;
    expect(regular).toEqual((({ stale, ...rest }) => rest)(plain));
    const movers = JSON.parse(
      (
        await moversAnswer(
          t.m,
          parseMovers({ symbols: ["US:HOOD"], min_move_pct: 0 }),
        )
      ).content[0]!.text,
    );
    expect(movers.items[0].change).toBe(plain.change);
    // HOOD's extended price is under 92, its regular close is not
    const rule = JSON.parse(
      (
        await rulesAnswer(
          t.m,
          parseRules({
            action: "create",
            symbol: "US:HOOD",
            condition: { left: "price", op: "<", right: 92 },
            note: "below 92",
          }),
        )
      ).content[0]!.text,
    );
    expect(rule.evaluation.result).toBe("false");
    expect(rule.evaluation.values[0].left.value).toBe(HOOD_CLOSE);
    expect(rule.alert).toBeNull();
  });
});

function unpricedSinceClose(fx: Recorded): Recorded {
  const out = clone(fx);
  const result = out.body.chart.result[0];
  const end = result.meta.currentTradingPeriod.regular.end;
  const close = result.indicators.quote[0].close;
  result.timestamp.forEach((s: number, i: number) => {
    if (s >= end) close[i] = null;
  });
  return out;
}

const latestOf = (fx: Recorded) => {
  const at = Date.parse(fx.recordedAt);
  return latestExtended(parseIntraday(fx.body, at), at);
};

describe("the latest extended bar", () => {
  test("is today's last post bar in an answer holding the day before", async () => {
    const fx = await recorded(hoodChart());
    const result = fx.body.chart.result[0];
    const last = result.timestamp.length - 1;
    const close = result.indicators.quote[0].close[last];
    expect(latestOf(fx).extended).toEqual({
      session: "post",
      price: close,
      change: round(close - HOOD_CLOSE),
      change_percent: round(((close - HOOD_CLOSE) / HOOD_CLOSE) * 100),
      time: iso(result.timestamp[last] * 1000),
    });
  });

  test("is the day before's last post bar before today's pre window", async () => {
    const fx = clone(await recorded(hoodChart()));
    const result = fx.body.chart.result[0];
    const now = Date.parse("2026-10-27T07:30:00Z");
    const n = result.timestamp.filter((s: number) => s * 1000 <= now).length;
    result.timestamp = result.timestamp.slice(0, n);
    const quote = result.indicators.quote[0];
    for (const k of Object.keys(quote)) quote[k] = quote[k].slice(0, n);
    const answer = {
      ...parseIntraday(fx.body, now),
      time: Date.parse("2026-10-26T20:00:00Z"),
    };
    const read = latestExtended(answer, now);
    expect(read.extended?.session).toBe("post");
    expect(read.extended?.time).toBe("2026-10-26T23:59:00Z");
  });

  test("never reaches back to the previous day's post bars", async () => {
    const fx = await recorded(hoodChart());
    expect(latestOf(unpricedSinceClose(fx))).toEqual({
      extended: null,
      reason: STALE.extendedNoPrice,
    });
  });

  test("is none when no extended bar has a price since the close", async () => {
    const fx = await recorded(chartName("HOOD"));
    expect(latestOf(unpricedSinceClose(fx))).toEqual({
      extended: null,
      reason: STALE.extendedNoPrice,
    });
  });

  test("is the evening's last post bar after the post window", async () => {
    const fx = await recorded(hoodChart(OVERNIGHT));
    expect(latestOf(fx).extended).toEqual(HOOD_OVERNIGHT);
  });

  test.each([
    ["two-day", hoodChart(PRE)],
    ["one-day", chartName("HOOD", PRE)],
  ])(
    "is the last pre bar in the pre window, from a %s answer",
    async (_, name) => {
      expect(latestOf(await recorded(name)).extended).toEqual(HOOD_PRE);
    },
  );

  test.each([
    ["VWCE.DE", "post", POST],
    ["BTC-USD", "post", POST],
    ["TLV.RO", "post", POST],
    ["VWCE.DE", "pre", PRE],
    ["TLV.RO", "pre", PRE],
  ])(
    "is none for %s, which has no extended trading, in the %s window",
    async (symbol, _, window) => {
      expect(latestOf(await recorded(chartName(symbol, window))).reason).toBe(
        STALE.extendedNone,
      );
    },
  );
});

describe("the extended points of a chart's day", () => {
  test("are the last close of each 5 minutes, pre and post only, in order", async () => {
    const fx = await recorded(hoodChart());
    const at = Date.parse(fx.recordedAt);
    const answer = parseIntraday(fx.body, at);
    const points = extendedPoints(answer);
    expect(points.length).toBeGreaterThan(0);
    const { pre, regular, post } = answer.windows;
    const inside = (ws: typeof pre, t: number) =>
      ws.some((w) => t >= w.start && t < w.end);
    for (const [i, p] of points.entries()) {
      expect(p.at % (5 * 60_000)).toBe(0);
      if (i > 0) expect(p.at).toBeGreaterThan(points[i - 1]!.at);
      expect(inside(regular, p.at)).toBe(false);
      expect(inside(p.session === "pre" ? pre : post, p.at)).toBe(true);
    }
    // a bucket holds its last minute's close
    const last = points.at(-1)!;
    const rows = answer.rows.filter(
      (r) => r.close !== null && r.at >= last.at && r.at < last.at + 300_000,
    );
    expect(last.close).toBe(rows.at(-1)!.close!);
  });

  test("are none for a listing without extended trading", async () => {
    const fx = await recorded(hoodChart());
    const answer = { ...parseIntraday(fx.body, Date.now()), prePost: false };
    expect(extendedPoints(answer)).toEqual([]);
  });
});
