// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { POLICY } from "../src/api/docs.ts";
import { MAX_BODY_BYTES, PREFIX } from "../src/api/http.ts";
import { spec } from "../src/api/openapi.ts";
import { routes } from "../src/api/routes.ts";
import { DAY_MS } from "../src/clock.ts";
import { type Db, open } from "../src/db/index.ts";
import { finnhub } from "../src/finnhub/client.ts";
import { fred } from "../src/fred/client.ts";
import { silent } from "../src/log.ts";
import { round } from "../src/tools/answer.ts";
import { tools } from "../src/tools/index.ts";
import { CALL_MS, markets } from "../src/tools/targets.ts";
import { lastReadAt } from "../src/tracking.ts";
import { writer } from "../src/writer.ts";
import { yahoo } from "../src/yahoo/client.ts";
import { ADMIN_KEY, api } from "./helpers/api.ts";
import { withApp } from "./helpers/app.ts";
import { fakeClock } from "./helpers/clock.ts";
import { drive, pacedOf } from "./helpers/drive.ts";
import { FINNHUB_KEY, finnhubAnswer } from "./helpers/finnhub.ts";
import {
  answerSchema,
  schemaErrors,
  specSchemas,
  validate,
} from "./helpers/schema.ts";
import { FRED_KEY, gate, NOW, sources } from "./helpers/sources.ts";
import { bar, FINAL, instrument, LIVE, row, world } from "./helpers/world.ts";
import { chartSymbol } from "./helpers/yahoo.ts";

const METHODS = ["get", "post", "patch", "delete"];

// the symbols whose first chart waits in the fake fetch until released
type Gate = ReturnType<typeof gate>;

async function setup() {
  const clock = fakeClock(NOW);
  const { db } = open(":memory:", clock);
  const gates = new Map<string, Gate>();
  const s = await sources({
    hold: async (url) => {
      const g = gates.get(chartSymbol(url) ?? "");
      if (g !== undefined) return g.hold();
      return finnhubAnswer(url);
    },
  });
  const m = markets({
    db,
    clock,
    writer: writer(db),
    yahoo: yahoo({ clock, fetch: s.fetch }),
    fred: fred({ clock, key: FRED_KEY, fetch: s.fetch }),
    finnhub: finnhub({ clock, key: FINNHUB_KEY, fetch: s.fetch }),
    log: silent,
  });
  const handle = api(m);
  const call = (path: string, init: RequestInit = {}) =>
    drive(
      clock,
      pacedOf(m),
      handle(new Request(`http://markets.test${PREFIX}${path}`, init)),
    );
  // a call whose symbol is held past the deadline, then let go, since
  // it holds one of the source queue's slots
  const late = async (symbol: string, path: string, init: RequestInit = {}) => {
    const g = gate();
    gates.set(symbol, g);
    const res = handle(
      new Request(`http://markets.test${PREFIX}${path}`, init),
    );
    await g.arrived;
    await clock.advance(CALL_MS);
    const answered = await res;
    g.release();
    return answered;
  };
  return { clock, db, m, s, call, late };
}

const json = (body: unknown, type = "application/json"): RequestInit => ({
  method: "POST",
  headers: { "content-type": type },
  body: typeof body === "string" ? body : JSON.stringify(body),
});

const patch = (body: unknown): RequestInit => ({
  ...json(body),
  method: "PATCH",
});

const count = (db: Db, table: string) =>
  (db.query(`select count(*) as n from ${table}`).get() as { n: number }).n;

