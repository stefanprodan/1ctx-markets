// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// Two people on one server: every route and tool over a person's rows is
// run as one on the other's ids, and nothing of the other's shows or
// changes. Made-up people, names, funds and figures only.

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { saveDashboard } from "../src/admin/dashboard.ts";
import { alertsHandler } from "../src/api/alerts.ts";
import { PREFIX } from "../src/api/http.ts";
import { match, type Route, routes } from "../src/api/routes.ts";
import { createAlert, parseAlertsEdit } from "../src/operations/alerts.ts";
import { type Markets, markets } from "../src/operations/markets.ts";
import {
  addFundTrade,
  addPosition,
  addTrade,
  createBroker,
  createPortfolio,
  fundDetail,
  listAll,
  readGrowth,
  readHoldings,
  readTradeList,
  saveSettings,
  setTradeState,
  updateFund,
} from "../src/operations/portfolio.ts";
import { NO_WORLD } from "../src/operations/track.ts";
import { ADMIN, OPERATOR, type Who } from "../src/operations/who.ts";
import { fundPrices } from "../src/portfolios/funds.ts";
import { readProfile, saveProfile } from "../src/profile/store.ts";
import {
  deleteRule,
  insertAlert,
  pruneAlerts,
  readRules,
} from "../src/rules/store.ts";
import { DAY_MS } from "../src/runtime/clock.ts";
import { silent } from "../src/runtime/log.ts";
import { createKey, listKeys } from "../src/server/access.ts";
import { createLink } from "../src/server/links.ts";
import { openLogin } from "../src/server/session.ts";
import { isIsin } from "../src/shared/isin.ts";
import { fred } from "../src/sources/fred/client.ts";
import { yahoo } from "../src/sources/yahoo/client.ts";
import { type Db, migrate, open } from "../src/storage/db/index.ts";
import { MIGRATIONS } from "../src/storage/db/migrations/index.ts";
import { writer } from "../src/storage/writer.ts";
import { call, tools } from "../src/tools/index.ts";
import { api, cookieFor } from "./helpers/api.ts";
import { mcpClient, seedKey, withApp } from "./helpers/app.ts";
import { fakeClock } from "./helpers/clock.ts";
import { instrument, NOW, quote, world } from "./helpers/world.ts";

const SECOND = "second";

const PRICE_BELOW = JSON.stringify({
  left: { field: "price", symbol: "US:AAA" },
  op: "<",
  right: 1,
});

const noNetwork = async (url: string): Promise<Response> => {
  throw new Error(`no network in tests: ${url}`);
};

const as = (user: string, name: string): Who => ({
  name,
  user,
  credential: { kind: "key", id: name },
  portfolio: "write",
  alerts: "write",
  profile: "write",
  analysis: "none",
});

// a made-up ISIN: the body and the one check digit that fits it
const isinOf = (body: string): string =>
  [..."0123456789"].map((d) => body + d).find(isIsin)!;

const SHARED = isinOf("ZZSHAREDFND");

// the answer, or the test fails with its refusal
function ok<T>(v: T): Exclude<T, { error: unknown }> {
  if (typeof v === "object" && v !== null && "error" in v) {
    throw new Error(String((v as { message?: unknown }).message));
  }
  return v as Exclude<T, { error: unknown }>;
}

function addUser(db: Db, id: string): void {
  db.query(
    "insert into users (id, name, role, created_at) values (?, ?, 'member', 0)",
  ).run(id, id);
}

// the ids a person's rows got, so the other can be pointed at them
type Owned = {
  portfolio: number;
  broker: number;
  trade: number;
  cash: number;
  bond: number;
  fund: string;
  rule: number;
  key: string;
  // the live profile revision
  revision: number;
  // a listing only this person's rule and dashboard name
  sym: string;
};

