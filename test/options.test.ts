// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { spec } from "../src/api/openapi.ts";
import { upsertInstrument } from "../src/market/instruments.ts";
import { markets } from "../src/operations/markets.ts";
import { MINUTE_MS } from "../src/runtime/clock.ts";
import { silent } from "../src/runtime/log.ts";
import { fred } from "../src/sources/fred/client.ts";
import { queue, type SourceError } from "../src/sources/source.ts";
import { parseOptions, yahoo } from "../src/sources/yahoo/client.ts";
import {
  CHAIN_BAND,
  chainRows,
  earningsExpiry,
  NO_OPTIONS,
  NOT_OPTIONABLE,
  summaryExpiries,
  summaryRow,
} from "../src/sources/yahoo/options.ts";
import { open } from "../src/storage/db/index.ts";
import { writer } from "../src/storage/writer.ts";
import { parseResearch, researchAnswer } from "../src/tools/research.ts";
import { api } from "./helpers/api.ts";
import { fakeClock } from "./helpers/clock.ts";
import { drive, pacedOf } from "./helpers/drive.ts";
import { answerSchema, validate } from "./helpers/schema.ts";
import { FRED_KEY, gate, sources } from "./helpers/sources.ts";
import {
  CRUMB,
  chainAnswer,
  clone,
  fakeFetch,
  listed,
  optionsSymbol,
  type Recorded,
  recorded,
  yahooSession,
} from "./helpers/yahoo.ts";

// the chains were recorded on a Saturday, Friday's close
const AT = Date.parse("2026-11-07T17:05:00Z");
const NOV_20 = Date.UTC(2026, 10, 20);

const body = (r: { content: { text: string }[] }) =>
  JSON.parse(r.content[0]!.text);

const chainOf = async (name: string) =>
  parseOptions((await recorded(name)).body, AT).chain!;

describe("the option chain read", () => {
  test("lists every expiry in UTC and keeps one contract size", async () => {
    const fx = clone(await recorded("options-aapl"));
    const calls = fx.body.optionChain.result[0].options[0].calls;
    calls[0].contractSize = "MINI";
    const chain = parseOptions(fx.body, AT);
    expect(chain).toMatchObject({
      symbol: "AAPL",
      price: 342.37,
      currency: "USD",
      priceAt: 1793998801000,
    });
    expect(chain.expiries).toHaveLength(20);
    expect(new Date(chain.expiries[0]!).toISOString()).toBe(
      "2026-11-09T00:00:00.000Z",
    );
    expect(chain.chain!.calls).toHaveLength(calls.length - 1);
    expect(chain.chain!.puts).toHaveLength(30);
  });

  test("a placeholder volatility is none, a sane one a fraction", async () => {
    const spy = await chainOf("options-spy");
    const put = (strike: number) => spy.puts.find((p) => p.strike === strike)!;
    for (const strike of [750, 760, 770]) {
      expect(put(strike).iv).toBeNull();
      expect(put(strike).bid).toBeGreaterThan(0);
    }
    expect(put(735).iv).toBeCloseTo(0.16639, 5);
  });

  test("a listing with no options is no chain, not an empty one", async () => {
    const vwce = parseOptions((await recorded("options-vwce-de")).body, AT);
    expect(vwce).toMatchObject({ symbol: "VWCE.DE", chain: null });
    expect(vwce.expiries).toEqual([]);
    const fx = clone(await recorded("options-aapl"));
    delete fx.body.optionChain.result[0].options;
    expect(() => parseOptions(fx.body, AT)).toThrow("not one expiry's options");
    // a side whose every contract is of another expiry is not this one's
    const moved = clone(await recorded("options-aapl"));
    for (const c of moved.body.optionChain.result[0].options[0].puts) {
      c.expiration += 86_400;
    }
    expect(() => parseOptions(moved.body, AT)).toThrow(
      "puts of another expiry",
    );
  });
});

