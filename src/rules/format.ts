// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// Stored as a fixed JSON tree with the server's own keys; read and written
// by callers as text (src/shared/when.ts), never an expression language.

import type { Instrument } from "../market/instruments.ts";
import {
  MAX_COMPARISONS,
  MAX_DEPTH,
  MAX_SYMBOL,
  parseWhen,
  renderWhen,
  WHEN_FIELDS,
  WhenError,
  type WhenNode,
  type WhenOperand,
} from "../shared/when.ts";
import type { DailyRow } from "../signals/daily.ts";
import type { WeeklyRow } from "../signals/weekly.ts";
import { FRED } from "../sources/ids.ts";

export {
  MAX_COMPARISONS,
  MAX_DEPTH,
  MAX_LITERAL,
  MAX_SYMBOL,
} from "../shared/when.ts";

export class RuleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RuleError";
  }
}

export const OPS = ["<", "<=", ">", ">="] as const;
export type Op = (typeof OPS)[number];

export const MAX_INSTRUMENTS = 4;
export const MAX_NOTE = 500;

type DailyKey = Exclude<keyof DailyRow, "date">;
type WeeklyKey = Exclude<keyof WeeklyRow, "date">;

// the listing's own unit and currency, which a split rescales
export const PRICE_LEVEL = "price";

export type QuoteColumn =
  | "price"
  | "previousClose"
  | "changePercent"
  | "dayHigh"
  | "dayLow";

export type FieldDef =
  | { from: "quote"; column: QuoteColumn; live: boolean; unit: string }
  | { from: "daily"; key: DailyKey; unit: string }
  | { from: "weekly"; key: WeeklyKey; unit: string }
  | { from: "relative"; months: 1 | 3; unit: string };

const quote = (column: QuoteColumn, unit: string, live = true): FieldDef => ({
  from: "quote",
  column,
  live,
  unit,
});
const daily = (key: DailyKey, unit: string): FieldDef => ({
  from: "daily",
  key,
  unit,
});
const weekly = (key: WeeklyKey, unit: string): FieldDef => ({
  from: "weekly",
  key,
  unit,
});

export const FIELDS: Readonly<Record<string, FieldDef>> = {
  price: quote("price", PRICE_LEVEL),
  // yesterday's close: a comparison needs another, live, side
  previousClose: quote("previousClose", PRICE_LEVEL, false),
  changePct: quote("changePercent", "percent"),
  dayHigh: quote("dayHigh", PRICE_LEVEL),
  dayLow: quote("dayLow", PRICE_LEVEL),
  sma50: daily("sma50", PRICE_LEVEL),
  sma200: daily("sma200", PRICE_LEVEL),
  ema20: daily("ema20", PRICE_LEVEL),
  cross: daily("cross", "state"),
  crossEdge: daily("crossEdge", "state"),
  rsi14: daily("rsi14", "0 to 100"),
  macd: daily("macd", PRICE_LEVEL),
  macdSignal: daily("macdSignal", PRICE_LEVEL),
  macdHistogram: daily("macdHistogram", PRICE_LEVEL),
  macdTurn: daily("macdTurn", "state"),
  atr14: daily("atr14", PRICE_LEVEL),
  moveAtr: daily("moveAtr", "ATRs"),
  volatility20: daily("volatility20", "percent per day"),
  bollingerLower: daily("bollingerLower", PRICE_LEVEL),
  high52w: daily("high52w", PRICE_LEVEL),
  low52w: daily("low52w", PRICE_LEVEL),
  drawdown: daily("drawdown", "percent"),
  fromLow: daily("fromLow", "percent"),
  daysSinceHigh: daily("daysSinceHigh", "trading days"),
  volumeRatio: daily("volumeRatio", "ratio"),
  weeklySma50: weekly("sma50", PRICE_LEVEL),
  weeklySma200: weekly("sma200", PRICE_LEVEL),
  weeklyCross: weekly("cross", "state"),
  weeklyCrossEdge: weekly("crossEdge", "state"),
  relativeReturn1m: { from: "relative", months: 1, unit: "percentage points" },
  relativeReturn3m: { from: "relative", months: 3, unit: "percentage points" },
};

