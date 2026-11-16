// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { status } from "../src/admin/http.ts";
import { tagOf } from "../src/operations/answer.ts";
import type { Markets } from "../src/operations/markets.ts";
import { moversAnswer, parseMovers } from "../src/operations/movers.ts";
import { createPortfolio, saveSettings } from "../src/operations/portfolio.ts";
import { parseScreen, screenAnswer } from "../src/operations/screen.ts";
import { type SetRead, setPage, shownBy } from "../src/operations/sets.ts";
import { OPERATOR, type Who } from "../src/operations/who.ts";
import type { Db } from "../src/storage/db/index.ts";
import { ask } from "./helpers/portfolio.ts";
import { instrument, listing, NOW, quote, world } from "./helpers/world.ts";

const LONG = "Ünïcödé “Holdings” 日本株式会社 ✓ ".repeat(10);

const setQuote = (db: Db, id: string, price: number, previous = 100) =>
  db
    .query(
      `update quotes set price = ?, change = ?, change_percent = ?
       where instrument = ?`,
    )
    .run(price, price - previous, ((price - previous) / previous) * 100, id);

async function walk(
  page: (next: string | null) => Promise<any>,
  between: (pages: number) => void = () => {},
): Promise<{ seen: string[]; pages: number }> {
  const seen: string[] = [];
  let next: string | null = null;
  let pages = 0;
  do {
    const body = await page(next);
    seen.push(...body.items.map((i: any) => i.id));
    next = body.next;
    pages++;
    between(pages);
  } while (next !== null && pages < 20);
  return { seen, pages };
}

describe("movers and screen pages", () => {
  function symbols(n: number) {
    const w = world();
    const names: string[] = [];
    for (let k = 0; k < n; k++) {
      const id = `XX:S${String(k).padStart(3, "0")}`;
      // moves 1% to n%, largest first, so S000 comes last
      listing(w.db, id, {
        name: `${LONG}${k}`,
        price: 101 + k,
        live: { rsi14: k },
      });
      names.push(id);
    }
    return { ...w, names };
  }

  const movers = async (m: Markets, args: object, next: string | null) =>
    JSON.parse(
      (
        await moversAnswer(
          m,
          parseMovers({ ...args, ...(next === null ? {} : { next }) }),
        )
      ).content[0]!.text,
    );

  const screen = async (m: Markets, args: object, next: string | null) =>
    JSON.parse(
      (
        await screenAnswer(
          m,
          parseScreen({ ...args, ...(next === null ? {} : { next }) }),
        )
      ).content[0]!.text,
    );

  test("a move between movers pages shows every match once", async () => {
    const w = symbols(60);
    const args = { symbols: w.names, min_move_pct: 0.5 };
    const { seen, pages } = await walk(
      (next) => movers(w.m, args, next),
      (n) => {
        // the last-ranked symbol jumps to the top after the first page
        if (n === 1) setQuote(w.db, "XX:S000", 500);
      },
    );
    expect(pages).toBeGreaterThan(1);
    expect(seen.toSorted()).toEqual(w.names);
  });

  test("a rank change between screen pages shows every match once", async () => {
    const w = symbols(60);
    const args = { symbols: w.names, sort: "rsi14", order: "desc" };
    const { seen, pages } = await walk(
      (next) => screen(w.m, args, next),
      (n) => {
        if (n === 1) {
          w.db
            .query(
              "update signals set rsi14 = 99 where instrument = 'XX:S000' and kind = 'live'",
            )
            .run();
        }
      },
    );
    expect(pages).toBeGreaterThan(1);
    expect(seen.toSorted()).toEqual(w.names);
  });

  test("two rows sharing a tag repeat, neither is hidden", async () => {
    const w = symbols(60);
    const [top, last] = ["XX:C14271", "XX:C50133"];
    expect(tagOf(top)).toBe(tagOf(last));
    listing(w.db, top, { name: LONG, price: 900 });
    listing(w.db, last, { name: LONG, price: 100.6 });
    const args = { symbols: [...w.names, top, last], min_move_pct: 0.5 };
    const { seen, pages } = await walk((next) => movers(w.m, args, next));
    expect(pages).toBeGreaterThan(1);
    expect(seen[0]).toBe(top);
    expect(seen.filter((id) => id === last)).toHaveLength(1);
    expect(seen.filter((id) => id === top).length).toBeGreaterThan(1);
    expect(new Set(seen)).toEqual(new Set([...w.names, top, last]));
  });

  test("a symbol that stops matching ends the walk, never refuses it", async () => {
    const w = symbols(60);
    const args = { symbols: w.names, min_move_pct: 0.5 };
    const first = await movers(w.m, args, null);
    expect(first.next).not.toBeNull();
    const shown = new Set(first.items.map((i: any) => i.id));
    for (const id of w.names) if (!shown.has(id)) setQuote(w.db, id, 100);
    const rest = await movers(w.m, args, first.next);
    expect(rest.items).toEqual([]);
    expect(rest.next).toBeNull();
  });
});