describe("the spec", () => {
  test("names every route and routes every operation", () => {
    const w = world();
    const list = routes({
      m: w.m,
      alerts: async () => new Response(),
      admin: { m: w.m, version: "v", sources: [] },
      log: silent,
    });
    const routed = list.map((r) => `${r.method} ${r.path}`).sort();
    const described = Object.entries(spec.paths)
      .flatMap(([path, item]) =>
        Object.keys(item)
          .filter((k) => METHODS.includes(k))
          .map((k) => `${k.toUpperCase()} ${path}`),
      )
      .sort();
    expect(routed).toEqual(described);
    expect(spec.servers).toEqual([{ url: PREFIX }]);
  });

  test("keeps every schema to the checked subset", () => {
    const all = specSchemas(spec);
    expect(all.length).toBeGreaterThan(50);
    for (const [where, s] of all) {
      expect([where, schemaErrors(s)]).toEqual([where, []]);
    }
    // every $ref resolves: an empty object breaks any schema but a bare ref
    const refs = JSON.stringify(spec).match(/"#\/components\/[^"]+"/g)!;
    for (const ref of new Set(refs)) {
      const path = JSON.parse(ref).slice(2).split("/");
      let node: any = spec;
      for (const p of path) node = node?.[p];
      expect([ref, node === undefined]).toEqual([ref, false]);
    }
  });

  test("the checker refuses keywords outside the subset and wrong values", () => {
    for (const s of [
      { type: "string", minLength: 1 },
      { anyOf: [{ type: "string" }, { type: "number" }] },
      { oneOf: [{ type: "string" }] },
      { type: "string", description: 1 },
      { type: "object", properties: { a: { pattern: "x" } } },
      { type: "array", items: { format: "date" } },
      { type: "text" },
      { $ref: "#/components/schemas/Error", type: "object" },
    ]) {
      expect(schemaErrors(s)).not.toEqual([]);
    }
    const s = {
      type: "object",
      properties: { a: { type: ["integer", "null"] }, b: { enum: ["x"] } },
      required: ["a"],
      additionalProperties: false,
    };
    expect(validate({ a: 1, b: "x" }, s, {})).toEqual([]);
    expect(validate({ a: null }, s, {})).toEqual([]);
    expect(validate({ a: 1.5 }, s, {})).not.toEqual([]);
    expect(validate({ b: "x" }, s, {})).not.toEqual([]);
    expect(validate({ a: 1, b: "y" }, s, {})).not.toEqual([]);
    expect(validate({ a: 1, c: 1 }, s, {})).not.toEqual([]);
    expect(validate([], s, {})).not.toEqual([]);
    // exactly one branch: a value both or neither match is refused
    const either = {
      oneOf: [
        {
          type: "object",
          properties: { a: { type: "integer" } },
          required: ["a"],
        },
        {
          type: "object",
          properties: { b: { type: "string" } },
          required: ["b"],
        },
      ],
    };
    expect(validate({ a: 1 }, either, {})).toEqual([]);
    expect(validate({ b: "x" }, either, {})).toEqual([]);
    expect(validate({ a: 1, b: "x" }, either, {})).not.toEqual([]);
    expect(validate({ c: 1 }, either, {})).not.toEqual([]);
    // an item is a whole result or a whole error, never a bare input
    const quotes = answerSchema(spec, "GET", "/quotes", 200)!;
    const answer = (item: object) => validate({ items: [item] }, quotes, spec);
    expect(answer({ input: "X" })).not.toEqual([]);
    expect(
      answer({ input: "X", error: "not_found", message: "no listing" }),
    ).toEqual([]);
    expect(
      answer({ input: "X", id: "US:X", error: "not_found", message: "m" }),
    ).not.toEqual([]);
    for (const path of ["/movers", "/screen"]) {
      const method = path === "/screen" ? "POST" : "GET";
      const set = answerSchema(spec, method, path, 200)!;
      const sort = path === "/screen" ? { field: "id", order: "asc" } : "x";
      const counts = { matched: 1, not_matched: 0, unavailable: 0, errors: 0 };
      expect(
        validate(
          {
            sort,
            counts,
            items: [{ input: "X", id: "US:X", status: "matched" }],
          },
          set,
          spec,
        ),
      ).not.toEqual([]);
    }
  });
});

