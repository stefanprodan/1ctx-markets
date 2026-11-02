// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { PREFIX } from "../src/api/http.ts";
import { spec } from "../src/api/openapi.ts";
import { recordSession, session } from "../src/market/calendars.ts";
import { round } from "../src/market/format.ts";
import type { Markets } from "../src/operations/markets.ts";
import { parseQuote, quotePage } from "../src/operations/quote.ts";
import { fillReturns, signalsAfterBars } from "../src/signals/store.ts";
import { FUND_SOURCE } from "../src/sources/ids.ts";
import type { Db } from "../src/storage/db/index.ts";
import { api } from "./helpers/api.ts";
import { answerSchema, validate } from "./helpers/schema.ts";
import {
  bar,
  FINAL,
  instrument,
  LIVE,
  NOW,
  quote,
  row,
  type Values,
  world,
} from "./helpers/world.ts";

async function ask(m: Markets, symbol: string) {
  const page = JSON.parse(
    await quotePage(m, parseQuote({ symbols: [symbol] })),
  );
  return page.items[0].returns;
}

function stored(db: Db, id: string) {
  return db
    .query<
      {
        kind: string;
        date: string;
        return_1m: number | null;
        return_1y: number | null;
      },
      [string]
    >(
      `select kind, date, return_1m, return_1y from signals
       where instrument = ? and interval = '1d'
         and (return_1m is not null or return_1y is not null)
       order by kind desc, date desc`,
    )
    .all(id);
}

// a session of the day NOW falls on, 14:00 to 20:00 UTC
function open(db: Db, market: string) {
  recordSession(
    db,
    market,
    session(
      "UTC",
      Date.parse(`${LIVE}T14:00:00Z`),
      Date.parse(`${LIVE}T20:00:00Z`),
    ),
    NOW,
  );
}

describe("the stored returns", () => {
  function shares() {
    const w = world();
    instrument(w.db, "XX:A");
    for (const [date, close] of [
      ["2025-10-20", 40],
      ["2025-12-30", 50],
      ["2026-09-23", 100],
      ["2026-10-22", 110],
    ] as const) {
      bar(w.db, "XX:A", "1d", date, close, true);
    }
    quote(w.db, "XX:A", 121, 110);
    open(w.db, "XX");
    w.db.query("update instruments set last_read_at = ?").run(NOW);
    return w;
  }

  test("equal the quote tool's, on the live row", async () => {
    const w = shares();
    signalsAfterBars(w.db, { id: "XX:A", market: "XX" }, null, NOW);
    const r = await ask(w.m, "XX:A");
    expect(r.live).toBe(true);
    const rows = stored(w.db, "XX:A");
    // the last final row keeps the ones its recompute stored
    expect(rows.map((s) => [s.kind, s.date])).toEqual([
      ["live", LIVE],
      ["final", "2026-10-22"],
    ]);
    const s = rows[0];
    expect([round(s!.return_1m), round(s!.return_1y)]).toEqual([
      r["1m"],
      r["1y"],
    ]);
    expect(r["1y"]).toBe(round(202.5));
  });

  test("move to the last final row once the day is final", async () => {
    const w = shares();
    signalsAfterBars(w.db, { id: "XX:A", market: "XX" }, null, NOW);
    bar(w.db, "XX:A", "1d", LIVE, 121, true);
    signalsAfterBars(w.db, { id: "XX:A", market: "XX" }, LIVE, NOW);
    const r = await ask(w.m, "XX:A");
    expect(r.live).toBe(false);
    const rows = stored(w.db, "XX:A");
    expect(rows.map((s) => s.kind)).toEqual(["final"]);
    expect([round(rows[0]!.return_1m), round(rows[0]!.return_1y)]).toEqual([
      r["1m"],
      r["1y"],
    ]);
  });

  test("of a yield are points, as the quote tool's", async () => {
    const w = world();
    instrument(w.db, "FRED:DGS10");
    for (const [date, close] of [
      ["2025-10-20", 3.5],
      ["2026-09-22", 4.4],
      ["2026-10-22", 4.6],
    ] as const) {
      bar(w.db, "FRED:DGS10", "1d", date, close, true);
    }
    w.db.query("update instruments set last_read_at = ?").run(NOW);
    signalsAfterBars(w.db, { id: "FRED:DGS10", market: "FRED" }, null, NOW);
    const r = await ask(w.m, "FRED:DGS10");
    const [s] = stored(w.db, "FRED:DGS10");
    expect([round(s!.return_1m), round(s!.return_1y)]).toEqual([
      r["1m"],
      r["1y"],
    ]);
    expect(s!.return_1y).toBeCloseTo(1.1, 6);
  });

  test("leave 1Y null for a listing younger than a year", async () => {
    const w = world();
    instrument(w.db, "XX:NEW");
    for (const [date, close] of [
      ["2026-09-01", 20],
      ["2026-10-22", 25],
    ] as const) {
      bar(w.db, "XX:NEW", "1d", date, close, true);
    }
    w.db.query("update instruments set last_read_at = ?").run(NOW);
    signalsAfterBars(w.db, { id: "XX:NEW", market: "XX" }, null, NOW);
    const [s] = stored(w.db, "XX:NEW");
    expect(s!.return_1m).toBeCloseTo(25, 6);
    expect(s!.return_1y).toBeNull();
    expect((await ask(w.m, "XX:NEW"))["1y"]).toBeNull();
  });

  test("are filled at start where a row has none", async () => {
    const w = shares();
    signalsAfterBars(w.db, { id: "XX:A", market: "XX" }, null, NOW);
    w.db.query("update signals set return_1m = null, return_1y = null").run();
    fillReturns(w.db);
    const r = await ask(w.m, "XX:A");
    const [s] = stored(w.db, "XX:A");
    expect(round(s!.return_1y)).toBe(r["1y"]);
  });
});