describe("a set's row that changes status between pages", () => {
  test("unavailable on one page and matched on the next is shown once", () => {
    const big = (id: string) => ({
      id,
      status: "matched",
      pad: "x".repeat(12_000),
    });
    const u = { input: "U", id: "XX:U", status: "unavailable" };
    const read = (matched: object[], unavailable: object[]): SetRead => ({
      matched: matched.map((item: any) => ({
        key: item.id,
        item,
        fred: false,
      })),
      notMatched: 0,
      unavailable: unavailable as SetRead["unavailable"],
      errors: [
        { input: "E", error: "not_found", message: "y".repeat(12_000) },
      ] as unknown as SetRead["errors"],
      head: {},
      attribution: "",
    });
    const args = { symbols: ["A", "B", "U", "E"] };
    const first = JSON.parse(
      setPage({
        ...read([big("XX:A"), big("XX:B")], [u]),
        args,
        shown: new Set(),
      }),
    );
    expect(first.items.map((i: any) => i.input ?? i.id)).toEqual([
      "XX:A",
      "XX:B",
      "U",
    ]);
    const second = JSON.parse(
      setPage({
        ...read(
          [big("XX:A"), big("XX:B"), { id: "XX:U", status: "matched" }],
          [],
        ),
        args,
        shown: shownBy(first.next, args),
      }),
    );
    expect(second.items.map((i: any) => i.input)).toEqual(["E"]);
    expect(second.next).toBeNull();
  });
});

describe("holdings pages", () => {
  const CASEY: Who = {
    name: "casey-agent",
    user: OPERATOR,
    credential: { kind: "key", id: "casey-agent" },
    portfolio: "write",
    alerts: "none",
    profile: "none",
    analysis: "none",
    tradePlans: "none",
  };

  test("a price moved between pages shows every holding once", async () => {
    const w = world();
    await saveSettings(w.m, OPERATOR, { display_currency: "EUR" });
    await createPortfolio(w.m, OPERATOR, { name: "Shares" });
    const names: string[] = [];
    for (let k = 0; k < 60; k++) {
      const id = `XX:H${String(k).padStart(3, "0")}`;
      instrument(w.db, id, { currency: "EUR", name: `${LONG}${k}` });
      quote(w.db, id, 101 + k, 100);
      names.push(id);
      const added = await ask(w.m, CASEY, "portfolio_trade", {
        action: "add",
        symbol: id,
        side: "buy",
        quantity: 1,
        price: 100,
        portfolio: "Shares",
        date: "2026-10-01",
      });
      expect(added.error).toBe(false);
    }
    const seen: string[] = [];
    let next: string | null = null;
    let pages = 0;
    do {
      const page = await ask(w.m, CASEY, "portfolio", {
        action: "holdings",
        ...(next === null ? {} : { next }),
      });
      expect(page.error).toBe(false);
      seen.push(
        ...page.body.holdings
          .filter((h: any) => h.kind === "holding")
          .map((h: any) => h.symbol),
      );
      next = page.body.next;
      pages++;
      // the smallest holding becomes the largest after the first page
      if (pages === 1) setQuote(w.db, "XX:H000", 900);
    } while (next !== null && pages < 20);
    expect(pages).toBeGreaterThan(1);
    expect(seen.toSorted()).toEqual(names);
  });
});