describe("every operation", () => {
  test("answers its success and each documented error as the spec says", async () => {
    const t = await setup();
    const covered = new Set<string>();
    const check = async (
      method: string,
      path: string,
      res: Response,
      status: number,
    ): Promise<any> => {
      const raw = await res.text();
      expect([method, path, res.status, raw.slice(0, 300)]).toEqual([
        method,
        path,
        status,
        raw.slice(0, 300),
      ]);
      covered.add(`${method} ${path} ${status}`);
      const schema = answerSchema(spec, method, path, status);
      if (schema === null) return raw;
      const body = JSON.parse(raw);
      expect([method, path, status, validate(body, schema, spec)]).toEqual([
        method,
        path,
        status,
        [],
      ]);
      return body;
    };
    const wrong = { headers: { authorization: "Bearer wrong" } };

    // quotes
    await check(
      "GET",
      "/quotes",
      await t.call("/quotes?symbols=NVDA,FRED:DGS10,^GSPC,ZZNOTHING"),
      200,
    );
    await check("GET", "/quotes", await t.call("/quotes?symbols="), 400);
    await check(
      "GET",
      "/quotes",
      await t.call("/quotes?symbols=A", wrong),
      401,
    );

    // history
    const h = await check(
      "GET",
      "/history",
      await t.call("/history?symbol=NVDA&benchmark=^GSPC"),
      200,
    );
    expect(h.relative.returns).toHaveLength(2);
    await check("GET", "/history", await t.call("/history?interval=1h"), 400);
    await check(
      "GET",
      "/history",
      await t.call("/history?symbol=A", wrong),
      401,
    );
    const missing = await check(
      "GET",
      "/history",
      await t.call("/history?symbol=ZZNOTHING"),
      404,
    );
    expect(missing).toMatchObject({ input: "ZZNOTHING", error: "not_found" });
    const slow = await t.late("SLOWA.DE", "/history?symbol=SLOWA.DE");
    expect((await check("GET", "/history", slow, 503)).error).toBe("timeout");

    // search
    await check("GET", "/search", await t.call("/search?query=NVDA"), 200);
    await check("GET", "/search", await t.call("/search"), 400);
    await check("GET", "/search", await t.call("/search?query=A", wrong), 401);

    // research
    const r = await check(
      "GET",
      "/research",
      await t.call(
        "/research?symbols=NVDA,^GSPC&sections=metric,news&since=2026-10-01",
      ),
      200,
    );
    expect(Object.keys(r.items[0].research).sort()).toEqual([
      "metric",
      "source",
    ]);
    await check(
      "GET",
      "/research",
      await t.call("/research?symbols=NVDA&sections=metric&since=2026-10-01"),
      400,
    );
    await check(
      "GET",
      "/research",
      await t.call("/research?symbols=NVDA", wrong),
      401,
    );

    // events
    const e = await check(
      "GET",
      "/events",
      await t.call("/events?from=2026-01-01&to=2026-12-31&symbols=NVDA"),
      200,
    );
    expect(e.events).toHaveLength(1);
    await check("GET", "/events", await t.call("/events?to=2026-12-31"), 400);
    await check(
      "GET",
      "/events",
      await t.call("/events?from=2026-01-01&to=2026-12-31", wrong),
      401,
    );

    // movers
    await check(
      "GET",
      "/movers",
      await t.call("/movers?symbols=NVDA,^GSPC,FRED:DGS10&min_move_pct=0"),
      200,
    );
    await check(
      "GET",
      "/movers",
      await t.call("/movers?symbols=NVDA&min_move_pct=x"),
      400,
    );
    await check(
      "GET",
      "/movers",
      await t.call("/movers?symbols=NVDA&min_move_pct=1", wrong),
      401,
    );

    // screen
    const screen = {
      symbols: ["NVDA", "^GSPC"],
      filters: [{ field: "rsi14", min: 0 }],
      sort: "return_1m",
      order: "desc",
    };
    await check("POST", "/screen", await t.call("/screen", json(screen)), 200);
    await check(
      "POST",
      "/screen",
      await t.call("/screen", json({ ...screen, order: "up" })),
      400,
    );
    await check(
      "POST",
      "/screen",
      await t.call("/screen", { ...json(screen), ...wrong }),
      401,
    );
    await check(
      "POST",
      "/screen",
      await t.call(
        "/screen",
        json({
          symbols: ["NVDA"],
          sort: "relative_return_1m",
          benchmark: "ZZNOTHING",
        }),
      ),
      404,
    );
    await check(
      "POST",
      "/screen",
      await t.call(
        "/screen",
        json({ ...screen, symbols: ["x".repeat(MAX_BODY_BYTES)] }),
      ),
      413,
    );
    await check(
      "POST",
      "/screen",
      await t.call("/screen", json(screen, "text/plain")),
      415,
    );
    const late = await t.late(
      "SLOWB.DE",
      "/screen",
      json({
        symbols: ["NVDA"],
        sort: "relative_return_1m",
        benchmark: "SLOWB.DE",
      }),
    );
    await check("POST", "/screen", late, 503);

    // alerts before any fired
    await check("GET", "/alerts", await t.call("/alerts"), 204);

    // rules
    const rule = {
      symbol: "NVDA",
      condition: { left: "price", op: "<", right: 211 },
      note: "below 211",
    };
    const made = await check(
      "POST",
      "/rules",
      await t.call("/rules", json(rule)),
      201,
    );
    expect(made.alert).not.toBeNull();
    await check(
      "POST",
      "/rules",
      await t.call("/rules", json({ ...rule, action: "list" })),
      400,
    );
    await check(
      "POST",
      "/rules",
      await t.call("/rules", { ...json(rule), ...wrong }),
      401,
    );
    await check(
      "POST",
      "/rules",
      await t.call("/rules", json({ ...rule, symbol: "ZZNOTHING" })),
      404,
    );
    await check(
      "POST",
      "/rules",
      await t.call(
        "/rules",
        json({ ...rule, note: "x".repeat(MAX_BODY_BYTES) }),
      ),
      413,
    );
    await check(
      "POST",
      "/rules",
      await t.call("/rules", json(rule, "text/plain")),
      415,
    );
    const lateRule = await t.late(
      "SLOWC.DE",
      "/rules",
      json({ ...rule, symbol: "SLOWC.DE" }),
    );
    await check("POST", "/rules", lateRule, 503);
    expect(count(t.db, "rules")).toBe(1);

    const listed = await check("GET", "/rules", await t.call("/rules"), 200);
    expect(listed.rules).toHaveLength(1);
    await check("GET", "/rules", await t.call("/rules?x=1"), 400);
    await check("GET", "/rules", await t.call("/rules", wrong), 401);

    const id = made.rule.id;
    await check(
      "PATCH",
      "/rules/{id}",
      await t.call(`/rules/${id}`, patch({ paused: true })),
      200,
    );
    await check(
      "PATCH",
      "/rules/{id}",
      await t.call(`/rules/${id}`, patch({ paused: "yes" })),
      400,
    );
    await check(
      "PATCH",
      "/rules/{id}",
      await t.call(`/rules/${id}`, { ...patch({ paused: true }), ...wrong }),
      401,
    );
    await check(
      "PATCH",
      "/rules/{id}",
      await t.call("/rules/999", patch({ paused: true })),
      404,
    );
    await check(
      "PATCH",
      "/rules/{id}",
      await t.call(
        `/rules/${id}`,
        patch({ paused: "x".repeat(MAX_BODY_BYTES) }),
      ),
      413,
    );
    await check(
      "PATCH",
      "/rules/{id}",
      await t.call(`/rules/${id}`, {
        ...patch({ paused: true }),
        headers: { "content-type": "text/plain" },
      }),
      415,
    );
    t.db.query("update rules set paused = 'split' where id = ?").run(id);
    await check(
      "PATCH",
      "/rules/{id}",
      await t.call(`/rules/${id}`, patch({ paused: false })),
      409,
    );

    // alerts after the rule fired
    const feed = await t.call("/alerts");
    const etag = feed.headers.get("etag")!;
    await check("GET", "/alerts", feed, 200);
    await check(
      "GET",
      "/alerts",
      await t.call("/alerts", { headers: { "if-none-match": etag } }),
      304,
    );
    await check(
      "GET",
      "/alerts",
      await t.call("/alerts", { headers: { "if-none-match": "x" } }),
      400,
    );
    await check("GET", "/alerts", await t.call("/alerts", wrong), 401);

    // admin
    await check("GET", "/admin/status", await t.call("/admin/status"), 200);
    await check("GET", "/admin/status", await t.call("/admin/status?x=1"), 400);
    await check(
      "GET",
      "/admin/status",
      await t.call("/admin/status", wrong),
      401,
    );
    const refetch = { symbols: ["US:NOPE"], fetch: ["quotes"] };
    await check(
      "POST",
      "/admin/refetch",
      await t.call("/admin/refetch", json(refetch)),
      200,
    );
    await check(
      "POST",
      "/admin/refetch",
      await t.call("/admin/refetch", json({ symbols: [] })),
      400,
    );
    await check(
      "POST",
      "/admin/refetch",
      await t.call("/admin/refetch", { ...json(refetch), ...wrong }),
      401,
    );
    await check(
      "POST",
      "/admin/refetch",
      await t.call("/admin/refetch", json({ symbols: ["x".repeat(20_000)] })),
      413,
    );
    await check(
      "POST",
      "/admin/refetch",
      await t.call("/admin/refetch", json(refetch, "text/plain")),
      415,
    );
    const del = (id: string, init: RequestInit = {}) =>
      t.call(`/admin/instruments/${encodeURIComponent(id)}`, {
        method: "DELETE",
        ...init,
      });
    const path = "/admin/instruments/{id}";
    await check("DELETE", path, await del("US:NVDA"), 409);
    await check("DELETE", path, await del("FRED:DGS10"), 200);
    await check("DELETE", path, await del("FRED:DGS10"), 404);
    await check("DELETE", path, await del("<b>"), 400);
    await check("DELETE", path, await del("US:NVDA", wrong), 401);

    // rules delete last: its alert stays
    await check(
      "DELETE",
      "/rules/{id}",
      await t.call(`/rules/${id}`, { method: "DELETE" }),
      204,
    );
    expect(count(t.db, "alerts")).toBe(1);
    await check(
      "DELETE",
      "/rules/{id}",
      await t.call(`/rules/${id}`, { method: "DELETE" }),
      404,
    );
    await check(
      "DELETE",
      "/rules/{id}",
      await t.call("/rules/0", { method: "DELETE" }),
      400,
    );
    // past Number.MAX_SAFE_INTEGER an id would round to another
    for (const big of ["9999999999999999", "100000000000000000"]) {
      const res = await t.call(`/rules/${big}`, { method: "DELETE" });
      expect([big, res.status]).toEqual([big, 400]);
    }
    expect(
      (await t.call("/rules/999999999999999", { method: "DELETE" })).status,
    ).toBe(404);
    await check(
      "DELETE",
      "/rules/{id}",
      await t.call(`/rules/${id}`, { method: "DELETE", ...wrong }),
      401,
    );

    // public
    await check("GET", "/openapi.json", await t.call("/openapi.json"), 200);
    await check("GET", "/openapi.json", await t.call("/openapi.json?x=1"), 400);
    await check("GET", "/docs", await t.call("/docs"), 200);
    await check("GET", "/docs/{file}", await t.call("/docs/init.js"), 200);

    // 500 is every route's wrapper, checked once below
    const documented = Object.entries(spec.paths).flatMap(([path, item]) =>
      Object.entries(item)
        .filter(([k]) => METHODS.includes(k))
        .flatMap(([method, op]: [string, any]) =>
          Object.keys(op.responses)
            .filter((s) => s !== "500")
            .map((s) => `${method.toUpperCase()} ${path} ${s}`),
        ),
    );
    expect([...covered].sort()).toEqual(documented.sort());
  });

  test("a throw answers 500 internal without its text", async () => {
    const w = world();
    const handle = api(w.m);
    w.db.close();
    const res = await handle(new Request("http://markets.test/api/v1/rules"));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toEqual({ error: "internal", message: "internal error" });
    const schema = answerSchema(spec, "GET", "/rules", 500)!;
    expect(validate(body, schema, spec)).toEqual([]);
  });

  test("refuses next and any argument a route does not take", async () => {
    const t = await setup();
    for (const path of [
      "/quotes?symbols=NVDA&next=1",
      "/history?symbol=NVDA&next=1",
      "/search?query=NVDA&next=1",
      "/research?symbols=NVDA&next=1",
      "/events?from=2026-01-01&to=2026-01-02&next=1",
      "/movers?symbols=NVDA&min_move_pct=1&next=1",
      "/quotes?symbols=NVDA&benchmark=^GSPC",
      "/quotes?symbols=NVDA&extended=yes",
      "/quotes?symbols=NVDA&extended=true&extended=false",
      "/alerts?next=1",
    ]) {
      const res = await t.call(path);
      expect([path, res.status]).toEqual([path, 400]);
      expect(((await res.json()) as any).error).toBe("bad_arguments");
    }
    for (const body of [
      { symbols: ["NVDA"], sort: "rsi14", next: "1" },
      [1, 2],
      "not json",
    ]) {
      const res = await t.call("/screen", json(body));
      expect(res.status).toBe(400);
    }
    expect(t.s.calls.urls).toHaveLength(0);
  });
});