export const FIELD_NAMES = Object.keys(FIELDS);

export type Operand = { field: string; symbol: string; benchmark?: string };
export type Comparison = { left: Operand; op: Op; right: number | Operand };
export type Node = Comparison | { all: Node[] } | { any: Node[] };

// the event a gated rule waits for, by its fiscal key
export type Gate = {
  symbol: string;
  fiscalYear: number;
  fiscalQuarter: number;
};

// as stored: every symbol an instrument id
export type Condition = { node: Node; afterEarnings: Gate | null };

// as a caller gives it: a symbol left out is the rule's own
export type InputOperand = {
  field: string;
  symbol: string | null;
  benchmark?: string;
};
type InputComparison = {
  left: InputOperand;
  op: Op;
  right: number | InputOperand;
};
export type InputNode =
  | InputComparison
  | { all: InputNode[] }
  | { any: InputNode[] };
export type InputCondition = {
  node: InputNode;
  afterEarnings: string | null;
};

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

export const isComparison = <T extends { op: Op }>(
  n: T | { all: unknown } | { any: unknown },
): n is T => "op" in n;

// the caller's name of a stored key: change_percent for changePct
const PUBLIC: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(WHEN_FIELDS).map(([name, key]) => [key, name]),
);
export const publicField = (key: string): string => PUBLIC[key] ?? key;

const SHAPE = "a stored condition is a comparison or all or any of them";

function storedOperand(v: unknown, path: string): Operand {
  if (
    !isObject(v) ||
    typeof v.field !== "string" ||
    !Object.hasOwn(FIELDS, v.field) ||
    typeof v.symbol !== "string" ||
    v.symbol.length > MAX_SYMBOL
  ) {
    throw new RuleError(`${path} is not a stored operand`);
  }
  const relative = FIELDS[v.field]!.from === "relative";
  if (relative !== (typeof v.benchmark === "string")) {
    throw new RuleError(`${path} is not a stored operand`);
  }
  const out: Operand = { field: v.field, symbol: v.symbol };
  if (relative) out.benchmark = v.benchmark as string;
  return out;
}

function storedNode(v: unknown, path: string, depth: number): Node {
  if (!isObject(v) || depth > MAX_DEPTH)
    throw new RuleError(`${path}: ${SHAPE}`);
  const list = Array.isArray(v.all)
    ? v.all
    : Array.isArray(v.any)
      ? v.any
      : null;
  if (list !== null) {
    if (list.length === 0 || list.length > MAX_COMPARISONS) {
      throw new RuleError(`${path}: ${SHAPE}`);
    }
    const kids = list.map((c, k) => storedNode(c, `${path}[${k}]`, depth + 1));
    return "all" in v ? { all: kids } : { any: kids };
  }
  if (typeof v.op !== "string" || !(OPS as readonly string[]).includes(v.op)) {
    throw new RuleError(`${path}: ${SHAPE}`);
  }
  const right =
    typeof v.right === "number" && Number.isFinite(v.right)
      ? v.right
      : storedOperand(v.right, `${path}.right`);
  return { left: storedOperand(v.left, `${path}.left`), op: v.op as Op, right };
}

// the text a caller sent, checked before anything is resolved or fetched
export function parseWhenCondition(
  text: string,
  afterEarnings: string | null,
): InputCondition {
  let n: WhenNode;
  try {
    n = parseWhen(text);
  } catch (error) {
    if (error instanceof WhenError) throw new RuleError(error.message);
    throw error;
  }
  const operand = (o: WhenOperand): InputOperand => {
    const out: InputOperand = {
      field: WHEN_FIELDS[o.field]!,
      symbol: o.symbol,
    };
    if (o.benchmark !== undefined) out.benchmark = o.benchmark;
    return out;
  };
  const walk = (x: WhenNode): InputNode => {
    if ("all" in x) return { all: x.all.map(walk) };
    if ("any" in x) return { any: x.any.map(walk) };
    return {
      left: operand(x.left),
      op: x.op,
      right: typeof x.right === "number" ? x.right : operand(x.right),
    };
  };
  return { node: walk(n), afterEarnings };
}

