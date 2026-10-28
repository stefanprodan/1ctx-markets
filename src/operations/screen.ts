// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Fixed fields only: one is checked once, an agent's formula never is.

import { round } from "../market/format.ts";
import type { Instrument } from "../market/instruments.ts";
import type { StaleReason } from "../market/stale.ts";
import type { DailyRow } from "../signals/daily.ts";
import {
  benchmarkSide,
  instrumentSide,
  relativeOf,
  returnsOf,
  type Side,
} from "../signals/read.ts";
import { earliestStart, type ReturnPeriod } from "../signals/relative.ts";
import type { WeeklyRow } from "../signals/weekly.ts";
import { ATTRIBUTION } from "../sources/fred/sync.ts";
import { FRED } from "../sources/ids.ts";
import {
  errorResult,
  type Failure,
  type ToolResult,
  textResult,
} from "./answer.ts";
import {
  ArgError,
  fields,
  oneOf,
  optionalText,
  quoted,
  symbols,
} from "./args.ts";
import type { Markets } from "./markets.ts";
import { type Latest, MAX_SYMBOLS, quoteItem, readLatest } from "./quote.ts";
import {
  benchmarkStale,
  distinct,
  type Resolved,
  type SetRead,
  setPage,
  startOf,
  type Unavailable,
  unavailable,
} from "./sets.ts";
import { readTargets } from "./targets.ts";

export const MAX_FILTERS = 8;
export const MAX_FIELDS = 8;

type DailyKey = Exclude<keyof DailyRow, "date">;
type WeeklyKey = Exclude<keyof WeeklyRow, "date">;

type Source =
  | { from: "daily"; key: DailyKey }
  | { from: "weekly"; key: WeeklyKey }
  | { from: "distance"; interval: "daily" | "weekly"; key: DailyKey }
  | { from: "relative"; months: 1 | 3 }
  | { from: "return"; period: ReturnPeriod };

type Field = {
  source: Source;
  // -1, 0 or 1, filtered with eq
  state?: true;
  // in the listing's own unit and currency
  absolute?: true;
  unit?: string;
};

const PRICE: Partial<Field> = { absolute: true };
const STATE: Partial<Field> = { state: true, unit: "state" };
const daily = (key: DailyKey, extra: Partial<Field>): Field => ({
  source: { from: "daily", key },
  ...extra,
});
const weekly = (key: WeeklyKey, extra: Partial<Field>): Field => ({
  source: { from: "weekly", key },
  ...extra,
});
const distance = (interval: "daily" | "weekly", key: DailyKey): Field => ({
  source: { from: "distance", interval, key },
  unit: "percent",
});

export const FIELDS: Readonly<Record<string, Field>> = {
  sma50: daily("sma50", PRICE),
  sma200: daily("sma200", PRICE),
  cross: daily("cross", STATE),
  cross_edge: daily("crossEdge", STATE),
  ema20: daily("ema20", PRICE),
  rsi14: daily("rsi14", { unit: "0 to 100" }),
  macd: daily("macd", PRICE),
  macd_signal: daily("macdSignal", PRICE),
  macd_histogram: daily("macdHistogram", PRICE),
  macd_turn: daily("macdTurn", STATE),
  atr14: daily("atr14", PRICE),
  move_atr: daily("moveAtr", { unit: "ATRs" }),
  volatility20: daily("volatility20", { unit: "percent per day" }),
  bollinger_lower: daily("bollingerLower", PRICE),
  high52w: daily("high52w", PRICE),
  low52w: daily("low52w", PRICE),
  drawdown: daily("drawdown", { unit: "percent" }),
  from_low: daily("fromLow", { unit: "percent" }),
  days_since_high: daily("daysSinceHigh", { unit: "trading days" }),
  volume_ratio: daily("volumeRatio", { unit: "ratio" }),
  weekly_sma50: weekly("sma50", PRICE),
  weekly_sma200: weekly("sma200", PRICE),
  weekly_cross: weekly("cross", STATE),
  weekly_cross_edge: weekly("crossEdge", STATE),
  distance_sma50: distance("daily", "sma50"),
  distance_sma200: distance("daily", "sma200"),
  distance_ema20: distance("daily", "ema20"),
  distance_weekly_sma50: distance("weekly", "sma50"),
  distance_weekly_sma200: distance("weekly", "sma200"),
  distance_bollinger_lower: distance("daily", "bollingerLower"),
  return_1w: { source: { from: "return", period: "1w" } },
  return_1m: { source: { from: "return", period: "1m" } },
  return_3m: { source: { from: "return", period: "3m" } },
  return_ytd: { source: { from: "return", period: "ytd" } },
  relative_return_1m: { source: { from: "relative", months: 1 } },
  relative_return_3m: { source: { from: "relative", months: 3 } },
};

