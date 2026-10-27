// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { DAY_MS, MINUTE_MS } from "../src/clock.ts";
import { cursor, PAGE_BYTES } from "../src/tools/answer.ts";
import { ArgError } from "../src/tools/args.ts";
import { quotesHandler } from "../src/tools/http.ts";
import { moversAnswer, parseMovers } from "../src/tools/movers.ts";
import { parseScreen, screenAnswer } from "../src/tools/screen.ts";
import type { Markets } from "../src/tools/targets.ts";
import { lastReadAt } from "../src/tracking.ts";
import {
  bar,
  FINAL,
  instrument,
  LIVE,
  listing,
  NOW,
  quote,
  row,
  world,
} from "./helpers/world.ts";

async function screen(m: Markets, args: unknown) {
  const r = await screenAnswer(m, parseScreen(args));
  return { isError: r.isError === true, body: JSON.parse(r.content[0]!.text) };
}

async function movers(m: Markets, args: unknown) {
  const r = await moversAnswer(m, parseMovers(args));
  return { isError: r.isError === true, body: JSON.parse(r.content[0]!.text) };
}

const ids = (body: any) =>
  body.items.filter((i: any) => i.status === "matched").map((i: any) => i.id);

describe("screen arguments", () => {
  const refused: [unknown, string][] = [
    [{ symbols: ["A"] }, "give filters, a sort or both"],
    [
      { symbols: ["A"], filters: [{ field: "rsi", max: 3 }] },
      "filters[0].field must be one of",
    ],
    [
      { symbols: ["A"], filters: [{ field: "rsi14" }] },
      "needs min, max or both",
    ],
    [
      { symbols: ["A"], filters: [{ field: "rsi14", min: 5, max: 4 }] },
      "min is above its max",
    ],
    [
      { symbols: ["A"], filters: [{ field: "rsi14", eq: 1 }] },
      "unknown key eq",
    ],
    [
      { symbols: ["A"], filters: [{ field: "cross", min: 0 }] },
      "a state, filtered with eq only",
    ],
    [
      { symbols: ["A"], filters: [{ field: "cross", eq: 2 }] },
      "eq must be -1, 0 or 1",
    ],
    [
      { symbols: ["A"], filters: [{ field: "rsi14", max: "40" }] },
      "max must be a number",
    ],
    [
      { symbols: ["A"], filters: Array(9).fill({ field: "rsi14", max: 1 }) },
      "at most 8",
    ],
    [{ symbols: ["A"], filters: [], order: "desc" }, "give filters"],
    [
      { symbols: ["A"], filters: [{ field: "rsi14", max: 1 }], order: "desc" },
      "order needs sort",
    ],
    [
      { symbols: ["A"], sort: "rsi14", order: "down" },
      "order must be one of asc, desc",
    ],
    [{ symbols: ["A"], sort: "relative_return_1m" }, "need a benchmark"],
    [
      { symbols: ["A"], sort: "rsi14", benchmark: "B" },
      "read only by relative_return",
    ],
    [{ symbols: ["A"], sort: "rsi14", limit: 5 }, "unknown argument limit"],
    [
      { symbols: ["A"], sort: "rsi14", fields: Array(9).fill("drawdown") },
      "fields must be a list of at most 8",
    ],
    [
      { symbols: ["A"], sort: "rsi14", fields: ["rsi"] },
      "fields[0] must be one of",
    ],
    [
      { symbols: ["A"], sort: "rsi14", fields: ["relative_return_1m"] },
      "need a benchmark",
    ],
    [{ symbols: ["A"], sort: "constructor" }, "sort must be one of"],
    [{ symbols: ["A"], sort: "__proto__" }, "sort must be one of"],
    [
      { symbols: ["A"], filters: [{ field: "toString", max: 1 }] },
      "must be one of",
    ],
  ];
  test("are refused with the argument and why", () => {
    for (const [args, message] of refused) {
      expect(() => parseScreen(args)).toThrow(ArgError);
      expect(() => parseScreen(args)).toThrow(message);
    }
  });
});

