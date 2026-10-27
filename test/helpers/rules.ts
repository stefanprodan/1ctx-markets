// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Reads with rules over the recorded sources: NVDA, ^GSPC and any chart
// a test adds, Finnhub when asked for, and quotes a test makes from the
// recorded metas, stored through the same write the quote job uses.

import { finnhub } from "../../src/finnhub/client.ts";
import { fred } from "../../src/fred/client.ts";
import { type Engine, ruleEngine } from "../../src/rules/evaluate.ts";
import { MINUTE_MS } from "../../src/runtime/clock.ts";
import { silent } from "../../src/runtime/log.ts";
import { type Db, open } from "../../src/storage/db/index.ts";
import { type Writer, writer } from "../../src/storage/writer.ts";
import { call, tools } from "../../src/tools/index.ts";
import { type Markets, markets } from "../../src/tools/markets.ts";
import { parseSpark, type Yahoo, yahoo } from "../../src/yahoo/client.ts";
import { storeQuotes } from "../../src/yahoo/sync.ts";
import { type FakeClock, fakeClock } from "./clock.ts";
import { drive, pacedOf } from "./drive.ts";
import { FINNHUB_KEY, finnhubAnswer } from "./finnhub.ts";
import { FRED_KEY, NOW, sources } from "./sources.ts";
import { chartSymbol, clone, type Recorded, recorded } from "./yahoo.ts";

export const EVERY_MS = 5 * MINUTE_MS;

export type QuoteEdit = {
  price?: number;
  // UTC ms; by default a second after the stored quote
  time?: number;
  previousClose?: number;
  dayHigh?: number;
  dayLow?: number;
  // the session moved on by this many days
  sessionDays?: number;
};

export type RulesTest = {
  clock: FakeClock;
  db: Db;
  write: Writer;
  engine: Engine;
  m: Markets;
  client: Yahoo;
  // a refetch's context, as the bar job has it
  ctx: {
    db: Db;
    clock: FakeClock;
    yahoo: Yahoo;
    writer: Writer;
    rules: Engine;
  };
  // answers a Yahoo chart of symbol with this instead, while set
  charts: Map<string, () => Recorded>;
  // edits Finnhub's calendar answer, while set
  calendar: { edit: ((fx: Recorded) => Recorded) | null };
  // the rules tool's answer, parsed, with whether it was an error
  rules(input: unknown): Promise<{ error: boolean; body: any }>;
  // a quote made from the recorded meta, stored as the quote job does
  quote(symbol: string, edit?: QuoteEdit): Promise<void>;
  calls: URL[];
};

export async function rulesTest(
  options: {
    finnhub?: boolean;
    fred?: boolean;
    charts?: Record<string, Recorded>;
    db?: Db;
  } = {},
): Promise<RulesTest> {
  const clock = fakeClock(NOW);
  const db = options.db ?? open(":memory:", clock).db;
  const charts = new Map<string, () => Recorded>();
  const calendar: RulesTest["calendar"] = { edit: null };
  const s = await sources({
    charts: options.charts,
    hold: async (url) => {
      const symbol = chartSymbol(url);
      const override = symbol === null ? undefined : charts.get(symbol);
      if (override !== undefined) return override();
      const fh = await finnhubAnswer(url);
      if (
        fh !== undefined &&
        calendar.edit !== null &&
        url.pathname === "/api/v1/calendar/earnings"
      ) {
        return calendar.edit(fh);
      }
      return fh;
    },
  });
  const write = writer(db);
  const engine = ruleEngine({ quoteEveryMs: EVERY_MS });
  const client = yahoo({ clock, fetch: s.fetch });
  const m = markets({
    db,
    clock,
    writer: write,
    yahoo: client,
    fred: options.fred ? fred({ clock, key: FRED_KEY, fetch: s.fetch }) : null,
    finnhub: options.finnhub
      ? finnhub({ clock, key: FINNHUB_KEY, fetch: s.fetch })
      : null,
    hooks: engine.finnhub,
    rules: engine,
    log: silent,
    quoteEveryMs: EVERY_MS,
  });
  const batch = await recorded("spark-v7-batch");
  const metas = new Map<string, any>(
    batch.body.spark.result.map((r: any) => [r.symbol, r.response[0].meta]),
  );
  for (const [symbol, fx] of Object.entries(options.charts ?? {})) {
    metas.set(symbol, fx.body.chart.result[0].meta);
  }
  const tool = tools(m).find((t) => t.name === "rules")!;
  return {
    clock,
    db,
    write,
    engine,
    m,
    client,
    ctx: { db, clock, yahoo: client, writer: write, rules: engine },
    charts,
    calendar,
    calls: s.calls.urls,
    async rules(input) {
      const result = await drive(clock, pacedOf(m), call(m, tool, input));
      return {
        error: result.isError === true,
        body: JSON.parse(result.content[0]!.text),
      };
    },
    async quote(symbol, edit = {}) {
      const meta = clone(metas.get(symbol));
      if (meta === undefined) throw new Error(`no meta for ${symbol}`);
      const shift = (edit.sessionDays ?? 0) * 86_400;
      for (const period of Object.values(meta.currentTradingPeriod ?? {})) {
        const p = period as { start: number; end: number };
        p.start += shift;
        p.end += shift;
      }
      const stored = db
        .query<{ time: number }, [string]>(
          `select q.time from quotes q join instruments i
             on i.id = q.instrument where i.source_symbol = ?`,
        )
        .get(symbol);
      const time =
        edit.time ??
        (stored === null ? meta.regularMarketTime * 1000 : stored.time + 1000);
      meta.regularMarketTime = Math.floor(time / 1000);
      if (edit.price !== undefined) meta.regularMarketPrice = edit.price;
      if (edit.previousClose !== undefined) {
        meta.previousClose = edit.previousClose;
        meta.chartPreviousClose = edit.previousClose;
      }
      if (edit.dayHigh !== undefined) meta.regularMarketDayHigh = edit.dayHigh;
      if (edit.dayLow !== undefined) meta.regularMarketDayLow = edit.dayLow;
      const body = {
        spark: { result: [{ symbol, response: [{ meta }] }], error: null },
      };
      await write.write((db) =>
        storeQuotes(db, parseSpark(body, clock.now()), engine, clock.now()),
      );
    },
  };
}
