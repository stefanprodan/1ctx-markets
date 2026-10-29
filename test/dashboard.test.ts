// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import {
  MAX_DASHBOARD_SYMBOLS,
  MAX_SECTION_NAME,
  MAX_SECTION_SYMBOLS,
  MAX_SECTIONS,
} from "../src/admin/dashboard.ts";
import { PREFIX } from "../src/api/http.ts";
import { spec } from "../src/api/openapi.ts";
import { readInstrument, upsertInstrument } from "../src/market/instruments.ts";
import { lastReadAt, trackedIds } from "../src/market/tracking.ts";
import { type Markets, markets } from "../src/operations/markets.ts";
import { readTargets } from "../src/operations/targets.ts";
import type { TrackState } from "../src/operations/track.ts";
import { silent } from "../src/runtime/log.ts";
import { yahoo } from "../src/sources/yahoo/client.ts";
import { type Db, open } from "../src/storage/db/index.ts";
import { writer } from "../src/storage/writer.ts";
import { api } from "./helpers/api.ts";
import { fakeClock } from "./helpers/clock.ts";
import { drive, pacedOf } from "./helpers/drive.ts";
import { answerSchema, validate } from "./helpers/schema.ts";
import { NOW as SOURCES_NOW, sources } from "./helpers/sources.ts";
import {
  FINAL,
  instrument,
  LIVE,
  listing,
  NOW,
  quote,
  row,
  world,
} from "./helpers/world.ts";

const PATH = `http://markets.test${PREFIX}/dashboard`;

type Layout = {
  revision: number;
  sections: { name: string; view: string; symbols: string[] }[];
};

