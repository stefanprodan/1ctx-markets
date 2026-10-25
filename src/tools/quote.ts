// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The quote reader: one item per symbol with its live quote, or a FRED
// series' last observation, the latest signal rows and why any of it
// may be behind. GET /quotes answers a smaller projection of the same
// items, and movers and screen read the same rows.

import type { Db } from "../db/index.ts";
import { SOURCE as FRED } from "../fred/client.ts";
import { ATTRIBUTION } from "../fred/sync.ts";
import type { Instrument } from "../instruments.ts";
import type { DailyRow } from "../signals/daily.ts";
import { type InstrumentSignals, readSignals } from "../signals/read.ts";
import { DAILY_COLUMNS, WEEKLY_COLUMNS } from "../signals/store.ts";
import type { WeeklyRow } from "../signals/weekly.ts";
import type { StaleReason } from "../stale.ts";
import { readQuote } from "../yahoo/sync.ts";
import { cursor, fitPage, iso, readCursor, round } from "./answer.ts";
import { ArgError, fields, symbols } from "./args.ts";
import { type ItemError, type Markets, readTargets } from "./targets.ts";

export const MAX_SYMBOLS = 100;

// the running values a live row steps from, which say nothing to a caller
const RUNNING = new Set([
  "ema12",
  "ema26",
  "rsiGain",
  "rsiLoss",
  "prevHistogram",
]);

const DAILY = Object.entries(DAILY_COLUMNS).filter(([k]) => !RUNNING.has(k));
const WEEKLY = Object.entries(WEEKLY_COLUMNS);

export type SignalRow = {
  kind: "live" | "final";
  date: string;
} & { [signal: string]: number | string | null };

export function signalRow(
  row: Record<string, unknown> & { date: string },
  kind: "live" | "final",
  interval: "1d" | "1wk",
): SignalRow {
  const out: SignalRow = { kind, date: row.date };
  for (const [key, column] of interval === "1d" ? DAILY : WEEKLY) {
    out[column] = round((row[key] as number | null) ?? null);
  }
  return out;
}

export type Signals = {
  daily: SignalRow | null;
  weekly: SignalRow | null;
  stale: string[];
};

export type Picked<T> = { kind: "live" | "final"; row: T } | null;

// The unrounded rows a quote's signals come from, for readers that
// compute on them: the stored rows, the one picked per interval, and
// why they may be behind.
export type Latest = {
  signals: InstrumentSignals | null;
  daily: Picked<DailyRow>;
  weekly: Picked<WeeklyRow>;
  stale: StaleReason[];
};

const pick = <T>(rows: { live: T | null; final: T | null }): Picked<T> =>
  rows.live !== null
    ? { kind: "live", row: rows.live }
    : rows.final !== null
      ? { kind: "final", row: rows.final }
      : null;

// The live row when one is current, else the last final row; a FRED
// series has final rows only, and no quote to be stale.
export function readLatest(
  db: Db,
  instrument: Instrument,
  now: number,
): Latest {
  const s = readSignals(db, instrument.id, now);
  if (s === null)
    return { signals: null, daily: null, weekly: null, stale: [] };
  return {
    signals: s,
    daily: pick(s.daily),
    weekly: pick(s.weekly),
    stale: instrument.source === FRED ? s.stale.final : s.stale.live,
  };
}

export function latestSignals(
  db: Db,
  instrument: Instrument,
  now: number,
  latest: Latest = readLatest(db, instrument, now),
): Signals {
  const row = (p: Picked<{ date: string }>, interval: "1d" | "1wk") =>
    p === null ? null : signalRow(p.row, p.kind, interval);
  return {
    daily: row(latest.daily, "1d"),
    weekly: row(latest.weekly, "1wk"),
    stale: latest.stale,
  };
}

export type QuoteItem = {
  input: string;
  id: string;
  name: string | null;
  type: string;
  source: string;
  unit: string;
  currency: string | null;
  kind: "market_quote" | "observation";
  price: number | null;
  // a FRED series' last value and its date
  observation?: { date: string; value: number } | null;
  previous_close: number | null;
  change: number | null;
  change_percent: number | null;
  day_high: number | null;
  day_low: number | null;
  volume: number | null;
  trade_time: string | null;
  fetched_at: string | null;
  signals: { daily: SignalRow | null; weekly: SignalRow | null };
  stale: string[];
};

export type ErrorItem = { input: string } & ItemError;

type Observed = { date: string; close: number; fetchedAt: number };

function observations(db: Db, id: string): Observed[] {
  return db
    .query<Observed, [string]>(
      `select date, close, fetched_at as fetchedAt from bars
       where instrument = ? and interval = '1d' order by date desc limit 2`,
    )
    .all(id);
}

