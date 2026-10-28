// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AdminError, runAdmin } from "../src/admin/cli.ts";
import {
  INSTRUMENT_TABLES,
  jobLabel,
  MAX_FAILING,
  MAX_PAGE,
  MAX_SYMBOLS,
} from "../src/admin/http.ts";
import { refetch } from "../src/admin/refetch.ts";
import { iso } from "../src/market/format.ts";
import { readInstrument, upsertInstrument } from "../src/market/instruments.ts";
import { lastReadAt, markRead } from "../src/market/tracking.ts";
import { CALL_MS, type Markets, markets } from "../src/operations/markets.ts";
import { readTargets } from "../src/operations/targets.ts";
import { DAY_MS } from "../src/runtime/clock.ts";
import { DEFAULT_LISTEN, parseCli } from "../src/runtime/config.ts";
import {
  ADMIN_FILE,
  ADMIN_PREFIX,
  BEARER_FILE,
  createAdmin,
  createBearer,
  KeyError,
  keys,
  requireAdmin,
  requireBearer,
} from "../src/runtime/keys.ts";
import { silent } from "../src/runtime/log.ts";
import { finnhub, SPACING_MS } from "../src/sources/finnhub/client.ts";
import { refreshResearch } from "../src/sources/finnhub/sync.ts";
import {
  queue,
  RATE_LIMIT_BACKOFF_MS,
  SourceError,
} from "../src/sources/source.ts";
import { yahoo } from "../src/sources/yahoo/client.ts";
import { type Db, open } from "../src/storage/db/index.ts";
import { writer } from "../src/storage/writer.ts";
import { api } from "./helpers/api.ts";
import { withApp } from "./helpers/app.ts";
import { fakeClock } from "./helpers/clock.ts";
import { drive, pacedOf } from "./helpers/drive.ts";
import { FINNHUB_KEY, finnhubAnswer } from "./helpers/finnhub.ts";
import { gate, NOW, sources } from "./helpers/sources.ts";
import { instrument, world } from "./helpers/world.ts";
import type { Recorded } from "./helpers/yahoo.ts";

const tempDir = () => mkdtempSync(join(tmpdir(), "markets-admin-"));

const count = (db: Db, sql: string, ...args: string[]) =>
  (db.query(sql).get(...args) as { n: number }).n;

async function setup(
  options: {
    hold?: (url: URL) => Promise<Recorded | undefined> | undefined;
    finnhub?: boolean;
  } = {},
) {
  const clock = fakeClock(NOW);
  const { db } = open(":memory:", clock);
  const s = await sources({
    hold: async (url) =>
      (await options.hold?.(url)) ?? (await finnhubAnswer(url)),
  });
  const fh =
    options.finnhub === false
      ? null
      : finnhub({ clock, key: FINNHUB_KEY, fetch: s.fetch });
  const m = markets({
    db,
    clock,
    writer: writer(db),
    yahoo: yahoo({ clock, fetch: s.fetch }),
    fred: null,
    finnhub: fh,
    log: silent,
  });
  const finnhubCalls = () =>
    s.calls.urls.filter((u) => u.hostname === "finnhub.io");
  return { clock, db, m, calls: s.calls, finnhubCalls };
}

type Setup = Awaited<ReturnType<typeof setup>>;

// stored by a read, as a tool would, with its research fetched once
async function stored(t: Setup) {
  await readTargets(t.m, ["NVDA"]);
  const i = readInstrument(t.db, "US:NVDA")!;
  await drive(
    t.clock,
    pacedOf(t.m),
    refreshResearch({ ...t.m, finnhub: t.m.finnhub }, i, undefined, {
      client: t.m.finnhub!,
    }),
  );
  return i;
}

const share = (db: Db, market: string, symbol: string, exchange: string) =>
  upsertInstrument(
    db,
    {
      market,
      symbol,
      source: "yahoo",
      sourceSymbol: symbol,
      exchange,
      name: symbol,
      type: "EQUITY",
      currency: "USD",
      unit: "per_share",
      zone: "America/New_York",
    },
    NOW,
  );

const admin = (t: Setup) => api(t.m);

