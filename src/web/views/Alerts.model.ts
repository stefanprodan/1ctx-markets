// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// A rule read as words, never as its JSON: the server's field names and
// reasons stay off the page.

import type {
  Alert,
  ComparisonValue,
  Listings,
  Node,
  Op,
  Operand,
  Rule,
} from "../data/alerts.ts";
import { amount } from "../lib/format.ts";
import { tickerOf } from "../lib/names.ts";

type Unit =
  | "price"
  | "percent"
  | "points"
  | "ratio"
  | "atrs"
  | "days"
  | "plain"
  | "state";

// every field the rules take (FIELDS in src/rules/format.ts)
export const FIELD_WORDS: Record<string, { label: string; unit: Unit }> = {
  price: { label: "Price", unit: "price" },
  previousClose: { label: "Previous close", unit: "price" },
  changePct: { label: "Day move", unit: "percent" },
  dayHigh: { label: "Day high", unit: "price" },
  dayLow: { label: "Day low", unit: "price" },
  sma50: { label: "50-day average", unit: "price" },
  sma200: { label: "200-day average", unit: "price" },
  ema20: { label: "20-day EMA", unit: "price" },
  cross: { label: "50/200-day cross", unit: "state" },
  crossEdge: { label: "50/200-day cross today", unit: "state" },
  rsi14: { label: "RSI", unit: "plain" },
  macd: { label: "MACD", unit: "price" },
  macdSignal: { label: "MACD signal", unit: "price" },
  macdHistogram: { label: "MACD histogram", unit: "price" },
  macdTurn: { label: "MACD turn", unit: "state" },
  atr14: { label: "Average true range", unit: "price" },
  moveAtr: { label: "Move in ATRs", unit: "atrs" },
  volatility20: { label: "20-day volatility", unit: "percent" },
  bollingerLower: { label: "Lower Bollinger band", unit: "price" },
  high52w: { label: "52-week high", unit: "price" },
  low52w: { label: "52-week low", unit: "price" },
  drawdown: { label: "Drop from high", unit: "percent" },
  fromLow: { label: "Rise from low", unit: "percent" },
  daysSinceHigh: { label: "Days since high", unit: "days" },
  volumeRatio: { label: "Volume vs average", unit: "ratio" },
  weeklySma50: { label: "50-week average", unit: "price" },
  weeklySma200: { label: "200-week average", unit: "price" },
  weeklyCross: { label: "50/200-week cross", unit: "state" },
  weeklyCrossEdge: { label: "50/200-week cross this week", unit: "state" },
  relativeReturn1m: { label: "1-month return", unit: "points" },
  relativeReturn3m: { label: "3-month return", unit: "points" },
};

const words = (field: string) =>
  FIELD_WORDS[field] ?? { label: field, unit: "plain" as Unit };

export const OP_WORDS: Record<Op, string> = {
  "<": "below",
  "<=": "at or below",
  ">": "above",
  ">=": "at or above",
};

const STATES: Record<string, Record<number, string>> = {
  cross: { 1: "golden", 0: "none", [-1]: "death" },
  weeklyCross: { 1: "golden", 0: "none", [-1]: "death" },
  crossEdge: { 1: "golden", 0: "none", [-1]: "death" },
  weeklyCrossEdge: { 1: "golden", 0: "none", [-1]: "death" },
  macdTurn: { 1: "up", 0: "none", [-1]: "down" },
};

const isComparison = (
  n: Node,
): n is { left: Operand; op: Op; right: number | Operand } => "op" in n;

// an index without Yahoo's caret: VIX, not ^VIX
export const tickerIn = (id: string, l: Listings) =>
  tickerOf(id, l[id]?.type).replace(/^\^/, "");