// every kind of row a person has, each text holding their mark, so an
// answer quoting any of it is caught
async function fill(m: Markets, who: Who, mark: string): Promise<Owned> {
  const owner = who.user;
  await saveSettings(m, owner, {
    display_currency: "EUR",
    time_zone: "Europe/Berlin",
  });
  // the same names for both: names are unique per person
  const portfolio = ok(await createPortfolio(m, owner, { name: "Shares" }))
    .portfolio.id;
  const broker = ok(await createBroker(m, owner, { name: "North" })).broker.id;
  const base = {
    portfolio: "Shares",
    price: 100,
    total: null,
    fees: 0,
    date: "2026-01-05",
    currency: null,
    broker: "North",
  };
  const trade = ok(
    await addTrade(m, who, {
      ...base,
      symbol: "US:AAA",
      side: "buy",
      quantity: 2,
      note: `${mark} trade`,
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
    note: mark,
    dryPowder: false,
  };
  const cash = ok(
    await addPosition(m, who, {
      ...position,
      kind: "cash",
      name: `${mark} cash`,
      amount: 1000,
    }),
  ).position.id;
  const bond = ok(
    await addPosition(m, who, {
      ...position,
      kind: "bond",
      portfolio: "Shares",
      name: `${mark} bond`,
      amount: 5000,
      cost: 4900,
      coupon: 4,
      maturity: "2030-06-30",
    }),
  ).position.id;
  const fund = isinOf(`ZZ${mark.toUpperCase().padEnd(9, "X").slice(0, 9)}`);
  const trade1 = { ...base, quantity: 10, side: "buy" as const };
  ok(
    await addFundTrade(m, who, {
      isin: fund,
      name: `${mark} fund`,
      market: null,
      trade: { ...trade1, currency: "EUR", note: mark },
    }),
  );
  ok(
    await addFundTrade(m, who, {
      isin: SHARED,
      name: owner === OPERATOR ? "Shared Made Up Fund" : null,
      market: null,
      trade: { ...trade1, currency: "EUR", note: mark },
    }),
  );
  // revisions are numbered per person: three for the operator, one for
  // the second, so the operator's third is no one else's
  const text = `# ${mark} profile\n- Horizon: 5 years\n`;
  const revisions = owner === OPERATOR ? 3 : 1;
  for (let n = 0; n < revisions; n++) {
    ok(
      await saveProfile(
        m.writer,
        owner,
        {
          action: "replace",
          revision: n === 0 ? null : n,
          text: `${text}${"- More\n".repeat(n)}`,
        },
        who.name,
        m.clock.now(),
      ),
    );
  }
  // a listing only this person's rule and dashboard track, so a list row
  // naming why it is tracked would tell
  const sym = owner === OPERATOR ? "US:BBB" : "US:CCC";
  const saved = await saveDashboard(m, owner, NO_WORLD, {
    revision: 0,
    sections: [
      { name: `${mark} board`, view: "cards", symbols: ["US:AAA", sym] },
    ],
  });
  expect(saved.status).toBe(200);
  const args = parseAlertsEdit({
    action: "create",
    symbol: "US:AAA",
    when: "price < 1",
    note: `${mark} rule`,
  });
  if (args.action !== "create") throw new Error("not a create");
  const rule = ok(await createAlert(m, owner, args)).alert.id;
  const own = parseAlertsEdit({
    action: "create",
    symbol: sym,
    when: "price < 1",
  });
  if (own.action !== "create") throw new Error("not a create");
  ok(await createAlert(m, owner, own));
  await m.writer.write((db) =>
    insertAlert(
      db,
      { id: rule, owner },
      {
        rule: {
          id: rule,
          symbol: "US:AAA",
          condition: JSON.parse(PRICE_BELOW),
          note: mark,
        },
        values: [],
      },
      m.clock.now(),
    ),
  );
  const key = await m.writer.write(
    (db) => createKey(db, owner, { name: `${mark}-key`, days: null }, 0).key.id,
  );
  return {
    portfolio,
    broker,
    trade,
    cash,
    bond,
    fund,
    rule,
    key,
    revision: revisions,
    sym,
  };
}

// the listings both people read; US:BBB is the operator's alone to track,
// US:CCC the second person's
function listings(db: Db): void {
  for (const [id, name] of [
    ["US:AAA", "Alpha Made Up"],
    ["US:BBB", "Beta Made Up"],
    ["US:CCC", "Gamma Made Up"],
  ] as const) {
    instrument(db, id, { currency: "USD", name });
    quote(db, id, 120, 118);
  }
}

async function two() {
  const w = world();
  listings(w.db);
  addUser(w.db, SECOND);
  const op = as(OPERATOR, "op-agent");
  const second = as(SECOND, "second-agent");
  const ids = {
    [OPERATOR]: await fill(w.m, op, "zzop"),
    [SECOND]: await fill(w.m, second, "zzsec"),
  };
  return { ...w, op, second, ids };
}

// every row a person owns, as stored
function rowsOf(db: Db, owner: string): unknown {
  const q = (sql: string) => db.query(sql).all(owner);
  const theirs = "portfolio in (select id from portfolios where owner = ?)";
  return {
    portfolios: q("select * from portfolios where owner = ? order by id"),
    brokers: q("select * from brokers where owner = ? order by id"),
    trades: q(`select * from trades where ${theirs} order by id`),
    positions: q(`select * from positions where ${theirs} order by id`),
    settings: q("select * from portfolio_settings where owner = ?"),
    profile: q("select * from profile_versions where owner = ? order by 2"),
    dashboard: q("select * from dashboards where owner = ?"),
    sections: q("select * from dashboard_sections where owner = ?"),
    items: q("select * from dashboard_items where owner = ?"),
    rules: q("select * from rules where owner = ? order by id"),
    alerts: q("select * from alerts where owner = ? order by id"),
    keys: q("select * from keys where user_id = ? order by id"),
    prices: q("select * from fund_prices where user_id = ? order by 1, 2"),
  };
}

const routeList = (m: Markets): Route[] =>
  routes({
    m,
    alerts: alertsHandler({ db: m.db, log: silent }),
    admin: { m, version: "v0.0.0-test", sources: [], sync: true },
    world: NO_WORLD,
    log: silent,
  });

// a person's rows: the scoped areas, and the dashboard and keys, which
// only the admin reaches today; and the instrument reads, whose rows say
// what tracks a listing from every person's rules and dashboards
const owned = (r: Route) =>
  /^(portfolio|alerts|profile):/.test(r.scope) ||
  r.path.startsWith("/dashboard") ||
  r.path.startsWith("/keys") ||
  r.path === "/screener" ||
  (r.method === "GET" &&
    /^\/instruments(\/\{symbol\})?(\/stored)?$/.test(r.path));

// every list row in an answer for this listing, wherever it sits
function rowsFor(body: unknown, id: string): { tracked_by?: string[] }[] {
  if (Array.isArray(body)) return body.flatMap((x) => rowsFor(x, id));
  if (typeof body !== "object" || body === null) return [];
  const here = (body as { id?: unknown }).id === id ? [body as object] : [];
  return [...here, ...Object.values(body).flatMap((x) => rowsFor(x, id))];
}

type Case = { path: string; body?: unknown; missing?: boolean };

// one request per route, aimed at the other person's ids; missing: it names
// one of their rows, so it answers 404
function cases(other: Owned, mine: Owned): Record<string, Case> {
  const csv = "Item,Amount,Currency\nSpare,10,EUR\n";
  return {
    "GET /alerts": { path: "/alerts" },
    "POST /alerts": {
      path: "/alerts",
      body: { symbol: "US:AAA", when: "price > 1000" },
    },
    "GET /alerts/{id}": { path: `/alerts/${other.rule}`, missing: true },
    "PATCH /alerts/{id}": {
      path: `/alerts/${other.rule}`,
      body: { paused: true },
      missing: true,
    },
    "DELETE /alerts/{id}": { path: `/alerts/${other.rule}`, missing: true },
    "GET /alerts/feed": { path: "/alerts/feed" },
    "GET /alerts/history": { path: "/alerts/history" },
    "GET /portfolios": { path: "/portfolios" },
    "POST /portfolios": { path: "/portfolios", body: { name: "Coins" } },
    "GET /portfolios/{id}": {
      path: `/portfolios/${other.portfolio}`,
      missing: true,
    },
    "PATCH /portfolios/{id}": {
      path: `/portfolios/${other.portfolio}`,
      body: { name: "Taken", position: 1 },
      missing: true,
    },
    "DELETE /portfolios/{id}": {
      path: `/portfolios/${other.portfolio}`,
      missing: true,
    },
    "GET /portfolios/{id}/holdings": {
      path: `/portfolios/${other.portfolio}/holdings`,
      missing: true,
    },
    "GET /holdings": { path: "/holdings" },
    "GET /portfolios/{id}/growth": {
      path: `/portfolios/${other.portfolio}/growth`,
      missing: true,
    },
    "GET /holdings/growth": { path: "/holdings/growth" },
    "GET /holdings/net-worth": { path: "/holdings/net-worth" },
    "GET /portfolios/{id}/export": {
      path: `/portfolios/${other.portfolio}/export`,
      missing: true,
    },
    "POST /portfolios/{id}/import": {
      path: `/portfolios/${other.portfolio}/import`,
      body: { csv, confirm: true },
      missing: true,
    },
    "GET /trades": { path: "/trades?removed=true" },
    "POST /trades": {
      path: "/trades",
      body: {
        portfolio: other.portfolio,
        symbol: "US:AAA",
        side: "buy",
        quantity: 1,
        price: 1,
      },
      missing: true,
    },
    "DELETE /trades/{id}": { path: `/trades/${other.trade}`, missing: true },
    "POST /trades/{id}/restore": {
      path: `/trades/${other.trade}/restore`,
      missing: true,
    },
    "GET /positions": { path: "/positions?removed=true" },
    "POST /positions": {
      path: "/positions",
      body: {
        kind: "bond",
        portfolio: other.portfolio,
        name: "Made Up Bond",
        amount: 100,
        currency: "EUR",
      },
      missing: true,
    },
    "PATCH /positions/{id}": {
      path: `/positions/${other.cash}`,
      body: { amount: 1 },
      missing: true,
    },
    "DELETE /positions/{id}": {
      path: `/positions/${other.bond}`,
      missing: true,
    },
    "POST /positions/{id}/restore": {
      path: `/positions/${other.bond}/restore`,
      missing: true,
    },
    "GET /positions/{id}/history": {
      path: `/positions/${other.cash}/history`,
      missing: true,
    },
    "GET /funds": { path: "/funds" },
    "POST /funds/trades": {
      path: "/funds/trades",
      body: {
        isin: SHARED,
        portfolio: other.portfolio,
        side: "buy",
        units: 1,
        price: 1,
      },
      missing: true,
    },
    "GET /funds/{isin}": { path: `/funds/${other.fund}`, missing: true },
    "PATCH /funds/{isin}": {
      path: `/funds/${other.fund}`,
      body: { price: 1, date: "2026-09-09" },
      missing: true,
    },
    "GET /brokers": { path: "/brokers" },
    "POST /brokers": { path: "/brokers", body: { name: "South" } },
    "PATCH /brokers/{id}": {
      path: `/brokers/${other.broker}`,
      body: { name: "East" },
      missing: true,
    },
    "DELETE /brokers/{id}": { path: `/brokers/${other.broker}`, missing: true },
    "GET /portfolio-settings": { path: "/portfolio-settings" },
    "PUT /portfolio-settings": {
      path: "/portfolio-settings",
      body: { display_currency: "USD", time_zone: "Asia/Tokyo" },
    },
    "GET /profile": { path: "/profile" },
    "PUT /profile": {
      path: "/profile",
      body: { revision: mine.revision, text: "# Made up\n" },
    },
    "POST /profile/preview": {
      path: "/profile/preview",
      body: { text: "# Made up\n" },
    },
    "GET /profile/versions": { path: "/profile/versions" },
    // the caller's own revision of that number, once PUT made one, is
    // theirs to read
    "GET /profile/versions/{revision}": {
      path: `/profile/versions/${other.revision}`,
      missing: mine.revision + 1 < other.revision,
    },
    "GET /dashboard": { path: "/dashboard" },
    "PUT /dashboard": {
      path: "/dashboard",
      body: {
        revision: 1,
        sections: [{ name: "Made up", view: "table", symbols: ["US:AAA"] }],
      },
    },
    "GET /keys": { path: "/keys" },
    "POST /keys": { path: "/keys", body: { name: "made-up-key" } },
    "PATCH /keys/{id}": {
      path: `/keys/${other.key}`,
      body: { portfolio: "read" },
      missing: true,
    },
    "DELETE /keys/{id}": { path: `/keys/${other.key}`, missing: true },
    "GET /instruments": { path: "/instruments" },
    "GET /instruments/{symbol}": { path: `/instruments/${other.sym}` },
    "GET /instruments/{symbol}/stored": {
      path: `/instruments/${other.sym}/stored`,
    },
    "GET /screener": { path: "/screener" },
  };
}

async function routeAs(
  list: readonly Route[],
  who: Who,
  method: string,
  c: Case,
): Promise<Response> {
  const url = new URL(`http://localhost${PREFIX}${c.path}`);
  const found = match(list, url.pathname.slice(PREFIX.length))!;
  const r = found.routes.find((x) => x.method === method)!;
  const req = new Request(url, {
    method,
    ...(c.body === undefined
      ? {}
      : {
          body: JSON.stringify(c.body),
          headers: { "content-type": "application/json" },
        }),
  });
  return r.handle(req, url, found.params, who);
}

// a tool call as an agent sends it, aimed at the other person's ids
function toolCases(
  mine: Owned,
  other: Owned,
): Record<string, { args: object; missing?: boolean }[]> {
  return {
    portfolio: [
      { args: { action: "list" } },
      { args: { action: "holdings", removed: true } },
      { args: { action: "trades", removed: true } },
      {
        args: { action: "trades", portfolio: other.portfolio },
        missing: true,
      },
    ],
    portfolio_trade: [
      { args: { action: "remove", trade: other.trade }, missing: true },
      { args: { action: "restore", trade: other.trade }, missing: true },
      {
        args: {
          action: "add",
          portfolio: other.portfolio,
          symbol: "US:AAA",
          side: "buy",
          quantity: 1,
          price: 1,
        },
        missing: true,
      },
    ],
    portfolio_cash: [
      {
        args: { action: "update", position: other.cash, amount: 1 },
        missing: true,
      },
      { args: { action: "remove", position: other.cash }, missing: true },
      { args: { action: "restore", position: other.cash }, missing: true },
    ],
    portfolio_bond: [
      {
        args: { action: "update", position: other.bond, amount: 1 },
        missing: true,
      },
      { args: { action: "remove", position: other.bond }, missing: true },
      { args: { action: "restore", position: other.bond }, missing: true },
    ],
    portfolio_fund: [
      { args: { isin: other.fund, price: 1 }, missing: true },
      { args: { isin: SHARED, price: 3, date: "2026-09-09" } },
    ],
    portfolio_setup: [
      {
        args: {
          action: "setup",
          display_currency: "EUR",
          portfolio: "Shares",
          broker: ["North", "West"],
        },
      },
      { args: { action: "rename_broker", broker: "West", name: "Far" } },
    ],
    profile: [
      { args: { action: "read" } },
      { args: { action: "versions" } },
      {
        args: { action: "version", revision: other.revision },
        missing: mine.revision < other.revision,
      },
    ],
    profile_edit: [
      {
        args: {
          action: "edit",
          revision: mine.revision,
          edits: [{ old: "5 years", new: "6 years" }],
        },
      },
    ],
    alerts: [
      { args: {} },
      { args: { history: true } },
      { args: { id: other.rule }, missing: true },
    ],
    alerts_edit: [
      { args: { action: "pause", id: other.rule }, missing: true },
      {
        args: { action: "update", id: other.rule, note: "x" },
        missing: true,
      },
      { args: { action: "delete", id: other.rule }, missing: true },
    ],
  };
}

const PEOPLE = [
  { actor: SECOND, victim: OPERATOR, mark: "zzop" },
  { actor: OPERATOR, victim: SECOND, mark: "zzsec" },
] as const;

describe("two people on one server", () => {
  for (const { actor, victim, mark } of PEOPLE) {
    test(`every route over a person's rows, as ${actor} on ${victim}'s ids, shows and changes none of them`, async () => {
      const t = await two();
      // as members: an admin lists and revokes anyone's keys by design,
      // tested apart below
      t.db.query("update users set role = 'member'").run();
      const who = actor === OPERATOR ? t.op : t.second;
      const list = routeList(t.m);
      const table = cases(t.ids[victim]!, t.ids[actor]!);
      const keys = list.filter(owned).map((r) => `${r.method} ${r.path}`);
      // a route added later without a case here fails, so its filter is
      // checked too
      expect(keys.filter((k) => table[k] === undefined)).toEqual([]);
      const before = rowsOf(t.db, victim);
      for (const k of keys) {
        const c = table[k]!;
        const res = await routeAs(list, who, k.split(" ")[0]!, c);
        const text = await res.text();
        expect([k, text.includes(mark)]).toEqual([k, false]);
        // the other's listing is tracked, never said why
        const named = rowsFor(
          res.headers.get("content-type")?.includes("json")
            ? JSON.parse(text)
            : null,
          t.ids[victim]!.sym,
        ).flatMap((r) => r.tracked_by ?? []);
        expect([k, named.filter((b) => b !== "read")]).toEqual([k, []]);
        if (c.missing) expect([k, res.status]).toEqual([k, 404]);
        else expect([k, res.status < 400]).toEqual([k, true]);
      }
      expect(rowsOf(t.db, victim)).toEqual(before);
    });

    test(`every tool over a person's rows, as ${actor} on ${victim}'s ids, shows and changes none of them`, async () => {
      const t = await two();
      const who = actor === OPERATOR ? t.op : t.second;
      const table = toolCases(t.ids[actor]!, t.ids[victim]!);
      const list = tools(t.m).filter((x) =>
        /^(portfolio|profile|alerts)/.test(x.name),
      );
      expect(list.map((x) => x.name).filter((n) => !table[n])).toEqual([]);
      const before = rowsOf(t.db, victim);
      for (const tool of list) {
        for (const c of table[tool.name]!) {
          const r = await call(t.m, tool, c.args, who);
          const text = r.content[0]!.text;
          const said = [tool.name, c.args];
          expect([...said, text.includes(mark)]).toEqual([...said, false]);
          if (c.missing) {
            expect([...said, JSON.parse(text).error]).toEqual([
              ...said,
              "not_found",
            ]);
          } else
            expect([...said, r.isError === true]).toEqual([...said, false]);
        }
      }
      expect(rowsOf(t.db, victim)).toEqual(before);
    });
  }

  test("names are per person, and each person has one Cash", async () => {
    const t = await two();
    const names = t.db
      .query(
        "select owner, name, cash from portfolios order by owner, cash desc",
      )
      .all();
    expect(names).toEqual([
      { owner: OPERATOR, name: "Cash", cash: 1 },
      { owner: OPERATOR, name: "Shares", cash: 0 },
      { owner: SECOND, name: "Cash", cash: 1 },
      { owner: SECOND, name: "Shares", cash: 0 },
    ]);
    expect(() =>
      t.db.exec(
        `insert into portfolios (owner, name, created_at)
         values ('second', 'shares', 0)`,
      ),
    ).toThrow();
    expect(() =>
      t.db.exec(
        `insert into portfolios (owner, name, cash, created_at)
         values ('second', 'Other cash', 1, 0)`,
      ),
    ).toThrow();
    expect(() =>
      t.db.exec(
        "insert into brokers (owner, name, created_at) values ('second', 'north', 0)",
      ),
    ).toThrow();
  });
});

test("deleting an instrument another person's rule reads is refused without naming the rule", async () => {
  const t = await two();
  const list = routeList(t.m);
  const del = () =>
    routeAs(list, ADMIN, "DELETE", { path: "/instruments/US:AAA" });
  const own = t.ids[OPERATOR]!.rule;
  let res = await del();
  expect(res.status).toBe(409);
  expect(await res.json()).toMatchObject({ rules: [own] });
  await t.m.writer.write((db) => deleteRule(db, OPERATOR, own));
  res = await del();
  expect(res.status).toBe(409);
  expect(await res.json()).toMatchObject({
    detail: "another person's alerts read this instrument",
    rules: [],
  });
  await t.m.writer.write((db) => deleteRule(db, SECOND, t.ids[SECOND]!.rule));
  // the second person's trades still hold it, counted, never named
  res = await del();
  expect(res.status).toBe(409);
  expect(await res.json()).toMatchObject({ rules: [] });
});

test("each key reaches its own person's rows over MCP and REST, per request", () =>
  withApp(async (t) => {
    addUser(t.db, SECOND);
    const access = {
      portfolio: "write",
      alerts: "write",
      profile: "write",
    } as const;
    const mine = seedKey(t, "op-agent", access);
    const theirs = seedKey(t, "second-agent", {
      ...access,
      user: SECOND,
    });
    const setup = (token: string, name: string) =>
      fetch(`${t.url}/api/v1/portfolio-settings`, {
        method: "PUT",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ display_currency: name }),
      });
    expect((await setup(mine, "EUR")).status).toBe(200);
    expect((await setup(theirs, "USD")).status).toBe(200);
    const a = await mcpClient(t, mine);
    const b = await mcpClient(t, theirs);
    // both in flight at once: neither reads the other's person
    const [x, y] = await Promise.all(
      [a, b].map((c) =>
        c.callTool({ name: "portfolio", arguments: { action: "list" } }),
      ),
    );
    const shown = (r: unknown) =>
      JSON.parse((r as { content: { text: string }[] }).content[0]!.text)
        .display_currency;
    expect([shown(x), shown(y)]).toEqual(["EUR", "USD"]);
    await a.close();
    await b.close();
  }));

