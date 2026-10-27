// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The day's moves among the symbols a caller passes: past a percent
// from the previous close, against an average, or both. Live prices
// drive it, so a crossing compares the last final close with the live
// quote, and a FRED series, which has no live quote, never moves.

import { ATTRIBUTION } from "../fred/sync.ts";
import { price, round } from "../market/format.ts";
import type { Instrument } from "../market/instruments.ts";
import { readQuote } from "../market/quotes.ts";
import { FRED } from "../sources/ids.ts";
import type { Db } from "../storage/db/index.ts";
import { type ToolResult, textResult } from "./answer.ts";
import { ArgError, fields, oneOf, optionalText, symbols } from "./args.ts";
import type { Markets } from "./markets.ts";
import {
  closeOn,
  type Latest,
  MAX_SYMBOLS,
  quoteItem,
  readLatest,
} from "./quote.ts";
import {
  distinct,
  type Resolved,
  type SetRead,
  setPage,
  startOf,
  type Unavailable,
  unavailable,
} from "./sets.ts";
import { readTargets } from "./targets.ts";

export const AVERAGES = {
  daily_sma50: { interval: "1d", key: "sma50" },
  daily_sma200: { interval: "1d", key: "sma200" },
  daily_ema20: { interval: "1d", key: "ema20" },
  weekly_sma50: { interval: "1wk", key: "sma50" },
  weekly_sma200: { interval: "1wk", key: "sma200" },
} as const;

type Average = keyof typeof AVERAGES;

const AVERAGE_NAMES = Object.keys(AVERAGES) as Average[];
const RELATIONS = ["above", "below", "crossed_up", "crossed_down"] as const;
const DIRECTIONS = ["up", "down", "either"] as const;

export type MoversArgs = {
  symbols: string[];
  min_move_pct: number | null;
  direction: (typeof DIRECTIONS)[number];
  average: Average | null;
  relation: (typeof RELATIONS)[number] | null;
  next: string | null;
};

export function parseMovers(input: unknown): MoversArgs {
  const f = fields(input, [
    "symbols",
    "min_move_pct",
    "direction",
    "average",
    "relation",
    "next",
  ]);
  const list = symbols(f.symbols, "symbols", MAX_SYMBOLS);
  let min: number | null = null;
  if (f.min_move_pct !== undefined && f.min_move_pct !== null) {
    if (
      typeof f.min_move_pct !== "number" ||
      !Number.isFinite(f.min_move_pct) ||
      f.min_move_pct < 0
    ) {
      throw new ArgError("min_move_pct must be a number, 0 or more");
    }
    min = f.min_move_pct;
  }
  const given = (v: unknown) => v !== undefined && v !== null;
  if (min === null && given(f.direction)) {
    throw new ArgError("direction needs min_move_pct");
  }
  const average = given(f.average)
    ? oneOf(f.average, "average", AVERAGE_NAMES, AVERAGE_NAMES[0]!)
    : null;
  const relation = given(f.relation)
    ? oneOf(f.relation, "relation", RELATIONS, "above")
    : null;
  if ((average === null) !== (relation === null)) {
    throw new ArgError("average and relation go together");
  }
  if (min === null && average === null) {
    throw new ArgError(
      "give min_move_pct, an average with a relation, or both",
    );
  }
  return {
    symbols: list,
    min_move_pct: min,
    direction: oneOf(f.direction, "direction", DIRECTIONS, "either"),
    average,
    relation,
    next: optionalText(f.next, "next", 200),
  };
}

const NO_QUOTE = "a FRED series has no live quote, so it never moves";
const NO_LIVE = "no live row: no trade in the current session yet";

type Side = { kind: "live" | "final"; date: string; value: number };

type Relation =
  | { ok: true; holds: boolean; shown: object }
  | { ok: false; reason?: string };

function relate(
  db: Db,
  instrument: Instrument,
  latest: Latest,
  args: MoversArgs,
  // the live quote's price
  last: number,
): Relation {
  const { interval, key } = AVERAGES[args.average!];
  const read = (row: { date: string } | null | undefined) =>
    row == null
      ? null
      : (((row as Record<string, unknown>)[key] as number | null) ?? null);
  const p = interval === "1d" ? latest.daily : latest.weekly;
  if (args.relation === "above" || args.relation === "below") {
    const avg = read(p?.row);
    if (p === null || avg === null) return { ok: false };
    const at: Side = { kind: p.kind, date: p.row.date, value: avg };
    return {
      ok: true,
      holds: args.relation === "above" ? last > avg : last < avg,
      shown: averageOf(args.average!, at, last),
    };
  }
  const rows = latest.signals?.[interval === "1d" ? "daily" : "weekly"];
  const live = rows?.live ?? null;
  const final = rows?.final ?? null;
  if (live === null) return { ok: false, reason: NO_LIVE };
  const avgNow = read(live);
  const avgThen = read(final);
  if (final === null || avgNow === null || avgThen === null) {
    return { ok: false };
  }
  if (final.date >= live.date) return { ok: false };
  const close = closeOn(db, instrument.id, interval, final.date);
  if (close === null) return { ok: false };
  const holds =
    args.relation === "crossed_up"
      ? close <= avgThen && last > avgNow
      : close >= avgThen && last < avgNow;
  return {
    ok: true,
    holds,
    shown: {
      ...averageOf(
        args.average!,
        { kind: "live", date: live.date, value: avgNow },
        last,
      ),
      last_final: {
        date: final.date,
        close: price(close),
        value: round(avgThen),
      },
    },
  };
}