const post = (body: unknown, headers: Record<string, string> = {}) =>
  new Request("http://markets.test/api/v1/admin/refetch", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

describe("the admin key", () => {
  test("a first start writes it once, prefixed and private", () => {
    const dir = join(tempDir(), "secrets");
    expect(createBearer(dir)).toBe(true);
    expect(createAdmin(dir)).toBe(true);
    const value = readFileSync(join(dir, ADMIN_FILE), "utf8");
    expect(value.startsWith(ADMIN_PREFIX)).toBe(true);
    expect(value.length).toBeGreaterThan(ADMIN_PREFIX.length + 40);
    expect(statSync(join(dir, ADMIN_FILE)).mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(createAdmin(dir)).toBe(false);
    expect(readFileSync(join(dir, ADMIN_FILE), "utf8")).toBe(value);
    const store = keys(dir);
    expect(requireAdmin(store, requireBearer(store))).toBe(value);
  });

  test("one equal to the bearer, or too short, stops the start without its value", () => {
    const dir = join(tempDir(), "secrets");
    createBearer(dir);
    const bearer = readFileSync(join(dir, BEARER_FILE), "utf8");
    writeFileSync(join(dir, ADMIN_FILE), bearer);
    const store = keys(dir);
    expect(() => requireAdmin(store, bearer)).toThrow(KeyError);
    expect(() => requireAdmin(store, bearer)).toThrow("holds the bearer");
    expect(() => requireAdmin(store, bearer)).not.toThrow(bearer);
    writeFileSync(join(dir, ADMIN_FILE), "short");
    expect(() => requireAdmin(keys(dir), bearer)).toThrow("shorter than");
    expect(() => requireAdmin(keys(dir), bearer)).not.toThrow("short\n");
  });
});

describe("the admin routes' guard", () => {
  const initialize = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "1" },
    },
  });

  test("the bearer is refused on the admin routes and the admin key everywhere else", () =>
    withApp(async ({ url, bearer, admin, lines }) => {
      const as = (key: string) => ({ authorization: `Bearer ${key}` });
      for (const headers of [{}, as(bearer)]) {
        for (const path of [
          "/api/v1/admin/status",
          "/api/v1/admin/nothing",
          "/api/v1/admin",
        ]) {
          const res = await fetch(`${url}${path}`, { headers });
          expect(res.status).toBe(401);
          expect(res.headers.get("www-authenticate")).toBe("Bearer");
        }
      }
      expect(
        (await fetch(`${url}/api/v1/admin/status`, { headers: as(admin) }))
          .status,
      ).toBe(200);
      expect(
        (await fetch(`${url}/api/v1/admin/nothing`, { headers: as(admin) }))
          .status,
      ).toBe(404);
      for (const path of [
        "/api/v1/quotes",
        "/api/v1/research",
        "/api/v1/alerts",
        "/api/v1/anything",
        "/admin/status",
        "/anything",
      ]) {
        const res = await fetch(`${url}${path}`, { headers: as(admin) });
        expect(res.status).toBe(401);
      }
      const mcp = await fetch(`${url}/mcp`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          ...as(admin),
        },
        body: initialize,
      });
      expect(mcp.status).toBe(401);
      expect(lines.some((l) => l.includes("path=/api/v1/admin/status"))).toBe(
        true,
      );
      for (const line of lines) {
        expect(line).not.toContain(admin);
        expect(line).not.toContain(bearer);
      }
    }));

  test("jobs read as words, an unknown one by its id", () => {
    expect(jobLabel("yahoo", "quotes")).toBe("Live prices");
    expect(jobLabel("yahoo", "bars")).toBe("Daily prices");
    expect(jobLabel("fred", "bars")).toBe("Daily series");
    expect(jobLabel("x", "new-thing")).toBe("New thing");
  });

  test("status names the newest failing scopes and counts them all", () =>
    withApp(
      async ({ url, admin, db }) => {
        const insert = db.query(
          `insert into sync_runs (source, job, scope, started_at, ended_at,
             status, rows, error)
           values ('yahoo', 'bars', ?1, ?2, ?2, ?3, 0, ?4)`,
        );
        for (let i = 0; i < 7; i++) {
          insert.run(`US:F${i}`, NOW - i * 60_000, "failed", `error ${i}`);
        }
        insert.run("US:OK", NOW, "ok", null);
        const res = await fetch(`${url}/api/v1/admin/status`, {
          headers: { authorization: `Bearer ${admin}` },
        });
        const [bars] = (await res.json()).jobs;
        expect(bars.scopes).toBe(8);
        expect(bars.failing_scopes).toBe(7);
        expect(bars.failing).toHaveLength(MAX_FAILING);
        expect(bars.failing.map((f: { scope: string }) => f.scope)).toEqual([
          "US:F0",
          "US:F1",
          "US:F2",
          "US:F3",
          "US:F4",
        ]);
      },
      { start: NOW },
    ));

  test("status answers its fields and never a key", () =>
    withApp(
      async ({ url, admin, bearer, db }) => {
        db.query(
          `insert into sync_runs (source, job, scope, started_at, ended_at,
             status, rows, error)
           values ('yahoo', 'quotes', 'US', ?1, ?1, 'ok', 3, null),
             ('yahoo', 'quotes', 'US', ?2, ?2, 'failed', 0, 'rate limited'),
             ('finnhub', 'metric', 'US:A', ?1, ?1, 'failed', 0, 'not found'),
             ('finnhub', 'metric', 'US:B', ?2, ?2, 'ok', 1, null)`,
        ).run(NOW - 60_000, NOW);
        const res = await fetch(`${url}/api/v1/admin/status`, {
          headers: { authorization: `Bearer ${admin}` },
        });
        expect(res.status).toBe(200);
        expect(res.headers.get("cache-control")).toBe("no-store");
        const text = await res.text();
        for (const key of [admin, bearer, FINNHUB_KEY]) {
          expect(text).not.toContain(key);
        }
        const b = JSON.parse(text);
        expect(b.version).toBe("v0.0.0-test");
        expect(b.sources).toEqual(
          [
            ["yahoo", "Yahoo Finance", "on", "always"],
            ["fred", "FRED", "off", "no key"],
            ["finnhub", "Finnhub", "on", "key file"],
            ["massive", "Massive", "off", "no key"],
            ["bvb", "Bucharest Stock Exchange", "off", "no flag"],
          ].map(([name, label, state, why]) => ({
            name,
            label,
            state,
            why,
            backing_off: null,
          })),
        );
        expect(b.jobs).toEqual([
          {
            source: "finnhub",
            job: "metric",
            label: "Key figures",
            last: {
              scope: "US:B",
              started_at: "2026-10-25T21:05:00Z",
              ended_at: "2026-10-25T21:05:00Z",
              status: "ok",
              rows: 1,
              error: null,
            },
            scopes: 2,
            failing_scopes: 1,
            failing: [
              { scope: "US:A", error: "not found", at: "2026-10-25T21:04:00Z" },
            ],
          },
          {
            source: "yahoo",
            job: "quotes",
            label: "Live prices",
            last: {
              scope: "US",
              started_at: "2026-10-25T21:05:00Z",
              ended_at: "2026-10-25T21:05:00Z",
              status: "failed",
              rows: 0,
              error: "rate limited",
            },
            // one scope, whose latest run failed
            scopes: 1,
            failing_scopes: 1,
            failing: [
              {
                scope: "US",
                error: "rate limited",
                at: "2026-10-25T21:05:00Z",
              },
            ],
          },
        ]);
        expect(b.instruments).toBe(0);
        expect(b.tracked).toBe(0);
        expect(b.database_bytes).toBeGreaterThan(0);
        const query = await fetch(`${url}/api/v1/admin/status?x=1`, {
          headers: { authorization: `Bearer ${admin}` },
        });
        expect(query.status).toBe(400);
        const posted = await fetch(`${url}/api/v1/admin/status`, {
          method: "POST",
          headers: { authorization: `Bearer ${admin}` },
        });
        expect(posted.status).toBe(405);
        expect(posted.headers.get("allow")).toBe("GET");
      },
      { finnhubKey: FINNHUB_KEY, start: NOW },
    ));

  test("a queue's back-off is readable until it ends", async () => {
    const clock = fakeClock(NOW);
    const q = queue(clock, 1);
    expect(q.backoff()).toBeNull();
    await q
      .run(async () => {
        throw new SourceError("rate limited");
      })
      .catch(() => {});
    expect(q.backoff()).toEqual({
      until: NOW + RATE_LIMIT_BACKOFF_MS,
      after: "rate limited",
    });
    await clock.advance(RATE_LIMIT_BACKOFF_MS);
    expect(q.backoff()).toBeNull();
  });
});