describe("alerts per person", () => {
  test("triggers kept after their alert is deleted stay their owner's", async () => {
    const t = await two();
    const rule = t.ids[SECOND]!.rule;
    expect(await t.m.writer.write((db) => deleteRule(db, SECOND, rule))).toBe(
      true,
    );
    expect(readRules(t.db, SECOND).map((r) => r.id)).not.toContain(rule);
    const feed = alertsHandler({ db: t.db, log: silent });
    const read = async (owner: string) =>
      (
        (await (
          await feed(new Request("http://localhost/api/v1/alerts/feed"), owner)
        ).json()) as { triggers: { alert_id: number; note: string }[] }
      ).triggers;
    expect(await read(SECOND)).toEqual([
      expect.objectContaining({ alert_id: rule, note: "zzsec" }),
    ]);
    expect((await read(OPERATOR)).map((a) => a.note)).toEqual(["zzop"]);
  });

  test("another person's alerts between one's ids read as nothing lost, a pruned own one as a gap", async () => {
    const clock = fakeClock(NOW);
    const { db } = open(":memory:", clock);
    addUser(db, SECOND);
    const fire = (owner: string, at: number) =>
      insertAlert(
        db,
        { id: 1, owner },
        {
          rule: {
            id: 1,
            symbol: "US:AAA",
            condition: JSON.parse(PRICE_BELOW),
            note: null,
          },
          values: [],
        },
        at,
      );
    const old = NOW - 100 * DAY_MS;
    const a = fire(OPERATOR, NOW);
    fire(SECOND, old);
    fire(SECOND, NOW);
    const b = fire(OPERATOR, NOW);
    const feed = alertsHandler({ db, log: silent });
    const get = (owner: string, cursor: number) =>
      feed(
        new Request("http://localhost/api/v1/alerts/feed", {
          headers: { "if-none-match": `W/"alerts-${cursor}"` },
        }),
        owner,
      );
    const body = async (res: Response) =>
      (await res.json()) as {
        retention_gap?: true;
        triggers: { id: number }[];
      };
    const seen = await body(await get(OPERATOR, a));
    expect(seen.retention_gap).toBeUndefined();
    expect(seen.triggers.map((x) => x.id)).toEqual([b]);
    // the second person's first alert is pruned: theirs reads as lost,
    // the operator's never
    expect(pruneAlerts(db, NOW)).toBe(1);
    expect((await body(await get(SECOND, 0))).retention_gap).toBe(true);
    expect((await get(OPERATOR, b)).status).toBe(304);
    db.close();
  });
});

