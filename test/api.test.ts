// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { connect } from "node:net";
import { join } from "node:path";
import { fingerprint, fingerprinted, POLICY } from "../src/api/docs.ts";
import { MAX_BODY_BYTES, PREFIX } from "../src/api/http.ts";
import { spec } from "../src/api/openapi.ts";
import { routes } from "../src/api/routes.ts";
import { round } from "../src/market/format.ts";
import { readInstrument } from "../src/market/instruments.ts";
import { storeIntraday } from "../src/market/intraday.ts";
import { lastReadAt } from "../src/market/tracking.ts";
import { withLive } from "../src/operations/history.ts";
import { NO_SOURCE } from "../src/operations/intraday.ts";
import { CALL_MS, markets } from "../src/operations/markets.ts";
import { MAX_IMPORT_BODY } from "../src/operations/portfolio-import.ts";
import { DAY_MS } from "../src/runtime/clock.ts";
import { silent } from "../src/runtime/log.ts";
import { CALLS_PER_MINUTE } from "../src/server/ratelimit.ts";
import { COOKIE, sessions } from "../src/server/session.ts";
import { finnhub } from "../src/sources/finnhub/client.ts";
import { fred } from "../src/sources/fred/client.ts";
import { yahoo } from "../src/sources/yahoo/client.ts";
import { type Db, open } from "../src/storage/db/index.ts";
import { writer } from "../src/storage/writer.ts";
import { tools } from "../src/tools/index.ts";
import { restAnswers } from "./helpers/answers.ts";
import { ADMIN_KEY, api, READ_KEY } from "./helpers/api.ts";
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
import {
  bar,
  FINAL,
  instrument,
  LIVE,
  listing,
  row,
  world,
} from "./helpers/world.ts";
import { chartSymbol } from "./helpers/yahoo.ts";

const METHODS = ["get", "post", "put", "patch", "delete"];