function client(m: Markets, track: () => TrackState[] = () => []) {
  const handle = api(m, { track });
  const send = async (req: Request) => {
    const res = await drive(m.clock as never, pacedOf(m), handle(req));
    return { status: res.status, body: (await res.json()) as any };
  };
  return {
    get: () => send(new Request(PATH)),
    put: (body: Layout | unknown) =>
      send(
        new Request(PATH, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
      ),
    del: (id: string) =>
      handle(
        new Request(
          `http://markets.test${PREFIX}/instruments/${encodeURIComponent(id)}`,
          { method: "DELETE" },
        ),
      ),
  };
}

const ids = (body: any) =>
  body.sections.map((s: any) => [s.name, s.items.map((i: any) => i.id)]);

const count = (db: Db, table: string) =>
  (db.query(`select count(*) as n from ${table}`).get() as { n: number }).n;

function kind(db: Db, id: string, type: string) {
  const [market, symbol] = id.split(":") as [string, string];
  upsertInstrument(
    db,
    {
      market,
      symbol,
      source: "other",
      sourceSymbol: symbol,
      exchange: market,
      name: symbol,
      type,
      currency: "USD",
      unit: "per_share",
      zone: "UTC",
    },
    NOW,
  );
}

const tracked = (value: string, id: string | null): TrackState => ({
  value,
  id,
  state: id === null ? "not_found" : "tracked",
});

describe("the dashboard's tables", () => {
  test("hold one owner's sections and items, an item dropped with its instrument", () => {
    const { db } = open(":memory:", fakeClock(NOW));
    instrument(db, "US:AAA");
    db.query(
      "insert into dashboards (owner, revision, updated_at) values ('operator', 1, 0)",
    ).run();
    db.query(
      "insert into dashboard_sections (owner, position, name, view) values ('operator', 0, 'A', 'cards')",
    ).run();
    db.query(
      "insert into dashboard_items (owner, section, position, instrument) values ('operator', 0, 0, 'US:AAA')",
    ).run();
    expect(() =>
      db
        .query(
          "insert into dashboard_items (owner, section, position, instrument) values ('operator', 0, 1, 'US:NONE')",
        )
        .run(),
    ).toThrow();
    expect(() =>
      db
        .query(
          "insert into dashboard_sections (owner, position, name, view) values ('operator', 1, 'B', 'grid')",
        )
        .run(),
    ).toThrow();
    db.query("delete from instruments where id = 'US:AAA'").run();
    expect(count(db, "dashboard_items")).toBe(0);
    expect(count(db, "dashboard_sections")).toBe(1);
    db.close();
  });
});

describe("the dashboard", () => {
  test("before a save is the watchlist by kind in flag order; once saved, only a save changes it", async () => {
    const w = world();
    kind(w.db, "SNP:^GSPC", "INDEX");
    kind(w.db, "CMX:GC=F", "FUTURE");
    kind(w.db, "NIM:^NDX", "INDEX");
    kind(w.db, "CRYPTO:BTC-USD", "CRYPTOCURRENCY");
    kind(w.db, "XX:ODD", "WARRANT");
    let track = [
      tracked("^GSPC", "SNP:^GSPC"),
      tracked("GC=F", "CMX:GC=F"),
      tracked("TYPO", null),
      tracked("^NDX", "NIM:^NDX"),
      tracked("SNP:^GSPC", "SNP:^GSPC"),
      tracked("BTC-USD", "CRYPTO:BTC-USD"),
      tracked("ODD", "XX:ODD"),
    ];
    const c = client(w.m, () => track);
    const first = await c.get();
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ revision: 0, created: false });
    expect(first.body.track).toEqual([
      { value: "^GSPC", state: "ready" },
      { value: "GC=F", state: "ready" },
      { value: "TYPO", state: "failed" },
      { value: "^NDX", state: "ready" },
      { value: "SNP:^GSPC", state: "ready" },
      { value: "BTC-USD", state: "ready" },
      { value: "ODD", state: "ready" },
    ]);
    expect(ids(first.body)).toEqual([
      ["Indices", ["SNP:^GSPC", "NIM:^NDX"]],
      ["Futures", ["CMX:GC=F"]],
      ["Crypto", ["CRYPTO:BTC-USD"]],
      ["Warrant", ["XX:ODD"]],
    ]);
    expect(first.body.sections.every((s: any) => s.view === "cards")).toBe(
      true,
    );
    expect(count(w.db, "dashboards")).toBe(0);
    const saved = await c.put({ revision: 0, sections: [] });
    expect(saved.status).toBe(200);
    expect(saved.body).not.toHaveProperty("track");
    expect(saved.body).toEqual({ revision: 1, created: true, sections: [] });
    track = [tracked("^DJI", "SNP:^GSPC")];
    expect((await c.get()).body).toEqual(saved.body);
  });

  test("answers each item as a watchlist entry with its distance from each average", async () => {
    const w = world();
    // crossed up through its 50 and down through its 200 since the last close
    listing(w.db, "US:AAA", {
      price: 110,
      previousClose: 95,
      final: { sma50: 100, sma200: 90 },
      live: { sma50: 100, sma200: 120 },
    });
    row(w.db, "US:AAA", "1wk", "2026-10-19", "final", { sma200: 55 });
    instrument(w.db, "US:BBB");
    quote(w.db, "US:BBB", 50, 50);
    row(w.db, "US:BBB", "1d", FINAL, "final", { sma50: 40, sma200: null });
    instrument(w.db, "FRED:DGS10");
    const c = client(w.m);
    const put = await c.put({
      revision: 0,
      sections: [
        { name: "Shares", view: "table", symbols: ["US:AAA", "US:BBB"] },
        { name: "Rates", view: "cards", symbols: ["FRED:DGS10"] },
      ],
    });
    expect(put.status).toBe(200);
    const { body } = await c.get();
    expect(body).toEqual(put.body);
    const schema = answerSchema(spec, "GET", "/dashboard", 200)!;
    expect(validate(body, schema, spec)).toEqual([]);
    expect(body.attribution).toContain("FRED");
    const [aaa, bbb] = body.sections[0].items;
    expect(aaa).toMatchObject({
      id: "US:AAA",
      instrument: { id: "US:AAA", price: 110, tracked_by: ["dashboard"] },
      intraday: false,
      averages: {
        daily_sma50: { distance_pct: 10, crossed_today: true },
        daily_sma200: { distance_pct: -8.33333, crossed_today: true },
        weekly_sma200: { distance_pct: 100 },
      },
    });
    expect(aaa.session).toMatchObject({ state: "closed" });
    expect(bbb.averages).toEqual({
      daily_sma50: { distance_pct: 25, crossed_today: false },
      daily_sma200: null,
      weekly_sma200: null,
    });
    expect(body.sections[1].items[0]).toMatchObject({
      id: "FRED:DGS10",
      session: null,
      averages: { daily_sma50: null, daily_sma200: null, weekly_sma200: null },
    });
    expect(LIVE > FINAL).toBe(true);
  });

  test("a value still resolving is pending, and the seed leaves it out until it resolves", async () => {
    const w = world();
    kind(w.db, "SNP:^GSPC", "INDEX");
    let track: TrackState[] = [
      tracked("^GSPC", "SNP:^GSPC"),
      { value: "AAPL", id: null, state: "pending" },
      { value: "LATE", id: "US:LATE", state: "pending" },
    ];
    const c = client(w.m, () => track);
    const first = (await c.get()).body;
    expect(first.track).toEqual([
      { value: "^GSPC", state: "ready" },
      { value: "AAPL", state: "pending" },
      { value: "LATE", state: "pending" },
    ]);
    expect(ids(first)).toEqual([["Indices", ["SNP:^GSPC"]]]);
    kind(w.db, "US:AAPL", "EQUITY");
    track = [track[0]!, tracked("AAPL", "US:AAPL"), tracked("LATE", null)];
    const after = (await c.get()).body;
    expect(after.track.map((t: any) => t.state)).toEqual([
      "ready",
      "ready",
      "failed",
    ]);
    expect(ids(after)).toEqual([
      ["Indices", ["SNP:^GSPC"]],
      ["Stocks", ["US:AAPL"]],
    ]);
  });

  test("a save asks no source for a stored favourite, so one it cannot reach never refuses a rename", async () => {
    const w = world();
    // a series whose source cannot answer: any fetch fails
    instrument(w.db, "FRED:DGS10");
    instrument(w.db, "US:AAA");
    const c = client(w.m);
    const layout = (revision: number, name: string) => ({
      revision,
      sections: [{ name, view: "cards", symbols: ["FRED:DGS10", "US:AAA"] }],
    });
    expect((await c.put(layout(0, "Mine"))).status).toBe(200);
    const renamed = await c.put(layout(1, "Rates"));
    expect([renamed.status, renamed.body.errors]).toEqual([200, undefined]);
    expect(ids(renamed.body)).toEqual([["Rates", ["FRED:DGS10", "US:AAA"]]]);
    const added = await c.put({
      revision: 2,
      sections: [{ name: "Rates", view: "cards", symbols: ["FRED:DGS2"] }],
    });
    expect(added.status).toBe(422);
  });

  test("the seed keeps to a save's limits, so the first edit saves", async () => {
    const w = world();
    const track: TrackState[] = [];
    for (let k = 0; k < MAX_SECTION_SYMBOLS + 5; k++) {
      kind(w.db, `US:S${k}`, "EQUITY");
      track.push(tracked(`S${k}`, `US:S${k}`));
    }
    for (let k = 0; k < MAX_SECTIONS + 5; k++) {
      kind(w.db, `XX:K${k}`, `KIND${k}`);
      track.push(tracked(`K${k}`, `XX:K${k}`));
    }
    const c = client(w.m, () => track);
    const seed = (await c.get()).body;
    expect(seed.sections).toHaveLength(MAX_SECTIONS);
    expect(seed.sections[0].items).toHaveLength(MAX_SECTION_SYMBOLS);
    const all = seed.sections.flatMap((s: any) => s.items);
    expect(all.length).toBeLessThanOrEqual(MAX_DASHBOARD_SYMBOLS);
    const first = await c.put({
      revision: 0,
      sections: seed.sections.map((s: any) => ({
        name: s.name,
        view: s.view,
        symbols: s.items.map((i: any) => i.id).slice(1),
      })),
    });
    expect(first.status).toBe(200);
  });

  test("crossed today follows the movers tool's rule, equal to the average included", async () => {
    const w = world();
    // from on its 50SMA to above it: crossed up; from below to on its
    // 200SMA: only touched
    listing(w.db, "US:AAA", {
      price: 110,
      previousClose: 100,
      final: { sma50: 100, sma200: 120 },
      live: { sma50: 100, sma200: 110 },
    });
    const c = client(w.m);
    const put = await c.put({
      revision: 0,
      sections: [{ name: "A", view: "cards", symbols: ["US:AAA"] }],
    });
    expect(put.body.sections[0].items[0].averages).toMatchObject({
      daily_sma50: { distance_pct: 10, crossed_today: true },
      daily_sma200: { distance_pct: 0, crossed_today: false },
    });
  });

  test("a favourite stays tracked with no read; deleting it drops its card and moves the revision", async () => {
    const w = world();
    instrument(w.db, "US:AAA");
    instrument(w.db, "US:BBB");
    const c = client(w.m);
    const put = await c.put({
      revision: 0,
      sections: [
        { name: "Mine", view: "cards", symbols: ["us:aaa", "US:BBB"] },
      ],
    });
    expect(put.status).toBe(200);
    expect(ids(put.body)).toEqual([["Mine", ["US:AAA", "US:BBB"]]]);
    expect(lastReadAt(w.db, "US:AAA")).toBeNull();
    expect(lastReadAt(w.db, "US:BBB")).toBeNull();
    const now = w.clock.now() + 60 * 24 * 3_600_000;
    expect([...trackedIds(w.db, now, w.m.tracking)].sort()).toEqual([
      "US:AAA",
      "US:BBB",
    ]);
    expect((await c.del("US:AAA")).status).toBe(204);
    expect(readInstrument(w.db, "US:AAA")).toBeNull();
    const after = await c.get();
    expect(after.body.revision).toBe(2);
    expect(ids(after.body)).toEqual([["Mine", ["US:BBB"]]]);
    const stale = await c.put({
      revision: 1,
      sections: [{ name: "Mine", view: "cards", symbols: ["US:BBB"] }],
    });
    expect(stale.status).toBe(409);
  });

  test("a stale revision answers the stored dashboard and changes nothing", async () => {
    const w = world();
    instrument(w.db, "US:AAA");
    const c = client(w.m);
    const layout = {
      revision: 0,
      sections: [{ name: "A", view: "cards", symbols: ["US:AAA"] }],
    };
    expect((await c.put(layout)).status).toBe(200);
    const again = await c.put({ ...layout, sections: [] });
    expect(again.status).toBe(409);
    expect(again.body).toMatchObject({
      code: "conflict",
      dashboard: { revision: 1, created: true },
    });
    expect(ids(again.body.dashboard)).toEqual([["A", ["US:AAA"]]]);
    const schema = answerSchema(spec, "PUT", "/dashboard", 409)!;
    expect(validate(again.body, schema, spec)).toEqual([]);
    const twice = await c.put({
      revision: 1,
      sections: [
        { name: "A", view: "table", symbols: ["US:AAA", "us:aaa"] },
        { name: "B", view: "cards", symbols: ["US:AAA"] },
      ],
    });
    expect(ids(twice.body)).toEqual([
      ["A", ["US:AAA"]],
      ["B", []],
    ]);
  });

  test("refuses a layout past its limits before anything is resolved", async () => {
    const w = world();
    const c = client(w.m);
    const section = (name: string, n = 0, view = "cards") => ({
      name,
      view,
      symbols: Array.from({ length: n }, (_, k) => `US:S${k}`),
    });
    const bad: unknown[] = [
      null,
      { sections: [] },
      { revision: -1, sections: [] },
      { revision: 1.5, sections: [] },
      { revision: 0 },
      { revision: 0, sections: [], extra: 1 },
      {
        revision: 0,
        sections: Array.from({ length: MAX_SECTIONS + 1 }, (_, k) =>
          section(`S${k}`),
        ),
      },
      { revision: 0, sections: [section("A", MAX_SECTION_SYMBOLS + 1)] },
      {
        revision: 0,
        sections: [
          section("A", MAX_SECTION_SYMBOLS),
          section("B", MAX_SECTION_SYMBOLS),
          section("C", MAX_DASHBOARD_SYMBOLS - 2 * MAX_SECTION_SYMBOLS + 1),
        ],
      },
      { revision: 0, sections: [section("")] },
      { revision: 0, sections: [section("  ")] },
      { revision: 0, sections: [section("x".repeat(MAX_SECTION_NAME + 1))] },
      { revision: 0, sections: [section("Mine"), section("MINE ")] },
      { revision: 0, sections: [section("A", 0, "grid")] },
      { revision: 0, sections: [{ ...section("A"), symbols: [""] }] },
      { revision: 0, sections: [{ ...section("A"), symbols: [7] }] },
      { revision: 0, sections: [{ ...section("A"), more: 1 }] },
    ];
    for (const body of bad) {
      const res = await c.put(body);
      expect([body, res.status, res.body.code]).toEqual([
        body,
        400,
        "bad_arguments",
      ]);
    }
    expect(count(w.db, "dashboards")).toBe(0);
    const name = "x".repeat(MAX_SECTION_NAME);
    for (let k = 0; k < 2; k++) {
      expect(
        (
          await c.put({
            revision: k,
            sections: [
              section(name),
              ...Array.from({ length: MAX_SECTIONS - 1 }, (_, j) =>
                section(`S${j}`),
              ),
            ],
          })
        ).status,
      ).toBe(200);
    }
  });
});