describe("refetch", () => {
  test("a research section with a good run is fetched again, through the limiter", async () => {
    const times: { path: string; at: number }[] = [];
    let clock: { now(): number } = { now: () => 0 };
    const t = await setup({
      hold: (url) => {
        if (url.hostname === "finnhub.io") {
          times.push({ path: url.pathname, at: clock.now() });
        }
        return undefined;
      },
    });
    clock = t.clock;
    const i = await stored(t);
    const read = lastReadAt(t.db, i.id);
    const runs = () =>
      count(
        t.db,
        "select count(*) as n from sync_runs where source = 'finnhub' and job = ? and status = 'ok'",
        "analysts",
      );
    expect(runs()).toBe(1);
    times.length = 0;
    const results = await drive(
      t.clock,
      pacedOf(t.m),
      refetch(t.m, [i], {
        parts: ["research"],
        sections: ["analysts", "metric"],
      }),
    );
    expect(results).toEqual([
      {
        symbol: "US:NVDA",
        part: "research",
        section: "analysts",
        status: "fetched",
        rows: expect.any(Number),
      },
      {
        symbol: "US:NVDA",
        part: "research",
        section: "metric",
        status: "fetched",
        rows: 1,
      },
    ]);
    expect(times.map((c) => c.path)).toEqual([
      "/api/v1/stock/recommendation",
      "/api/v1/stock/metric",
    ]);
    expect(times[1]!.at - times[0]!.at).toBeGreaterThanOrEqual(SPACING_MS);
    expect(runs()).toBe(2);
    // a refetch is no read
    expect(lastReadAt(t.db, i.id)).toBe(read);
  });

  test("answers every part of a stored share", async () => {
    const t = await setup();
    const i = await stored(t);
    const results = await drive(
      t.clock,
      pacedOf(t.m),
      refetch(t.m, [i], {
        parts: ["bars", "quotes", "research", "calendar", "news"],
        sections: ["insider"],
      }),
    );
    expect(results).toEqual([
      {
        symbol: "US:NVDA",
        part: "bars",
        status: "fetched",
        rows: expect.any(Number),
      },
      {
        symbol: "US:NVDA",
        part: "quotes",
        status: "fetched",
        rows: expect.any(Number),
      },
      {
        symbol: "US:NVDA",
        part: "research",
        section: "insider",
        status: "fetched",
        rows: expect.any(Number),
      },
      {
        symbol: "US:NVDA",
        part: "calendar",
        status: "fetched",
        rows: expect.any(Number),
      },
      { symbol: "US:NVDA", part: "news", status: "source off" },
    ]);
    const bars = t.db
      .query<{ status: string }, []>(
        "select status from sync_runs where source = 'yahoo' and job = 'bars' and scope = 'US:NVDA' order by id",
      )
      .all();
    expect(bars.at(-1)?.status).toBe("ok");
    // the whole history, from the first stored week
    const charts = t.calls.charts("NVDA");
    const from = Number(charts.at(-1)!.searchParams.get("period1")) * 1000;
    expect(from).toBeLessThan(NOW - 4 * 365 * 86_400_000);
  });

  test("a share outside a source's cover is not covered, and a source off says so", async () => {
    const t = await setup({ finnhub: false });
    const x = share(t.db, "XETRA", "VVSM", "GER");
    const results = await refetch(t.m, [x], {
      parts: ["research", "news"],
      sections: ["metric"],
    });
    expect(results).toEqual([
      {
        symbol: "XETRA:VVSM",
        part: "research",
        section: "metric",
        status: "source off",
      },
      { symbol: "XETRA:VVSM", part: "news", status: "source off" },
    ]);
    const on = await setup();
    const y = share(on.db, "XETRA", "VVSM", "GER");
    expect(
      await refetch(on.m, [y], { parts: ["calendar"], sections: [] }),
    ).toEqual([
      { symbol: "XETRA:VVSM", part: "calendar", status: "not covered" },
    ]);
    const fred = upsertInstrument(
      on.db,
      {
        market: "FRED",
        symbol: "DGS10",
        source: "fred",
        sourceSymbol: "DGS10",
        exchange: "FRED",
        name: "DGS10",
        type: "SERIES",
        currency: null,
        unit: "percent",
        zone: "UTC",
      },
      NOW,
    );
    expect(
      await refetch(on.m, [fred], { parts: ["bars", "quotes"], sections: [] }),
    ).toEqual([
      { symbol: "FRED:DGS10", part: "bars", status: "source off" },
      { symbol: "FRED:DGS10", part: "quotes", status: "not covered" },
    ]);
  });

  test("a call past the deadline answers timed out and stores nothing", async () => {
    const held = gate();
    const t = await setup({
      hold: (url) =>
        url.pathname === "/api/v1/stock/metric" ? held.hold() : undefined,
    });
    const i = share(t.db, "US", "NVDA", "NMS");
    const answer = refetch(t.m, [i], {
      parts: ["research"],
      sections: ["metric"],
    });
    await drive(t.clock, pacedOf(t.m), held.arrived);
    await t.clock.advance(CALL_MS);
    expect(await answer).toEqual([
      {
        symbol: "US:NVDA",
        part: "research",
        section: "metric",
        status: "failed",
        error: "timed out",
      },
    ]);
    held.release();
    await drive(t.clock, pacedOf(t.m), Promise.resolve());
    expect(count(t.db, "select count(*) as n from research")).toBe(0);
  });

  test("the route parses strictly and answers an unknown symbol not found", async () => {
    const t = await setup();
    share(t.db, "XETRA", "VVSM", "GER");
    const handle = admin(t);
    const ok = await handle(
      post({ symbols: ["US:NOPE", "xetra:vvsm"], fetch: ["calendar"] }),
    );
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({
      results: [
        { symbol: "US:NOPE", status: "not found" },
        { symbol: "XETRA:VVSM", part: "calendar", status: "not covered" },
      ],
    });
    const refused: [Request, number][] = [
      [post("{"), 400],
      [post([]), 400],
      [post({ symbols: ["US:A"] }), 400],
      [post({ symbols: [], fetch: ["bars"] }), 400],
      [post({ symbols: ["US:A"], fetch: ["bars"], extra: 1 }), 400],
      [post({ symbols: ["US:A"], fetch: ["everything"] }), 400],
      [post({ symbols: ["US:A"], fetch: ["bars"], sections: ["metric"] }), 400],
      [
        post({
          symbols: ["US:A"],
          fetch: ["research"],
          sections: ["calendar"],
        }),
        400,
      ],
      [post({ symbols: ["<script>"], fetch: ["bars"] }), 400],
      [post({ symbols: ["A".repeat(65)], fetch: ["bars"] }), 400],
      [
        post({
          symbols: Array.from(
            { length: MAX_SYMBOLS + 1 },
            (_, k) => `US:S${k}`,
          ),
          fetch: ["bars"],
        }),
        400,
      ],
      [
        post(
          { symbols: ["US:A"], fetch: ["bars"] },
          { "content-type": "text/plain" },
        ),
        415,
      ],
      [post(`{"symbols":["${"A".repeat(20_000)}"]}`), 413],
      [new Request("http://markets.test/api/v1/admin/refetch"), 405],
      [
        new Request("http://markets.test/api/v1/admin/refetch?x=1", {
          method: "POST",
        }),
        400,
      ],
    ];
    for (const [req, status] of refused) {
      const res = await handle(req);
      expect(res.status).toBe(status);
      const text = await res.text();
      expect(text).not.toContain("<script>");
      expect(text).not.toContain("everything");
    }
  });
});