describe("history", () => {
  // ten years of trading days, the most the server keeps
  const DAYS = 2520;

  function long() {
    const w = world();
    const id = "XX:LONG";
    instrument(w.db, id);
    const dates: string[] = [];
    for (let d = Date.parse("2016-11-01T00:00:00Z"); dates.length < DAYS; ) {
      const day = new Date(d).getUTCDay();
      if (day !== 0 && day !== 6)
        dates.push(new Date(d).toISOString().slice(0, 10));
      d += 86_400_000;
    }
    for (const [k, date] of dates.entries()) {
      const last = k === dates.length - 1;
      bar(w.db, id, "1d", date, 100 + k / 100, !last);
      // every tenth day has no row, so its averages answer null
      if (k % 10 === 5) continue;
      row(w.db, id, "1d", date, last ? "live" : "final", {
        sma50: k,
        sma200: k < 199 ? null : k + 0.5,
      });
    }
    return { w, id, dates };
  }

  test("answers every bar of ten years, oldest first, with its averages", async () => {
    const { w, id, dates } = long();
    const res = await api(w.m)(
      new Request(
        `http://markets.test/api/v1/history?symbol=${id}&from=${dates[0]}`,
      ),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body: any = await res.json();
    expect(
      validate(body, answerSchema(spec, "GET", "/history", 200)!, spec),
    ).toEqual([]);
    expect(body).not.toContainKey("next");
    expect(body.bars).toHaveLength(DAYS);
    expect(body.bars.map((b: any) => b.date)).toEqual(dates);
    expect(body.bars[0]).toEqual({
      date: dates[0],
      close: 100,
      final: true,
      sma50: 0,
      sma200: null,
    });
    expect(body.bars[5]).toMatchObject({ sma50: null, sma200: null });
    expect(body.bars[300]).toMatchObject({
      final: true,
      sma50: 300,
      sma200: 300.5,
    });
    // the session still trading carries its live row
    expect(body.bars.at(-1)).toMatchObject({
      final: false,
      sma50: DAYS - 1,
      sma200: DAYS - 0.5,
    });
    expect(Buffer.byteLength(JSON.stringify(body))).toBeLessThan(200 * 1024);
  });

  test("a range of final bars with its end given may be kept a while", async () => {
    const { w, id, dates } = long();
    const get = (query: string) =>
      api(w.m)(
        new Request(`http://markets.test/api/v1/history?symbol=${id}${query}`),
      );
    const end = dates.at(-2)!;
    const final = await get(`&to=${end}`);
    expect(final.headers.get("cache-control")).toBe("private, max-age=3600");
    // the end moves when a bar lands, and a benchmark is read live
    for (const query of [
      "",
      `&to=${dates.at(-1)}`,
      `&to=${end}&benchmark=${id}`,
    ]) {
      expect((await get(query)).headers.get("cache-control")).toBe("no-store");
    }
  });

  test("a range ending today or later is never kept, its bars final or not", async () => {
    const w = world();
    const id = "XX:DAYS";
    instrument(w.db, id);
    // final up to the day before the fake clock's, in the listing's zone
    for (const date of ["2026-10-20", "2026-10-21", FINAL]) {
      bar(w.db, id, "1d", date, 100, true);
    }
    const cache = async (to: string) =>
      (
        await api(w.m)(
          new Request(
            `http://markets.test/api/v1/history?symbol=${id}&from=2026-10-01&to=${to}`,
          ),
        )
      ).headers.get("cache-control");
    expect(await cache(FINAL)).toBe("private, max-age=3600");
    expect(await cache(LIVE)).toBe("no-store");
    expect(await cache("2027-01-01")).toBe("no-store");
    // the next day the same end is past
    await w.clock.advance(DAY_MS);
    expect(await cache(LIVE)).toBe("private, max-age=3600");
  });

  test("an index's first read answers its final rows and its live row", async () => {
    const t = await setup();
    const body: any = await (await t.call("/history?symbol=^GSPC")).json();
    const live = t.db
      .query<{ date: string; sma50: number; sma200: number }, []>(
        `select date, sma50, sma200 from signals
         where instrument = 'SNP:^GSPC' and kind = 'live' and interval = '1d'`,
      )
      .get()!;
    // Yahoo stamps the index's close 38 minutes after its session's end
    expect(live.date).toBe("2026-10-23");
    const last = body.bars.at(-1);
    expect(last).toMatchObject({ date: live.date, final: false });
    expect(last.sma50).toBe(round(live.sma50));
    expect(last.sma200).toBe(round(live.sma200));
    expect(last.sma200).not.toBeNull();
    const final = body.bars.slice(0, -1);
    expect(final.every((b: any) => b.final && b.sma50 !== null)).toBe(true);
  });

  test("resolves and fetches a new symbol inside the call, as the tool does", async () => {
    const t = await setup();
    const res = await t.call("/history?symbol=NVDA&benchmark=^GSPC");
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.id).toBe("US:NVDA");
    expect(body.bars.length).toBeGreaterThan(50);
    expect(t.s.calls.charts("NVDA").length).toBeGreaterThan(0);
    expect(lastReadAt(t.db, "US:NVDA")).toBe(NOW);
    const tool = tools(t.m).find((x) => x.name === "history")!;
    const args = { symbol: "NVDA", benchmark: "^GSPC" };
    const pages: any[] = [];
    let next: string | null = null;
    do {
      const page: any = JSON.parse(
        (await tool.run({ ...args, ...(next === null ? {} : { next }) }))
          .content[0]!.text,
      );
      pages.push(page);
      next = page.next;
    } while (next !== null);
    expect(pages.length).toBeGreaterThan(1);
    expect(body.relative).toEqual(pages[0].relative);
    const bars = pages.flatMap((p) => p.bars);
    expect(body.bars).toEqual(
      bars.map((b) => ({
        date: b.date,
        close: b.close,
        final: b.final,
        sma50: b.signals?.sma50 ?? null,
        sma200: b.signals?.sma200 ?? null,
      })),
    );
    const missing = await t.call("/history?symbol=ZZNOTHING");
    expect(missing.status).toBe(404);
    const wanted = JSON.parse(
      (await tool.run({ symbol: "ZZNOTHING" })).content[0]!.text,
    );
    expect(await missing.json()).toEqual(wanted);
  });
});

