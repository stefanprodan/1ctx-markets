// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// A person lets others see all their portfolios, read only, from the web
// UI. Made-up people, names and figures only.

import { describe, expect, test } from "bun:test";
import { removeUserRows } from "../src/admin/users.ts";
import { PREFIX } from "../src/api/http.ts";
import { routes } from "../src/api/routes.ts";
import type { Markets } from "../src/operations/markets.ts";
import {
  addFundTrade,
  addPosition,
  addTrade,
  createBroker,
  createPortfolio,
  saveSettings,
} from "../src/operations/portfolio.ts";
import { NO_WORLD } from "../src/operations/track.ts";
import type { Who } from "../src/operations/who.ts";
import { silent } from "../src/runtime/log.ts";
import { createKey } from "../src/server/access.ts";
import { isIsin } from "../src/shared/isin.ts";
import type { Db } from "../src/storage/db/index.ts";
import { ADMIN_KEY, api, cookieFor } from "./helpers/api.ts";
import { instrument, quote, world } from "./helpers/world.ts";

const as = (user: string): Who => ({
  name: user === "ana" ? "Ana" : "Jo",
  user,
  credential: { kind: "key", id: user },
  portfolio: "write",
  rules: "none",
  profile: "none",
  analysis: "none",
});

const isinOf = (body: string): string =>
  [..."0123456789"].map((d) => body + d).find(isIsin)!;

function ok<T>(v: T): Exclude<T, { error: unknown }> {
  if (typeof v === "object" && v !== null && "error" in v) {
    throw new Error(String((v as { message?: unknown }).message));
  }
  return v as Exclude<T, { error: unknown }>;
}

type Owned = {
  portfolio: number;
  broker: number;
  trade: number;
  cash: number;
  bond: number;
  fund: string;
};

// each person's rows; the figures differ, so an answer tells whose it is
async function fill(m: Markets, user: string, n: number): Promise<Owned> {
  const who = as(user);
  await saveSettings(m, user, {
    display_currency: user === "ana" ? "EUR" : "USD",
    time_zone: user === "ana" ? "Europe/Berlin" : "Asia/Tokyo",
  });
  const portfolio = ok(await createPortfolio(m, user, { name: "Shares" }))
    .portfolio.id;
  const broker = ok(await createBroker(m, user, { name: "North" })).broker.id;
  const base = {
    portfolio: "Shares",
    price: 100 + n,
    total: null,
    fees: 0,
    date: "2026-01-05",
    currency: null,
    broker: "North",
    note: null,
  };
  const trade = ok(
    await addTrade(m, who, {
      ...base,
      symbol: "US:AAA",
      side: "buy",
      quantity: n,
    }),
  ).trade!.id;
  const position = {
    portfolio: null,
    symbol: null,
    currency: "EUR",
    cost: null,
    coupon: null,
    maturity: null,
    date: "2026-03-17",
    broker: "North",
    note: null,
    dryPowder: false,
  };
  const cash = ok(
    await addPosition(m, who, {
      ...position,
      kind: "cash",
      name: "Spare",
      amount: 1000 * n,
    }),
  ).position.id;
  const bond = ok(
    await addPosition(m, who, {
      ...position,
      kind: "bond",
      portfolio: "Shares",
      name: "Made Up Bond",
      amount: 5000,
      cost: 4900,
      coupon: n,
      maturity: "2030-06-30",
    }),
  ).position.id;
  const fund = isinOf(`ZZ${user.toUpperCase().padEnd(9, "X")}`);
  ok(
    await addFundTrade(m, who, {
      isin: fund,
      name: `Made Up ${user} Fund`,
      market: null,
      trade: {
        ...base,
        quantity: 10,
        side: "buy",
        currency: "EUR",
      },
    }),
  );
  return { portfolio, broker, trade, cash, bond, fund };
}

