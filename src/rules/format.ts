// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The rule format: a small fixed JSON tree of comparisons under all and
// any, never an expression language, so every rule is checked once here
// and read the same way by evaluation, tracking and the tools. A stored
// condition names every instrument by its id and binds its earnings gate
// to one fiscal quarter.

import { SOURCE as FRED } from "../fred/client.ts";
import type { Instrument } from "../instruments.ts";
import type { DailyRow } from "../signals/daily.ts";
import type { WeeklyRow } from "../signals/weekly.ts";

export class RuleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RuleError";
  }
}

export const OPS = ["<", "<=", ">", ">="] as const;
export type Op = (typeof OPS)[number];

export const MAX_COMPARISONS = 8;
export const MAX_DEPTH = 3;
export const MAX_INSTRUMENTS = 4;
export const MAX_NOTE = 500;
// the condition as the caller sent it, serialized
export const MAX_CONDITION_BYTES = 4096;
export const MAX_SYMBOL = 100;
// past this a level is a typo, not a price
export const MAX_LITERAL = 1e15;

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

// The quote fields, the signal columns of the live daily and weekly
// rows by their row names, and relative return computed on read.
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

const SHAPE =
  "a comparison {left, op, right}, or {all: [...]} or {any: [...]} of them";

// a snake_case name an agent may have taken from the screen tool
function hint(name: string): string {
  const camel = name.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
  const known = FIELD_NAMES.find(
    (f) => f.toLowerCase() === camel.toLowerCase(),
  );
  return known === undefined ? "" : `; did you mean ${known}?`;
}

const quoted = (s: string) => (s.length > 64 ? `${s.slice(0, 64)}…` : s);

type Mode = "input" | "stored";

function symbolText(v: unknown, path: string): string {
  if (typeof v !== "string" || v.trim() === "") {
    throw new RuleError(`${path} must be a non-empty symbol`);
  }
  if (v.length > MAX_SYMBOL) {
    throw new RuleError(`${path} is longer than ${MAX_SYMBOL} characters`);
  }
  return v.trim();
}

function fieldName(v: unknown, path: string): string {
  if (typeof v !== "string") {
    throw new RuleError(`${path} must be a field name`);
  }
  if (!Object.hasOwn(FIELDS, v)) {
    throw new RuleError(`${path}: unknown field ${quoted(v)}${hint(v)}`);
  }
  return v;
}

function operand(v: unknown, path: string, mode: Mode): InputOperand {
  if (typeof v === "string" && mode === "input") {
    const field = fieldName(v, path);
    if (FIELDS[field]!.from === "relative") {
      throw new RuleError(
        `${path}: ${field} needs a benchmark: {"field": "${field}", "benchmark": "QQQ"}`,
      );
    }
    return { field, symbol: null };
  }
  if (!isObject(v)) {
    throw new RuleError(
      `${path} must be a field name or {field, symbol, benchmark}`,
    );
  }
  for (const k of Object.keys(v)) {
    if (k !== "field" && k !== "symbol" && k !== "benchmark") {
      throw new RuleError(`${path}: unknown property ${quoted(k)}`);
    }
  }
  const field = fieldName(v.field, `${path}.field`);
  const relative = FIELDS[field]!.from === "relative";
  let symbol: string | null = null;
  if (v.symbol !== undefined) symbol = symbolText(v.symbol, `${path}.symbol`);
  else if (mode === "stored") throw new RuleError(`${path} has no symbol`);
  if (relative !== (v.benchmark !== undefined)) {
    throw new RuleError(
      relative
        ? `${path}: ${field} needs a benchmark`
        : `${path}: only relativeReturn1m and relativeReturn3m take a benchmark`,
    );
  }
  const out: InputOperand = { field, symbol };
  if (relative) out.benchmark = symbolText(v.benchmark, `${path}.benchmark`);
  return out;
}

function literal(v: number, path: string): number {
  if (!Number.isFinite(v) || Math.abs(v) > MAX_LITERAL) {
    throw new RuleError(`${path} must be a finite number`);
  }
  return v;
}

type Count = { comparisons: number };

