// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { recordSession, session } from "../src/market/calendars.ts";
import { round } from "../src/market/format.ts";
import type { Db } from "../src/storage/db/index.ts";
import { cursor, fits, PAGE_BYTES } from "../src/tools/answer.ts";
import { historyAnswer, parseHistory } from "../src/tools/history.ts";
import type { Markets } from "../src/tools/markets.ts";
import { parseQuote, quotePage } from "../src/tools/quote.ts";
import {
  bar,
  instrument,
  LIVE,
  NOW,
  quote,
  row,
  world,
} from "./helpers/world.ts";

const HOUR_MS = 60 * 60 * 1000;

async function ask(m: Markets, args: unknown) {
  return JSON.parse(await quotePage(m, parseQuote(args)));
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

// final closes by date, then the live price on LIVE from a quote at NOW
function closes(db: Db, id: string, rows: [string, number][]) {
  for (const [date, close] of rows) bar(db, id, "1d", date, close, true);
}

describe("quote returns", () => {
  function shares() {
    const w = world();
    instrument(w.db, "XX:A");
    // 2025-12-31 is a holiday: the year's last close is the 30th
    closes(w.db, "XX:A", [
      ["2025-12-30", 50],
      ["2026-07-23", 80],
      ["2026-09-23", 100],
      ["2026-10-16", 105],
      ["2026-10-22", 110],
    ]);
    quote(w.db, "XX:A", 121, 110);
    open(w.db, "XX");
    // bars only from October: no 3-month or year start
    instrument(w.db, "XX:NEW");
    closes(w.db, "XX:NEW", [
      ["2026-10-01", 20],
      ["2026-10-16", 22],
      ["2026-10-22", 25],
    ]);
    instrument(w.db, "FRED:DGS10");
    closes(w.db, "FRED:DGS10", [
      ["2025-12-31", 4.0],
      ["2026-07-22", 4.2],
      ["2026-09-22", 4.4],
      ["2026-10-15", 4.5],
      ["2026-10-22", 4.6],
    ]);
    // a FRED series no read kept would be fetched again
    w.db.query("update instruments set last_read_at = ?").run(NOW);
    return w;
  }

  test("end on the live price after the last final close", async () => {
    const w = shares();
    const [a] = (await ask(w.m, { symbols: ["XX:A"] })).items;
    expect(a.returns).toEqual({
      "1w": round((121 / 105 - 1) * 100),
      "1m": round(21),
      "3m": round(51.25),
      ytd: round(142),
      to: LIVE,
      live: true,
    });
  });

  test("end on the last final close once the day is final", async () => {
    const w = shares();
    bar(w.db, "XX:A", "1d", LIVE, 121, true);
    const [a] = (await ask(w.m, { symbols: ["XX:A"] })).items;
    expect(a.returns).toMatchObject({
      "1w": round((121 / 105 - 1) * 100),
      ytd: round(142),
      to: LIVE,
      live: false,
    });
  });

  test("are null where the bars do not reach the start", async () => {
    const w = shares();
    const [n] = (await ask(w.m, { symbols: ["XX:NEW"] })).items;
    // no quote: the last final close ends them
    expect(n.returns).toEqual({
      "1w": round(25),
      "1m": null,
      "3m": null,
      ytd: null,
      to: "2026-10-22",
      live: false,
    });
  });

  test("a percent series answers points", async () => {
    const w = shares();
    const [y] = (await ask(w.m, { symbols: ["FRED:DGS10"] })).items;
    expect(y.returns["1w"]).toBeCloseTo(0.1, 6);
    expect(y.returns["1m"]).toBeCloseTo(0.2, 6);
    expect(y.returns["3m"]).toBeCloseTo(0.4, 6);
    expect(y.returns.ytd).toBeCloseTo(0.6, 6);
    expect(y.returns).toMatchObject({ to: "2026-10-22", live: false });
  });

  test("leave GET /quotes's projection and the error items as they were", async () => {
    const w = shares();
    const brief = JSON.parse(
      await quotePage(w.m, parseQuote({ symbols: ["XX:A"] }), (item) => item),
    );
    expect(brief.items[0]).not.toContainKey("returns");
    expect(brief.items[0]).not.toContainKey("session");
    const [none] = (await ask(w.m, { symbols: ["XX:NOPE"] })).items;
    expect(none).not.toContainKey("returns");
  });
});

describe("quote against a benchmark", () => {
  // both trade NOW's session, with a provisional bar on it
  function pair() {
    const w = world();
    const rows: Record<string, [string, number][]> = {
      "XX:A": [
        ["2026-07-23", 80],
        ["2026-09-23", 100],
        ["2026-10-22", 108],
      ],
      "XX:B": [
        ["2026-07-23", 200],
        ["2026-09-23", 200],
        ["2026-10-22", 205],
      ],
    };
    for (const [id, list] of Object.entries(rows)) {
      instrument(w.db, id);
      closes(w.db, id, list);
      for (const [date] of list) row(w.db, id, "1d", date, "final");
      bar(w.db, id, "1d", LIVE, id === "XX:A" ? 110 : 210, false);
      row(w.db, id, "1d", LIVE, "live");
      quote(w.db, id, id === "XX:A" ? 110 : 210, list.at(-1)![1]);
    }
    open(w.db, "XX");
    return w;
  }

  test("answers the relative returns history answers", async () => {
    const w = pair();
    const q = await ask(w.m, { symbols: ["XX:A"], benchmark: "XX:B" });
    const h = await historyAnswer(
      w.m,
      parseHistory({ symbol: "XX:A", benchmark: "XX:B" }),
    );
    const rel = JSON.parse(h.content[0]!.text).relative;
    expect(rel.returns[0].live).toBe(true);
    expect(q.items[0].relative_return_1m).toBe(rel.returns[0].relative);
    expect(q.items[0].relative_return_3m).toBe(rel.returns[1].relative);
    // 1m: A +10%, B +5%
    expect(q.items[0].relative_return_1m).toBeCloseTo(5, 4);
    expect(q.benchmark).toMatchObject({
      id: "XX:B",
      currency: "USD",
      fetched_at: "2026-10-23T18:00:00Z",
    });
    expect(q.benchmark.stale).not.toContain("no quote yet");
  });

  test("a stale benchmark marks the answer", async () => {
    const w = pair();
    w.db.query("delete from quotes where instrument = 'XX:B'").run();
    const q = await ask(w.m, { symbols: ["XX:A"], benchmark: "XX:B" });
    expect(q.benchmark.stale).toContain("no quote yet");
    expect(q.stale).toContain("benchmark: no quote yet");
    // the symbol's own reasons stay its own
    expect(q.items[0].stale).not.toContain("no quote yet");
  });

  test("a benchmark not found is said once, beside null returns", async () => {
    const w = pair();
    const q = await ask(w.m, { symbols: ["XX:A"], benchmark: "XX:NOPE" });
    expect(q.benchmark.input).toBe("XX:NOPE");
    expect(q.benchmark.error).toBeString();
    expect(q.items[0].relative_return_1m).toBeNull();
  });

  test("a cursor continues only under its own benchmark", async () => {
    const w = pair();
    const symbols = ["XX:A", "XX:B"];
    const next = cursor("1", { symbols, benchmark: "XX:B" });
    const same = await ask(w.m, { symbols, benchmark: "XX:B", next });
    expect(same.items.map((i: any) => i.id)).toEqual(["XX:B"]);
    for (const other of [{ benchmark: "XX:A" }, {}]) {
      await expect(
        quotePage(w.m, parseQuote({ symbols, ...other, next })),
      ).rejects.toThrow("next does not continue");
    }
    // without a benchmark the cursor is the one it always was
    const plain = await ask(w.m, { symbols, next: cursor("1", symbols) });
    expect(plain.items.map((i: any) => i.id)).toEqual(["XX:B"]);
    expect(plain.items[0]).not.toContainKey("relative_return_1m");
  });
});

describe("quote session", () => {
  function markets() {
    const w = world();
    for (const id of ["US:AAA", "XETRA:VVSM", "CRYPTO:BTC-USD", "FRED:DGS10"]) {
      instrument(w.db, id);
      bar(w.db, id, "1d", "2026-10-22", 10, true);
    }
    const day = (market: string, date: string, from: string, to: string) =>
      recordSession(
        w.db,
        market,
        session(
          "UTC",
          Date.parse(`${date}T${from}:00Z`),
          Date.parse(`${date}T${to}:00Z`),
        ),
        w.clock.now(),
      );
    w.db.query("update instruments set last_read_at = ?").run(NOW);
    day("US", LIVE, "13:30", "20:00");
    day("XETRA", LIVE, "07:00", "15:30");
    return { ...w, day };
  }
  const states = async (m: Markets) =>
    Object.fromEntries(
      (
        await ask(m, {
          symbols: ["US:AAA", "XETRA:VVSM", "CRYPTO:BTC-USD", "FRED:DGS10"],
        })
      ).items.map((i: any) => [i.id, i.session]),
    );

  test("is open inside the stored session and closed outside it", async () => {
    const w = markets();
    expect(await states(w.m)).toEqual({
      "US:AAA": {
        state: "open",
        start: `${LIVE}T13:30:00Z`,
        end: `${LIVE}T20:00:00Z`,
      },
      "XETRA:VVSM": {
        state: "closed",
        start: `${LIVE}T07:00:00Z`,
        end: `${LIVE}T15:30:00Z`,
      },
      "CRYPTO:BTC-USD": { state: "open", start: null, end: null },
      "FRED:DGS10": null,
    });
    // a Saturday, a day with no session
    await w.clock.advance(21 * HOUR_MS);
    const weekend = await states(w.m);
    expect(weekend["US:AAA"].state).toBe("closed");
    expect(weekend["XETRA:VVSM"].state).toBe("closed");
    expect(weekend["CRYPTO:BTC-USD"].state).toBe("open");
    // Monday morning: Xetra's new session stored, the US one not yet
    await w.clock.advance(42 * HOUR_MS);
    w.day("XETRA", "2026-10-26", "08:00", "16:30");
    const monday = await states(w.m);
    expect(monday["XETRA:VVSM"]).toEqual({
      state: "open",
      start: "2026-10-26T08:00:00Z",
      end: "2026-10-26T16:30:00Z",
    });
    expect(monday["US:AAA"].state).toBe("closed");
  });
});

describe("quote pages", () => {
  test("100 symbols with every new field fit the page cap", async () => {
    const w = world();
    const name = "Ünïcödé “Holdings” 日本株式会社 \\ ✓ ".repeat(3);
    const every: Record<string, number> = {};
    for (const key of [
      "ema20",
      "rsi14",
      "macd",
      "macd_signal",
      "macd_histogram",
      "atr14",
      "move_atr",
      "volatility20",
      "bollinger_lower",
      "high52w",
      "low52w",
      "drawdown",
      "from_low",
      "volume_ratio",
    ]) {
      every[key] = -12345.678901;
    }
    every.rsi14 = 12.345678;
    every.volatility20 = 12.345678;
    const symbols: string[] = [];
    for (let k = 0; k < 100; k++) {
      const id = `XXXXXXXX:SYMBOL-${String(k).padStart(3, "0")}-LONGER`;
      instrument(w.db, id, { name: `${name}${k}` });
      closes(w.db, id, [
        ["2025-12-30", 1234.5678],
        ["2026-07-23", 2234.5678],
        ["2026-09-23", 3234.5678],
        ["2026-10-16", 4234.5678],
        ["2026-10-22", 5234.5678],
      ]);
      row(w.db, id, "1d", "2026-10-22", "final", {
        ...every,
        days_since_high: 123,
        cross_edge: -1,
        macd_turn: -1,
      });
      bar(w.db, id, "1d", LIVE, 6234.5678, false);
      row(w.db, id, "1d", LIVE, "live", {
        ...every,
        days_since_high: 123,
        cross_edge: -1,
        macd_turn: -1,
      });
      bar(w.db, id, "1wk", "2026-10-19", 6234.5678, false);
      row(w.db, id, "1wk", "2026-10-19", "live", { cross_edge: -1 });
      quote(w.db, id, 6234.5678, 5234.5678);
      symbols.push(id);
    }
    open(w.db, "XXXXXXXX");
    const seen: string[] = [];
    let next: string | null = null;
    let pages = 0;
    do {
      const text = await quotePage(
        w.m,
        parseQuote({
          symbols,
          benchmark: symbols[0],
          ...(next === null ? {} : { next }),
        }),
      );
      expect(fits(text)).toBe(true);
      expect(Buffer.byteLength(text)).toBeLessThan(PAGE_BYTES);
      const body = JSON.parse(text);
      for (const item of body.items) {
        expect(item.returns.ytd).toBeNumber();
        expect(item.relative_return_3m).toBeNumber();
        expect(item.session.state).toBe("open");
        seen.push(item.id);
      }
      next = body.next;
      pages++;
    } while (next !== null);
    expect(seen).toEqual(symbols);
    expect(pages).toBeGreaterThan(1);
  });
});