const averageOf = (name: Average, at: Side, last: number) => ({
  name,
  value: round(at.value),
  kind: at.kind,
  date: at.date,
  distance_pct: at.value > 0 ? round(100 * (last / at.value - 1)) : null,
});

function moves(args: MoversArgs, change: number): boolean {
  const min = args.min_move_pct;
  if (min === null) return true;
  switch (args.direction) {
    case "up":
      return change > 0 && change >= min;
    case "down":
      return change < 0 && -change >= min;
    default:
      return Math.abs(change) >= min;
  }
}

// move is null when an average alone was asked and the day has no change
type Matched = { id: string; move: number | null; item: object };

// Matched, unavailable, or null when its inputs were all there and it
// did not move as asked.
function moverOne(
  m: Markets,
  args: MoversArgs,
  r: Resolved,
  now: number,
): Matched | Unavailable | null {
  const moving = args.min_move_pct !== null;
  const inputs = [
    ...(moving ? ["change_percent"] : []),
    ...(args.average === null ? [] : [args.average]),
  ];
  if (r.instrument.source === FRED) {
    return unavailable(r, inputs, [], NO_QUOTE);
  }
  const latest = readLatest(m.db, r.instrument, now, m.quoteEveryMs);
  const q = quoteItem(m.db, r.input, r.instrument, latest);
  if (q.stale.length > 0) return unavailable(r, inputs, q.stale);
  const raw = readQuote(m.db, r.instrument.id);
  const change = raw?.changePercent ?? null;
  const missing: string[] = [];
  if (moving && change === null) missing.push("change_percent");
  // no quote leaves the average nothing to compare with
  const relation: Relation | null =
    args.average === null
      ? null
      : raw === null
        ? { ok: false }
        : relate(m.db, r.instrument, latest, args, raw.price);
  if (relation?.ok === false) missing.push(args.average!);
  if (missing.length > 0) {
    return unavailable(
      r,
      missing,
      [],
      relation?.ok === false ? relation.reason : undefined,
    );
  }
  if (moving && !moves(args, change!)) return null;
  const shown = relation?.ok ? relation : null;
  if (shown !== null && !shown.holds) return null;
  return {
    id: r.instrument.id,
    move: change === null ? null : Math.abs(change),
    item: {
      input: r.input,
      id: r.instrument.id,
      status: "matched",
      name: r.instrument.name,
      unit: r.instrument.unit,
      currency: r.instrument.currency,
      price: q.price,
      previous_close: q.previous_close,
      change: q.change,
      change_percent: q.change_percent,
      trade_time: q.trade_time,
      fetched_at: q.fetched_at,
      ...(shown === null ? {} : { average: shown.shown }),
    },
  };
}

export async function readMovers(
  m: Markets,
  args: MoversArgs,
): Promise<SetRead> {
  const targets = await readTargets(m, args.symbols);
  const now = m.clock.now();
  const { resolved, errors } = distinct(targets);
  const matched: Matched[] = [];
  const out: Unavailable[] = [];
  let notMatched = 0;
  for (const r of resolved) {
    const result = moverOne(m, args, r, now);
    if (result === null) notMatched++;
    else if ("status" in result) out.push(result);
    else matched.push(result);
  }
  // the ones without a change after those with one, each by id on a tie
  matched.sort((a, b) => {
    if (a.move !== b.move) {
      if (a.move === null) return 1;
      if (b.move === null) return -1;
      return b.move - a.move;
    }
    return a.id < b.id ? -1 : 1;
  });
  return {
    matched: matched.map(({ item }) => ({ item, fred: false })),
    notMatched,
    unavailable: out,
    errors,
    head: {
      sort: "absolute change_percent, largest first; those without one last",
    },
    attribution: ATTRIBUTION,
  };
}

export async function moversAnswer(
  m: Markets,
  args: MoversArgs,
): Promise<ToolResult> {
  const { next, ...asked } = args;
  const offset = startOf(next, asked);
  const read = await readMovers(m, args);
  return textResult(setPage({ ...read, args: asked, offset }));
}