export function quoteItem(
  db: Db,
  input: string,
  instrument: Instrument,
  now: number,
  latest?: Latest,
): QuoteItem {
  const signals = latestSignals(db, instrument, now, latest);
  const base = {
    input,
    id: instrument.id,
    name: instrument.name,
    type: instrument.type,
    source: instrument.source,
    unit: instrument.unit,
    currency: instrument.currency,
  };
  if (instrument.source === FRED) {
    const [last, before] = observations(db, instrument.id);
    const change =
      last !== undefined && before !== undefined
        ? last.close - before.close
        : null;
    return {
      ...base,
      kind: "observation",
      price: null,
      observation:
        last === undefined ? null : { date: last.date, value: last.close },
      previous_close: before?.close ?? null,
      change: round(change),
      // a yield or spread moves in points, never in percent of itself
      change_percent:
        change === null || instrument.unit === "percent" || before!.close === 0
          ? null
          : round((change / before!.close) * 100),
      day_high: null,
      day_low: null,
      volume: null,
      trade_time: null,
      fetched_at: iso(last?.fetchedAt ?? null),
      signals: { daily: signals.daily, weekly: signals.weekly },
      stale: signals.stale,
    };
  }
  const q = readQuote(db, instrument.id);
  return {
    ...base,
    kind: "market_quote",
    price: q?.price ?? null,
    previous_close: q?.previousClose ?? null,
    change: round(q?.change ?? null),
    change_percent: round(q?.changePercent ?? null),
    day_high: q?.dayHigh ?? null,
    day_low: q?.dayLow ?? null,
    volume: q?.volume ?? null,
    trade_time: iso(q?.time ?? null),
    fetched_at: iso(q?.fetchedAt ?? null),
    signals: { daily: signals.daily, weekly: signals.weekly },
    stale: signals.stale,
  };
}

const averages = (row: SignalRow | null) =>
  row === null
    ? null
    : { kind: row.kind, date: row.date, sma50: row.sma50, sma200: row.sma200 };

// what a script needs: the price or observation, the times, stale, and
// the daily and weekly SMA 50 and 200
export function briefItem(item: QuoteItem) {
  return {
    input: item.input,
    id: item.id,
    kind: item.kind,
    price: item.price,
    ...(item.kind === "observation" ? { observation: item.observation } : {}),
    previous_close: item.previous_close,
    change: item.change,
    change_percent: item.change_percent,
    unit: item.unit,
    currency: item.currency,
    trade_time: item.trade_time,
    fetched_at: item.fetched_at,
    stale: item.stale,
    sma: {
      daily: averages(item.signals.daily),
      weekly: averages(item.signals.weekly),
    },
  };
}

export type QuoteArgs = { symbols: string[]; next: string | null };

export function parseQuote(input: unknown): QuoteArgs {
  const f = fields(input, ["symbols", "next"]);
  const list = symbols(f.symbols, "symbols", MAX_SYMBOLS);
  if (f.next !== undefined && f.next !== null && typeof f.next !== "string") {
    throw new ArgError("next must be a string from an earlier answer");
  }
  return { symbols: list, next: (f.next as string | undefined) ?? null };
}

function offsetOf(args: QuoteArgs): number {
  if (args.next === null) return 0;
  const at = readCursor(args.next, args.symbols);
  const n = at === null ? Number.NaN : Number(at);
  if (!Number.isSafeInteger(n) || n < 1 || n >= args.symbols.length) {
    throw new ArgError("next does not continue these symbols");
  }
  return n;
}

// One page of items in the order asked, each symbol's error an item of
// its own, and FRED's attribution once when the page holds its values.
export async function quotePage(
  m: Markets,
  args: QuoteArgs,
  project: (item: QuoteItem) => object = (item) => item,
): Promise<string> {
  const offset = offsetOf(args);
  const targets = await readTargets(m, args.symbols.slice(offset));
  const now = m.clock.now();
  const rows = targets.map((t) => {
    if ("error" in t) {
      const item: ErrorItem = { input: t.input, ...t.error };
      return { item, fred: false };
    }
    const q = quoteItem(m.db, t.input, t.instrument, now);
    return { item: project(q), fred: q.observation != null };
  });
  const items = rows.map((r) => r.item);
  return fitPage(items, (count) => {
    const end = offset + count;
    return {
      next:
        end < args.symbols.length ? cursor(String(end), args.symbols) : null,
      ...(rows.slice(0, count).some((r) => r.fred)
        ? { attribution: ATTRIBUTION }
        : {}),
    };
  }).text;
}