describe("screen", () => {
  function three() {
    const w = world();
    listing(w.db, "XX:A", { live: { rsi14: 30, drawdown: -20 } });
    listing(w.db, "XX:B", { live: { rsi14: 40, drawdown: -5 } });
    listing(w.db, "XX:C", { live: { rsi14: 50, drawdown: -15 } });
    return w;
  }
  const all = ["XX:C", "XX:A", "XX:B"];

  test("a range filter holds both bounds inclusive, either alone", async () => {
    const { m } = three();
    const cases: [object, string[]][] = [
      [{ field: "rsi14", max: 40 }, ["XX:A", "XX:B"]],
      [{ field: "rsi14", min: 40 }, ["XX:B", "XX:C"]],
      [{ field: "rsi14", min: 40, max: 40 }, ["XX:B"]],
      [{ field: "rsi14", min: 30.5, max: 39.5 }, []],
    ];
    for (const [filter, want] of cases) {
      const a = await screen(m, { symbols: all, filters: [filter] });
      expect(ids(a.body)).toEqual(want);
      expect(a.body.counts).toEqual({
        matched: want.length,
        not_matched: 3 - want.length,
        unavailable: 0,
        errors: 0,
      });
    }
  });

  test("filters are ANDed and each item shows the fields it used", async () => {
    const { m } = three();
    const a = await screen(m, {
      symbols: all,
      filters: [
        { field: "rsi14", max: 45 },
        { field: "drawdown", max: -10 },
      ],
    });
    expect(ids(a.body)).toEqual(["XX:A"]);
    const [item] = a.body.items;
    expect(item).toMatchObject({
      input: "XX:A",
      status: "matched",
      currency: "USD",
      kind: "market_quote",
      price: 100,
    });
    expect(item.fields).toEqual({
      rsi14: { value: 30, unit: "0 to 100", kind: "live", date: LIVE },
      drawdown: { value: -20, unit: "percent", kind: "live", date: LIVE },
    });
  });

  test("fields are shown on every row beside the filter fields", async () => {
    const w = three();
    // C has a week of history: its 1-week return ends on its last close
    bar(w.db, "XX:C", "1d", "2026-10-15", 80, true);
    row(w.db, "XX:C", "1d", "2026-10-15", "final");
    const a = await screen(w.m, {
      symbols: all,
      filters: [{ field: "rsi14", max: 45 }],
      fields: ["drawdown", "return_1w", "rsi14"],
    });
    expect(ids(a.body)).toEqual(["XX:A", "XX:B"]);
    expect(Object.keys(a.body.items[0].fields)).toEqual([
      "rsi14",
      "drawdown",
      "return_1w",
    ]);
    expect(a.body.items[0].fields.drawdown).toMatchObject({ value: -20 });
    // A's bars do not reach a week back
    expect(a.body.items[0].fields.return_1w).toBeNull();
    const c = await screen(w.m, {
      symbols: all,
      filters: [{ field: "return_1w", min: 0 }],
    });
    expect(ids(c.body)).toEqual(["XX:C"]);
    expect(c.body.items[0].fields.return_1w).toEqual({
      value: 25,
      unit: "percent",
      kind: "final",
      date: FINAL,
    });
  });

  test("a state field matches by eq", async () => {
    const w = world();
    listing(w.db, "XX:A", { live: { sma50: 110, sma200: 100 } });
    listing(w.db, "XX:B", { live: { sma50: 90, sma200: 100, cross_edge: -1 } });
    listing(w.db, "XX:C", { live: { sma50: 100, sma200: 100 } });
    const names = ["XX:A", "XX:B", "XX:C"];
    for (const [eq, want] of [
      [1, ["XX:A"]],
      [-1, ["XX:B"]],
      [0, ["XX:C"]],
    ] as const) {
      const a = await screen(w.m, {
        symbols: names,
        filters: [{ field: "cross", eq }],
      });
      expect(ids(a.body)).toEqual([...want]);
    }
    const edge = await screen(w.m, {
      symbols: names,
      filters: [{ field: "cross_edge", eq: -1 }],
    });
    expect(ids(edge.body)).toEqual(["XX:B"]);
    // a null edge is a missing input, never a 0
    expect(edge.body.counts).toMatchObject({ matched: 1, unavailable: 2 });
  });

  test("sorts by a field either way, ties and no sort by id", async () => {
    const w = three();
    listing(w.db, "XX:D", { live: { rsi14: 40, drawdown: -1 } });
    const names = [...all, "XX:D"];
    const desc = await screen(w.m, {
      symbols: names,
      sort: "rsi14",
      order: "desc",
    });
    expect(ids(desc.body)).toEqual(["XX:C", "XX:B", "XX:D", "XX:A"]);
    expect(desc.body.sort).toEqual({ field: "rsi14", order: "desc" });
    const asc = await screen(w.m, { symbols: names, sort: "rsi14" });
    expect(ids(asc.body)).toEqual(["XX:A", "XX:B", "XX:D", "XX:C"]);
    const none = await screen(w.m, {
      symbols: names,
      filters: [{ field: "rsi14", min: 0 }],
    });
    expect(ids(none.body)).toEqual(["XX:A", "XX:B", "XX:C", "XX:D"]);
    expect(none.body.sort).toEqual({ field: "id", order: "asc" });
  });

  test("distances are the price's signed percent from each average", async () => {
    const w = world();
    listing(w.db, "XX:A", {
      price: 110,
      live: { sma50: 100, sma200: 125, ema20: 88, bollinger_lower: 55 },
    });
    bar(w.db, "XX:A", "1wk", "2026-10-12", 104, true);
    row(w.db, "XX:A", "1wk", "2026-10-12", "final", { sma50: 1, sma200: 2 });
    bar(w.db, "XX:A", "1wk", "2026-10-19", 110, false);
    row(w.db, "XX:A", "1wk", "2026-10-19", "live", { sma50: 80, sma200: 200 });
    const a = await screen(w.m, {
      symbols: ["XX:A"],
      filters: [
        { field: "distance_sma50", min: 9.99, max: 10.01 },
        { field: "distance_sma200", max: 0 },
        { field: "distance_ema20", min: 0 },
        { field: "distance_weekly_sma50", min: 0 },
        { field: "distance_weekly_sma200", max: 0 },
        { field: "distance_bollinger_lower", min: 0 },
      ],
    });
    const f = a.body.items[0].fields;
    // 100 (110 / avg - 1)
    expect(f.distance_sma50.value).toBeCloseTo(10, 6);
    expect(f.distance_sma200.value).toBeCloseTo(-12, 6);
    expect(f.distance_ema20.value).toBeCloseTo(25, 6);
    expect(f.distance_bollinger_lower.value).toBeCloseTo(100, 6);
    expect(f.distance_weekly_sma50).toEqual({
      value: 37.5,
      unit: "percent",
      kind: "live",
      date: "2026-10-19",
    });
    expect(f.distance_weekly_sma200.value).toBeCloseTo(-45, 6);
    expect(f.distance_sma50).toMatchObject({ kind: "live", date: LIVE });
  });

  test("a final row answers when there is no live one, stated per field", async () => {
    const w = world();
    instrument(w.db, "XX:A");
    bar(w.db, "XX:A", "1d", FINAL, 100, true);
    row(w.db, "XX:A", "1d", FINAL, "final", { rsi14: 33 });
    quote(w.db, "XX:A", 100, 98);
    const a = await screen(w.m, {
      symbols: ["XX:A"],
      filters: [{ field: "rsi14", max: 40 }],
    });
    expect(a.body.items[0].fields.rsi14).toMatchObject({
      value: 33,
      kind: "final",
      date: FINAL,
    });
  });

  describe("relative return", () => {
    // 1m: A +10%, B +5%; 3m: A 80 to 110 is +37.5%, B +5%
    function pair() {
      const w = world();
      const closes: Record<string, [string, number][]> = {
        "XX:A": [
          ["2026-07-23", 80],
          ["2026-09-23", 100],
          ["2026-10-23", 110],
        ],
        "XX:B": [
          ["2026-07-23", 200],
          ["2026-09-23", 200],
          ["2026-10-23", 210],
        ],
      };
      for (const [id, rows] of Object.entries(closes)) {
        instrument(w.db, id);
        for (const [date, close] of rows) {
          bar(w.db, id, "1d", date, close, true);
          row(w.db, id, "1d", date, "final", { rsi14: 50 });
        }
        quote(w.db, id, rows.at(-1)![1], rows.at(-2)![1]);
      }
      return w;
    }

    test("filters in percentage points against the named benchmark", async () => {
      const w = pair();
      const a = await screen(w.m, {
        symbols: ["XX:A"],
        benchmark: "XX:B",
        filters: [
          { field: "relative_return_1m", min: 4.99, max: 5.01 },
          { field: "relative_return_3m", min: 32 },
        ],
      });
      expect(a.body.benchmark).toMatchObject({ id: "XX:B", currency: "USD" });
      const f = a.body.items[0].fields;
      expect(f.relative_return_1m.value).toBeCloseTo(5, 6);
      expect(f.relative_return_3m.value).toBeCloseTo(32.5, 6);
      expect(f.relative_return_1m).toMatchObject({
        unit: "percentage points",
        kind: "final",
        date: "2026-10-23",
      });
      expect(f.relative_return_1m.note).toContain("FX conversion excluded");
      // the benchmark counts as read
      expect(lastReadAt(w.db, "XX:B")).toBe(NOW);
    });

    test("a stale benchmark makes them unavailable", async () => {
      const w = pair();
      w.db.query("delete from quotes where instrument = 'XX:B'").run();
      const a = await screen(w.m, {
        symbols: ["XX:A"],
        benchmark: "XX:B",
        filters: [{ field: "relative_return_1m", min: 0 }],
      });
      expect(a.body.items).toEqual([
        {
          input: "XX:A",
          id: "XX:A",
          status: "unavailable",
          missing: ["relative_return_1m"],
          stale: ["benchmark: no quote yet"],
        },
      ]);
    });

    test("a benchmark no source knows refuses the call", async () => {
      const w = pair();
      const a = await screen(w.m, {
        symbols: ["XX:A"],
        benchmark: "XX:NOPE",
        filters: [{ field: "relative_return_1m", min: 0 }],
      });
      expect(a.isError).toBe(true);
      expect(a.body.benchmark).toBe("XX:NOPE");
    });
  });

  test("a null or stale input makes a symbol unavailable, never a match", async () => {
    const w = world();
    listing(w.db, "XX:A", { live: { rsi14: 30 } });
    listing(w.db, "XX:NULL", { live: { rsi14: null } });
    listing(w.db, "XX:STALE", { live: { rsi14: 20 } });
    w.db.query("delete from quotes where instrument = 'XX:STALE'").run();
    const a = await screen(w.m, {
      symbols: ["XX:STALE", "XX:NULL", "XX:A"],
      filters: [{ field: "rsi14", max: 100 }],
    });
    expect(a.body.counts).toEqual({
      matched: 1,
      not_matched: 0,
      unavailable: 2,
      errors: 0,
    });
    expect(a.body.items.slice(1)).toEqual([
      {
        input: "XX:NULL",
        id: "XX:NULL",
        status: "unavailable",
        missing: ["rsi14"],
        stale: [],
      },
      {
        input: "XX:STALE",
        id: "XX:STALE",
        status: "unavailable",
        missing: ["rsi14"],
        stale: ["no quote yet"],
      },
    ]);
  });

  test("price-level fields over mixed currencies or units are refused", async () => {
    const w = world();
    listing(w.db, "XX:A", { live: { rsi14: 30, atr14: 2 } });
    listing(w.db, "XX:B", { currency: "EUR", live: { rsi14: 30, atr14: 2 } });
    for (const field of ["atr14", "sma50", "macd", "weekly_sma200"]) {
      const a = await screen(w.m, { symbols: ["XX:A", "XX:B"], sort: field });
      expect(a.isError).toBe(true);
      expect(a.body.error).toBe("mixed_units");
      expect(a.body.groups).toEqual({
        "per_share USD": ["XX:A"],
        "per_share EUR": ["XX:B"],
      });
    }
    // a percent or a ratio compares across them
    const ok = await screen(w.m, { symbols: ["XX:A", "XX:B"], sort: "rsi14" });
    expect(ok.isError).toBe(false);
    expect(ids(ok.body)).toEqual(["XX:A", "XX:B"]);
    const one = await screen(w.m, { symbols: ["XX:A"], sort: "atr14" });
    expect(one.body.items[0].fields.atr14.unit).toBe("per_share USD");
  });

  test("a FRED series matches on its final rows and never on a distance", async () => {
    const w = world();
    instrument(w.db, "FRED:DGS10");
    bar(w.db, "FRED:DGS10", "1d", FINAL, 4.2, true);
    row(w.db, "FRED:DGS10", "1d", FINAL, "final", { rsi14: 61 });
    w.db.query("update instruments set last_read_at = ?").run(NOW);
    const a = await screen(w.m, {
      symbols: ["FRED:DGS10"],
      filters: [{ field: "rsi14", min: 60 }],
    });
    expect(a.body.items[0]).toMatchObject({
      id: "FRED:DGS10",
      kind: "observation",
      price: null,
      observation: { date: FINAL, value: 4.2 },
      fields: { rsi14: { value: 61, kind: "final", date: FINAL } },
    });
    expect(a.body.attribution).toBeString();
    const d = await screen(w.m, {
      symbols: ["FRED:DGS10"],
      filters: [{ field: "distance_sma50", min: -100 }],
    });
    expect(d.body.items[0]).toMatchObject({
      status: "unavailable",
      missing: ["distance_sma50"],
      reason: "a FRED series has no price to measure a distance from",
    });
    expect(d.body.attribution).toBeUndefined();
  });

  test("pages whole items under 32 KiB, counts on every page, and tracks all", async () => {
    const w = world();
    const names: string[] = [];
    const long = "Ünïcödé “Holdings” 日本株式会社 ✓ ".repeat(10);
    for (let k = 0; k < 100; k++) {
      const id = `XX:S${String(k).padStart(3, "0")}`;
      listing(w.db, id, { name: `${long}${k}`, live: { rsi14: k % 50 } });
      names.push(id);
    }
    const args = {
      symbols: names,
      filters: [{ field: "rsi14", max: 39 }],
      sort: "rsi14",
      order: "desc",
    };
    const seen: string[] = [];
    let next: string | null = null;
    let pages = 0;
    do {
      const r = await screenAnswer(
        w.m,
        parseScreen({ ...args, ...(next === null ? {} : { next }) }),
      );
      const text = r.content[0]!.text;
      expect(Buffer.byteLength(text)).toBeLessThan(PAGE_BYTES);
      const body = JSON.parse(text);
      expect(body.counts).toEqual({
        matched: 80,
        not_matched: 20,
        unavailable: 0,
        errors: 0,
      });
      seen.push(...body.items.map((i: any) => i.id));
      next = body.next;
      pages++;
      if (pages === 1) {
        await expect(
          screenAnswer(
            w.m,
            parseScreen({ ...args, order: "asc", next: next! }),
          ),
        ).rejects.toThrow("next does not continue");
      }
    } while (next !== null);
    expect(pages).toBeGreaterThan(1);
    expect(seen).toHaveLength(80);
    expect(new Set(seen).size).toBe(80);
    // rsi14 39 first: k = 39 and 89
    expect(seen.slice(0, 2)).toEqual(["XX:S039", "XX:S089"]);
    for (const id of names) expect(lastReadAt(w.db, id)).toBe(NOW);
  });
});

