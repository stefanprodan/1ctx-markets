// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// One symbol's bars over a range, oldest first, each with that date's
// signal row, and its return against a benchmark the caller names,
// computed on read at the range's end.

import { type Bar, type Interval, readBars } from "../bars.ts";
import { weekOf } from "../calendars.ts";
import type { Db } from "../db/index.ts";
import { SOURCE as FRED } from "../fred/client.ts";
import { ATTRIBUTION } from "../fred/sync.ts";
import type { Instrument } from "../instruments.ts";
import { readRelativeReturn } from "../signals/read.ts";
import { monthsBack } from "../signals/relative.ts";
import { type LiveTarget, liveTarget, selectList } from "../signals/store.ts";
import type { StaleReason } from "../stale.ts";
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
import type { Markets } from "./markets.ts";
import {
  quoteItem,
  readLatest,
  type SignalRow,
  sessionOf,
  signalRow,
} from "./quote.ts";
import { benchmarkStale } from "./sets.ts";
import { type ItemError, readTargets } from "./targets.ts";

export const BASIS =
  "split-adjusted prices; dividends and FX conversion excluded";
export const FRED_BASIS =
  "observations as FRED publishes them; a revision replaces the earlier value";

// the range when from is left out
export const DEFAULT_MONTHS: Record<Interval, number> = { "1d": 3, "1wk": 24 };

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

// The benchmark's own staleness and fetch time go with it: a stale
// benchmark makes the comparison stale, whatever the symbol's state.
function relative(
  m: Markets,
  instrument: Instrument,
  benchmark: Instrument,
  to: string,
) {
  const db = m.db;
  const now = m.clock.now();
  const latest = readLatest(db, benchmark, now, m.quoteEveryMs);
  const read = quoteItem(db, benchmark.id, benchmark, latest);
  let unit: "points" | "percentage points" | null = null;
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
    // a yield or spread changes in points, so their difference is too
    unit = r.instrument.unit === "points" ? "points" : "percentage points";
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
      fetched_at: read.fetched_at,
      stale: latest.stale,
    },
    stale: benchmarkStale(latest.stale),
    at: to,
    unit,
    returns,
  };
}

const widen = (
  v: number | null,
  q: number | null,
  price: number,
  f: (...xs: number[]) => number,
) =>
  v === null && q === null
    ? null
    : f(...[v, q, price].filter((x) => x !== null));

// The session's bar is the quote's, as its live row is: a stored one is
// the last bar pass's, taken near the open, and a feed may store none.
export function withLive(
  bars: readonly Bar[],
  target: LiveTarget | null,
  interval: Interval,
): Bar[] {
  if (target === null) return [...bars];
  const date = interval === "1d" ? target.date : weekOf(target.date);
  const q = target.quote;
  const last = bars.at(-1);
  if (
    last !== undefined &&
    (last.date > date || (last.date === date && last.final))
  ) {
    return [...bars];
  }
  if (last?.date === date) {
    return [
      ...bars.slice(0, -1),
      {
        ...last,
        high: widen(last.high, q.dayHigh, q.price, Math.max),
        low: widen(last.low, q.dayLow, q.price, Math.min),
        close: q.price,
        // a week's volume is its days' sum, which the quote is not
        volume: interval === "1d" ? (q.volume ?? last.volume) : last.volume,
      },
    ];
  }
  return [
    ...bars,
    {
      date,
      open: null,
      high: widen(null, q.dayHigh, q.price, Math.max),
      low: widen(null, q.dayLow, q.price, Math.min),
      close: q.price,
      volume: q.volume,
      final: false,
    },
  ];
}

export type HistoryBar = Bar & { row: SignalRow | null };

export type HistoryRead =
  | { input: string; error: ItemError }
  | {
      instrument: Instrument;
      from: string;
      to: string;
      bars: HistoryBar[];
      session: ReturnType<typeof sessionOf>;
      relative: object | null;
      stale: StaleReason[];
      attribution: boolean;
    };

// The bars from start (from without one) to to, each with that date's
// final row, or its live row on the one bar not final.
export async function readHistory(
  m: Markets,
  args: HistoryArgs,
  start: string | null,
): Promise<HistoryRead> {
  const names =
    args.benchmark === null ? [args.symbol] : [args.symbol, args.benchmark];
  const [target, bench] = await readTargets(m, names);
  if ("error" in target!) return { input: target.input, error: target.error };
  const instrument = target.instrument;
  const db = m.db;
  const all = withLive(
    readBars(db, instrument.id, args.interval),
    liveTarget(db, instrument),
    args.interval,
  );
  const to = args.to ?? all.at(-1)?.date ?? dateOfWall(m.clock.now());
  const from = args.from ?? monthsBack(to, DEFAULT_MONTHS[args.interval]);
  const first = start ?? from;
  const signals = rowsByDate(db, instrument.id, args.interval, first, to);
  const bars = all
    .filter((b) => b.date >= first && b.date <= to)
    .map((b) => {
      const final = signals.final.get(b.date);
      const live =
        !b.final && signals.live?.date === b.date ? signals.live : null;
      const row: SignalRow | null =
        final !== undefined
          ? signalRow(final, "final", args.interval)
          : live !== null
            ? signalRow(live, "live", args.interval)
            : null;
      return { ...b, row };
    });
  let rel: object | null = null;
  if (bench !== undefined) {
    rel =
      "error" in bench
        ? { benchmark: { input: bench.input }, ...bench.error }
        : relative(m, instrument, bench.instrument, to);
  }
  const benchFred =
    bench !== undefined &&
    "instrument" in bench &&
    bench.instrument.source === FRED;
  return {
    instrument,
    from,
    to,
    bars,
    session: sessionOf(m, instrument, m.clock.now()),
    relative: rel,
    stale: readLatest(db, instrument, m.clock.now(), m.quoteEveryMs).stale,
    attribution: instrument.source === FRED || benchFred,
  };
}

export const basisOf = (i: Instrument): string =>
  i.source === FRED ? FRED_BASIS : BASIS;

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
  const read = await readHistory(m, args, start);
  if ("error" in read) return errorResult({ input: read.input, ...read.error });
  const { instrument, from, to } = read;
  const items = read.bars.map((b) => {
    let sig: Omit<SignalRow, "date"> | null = null;
    if (b.row !== null) {
      const { date: _, ...rest } = b.row;
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
      session: read.session,
      basis: basisOf(instrument),
      stale: read.stale,
      ...(read.relative === null ? {} : { relative: read.relative }),
      ...(read.attribution ? { attribution: ATTRIBUTION } : {}),
      next: count < items.length ? cursor(items[count]!.date, asked) : null,
    }),
    "bars",
  );
  return textResult(page.text);
}