test("the alerts feed answers alike whatever another person's alert count", async () => {
  const clock = fakeClock(NOW);
  const { db } = open(":memory:", clock);
  addUser(db, SECOND);
  const fire = (owner: string) =>
    insertAlert(
      db,
      { id: 1, owner },
      {
        rule: {
          id: 1,
          symbol: "US:AAA",
          condition: JSON.parse(PRICE_BELOW),
          note: null,
        },
        values: [],
      },
      NOW,
    );
  const mine = fire(SECOND);
  for (let n = 0; n < 10; n++) fire(OPERATOR);
  const feed = alertsHandler({ db, log: silent });
  const answer = async (cursor: number) => {
    const res = await feed(
      new Request("http://localhost/api/v1/alerts/feed", {
        headers: { "if-none-match": `W/"alerts-${cursor}"` },
      }),
      SECOND,
    );
    return [res.status, res.headers.get("etag")];
  };
  // at their own last id: unchanged; past it, by any amount: started
  // over from their first alert
  expect(await answer(mine)).toEqual([304, `W/"alerts-${mine}"`]);
  const past = await Promise.all([2, 5, 11, 12, 13].map(answer));
  expect(new Set(past.map((x) => JSON.stringify(x))).size).toBe(1);
  expect(past[0]).toEqual([200, `W/"alerts-${mine}"`]);
  db.close();
});