describe("delete", () => {
  // a row in every table keyed to an instrument, and a run in its scope
  function rows(db: Db, id: string) {
    const q = (sql: string) => db.query(sql).run(id, NOW);
    q(`insert into bars (instrument, interval, date, close, final, fetched_at)
       values (?, '1d', '2026-10-23', 1, 1, ?)`);
    q(`insert into splits (instrument, date, numerator, denominator, ratio, applied_at)
       values (?, '2026-10-23', 2, 1, '2:1', ?)`);
    q(`insert into quotes (instrument, price, time, source, fetched_at)
       values (?1, 1, ?2, 'yahoo', ?2)`);
    q(`insert into signals (instrument, interval, date, kind, computed_at)
       values (?, '1d', '2026-10-23', 'final', ?)`);
    q(`insert into research (instrument, kind, period, fetched_at)
       values (?, 'analysts', '2026-10-01', ?)`);
    q(`insert into events (instrument, fiscal_year, fiscal_quarter, date, hour, fetched_at)
       values (?, 2026, 3, '2026-11-17', 'amc', ?)`);
    q(`insert into news (instrument, id, published_at, title, url, fetched_at)
       values (?1, 'a', ?2, 't', 'https://example.com', ?2)`);
    q(`insert into news_walks (instrument, walk, cursor, after)
       values (?, 'history', null, ?)`);
    q(`insert into sync_runs (source, job, scope, started_at, ended_at, status)
       values ('finnhub', 'metric', ?1, ?2, ?2, 'ok')`);
  }

  const tables = [...INSTRUMENT_TABLES, "sync_runs"];
  const of = (db: Db, id: string) =>
    Object.fromEntries(
      tables.map((table) => [
        table,
        count(
          db,
          `select count(*) as n from ${table} where ${table === "sync_runs" ? "scope" : "instrument"} = ?`,
          id,
        ),
      ]),
    );

  const del = (id: string) =>
    new Request(
      `http://markets.test/api/v1/admin/instruments/${encodeURIComponent(id)}`,
      {
        method: "DELETE",
      },
    );

  test("every table keyed to an instrument is one delete clears", async () => {
    const { db } = open(":memory:", fakeClock(NOW));
    const keyed = db
      .query<{ name: string }, []>(
        `select m.name from sqlite_master m, pragma_foreign_key_list(m.name) f
         where m.type = 'table' and f."table" = 'instruments' order by m.name`,
      )
      .all()
      .map((r) => r.name);
    expect(keyed).toEqual([...INSTRUMENT_TABLES, "rules"].sort());
  });

  test("removes every row of the instrument and nothing of another", async () => {
    const t = await setup();
    share(t.db, "US", "AAA", "NMS");
    share(t.db, "US", "BBB", "NMS");
    rows(t.db, "US:AAA");
    rows(t.db, "US:BBB");
    t.db
      .query(
        "insert into alerts (rule_id, fired_at, snapshot) values (7, ?, '{}')",
      )
      .run(NOW);
    const before = of(t.db, "US:BBB");
    const res = await admin(t)(del("us:aaa"));
    expect(res.status).toBe(200);
    const b = (await res.json()) as {
      deleted: string;
      rows: Record<string, number>;
    };
    expect(b.deleted).toBe("US:AAA");
    expect(Object.values(b.rows).every((n) => n === 1)).toBe(true);
    expect(Object.values(of(t.db, "US:AAA")).every((n) => n === 0)).toBe(true);
    expect(readInstrument(t.db, "US:AAA")).toBeNull();
    expect(of(t.db, "US:BBB")).toEqual(before);
    expect(readInstrument(t.db, "US:BBB")).not.toBeNull();
    // alerts stay to retention, so the feed shows no gap
    expect(count(t.db, "select count(*) as n from alerts")).toBe(1);
    expect((await admin(t)(del("US:AAA"))).status).toBe(404);
  });

  test("is refused while a rule reads the instrument, its own or another's", async () => {
    const t = await setup();
    share(t.db, "US", "AAA", "NMS");
    share(t.db, "US", "BBB", "NMS");
    rows(t.db, "US:AAA");
    const reads = (on: string) =>
      t.db
        .query(
          "insert into rules (instrument, condition, created_at) values (?, ?, ?)",
        )
        .run(
          on,
          JSON.stringify({
            left: { field: "price", symbol: "US:AAA" },
            op: ">",
            right: 1,
          }),
          NOW,
        ).lastInsertRowid;
    const rule = Number(reads("US:BBB"));
    const res = await admin(t)(del("US:AAA"));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      error: "conflict",
      rules: [rule],
    });
    expect(readInstrument(t.db, "US:AAA")).not.toBeNull();
    expect(of(t.db, "US:AAA").bars).toBe(1);
    t.db.query("delete from rules").run();
    expect((await admin(t)(del("US:AAA"))).status).toBe(200);
  });

  test("refuses a malformed id and any other method", async () => {
    const t = await setup();
    const handle = admin(t);
    expect((await handle(del("<b>"))).status).toBe(400);
    expect(
      (
        await handle(
          new Request("http://markets.test/api/v1/admin/instruments/%E0%A4%A"),
        )
      ).status,
    ).toBe(405);
    expect(
      (
        await handle(
          new Request("http://markets.test/api/v1/admin/instruments/%E0%A4%A", {
            method: "DELETE",
          }),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await handle(
          new Request("http://markets.test/api/v1/admin/instruments/US:A/x", {
            method: "DELETE",
          }),
        )
      ).status,
    ).toBe(404);
  });
});

