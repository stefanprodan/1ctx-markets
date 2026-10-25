// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// One symbol's bars over a range, oldest first, each with that date's
// signal row, and its return against a benchmark the caller names,
// computed on read at the range's end.

import { type Interval, readBars } from "../bars.ts";
import type { Db } from "../db/index.ts";
import { SOURCE as FRED } from "../fred/client.ts";
import { ATTRIBUTION } from "../fred/sync.ts";
import type { Instrument } from "../instruments.ts";
import { readRelativeReturn } from "../signals/read.ts";
import { monthsBack } from "../signals/relative.ts";
import { selectList } from "../signals/store.ts";
import { dateOfWall } from "../zone.ts";
import {
  cursor,
  errorResult,
  fitPage,
  price,
  readCursor,
  round,
  type ToolResult,
  textResult,
} from "./answer.ts";
import { ArgError, date, fields, oneOf, optionalText, text } from "./args.ts";
import { latestSignals, type SignalRow, signalRow } from "./quote.ts";
import { type Markets, readTargets } from "./targets.ts";

export const BASIS =
  "split-adjusted prices; dividends and FX conversion excluded";
export const FRED_BASIS =
  "observations as FRED publishes them; a revision replaces the earlier value";

// the range when from is left out
const DEFAULT_MONTHS: Record<Interval, number> = { "1d": 3, "1wk": 24 };

export type HistoryArgs = {
  symbol: string;
  interval: Interval;
  from: string | null;
  to: string | null;
  benchmark: string | null;
  next: string | null;
};

export function parseHistory(input: unknown): HistoryArgs {
  const f = fields(input, [
    "symbol",
    "interval",
    "from",
    "to",
    "benchmark",
    "next",
  ]);
  const args = {
    symbol: text(f.symbol, "symbol"),
    interval: oneOf(f.interval, "interval", ["1d", "1wk"] as const, "1d"),
    from: date(f.from, "from"),
    to: date(f.to, "to"),
    benchmark: optionalText(f.benchmark, "benchmark"),
    next: optionalText(f.next, "next", 200),
  };
  if (args.from !== null && args.to !== null && args.from > args.to) {
    throw new ArgError("from is after to");
  }
  return args;
}

type Row = Record<string, unknown> & { date: string };

function rowsByDate(
  db: Db,
  id: string,
  interval: Interval,
  from: string,
  to: string,
): { final: Map<string, Row>; live: Row | null } {
  const rows = db
    .query<Row & { kind: string }, [string, string, string, string]>(
      `select date, kind, ${selectList(interval)} from signals
       where instrument = ? and interval = ? and date >= ? and date <= ?`,
    )
    .all(id, interval, from, to);
  return {
    final: new Map(
      rows.filter((r) => r.kind === "final").map((r) => [r.date, r]),
    ),
    live: rows.find((r) => r.kind === "live") ?? null,
  };
}

function relative(
  db: Db,
  instrument: Instrument,
  benchmark: Instrument,
  to: string,
) {
  const returns = ([1, 3] as const).map((months) => {
    const r = readRelativeReturn(db, instrument.id, benchmark.id, months, to);
    if (r === null) {
      return { months, relative: null, reason: "not enough bars on both" };
    }
    const side = (x: typeof r.instrument) => ({
      change: round(x.change),
      unit: x.unit,
      from: x.from,
      to: x.to,
      currency: x.currency,
    });
    return {
      months,
      relative: round(r.relative),
      instrument: side(r.instrument),
      benchmark: side(r.benchmark),
      live: r.live,
      note: r.note,
    };
  });
  return {
    benchmark: {
      id: benchmark.id,
      name: benchmark.name,
      currency: benchmark.currency,
      unit: benchmark.unit,
    },
    at: to,
    unit: "percentage points",
    returns,
  };
}

export async function historyAnswer(
  m: Markets,
  args: HistoryArgs,
): Promise<ToolResult> {
  const { next, ...asked } = args;
  let start: string | null = null;
  if (next !== null) {
    start = readCursor(next, asked);
    if (start === null)
      throw new ArgError("next does not continue these arguments");
  }
  const names =
    args.benchmark === null ? [args.symbol] : [args.symbol, args.benchmark];
  const [target, bench] = await readTargets(m, names);
  if ("error" in target!) {
    return errorResult({ input: target.input, ...target.error });
  }
  const instrument = target.instrument;
  const db = m.db;
  const all = readBars(db, instrument.id, args.interval);
  const to = args.to ?? all.at(-1)?.date ?? dateOfWall(m.clock.now());
  const from = args.from ?? monthsBack(to, DEFAULT_MONTHS[args.interval]);
  const first = start ?? from;
  const bars = all.filter((b) => b.date >= first && b.date <= to);
  const signals = rowsByDate(db, instrument.id, args.interval, first, to);
  const items = bars.map((b) => {
    const final = signals.final.get(b.date);
    const live =
      !b.final && signals.live?.date === b.date ? signals.live : null;
    const row: SignalRow | null =
      final !== undefined
        ? signalRow(final, "final", args.interval)
        : live !== null
          ? signalRow(live, "live", args.interval)
          : null;
    let sig: Omit<SignalRow, "date"> | null = null;
    if (row !== null) {
      const { date: _, ...rest } = row;
      sig = rest;
    }
    return {
      date: b.date,
      open: price(b.open),
      high: price(b.high),
      low: price(b.low),
      close: price(b.close),
      volume: b.volume,
      final: b.final,
      signals: sig,
    };
  });
  const isFred = instrument.source === FRED;
  let rel: object | null = null;
  if (bench !== undefined) {
    rel =
      "error" in bench
        ? { benchmark: { input: bench.input }, ...bench.error }
        : relative(db, instrument, bench.instrument, to);
  }
  const stale = latestSignals(db, instrument, m.clock.now()).stale;
  const benchFred =
    bench !== undefined &&
    "instrument" in bench &&
    bench.instrument.source === FRED;
  const page = fitPage(
    items,
    (count) => ({
      id: instrument.id,
      name: instrument.name,
      source: instrument.source,
      unit: instrument.unit,
      currency: instrument.currency,
      interval: args.interval,
      from,
      to,
      basis: isFred ? FRED_BASIS : BASIS,
      stale,
      ...(rel === null ? {} : { relative: rel }),
      ...(isFred || benchFred ? { attribution: ATTRIBUTION } : {}),
      next: count < items.length ? cursor(items[count]!.date, asked) : null,
    }),
    "bars",
  );
  return textResult(page.text);
}