describe("a fund two people hold", () => {
  test("each sees only their own trades and no other's author on a price", async () => {
    const t = await two();
    ok(
      await updateFund(t.m, t.second, SHARED, { price: 9, date: "2026-02-01" }),
    );
    for (const [owner, mark, other] of [
      [OPERATOR, "zzop", "zzsec"],
      [SECOND, "zzsec", "zzop"],
    ] as const) {
      const d = ok(fundDetail(t.m, owner, SHARED)) as {
        trades: { note: string; entered_by: string }[];
        prices: { trade: number | null; entered_by: string | null }[];
      };
      expect(d.trades.map((x) => x.note)).toEqual([mark]);
      expect(JSON.stringify(d)).not.toContain(other);
      // the day both bought is priced by the later buy, the second
      // person's, as is the price entered by hand
      for (const p of d.prices) {
        if (owner === OPERATOR) {
          expect(p).toMatchObject({ trade: null, entered_by: null });
        } else expect(p.entered_by).toBe("second-agent");
      }
    }
  });

  test("a person who never held or priced it is refused a price", async () => {
    const t = await two();
    addUser(t.db, "third");
    const third = as("third", "third-agent");
    const done = await updateFund(t.m, third, SHARED, { price: 1 });
    expect(done).toMatchObject({ error: "not_found" });
    expect(fundDetail(t.m, "third", SHARED)).toMatchObject({
      error: "not_found",
    });
  });

  test("a currency change is refused over another person's live trade", async () => {
    const t = await two();
    const own = t.db
      .query<{ id: number }, [string]>(
        `select t.id from trades t join portfolios p on p.id = t.portfolio
         where t.instrument = ? and p.owner = 'operator'`,
      )
      .all(`fund:${SHARED}`);
    for (const { id } of own) ok(await setTradeState(t.m, t.op, id, true));
    const done = await updateFund(t.m, t.op, SHARED, { currency: "USD" });
    expect(done).toMatchObject({ error: "bad_arguments" });
  });

  test("a price its buy set stays when that person's rows are deleted", async () => {
    const t = await two();
    const fund = `fund:${SHARED}`;
    const before = fundPrices(t.db, fund);
    expect(before.map((p) => p.user)).toEqual([SECOND]);
    // the second person's buy stands for the day; removing the person
    // deletes their trades, never the shared price
    t.db.exec(`
      delete from trades where portfolio in
        (select id from portfolios where owner = 'second');
    `);
    expect(fundPrices(t.db, fund).map((p) => [p.date, p.price])).toEqual(
      before.map((p) => [p.date, p.price]),
    );
    expect(fundPrices(t.db, fund)[0]!.trade).toBeNull();
  });
});

