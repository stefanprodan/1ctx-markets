// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Every MCP tool called over the recordings, each answer followed page
// by page, as the bytes a client gets: a fixture of these pins the
// tools' answers through a change that should leave them as they are.

import { PREFIX } from "../../src/api/http.ts";
import { open } from "../../src/db/index.ts";
import { finnhub } from "../../src/finnhub/client.ts";
import { fred } from "../../src/fred/client.ts";
import { silent } from "../../src/runtime/log.ts";
import { call, tools } from "../../src/tools/index.ts";
import { markets } from "../../src/tools/markets.ts";
import { writer } from "../../src/writer.ts";
import { yahoo } from "../../src/yahoo/client.ts";
import { api, READ_KEY } from "./api.ts";
import { fakeClock } from "./clock.ts";
import { drive, pacedOf } from "./drive.ts";
import { FINNHUB_KEY, finnhubAnswer } from "./finnhub.ts";
import { FRED_KEY, NOW, sources } from "./sources.ts";
import { bar, listing, row, world } from "./world.ts";

// the calls, in order, since rules change what later calls read
const CALLS: [string, Record<string, unknown>][] = [
  ["quote", { symbols: ["NVDA", "FRED:DGS10", "^GSPC"] }],
  ["quote", { symbols: ["NVDA"], benchmark: "^GSPC" }],
  ["quote", { symbols: [] }],
  ["quote", { symbols: ["NVDA", "FRED:DGS10"], extended: true }],
  ["history", { symbol: "NVDA", from: "2026-07-01" }],
  ["history", { symbol: "NVDA", interval: "1wk", benchmark: "^GSPC" }],
  ["history", { symbol: "FRED:DGS10", from: "2026-01-01" }],
  ["history", { symbol: "ZZNOTHING" }],
  ["history", { symbol: "NVDA", from: "2026-04-01", to: "2026-09-30" }],
  ["search", { query: "NVDA" }],
  ["search", { query: "FRED:DGS10" }],
  ["movers", { symbols: ["NVDA", "^GSPC", "FRED:DGS10"], min_move_pct: 0 }],
  [
    "movers",
    {
      symbols: ["NVDA", "^GSPC"],
      average: "daily_sma50",
      relation: "above",
    },
  ],
  [
    "screen",
    {
      symbols: ["NVDA", "^GSPC"],
      filters: [{ field: "rsi14", min: 0 }],
      sort: "return_1m",
      order: "desc",
      fields: ["distance_sma200"],
    },
  ],
  ["screen", { symbols: ["NVDA"], sort: "relative_return_1m" }],
  [
    "screen",
    {
      symbols: ["NVDA"],
      sort: "relative_return_1m",
      benchmark: "^GSPC",
    },
  ],
  ["research", { symbol: "NVDA" }],
  ["research", { symbol: "NVDA", section: "analysts" }],
  ["research", { symbol: "NVDA", section: "earnings" }],
  ["research", { symbol: "NVDA", section: "news", since: "2026-10-10" }],
  ["research", { symbol: "NVDA", section: "analysts", since: "2026-10-10" }],
  ["events", { from: "2026-01-01", to: "2026-12-31", symbols: ["NVDA"] }],
  ["events", { from: "2026-01-01", to: "2026-12-31" }],
  [
    "rules",
    {
      action: "create",
      symbol: "NVDA",
      condition: { left: "price", op: "<", right: 211 },
      note: "below 211",
    },
  ],
  [
    "rules",
    {
      action: "create",
      symbol: "NVDA",
      condition: { left: "rsi14", op: ">", right: 30 },
    },
  ],
  ["rules", { action: "list" }],
  ["rules", { action: "pause", id: 1, paused: true }],
  ["rules", { action: "delete", id: 2 }],
  ["rules", { action: "delete", id: 2 }],
  ["rules", { action: "list" }],
];

type Answers = Record<string, string[]>;

async function pages(
  run: (
    input: unknown,
  ) => Promise<{ isError?: true; content: { text: string }[] }>,
  input: Record<string, unknown>,
): Promise<string[]> {
  const out: string[] = [];
  let next: string | null = null;
  do {
    const r = await run(next === null ? input : { ...input, next });
    out.push(JSON.stringify(r));
    next = r.isError ? null : (JSON.parse(r.content[0]!.text).next ?? null);
  } while (next !== null && out.length < 50);
  return out;
}