describe("search", () => {
  test("answers the tool's pages joined and marks nothing read", async () => {
    const t = await setup();
    const res = await t.call("/search?query=NVDA");
    const body: any = await res.json();
    const tool = tools(t.m).find((x) => x.name === "search")!;
    const pages: any[] = [];
    let next: string | null = null;
    do {
      const page: any = JSON.parse(
        (await tool.run({ query: "NVDA", ...(next === null ? {} : { next }) }))
          .content[0]!.text,
      );
      pages.push(page);
      next = page.next;
    } while (next !== null);
    expect(body.candidates).toEqual(pages.flatMap((p) => p.candidates));
    expect(body.candidates.length).toBeGreaterThan(0);
    for (const c of body.candidates) expect(lastReadAt(t.db, c.id)).toBeNull();
  });
});

describe("rules", () => {
  test("create, list, pause and delete answer what the tool answers", async () => {
    const rest = await setup();
    const mcp = await setup();
    const tool = tools(mcp.m).find((x) => x.name === "rules")!;
    const run = async (args: object) =>
      JSON.parse(
        (await drive(mcp.clock, pacedOf(mcp.m), tool.run(args))).content[0]!
          .text,
      );
    const rule = {
      symbol: "NVDA",
      condition: { left: "price", op: "<", right: 211 },
      note: "below 211",
    };
    const made = await rest.call("/rules", json(rule));
    expect(made.status).toBe(201);
    expect(await made.json()).toEqual(await run({ action: "create", ...rule }));
    const listed: any = await (await rest.call("/rules")).json();
    const { next, ...page } = await run({ action: "list" });
    expect(next).toBeNull();
    expect(listed).toEqual(page);
    const paused = await rest.call("/rules/1", patch({ paused: true }));
    expect(await paused.json()).toEqual(
      await run({ action: "pause", id: 1, paused: true }),
    );
    const gone = await rest.call("/rules/1", { method: "DELETE" });
    expect(gone.status).toBe(204);
    expect(await gone.text()).toBe("");
    expect(await run({ action: "delete", id: 1 })).toEqual({
      deleted: 1,
      alerts: "kept",
    });
    expect(count(rest.db, "rules")).toBe(0);
    expect(count(rest.db, "alerts")).toBe(count(mcp.db, "alerts"));
    expect(count(rest.db, "alerts")).toBe(1);
  });

  test("a failed create writes nothing", async () => {
    const t = await setup();
    for (const body of [
      { symbol: "ZZNOTHING", condition: { left: "price", op: "<", right: 1 } },
      { symbol: "NVDA", condition: { left: "nothing", op: "<", right: 1 } },
      { symbol: "NVDA" },
    ]) {
      const res = await t.call("/rules", json(body));
      expect(res.status).toBeGreaterThanOrEqual(400);
    }
    expect(count(t.db, "rules")).toBe(0);
    expect(count(t.db, "alerts")).toBe(0);
  });
});