// a value in its field's unit, a price in the listing's currency
export function valueText(
  field: string,
  v: number | null,
  symbol: string,
  l: Listings,
): string {
  if (v === null) return "–";
  const u = words(field).unit;
  if (u === "price") {
    // an index's points and a yield's percent carry no currency
    const unit = l[symbol]?.unit;
    if (unit === "index_points") return round(v, 2);
    if (unit === "percent") return `${round(v, 2)}%`;
    return amount(v, l[symbol]?.currency ?? null);
  }
  if (u === "percent") return `${round(v, 2)}%`;
  if (u === "points") return `${round(v, 2)} pts`;
  if (u === "ratio") return `${round(v, 2)}×`;
  if (u === "atrs") return `${round(v, 2)} ATRs`;
  if (u === "days") return `${Math.round(v)} days`;
  if (u === "state") return STATES[field]?.[v] ?? String(v);
  return String(round(v, 1));
}

const round = (v: number, d: number) =>
  Number(v.toFixed(d)).toLocaleString("en-US", { maximumFractionDigits: d });

// a field named, with its listing when it is not the rule's own
function subject(o: Operand, own: string, l: Listings): string {
  const w = words(o.field).label;
  const bench = o.benchmark ? ` vs ${tickerIn(o.benchmark, l)}` : "";
  return o.symbol === own
    ? `${w}${bench}`
    : `${tickerIn(o.symbol, l)}${o.field === "price" ? "" : ` ${w}`}${bench}`;
}

function target(
  right: number | Operand,
  left: Operand,
  own: string,
  l: Listings,
): string {
  if (typeof right === "number") {
    return valueText(left.field, right, left.symbol, l);
  }
  const s = subject(right, own, l);
  return right.symbol === own ? lower(s) : s;
}

// "Price at or below 80.00 EUR", "VIX above 30", "RSI below 30"
export function comparisonText(
  c: { left: Operand; op: Op; right: number | Operand },
  own: string,
  l: Listings,
): string {
  return `${subject(c.left, own, l)} ${OP_WORDS[c.op]} ${target(c.right, c.left, own, l)}`;
}

// "Lower Bollinger band" mid-sentence, never "mACD"
const lower = (s: string) =>
  /^[A-Z][a-z]/.test(s) ? s[0]!.toLowerCase() + s.slice(1) : s;

export type Line = { text: string; depth: number };

// one line per comparison, a group's words leading its lines
export function conditionLines(n: Node, own: string, l: Listings): Line[] {
  const out: Line[] = [];
  const walk = (x: Node, depth: number) => {
    if (isComparison(x)) {
      out.push({ text: comparisonText(x, own, l), depth });
      return;
    }
    const all = "all" in x;
    out.push({ text: all ? "All of" : "Any of", depth });
    for (const k of all ? x.all : x.any) walk(k, depth + 1);
  };
  walk(n, 0);
  return out;
}

export function gateText(rule: Pick<Rule, "after_earnings">, l: Listings) {
  const g = rule.after_earnings;
  if (g === undefined) return null;
  return `After ${tickerIn(g.symbol, l)}'s Q${g.fiscal_quarter} ${g.fiscal_year} results`;
}

// the condition on one line, for a row
export function ruleSummary(rule: Rule, l: Listings): string {
  const n = rule.condition;
  const gate = gateText(rule, l);
  const body = isComparison(n)
    ? comparisonText(n, rule.symbol, l)
    : inline(n, rule.symbol, l);
  return gate === null ? body : `${gate}: ${lower(body)}`;
}

// a flat group read out, "Price at or below 165.00 EUR and RSI below 40";
// a nested one, or one too long for a row, by its count
const INLINE_MAX = 90;
function inline(n: Node, own: string, l: Listings): string {
  const kids = "all" in n ? n.all : "any" in n ? n.any : [];
  const all = "all" in n;
  if (kids.every(isComparison)) {
    const text = kids
      .map((k, i) => {
        const t = comparisonText(k, own, l);
        return i === 0 ? t : lower(t);
      })
      .join(all ? " and " : " or ");
    if (text.length <= INLINE_MAX) return text;
  }
  return `${all ? "All" : "Any"} of ${count(n)} conditions`;
}

