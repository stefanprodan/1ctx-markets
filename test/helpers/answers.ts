// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Every MCP tool called over the recordings, each answer followed page
// by page, as the bytes a client gets: a fixture of these pins the
// tools' answers through a change that should leave them as they are.

import { open } from "../../src/db/index.ts";
import { finnhub } from "../../src/finnhub/client.ts";
import { fred } from "../../src/fred/client.ts";
import { silent } from "../../src/log.ts";
import { call, tools } from "../../src/tools/index.ts";
import { markets } from "../../src/tools/targets.ts";
import { writer } from "../../src/writer.ts";
import { yahoo } from "../../src/yahoo/client.ts";
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
  ["history", { symbol: "NVDA", from: "2026-07-01" }],
  ["history", { symbol: "NVDA", interval: "1wk", benchmark: "^GSPC" }],
  ["history", { symbol: "FRED:DGS10", from: "2026-01-01" }],
  ["history", { symbol: "ZZNOTHING" }],
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