// the stored tree in the caller's words, its own symbol left out
export function whenOperand(o: Operand, own: string): WhenOperand {
  const out: WhenOperand = {
    field: publicField(o.field),
    symbol: o.symbol === own ? null : o.symbol,
  };
  if (o.benchmark !== undefined) out.benchmark = o.benchmark;
  return out;
}

export function whenNode(n: Node, own: string): WhenNode {
  const operand = (o: Operand) => whenOperand(o, own);
  if ("all" in n) return { all: n.all.map((k) => whenNode(k, own)) };
  if ("any" in n) return { any: n.any.map((k) => whenNode(k, own)) };
  return {
    left: operand(n.left),
    op: n.op,
    right: typeof n.right === "number" ? n.right : operand(n.right),
  };
}

export const whenText = (n: Node, own: string): string =>
  renderWhen(whenNode(n, own));

// A stored condition, written only by this module; a row that no longer
// parses is the server's fault, never the caller's.
export function readCondition(text: string): Condition {
  const value: unknown = JSON.parse(text);
  if (!isObject(value)) throw new RuleError(SHAPE);
  const { afterEarnings: gate, ...rest } = value;
  const n = storedNode(rest, "condition", 1);
  let afterEarnings: Gate | null = null;
  if (gate !== undefined) {
    const g = gate as Record<string, unknown>;
    if (
      !isObject(g) ||
      typeof g.symbol !== "string" ||
      !Number.isSafeInteger(g.fiscalYear) ||
      !Number.isSafeInteger(g.fiscalQuarter)
    ) {
      throw new RuleError("a stored earnings gate is malformed");
    }
    afterEarnings = {
      symbol: g.symbol,
      fiscalYear: g.fiscalYear as number,
      fiscalQuarter: g.fiscalQuarter as number,
    };
  }
  return { node: n, afterEarnings };
}

export function writeCondition(c: Condition): string {
  return JSON.stringify(
    c.afterEarnings === null
      ? c.node
      : { ...c.node, afterEarnings: c.afterEarnings },
  );
}

export function comparisons<T extends { op: Op }>(
  n: T | { all: unknown[] } | { any: unknown[] },
): T[] {
  if (isComparison(n)) return [n];
  const list = ("all" in n ? n.all : n.any) as (
    | T
    | { all: unknown[] }
    | { any: unknown[] }
  )[];
  return list.flatMap((c) => comparisons<T>(c));
}

const operands = <O>(c: { left: O; right: number | O }): O[] =>
  typeof c.right === "number" ? [c.left] : [c.left, c.right];

// the gate's symbol included, in order and once
export function inputSymbols(c: InputCondition): string[] {
  const out: string[] = [];
  for (const cmp of comparisons<InputComparison>(c.node)) {
    for (const o of operands(cmp)) {
      if (o.symbol !== null) out.push(o.symbol);
      if (o.benchmark !== undefined) out.push(o.benchmark);
    }
  }
  if (c.afterEarnings !== null) out.push(c.afterEarnings);
  return [...new Set(out)];
}

export function bindCondition(
  c: InputCondition,
  own: string,
  idOf: (symbol: string) => string,
  gate: Gate | null,
): Condition {
  const bind = (o: InputOperand): Operand => {
    const out: Operand = {
      field: o.field,
      symbol: o.symbol === null ? own : idOf(o.symbol),
    };
    if (o.benchmark !== undefined) out.benchmark = idOf(o.benchmark);
    return out;
  };
  const walk = (n: InputNode): Node => {
    if ("all" in n) return { all: n.all.map(walk) };
    if ("any" in n) return { any: n.any.map(walk) };
    return {
      left: bind(n.left),
      op: n.op,
      right: typeof n.right === "number" ? n.right : bind(n.right),
    };
  };
  return { node: walk(c.node), afterEarnings: gate };
}

// the gate's company included
export function instrumentsOf(c: Condition): Set<string> {
  const out = new Set<string>();
  for (const cmp of comparisons<Comparison>(c.node)) {
    for (const o of operands(cmp)) {
      out.add(o.symbol);
      if (o.benchmark !== undefined) out.add(o.benchmark);
    }
  }
  if (c.afterEarnings !== null) out.add(c.afterEarnings.symbol);
  return out;
}