test("every bond, holding and growth figure is the same with another person's rows present", async () => {
  const alone = world();
  listings(alone.db);
  await fill(alone.m, as(OPERATOR, "op-agent"), "zzop");
  const t = await two();
  // the second person's bonds on the same days, and more of them
  ok(
    await addPosition(t.m, t.second, {
      kind: "bond",
      portfolio: "Shares",
      name: "Made Up Later",
      symbol: null,
      currency: "EUR",
      amount: 7000,
      cost: 6800,
      coupon: 3,
      maturity: "2031-01-31",
      date: "2026-02-01",
      broker: null,
      note: null,
      dryPowder: false,
    }),
  );
  for (const read of [
    (m: Markets) =>
      readHoldings(m, OPERATOR, {
        portfolio: null,
        broker: null,
        currency: null,
      }),
    (m: Markets) =>
      readHoldings(m, OPERATOR, {
        portfolio: "Shares",
        broker: "North",
        currency: "EUR",
      }),
    async (m: Markets) =>
      readGrowth(m, OPERATOR, { portfolio: null, currency: null }),
    async (m: Markets) =>
      readGrowth(m, OPERATOR, { portfolio: "Shares", currency: null }),
  ]) {
    expect(await read(t.m)).toEqual(await read(alone.m));
  }
});