describe("the options summary", () => {
  test("a row's figures are the at-the-money pair's and the chain's sums", async () => {
    const row = summaryRow(await chainOf("options-aapl-2026-11-20"), 342.37);
    expect(row).toEqual({
      atm_strike: 342.5,
      call_iv: 28.8337,
      put_iv: 27.7961,
      straddle: 14.925,
      implied_move_pct: 4.35932,
      put_call_oi: 0.886379,
      put_call_volume: 2.42382,
      top_call_oi: [
        { strike: 400, open_interest: 40963 },
        { strike: 365, open_interest: 40261 },
        { strike: 360, open_interest: 22812 },
      ],
      top_put_oi: [
        { strike: 310, open_interest: 44399 },
        { strike: 300, open_interest: 42345 },
        { strike: 330, open_interest: 21049 },
      ],
    });
  });

  test("a crossed quote has no mid, so its straddle is none", async () => {
    const chain = await chainOf("options-aapl");
    const row = summaryRow(chain, 342.37);
    // the 342.5 call read bid 2.72, ask 2.65
    expect(row).toMatchObject({
      atm_strike: 342.5,
      call_iv: 21.9246,
      put_iv: 23.6092,
      straddle: null,
      implied_move_pct: null,
    });
    const strike = chainRows(chain, 342.37).find((r) => r.strike === 342.5)!;
    expect(strike.call).toMatchObject({ bid: 2.72, ask: 2.65, mid: null });
    const put = strike.put!;
    expect(put.bid!).toBeLessThan(put.ask!);
    expect(put.mid!).toBeCloseTo((put.bid! + put.ask!) / 2, 6);
    // a zero bid far out of the money has no mid either
    const far = chainRows(chain, 342.37).find((r) => r.call?.bid === 0)!;
    expect(far.call!.mid).toBeNull();
    expect(far.call!.last).not.toBeNull();
  });

  test("the at-the-money strike lists both sides", async () => {
    const chain = await chainOf("options-aapl-2026-11-20");
    const noPut = {
      ...chain,
      puts: chain.puts.filter((p) => p.strike !== 342.5),
    };
    expect(summaryRow(noPut, 342.37).atm_strike).toBe(340);
  });

  test("the earnings expiry is the first to price the report", () => {
    const days = [9, 11, 13, 20, 27].map((d) => Date.UTC(2026, 10, d));
    const at = (date: string, hour: string) =>
      new Date(earningsExpiry(days, { date, hour })!)
        .toISOString()
        .slice(0, 10);
    expect(at("2026-11-20", "amc")).toBe("2026-11-27");
    expect(at("2026-11-20", "")).toBe("2026-11-27");
    expect(at("2026-11-20", "bmo")).toBe("2026-11-20");
    // an expiry settles at the day's close, after a report during the session
    expect(at("2026-11-20", "dmh")).toBe("2026-11-20");
    expect(earningsExpiry(days, null)).toBeNull();
    expect(
      earningsExpiry(days, { date: "2026-11-30", hour: "bmo" }),
    ).toBeNull();
    // added only when past the nearest four, a same-day expiry skipped
    const rows = (today: string, earnings: number | null) =>
      summaryExpiries(days, today, earnings).map(
        (r) =>
          `${new Date(r.expiry).toISOString().slice(8, 10)}${r.earnings ? "e" : ""}`,
      );
    expect(rows("2026-11-07", days[3]!)).toEqual(["09", "11", "13", "20e"]);
    expect(rows("2026-11-07", days[4]!)).toEqual([
      "09",
      "11",
      "13",
      "20",
      "27e",
    ]);
    expect(rows("2026-11-09", null)).toEqual(["11", "13", "20", "27"]);
  });
});

function client(
  route: (url: URL) => Promise<Recorded | undefined> = async () => undefined,
) {
  const clock = fakeClock(AT);
  const session = yahooSession();
  const f = fakeFetch(
    async (url, headers) => (await route(url)) ?? session.answer(url, headers),
  );
  return { f, y: yahoo({ clock, fetch: f.fetch, queue: queue(clock, 2) }) };
}

describe("the option chain call", () => {
  test("shares the quote summary's session and asks a listed date", async () => {
    const { f, y } = client();
    await y.valuation("TSM");
    const dated = await y.options("AAPL", NOV_20);
    expect(dated.chain!.calls).toHaveLength(94);
    const asked = f.urls.filter((u) => optionsSymbol(u) !== null);
    expect(asked.map((u) => u.searchParams.get("date"))).toEqual([
      "1795132800",
    ]);
    expect(asked[0]!.searchParams.get("crumb")).toStartWith(CRUMB);
    expect(f.urls.filter((u) => u.hostname === "fc.yahoo.com")).toHaveLength(1);
  });

  test("an answer naming another symbol or expiry is malformed", async () => {
    const other = client(async (url) => {
      if (optionsSymbol(url) === null) return undefined;
      const fx = clone((await chainAnswer(url))!);
      fx.body.optionChain.result[0].quote.symbol = "AAPX";
      return fx;
    });
    const named = await other.y.options("AAPL").catch((e: unknown) => e);
    expect((named as SourceError).phrase).toBe("malformed answer");
    // a date Yahoo does not take answers the nearest chain
    const nearest = client(async (url) =>
      optionsSymbol(url) === null ? undefined : recorded("options-aapl"),
    );
    const moved = await nearest.y
      .options("AAPL", NOV_20)
      .catch((e: unknown) => e);
    expect((moved as SourceError).phrase).toBe("malformed answer");
    expect(nearest.y.backoff()).toBeNull();
  });
});