describe("movers arguments", () => {
  const refused: [unknown, string][] = [
    [{ symbols: ["A"] }, "give min_move_pct, an average"],
    [
      { symbols: ["A"], min_move_pct: -1 },
      "min_move_pct must be a number, 0 or more",
    ],
    [{ symbols: ["A"], min_move_pct: "2" }, "min_move_pct must be a number"],
    [
      {
        symbols: ["A"],
        direction: "up",
        average: "daily_sma50",
        relation: "above",
      },
      "direction needs min_move_pct",
    ],
    [
      { symbols: ["A"], min_move_pct: 1, direction: "sideways" },
      "direction must be one of up, down, either",
    ],
    [
      { symbols: ["A"], average: "daily_sma50" },
      "average and relation go together",
    ],
    [{ symbols: ["A"], relation: "above" }, "average and relation go together"],
    [
      { symbols: ["A"], average: "sma50", relation: "above" },
      "average must be one of",
    ],
    [
      { symbols: ["A"], average: "daily_sma50", relation: "near" },
      "relation must be one of",
    ],
  ];
  test("are refused with the argument and why", () => {
    for (const [args, message] of refused) {
      expect(() => parseMovers(args)).toThrow(message);
    }
  });
});

describe("movers", () => {
  function moves() {
    const w = world();
    listing(w.db, "XX:UP3", { price: 103, previousClose: 100 });
    listing(w.db, "XX:DN2", { price: 98, previousClose: 100 });
    listing(w.db, "XX:UP05", { price: 100.5, previousClose: 100 });
    listing(w.db, "XX:DN3", { price: 97, previousClose: 100 });
    return w;
  }
  const names = ["XX:UP05", "XX:DN2", "XX:UP3", "XX:DN3"];

  test("past a move in either direction, largest first, id breaking ties", async () => {
    const { m } = moves();
    const a = await movers(m, { symbols: names, min_move_pct: 2 });
    expect(ids(a.body)).toEqual(["XX:DN3", "XX:UP3", "XX:DN2"]);
    expect(a.body.counts).toEqual({
      matched: 3,
      not_matched: 1,
      unavailable: 0,
      errors: 0,
    });
    expect(a.body.items[1]).toMatchObject({
      id: "XX:UP3",
      price: 103,
      previous_close: 100,
      change: 3,
      change_percent: 3,
    });
  });

  test("up and down keep their side, the threshold inclusive", async () => {
    const { m } = moves();
    const up = await movers(m, {
      symbols: names,
      min_move_pct: 0,
      direction: "up",
    });
    expect(ids(up.body)).toEqual(["XX:UP3", "XX:UP05"]);
    const down = await movers(m, {
      symbols: names,
      min_move_pct: 2,
      direction: "down",
    });
    expect(ids(down.body)).toEqual(["XX:DN3", "XX:DN2"]);
    const none = await movers(m, { symbols: names, min_move_pct: 3.01 });
    expect(ids(none.body)).toEqual([]);
  });

  describe("against an average", () => {
    function crossings() {
      const w = world();
      // final close 99 under its SMA 50 of 100; live 101 over 100.2
      listing(w.db, "XX:UPX", {
        previousClose: 99,
        price: 101,
        final: { sma50: 100 },
        live: { sma50: 100.2 },
      });
      // final close 101 over 100; live 99 under 100.1
      listing(w.db, "XX:DNX", {
        previousClose: 101,
        price: 99,
        final: { sma50: 100 },
        live: { sma50: 100.1 },
      });
      // above both times
      listing(w.db, "XX:OVER", {
        previousClose: 105,
        price: 106,
        final: { sma50: 100 },
        live: { sma50: 100.1 },
      });
      // final close on the average, live under it
      listing(w.db, "XX:ON", {
        previousClose: 100,
        price: 99.5,
        final: { sma50: 100 },
        live: { sma50: 100 },
      });
      return w;
    }
    const all = ["XX:UPX", "XX:DNX", "XX:OVER", "XX:ON"];
    const by = (m: Markets, relation: string) =>
      movers(m, { symbols: all, average: "daily_sma50", relation });

    test("above and below compare the live price with the average now", async () => {
      const { m } = crossings();
      expect(ids((await by(m, "above")).body)).toEqual(["XX:UPX", "XX:OVER"]);
      expect(ids((await by(m, "below")).body)).toEqual(["XX:DNX", "XX:ON"]);
    });

    test("crossed compares the last final close then and the live price now", async () => {
      const { m } = crossings();
      const up = await by(m, "crossed_up");
      expect(ids(up.body)).toEqual(["XX:UPX"]);
      expect(up.body.items[0].average).toEqual({
        name: "daily_sma50",
        value: 100.2,
        kind: "live",
        date: LIVE,
        distance_pct: expect.closeTo(100 * (101 / 100.2 - 1), 4),
        last_final: { date: FINAL, close: 99, value: 100 },
      });
      const down = await by(m, "crossed_down");
      expect(ids(down.body)).toEqual(["XX:DNX", "XX:ON"]);
    });

    test("weekly averages cross on the last final week", async () => {
      const w = world();
      listing(w.db, "XX:W", { previousClose: 99, price: 103 });
      bar(w.db, "XX:W", "1wk", "2026-10-12", 95, true);
      row(w.db, "XX:W", "1wk", "2026-10-12", "final", {
        sma50: 100,
        sma200: 90,
      });
      bar(w.db, "XX:W", "1wk", "2026-10-19", 103, false);
      row(w.db, "XX:W", "1wk", "2026-10-19", "live", {
        sma50: 101,
        sma200: 90,
      });
      const a = await movers(w.m, {
        symbols: ["XX:W"],
        average: "weekly_sma50",
        relation: "crossed_up",
      });
      expect(ids(a.body)).toEqual(["XX:W"]);
      expect(a.body.items[0].average.last_final).toEqual({
        date: "2026-10-12",
        close: 95,
        value: 100,
      });
      const below = await movers(w.m, {
        symbols: ["XX:W"],
        average: "weekly_sma200",
        relation: "below",
      });
      expect(ids(below.body)).toEqual([]);
    });

    test("with a move, both must hold", async () => {
      const { m } = crossings();
      const a = await movers(m, {
        symbols: all,
        min_move_pct: 1.5,
        direction: "down",
        average: "daily_sma50",
        relation: "crossed_down",
      });
      expect(ids(a.body)).toEqual(["XX:DNX"]);
    });

    test("a crossing with no live row is unavailable", async () => {
      const w = world();
      instrument(w.db, "XX:A");
      bar(w.db, "XX:A", "1d", FINAL, 100, true);
      row(w.db, "XX:A", "1d", FINAL, "final");
      quote(w.db, "XX:A", 99.5, 100);
      const a = await movers(w.m, {
        symbols: ["XX:A"],
        average: "daily_sma50",
        relation: "crossed_up",
      });
      expect(a.body.items).toEqual([
        {
          input: "XX:A",
          id: "XX:A",
          status: "unavailable",
          missing: ["daily_sma50"],
          stale: [],
          reason: "no live row: no trade in the current session yet",
        },
      ]);
      // below reads the final row when no live one is current
      const below = await movers(w.m, {
        symbols: ["XX:A"],
        average: "daily_sma50",
        relation: "below",
      });
      expect(below.body.items[0].average).toMatchObject({
        kind: "final",
        value: 100,
      });
    });
  });

  test("a stale quote, a null average or a FRED series never moves", async () => {
    const w = moves();
    listing(w.db, "XX:NULL", {
      price: 110,
      live: { sma50: null, sma200: null },
    });
    w.db.query("delete from quotes where instrument = 'XX:UP3'").run();
    instrument(w.db, "FRED:DGS10");
    bar(w.db, "FRED:DGS10", "1d", FINAL, 4.2, true);
    row(w.db, "FRED:DGS10", "1d", FINAL, "final");
    w.db.query("update instruments set last_read_at = ?").run(NOW);
    const a = await movers(w.m, {
      symbols: ["XX:UP3", "XX:NULL", "FRED:DGS10", "XX:DN3"],
      min_move_pct: 0,
      average: "daily_sma50",
      relation: "above",
    });
    expect(a.body.counts).toEqual({
      matched: 0,
      not_matched: 1,
      unavailable: 3,
      errors: 0,
    });
    expect(a.body.items).toEqual([
      {
        input: "FRED:DGS10",
        id: "FRED:DGS10",
        status: "unavailable",
        missing: ["change_percent", "daily_sma50"],
        stale: [],
        reason: "a FRED series has no live quote, so it never moves",
      },
      {
        input: "XX:NULL",
        id: "XX:NULL",
        status: "unavailable",
        missing: ["daily_sma50"],
        stale: [],
      },
      {
        input: "XX:UP3",
        id: "XX:UP3",
        status: "unavailable",
        missing: ["change_percent", "daily_sma50"],
        stale: ["no quote yet"],
      },
    ]);
  });

  test("an average alone needs no day change, and ranks those without one last", async () => {
    const w = moves();
    listing(w.db, "XX:FLAT", { price: 150 });
    w.db
      .query(
        `update quotes set previous_close = null, previous_close_field = null,
           change = null, change_percent = null where instrument = 'XX:FLAT'`,
      )
      .run();
    const a = await movers(w.m, {
      symbols: [...names, "XX:FLAT"],
      average: "daily_sma50",
      relation: "above",
    });
    expect(ids(a.body)).toEqual(["XX:UP3", "XX:UP05", "XX:FLAT"]);
    expect(a.body.items[2]).toMatchObject({ change_percent: null, price: 150 });
    const moving = await movers(w.m, {
      symbols: ["XX:FLAT"],
      min_move_pct: 0,
    });
    expect(moving.body.items[0]).toMatchObject({
      status: "unavailable",
      missing: ["change_percent"],
    });
  });

  test("a market that trades with a quote no pass refreshed is stale", async () => {
    const w = world();
    listing(w.db, "CRYPTO:C", { price: 103 });
    bar(w.db, "CRYPTO:C", "1wk", "2026-10-19", 103, false);
    row(w.db, "CRYPTO:C", "1wk", "2026-10-19", "live");
    const ok = await movers(w.m, { symbols: ["CRYPTO:C"], min_move_pct: 1 });
    expect(ids(ok.body)).toEqual(["CRYPTO:C"]);
    await w.clock.advance(10 * MINUTE_MS + 1);
    const late = await movers(w.m, { symbols: ["CRYPTO:C"], min_move_pct: 1 });
    expect(late.body.items[0]).toMatchObject({
      status: "unavailable",
      stale: ["quote overdue"],
    });
  });

  test("a cursor is checked before any symbol is read", async () => {
    const w = moves();
    const asked = {
      symbols: names,
      min_move_pct: 1,
      direction: "either",
      average: null,
      relation: null,
    };
    for (const next of [
      "bogus",
      "1~0000000000",
      cursor("0", asked),
      cursor("1.5", asked),
      cursor("x", asked),
    ]) {
      await expect(
        moversAnswer(
          w.m,
          parseMovers({ symbols: names, min_move_pct: 1, next }),
        ),
      ).rejects.toThrow("next does not continue");
    }
    for (const id of names) expect(lastReadAt(w.db, id)).toBeNull();
    // the same arguments' cursor continues them
    const rest = await movers(w.m, {
      symbols: names,
      min_move_pct: 1,
      next: cursor("1", asked),
    });
    expect(ids(rest.body)).toEqual(["XX:UP3", "XX:DN2"]);
  });

  test("every named symbol counts as read, matched or not", async () => {
    const w = moves();
    await w.clock.advance(DAY_MS);
    await movers(w.m, { symbols: names, min_move_pct: 50 });
    for (const id of names) expect(lastReadAt(w.db, id)).toBe(NOW + DAY_MS);
  });
});