describe("the migration that gives every row an owner", () => {
  test("keeps every row and id, the operator's, answered as before, with no broken reference", async () => {
    const clock = fakeClock(NOW);
    const db = new Database(":memory:", { strict: true });
    db.exec("pragma foreign_keys = on");
    const at = MIGRATIONS.findIndex((x) => x.id === "0036-owners");
    migrate(db, clock, MIGRATIONS.slice(0, at));
    db.exec(`
      insert into instruments (id, market, symbol, source, source_symbol,
        exchange, name, type, currency, unit, zone, added_at, updated_at)
      values ('US:AAA', 'US', 'AAA', 'yahoo', 'AAA', 'NMS', 'Alpha', 'EQUITY',
        'USD', 'per_share', 'America/New_York', 0, 0),
        ('fund:${SHARED}', 'fund', '${SHARED}', 'owner', '${SHARED}', '',
        'Made Up Fund', 'FUND', 'EUR', 'per_share', 'UTC', 0, 0);
      insert into portfolio_settings (owner, display_currency, updated_at,
        time_zone)
        values ('admin', 'EUR', 1, 'Europe/Berlin');
      insert into portfolios (name, cash, created_at, position)
        values ('Cash', 1, 1, 0), ('Shares', 0, 1, 1), ('Gone', 0, 1, 2);
      delete from portfolios where name = 'Gone';
      insert into brokers (name, created_at) values ('North', 1);
      insert into trades (portfolio, instrument, side, date, quantity, price,
        currency, broker, note, entered_by, entered_at)
      values (2, 'US:AAA', 'buy', '2026-01-05', 2, 100, 'USD', 1, 'kept', 'web', 1),
        (2, 'fund:${SHARED}', 'buy', '2026-01-05', 3, 10, 'EUR', 1, null, 'web', 1);
      insert into positions (portfolio, kind, name, currency, amount, as_of,
        entered_by, entered_at)
      values (1, 'cash', 'Spare', 'EUR', 10, '2026-01-05', 'web', 1);
      insert into funds (instrument, entered_by, entered_at)
        values ('fund:${SHARED}', 'web', 1);
      insert into fund_prices (instrument, date, price, trade, entered_by,
        entered_at)
      values ('fund:${SHARED}', '2026-01-05', 10, 2, 'web', 1),
        ('fund:${SHARED}', '2026-01-06', 11, null, 'admin', 1);
      insert into profile_versions (revision, text, bytes, author, created_at)
        values (3, '# Made up', 9, 'web', 1);
      insert into dashboards (owner, revision, updated_at)
        values ('operator', 2, 1);
      insert into dashboard_sections (owner, position, name, view)
        values ('operator', 0, 'A', 'cards');
      insert into dashboard_items (owner, section, position, instrument)
        values ('operator', 0, 0, 'US:AAA');
      insert into rules (instrument, condition, created_at)
        values ('US:AAA', '${PRICE_BELOW}', 1), ('US:AAA', '${PRICE_BELOW}', 1),
          ('US:AAA', '${PRICE_BELOW}', 1);
      delete from rules where id = 3;
      insert into alerts (rule_id, fired_at, snapshot)
        values (1, 1, '{}'), (1, 2, '{}'), (2, 3, '{}');
      delete from alerts where id = 1;
      insert into keys (id, name, token_hash, created_at, portfolio)
        values ('madeupkey001', 'made-up', 'ab', 1, 'read');
    `);
    const tables = [
      "portfolios",
      "brokers",
      "trades",
      "positions",
      "funds",
      "fund_prices",
      "portfolio_settings",
      "profile_versions",
      "dashboards",
      "dashboard_sections",
      "dashboard_items",
      "rules",
      "alerts",
      "keys",
    ];
    // every column but the owner's, new or renamed from 'admin'; the
    // dashboard's was the operator's already
    const kept = () =>
      Object.fromEntries(
        tables.map((x) => [
          x,
          db
            .query(`select * from ${x} order by 1, 2`)
            .all()
            .map((r) => {
              const o = { ...(r as Record<string, unknown>) };
              if (!x.startsWith("dashboard")) {
                delete o.owner;
                delete o.user_id;
              }
              // columns later migrations add
              delete o.past_of;
              delete o.analysis;
              delete o.fired_session;
              // a later migration renames the key's rules access
              if (x === "keys" && "alerts" in o) {
                o.rules = o.alerts;
                delete o.alerts;
              }
              return o;
            }),
        ]),
      );
    const seq = () =>
      db.query("select name, seq from sqlite_sequence order by name").all();
    const before = { rows: kept(), seq: seq() };
    migrate(db, clock);
    expect(kept()).toEqual(before.rows);
    expect(seq()).toEqual(before.seq);
    expect(db.query("pragma foreign_key_check").all()).toEqual([]);
    expect(db.query("pragma foreign_keys").get()).toEqual({ foreign_keys: 1 });
    expect(db.query("select id, role from users").all()).toEqual([
      { id: OPERATOR, role: "admin" },
    ]);
    for (const [table, column] of [
      ["portfolios", "owner"],
      ["brokers", "owner"],
      ["portfolio_settings", "owner"],
      ["dashboards", "owner"],
      ["rules", "owner"],
      ["alerts", "owner"],
      ["keys", "user_id"],
      ["profile_versions", "owner"],
      ["fund_prices", "user_id"],
    ] as const) {
      expect([
        table,
        db.query(`select distinct ${column} as o from ${table}`).all(),
      ]).toEqual([table, [{ o: OPERATOR }]]);
    }
    // the alert retention took before stays a gap for the operator
    expect(db.query("select alerts_pruned as n from users").get()).toEqual({
      n: 1,
    });
    // the reads answer the operator's rows
    const m = markets({
      db,
      clock,
      writer: writer(db),
      yahoo: yahoo({ clock, fetch: noNetwork }),
      fred: fred({ clock, key: "0".repeat(32), fetch: noNetwork }),
      log: silent,
    });
    expect(listAll(m, OPERATOR)).toMatchObject({
      display_currency: "EUR",
      time_zone: "Europe/Berlin",
      portfolios: [
        { id: 1, name: "Cash", trades: 0, positions: 1 },
        { id: 2, name: "Shares", trades: 2, positions: 0 },
      ],
      brokers: [{ id: 1, name: "North" }],
      funds: [{ isin: SHARED, price: 11, as_of: "2026-01-06" }],
    });
    expect(
      readTradeList(m, OPERATOR, {
        portfolio: null,
        broker: null,
        symbol: null,
        from: null,
        to: null,
        removed: false,
      }),
    ).toMatchObject([
      { id: 2, broker: "North" },
      { id: 1, note: "kept", broker: "North" },
    ]);
    expect(readProfile(db, OPERATOR)).toMatchObject({
      revision: 3,
      text: "# Made up",
    });
    expect(readRules(db, OPERATOR).map((r) => r.id)).toEqual([1, 2]);
    expect(listKeys(db, OPERATOR).map((k) => k.id)).toEqual(["madeupkey001"]);
    expect(fundDetail(m, OPERATOR, SHARED)).toMatchObject({
      prices: [
        { date: "2026-01-06", entered_by: "admin" },
        { date: "2026-01-05", trade: 2, entered_by: "web" },
      ],
    });
    // an id is never given twice
    db.exec(
      "insert into portfolios (owner, name, created_at) values ('operator', 'New', 2)",
    );
    expect(
      db.query("select id from portfolios where name = 'New'").get(),
    ).toEqual({ id: 4 });
    db.exec(
      "insert into rules (owner, instrument, condition, created_at) values ('operator', 'US:AAA', '{}', 2)",
    );
    expect(db.query("select max(id) as id from rules").get()).toEqual({
      id: 4,
    });
    // deleting a buy keeps the price it set
    db.exec("delete from trades where id = 2");
    expect(
      db.query("select date, trade from fund_prices order by date").all(),
    ).toEqual([
      { date: "2026-01-05", trade: null },
      { date: "2026-01-06", trade: null },
    ]);
    db.close();
  });
});