async function setup(
  options: {
    hold?: (url: URL) => Promise<Recorded | undefined> | undefined;
    at?: number;
  } = {},
) {
  const clock = fakeClock(options.at ?? AT);
  const { db } = open(":memory:", clock);
  const chart = listed(await recorded("chart-nvda-5y-1d"));
  const charts: Record<string, Recorded> = {};
  for (const symbol of ["AAPL", "SPY", "VWCE.DE"]) {
    const c = clone(chart);
    c.body.chart.result[0].meta.symbol = symbol;
    charts[symbol] = c;
  }
  const s = await sources({ charts, hold: options.hold });
  const m = markets({
    db,
    clock,
    writer: writer(db),
    yahoo: yahoo({ clock, fetch: s.fetch }),
    fred: fred({ clock, key: FRED_KEY, fetch: s.fetch }),
    log: silent,
  });
  for (const [symbol, type] of [
    ["AAPL", "EQUITY"],
    ["SPY", "ETF"],
  ] as const) {
    upsertInstrument(
      db,
      {
        market: "US",
        symbol,
        source: "yahoo",
        sourceSymbol: symbol,
        exchange: "NMS",
        name: symbol,
        type,
        currency: "USD",
        unit: "per_share",
        zone: "America/New_York",
      },
      clock.now(),
    );
  }
  const ask = (args: Record<string, unknown>) =>
    drive(clock, pacedOf(m), researchAnswer(m, parseResearch(args)));
  const tool = async (symbol: string, more: Record<string, unknown> = {}) =>
    body(await ask({ symbol, section: "options", ...more }));
  const rest = async (path: string) => {
    const res = await drive(
      clock,
      pacedOf(m),
      api(m)(new Request(`http://markets.test/api/v1/${path}`)),
    );
    return { status: res.status, body: (await res.json()) as any };
  };
  const dates = () =>
    s.calls.chains().map((u) => u.searchParams.get("date") ?? "listed");
  const earnings = (
    date: string,
    hour: string,
    quarter = 1,
    reported: number | null = null,
  ) =>
    db
      .query(
        `insert into events (instrument, fiscal_year, fiscal_quarter, date,
           hour, reported_seen_at, fetched_at)
         values ('US:AAPL', 2027, ?, ?, ?, ?, ?)`,
      )
      .run(quarter, date, hour, reported, clock.now());
  return { clock, db, m, s, ask, tool, rest, dates, earnings };
}

