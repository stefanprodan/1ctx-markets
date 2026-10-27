// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The quote reader: one item per symbol with its live quote, or a FRED
// series' last observation, the latest signal rows and why any of it
// may be behind. The API's quotes route answers a smaller projection of
// the same items, and movers and screen read the same rows.

import { CRYPTO, isQuoted, readSession } from "../calendars.ts";
import type { Db } from "../db/index.ts";
import { ATTRIBUTION } from "../fred/sync.ts";
import type { Instrument } from "../instruments.ts";
import { iso, price, round } from "../market/format.ts";
import { readQuote } from "../quotes.ts";
import type { DailyRow } from "../signals/daily.ts";
import {
  benchmarkSide,
  type InstrumentSignals,
  instrumentSide,
  readSignals,
  relativeOf,
  returnsOf,
  type Side,
} from "../signals/read.ts";
import { earliestStart } from "../signals/relative.ts";
import { DAILY_COLUMNS, WEEKLY_COLUMNS } from "../signals/store.ts";
import type { WeeklyRow } from "../signals/weekly.ts";
import { FRED } from "../sources/ids.ts";
import type { StaleReason } from "../stale.ts";
import { cursor, fitPage, readCursor } from "./answer.ts";
import { ArgError, fields, optionalText, symbols } from "./args.ts";
import { readExtended } from "./extended.ts";
import type { ExtendedRead, Markets } from "./markets.ts";
import { benchmarkStale } from "./sets.ts";
import { type ErrorItem, readTargets, type Target } from "./targets.ts";

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
  quoteEveryMs: number,
): Latest {
  const s = readSignals(db, instrument.id, now, quoteEveryMs);
  if (s === null)
    return { signals: null, daily: null, weekly: null, stale: [] };
  return {
    signals: s,
    daily: pick(s.daily),
    weekly: pick(s.weekly),
    stale: instrument.source === FRED ? s.stale.final : s.stale.live,
  };
}

export function latestSignals(latest: Latest): Signals {
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
  latest: Latest,
): QuoteItem {
  const signals = latestSignals(latest);
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

// the close of the bar a final row was computed for
export function closeOn(
  db: Db,
  id: string,
  interval: "1d" | "1wk",
  date: string,
): number | null {
  return (
    db
      .query<{ close: number }, [string, string, string]>(
        "select close from bars where instrument = ? and interval = ? and date = ?",
      )
      .get(id, interval, date)?.close ?? null
  );
}

// the last final close and its averages, the pair movers crosses from
function lastFinal(db: Db, id: string, latest: Latest) {
  const row = latest.signals?.daily.final ?? null;
  const close = row === null ? null : closeOn(db, id, "1d", row.date);
  if (row === null || close === null) return null;
  return {
    daily: {
      date: row.date,
      close: price(close),
      sma50: round(row.sma50),
      sma200: round(row.sma200),
    },
  };
}

const averages = (row: SignalRow | null) =>
  row === null
    ? null
    : { kind: row.kind, date: row.date, sma50: row.sma50, sma200: row.sma200 };

// what a script needs: the price or observation, the times, stale, the
// daily and weekly SMA 50 and 200, and the last final day's to tell a
// crossing since that close
export function briefItem(db: Db, item: QuoteItem, latest: Latest) {
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
    last_final: lastFinal(db, item.id, latest),
  };
}

export type QuoteArgs = {
  symbols: string[];
  benchmark: string | null;
  next: string | null;
  extended: boolean;
};

export function parseQuote(input: unknown): QuoteArgs {
  const f = fields(input, ["symbols", "benchmark", "next", "extended"]);
  const list = symbols(f.symbols, "symbols", MAX_SYMBOLS);
  const benchmark = optionalText(f.benchmark, "benchmark");
  if (f.next !== undefined && f.next !== null && typeof f.next !== "string") {
    throw new ArgError("next must be a string from an earlier answer");
  }
  if (
    f.extended !== undefined &&
    f.extended !== null &&
    typeof f.extended !== "boolean"
  ) {
    throw new ArgError("extended must be true or false");
  }
  return {
    symbols: list,
    benchmark,
    next: (f.next as string | undefined) ?? null,
    extended: f.extended === true,
  };
}

// a page is never continued under another benchmark; without one the
// cursor is the one quote has always made
const continued = (args: QuoteArgs) =>
  args.benchmark === null
    ? args.symbols
    : { symbols: args.symbols, benchmark: args.benchmark };

function offsetOf(args: QuoteArgs): number {
  if (args.next === null) return 0;
  const at = readCursor(args.next, continued(args));
  const n = at === null ? Number.NaN : Number(at);
  if (!Number.isSafeInteger(n) || n < 1 || n >= args.symbols.length) {
    throw new ArgError("next does not continue these symbols");
  }
  return n;
}