function rowsOf(db: Db, owner: string): unknown {
  const q = (sql: string) => db.query(sql).all(owner);
  const theirs = "portfolio in (select id from portfolios where owner = ?)";
  return {
    portfolios: q("select * from portfolios where owner = ? order by id"),
    brokers: q("select * from brokers where owner = ? order by id"),
    trades: q(`select * from trades where ${theirs} order by id`),
    positions: q(`select * from positions where ${theirs} order by id`),
    settings: q("select * from portfolio_settings where owner = ?"),
    prices: q("select * from fund_prices where user_id = ? order by 1, 2"),
  };
}

async function setup() {
  const w = world();
  instrument(w.db, "US:AAA", { currency: "USD", name: "Alpha Made Up" });
  quote(w.db, "US:AAA", 120, 118);
  for (const [id, name] of [
    ["ana", "Ana"],
    ["jo", "Jo"],
    ["bea", "Bea"],
  ]) {
    w.db
      .query(
        "insert into users (id, name, role, created_at) values (?, ?, 'member', 0)",
      )
      .run(id, name);
  }
  const ids = { ana: await fill(w.m, "ana", 2), jo: await fill(w.m, "jo", 3) };
  const handle = api(w.m);
  const cookies: Record<string, string> = {};
  const send = (
    user: string | null,
    path: string,
    init: RequestInit = {},
  ): Promise<Response> => {
    if (user !== null) {
      cookies[user] ??= cookieFor(w.db, w.clock.now(), user, null);
    }
    const headers = new Headers(init.headers);
    if (user !== null) {
      headers.set("cookie", cookies[user]!);
      headers.set("sec-fetch-site", "same-origin");
    }
    if (init.body !== undefined)
      headers.set("content-type", "application/json");
    return handle(
      new Request(`http://markets.test${PREFIX}${path}`, { ...init, headers }),
    );
  };
  const share = (owner: string, viewer: string) =>
    send(owner, `/sharing/${viewer}`, { method: "PUT" });
  return { ...w, ids, send, share };
}

// the reads the Portfolios page draws from, aimed at the owner's ids
const reads = (o: Owned): string[] => [
  "/portfolios",
  "/holdings",
  "/holdings?currency=USD",
  `/portfolios/${o.portfolio}/holdings`,
  "/holdings/growth",
  `/portfolios/${o.portfolio}/growth`,
  "/trades?removed=true",
  `/trades?portfolio=${o.portfolio}&symbol=US:AAA`,
];

const withOwner = (path: string, owner: string) =>
  `${path}${path.includes("?") ? "&" : "?"}owner=${owner}`;