const count = (n: Node): number =>
  isComparison(n)
    ? 1
    : ("all" in n ? n.all : n.any).reduce((s, k) => s + count(k), 0);

// a percent away only means something between price levels: MACD and ATR
// share the price's unit but sit near zero
const LEVELS = new Set([
  "price",
  "previousClose",
  "dayHigh",
  "dayLow",
  "sma50",
  "sma200",
  "ema20",
  "bollingerLower",
  "high52w",
  "low52w",
  "weeklySma50",
  "weeklySma200",
]);

export function distanceOf(v: ComparisonValue): number | null {
  if (
    !LEVELS.has(v.left.field) ||
    v.left.value === null ||
    v.left.value === 0
  ) {
    return null;
  }
  const level = typeof v.right === "number" ? v.right : v.right.value;
  if (level === null) return null;
  if (typeof v.right !== "number" && !LEVELS.has(v.right.field)) return null;
  if (v.holds === true) return 0;
  return (Math.abs(level - v.left.value) / Math.abs(v.left.value)) * 100;
}

// a price as is, any other reading with its name: "RSI 34.5", "VIX 16.82"
export function nowText(v: ComparisonValue, own: string, l: Listings): string {
  const text = valueText(v.left.field, v.left.value, v.left.symbol, l);
  return v.left.symbol === own && words(v.left.field).unit === "price"
    ? text
    : `${subject(v.left, own, l)} ${text}`;
}

export type Near = {
  // the nearest comparison not yet holding, in percent; 0 when it holds
  distance: number | null;
  holds: number;
  of: number;
  // the value shown on the row: the first comparison's left side
  shown: { text: string; field: string } | null;
};

// all of: only when every condition left is a price, the farthest of them;
// any of: the nearest price; another reading has no distance in percent
// walked as the server lists values: comparisons depth first
// (comparisons() in src/rules/format.ts); a group met counts 0
function distanceAll(rule: Rule): number | null {
  if (rule.now.result === "true") return 0;
  const values = rule.now.values;
  let at = 0;
  const walk = (n: Node): number | null => {
    if (isComparison(n)) {
      const v = values[at++];
      return v === undefined ? null : distanceOf(v);
    }
    const kids = ("all" in n ? n.all : n.any).map(walk);
    if ("any" in n) {
      const known = kids.filter((d): d is number => d !== null);
      return known.length > 0 ? Math.min(...known) : null;
    }
    return kids.some((d) => d === null)
      ? null
      : Math.max(...(kids as number[]));
  };
  return walk(rule.condition);
}

export function nearOf(rule: Rule, l: Listings): Near {
  const vs = rule.now.values;
  const holds = vs.filter((v) => v.holds === true).length;
  const first = vs[0];
  return {
    distance: distanceAll(rule),
    holds,
    of: vs.length,
    shown:
      first === undefined
        ? null
        : {
            text: nowText(first, rule.symbol, l),
            field: first.left.field,
          },
  };
}

// the other side of a comparison now, named: "200-day average 438.99 USD"
export function rightNow(
  v: ComparisonValue,
  own: string,
  l: Listings,
): string | null {
  if (typeof v.right === "number") return null;
  const name = subject(v.right, own, l);
  return `${v.right.symbol === own ? lower(name) : name} ${valueText(v.right.field, v.right.value, v.right.symbol, l)}`;
}

export type StateKey =
  | "watching"
  | "holds"
  | "fired"
  | "paused"
  | "split"
  | "earnings"
  | "stale"
  | "unknown";

export const STATE_WORDS: Record<StateKey, string> = {
  watching: "Watching",
  holds: "Met",
  fired: "Fired",
  paused: "Paused",
  split: "Paused by a split",
  earnings: "Waiting for earnings",
  stale: "No fresh price",
  unknown: "Can't check now",
};