describe("saving with sources", () => {
  async function setup() {
    const clock = fakeClock(SOURCES_NOW);
    const { db } = open(":memory:", clock);
    const s = await sources();
    const m = markets({
      db,
      clock,
      writer: writer(db),
      yahoo: yahoo({ clock, fetch: s.fetch }),
      fred: null,
      log: silent,
    });
    return { db, m, calls: s.calls };
  }

  test("a stored symbol and one never seen, fetched inside the call", async () => {
    const t = await setup();
    await readTargets(t.m, ["^GSPC"]);
    const before = t.calls.charts("^GSPC").length;
    const c = client(t.m);
    const res = await c.put({
      revision: 0,
      sections: [{ name: "Mine", view: "cards", symbols: ["^GSPC", "NVDA"] }],
    });
    expect(res.status).toBe(200);
    expect(ids(res.body)).toEqual([["Mine", ["SNP:^GSPC", "US:NVDA"]]]);
    expect(t.calls.charts("NVDA").length).toBeGreaterThan(0);
    expect(t.calls.charts("^GSPC").length).toBe(before);
    expect(res.body.sections[0].items[1].instrument).toMatchObject({
      id: "US:NVDA",
      tracked_by: ["dashboard"],
    });
    expect(lastReadAt(t.db, "US:NVDA")).toBeNull();
  });

  test("one symbol that does not resolve saves nothing and says which", async () => {
    const t = await setup();
    const c = client(t.m);
    const res = await c.put({
      revision: 0,
      sections: [
        { name: "Mine", view: "cards", symbols: ["NVDA", "ZZNOTHING"] },
      ],
    });
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({
      code: "unresolved",
      errors: [{ input: "ZZNOTHING", error: { code: "not_found" } }],
    });
    expect(res.body.errors).toHaveLength(1);
    const schema = answerSchema(spec, "PUT", "/dashboard", 422)!;
    expect(validate(res.body, schema, spec)).toEqual([]);
    expect(count(t.db, "dashboards")).toBe(0);
    expect(count(t.db, "dashboard_items")).toBe(0);
    expect((await c.get()).body).toMatchObject({
      created: false,
      sections: [],
    });
  });
});