describe("the options section", () => {
  test("answers the nearest four expiries in one read, then costs no call", async () => {
    const t = await setup();
    const answer = await t.tool("AAPL");
    expect(answer).toMatchObject({
      id: "US:AAPL",
      section: "options",
      source: "yahoo",
      price: 342.37,
      price_at: "2026-11-06T21:00:01Z",
      currency: "USD",
      fetched_at: "2026-11-07T17:05:00Z",
      stale: [],
    });
    expect(answer.expiries).toHaveLength(20);
    expect(answer.expiries[0]).toBe("2026-11-09");
    expect(
      answer.summary.map((r: any) => [r.expiry, r.days, r.earnings]),
    ).toEqual([
      ["2026-11-09", 2, false],
      ["2026-11-11", 4, false],
      ["2026-11-13", 6, false],
      ["2026-11-20", 13, false],
    ]);
    expect(answer.summary[3]).toMatchObject({
      straddle: 14.925,
      implied_move_pct: 4.35932,
    });
    expect(answer.summary[0]).toMatchObject({
      straddle: null,
      call_iv: 21.9246,
    });
    expect(answer).not.toContainKey("next");
    expect(JSON.stringify(answer)).not.toContain(CRUMB);
    // the listing is the nearest chain: one call for it, one per other row
    expect(t.dates()).toEqual([
      "listed",
      "1794355200",
      "1794528000",
      "1795132800",
    ]);
    expect(await t.tool("AAPL")).toEqual(answer);
    expect(t.dates()).toHaveLength(4);
    // a quote period on, asked again
    await t.clock.advance(5 * MINUTE_MS);
    await t.tool("AAPL");
    expect(t.dates()).toHaveLength(8);
  });

  test("adds the earnings expiry past the nearest four, and marks one among them", async () => {
    const after = await setup();
    after.earnings("2026-11-20", "amc");
    const rows = (await after.tool("AAPL")).summary;
    expect(rows.map((r: any) => r.expiry)).toEqual([
      "2026-11-09",
      "2026-11-11",
      "2026-11-13",
      "2026-11-20",
      "2026-11-27",
    ]);
    expect(rows.map((r: any) => r.earnings)).toEqual([
      false,
      false,
      false,
      false,
      true,
    ]);
    expect(after.dates()).toHaveLength(5);
    const before = await setup();
    before.earnings("2026-11-20", "bmo");
    const marked = (await before.tool("AAPL")).summary;
    expect(marked.map((r: any) => r.earnings)).toEqual([
      false,
      false,
      false,
      true,
    ]);
  });

  test("a past event awaiting results or one reported today never hides the next", async () => {
    const marked = async (
      first: (t: Awaited<ReturnType<typeof setup>>) => void,
    ) => {
      const t = await setup();
      first(t);
      t.earnings("2026-11-12", "amc", 2);
      return (await t.tool("AAPL")).summary
        .filter((r: any) => r.earnings)
        .map((r: any) => r.expiry);
    };
    expect(await marked((t) => t.earnings("2026-11-03", "amc"))).toEqual([
      "2026-11-13",
    ]);
    expect(
      await marked((t) => t.earnings("2026-11-07", "bmo", 1, t.clock.now())),
    ).toEqual(["2026-11-13"]);
  });

  test("skips an expiry on the market's date", async () => {
    const t = await setup({ at: Date.parse("2026-11-09T15:00:00Z") });
    const rows = (await t.tool("AAPL")).summary;
    expect(rows.map((r: any) => [r.expiry, r.days])).toEqual([
      ["2026-11-11", 2],
      ["2026-11-13", 4],
      ["2026-11-20", 11],
      ["2026-11-27", 18],
    ]);
  });

  test("an expiry not answered in time is its row's timeout, the rest standing", async () => {
    const held = gate();
    const t = await setup({
      hold: (url) =>
        url.searchParams.get("date") === "1794528000" ? held.hold() : undefined,
    });
    const call = t.ask({ symbol: "AAPL", section: "options" });
    await held.arrived;
    // the other rows land before the deadline passes
    for (
      let k = 0;
      k < 1000 && !t.m.options.has("US:AAPL:1795132800000");
      k++
    ) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    await t.clock.advance(t.m.callMs);
    const rows = body(await call).summary;
    expect(rows[2]).toMatchObject({ expiry: "2026-11-13", error: "timeout" });
    expect(rows[2]).not.toContainKey("straddle");
    expect(rows[3]).toMatchObject({ expiry: "2026-11-20", straddle: 14.925 });
    held.release();
  });

  test("one expiry answers its chain near the money", async () => {
    const t = await setup();
    const answer = await t.tool("AAPL", { expiry: "2026-11-20" });
    expect(answer).toMatchObject({
      price: 342.37,
      expiry: "2026-11-20",
      days: 13,
      band_pct: CHAIN_BAND,
    });
    expect(Object.keys(answer).at(-1)).toBe("strikes");
    expect(answer.strikes).toHaveLength(24);
    expect(answer.strikes[0].strike).toBe(310);
    expect(answer.strikes.at(-1).strike).toBe(375);
    expect(answer.strikes.find((s: any) => s.strike === 342.5)).toEqual({
      strike: 342.5,
      call: {
        bid: 7.4,
        ask: 7.65,
        mid: 7.525,
        last: expect.any(Number),
        last_trade_at: expect.stringMatching(/^2026-11-0\dT/),
        volume: expect.any(Number),
        open_interest: expect.any(Number),
        iv: 28.8337,
        in_the_money: false,
      },
      put: expect.objectContaining({
        mid: 7.4,
        iv: 27.7961,
        in_the_money: true,
      }),
    });
    expect(t.dates()).toEqual(["listed", "1795132800"]);
    // the nearest is the listing's own chain, cached
    await t.tool("AAPL", { expiry: "2026-11-09" });
    expect(t.dates()).toEqual(["listed", "1795132800"]);
  });

  test("a chain too long for a page narrows its band, never cuts a strike's sides", async () => {
    const t = await setup({
      hold: async (url) => {
        if (optionsSymbol(url) !== "SPY") return undefined;
        const fx = clone(await recorded("options-spy"));
        const chain = fx.body.optionChain.result[0].options[0];
        const like = (c: any, strike: number) => ({ ...c, strike });
        for (const side of ["calls", "puts"]) {
          const base = chain[side][0];
          chain[side] = [];
          for (let s = 660; s <= 810; s += 0.5) chain[side].push(like(base, s));
        }
        return fx;
      },
    });
    const answer = await t.tool("SPY", { expiry: "2026-11-09" });
    expect(answer.band_pct).toBeLessThan(CHAIN_BAND);
    expect(answer.band_pct).toBeGreaterThan(0);
    const off = answer.strikes.map((s: any) => Math.abs(s.strike - 735.29));
    expect(Math.max(...off)).toBeLessThanOrEqual(
      (answer.band_pct / 100) * 735.29 + 0.5,
    );
    for (const s of answer.strikes) {
      expect(s.call).not.toBeNull();
      expect(s.put).not.toBeNull();
    }
  });

  test("refuses expiry and since where they do not belong", async () => {
    const t = await setup();
    await expect(
      t.ask({ symbol: "AAPL", section: "options", expiry: "2026-11-21" }),
    ).rejects.toThrow(
      "expiry 2026-11-21 is not listed; the nearest 3 listed: 2026-11-13, 2026-11-20, 2026-11-27",
    );
    await expect(
      t.ask({ symbol: "AAPL", expiry: "2026-11-20" }),
    ).rejects.toThrow("expiry is for the options section only");
    await expect(
      t.ask({ symbol: "AAPL", section: "options", since: "2026-11-01" }),
    ).rejects.toThrow("since is for the news and positioning sections only");
    await expect(
      t.ask({ symbol: "AAPL", section: "options", next: "x" }),
    ).rejects.toThrow("options has no next page");
    expect(() =>
      parseResearch({ symbol: "AAPL", section: "options", expiry: "20261120" }),
    ).toThrow("expiry must be a date");
  });

  test("another source's instrument has none, and a listing without options says so", async () => {
    const t = await setup();
    expect(await t.tool("FRED:DGS10")).toMatchObject({
      id: "FRED:DGS10",
      source: "yahoo",
      message: NOT_OPTIONABLE,
    });
    expect(t.dates()).toEqual([]);
    const vwce = await t.tool("VWCE.DE");
    expect(vwce).toMatchObject({ source: "yahoo", message: NO_OPTIONS });
    expect(vwce).not.toContainKey("summary");
    expect(await t.tool("VWCE.DE", { expiry: "2026-11-20" })).toMatchObject({
      message: NO_OPTIONS,
    });
  });

  test("the overview never asks for options", async () => {
    const t = await setup();
    const overview = body(await t.ask({ symbol: "AAPL" }));
    expect(overview).not.toContainKey("options");
    expect(t.dates()).toEqual([]);
  });

  test("the research route answers the summary for one symbol only", async () => {
    const t = await setup();
    const two = await t.rest("research?symbols=AAPL,SPY&sections=options");
    expect(two.status).toBe(400);
    expect(two.body.detail).toBe("options is for one symbol per call");
    expect(t.dates()).toEqual([]);
    const plain = await t.rest("research?symbols=AAPL");
    expect(plain.body.research[0]).not.toContainKey("options");
    const one = await t.rest("research?symbols=AAPL&sections=options");
    expect(one.status).toBe(200);
    const schema = answerSchema(spec, "GET", "/research", 200)!;
    expect(validate(one.body, schema, spec)).toEqual([]);
    expect(Object.keys(one.body.research[0])).toEqual([
      "input",
      "id",
      "options",
    ]);
    const {
      id: _,
      name: __,
      type: ___,
      currency: ____,
      section: _____,
      ...tool
    } = await t.tool("AAPL");
    expect(one.body.research[0].options).toEqual({ ...tool, currency: "USD" });
    expect(t.dates()).toHaveLength(4);
  });
});