const WAITING = "waiting for the earnings results";
const FRESH_PRICE =
  /quote overdue|quote sync failed|no quote|session check failed|no live|no value/;

export function stateOf(rule: Rule): StateKey {
  if (rule.paused === "split") return "split";
  if (rule.paused === "manual") return "paused";
  const { result, reasons } = rule.now;
  if (result === "unknown") {
    // a price that did not come in (STALE in src/market/stale.ts); bars or
    // signals still pending are another wait
    return reasons.some((r) => FRESH_PRICE.test(r)) ? "stale" : "unknown";
  }
  if (reasons.includes(WAITING)) return "earnings";
  if (result === "true") return rule.armed ? "holds" : "fired";
  return "watching";
}

export const NEAR_PERCENT = 5;
export const WEEK_MS = 7 * 24 * 3600 * 1000;

export type TileKey = "all" | "near" | "fired" | "paused";

export const TILES: readonly { key: TileKey; name: string }[] = [
  { key: "all", name: "All rules" },
  { key: "near", name: `Within ${NEAR_PERCENT}%` },
  { key: "fired", name: "Fired this week" },
  { key: "paused", name: "Paused" },
];

export function inTile(
  key: TileKey,
  rule: Rule,
  alerts: readonly Alert[],
  now: number,
): boolean {
  const s = stateOf(rule);
  if (key === "paused") return s === "paused" || s === "split";
  if (key === "near") {
    const d = nearOf(rule, {}).distance;
    return s !== "paused" && s !== "split" && d !== null && d <= NEAR_PERCENT;
  }
  if (key === "fired") {
    return alerts.some(
      (a) => a.rule_id === rule.id && now - Date.parse(a.fired_at) < WEEK_MS,
    );
  }
  return true;
}

// nearest first, a symbol's rules together, paused last
export function sortRules(rules: readonly Rule[]): Rule[] {
  const rank = (r: Rule) => {
    const s = stateOf(r);
    return s === "paused" || s === "split" ? 2 : 0;
  };
  const d = (r: Rule) => nearOf(r, {}).distance ?? Number.POSITIVE_INFINITY;
  const best = new Map<string, number>();
  for (const r of rules) {
    if (rank(r) > 0) continue;
    best.set(r.symbol, Math.min(best.get(r.symbol) ?? Infinity, d(r)));
  }
  return [...rules].sort(
    (a, b) =>
      rank(a) - rank(b) ||
      (best.get(a.symbol) ?? Infinity) - (best.get(b.symbol) ?? Infinity) ||
      a.symbol.localeCompare(b.symbol) ||
      d(a) - d(b) ||
      a.id - b.id,
  );
}

// "Price fell to 79.62 EUR, at or below 80.00 EUR"
export function firedText(v: ComparisonValue, own: string, l: Listings) {
  const verb = v.op === "<" || v.op === "<=" ? "fell to" : "rose to";
  const at = valueText(v.left.field, v.left.value, v.left.symbol, l);
  const level =
    typeof v.right === "number"
      ? valueText(v.left.field, v.right, v.left.symbol, l)
      : `${target(v.right, v.left, own, l)} (${valueText(v.right.field, v.right.value, v.right.symbol, l)})`;
  return `${subject(v.left, own, l)} ${verb} ${at}, ${OP_WORDS[v.op]} ${level}`;
}

// Today, Yesterday, then the date, in the browser's zone
export function dayLabel(at: string, now: number): string {
  const d = new Date(at);
  const today = new Date(now);
  const start = (x: Date) =>
    new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((start(today) - start(d)) / (24 * 3600 * 1000));
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  return d.toLocaleDateString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    ...(d.getFullYear() !== today.getFullYear() ? { year: "numeric" } : {}),
  });
}

export const timeText = (at: string) =>
  new Date(at).toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
  });