describe("access", () => {
  const sample = (path: string) =>
    path
      .replace("{id}", path.startsWith("/admin") ? "US%3AA" : "1")
      .replace("{file}", "init.js");

  test("every path but the spec and docs needs its own key", () =>
    withApp(async ({ url, bearer, admin }) => {
      const as = (key: string): Record<string, string> => ({
        authorization: `Bearer ${key}`,
      });
      const list = routes({
        m: world().m,
        alerts: async () => new Response(),
        admin: null,
        log: silent,
      });
      const paths = Object.entries(spec.paths).flatMap(([path, item]) =>
        Object.keys(item)
          .filter((k) => METHODS.includes(k))
          .map((k) => ({ method: k.toUpperCase(), path })),
      );
      for (const { method, path } of paths) {
        const at = `${url}${PREFIX}${sample(path)}`;
        const open = list.some((r) => r.path === path && r.key === "none");
        const isAdmin = path.startsWith("/admin");
        const none = await fetch(at, { method });
        expect([method, path, none.status]).toEqual([
          method,
          path,
          open ? 200 : 401,
        ]);
        if (open) continue;
        expect(none.headers.get("www-authenticate")).toBe("Bearer");
        const other = await fetch(at, {
          method,
          headers: as(isAdmin ? bearer : admin),
        });
        expect([method, path, other.status]).toEqual([method, path, 401]);
        const own = await fetch(at, {
          method,
          headers: as(isAdmin ? admin : bearer),
        });
        expect([method, path, own.status === 401]).toEqual([
          method,
          path,
          false,
        ]);
      }
      for (const path of [
        "/api/v1/nothing",
        "/api/v1/docs/other.js",
        "/api/v1/admin/nothing",
        "/api/v1",
      ]) {
        expect([path, (await fetch(`${url}${path}`)).status]).toEqual([
          path,
          401,
        ]);
      }
      expect(
        (await fetch(`${url}/api/v1/nothing`, { headers: as(bearer) })).status,
      ).toBe(404);
      const posted = await fetch(`${url}/api/v1/quotes`, {
        method: "PUT",
        headers: as(bearer),
      });
      expect(posted.status).toBe(405);
      expect(posted.headers.get("allow")).toBe("GET");
    }));

  test("the old paths are gone", () =>
    withApp(async ({ url, bearer, admin }) => {
      for (const [path, key] of [
        ["/quotes?symbols=NVDA", bearer],
        ["/research?symbols=NVDA", bearer],
        ["/alerts", bearer],
        ["/admin/status", admin],
        ["/admin/status", bearer],
        ["/admin/refetch", bearer],
      ] as const) {
        expect((await fetch(`${url}${path}`)).status).toBe(401);
        const res = await fetch(`${url}${path}`, {
          headers: { authorization: `Bearer ${key}` },
        });
        expect([path, res.status]).toEqual([path, key === bearer ? 404 : 401]);
      }
      expect(ADMIN_KEY).not.toBe(admin);
    }));
});