export async function mcpAnswers(): Promise<Answers> {
  const answers: Answers = {};
  const clock = fakeClock(NOW);
  const { db } = open(":memory:", clock);
  const s = await sources({ hold: (url) => finnhubAnswer(url) });
  const m = markets({
    db,
    clock,
    writer: writer(db),
    yahoo: yahoo({ clock, fetch: s.fetch }),
    fred: fred({ clock, key: FRED_KEY, fetch: s.fetch }),
    finnhub: finnhub({ clock, key: FINNHUB_KEY, fetch: s.fetch }),
    log: silent,
  });
  const list = tools(m);
  for (const [k, [name, input]] of CALLS.entries()) {
    const tool = list.find((t) => t.name === name)!;
    answers[`${k} ${name} ${JSON.stringify(input)}`] = await pages(
      (args) => drive(clock, pacedOf(m), call(m, tool, args)),
      input,
    );
  }
  // a century of quarters, so events pages
  const insert = db.query(
    `insert into events (instrument, fiscal_year, fiscal_quarter, date,
       hour, eps_estimate, eps_actual, reported_seen_at, fetched_at)
     values ('US:NVDA', ?, ?, ?, 'bmo', 1, ?, ?, ?)`,
  );
  for (let k = 0; k < 120; k++) {
    const year = 1980 + Math.floor(k / 4);
    const date = `${year}-${String((k % 4) * 3 + 1).padStart(2, "0")}-15`;
    const reported = k % 2 === 1;
    insert.run(
      year,
      (k % 4) + 1,
      date,
      reported ? 0 : null,
      reported ? NOW : null,
      NOW,
    );
  }
  const events = list.find((t) => t.name === "events")!;
  for (const input of [
    { from: "1979-01-01", to: "2030-01-01" },
    { from: "1979-01-01", to: "2030-01-01", symbols: ["NVDA"] },
  ]) {
    answers[`events ${JSON.stringify(input)}`] = await pages(
      (args) => drive(clock, pacedOf(m), call(m, events, args)),
      input,
    );
  }
  // a hundred listings with long numbers, so quote pages
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
    symbols.push(id);
  }
  const quote = tools(w.m).find((t) => t.name === "quote")!;
  answers["quote 50 listings"] = await pages((args) => call(w.m, quote, args), {
    symbols: symbols.slice(0, 50),
  });
  const movers = tools(w.m).find((t) => t.name === "movers")!;
  answers["movers 100 listings"] = await pages(
    (args) => call(w.m, movers, args),
    { symbols, min_move_pct: 0 },
  );
  db.close();
  w.db.close();
  return answers;
}

// the package's own files are pinned by digest: their bytes are its
const DIGESTED = /\/docs\/swagger-ui(-bundle\.js|\.css)/;

type RestAnswer = {
  status: number;
  headers: Record<string, string>;
  body: string;
};

const post = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

const WRONG = { headers: { authorization: "Bearer wrong" } };