const ANSWERS = join(import.meta.dir, "fixtures", "api", "answers.json");

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
  // one source of each kind, so the status answer checks every field
  const handle = api(m, {
    sources: [
      { name: "yahoo", on: true, why: "always", backoff: () => null },
      { name: "fred", on: false, why: "no key", backoff: () => null },
    ],
  });
  const call = (path: string, init: RequestInit = {}) =>
    drive(
      clock,
      pacedOf(m),
      handle(new Request(`http://markets.test${PREFIX}${path}`, init)),
    );
  // held past the deadline, then let go, since it holds a source queue slot
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
      track: () => [],
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
      { $ref: "#/components/schemas/Problem", type: "object" },
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
    const answer = (item: object) => validate({ quotes: [item] }, quotes, spec);
    expect(answer({ input: "X" })).not.toEqual([]);
    expect(
      answer({
        input: "X",
        error: { code: "not_found", detail: "no listing" },
      }),
    ).toEqual([]);
    expect(
      answer({
        input: "X",
        id: "US:X",
        error: { code: "not_found", detail: "m" },
      }),
    ).not.toEqual([]);
    expect(
      answer({ input: "X", error: "not_found", message: "no listing" }),
    ).not.toEqual([]);
    // a research result holds a block its sections asked, never none
    const research = answerSchema(spec, "GET", "/research", 200)!;
    const item = (i: object) => validate({ research: [i] }, research, spec);
    const block = { source: "finnhub" };
    expect(item({ input: "X", id: "US:X" })).not.toEqual([]);
    expect(item({ input: "X", id: "US:X", company: block })).toEqual([]);
    expect(item({ input: "X", id: "US:X", news: block })).toEqual([]);
    expect(
      item({ input: "X", id: "US:X", company: block, news: block }),
    ).toEqual([]);
    const filings = {
      source: "edgar",
      late_filing: null,
      restatement: null,
      offering: null,
    };
    expect(item({ input: "X", id: "US:X", filings })).toEqual([]);
    expect(item({ input: "X", id: "US:X", company: block, filings })).toEqual(
      [],
    );
    expect(
      item({ input: "X", id: "US:X", company: block, news: block, filings }),
    ).toEqual([]);
    expect(
      item({ input: "X", id: "US:X", filings: { source: "edgar" } }),
    ).not.toEqual([]);
    for (const path of ["/movers", "/screen"]) {
      const method = path === "/screen" ? "POST" : "GET";
      const set = answerSchema(spec, method, path, 200)!;
      const sort = path === "/screen" ? { field: "id", order: "asc" } : "x";
      const counts = { matched: 1, not_matched: 0, unavailable: 0, errors: 0 };
      const list = path === "/screen" ? "matches" : "movers";
      expect(
        validate(
          {
            sort,
            counts,
            [list]: [{ input: "X", id: "US:X", status: "matched" }],
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
      const type = res.headers.get("content-type");
      // every error is a problem whose status is the answer's
      if (status >= 400) {
        expect([method, path, status, type]).toEqual([
          method,
          path,
          status,
          "application/problem+json",
        ]);
      }
      const schema = answerSchema(spec, method, path, status);
      if (schema === null) return raw;
      const body = JSON.parse(raw);
      expect([method, path, status, validate(body, schema, spec)]).toEqual([
        method,
        path,
        status,
        [],
      ]);
      if (status >= 400) {
        expect([method, path, body.status, body.type]).toEqual([
          method,
          path,
          status,
          undefined,
        ]);
      }
      return body;
    };
    const wrong = { headers: { authorization: "Bearer wrong" } };
    const reader = { headers: { authorization: `Bearer ${READ_KEY}` } };

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

    const bars = "/instruments/{symbol}/bars";
    const h = await check(
      "GET",
      bars,
      await t.call("/instruments/NVDA/bars?benchmark=^GSPC"),
      200,
    );
    expect(h.relative.returns).toHaveLength(2);
    expect(h).toMatchObject({ input: "NVDA", instrument: { id: "US:NVDA" } });
    // daily bars always carry their candles and volume
    expect(Object.keys(h.bars.at(-2)).sort()).toEqual([
      "close",
      "date",
      "final",
      "high",
      "low",
      "open",
      "sma200",
      "sma50",
      "volume",
    ]);
    await check(
      "GET",
      bars,
      await t.call("/instruments/NVDA/bars?ohlc=true"),
      400,
    );
    // the whole range of 5-minute closes, past a tool's page, in its own schema
    for (const d of ["19", "20", "21", "22", "23"]) {
      const day = Date.parse(`2026-10-${d}T13:30:00Z`);
      storeIntraday(
        t.db,
        "US:NVDA",
        "America/New_York",
        Array.from({ length: 288 }, (_, k) => ({
          at: day + k * 60_000,
          close: 180.123456 + k,
        })),
        NOW,
      );
    }
    const five = await check(
      "GET",
      bars,
      await t.call("/instruments/NVDA/bars?interval=5m&from=2026-10-01"),
      200,
    );
    expect(five).toMatchObject({
      input: "NVDA",
      instrument: { id: "US:NVDA" },
      interval: "5m",
      from: "2026-10-01",
      to: "2026-10-23",
    });
    expect(five.points).toHaveLength(5 * 288);
    expect(five.sessions).toHaveLength(5);
    expect(five.next).toBeUndefined();
    await check(
      "GET",
      bars,
      await t.call("/instruments/NVDA/bars?interval=5m&benchmark=^GSPC"),
      400,
    );
    await check(
      "GET",
      bars,
      await t.call("/instruments/NVDA/bars?interval=1d&extended=true"),
      400,
    );
    await check(
      "GET",
      bars,
      await t.call("/instruments/NVDA/bars?interval=1h"),
      400,
    );
    await check("GET", bars, await t.call("/instruments/A/bars", wrong), 401);
    const missing = await check(
      "GET",
      bars,
      await t.call("/instruments/ZZNOTHING/bars"),
      404,
    );
    expect(missing).toMatchObject({ input: "ZZNOTHING", code: "not_found" });
    const slow = await t.late("SLOWA.DE", "/instruments/SLOWA.DE/bars");
    expect((await check("GET", bars, slow, 503)).code).toBe("timeout");

    await check("GET", "/symbols", await t.call("/symbols?query=NVDA"), 200);
    await check("GET", "/symbols", await t.call("/symbols"), 400);
    await check(
      "GET",
      "/symbols",
      await t.call("/symbols?query=NVDA&upstream=false"),
      200,
    );
    await check(
      "GET",
      "/symbols",
      await t.call("/symbols?query=NVDA&upstream=no"),
      400,
    );
    await check(
      "GET",
      "/symbols",
      await t.call("/symbols?query=A", wrong),
      401,
    );

    const r = await check(
      "GET",
      "/research",
      await t.call(
        "/research?symbols=NVDA,^GSPC&sections=metric,news&since=2026-10-01",
      ),
      200,
    );
    expect(Object.keys(r.research[0].company).sort()).toEqual([
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

    const e = await check(
      "GET",
      "/earnings",
      await t.call("/earnings?from=2026-01-01&to=2026-12-31&symbols=NVDA"),
      200,
    );
    expect(e.earnings).toHaveLength(1);
    await check(
      "GET",
      "/earnings",
      await t.call("/earnings?to=2026-12-31"),
      400,
    );
    await check(
      "GET",
      "/earnings",
      await t.call("/earnings?from=2026-01-01&to=2026-12-31", wrong),
      401,
    );

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

    const rule = {
      symbol: "NVDA",
      condition: { left: "price", op: "<", right: 211 },
      note: "below 211",
    };
    const created = await t.call("/rules", json(rule));
    const location = created.headers.get("location");
    const made = await check("POST", "/rules", created, 201);
    expect(made.alert).not.toBeNull();
    expect(location).toBe(`${PREFIX}/rules/${made.rule.id}`);
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
    const one = await check(
      "GET",
      "/rules/{id}",
      await t.call(location!.slice(PREFIX.length)),
      200,
    );
    expect(one).toEqual({ rule: listed.rules[0] });
    await check("GET", "/rules/{id}", await t.call("/rules/x"), 400);
    await check("GET", "/rules/{id}", await t.call("/rules/999"), 404);
    await check("GET", "/rules/{id}", await t.call(`/rules/${id}`, wrong), 401);
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

    await check("GET", "/watchlist", await t.call("/watchlist"), 200);
    await check("GET", "/watchlist", await t.call("/watchlist?x=1"), 400);
    await check("GET", "/watchlist", await t.call("/watchlist", wrong), 401);

    await check("GET", "/status", await t.call("/status"), 200);
    await check("GET", "/status", await t.call("/status?x=1"), 400);
    await check("GET", "/status", await t.call("/status", wrong), 401);
    await check("GET", "/status", await t.call("/status", reader), 403);
    await check(
      "GET",
      "/instruments",
      await t.call("/instruments?page_size=2"),
      200,
    );
    await check(
      "GET",
      "/instruments",
      await t.call("/instruments?page_size=0"),
      400,
    );
    await check(
      "GET",
      "/instruments",
      await t.call("/instruments", wrong),
      401,
    );
    await check(
      "GET",
      "/instruments",
      await t.call("/instruments", reader),
      403,
    );
    // signed in by the UI's cookie, without this server's Origin
    const cookie = {
      cookie: `${COOKIE}=${sessions(ADMIN_KEY).issue(t.clock.now())}`,
    };
    await check(
      "POST",
      "/screen",
      await t.call("/screen", {
        ...json({ symbols: ["US:NVDA"] }),
        headers: { "content-type": "application/json", ...cookie },
      }),
      403,
    );
    const again = "/instruments/{symbol}/refetch";
    const refetch = { parts: ["quotes"] };
    await check(
      "POST",
      again,
      await t.call("/instruments/US:NVDA/refetch", {
        ...json(refetch),
        headers: { "content-type": "application/json", ...cookie },
      }),
      403,
    );
    await check(
      "POST",
      again,
      await t.call("/instruments/US:NVDA/refetch", json(refetch)),
      200,
    );
    await check(
      "POST",
      again,
      await t.call("/instruments/US:NOPE/refetch", json(refetch)),
      404,
    );
    await check(
      "POST",
      again,
      await t.call("/instruments/US:NVDA/refetch", json({ parts: [] })),
      400,
    );
    await check(
      "POST",
      again,
      await t.call("/instruments/US:NVDA/refetch", {
        ...json(refetch),
        ...wrong,
      }),
      401,
    );
    await check(
      "POST",
      again,
      await t.call("/instruments/US:NVDA/refetch", {
        ...json(refetch),
        ...reader,
      }),
      403,
    );
    await check(
      "POST",
      again,
      await t.call(
        "/instruments/US:NVDA/refetch",
        json({ parts: ["x".repeat(20_000)] }),
      ),
      413,
    );
    await check(
      "POST",
      again,
      await t.call("/instruments/US:NVDA/refetch", json(refetch, "text/plain")),
      415,
    );
    const board = "/dashboard";
    const put = (body: unknown, init: RequestInit = {}) =>
      t.call(board, { ...json(body), method: "PUT", ...init });
    const layout = (revision: number, symbols: string[]) => ({
      revision,
      sections: [{ name: "Mine", view: "cards", symbols }],
    });
    await check("GET", board, await t.call(board), 200);
    await check("GET", board, await t.call(`${board}?x=1`), 400);
    await check("GET", board, await t.call(board, wrong), 401);
    await check("GET", board, await t.call(board, reader), 403);
    await check("PUT", board, await put(layout(0, ["NVDA"])), 200);
    await check("PUT", board, await put(layout(0, ["NVDA"])), 409);
    await check("PUT", board, await put(layout(1, ["ZZNOTHING"])), 422);
    await check("PUT", board, await put({ revision: 1 }), 400);
    await check("PUT", board, await put(layout(1, []), wrong), 401);
    await check("PUT", board, await put(layout(1, []), reader), 403);
    await check("PUT", board, await put(layout(1, ["x".repeat(70_000)])), 413);
    await check(
      "PUT",
      board,
      await t.call(board, {
        ...json(layout(1, []), "text/plain"),
        method: "PUT",
      }),
      415,
    );
    const path = "/instruments/{symbol}";
    const at = (id: string, init: RequestInit = {}) =>
      t.call(`/instruments/${encodeURIComponent(id)}`, init);
    const del = (id: string, init: RequestInit = {}) =>
      at(id, { method: "DELETE", ...init });
    await check("GET", path, await at("US:NVDA"), 200);
    await check("GET", path, await at("NVDA", reader), 200);
    await check("GET", path, await at("ZZNOTHING"), 404);
    await check("GET", path, await t.call("/instruments/%E0%A4%A"), 400);
    await check("GET", path, await at("US:NVDA", wrong), 401);
    const slowRead = await t.late("SLOWD.DE", "/instruments/SLOWD.DE");
    await check("GET", path, slowRead, 503);
    await check("DELETE", path, await del("US:NVDA"), 409);
    await check("DELETE", path, await del("FRED:DGS10"), 204);
    await check("DELETE", path, await del("FRED:DGS10"), 404);
    await check("DELETE", path, await del("<b>"), 400);
    await check("DELETE", path, await del("US:NVDA", wrong), 401);
    await check("DELETE", path, await del("US:NVDA", reader), 403);

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

    await check("GET", "/openapi.json", await t.call("/openapi.json"), 200);
    await check("GET", "/openapi.json", await t.call("/openapi.json?x=1"), 400);
    await check("GET", "/docs", await t.call("/docs"), 200);
    await check("GET", "/docs/{file}", await t.call("/docs/init.js"), 200);
    await check("GET", "/docs/{file}", await t.call("/docs/init.js?x=1"), 400);

    const madeKey = await check(
      "POST",
      "/keys",
      await t.call("/keys", json({ name: "claude-code", expiresInDays: 30 })),
      201,
    );
    expect(madeKey.token).toStartWith("1ctx-markets-");
    await check(
      "POST",
      "/keys",
      await t.call("/keys", json({ name: "Not A Name" })),
      400,
    );
    await check(
      "POST",
      "/keys",
      await t.call("/keys", json({ name: "claude-code" })),
      409,
    );
    await check(
      "POST",
      "/keys",
      await t.call("/keys", json({ name: "x".repeat(70_000) })),
      413,
    );
    await check(
      "POST",
      "/keys",
      await t.call("/keys", json({ name: "codex" }, "text/plain")),
      415,
    );
    await check(
      "POST",
      "/keys",
      await t.call("/keys", { ...json({ name: "codex" }), ...wrong }),
      401,
    );
    await check(
      "POST",
      "/keys",
      await t.call("/keys", { ...json({ name: "codex" }), ...reader }),
      403,
    );
    const listedKeys = await check("GET", "/keys", await t.call("/keys"), 200);
    expect(listedKeys.keys.map((k: { name: string }) => k.name)).toEqual([
      "test-read",
      "claude-code",
    ]);
    await check("GET", "/keys", await t.call("/keys?x=1"), 400);
    await check("GET", "/keys", await t.call("/keys", wrong), 401);
    await check("GET", "/keys", await t.call("/keys", reader), 403);
    const keyAt = `/keys/${madeKey.key.id}`;
    const revoke = (init: RequestInit = {}) =>
      t.call(keyAt, { method: "DELETE", ...init });
    await check("DELETE", "/keys/{id}", await revoke(wrong), 401);
    await check("DELETE", "/keys/{id}", await revoke(reader), 403);
    await check(
      "DELETE",
      "/keys/{id}",
      await t.call(`${keyAt}?x=1`, { method: "DELETE" }),
      400,
    );
    await check("DELETE", "/keys/{id}", await revoke(), 204);
    await check("DELETE", "/keys/{id}", await revoke(), 404);

    await portfolioOperations(t, check, wrong, reader);

    // past the minute's calls every keyed operation is refused before it
    // runs, whatever it was sent
    for (const key of [READ_KEY, ADMIN_KEY]) {
      for (let k = 0; k < CALLS_PER_MINUTE; k++) {
        await t.call("/nothing", {
          headers: { authorization: `Bearer ${key}` },
        });
      }
    }
    for (const [path, item] of Object.entries(spec.paths)) {
      for (const [method, op] of Object.entries(item)) {
        if (!METHODS.includes(method)) continue;
        if (!("429" in (op as { responses: object }).responses)) continue;
        const at = path.replace("{symbol}", "US%3ANVDA").replace("{id}", "1");
        await check(
          method.toUpperCase(),
          path,
          await t.call(at, { method: method.toUpperCase() }),
          429,
        );
      }
    }

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
    expect(res.headers.get("content-type")).toBe("application/problem+json");
    const body = await res.json();
    expect(body).toEqual({
      title: "Internal Server Error",
      status: 500,
      detail: "internal error",
      code: "internal",
    });
    const schema = answerSchema(spec, "GET", "/rules", 500)!;
    expect(validate(body, schema, spec)).toEqual([]);
  });

  test("refuses next and any argument a route does not take", async () => {
    const t = await setup();
    for (const path of [
      "/quotes?symbols=NVDA&next=1",
      "/instruments/NVDA/bars?next=1",
      "/symbols?query=NVDA&next=1",
      "/research?symbols=NVDA&next=1",
      "/earnings?from=2026-01-01&to=2026-01-02&next=1",
      "/movers?symbols=NVDA&min_move_pct=1&next=1",
      "/quotes?symbols=NVDA&benchmark=^GSPC",
      "/quotes?symbols=NVDA&extended=yes",
      "/quotes?symbols=NVDA&extended=true&extended=false",
      "/instruments/NVDA/bars?symbol=NVDA",
      "/instruments/NVDA?extended=true",
      "/watchlist?x=1",
      "/alerts?next=1",
    ]) {
      const res = await t.call(path);
      expect([path, res.status]).toEqual([path, 400]);
      expect(((await res.json()) as any).code).toBe("bad_arguments");
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

describe("bars", () => {
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
        `http://markets.test/api/v1/instruments/${id}/bars?from=${dates[0]}`,
      ),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body: any = await res.json();
    expect(
      validate(
        body,
        answerSchema(spec, "GET", "/instruments/{symbol}/bars", 200)!,
        spec,
      ),
    ).toEqual([]);
    expect(body).not.toContainKey("next");
    expect(body.bars).toHaveLength(DAYS);
    expect(body.bars.map((b: any) => b.date)).toEqual(dates);
    expect(body.bars[0]).toEqual({
      date: dates[0],
      open: 100,
      high: 100,
      low: 100,
      close: 100,
      volume: 1000,
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
  });

  test("a range of final bars with its end given may be kept a while", async () => {
    const { w, id, dates } = long();
    const get = (query: string) =>
      api(w.m)(
        new Request(
          `http://markets.test/api/v1/instruments/${id}/bars${query}`,
        ),
      );
    const end = dates.at(-2)!;
    const final = await get(`?to=${end}`);
    expect(final.headers.get("cache-control")).toBe("private, max-age=3600");
    // the end moves when a bar lands, and a benchmark is read live
    for (const query of [
      "",
      `?to=${dates.at(-1)}`,
      `?to=${end}&benchmark=${id}`,
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
            `http://markets.test/api/v1/instruments/${id}/bars?from=2026-10-01&to=${to}`,
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

  test("the session's bar never ranges short of its quote's price", () => {
    const stored = {
      date: "2026-10-22",
      open: 10,
      high: 11,
      low: 9,
      close: 10,
      volume: 5,
      final: true,
    };
    // a day range read before the last trade, which moved past it
    const quote = { dayHigh: 12, dayLow: 11.5, volume: 7, time: 0 };
    const up = withLive(
      [stored],
      { date: "2026-10-23", quote: { ...quote, price: 12.5 } },
      "1d",
    ).at(-1)!;
    expect(up).toMatchObject({ high: 12.5, low: 11.5, close: 12.5 });
    const down = withLive(
      [stored],
      { date: "2026-10-23", quote: { ...quote, price: 11 } },
      "1d",
    ).at(-1)!;
    expect(down).toMatchObject({ high: 12, low: 11, close: 11 });
    // no range at all stays none
    const bare = withLive(
      [stored],
      {
        date: "2026-10-23",
        quote: {
          dayHigh: null,
          dayLow: null,
          volume: null,
          time: 0,
          price: 11,
        },
      },
      "1d",
    ).at(-1)!;
    expect(bare).toMatchObject({ high: null, low: null, close: 11 });
  });

  test("an index's first read answers its final rows and its live row", async () => {
    const t = await setup();
    const body: any = await (await t.call("/instruments/^GSPC/bars")).json();
    expect(body.instrument.unit).toBe("index_points");
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
    const res = await t.call("/instruments/NVDA/bars?benchmark=^GSPC");
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.instrument.id).toBe("US:NVDA");
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
        open: b.open,
        high: b.high,
        low: b.low,
        close: b.close,
        volume: b.volume,
        final: b.final,
        sma50: b.signals?.sma50 ?? null,
        sma200: b.signals?.sma200 ?? null,
      })),
    );
    const missing = await t.call("/instruments/ZZNOTHING/bars");
    expect(missing.status).toBe(404);
    const wanted = JSON.parse(
      (await tool.run({ symbol: "ZZNOTHING" })).content[0]!.text,
    );
    expect(wanted.message).toBe("no listing found; try search");
    expect(await missing.json()).toEqual({
      title: "Not Found",
      status: 404,
      detail: "no listing found; try GET /api/v1/symbols",
      code: wanted.error,
      input: wanted.input,
    });
  });
});

describe("an unknown symbol", () => {
  test("points to the symbols route, whole call or one item", async () => {
    const t = await setup();
    const hint = "no listing found; try GET /api/v1/symbols";
    for (const path of [
      "/instruments/ZZNOTHING",
      "/instruments/ZZNOTHING/bars",
      "/instruments/ZZNOTHING/bars?interval=5m",
    ]) {
      const res = await t.call(path);
      expect([path, res.status]).toEqual([path, 404]);
      expect(await res.json()).toMatchObject({
        code: "not_found",
        detail: hint,
      });
    }
    const res = await t.call("/quotes?symbols=NVDA,ZZNOTHING");
    const body: any = await res.json();
    expect(body.quotes[1]).toEqual({
      input: "ZZNOTHING",
      error: { code: "not_found", detail: hint },
    });
    // a rule's miss names its input first
    const rule = await t.call(
      "/rules",
      json({
        symbol: "ZZNOTHING",
        condition: { left: "price", op: "<", right: 1 },
      }),
    );
    expect(rule.status).toBe(404);
    expect(await rule.json()).toMatchObject({
      code: "not_found",
      detail: `ZZNOTHING: ${hint}`,
    });
    const earnings: any = await (
      await t.call("/earnings?from=2026-01-01&to=2026-12-31&symbols=ZZNOTHING")
    ).json();
    expect(earnings.unavailable).toEqual([
      expect.objectContaining({ input: "ZZNOTHING", message: hint }),
    ]);
  });
});

describe("symbols", () => {
  test("answers the search tool's pages joined and marks nothing read", async () => {
    const t = await setup();
    const res = await t.call("/symbols?query=NVDA");
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

  test("upstream false answers stored matches and asks no source", async () => {
    const t = await setup();
    expect((await t.call("/quotes?symbols=NVDA")).status).toBe(200);
    const before = t.s.calls.urls.length;
    const res = await t.call("/symbols?query=nvd&upstream=false");
    const body: any = await res.json();
    expect(t.s.calls.urls.slice(before)).toEqual([]);
    expect(body.candidates).toEqual([
      expect.objectContaining({ id: "US:NVDA", stored: true }),
    ]);
    const full: any = await (await t.call("/symbols?query=nvd")).json();
    expect(t.s.calls.searches().length).toBeGreaterThan(0);
    expect(full.candidates[0]).toEqual(body.candidates[0]);
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
    expect(made.headers.get("location")).toBe(`${PREFIX}/rules/1`);
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
      .replace("{symbol}", "US%3AA")
      .replace("{id}", "1")
      .replace("{file}", "init.js");

  test("each operation takes its scope; the admin key holds every one and /mcp", () =>
    withApp(async ({ url, bearer, admin }) => {
      const as = (key: string): Record<string, string> => ({
        authorization: `Bearer ${key}`,
      });
      const list = routes({
        m: world().m,
        alerts: async () => new Response(),
        admin: { m: world().m, version: "v", sources: [] },
        track: () => [],
        log: silent,
      });
      const paths = Object.entries(spec.paths).flatMap(([path, item]) =>
        Object.keys(item)
          .filter((k) => METHODS.includes(k))
          .map((k) => ({ method: k.toUpperCase(), path })),
      );
      for (const { method, path } of paths) {
        const r = list.find((x) => x.path === path && x.method === method)!;
        // an unknown argument is refused after the key, before any read
        const at = `${url}${PREFIX}${sample(path)}${r.scope === "none" ? "" : "?x=1"}`;
        const none = await fetch(at, { method });
        expect([method, path, none.status]).toEqual([
          method,
          path,
          r.scope === "none" ? 200 : 401,
        ]);
        if (r.scope === "none") continue;
        expect(none.headers.get("www-authenticate")).toBeNull();
        expect(none.headers.get("content-type")).toBe(
          "application/problem+json",
        );
        const read = await fetch(at, { method, headers: as(bearer) });
        // the agent key here has no portfolio access
        const forbidden = r.scope !== "read";
        expect([method, path, read.status === 403]).toEqual([
          method,
          path,
          forbidden,
        ]);
        expect([method, path, read.status === 401]).toEqual([
          method,
          path,
          false,
        ]);
        if (forbidden) {
          expect(await read.json()).toMatchObject({ code: "forbidden" });
        }
        const own = await fetch(at, { method, headers: as(admin) });
        expect([
          method,
          path,
          own.status === 401 || own.status === 403,
        ]).toEqual([method, path, false]);
      }
      for (const path of [
        "/api/v1/nothing",
        "/api/v1/docs/other.js",
        "/api/v1/instruments/US:A/nothing",
        "/api/v1",
      ]) {
        expect([path, (await fetch(`${url}${path}`)).status]).toEqual([
          path,
          401,
        ]);
      }
      for (const [key, path] of [
        [bearer, "/api/v1/nothing"],
        [admin, "/api/v1/nothing"],
        [bearer, "/api/v1"],
        [admin, "/api/v1"],
      ] as const) {
        const res = await fetch(`${url}${path}`, { headers: as(key) });
        expect([path, res.status]).toEqual([path, 404]);
        expect(res.headers.get("content-type")).toBe(
          "application/problem+json",
        );
        expect(await res.json()).toEqual({
          title: "Not Found",
          status: 404,
          detail: "no such route",
          code: "not_found",
        });
      }
      const posted = await fetch(`${url}/api/v1/quotes`, {
        method: "PUT",
        headers: as(bearer),
      });
      expect(posted.status).toBe(405);
      expect(posted.headers.get("allow")).toBe("GET");
      expect((await posted.json()).code).toBe("method_not_allowed");
      // /mcp's refusal keeps the shape it always had
      const mcp = await fetch(`${url}/mcp`, { method: "POST" });
      expect(mcp.status).toBe(401);
      expect(mcp.headers.get("content-type")).toBe("application/json");
      expect(await mcp.json()).toEqual({
        error: "unauthorized",
        message: "no or wrong key",
      });
    }));

  test("the old paths are gone", () =>
    withApp(async ({ url, bearer, admin }) => {
      for (const path of [
        "/history?symbol=NVDA",
        "/search?query=NVDA",
        "/events?from=2026-01-01&to=2026-01-02",
        "/admin/status",
        "/admin/instruments",
        "/admin/instruments/US:NVDA",
        "/admin/refetch",
      ]) {
        expect((await fetch(`${url}/api/v1${path}`)).status).toBe(401);
        for (const key of [bearer, admin]) {
          const res = await fetch(`${url}/api/v1${path}`, {
            headers: { authorization: `Bearer ${key}` },
          });
          expect([path, res.status]).toEqual([path, 404]);
        }
      }
      // the paths without the prefix were never routes
      expect((await fetch(`${url}/quotes`)).status).toBe(401);
      expect(ADMIN_KEY).not.toBe(admin);
    }));
});

describe("one instrument", () => {
  test("a read fetches a symbol never stored; delete and refetch fetch nothing", async () => {
    const t = await setup();
    const reader = { headers: { authorization: `Bearer ${READ_KEY}` } };
    const res = await t.call("/instruments/NVDA", reader);
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body).toMatchObject({
      input: "NVDA",
      instrument: { id: "US:NVDA", tracked_by: ["read"] },
      quote: { id: "US:NVDA" },
      error: null,
    });
    expect(t.s.calls.charts("NVDA").length).toBeGreaterThan(0);
    expect(lastReadAt(t.db, "US:NVDA")).toBe(NOW);
    const asked = t.s.calls.urls.length;
    for (const init of [
      { method: "DELETE" },
      json({ parts: ["bars"] }),
    ] as RequestInit[]) {
      const path = `/instruments/AMD${init.method === "POST" ? "/refetch" : ""}`;
      const res = await t.call(path, init);
      expect([path, res.status]).toEqual([path, 404]);
    }
    expect(t.s.calls.urls.length).toBe(asked);
  });
});

describe("the watchlist", () => {
  test("names FRED's terms once when an entry is a series", async () => {
    const w = world();
    instrument(w.db, "FRED:DGS10");
    instrument(w.db, "US:AAA");
    const ask = async (ids: string[]) => {
      const res = await api(w.m, {
        track: () => ids.map((id) => ({ value: id, id, state: "tracked" })),
      })(new Request(`http://markets.test${PREFIX}/watchlist`));
      const raw = await res.text();
      const body = JSON.parse(raw);
      const schema = answerSchema(spec, "GET", "/watchlist", 200)!;
      expect(validate(body, schema, spec)).toEqual([]);
      return { raw, body };
    };
    const both = await ask(["US:AAA", "FRED:DGS10"]);
    expect(both.body.attribution).toContain("FRED");
    expect(both.raw.split(both.body.attribution)).toHaveLength(2);
    expect((await ask(["US:AAA"])).body).not.toHaveProperty("attribution");
  });

  test("says which entries have 5-minute closes", async () => {
    const w = world();
    for (const id of ["FRED:DGS10", "US:AAA", "US:BBB"]) listing(w.db, id);
    w.db
      .query("update instruments set source = 'yahoo' where id = 'US:AAA'")
      .run();
    // read lately, so the 5-minute read below fetches nothing
    w.db.query("update instruments set last_read_at = ?").run(NOW);
    const res = await api(w.m, {
      track: () => [
        { value: "AAA", id: "US:AAA", state: "tracked" },
        { value: "FRED:DGS10", id: "FRED:DGS10", state: "tracked" },
        { value: "BBB", id: "US:BBB", state: "tracked" },
        { value: "ZZNOPE", id: null, state: "not_found" },
        { value: "CCC", id: null, state: "pending" },
      ],
    })(new Request(`http://markets.test${PREFIX}/watchlist`));
    const body = await res.json();
    expect(
      validate(body, answerSchema(spec, "GET", "/watchlist", 200)!, spec),
    ).toEqual([]);
    expect(body.entries.map((e: any) => [e.value, e.intraday])).toEqual([
      ["AAA", true],
      ["FRED:DGS10", false],
      ["BBB", false],
      ["ZZNOPE", false],
      ["CCC", false],
    ]);
    // the 5-minute read refuses exactly the entries the watchlist marks false
    for (const id of ["US:AAA", "FRED:DGS10", "US:BBB"]) {
      const res = await api(w.m)(
        new Request(
          `http://markets.test${PREFIX}/instruments/${id}/bars?interval=5m`,
        ),
      );
      const refused = JSON.stringify(await res.json()).includes(NO_SOURCE);
      const entry = body.entries.find((e: any) => e.id === id);
      expect([id, refused]).toEqual([id, !entry.intraday]);
    }
  });
});

describe("a symbol in a path", () => {
  // stored from Yahoo and read lately, so a read fetches nothing
  const FORMS: [string, string][] = [
    ["^VIX", "CXI:^VIX"],
    ["CL=F", "NYM:CL=F"],
    ["VVSM.DE", "XETRA:VVSM"],
    ["BRK-B", "US:BRK-B"],
    ["BTC-USD", "CRYPTO:BTC-USD"],
  ];

  function stored() {
    const w = world();
    for (const [symbol, id] of FORMS) {
      listing(w.db, id);
      w.db
        .query(
          "update instruments set source = 'yahoo', source_symbol = ? where id = ?",
        )
        .run(symbol, id);
    }
    listing(w.db, "BVB:R2809A");
    w.db.query("update instruments set last_read_at = ?").run(NOW);
    return w;
  }

  test("takes Yahoo's forms as written, a raw ^ or %5E, a regional form and an id", async () => {
    const w = stored();
    const handle = api(w.m);
    const at = (path: string, init: RequestInit = {}) =>
      handle(new Request(`http://markets.test${PREFIX}${path}`, init));
    const cases: [string, string, string][] = [
      ...FORMS.map(([s, id]): [string, string, string] => [s, s, id]),
      ["%5EVIX", "^VIX", "CXI:^VIX"],
      ["BVB:R2809A", "BVB:R2809A", "BVB:R2809A"],
      ["US%3ABRK-B", "US:BRK-B", "US:BRK-B"],
    ];
    for (const [sent, input, id] of cases) {
      const one = await at(`/instruments/${sent}`);
      expect([sent, one.status]).toEqual([sent, 200]);
      expect(await one.json()).toMatchObject({ input, instrument: { id } });
      const bars = await at(`/instruments/${sent}/bars`);
      expect([sent, bars.status]).toEqual([sent, 200]);
      expect(await bars.json()).toMatchObject({ input, instrument: { id } });
      const again = await at(`/instruments/${sent}/refetch`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ parts: ["calendar"] }),
      });
      expect([sent, again.status]).toEqual([sent, 200]);
      expect(await again.json()).toMatchObject({ input, id });
    }
    for (const [sent, id] of [
      ["^VIX", "CXI:^VIX"],
      ["BVB:R2809A", "BVB:R2809A"],
      ["US%3ABRK-B", "US:BRK-B"],
    ]) {
      expect(
        (await at(`/instruments/${sent}`, { method: "DELETE" })).status,
      ).toBe(204);
      expect([sent, readInstrument(w.db, id!)]).toEqual([sent, null]);
    }
  });

  test("JSON bodies take ^VIX as written", async () => {
    const w = stored();
    const handle = api(w.m);
    const screened: any = await (
      await handle(
        new Request(
          `http://markets.test${PREFIX}/screen`,
          json({
            symbols: ["^VIX", "CL=F"],
            sort: "rsi14",
          }),
        ),
      )
    ).json();
    expect(screened.matches.map((x: any) => [x.input, x.id])).toEqual([
      ["^VIX", "CXI:^VIX"],
      ["CL=F", "NYM:CL=F"],
    ]);
    const made = await handle(
      new Request(
        `http://markets.test${PREFIX}/rules`,
        json({
          symbol: "^VIX",
          condition: { left: "price", op: ">", right: 1 },
        }),
      ),
    );
    expect(made.status).toBe(201);
    expect(((await made.json()) as any).rule.symbol).toBe("CXI:^VIX");
  });

  test("every answer names the server's start, never its version", () =>
    withApp(async ({ url, bearer }) => {
      const answered = await fetch(`${url}${PREFIX}/status`, {
        headers: { authorization: `Bearer ${bearer}` },
      });
      const build = answered.headers.get("x-markets-build");
      expect(build).toMatch(/^[0-9a-f-]{36}$/);
      const refused = await fetch(`${url}${PREFIX}/status`);
      expect(refused.status).toBe(401);
      expect(refused.headers.get("x-markets-build")).toBe(build);
    }));

  test("a raw ^ sent on the wire reaches the route", () =>
    withApp(async ({ url, bearer }) => {
      const { port } = new URL(url);
      const raw = await new Promise<string>((resolve, reject) => {
        let got = "";
        const socket = connect(Number(port), "127.0.0.1", () => {
          socket.write(
            `GET ${PREFIX}/instruments/^VIX/bars?x=1 HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer ${bearer}\r\nConnection: close\r\n\r\n`,
          );
        });
        socket.on("data", (d) => {
          got += d.toString();
        });
        socket.on("end", () => resolve(got));
        socket.on("error", reject);
      });
      // past the route and the key, the argument is refused, not the path
      expect(raw).toStartWith("HTTP/1.1 400");
      expect(raw).toContain('"detail":"unknown argument x"');
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
      expect(ours.headers.get("content-type")).toBe("application/problem+json");
      const body = await ours.json();
      expect(body).toMatchObject({ code: "payload_too_large", status: 413 });
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
      // asked again on every load, so a new build's fingerprints are seen
      expect(page.headers.get("cache-control")).toBe("no-cache");
      const linked = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map(
        (m) => m[1]!,
      );
      expect(linked.filter((l) => l !== "data:,").length).toBe(3);
      expect(linked).toContain("data:,");
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
        // the page names each file with its bytes' fingerprint
        expect(linked).toContain(
          `/api/v1/docs/${file}?h=${fingerprint(bytes)}`,
        );
        // a stale fingerprint or none still answers the current file
        for (const h of [`?h=${fingerprint(bytes)}`, "?h=0123456789ab", ""]) {
          const again = await fetch(`${url}/api/v1/docs/${file}${h}`);
          expect([file, h, again.status]).toEqual([file, h, 200]);
          expect(new Uint8Array(await again.arrayBuffer())).toEqual(bytes);
        }
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

  test("a file's fingerprint follows its bytes", () => {
    const one = new TextEncoder().encode("window.a = 1;");
    const two = new TextEncoder().encode("window.a = 2;");
    expect(fingerprint(one)).toMatch(/^[0-9a-f]{12}$/);
    expect(fingerprint(one)).toBe(fingerprint(one.slice()));
    expect(fingerprint(two)).not.toBe(fingerprint(one));
    const html = [
      '<link href="/api/v1/docs/swagger-ui.css" />',
      '<script src="/api/v1/docs/swagger-ui-bundle.js"></script>',
      '<script src="/api/v1/docs/init.js"></script>',
    ].join("");
    const hashes = {
      "swagger-ui.css": "a",
      "swagger-ui-bundle.js": "b",
      "init.js": fingerprint(two),
    };
    expect(fingerprinted(html, hashes)).toContain(
      `/api/v1/docs/init.js?h=${fingerprint(two)}"`,
    );
    // a page that leaves a file out fails at start, never serves it stale
    expect(() =>
      fingerprinted(html.replace("init.js", "other.js"), hashes),
    ).toThrow("init.js");
  });
});

describe("the routes' answers", () => {
  test("are the status, headers and bytes recorded", async () => {
    const want: Awaited<ReturnType<typeof restAnswers>> =
      await Bun.file(ANSWERS).json();
    const got = await restAnswers();
    expect(Object.keys(got)).toEqual(Object.keys(want));
    for (const [call, answer] of Object.entries(want)) {
      expect([call, got[call]]).toEqual([call, answer]);
    }
  });
});

type Check = (
  method: string,
  path: string,
  res: Response,
  status: number,
) => Promise<any>;

// every portfolio operation's success and documented errors, on made-up rows
async function portfolioOperations(
  t: Awaited<ReturnType<typeof setup>>,
  check: Check,
  wrong: RequestInit,
  reader: RequestInit,
) {
  const send = (method: string, body: unknown, type = "application/json") => ({
    method,
    headers: { "content-type": type },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  const as = (init: RequestInit, key: RequestInit): RequestInit => ({
    ...init,
    headers: { ...(init.headers as object), ...(key.headers as object) },
  });
  // a key's minute of calls opens again, so this many fit
  const call = t.call;
  let calls = 0;
  t = {
    ...t,
    call: async (path: string, init?: RequestInit) => {
      if (++calls % 50 === 0) await t.clock.advance(60_000);
      return call(path, init);
    },
  };
  await t.clock.advance(60_000);
  // each refusal any keyed portfolio operation shares
  const refusals = async (
    method: string,
    path: string,
    at: string,
    init: RequestInit = { method },
  ) => {
    await check(method, path, await t.call(at, as(init, wrong)), 401);
    await check(method, path, await t.call(at, as(init, reader)), 403);
  };

  const P = "/portfolios";
  const made = await check(
    "POST",
    P,
    await t.call(P, send("POST", { name: "Casey" })),
    201,
  );
  const pid = made.portfolio.id;
  await check("POST", P, await t.call(P, send("POST", { name: "casey" })), 409);
  await check("POST", P, await t.call(P, send("POST", {})), 400);
  await check("POST", P, await t.call(P, send("POST", "x", "text/plain")), 415);
  await refusals("POST", P, P, send("POST", { name: "Other" }));
  await check("GET", P, await t.call(P), 200);
  await check("GET", P, await t.call(`${P}?x=1`), 400);
  await refusals("GET", P, P);

  const one = `${P}/{id}`;
  const at = `${P}/${pid}`;
  await check("GET", one, await t.call(at), 200);
  await check("GET", one, await t.call(`${P}/x`), 400);
  await check("GET", one, await t.call(`${P}/999`), 404);
  await refusals("GET", one, at);
  const spare = (
    await t.call(P, send("POST", { name: "Spare" })).then((r) => r.json())
  ).portfolio.id;
  await check(
    "PATCH",
    one,
    await t.call(`${P}/${spare}`, send("PATCH", { name: "Spare two" })),
    200,
  );
  await check(
    "PATCH",
    one,
    await t.call(`${P}/${spare}`, send("PATCH", { name: "Casey" })),
    409,
  );
  await check(
    "PATCH",
    one,
    await t.call(`${P}/${spare}`, send("PATCH", { nope: 1 })),
    400,
  );
  await check(
    "PATCH",
    one,
    await t.call(`${P}/999`, send("PATCH", { name: "Z" })),
    404,
  );
  await check(
    "PATCH",
    one,
    await t.call(`${P}/${spare}`, send("PATCH", "x", "text/plain")),
    415,
  );
  await refusals("PATCH", one, at, send("PATCH", { name: "Z" }));

  const B = "/brokers";
  const north = (
    await check(
      "POST",
      B,
      await t.call(B, send("POST", { name: "North" })),
      201,
    )
  ).broker.id;
  await check("POST", B, await t.call(B, send("POST", { name: "NORTH" })), 409);
  await check("POST", B, await t.call(B, send("POST", { name: "" })), 400);
  await check("POST", B, await t.call(B, send("POST", "x", "text/plain")), 415);
  await refusals("POST", B, B, send("POST", { name: "South" }));
  await check("GET", B, await t.call(B), 200);
  await check("GET", B, await t.call(`${B}?x=1`), 400);
  await refusals("GET", B, B);
  const south = (
    await t.call(B, send("POST", { name: "South" })).then((r) => r.json())
  ).broker.id;
  const bone = `${B}/{id}`;
  await check(
    "PATCH",
    bone,
    await t.call(`${B}/${south}`, send("PATCH", { name: "South two" })),
    200,
  );
  await check(
    "PATCH",
    bone,
    await t.call(`${B}/${south}`, send("PATCH", { name: "north" })),
    409,
  );
  await check(
    "PATCH",
    bone,
    await t.call(`${B}/${south}`, send("PATCH", { x: 1 })),
    400,
  );
  await check(
    "PATCH",
    bone,
    await t.call(`${B}/999`, send("PATCH", { name: "Q" })),
    404,
  );
  await check(
    "PATCH",
    bone,
    await t.call(`${B}/${south}`, send("PATCH", "x", "text/plain")),
    415,
  );
  await refusals("PATCH", bone, `${B}/${south}`, send("PATCH", { name: "Q" }));

  const T = "/trades";
  const trade = {
    portfolio: pid,
    symbol: "NVDA",
    side: "buy",
    quantity: 2,
    price: 100,
    broker: "north",
    date: "2026-10-01",
  };
  const bought = await check(
    "POST",
    T,
    await t.call(T, send("POST", trade)),
    201,
  );
  const tid = bought.trade.id;
  await check(
    "POST",
    T,
    await t.call(T, send("POST", { ...trade, side: "hold" })),
    400,
  );
  await check(
    "POST",
    T,
    await t.call(T, send("POST", { ...trade, broker: "Nowhere" })),
    404,
  );
  await check("POST", T, await t.call(T, send("POST", "x", "text/plain")), 415);
  const slowTrade = await t.late(
    "SLOWE.DE",
    T,
    send("POST", { ...trade, symbol: "SLOWE.DE" }),
  );
  expect((await check("POST", T, slowTrade, 503)).code).toBe("timeout");
  await refusals("POST", T, T, send("POST", trade));
  await check(
    "GET",
    T,
    await t.call(`${T}?portfolio=Casey&broker=North&symbol=NVDA&removed=true`),
    200,
  );
  await check("GET", T, await t.call(`${T}?removed=maybe`), 400);
  await check("GET", T, await t.call(`${T}?portfolio=Nowhere`), 404);
  await refusals("GET", T, T);
  const tone = `${T}/{id}`;
  const back = `${T}/{id}/restore`;
  // a later sale of what the buy brought: the buy cannot go before it
  const sold = await t.call(
    T,
    send("POST", { ...trade, side: "sell", date: "2026-10-02" }),
  );
  const sid0 = (await sold.json()).trade.id;
  await check(
    "DELETE",
    tone,
    await t.call(`${T}/${tid}`, { method: "DELETE" }),
    409,
  );
  await t.call(`${T}/${sid0}`, { method: "DELETE" });
  await check(
    "DELETE",
    tone,
    await t.call(`${T}/${tid}`, { method: "DELETE" }),
    200,
  );
  await check(
    "POST",
    back,
    await t.call(`${T}/${sid0}/restore`, { method: "POST" }),
    409,
  );
  await check(
    "DELETE",
    tone,
    await t.call(`${T}/x`, { method: "DELETE" }),
    400,
  );
  await check(
    "DELETE",
    tone,
    await t.call(`${T}/999`, { method: "DELETE" }),
    404,
  );
  await refusals("DELETE", tone, `${T}/${tid}`);
  await check(
    "POST",
    back,
    await t.call(`${T}/${tid}/restore`, { method: "POST" }),
    200,
  );
  await check(
    "POST",
    back,
    await t.call(`${T}/x/restore`, { method: "POST" }),
    400,
  );
  await check(
    "POST",
    back,
    await t.call(`${T}/999/restore`, { method: "POST" }),
    404,
  );
  await refusals("POST", back, `${T}/${tid}/restore`);

  const H = `${P}/{id}/holdings`;
  await check(
    "GET",
    H,
    await t.call(`${at}/holdings?broker=North&currency=USD`),
    200,
  );
  await check("GET", H, await t.call(`${at}/holdings?currency=usd`), 400);
  await check("GET", H, await t.call(`${P}/999/holdings`), 404);
  await refusals("GET", H, `${at}/holdings`);
  await check("GET", "/holdings", await t.call("/holdings"), 200);
  await check("GET", "/holdings", await t.call("/holdings?x=1"), 400);
  await check(
    "GET",
    "/holdings",
    await t.call("/holdings?broker=Nowhere"),
    404,
  );
  await refusals("GET", "/holdings", "/holdings");

  const E = `${P}/{id}/export`;
  const csv = await t.call(`${at}/export`);
  expect(csv.headers.get("content-type")).toBe("text/csv; charset=utf-8");
  expect(await check("GET", E, csv, 200)).toContain("NVDA,");
  await check("GET", E, await t.call(`${at}/export?x=1`), 400);
  await check("GET", E, await t.call(`${P}/999/export`), 404);
  await refusals("GET", E, `${at}/export`);

  const I = `${P}/{id}/import`;
  const file =
    "Item,Amount (USD),As Of,Note\nKept for buying,500,2026-10-01,\n";
  const imported = await check(
    "POST",
    I,
    await t.call(
      `${at}/import`,
      send("POST", { csv: file, dry_powder: [2], confirm: true }),
    ),
    200,
  );
  expect(imported.counts.saved).toBe(1);
  await check(
    "POST",
    I,
    await t.call(`${at}/import`, send("POST", { csv: "a,b\n1,2" })),
    400,
  );
  await check(
    "POST",
    I,
    await t.call(`${P}/999/import`, send("POST", { csv: file })),
    404,
  );
  await check(
    "POST",
    I,
    await t.call(
      `${at}/import`,
      send("POST", { csv: "x".repeat(MAX_IMPORT_BODY) }),
    ),
    413,
  );
  await check(
    "POST",
    I,
    await t.call(`${at}/import`, send("POST", "x", "text/plain")),
    415,
  );
  await refusals("POST", I, `${at}/import`, send("POST", { csv: file }));

  const S = "/positions";
  const fund = {
    kind: "manual",
    portfolio: pid,
    name: "Made Up Fund",
    units: 3,
    price: 10,
    currency: "USD",
  };
  const added = await check(
    "POST",
    S,
    await t.call(S, send("POST", fund)),
    201,
  );
  const sid = added.position.id;
  await check(
    "POST",
    S,
    await t.call(S, send("POST", { ...fund, kind: "stock" })),
    400,
  );
  await check(
    "POST",
    S,
    await t.call(S, send("POST", { ...fund, broker: "Nowhere" })),
    404,
  );
  await check("POST", S, await t.call(S, send("POST", "x", "text/plain")), 415);
  const slowBond = await t.late(
    "SLOWF.DE",
    S,
    send("POST", {
      kind: "bond",
      portfolio: pid,
      name: "Made Up Bond",
      symbol: "SLOWF.DE",
      amount: 100,
      currency: "EUR",
    }),
  );
  expect((await check("POST", S, slowBond, 503)).code).toBe("timeout");
  await refusals("POST", S, S, send("POST", fund));
  await check(
    "GET",
    S,
    await t.call(`${S}?portfolio=${pid}&removed=true`),
    200,
  );
  await check("GET", S, await t.call(`${S}?removed=1`), 400);
  await check("GET", S, await t.call(`${S}?portfolio=Nowhere`), 404);
  await refusals("GET", S, S);
  const sone = `${S}/{id}`;
  const updated = await check(
    "PATCH",
    sone,
    await t.call(`${S}/${sid}`, send("PATCH", { price: 11 })),
    200,
  );
  const newer = updated.position.id;
  await check(
    "PATCH",
    sone,
    await t.call(`${S}/${sid}`, send("PATCH", { price: 12 })),
    409,
  );
  await check(
    "PATCH",
    sone,
    await t.call(`${S}/${newer}`, send("PATCH", {})),
    400,
  );
  await check(
    "PATCH",
    sone,
    await t.call(`${S}/999`, send("PATCH", { price: 1 })),
    404,
  );
  await check(
    "PATCH",
    sone,
    await t.call(`${S}/${newer}`, send("PATCH", "x", "text/plain")),
    415,
  );
  await refusals("PATCH", sone, `${S}/${newer}`, send("PATCH", { price: 1 }));
  const hist = `${S}/{id}/history`;
  expect(
    (await check("GET", hist, await t.call(`${S}/${newer}/history`), 200))
      .history,
  ).toHaveLength(2);
  await check("GET", hist, await t.call(`${S}/x/history`), 400);
  await check("GET", hist, await t.call(`${S}/999/history`), 404);
  await refusals("GET", hist, `${S}/${newer}/history`);
  await check(
    "DELETE",
    sone,
    await t.call(`${S}/${newer}`, { method: "DELETE" }),
    200,
  );
  await check(
    "DELETE",
    sone,
    await t.call(`${S}/x`, { method: "DELETE" }),
    400,
  );
  await check(
    "DELETE",
    sone,
    await t.call(`${S}/999`, { method: "DELETE" }),
    404,
  );
  await refusals("DELETE", sone, `${S}/${newer}`);
  const sback = `${S}/{id}/restore`;
  await check(
    "POST",
    sback,
    await t.call(`${S}/${sid}/restore`, { method: "POST" }),
    200,
  );
  await check(
    "POST",
    sback,
    await t.call(`${S}/x/restore`, { method: "POST" }),
    400,
  );
  await check(
    "POST",
    sback,
    await t.call(`${S}/999/restore`, { method: "POST" }),
    404,
  );
  await refusals("POST", sback, `${S}/${sid}/restore`);

  const G = "/portfolio-settings";
  await check(
    "PUT",
    G,
    await t.call(G, send("PUT", { display_currency: "USD" })),
    200,
  );
  await check(
    "PUT",
    G,
    await t.call(G, send("PUT", { display_currency: "usd" })),
    400,
  );
  await check("PUT", G, await t.call(G, send("PUT", "x", "text/plain")), 415);
  await refusals("PUT", G, G, send("PUT", { display_currency: null }));
  expect((await check("GET", G, await t.call(G), 200)).display_currency).toBe(
    "USD",
  );
  await check("GET", G, await t.call(`${G}?x=1`), 400);
  await refusals("GET", G, G);

  await check(
    "DELETE",
    bone,
    await t.call(`${B}/${north}`, { method: "DELETE" }),
    409,
  );
  await check(
    "DELETE",
    bone,
    await t.call(`${B}/${south}`, { method: "DELETE" }),
    204,
  );
  await check(
    "DELETE",
    bone,
    await t.call(`${B}/x`, { method: "DELETE" }),
    400,
  );
  await check(
    "DELETE",
    bone,
    await t.call(`${B}/999`, { method: "DELETE" }),
    404,
  );
  await refusals("DELETE", bone, `${B}/${north}`);
  await check("DELETE", one, await t.call(at, { method: "DELETE" }), 409);
  await check(
    "DELETE",
    one,
    await t.call(`${P}/${spare}`, { method: "DELETE" }),
    204,
  );
  await check("DELETE", one, await t.call(`${P}/x`, { method: "DELETE" }), 400);
  await check(
    "DELETE",
    one,
    await t.call(`${P}/999`, { method: "DELETE" }),
    404,
  );
  await refusals("DELETE", one, at);
}