const isPriceLevel = (o: Operand) => FIELDS[o.field]!.unit === PRICE_LEVEL;

// a split rescales the instrument's price levels: against a fixed number or
// another listing's price a comparison changes meaning; against its average not
export function splitSensitive(c: Comparison, instrument: string): boolean {
  const sides = operands(c).filter(
    (o) => o.symbol === instrument && isPriceLevel(o),
  );
  if (sides.length === 0) return false;
  if (typeof c.right === "number") return true;
  return !(isPriceLevel(c.left) && isPriceLevel(c.right) && sides.length === 2);
}

export const hasQuote = (i: Pick<Instrument, "source">) => i.source !== FRED;

// a value computed from today's price: a quote field but the previous
// close, or any signal or relative return of a listing with quotes
export function isLive(o: Operand, i: Pick<Instrument, "source">): boolean {
  const def = FIELDS[o.field]!;
  if (!hasQuote(i)) return false;
  return def.from !== "quote" || def.live;
}

// a price level in a unit the source does not name (a future's per barrel or
// per bond) or in one index's points, no other's: ^VIX volatility, ^TNX yield
const unknownUnit = (o: Operand, i: Instrument): boolean =>
  FIELDS[o.field]!.unit === PRICE_LEVEL &&
  (i.unit === "unknown" || i.unit === "index_points");

export const UNKNOWN_UNIT =
  "comparing different instruments needs a known shared unit";

export const NO_RETURN_QUOTE =
  "relative return needs live quotes for the instrument and its benchmark";

const unitOf = (o: Operand, i: Instrument): string => {
  const unit = FIELDS[o.field]!.unit;
  if (unit !== PRICE_LEVEL) return unit;
  return i.currency === null ? i.unit : `${i.unit} ${i.currency}`;
};

// checks only the resolved instruments can answer: count, quotes, units
export function checkBound(
  c: Condition,
  own: string,
  instruments: ReadonlyMap<string, Instrument>,
): void {
  const ids = instrumentsOf(c);
  ids.add(own);
  if (ids.size > MAX_INSTRUMENTS) {
    throw new RuleError(
      `an alert reads at most ${MAX_INSTRUMENTS} symbols; this one reads ${ids.size}`,
    );
  }
  const get = (id: string) => {
    const i = instruments.get(id);
    if (i === undefined) throw new Error(`${id} was not resolved`);
    return i;
  };
  comparisons<Comparison>(c.node).forEach((cmp, k) => {
    const at = `comparison ${k + 1} (${whenText(cmp, own)})`;
    for (const o of operands(cmp)) {
      const i = get(o.symbol);
      if (FIELDS[o.field]!.from === "quote" && !hasQuote(i)) {
        throw new RuleError(
          `${at}: ${i.id} is a series with no quote; read it by a signal such as sma50`,
        );
      }
      if (FIELDS[o.field]!.from === "relative") {
        const b = get(o.benchmark!);
        // a series' return never moves with a live price
        if (!hasQuote(i) || !hasQuote(b)) {
          throw new RuleError(`${at}: ${NO_RETURN_QUOTE}`);
        }
      }
    }
    if (!operands(cmp).some((o) => isLive(o, get(o.symbol)))) {
      throw new RuleError(
        `${at} reads no live value: compare a live field such as price, change_percent or a signal of a listing with quotes`,
      );
    }
    if (typeof cmp.right !== "number") {
      const li = get(cmp.left.symbol);
      const ri = get(cmp.right.symbol);
      if (
        li.id !== ri.id &&
        (unknownUnit(cmp.left, li) || unknownUnit(cmp.right, ri))
      ) {
        throw new RuleError(`${at}: ${UNKNOWN_UNIT}`);
      }
      const l = unitOf(cmp.left, li);
      const r = unitOf(cmp.right, ri);
      if (l !== r) {
        throw new RuleError(
          `${at} compares ${publicField(cmp.left.field)} in ${l} with ${publicField(cmp.right.field)} in ${r}; both sides need the same unit`,
        );
      }
    }
  });
}