export const FIELD_NAMES = Object.keys(FIELDS);

const isRelative = (name: string) => FIELDS[name]!.source.from === "relative";

export type Filter =
  | { field: string; min: number | null; max: number | null }
  | { field: string; eq: -1 | 0 | 1 };

export type ScreenArgs = {
  symbols: string[];
  filters: Filter[];
  benchmark: string | null;
  sort: string | null;
  order: "asc" | "desc";
  // shown beside the filter and sort fields, never filtered on
  fields: string[];
  next: string | null;
};

function field(value: unknown, name: string): string {
  if (typeof value !== "string" || !Object.hasOwn(FIELDS, value)) {
    throw new ArgError(`${name} must be one of the screen fields`);
  }
  return value;
}

function bound(value: unknown, name: string): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ArgError(`${name} must be a number`);
  }
  return value;
}

function parseFilter(input: unknown, k: number): Filter {
  const name = `filters[${k}]`;
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new ArgError(`${name} must be an object`);
  }
  const f = input as Record<string, unknown>;
  const at = field(f.field, `${name}.field`);
  if (FIELDS[at]!.state) {
    for (const key of Object.keys(f)) {
      if (key !== "field" && key !== "eq") {
        throw new ArgError(`${name}: ${at} is a state, filtered with eq only`);
      }
    }
    if (f.eq !== -1 && f.eq !== 0 && f.eq !== 1) {
      throw new ArgError(`${name}.eq must be -1, 0 or 1`);
    }
    return { field: at, eq: f.eq };
  }
  for (const key of Object.keys(f)) {
    if (key !== "field" && key !== "min" && key !== "max") {
      throw new ArgError(
        `${name}: unknown key ${quoted(key)}; use min and max`,
      );
    }
  }
  const min = bound(f.min, `${name}.min`);
  const max = bound(f.max, `${name}.max`);
  if (min === null && max === null) {
    throw new ArgError(`${name} needs min, max or both`);
  }
  if (min !== null && max !== null && min > max) {
    throw new ArgError(`${name}.min is above its max`);
  }
  return { field: at, min, max };
}

export function parseScreen(input: unknown): ScreenArgs {
  const f = fields(input, [
    "symbols",
    "filters",
    "benchmark",
    "sort",
    "order",
    "fields",
    "next",
  ]);
  const list = symbols(f.symbols, "symbols", MAX_SYMBOLS);
  const raw = f.filters ?? [];
  if (!Array.isArray(raw) || raw.length > MAX_FILTERS) {
    throw new ArgError(`filters must be a list of at most ${MAX_FILTERS}`);
  }
  const filters = raw.map(parseFilter);
  const sort =
    f.sort === undefined || f.sort === null ? null : field(f.sort, "sort");
  if (filters.length === 0 && sort === null) {
    throw new ArgError("give filters, a sort or both");
  }
  if (sort === null && f.order !== undefined && f.order !== null) {
    throw new ArgError("order needs sort");
  }
  const order = oneOf(f.order, "order", ["asc", "desc"] as const, "asc");
  const benchmark = optionalText(f.benchmark, "benchmark");
  const rawFields = f.fields ?? [];
  if (!Array.isArray(rawFields) || rawFields.length > MAX_FIELDS) {
    throw new ArgError(`fields must be a list of at most ${MAX_FIELDS}`);
  }
  const shown = [...new Set(rawFields.map((x, k) => field(x, `fields[${k}]`)))];
  const used = [
    ...filters.map((x) => x.field),
    ...(sort ? [sort] : []),
    ...shown,
  ];
  const relative = used.some(isRelative);
  if (relative && benchmark === null) {
    throw new ArgError("relative_return fields need a benchmark");
  }
  if (!relative && benchmark !== null) {
    throw new ArgError("benchmark is read only by relative_return fields");
  }
  return {
    symbols: list,
    filters,
    benchmark,
    sort,
    order,
    fields: shown,
    next: optionalText(f.next, "next", 200),
  };
}

type Value = {
  value: number;
  unit: string;
  kind: "live" | "final";
  date: string;
  note?: string;
};

type Read =
  | { ok: true; value: Value }
  | { ok: false; reason?: string; benchmark?: true };