describe("a live-priced add", () => {
  const CASEY: Who = {
    name: "casey-agent",
    user: OPERATOR,
    credential: { kind: "key", id: "casey-agent" },
    portfolio: "write",
    alerts: "none",
    profile: "none",
    analysis: "none",
    tradePlans: "none",
  };

  async function setup() {
    const w = world();
    await saveSettings(w.m, OPERATOR, { display_currency: "EUR" });
    await createPortfolio(w.m, OPERATOR, { name: "Shares" });
    instrument(w.db, "XX:LIVE", { currency: "EUR", name: "Live Made Up" });
    quote(w.db, "XX:LIVE", 50, 49);
    return w;
  }

  const add = { action: "add", symbol: "XX:LIVE", side: "buy", quantity: 2 };
  const count = (db: Db) =>
    (db.query("select count(*) as n from trades").get() as { n: number }).n;

  test("retried after the quote moved saves one trade", async () => {
    const w = await setup();
    const first = await ask(w.m, CASEY, "portfolio_trade", add);
    expect(first.error).toBe(false);
    setQuote(w.db, "XX:LIVE", 51, 49);
    const retry = await ask(w.m, CASEY, "portfolio_trade", add);
    expect(retry).toMatchObject({
      error: true,
      body: { error: "conflict", trade: first.body.trade.id },
    });
    expect(retry.body.message).toMatch(
      /^the same trade was saved as trade \d+ in the last/,
    );
    expect(count(w.db)).toBe(1);
  });

  test("repeated past two minutes, or with again, is a second trade", async () => {
    const w = await setup();
    await ask(w.m, CASEY, "portfolio_trade", add);
    setQuote(w.db, "XX:LIVE", 51, 49);
    const again = await ask(w.m, CASEY, "portfolio_trade", {
      ...add,
      again: true,
    });
    expect(again.error).toBe(false);
    await w.clock.advance(2 * 60_000 + 1);
    setQuote(w.db, "XX:LIVE", 52, 49);
    const later = await ask(w.m, CASEY, "portfolio_trade", add);
    expect(later.error).toBe(false);
    expect(count(w.db)).toBe(3);
  });

  test("retried after the first was removed is saved", async () => {
    const w = await setup();
    const first = await ask(w.m, CASEY, "portfolio_trade", add);
    await ask(w.m, CASEY, "portfolio_trade", {
      action: "remove",
      trade: first.body.trade.id,
    });
    setQuote(w.db, "XX:LIVE", 51, 49);
    const retry = await ask(w.m, CASEY, "portfolio_trade", add);
    expect(retry.error).toBe(false);
  });
});

describe("the status page's runs", () => {
  test("name each job's newest run and each scope's last ended one", async () => {
    const w = world();
    const run = w.db.query(
      `insert into sync_runs (source, job, scope, started_at, ended_at,
         status, rows, error) values (?, ?, ?, ?, ?, ?, 0, ?)`,
    );
    const t = (min: number) => NOW - 60 * 60_000 + min * 60_000;
    run.run("yahoo", "quotes", "US", t(1), t(2), "failed", "old");
    run.run("yahoo", "quotes", "US", t(10), t(11), "ok", null);
    run.run("yahoo", "quotes", "US", t(30), null, "running", null);
    run.run("yahoo", "quotes", "XETRA", t(20), t(21), "failed", "down");
    run.run("yahoo", "bars", null, t(40), t(41), "ok", null);
    run.run("yahoo", "bars", "US:A", t(5), t(6), "failed", "gone");
    run.run("fred", "bars", "FRED:X", t(3), t(4), "ok", null);
    const res = status(
      { m: w.m, version: "test", sources: [], sync: true },
      new URL("http://localhost/admin/api/status"),
    );
    const jobs = (await res.json()).jobs.map((j: any) => ({
      job: `${j.source}/${j.job}`,
      scope: j.last.scope,
      status: j.last.status,
      instruments: j.instruments,
      markets: j.markets,
      failing: j.failing.map((f: any) => f.scope),
    }));
    expect(jobs).toEqual([
      {
        job: "fred/bars",
        scope: "FRED:X",
        status: "ok",
        instruments: 1,
        markets: 0,
        failing: [],
      },
      {
        job: "yahoo/bars",
        scope: null,
        status: "ok",
        instruments: 1,
        markets: 0,
        failing: ["US:A"],
      },
      {
        job: "yahoo/quotes",
        scope: "US",
        status: "running",
        instruments: 0,
        markets: 2,
        failing: ["XETRA"],
      },
    ]);
  });
});