describe("the admin command", () => {
  function dataDir(): { dir: string; key: string } {
    const dir = tempDir();
    mkdirSync(join(dir, "secrets"));
    const key = `${ADMIN_PREFIX}made-up-cli-key-0123456789abcdef`;
    writeFileSync(join(dir, "secrets", ADMIN_FILE), key);
    return { dir, key };
  }

  function fake(status = 200, body = '{"ok":true}') {
    const calls: { url: string; init: RequestInit }[] = [];
    return {
      calls,
      fetch: async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        return new Response(body, { status });
      },
    };
  }

  test("reads the key file and calls the server on loopback", async () => {
    const { dir, key } = dataDir();
    const f = fake();
    const out: string[] = [];
    await runAdmin(["--data", dir, "--listen", "0.0.0.0:9999", "status"], {
      fetch: f.fetch,
      write: (line) => out.push(line),
      service: async () => null,
    });
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]!.url).toBe("http://127.0.0.1:9999/api/v1/admin/status");
    const headers = f.calls[0]!.init.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Bearer ${key}`);
    expect(out).toEqual([JSON.stringify({ ok: true }, null, 2)]);
    expect(out.join("\n")).not.toContain(key);
  });

  test("takes the installed service's address and data, else the defaults", async () => {
    const { dir } = dataDir();
    const installed = parseCli(["--listen", "127.0.0.1:12000", "--data", dir]);
    if (installed.kind !== "run") throw new Error("bad config");
    const f = fake();
    await runAdmin(
      ["refetch", "--fetch", "research", "--sections", "metric", "US:NVDA"],
      {
        fetch: f.fetch,
        write: () => {},
        service: async () => installed.config,
      },
    );
    expect(f.calls[0]!.url).toBe("http://127.0.0.1:12000/api/v1/admin/refetch");
    expect(f.calls[0]!.init.method).toBe("POST");
    expect(JSON.parse(f.calls[0]!.init.body as string)).toEqual({
      symbols: ["US:NVDA"],
      fetch: ["research"],
      sections: ["metric"],
    });
    const home = tempDir();
    const g = fake();
    await expect(
      runAdmin(["delete", "US:^GSPC"], {
        home,
        fetch: g.fetch,
        write: () => {},
        service: async () => null,
      }),
    ).rejects.toThrow(join(home, ".1ctx-markets", "secrets", ADMIN_FILE));
    expect(g.calls).toHaveLength(0);
    const h = fake();
    await runAdmin(["--data", dir, "delete", "US:^GSPC"], {
      fetch: h.fetch,
      write: () => {},
      service: async () => null,
    });
    expect(h.calls[0]!.url).toBe(
      `http://${DEFAULT_LISTEN}/api/v1/admin/instruments/US%3A%5EGSPC`,
    );
    expect(h.calls[0]!.init.method).toBe("DELETE");
  });

  test("prints a refusal and fails, never with the key", async () => {
    const { dir, key } = dataDir();
    const out: string[] = [];
    const f = fake(409, '{"error":"conflict"}');
    const run = runAdmin(["--data", dir, "delete", "US:A"], {
      fetch: f.fetch,
      write: (line) => out.push(line),
      service: async () => null,
    });
    await expect(run).rejects.toThrow(AdminError);
    await expect(run).rejects.toThrow("409");
    expect(out.join("\n")).toContain("conflict");
    const down = runAdmin(["--data", dir, "status"], {
      fetch: async () => {
        throw new Error(`refused ${key}`);
      },
      write: (line) => out.push(line),
      service: async () => null,
    });
    await expect(down).rejects.toThrow("no answer from http://");
    await expect(down).rejects.not.toThrow(key);
    for (const argv of [
      [],
      ["status", "x"],
      ["delete"],
      ["refetch"],
      ["nope"],
      ["status", "--fetch", "bars"],
    ]) {
      await expect(
        runAdmin(["--data", dir, ...argv], { service: async () => null }),
      ).rejects.toThrow("usage:");
    }
  });
});