const NO_PRICE = "a FRED series has no price to measure a distance from";

const ownUnit = (i: Instrument): string =>
  i.currency === null ? i.unit : `${i.unit} ${i.currency}`;

const unitOf = (def: Field, i: Instrument): string => def.unit ?? ownUnit(i);

type Context = {
  m: Markets;
  benchmark: { side: Side; stale: StaleReason[] } | null;
};

// read once per symbol
type Reads = { side: () => Side; returns: () => ReturnType<typeof returnsOf> };

function reads(ctx: Context, instrument: Instrument): Reads {
  let side: Side | undefined;
  let returns: ReturnType<typeof returnsOf> | undefined;
  const sideOf = () => {
    side ??= instrumentSide(
      ctx.m.db,
      instrument,
      ctx.benchmark?.side ?? null,
      earliestStart,
    );
    return side;
  };
  return {
    side: sideOf,
    returns: () => {
      if (returns === undefined) returns = returnsOf(sideOf());
      return returns;
    },
  };
}

function readField(
  ctx: Context,
  name: string,
  instrument: Instrument,
  latest: Latest,
  price: number | null,
  r: Reads,
): Read {
  const def = FIELDS[name]!;
  const s = def.source;
  const missing: Read = { ok: false };
  if (s.from === "daily" || s.from === "weekly") {
    const p = s.from === "daily" ? latest.daily : latest.weekly;
    const v = p?.row[s.key as keyof typeof p.row] as number | null | undefined;
    if (p === null || v === null || v === undefined) return missing;
    return {
      ok: true,
      value: {
        value: v,
        unit: unitOf(def, instrument),
        kind: p.kind,
        date: p.row.date,
      },
    };
  }
  if (s.from === "distance") {
    if (instrument.source === FRED) return { ok: false, reason: NO_PRICE };
    const p = s.interval === "daily" ? latest.daily : latest.weekly;
    const avg = p?.row[s.key as keyof typeof p.row] as
      | number
      | null
      | undefined;
    // a percent of a level at or below zero says nothing
    if (p === null || price === null || avg == null || avg <= 0) {
      return missing;
    }
    return {
      ok: true,
      value: {
        value: 100 * (price / avg - 1),
        unit: "percent",
        kind: p.kind,
        date: p.row.date,
      },
    };
  }
  if (s.from === "return") {
    const ret = r.returns();
    const v = ret?.[s.period] ?? null;
    if (ret === null || v === null) return missing;
    return {
      ok: true,
      value: {
        value: v,
        // a yield or spread moves in points, as quote's returns
        unit: instrument.unit === "percent" ? "points" : "percent",
        kind: ret.live ? "live" : "final",
        date: ret.to,
      },
    };
  }
  const bench = ctx.benchmark!;
  if (bench.stale.length > 0) return { ok: false, benchmark: true };
  const rel = relativeOf(r.side(), bench.side, s.months);
  if (rel === null) return missing;
  return {
    ok: true,
    value: {
      value: rel.relative,
      unit: rel.instrument.unit === "points" ? "points" : "percentage points",
      kind: rel.live ? "live" : "final",
      date: rel.instrument.to,
      note: rel.note,
    },
  };
}

function passes(f: Filter, v: number): boolean {
  if ("eq" in f) return v === f.eq;
  return (f.min === null || v >= f.min) && (f.max === null || v <= f.max);
}

type Matched = {
  id: string;
  key: number | null;
  item: object;
  fred: boolean;
};

export async function screenAnswer(
  m: Markets,
  args: ScreenArgs,
): Promise<ToolResult> {
  const { next, fields: shown, ...rest } = args;
  // a cursor made before fields existed still continues
  const asked = shown.length === 0 ? rest : { ...rest, fields: shown };
  const offset = startOf(next, asked);
  const read = await readScreen(m, args);
  if ("error" in read) return errorResult(read);
  return textResult(setPage({ ...read, args: asked, offset }));
}