describe("people signed in to the web UI", () => {
  test("removing a person deletes every row of theirs, keeps the other's and the fund prices", async () => {
    const t = await two();
    await t.m.writer.write((db) => {
      openLogin(db, SECOND, t.clock.now());
      createLink(
        db,
        { user: SECOND, purpose: "sign_in", challenge: null },
        t.clock.now(),
      );
    });
    const list = routeList(t.m);
    const filled = rowsOf(t.db, SECOND) as Record<string, unknown[]>;
    for (const [table, rows] of Object.entries(filled)) {
      expect([table, rows.length > 0]).toEqual([table, true]);
    }
    const before = rowsOf(t.db, OPERATOR);
    const prices = t.db
      .query("select count(*) as n from fund_prices where user_id = ?")
      .get(SECOND) as { n: number };
    const counted = await routeAs(list, ADMIN, "DELETE", {
      path: `/users/${SECOND}?dry_run=true`,
    });
    expect(counted.status).toBe(200);
    const dry = (await counted.json()) as { deleted: Record<string, number> };
    expect(rowsOf(t.db, SECOND)).toEqual(filled);
    const res = await routeAs(list, ADMIN, "DELETE", {
      path: `/users/${SECOND}`,
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as typeof dry).deleted).toEqual(dry.deleted);
    expect(dry.deleted).toMatchObject({ logins: 1, links: 1, keys: 1 });
    const left = rowsOf(t.db, SECOND) as Record<string, unknown[]>;
    for (const [table, rows] of Object.entries(left)) {
      expect([table, rows]).toEqual([table, []]);
    }
    for (const table of ["logins", "links"]) {
      expect(
        t.db.query(`select * from ${table} where user_id = ?`).all(SECOND),
      ).toEqual([]);
    }
    expect(
      t.db.query("select id from users where id = ?").get(SECOND),
    ).toBeNull();
    // the prices they entered stay, shared, with no author
    expect(
      t.db
        .query("select count(*) as n from fund_prices where user_id is null")
        .get(),
    ).toEqual(prices);
    expect(rowsOf(t.db, OPERATOR)).toEqual(before);
    expect(t.db.query("pragma foreign_key_check").all()).toEqual([]);
  });

  test("each person's /ui/me, dashboard and keys are their own", async () => {
    const t = await two();
    const handle = api(t.m);
    const at = (path: string, cookie: string, init: RequestInit = {}) =>
      handle(
        new Request(`http://markets.test${path}`, {
          ...init,
          headers: {
            cookie,
            "sec-fetch-site": "same-origin",
            "content-type": "application/json",
          },
        }),
      );
    const cookies: Record<string, string> = {
      [OPERATOR]: cookieFor(t.db, t.clock.now()),
      [SECOND]: cookieFor(t.db, t.clock.now(), SECOND),
    };
    for (const { actor, victim, mark } of PEOPLE) {
      const cookie = cookies[actor]!;
      const me = (await (await at("/ui/me", cookie)).json()) as {
        user: { id: string };
      };
      expect(me.user.id).toBe(actor);
      const board = await (await at(`${PREFIX}/dashboard`, cookie)).text();
      expect([actor, board.includes(mark)]).toEqual([actor, false]);
      const renamed = await at("/ui/me", cookie, {
        method: "PATCH",
        body: JSON.stringify({ name: `${actor} renamed` }),
      });
      expect(renamed.status).toBe(200);
      expect(
        t.db.query("select name from users where id = ?").get(victim),
      ).not.toEqual({ name: `${actor} renamed` });
    }
    // a member lists only their own keys; the operator, an admin, all
    const listed = async (who: string) =>
      (
        (await (await at(`${PREFIX}/keys`, cookies[who]!)).json()) as {
          keys: { owner: { id: string } }[];
        }
      ).keys.map((k) => k.owner.id);
    expect(await listed(SECOND)).toEqual([SECOND]);
    expect([...new Set(await listed(OPERATOR))].sort()).toEqual([
      OPERATOR,
      SECOND,
    ]);
  });
});