describe("bodies over the cap", () => {
  test("answer the JSON 413 under the server's own limit, and Bun's past it", () =>
    withApp(async ({ url, bearer }) => {
      const post = (bytes: number) =>
        fetch(`${url}/api/v1/screen`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${bearer}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ symbols: ["x".repeat(bytes)] }),
        });
      const ours = await post(MAX_BODY_BYTES);
      expect(ours.status).toBe(413);
      const body = await ours.json();
      expect(body).toMatchObject({ error: "payload_too_large" });
      const schema = answerSchema(spec, "POST", "/screen", 413)!;
      expect(validate(body, schema, spec)).toEqual([]);
      // Bun refuses it before the router runs: no body, nothing logged
      const buns = await post(1024 * 1024);
      expect(buns.status).toBe(413);
      expect(await buns.text()).toBe("");
      const said = (spec.components.responses.TooLarge as any).description;
      expect(said).toContain("empty body");
    }));
});

describe("the docs page", () => {
  test("is served without a key, under a policy, from this server only", () =>
    withApp(async ({ url, lines }) => {
      const page = await fetch(`${url}/api/v1/docs`);
      expect(page.status).toBe(200);
      expect(page.headers.get("content-type")).toContain("text/html");
      expect(page.headers.get("content-security-policy")).toBe(POLICY);
      const html = await page.text();
      const linked = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map(
        (m) => m[1]!,
      );
      expect(linked.sort()).toEqual(
        [
          "data:,",
          "/api/v1/docs/init.js",
          "/api/v1/docs/swagger-ui-bundle.js",
          "/api/v1/docs/swagger-ui.css",
        ].sort(),
      );
      expect(html).not.toMatch(/https?:/);
      expect(html).not.toMatch(/<script>|<script [^>]*>[^<]/);
      const types: Record<string, string> = {
        "init.js": "text/javascript",
        "swagger-ui-bundle.js": "text/javascript",
        "swagger-ui.css": "text/css",
      };
      for (const [file, type] of Object.entries(types)) {
        const res = await fetch(`${url}/api/v1/docs/${file}`);
        expect([file, res.status]).toEqual([file, 200]);
        expect(res.headers.get("content-type")).toContain(type);
        expect(res.headers.get("x-content-type-options")).toBe("nosniff");
        const bytes = new Uint8Array(await res.arrayBuffer());
        if (file !== "init.js") {
          const dist = join(
            import.meta.dir,
            "..",
            "node_modules",
            "swagger-ui-dist",
            file,
          );
          expect(bytes).toEqual(await Bun.file(dist).bytes());
        }
      }
      const init = await (await fetch(`${url}/api/v1/docs/init.js`)).text();
      expect(init).toContain('url: "/api/v1/openapi.json"');
      expect(init).toContain("validatorUrl: null");
      expect(init).toContain("persistAuthorization: false");
      expect(init).not.toMatch(/https?:/);
      const served = await fetch(`${url}/api/v1/openapi.json`);
      expect(await served.json()).toEqual(JSON.parse(JSON.stringify(spec)));
      expect(lines.some((l) => l.includes("path=/api/v1/docs "))).toBe(true);
    }));
});