// the requests, in order, since rules and deletes change what later
// requests read
const REQUESTS: [string, RequestInit?][] = [
  ["/quotes?symbols=NVDA,FRED:DGS10,^GSPC"],
  ["/quotes?symbols=NVDA,FRED:DGS10&extended=true"],
  ["/quotes?symbols=ZZNOTHING"],
  ["/quotes?symbols=NVDA&next=x"],
  ["/history?symbol=NVDA&from=2026-07-01"],
  ["/history?symbol=NVDA&interval=1wk&benchmark=^GSPC"],
  ["/history?symbol=NVDA&from=2026-04-01&to=2026-09-30"],
  ["/history?symbol=FRED:DGS10&from=2026-01-01"],
  ["/history?symbol=ZZNOTHING"],
  ["/search?query=NVDA"],
  ["/search?query=FRED:DGS10"],
  ["/research?symbols=NVDA"],
  ["/research?symbols=NVDA,^GSPC&sections=analysts,earnings"],
  ["/research?symbols=NVDA&sections=news&since=2026-10-10"],
  ["/events?from=2026-01-01&to=2026-12-31&symbols=NVDA"],
  ["/events?from=2026-01-01&to=2026-12-31"],
  ["/movers?symbols=NVDA,^GSPC,FRED:DGS10&min_move_pct=0"],
  ["/movers?symbols=NVDA,^GSPC&average=daily_sma50&relation=above"],
  [
    "/screen",
    post("POST", {
      symbols: ["NVDA", "^GSPC"],
      filters: [{ field: "rsi14", min: 0 }],
      sort: "return_1m",
      order: "desc",
      fields: ["distance_sma200"],
    }),
  ],
  ["/screen", post("POST", { symbols: ["NVDA"], sort: "relative_return_1m" })],
  [
    "/screen",
    post("POST", {
      symbols: ["NVDA"],
      sort: "relative_return_1m",
      benchmark: "^GSPC",
    }),
  ],
  ["/screen", { method: "POST", body: "{}" }],
  ["/alerts"],
  ["/rules"],
  [
    "/rules",
    post("POST", {
      symbol: "NVDA",
      condition: { left: "price", op: "<", right: 211 },
      note: "below 211",
    }),
  ],
  [
    "/rules",
    post("POST", {
      symbol: "NVDA",
      condition: { left: "rsi14", op: ">", right: 30 },
    }),
  ],
  ["/rules", post("POST", { symbol: "ZZNOTHING", condition: "x" })],
  ["/rules"],
  ["/rules/1", post("PATCH", { paused: true })],
  ["/rules/x", post("PATCH", { paused: true })],
  ["/rules/2", { method: "DELETE" }],
  ["/rules/2", { method: "DELETE" }],
  ["/rules"],
  ["/alerts"],
  ["/alerts", { headers: { "if-none-match": 'W/"alerts-1"' } }],
  ["/alerts", { headers: { "if-none-match": "x" } }],
  ["/openapi.json"],
  ["/docs"],
  ["/docs/init.js?h=0"],
  ["/docs/swagger-ui.css"],
  ["/docs/swagger-ui-bundle.js"],
  ["/docs/other.js"],
  ["/admin/status"],
  [
    "/admin/refetch",
    post("POST", {
      symbols: ["US:NVDA", "US:ZZNOTHING"],
      fetch: ["bars", "quotes", "research"],
      sections: ["analysts"],
    }),
  ],
  ["/admin/refetch", post("POST", { symbols: [] })],
  ["/admin/instruments/US:NVDA", { method: "DELETE" }],
  ["/admin/instruments/FRED:DGS10", { method: "DELETE" }],
  ["/admin/instruments/FRED:DGS10", { method: "DELETE" }],
  ["/admin/status"],
  ["/nothing"],
  ["/quotes", { method: "POST" }],
  ["/quotes?symbols=NVDA", WRONG],
  ["/admin/status", { headers: { authorization: `Bearer ${READ_KEY}` } }],
];

async function restAnswer(res: Response, path: string): Promise<RestAnswer> {
  const bytes = new Uint8Array(await res.arrayBuffer());
  const body = DIGESTED.test(path)
    ? `sha256:${new Bun.CryptoHasher("sha256").update(bytes).digest("hex")} ${bytes.byteLength}`
    : new TextDecoder().decode(bytes);
  const headers = Object.fromEntries(
    [...res.headers.entries()].sort(([a], [b]) => a.localeCompare(b)),
  );
  return { status: res.status, headers, body };
}

// Every /api/v1 route over the recordings, as status, headers and the
// bytes a client gets: a fixture of these pins the routes' answers.
export async function restAnswers(): Promise<Record<string, RestAnswer>> {
  const answers: Record<string, RestAnswer> = {};
  const clock = fakeClock(NOW);
  const { db } = open(":memory:", clock);
  const s = await sources({ hold: (url) => finnhubAnswer(url) });
  const m = markets({
    db,
    clock,
    writer: writer(db),
    yahoo: yahoo({ clock, fetch: s.fetch }),
    fred: fred({ clock, key: FRED_KEY, fetch: s.fetch }),
    finnhub: finnhub({ clock, key: FINNHUB_KEY, fetch: s.fetch }),
    log: silent,
  });
  const handle = api(m, {
    sources: [
      { name: "yahoo", on: true, why: "always", backoff: () => null },
      { name: "massive", on: false, why: "no key file", backoff: () => null },
    ],
  });
  for (const [k, [path, init]] of REQUESTS.entries()) {
    const req = new Request(`http://markets.test${PREFIX}${path}`, init);
    const res = await drive(clock, pacedOf(m), handle(req));
    answers[`${k} ${req.method} ${path}`] = await restAnswer(res, path);
  }
  db.close();
  return answers;
}