describe("GET /quotes's last final day", () => {
  const quotes = async (m: Markets, symbols: string[], next?: string) => {
    const query = new URLSearchParams({
      symbols: symbols.join(","),
      ...(next === undefined ? {} : { next }),
    });
    const res = await quotesHandler(m)(
      new Request(`http://localhost/quotes?${query}`),
    );
    expect(res.status).toBe(200);
    const text = await res.text();
    return { body: JSON.parse(text), bytes: Buffer.byteLength(text) };
  };

  // the rule docs/tools.md gives a script, on the SMA 50 under 200 bars
  function crossed(item: any): "up" | "down" | null {
    const then = item.last_final?.daily;
    const now = item.sma.daily;
    if (then == null || now?.kind !== "live" || item.stale.length > 0) {
      return null;
    }
    if (now.date <= then.date) return null;
    const key = then.sma200 === null ? "sma50" : "sma200";
    if (then[key] === null || now[key] === null) return null;
    if (then.close >= then[key] && item.price < now[key]) return "down";
    if (then.close <= then[key] && item.price > now[key]) return "up";
    return null;
  }

  function crossings() {
    const w = world();
    listing(w.db, "XX:UPX", {
      previousClose: 99,
      price: 101,
      final: { sma200: 100 },
      live: { sma200: 100.2 },
    });
    listing(w.db, "XX:DNX", {
      previousClose: 101,
      price: 99,
      final: { sma200: 100 },
      live: { sma200: 100.1 },
    });
    listing(w.db, "XX:OVER", {
      previousClose: 105,
      price: 106,
      final: { sma200: 100 },
      live: { sma200: 100.1 },
    });
    listing(w.db, "XX:ON", {
      previousClose: 100,
      price: 99.5,
      final: { sma200: 100 },
      live: { sma200: 100 },
    });
    // under 200 bars: no SMA 200, crossing its SMA 50 both ways
    listing(w.db, "XX:NEWDN", {
      previousClose: 101,
      price: 99,
      final: { sma50: 100, sma200: null },
      live: { sma50: 100.1, sma200: null },
    });
    listing(w.db, "XX:NEWUP", {
      previousClose: 99,
      price: 101,
      final: { sma50: 100, sma200: null },
      live: { sma50: 100.1, sma200: null },
    });
    return w;
  }
  const long = ["XX:UPX", "XX:DNX", "XX:OVER", "XX:ON"];
  const young = ["XX:NEWDN", "XX:NEWUP"];

  test("answers the last final close and its averages", async () => {
    const { m } = crossings();
    const { body } = await quotes(m, ["XX:DNX", "XX:NEWDN"]);
    expect(body.items[0]).toMatchObject({
      price: 99,
      sma: { daily: { kind: "live", date: LIVE, sma200: 100.1 } },
      last_final: {
        daily: { date: FINAL, close: 101, sma50: 100, sma200: 100 },
      },
    });
    expect(body.items[1].last_final).toEqual({
      daily: { date: FINAL, close: 101, sma50: 100, sma200: null },
    });
  });

  test("a crossing told from it is the one movers answers", async () => {
    const { m } = crossings();
    const { body } = await quotes(m, [...long, ...young]);
    for (const [relation, side] of [
      ["crossed_down", "down"],
      ["crossed_up", "up"],
    ] as const) {
      const old = await movers(m, {
        symbols: long,
        average: "daily_sma200",
        relation,
      });
      const fresh = await movers(m, {
        symbols: young,
        average: "daily_sma50",
        relation,
      });
      const expected = [...ids(old.body), ...ids(fresh.body)].sort();
      expect(expected.length).toBeGreaterThan(1);
      const told = body.items
        .filter((i: any) => crossed(i) === side)
        .map((i: any) => i.id)
        .sort();
      expect(told).toEqual(expected);
    }
  });

  test("is null with no final bar", async () => {
    const w = world();
    instrument(w.db, "XX:A");
    bar(w.db, "XX:A", "1d", LIVE, 100, false);
    row(w.db, "XX:A", "1d", LIVE, "live");
    quote(w.db, "XX:A", 100, 100);
    const { body } = await quotes(w.m, ["XX:A"]);
    expect(body.items[0].sma.daily).not.toBeNull();
    expect(body.items[0].last_final).toBeNull();
  });

  test("100 symbols fit the page cap, or continue with next", async () => {
    const w = world();
    const symbols: string[] = [];
    for (let k = 0; k < 100; k++) {
      const id = `XXXXXX:SYMBOL${k}-USD`;
      const many = { sma50: 12345.6 + k, sma200: 12345.7 + k };
      listing(w.db, id, {
        previousClose: 12345.678 + k,
        price: 12346.789 + k,
        final: many,
        live: many,
      });
      bar(w.db, id, "1wk", "2026-10-12", 12345.678, true);
      row(w.db, id, "1wk", "2026-10-12", "final", many);
      bar(w.db, id, "1wk", "2026-10-19", 12346.789, false);
      row(w.db, id, "1wk", "2026-10-19", "live", many);
      symbols.push(id);
    }
    const seen: string[] = [];
    let next: string | undefined;
    do {
      const { body, bytes } = await quotes(w.m, symbols, next);
      expect(bytes).toBeLessThanOrEqual(PAGE_BYTES);
      for (const item of body.items) {
        expect(item.last_final.daily.sma200).toBeNumber();
        seen.push(item.id);
      }
      next = body.next ?? undefined;
    } while (next !== undefined);
    expect(seen).toEqual(symbols);
  });
});