type Item = {
  type?: string;
  // the day's move in percent; null for no quote
  change?: number | null;
  daily?: Values;
  tracked?: boolean;
  live?: boolean;
};

function put(db: Db, id: string, o: Item = {}) {
  instrument(db, id);
  if (o.type !== undefined) {
    db.query("update instruments set type = ? where id = ?").run(o.type, id);
  }
  if (o.tracked !== false) {
    db.query("update instruments set last_read_at = ? where id = ?").run(
      NOW,
      id,
    );
  }
  bar(db, id, "1d", FINAL, 100, true);
  const values = { sma50: null, sma200: null, ...o.daily };
  row(db, id, "1d", FINAL, "final", o.live === false ? values : {});
  if (o.live !== false) row(db, id, "1d", LIVE, "live", values);
  if (o.change !== null) quote(db, id, 100 + (o.change ?? 0), 100);
}

function client(m: Markets) {
  const handle = api(m);
  return async (query = "") => {
    const res = await handle(
      new Request(`http://markets.test${PREFIX}/screener${query}`),
    );
    return { status: res.status, body: (await res.json()) as any };
  };
}

const ids = (body: any): string[] => body.instruments.map((r: any) => r.id);

describe("the screener", () => {
  function many() {
    const w = world();
    put(w.db, "US:UP", { change: 4, daily: { drawdown: -1, rsi14: 72 } });
    put(w.db, "US:DOWN", { change: -6, daily: { drawdown: -25, rsi14: 25 } });
    put(w.db, "US:FLAT", { change: 0.5, daily: { drawdown: -10, rsi14: 50 } });
    put(w.db, "US:HIGH", { change: 1, daily: { drawdown: 0, rsi14: 80 } });
    put(w.db, "US:LOW", { change: -2, daily: { drawdown: -40, rsi14: 10 } });
    put(w.db, "CCY:EURUSD=X", {
      type: "CURRENCY",
      change: 0.2,
      daily: { drawdown: -2, rsi14: 90 },
    });
    put(w.db, "US:ETF", {
      type: "ETF",
      change: 3,
      daily: { drawdown: -22, rsi14: 28 },
    });
    // a series is in moves only, however its figures read
    put(w.db, "FRED:DGS10", {
      type: "SERIES",
      change: null,
      daily: { drawdown: 0, rsi14: 95 },
    });
    put(w.db, "US:GONE", {
      change: 9,
      daily: { drawdown: 0, rsi14: 99 },
      tracked: false,
    });
    return w;
  }

  test("answers each screen's rows in its order, as the spec says", async () => {
    const w = many();
    const get = client(w.m);
    const moves = await get();
    expect(moves.status).toBe(200);
    expect(ids(moves.body)).toEqual([
      "US:DOWN",
      "US:UP",
      "US:ETF",
      "US:LOW",
      "US:HIGH",
      "US:FLAT",
      "CCY:EURUSD=X",
      "FRED:DGS10",
    ]);
    const schema = answerSchema(spec, "GET", "/screener", 200)!;
    expect(validate(moves.body, schema, spec)).toEqual([]);
    expect(moves.body.sort).toEqual({ field: "move", order: "desc" });
    expect(ids((await get("?screen=near_high")).body)).toEqual([
      "US:HIGH",
      "US:UP",
      "CCY:EURUSD=X",
    ]);
    expect(ids((await get("?screen=off_high")).body)).toEqual([
      "US:LOW",
      "US:DOWN",
      "US:ETF",
    ]);
    expect(ids((await get("?screen=oversold")).body)).toEqual([
      "US:LOW",
      "US:DOWN",
      "US:ETF",
    ]);
    expect(ids((await get("?screen=overbought")).body)).toEqual([
      "US:HIGH",
      "US:UP",
    ]);
  });

  test("counts every screen and kind of what is kept up to date", async () => {
    const w = many();
    const get = client(w.m);
    const all = (await get()).body;
    expect(all.counts).toEqual({
      moves: 8,
      near_high: 3,
      off_high: 3,
      oversold: 3,
      overbought: 2,
    });
    expect(all.kinds).toEqual([
      { kind: "CURRENCY", count: 1 },
      { kind: "EQUITY", count: 5 },
      { kind: "ETF", count: 1 },
      { kind: "SERIES", count: 1 },
    ]);
    const etf = (await get("?type=ETF,CURRENCY&screen=off_high")).body;
    expect(ids(etf)).toEqual(["US:ETF"]);
    expect(etf.type).toEqual(["ETF", "CURRENCY"]);
    expect(etf.counts).toEqual({
      moves: 2,
      near_high: 1,
      off_high: 1,
      oversold: 1,
      overbought: 0,
    });
    // the tabs stay whatever the type
    expect(etf.kinds).toEqual(all.kinds);
  });

  test("leaves out a fund the owner prices, though a dashboard holds it", async () => {
    const w = world();
    put(w.db, "US:A");
    put(w.db, "OWN:FUND");
    w.db
      .query("update instruments set source = ? where id = 'OWN:FUND'")
      .run(FUND_SOURCE);
    w.db.exec(`
      insert into dashboards (owner, revision, updated_at) values ('operator', 1, 0);
      insert into dashboard_sections (owner, position, name, view)
        values ('operator', 0, 'A', 'cards');
      insert into dashboard_items (owner, section, position, instrument)
        values ('operator', 0, 0, 'OWN:FUND');
    `);
    const body = (await client(w.m)()).body;
    expect(ids(body)).toEqual(["US:A"]);
    expect(body.counts.moves).toBe(1);
  });

  test("reads the last final row where no live one is", async () => {
    const w = world();
    put(w.db, "US:A", { live: false, daily: { drawdown: -30 } });
    const body = (await client(w.m)("?screen=off_high")).body;
    expect(ids(body)).toEqual(["US:A"]);
    expect(body.instruments[0].drawdown).toBe(-30);
  });

  test("sorts on a field, rows without it last either way, ties by ticker", async () => {
    const w = world();
    put(w.db, "US:B", { daily: { return_1y: 5 } });
    put(w.db, "US:A", { daily: { return_1y: 5 } });
    put(w.db, "US:C", { daily: { return_1y: -5 } });
    put(w.db, "US:N");
    const get = client(w.m);
    expect(ids((await get("?sort=return_1y")).body)).toEqual([
      "US:A",
      "US:B",
      "US:C",
      "US:N",
    ]);
    expect(ids((await get("?sort=return_1y&order=asc")).body)).toEqual([
      "US:C",
      "US:A",
      "US:B",
      "US:N",
    ]);
    expect(ids((await get("?sort=symbol")).body)).toEqual([
      "US:A",
      "US:B",
      "US:C",
      "US:N",
    ]);
  });

  test("says the trend from the cross and the 200-day", async () => {
    const w = world();
    // the price is 100 in each
    put(w.db, "US:UP", { daily: { sma50: 95, sma200: 90 } });
    put(w.db, "US:DOWN", { daily: { sma50: 105, sma200: 110 } });
    put(w.db, "US:MIX", { daily: { sma50: 115, sma200: 110 } });
    put(w.db, "US:NONE");
    const body = (await client(w.m)("?sort=trend")).body;
    expect(
      body.instruments.map((r: any) => [r.id, r.trend, r.distance_sma200]),
    ).toEqual([
      ["US:UP", "up", round((100 / 90 - 1) * 100)],
      ["US:MIX", "mixed", round((100 / 110 - 1) * 100)],
      ["US:DOWN", "down", round((100 / 110 - 1) * 100)],
      ["US:NONE", null, null],
    ]);
  });

  test("pages with a token bound to its arguments", async () => {
    const w = many();
    const get = client(w.m);
    const first = (await get("?page_size=3")).body;
    expect(ids(first)).toEqual(["US:DOWN", "US:UP", "US:ETF"]);
    const token = encodeURIComponent(first.next_page_token);
    const second = (await get(`?page_size=3&page_token=${token}`)).body;
    expect(ids(second)).toEqual(["US:LOW", "US:HIGH", "US:FLAT"]);
    const third = (
      await get(
        `?page_size=3&page_token=${encodeURIComponent(second.next_page_token)}`,
      )
    ).body;
    expect(ids(third)).toEqual(["CCY:EURUSD=X", "FRED:DGS10"]);
    expect(third.next_page_token).toBeUndefined();
    const other = await get(`?screen=oversold&page_token=${token}`);
    expect(other.status).toBe(400);
  });

  test("refuses arguments it does not take", async () => {
    const w = many();
    const get = client(w.m);
    for (const q of [
      "?screen=cheap",
      "?sort=price",
      "?order=asc",
      "?type=equity",
      "?page_size=0",
      "?query=a",
    ]) {
      expect([q, (await get(q)).status]).toEqual([q, 400]);
    }
  });

  test("fetches nothing and counts as no read", async () => {
    // the world's sources throw on any call, so an answer means none ran
    const w = many();
    const reads = () =>
      w.db.query("select id, last_read_at from instruments order by id").all();
    const before = reads();
    expect((await client(w.m)()).status).toBe(200);
    expect(reads()).toEqual(before);
  });
});