describe("a person sharing their portfolios", () => {
  test("lets a viewer read every portfolio read as the owner reads it", async () => {
    const t = await setup();
    expect((await t.share("ana", "jo")).status).toBe(200);
    for (const path of reads(t.ids.ana)) {
      const own = await t.send("ana", path);
      const seen = await t.send("jo", withOwner(path, "ana"));
      expect([path, seen.status]).toEqual([path, 200]);
      expect([path, await seen.text()]).toEqual([path, await own.text()]);
    }
    // in the owner's display currency and time zone, never the viewer's
    const list = await (
      await t.send("jo", withOwner("/portfolios", "ana"))
    ).json();
    expect(list).toMatchObject({
      display_currency: "EUR",
      time_zone: "Europe/Berlin",
    });
    // the owner names themself, as an owner's own id is no share
    const self = await t.send("ana", withOwner("/holdings", "ana"));
    expect(self.status).toBe(200);
  });

  test("answers 404 to a non-viewer, an ended share and a removed owner", async () => {
    const t = await setup();
    const missing = async (user: string, owner: string) => {
      for (const path of reads(t.ids.ana)) {
        const res = await t.send(user, withOwner(path, owner));
        expect([path, res.status]).toEqual([path, 404]);
        expect([path, await res.text()]).not.toContain("Made Up");
      }
    };
    await missing("jo", "ana");
    // a person who is not there reads the same as one who does not share
    await missing("jo", "nobody");
    await t.share("ana", "jo");
    // sharing goes one way
    await missing("ana", "jo");
    expect(
      (await t.send("ana", "/sharing/jo", { method: "DELETE" })).status,
    ).toBe(200);
    await missing("jo", "ana");
    await t.share("ana", "jo");
    await t.m.writer.write((db) => removeUserRows(db, "ana"));
    await missing("jo", "ana");
  });

  test("ends with a removed viewer", async () => {
    const t = await setup();
    await t.share("ana", "jo");
    await t.share("ana", "bea");
    await t.m.writer.write((db) => removeUserRows(db, "jo"));
    expect(
      t.db.query("select owner, viewer from portfolio_viewers").all(),
    ).toEqual([{ owner: "ana", viewer: "bea" }]);
  });

  test("refuses owner from a key, even its own person's", async () => {
    const t = await setup();
    await t.share("ana", "jo");
    const made = await t.m.writer.write((db) =>
      createKey(
        db,
        "jo",
        { name: "jo-agent", days: null, portfolio: "read" },
        0,
      ),
    );
    for (const token of [made.token, ADMIN_KEY]) {
      const bearer = { authorization: `Bearer ${token}` };
      for (const owner of ["ana", "jo", "operator"]) {
        const res = await t.send(null, withOwner("/holdings", owner), {
          headers: bearer,
        });
        expect([owner, res.status]).toEqual([owner, 403]);
      }
      // without owner the key reads its own person's
      expect(
        (await t.send(null, "/portfolios", { headers: bearer })).status,
      ).toBe(200);
      // the share is the web UI's: a key neither reads nor sets it
      for (const [path, method] of [
        ["/sharing", "GET"],
        ["/sharing/bea", "PUT"],
        ["/sharing/ana", "DELETE"],
      ] as const) {
        const res = await t.send(null, path, { method, headers: bearer });
        expect([path, method, res.status]).toEqual([path, method, 403]);
      }
    }
    expect(
      t.db.query("select count(*) as n from portfolio_viewers").get(),
    ).toEqual({ n: 1 });
  });

  test("never writes the owner's rows through owner", async () => {
    const t = await setup();
    await t.share("ana", "jo");
    const mine = t.ids.jo;
    const before = rowsOf(t.db, "ana");
    const jo = rowsOf(t.db, "jo");
    const list = routes({
      m: t.m,
      alerts: async () => new Response(),
      admin: { m: t.m, version: "v", sources: [], sync: true },
      world: NO_WORLD,
      log: silent,
    }).filter((r) => r.scope === "portfolio:write");
    const spare = await (
      await t.send("jo", "/portfolios?owner=ana", {
        method: "POST",
        body: JSON.stringify({ name: "Spare" }),
      })
    ).json();
    const csv = "Item,Amount (EUR),As Of,Note\nKept,10,2026-10-01,\n";
    // each aimed at the caller's own rows: one that took owner would miss
    // them or land in the owner's
    const cases: Record<string, [string, unknown?]> = {
      "POST /portfolios": ["/portfolios", { name: "Coins" }],
      "PATCH /portfolios/{id}": [
        `/portfolios/${mine.portfolio}`,
        { name: "Stocks" },
      ],
      "DELETE /portfolios/{id}": [`/portfolios/${spare.portfolio.id}`],
      "POST /portfolios/{id}/import": [
        `/portfolios/${mine.portfolio}/import`,
        { csv, confirm: true },
      ],
      "POST /trades": [
        "/trades",
        {
          portfolio: mine.portfolio,
          symbol: "US:AAA",
          side: "buy",
          quantity: 1,
          price: 1,
        },
      ],
      "DELETE /trades/{id}": [`/trades/${mine.trade}`],
      "POST /trades/{id}/restore": [`/trades/${mine.trade}/restore`],
      "POST /positions": [
        "/positions",
        { kind: "cash", name: "More", amount: 5, currency: "EUR" },
      ],
      "PATCH /positions/{id}": [`/positions/${mine.cash}`, { amount: 7 }],
      "DELETE /positions/{id}": [`/positions/${mine.bond}`],
      "POST /positions/{id}/restore": [`/positions/${mine.bond}/restore`],
      "POST /funds/trades": [
        "/funds/trades",
        {
          isin: mine.fund,
          portfolio: mine.portfolio,
          side: "buy",
          units: 1,
          price: 1,
        },
      ],
      "PATCH /funds/{isin}": [
        `/funds/${mine.fund}`,
        { price: 2, date: "2026-09-09" },
      ],
      "POST /brokers": ["/brokers", { name: "South" }],
      "PATCH /brokers/{id}": [`/brokers/${mine.broker}`, { name: "East" }],
      "DELETE /brokers/{id}": [
        "/brokers/0",
        // replaced below by the broker this run makes
      ],
      "PUT /portfolio-settings": [
        "/portfolio-settings",
        { display_currency: "GBP" },
      ],
    };
    // a route added later without a case here fails
    expect(
      list
        .map((r) => `${r.method} ${r.path}`)
        .filter((k) => cases[k] === undefined),
    ).toEqual([]);
    for (const r of list) {
      const k = `${r.method} ${r.path}`;
      let [path, body] = cases[k]!;
      if (k === "DELETE /brokers/{id}") {
        const south = t.db
          .query<{ id: number }, []>(
            "select id from brokers where owner = 'jo' and name = 'South'",
          )
          .get()!;
        path = `/brokers/${south.id}`;
      }
      const res = await t.send("jo", withOwner(path, "ana"), {
        method: r.method,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      expect([k, res.status, res.status < 400 ? "" : await res.text()]).toEqual(
        [k, res.status, ""],
      );
    }
    expect(rowsOf(t.db, "ana")).toEqual(before);
    expect(rowsOf(t.db, "jo")).not.toEqual(jo);
    expect(
      t.db
        .query("select name from portfolios where owner = 'jo' order by id")
        .all(),
    ).toEqual([{ name: "Cash" }, { name: "Stocks" }, { name: "Coins" }]);
  });
});

describe("GET /sharing", () => {
  test("lists everyone else, whom the caller shares with, and who shares with them", async () => {
    const t = await setup();
    await t.share("ana", "jo");
    await t.share("bea", "jo");
    await t.share("jo", "bea");
    expect(await (await t.send("jo", "/sharing")).json()).toEqual({
      people: [
        { id: "ana", name: "Ana", shared: false },
        { id: "bea", name: "Bea", shared: true },
        { id: "operator", name: "operator", shared: false },
      ],
      sharers: [
        { id: "ana", name: "Ana" },
        { id: "bea", name: "Bea" },
      ],
    });
  });

  test("sets a share idempotently, and refuses oneself and an unknown person", async () => {
    const t = await setup();
    for (let k = 0; k < 2; k++) {
      expect((await t.share("ana", "jo")).status).toBe(200);
    }
    const viewers = () =>
      t.db.query("select owner, viewer from portfolio_viewers").all();
    expect(viewers()).toEqual([{ owner: "ana", viewer: "jo" }]);
    for (let k = 0; k < 2; k++) {
      const res = await t.send("ana", "/sharing/jo", { method: "DELETE" });
      expect(res.status).toBe(200);
    }
    expect(viewers()).toEqual([]);
    const self = await t.send("ana", "/sharing/ana", { method: "PUT" });
    expect(self.status).toBe(400);
    for (const id of ["nobody", "NOT-AN-ID"]) {
      const res = await t.send("ana", `/sharing/${id}`, { method: "PUT" });
      expect([id, res.status]).toEqual([id, 404]);
    }
    expect(viewers()).toEqual([]);
  });
});