describe("the instrument list", () => {
  const list = async (m: Markets, query = "") => {
    const res = await api(m)(
      new Request(`http://markets.test/api/v1/admin/instruments${query}`),
    );
    return { status: res.status, body: (await res.json()) as any };
  };

  test("pages the stored set by id and counts every match", async () => {
    const w = world();
    for (const id of ["US:CCC", "US:AAA", "XETRA:BBB", "FRED:DGS10"]) {
      instrument(w.db, id, { name: `${id.split(":")[1]} name` });
    }
    const first = await list(w.m, "?limit=2");
    expect(first.status).toBe(200);
    expect(first.body.total).toBe(4);
    expect(first.body.more).toBe(true);
    expect(first.body.instruments.map((i: any) => i.id)).toEqual([
      "FRED:DGS10",
      "US:AAA",
    ]);
    const next = await list(w.m, "?limit=2&after=US:AAA");
    expect(next.body.more).toBe(false);
    expect(next.body.instruments.map((i: any) => i.id)).toEqual([
      "US:CCC",
      "XETRA:BBB",
    ]);
    const found = await list(w.m, "?query=bbb");
    expect(found.body.total).toBe(1);
    expect(found.body.instruments[0]).toMatchObject({
      id: "XETRA:BBB",
      name: "BBB name",
      market: "XETRA",
    });
    const byName = await list(w.m, "?query=AAA%20NAME");
    expect(byName.body.instruments.map((i: any) => i.id)).toEqual(["US:AAA"]);
  });

  test("names what tracks each one: a rule, a read and until when, --track", async () => {
    const w = world();
    const m: Markets = {
      ...w.m,
      tracking: { ...w.m.tracking, flagged: new Set(["US:FLAG"]) },
    };
    for (const id of ["US:RULE", "US:READ", "US:OLD", "US:FLAG", "US:NONE"]) {
      instrument(w.db, id);
    }
    w.db
      .query(
        "insert into rules (instrument, condition, created_at) values (?, ?, ?)",
      )
      .run(
        "US:RULE",
        JSON.stringify({
          left: { field: "price", symbol: "US:RULE" },
          op: ">",
          right: 1,
        }),
        NOW,
      );
    markRead(w.db, ["US:READ"], NOW - DAY_MS);
    markRead(w.db, ["US:OLD"], NOW - 40 * DAY_MS);
    const { body } = await list(m);
    const by = Object.fromEntries(body.instruments.map((i: any) => [i.id, i]));
    expect(by["US:RULE"]).toMatchObject({
      tracked: true,
      tracked_by: ["rule"],
    });
    expect(by["US:READ"]).toMatchObject({
      tracked: true,
      tracked_by: ["read"],
      read_at: iso(NOW - DAY_MS),
      read_until: iso(NOW + 29 * DAY_MS),
    });
    expect(by["US:OLD"]).toMatchObject({
      tracked: false,
      tracked_by: [],
      read_at: iso(NOW - 40 * DAY_MS),
      read_until: null,
    });
    expect(by["US:FLAG"]).toMatchObject({
      tracked: true,
      tracked_by: ["track"],
    });
    expect(by["US:NONE"]).toMatchObject({
      tracked: false,
      read_at: null,
    });
    // a listing is no read
    expect(lastReadAt(w.db, "US:NONE")).toBeNull();
  });

  test("parses strictly", async () => {
    const w = world();
    for (const query of [
      "?limit=0",
      `?limit=${MAX_PAGE + 1}`,
      "?limit=1.5",
      "?after=<b>",
      `?query=${"x".repeat(65)}`,
      "?next=US:A",
      "?limit=1&limit=2",
    ]) {
      const res = await list(w.m, query);
      expect([query, res.status, res.body.error]).toEqual([
        query,
        400,
        "bad_arguments",
      ]);
    }
  });
});