function node(
  v: unknown,
  path: string,
  depth: number,
  count: Count,
  mode: Mode,
  root: boolean,
): InputNode {
  if (!isObject(v)) throw new RuleError(`${path} must be ${SHAPE}`);
  if (depth > MAX_DEPTH) {
    throw new RuleError(`${path}: conditions nest at most ${MAX_DEPTH} deep`);
  }
  const keys = Object.keys(v).filter((k) => !(root && k === "afterEarnings"));
  if (keys.includes("all") || keys.includes("any")) {
    if (keys.length !== 1) {
      throw new RuleError(
        `${path}: all or any stands alone, with no other property`,
      );
    }
    const key = keys[0] as "all" | "any";
    const list = v[key];
    if (!Array.isArray(list) || list.length === 0) {
      throw new RuleError(`${path}.${key} must be a non-empty list`);
    }
    if (list.length > MAX_COMPARISONS) {
      throw new RuleError(
        `${path}.${key} holds at most ${MAX_COMPARISONS} conditions`,
      );
    }
    const children = list.map((c, k) =>
      node(c, `${path}.${key}[${k}]`, depth + 1, count, mode, false),
    );
    return key === "all" ? { all: children } : { any: children };
  }
  for (const k of keys) {
    if (k !== "left" && k !== "op" && k !== "right") {
      throw new RuleError(
        k === "afterEarnings"
          ? `${path}: afterEarnings goes on the condition's root only`
          : `${path}: unknown property ${quoted(k)}; a condition is ${SHAPE}`,
      );
    }
  }
  for (const k of ["left", "op", "right"]) {
    if (!(k in v))
      throw new RuleError(`${path} has no ${k}; it must be ${SHAPE}`);
  }
  count.comparisons++;
  if (count.comparisons > MAX_COMPARISONS) {
    throw new RuleError(
      `a condition holds at most ${MAX_COMPARISONS} comparisons`,
    );
  }
  if (typeof v.op !== "string" || !(OPS as readonly string[]).includes(v.op)) {
    throw new RuleError(`${path}.op must be one of ${OPS.join(" ")}`);
  }
  if (typeof v.left === "number") {
    throw new RuleError(
      `${path}.left must be an operand; put the number on the right`,
    );
  }
  const left = operand(v.left, `${path}.left`, mode);
  const right =
    typeof v.right === "number"
      ? literal(v.right, `${path}.right`)
      : operand(v.right, `${path}.right`, mode);
  return { left, op: v.op as Op, right };
}

function parse(
  v: unknown,
  mode: Mode,
): { node: InputNode; gate: unknown | undefined } {
  if (!isObject(v)) throw new RuleError(`condition must be ${SHAPE}`);
  const n = node(v, "condition", 1, { comparisons: 0 }, mode, true);
  return { node: n, gate: v.afterEarnings };
}

// What a caller sends, checked before anything is resolved or fetched.
export function parseCondition(value: unknown): InputCondition {
  if (isObject(value)) {
    const bytes = Buffer.byteLength(JSON.stringify(value));
    if (bytes > MAX_CONDITION_BYTES) {
      throw new RuleError(
        `condition is longer than ${MAX_CONDITION_BYTES} bytes`,
      );
    }
  }
  const { node: n, gate } = parse(value, "input");
  return {
    node: n,
    afterEarnings:
      gate === undefined ? null : symbolText(gate, "condition.afterEarnings"),
  };
}

// A stored condition, written only by this module; a row that no longer
// parses is the server's fault, never the caller's.
export function readCondition(text: string): Condition {
  const value: unknown = JSON.parse(text);
  const { node: n, gate } = parse(value, "stored");
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
  return { node: n as Node, afterEarnings };
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

// every symbol a caller named, the gate's included, in order and once
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

// The caller's condition with each symbol replaced by its instrument id,
// the rule's own filled in, and the gate bound to its event.
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

// every instrument a stored condition reads, the gate's company included
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

// A split rescales instrument's price levels: a comparison of one with
// a fixed number or with another listing's price no longer means what
// it did. Against its own average or high it still does.
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

// a price level in a unit the source does not name, such as a future's
// price per barrel or per bond, or in one index's points, which are no
// other index's: ^VIX's volatility, ^TNX's yield
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
      `a rule reads at most ${MAX_INSTRUMENTS} instruments; this one reads ${ids.size}`,
    );
  }
  const get = (id: string) => {
    const i = instruments.get(id);
    if (i === undefined) throw new Error(`${id} was not resolved`);
    return i;
  };
  comparisons<Comparison>(c.node).forEach((cmp, k) => {
    const at = `comparison ${k + 1}`;
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
        `${at} reads no live value: compare a live field such as price, changePct or a signal of a listing with quotes`,
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
          `${at} compares ${cmp.left.field} in ${l} with ${cmp.right.field} in ${r}; both sides need the same unit`,
        );
      }
    }
  });
}