export async function readScreen(
  m: Markets,
  args: ScreenArgs,
): Promise<SetRead | Failure> {
  const names =
    args.benchmark === null ? args.symbols : [...args.symbols, args.benchmark];
  const targets = await readTargets(m, names);
  const now = m.clock.now();
  const ctx: Context = { m, benchmark: null };
  if (args.benchmark !== null) {
    const b = targets.at(-1)!;
    if ("error" in b) return { benchmark: b.input, ...b.error };
    ctx.benchmark = {
      side: benchmarkSide(m.db, b.instrument, 3),
      stale: readLatest(m.db, b.instrument, now, m.quoteEveryMs).stale,
    };
  }
  const { resolved, errors } = distinct(targets.slice(0, args.symbols.length));
  const used = [
    ...new Set([
      ...args.filters.map((f) => f.field),
      ...(args.sort === null ? [] : [args.sort]),
    ]),
  ];
  const absolute = used.filter((name) => FIELDS[name]!.absolute);
  if (absolute.length > 0) {
    const groups = new Map<string, string[]>();
    for (const r of resolved) {
      const key = ownUnit(r.instrument);
      groups.set(key, [...(groups.get(key) ?? []), r.instrument.id]);
    }
    if (groups.size > 1) {
      return {
        error: "mixed_units",
        message: `${absolute.join(", ")} ${absolute.length > 1 ? "are" : "is"} in each listing's own unit and currency, and these symbols mix them; screen each group apart, or use a percent field such as distance_sma50`,
        groups: Object.fromEntries(groups),
      };
    }
  }
  const matched: Matched[] = [];
  const out: Unavailable[] = [];
  let notMatched = 0;
  for (const r of resolved) {
    const result = screenOne(ctx, args, used, r, now);
    if (result === null) notMatched++;
    else if ("status" in result) out.push(result);
    else matched.push(result);
  }
  const sign = args.order === "desc" ? -1 : 1;
  matched.sort((a, b) => {
    if (a.key !== null && b.key !== null && a.key !== b.key) {
      return sign * (a.key < b.key ? -1 : 1);
    }
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  const bench = ctx.benchmark?.side.instrument;
  const head: Record<string, unknown> = {
    ...(bench === undefined
      ? {}
      : {
          benchmark: {
            id: bench.id,
            name: bench.name,
            unit: bench.unit,
            currency: bench.currency,
            stale: ctx.benchmark!.stale,
          },
        }),
    sort:
      args.sort === null
        ? { field: "id", order: "asc" }
        : { field: args.sort, order: args.order },
    ...(bench?.source === FRED ? { attribution: ATTRIBUTION } : {}),
  };
  return {
    matched: matched.map(({ item, fred }) => ({ item, fred })),
    notMatched,
    unavailable: out,
    errors,
    head,
    attribution: ATTRIBUTION,
  };
}

// null when an input it had failed a filter
function screenOne(
  ctx: Context,
  args: ScreenArgs,
  used: readonly string[],
  r: Resolved,
  now: number,
): Matched | Unavailable | null {
  const { m } = ctx;
  const latest = readLatest(m.db, r.instrument, now, m.quoteEveryMs);
  const q = quoteItem(m.db, r.input, r.instrument, latest);
  if (q.stale.length > 0) return unavailable(r, used, q.stale);
  const values = new Map<string, Value>();
  const missing: string[] = [];
  const stale: string[] = [];
  let reason: string | undefined;
  const once = reads(ctx, r.instrument);
  for (const name of used) {
    const read = readField(ctx, name, r.instrument, latest, q.price, once);
    if (read.ok) {
      values.set(name, read.value);
      continue;
    }
    missing.push(name);
    if (read.benchmark) stale.push(...benchmarkStale(ctx.benchmark!.stale));
    if (read.reason !== undefined) reason = read.reason;
  }
  if (missing.length > 0) return unavailable(r, missing, stale, reason);
  if (!args.filters.every((f) => passes(f, values.get(f.field)!.value))) {
    return null;
  }
  const shown: Record<string, object | null> = {};
  for (const [name, v] of values) {
    shown[name] = { ...v, value: round(v.value) };
  }
  // an asked field no filter reads is shown, or null, never a reason
  for (const name of args.fields) {
    if (Object.hasOwn(shown, name)) continue;
    const read = readField(ctx, name, r.instrument, latest, q.price, once);
    shown[name] = read.ok
      ? { ...read.value, value: round(read.value.value) }
      : null;
  }
  return {
    id: r.instrument.id,
    key: args.sort === null ? null : values.get(args.sort)!.value,
    fred: q.kind === "observation",
    item: {
      input: r.input,
      id: r.instrument.id,
      status: "matched",
      name: r.instrument.name,
      unit: r.instrument.unit,
      currency: r.instrument.currency,
      kind: q.kind,
      price: q.price,
      ...(q.kind === "observation" ? { observation: q.observation } : {}),
      trade_time: q.trade_time,
      fetched_at: q.fetched_at,
      fields: shown,
    },
  };
}