// The last regular session the source reported, so it can read closed at
// an opening until a check stores the day's; crypto never closes, and a
// FRED series has no session.
export function sessionOf(m: Markets, i: Instrument, now: number) {
  if (i.source === FRED) return null;
  if (i.market === CRYPTO) return { state: "open", start: null, end: null };
  const s = readSession(m.db, i.market);
  return {
    state: isQuoted(i.market, s, now) ? "open" : "closed",
    start: iso(s?.start ?? null),
    end: iso(s?.end ?? null),
  };
}

type Benchmark =
  | { side: Side; head: object; stale: string[]; fred: boolean }
  | { side: null; head: object; stale: string[]; fred: false };

// as history gives it: its fetch time and its own stale reasons
function benchmarkOf(m: Markets, t: Target, now: number): Benchmark {
  if ("error" in t) {
    return {
      side: null,
      head: { input: t.input, ...t.error },
      stale: [],
      fred: false,
    };
  }
  const b = t.instrument;
  const latest = readLatest(m.db, b, now, m.quoteEveryMs);
  return {
    side: benchmarkSide(m.db, b, 3),
    head: {
      id: b.id,
      name: b.name,
      currency: b.currency,
      unit: b.unit,
      fetched_at: quoteItem(m.db, b.id, b, latest).fetched_at,
      stale: latest.stale,
    },
    stale: benchmarkStale(latest.stale),
    fred: b.source === FRED,
  };
}

// What only the quote tool adds to an item: the quotes route, movers
// and screen share quoteItem and never pay for these reads.
function agentItem(
  m: Markets,
  q: QuoteItem,
  i: Instrument,
  bench: Benchmark | null,
  now: number,
  extended: ExtendedRead | undefined,
) {
  const side = instrumentSide(m.db, i, bench?.side ?? null, earliestStart);
  const r = returnsOf(side);
  const relative = (months: 1 | 3) => {
    if (!bench?.side) return null;
    return round(relativeOf(side, bench.side, months)?.relative ?? null);
  };
  const { stale, ...rest } = q;
  return {
    ...rest,
    returns:
      r === null
        ? null
        : {
            "1w": round(r["1w"]),
            "1m": round(r["1m"]),
            "3m": round(r["3m"]),
            ytd: round(r.ytd),
            to: r.to,
            live: r.live,
          },
    ...(bench === null
      ? {}
      : {
          relative_return_1m: relative(1),
          relative_return_3m: relative(3),
        }),
    session: sessionOf(m, i, now),
    ...(extended === undefined
      ? { stale }
      : {
          extended: extended.extended,
          stale: extended.reason === null ? stale : [...stale, extended.reason],
        }),
  };
}

// Every item asked from the cursor on, in the order asked, each symbol's
// error an item of its own. Without project, the quote tool's items,
// with returns, the session and the benchmark; extended is read for
// either when asked.
export async function quoteRows(
  m: Markets,
  args: QuoteArgs,
  project?: (
    item: QuoteItem,
    latest: Latest,
    extended: ExtendedRead | undefined,
  ) => object,
): Promise<{
  offset: number;
  bench: Benchmark | null;
  rows: { item: object; fred: boolean }[];
}> {
  const offset = offsetOf(args);
  const asked = args.symbols.slice(offset);
  const deadline = m.clock.now() + m.callMs;
  const targets = await readTargets(
    m,
    args.benchmark === null ? asked : [...asked, args.benchmark],
    deadline,
  );
  const extended = args.extended
    ? await readExtended(
        m,
        targets
          .slice(0, asked.length)
          .flatMap((t) => ("instrument" in t ? [t.instrument] : [])),
        deadline,
      )
    : null;
  const now = m.clock.now();
  const bench =
    args.benchmark === null ? null : benchmarkOf(m, targets.at(-1)!, now);
  const rows = targets.slice(0, asked.length).map((t) => {
    if ("error" in t) {
      const item: ErrorItem = { input: t.input, ...t.error };
      return { item, fred: false };
    }
    const latest = readLatest(m.db, t.instrument, now, m.quoteEveryMs);
    const q = quoteItem(m.db, t.input, t.instrument, latest);
    const ext = extended?.get(t.instrument.id);
    const item =
      project === undefined
        ? agentItem(m, q, t.instrument, bench, now, ext)
        : project(q, latest, ext);
    return { item, fred: q.observation != null };
  });
  return { offset, bench, rows };
}

// One page of quoteRows(), and FRED's attribution once when the page
// holds its values.
export async function quotePage(
  m: Markets,
  args: QuoteArgs,
  project?: (item: QuoteItem, latest: Latest) => object,
): Promise<string> {
  const { offset, bench, rows } = await quoteRows(m, args, project);
  const items = rows.map((r) => r.item);
  return fitPage(items, (count) => {
    const end = offset + count;
    return {
      ...(bench === null ? {} : { benchmark: bench.head, stale: bench.stale }),
      next:
        end < args.symbols.length ? cursor(String(end), continued(args)) : null,
      ...(bench?.fred || rows.slice(0, count).some((r) => r.fred)
        ? { attribution: ATTRIBUTION }
        : {}),
    };
  }).text;
}
