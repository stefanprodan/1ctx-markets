// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// An alert read as words, never as its condition's text: the server's
// field names and reasons stay off the page.

import {
  isWhenComparison,
  operandText,
  parseWhen,
  type WhenComparison,
  type WhenNode,
  type WhenOp,
  type WhenOperand,
  whenComparisons,
} from "../../shared/when.ts";
import type { Alert, Listings, Now, Trigger } from "../data/alerts.ts";
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

// every field when takes (WHEN_FIELDS in src/shared/when.ts)
export const FIELD_WORDS: Record<string, { label: string; unit: Unit }> = {
  price: { label: "Price", unit: "price" },
  previous_close: { label: "Previous close", unit: "price" },
  change_percent: { label: "Day move", unit: "percent" },
  day_high: { label: "Day high", unit: "price" },
  day_low: { label: "Day low", unit: "price" },
  sma50: { label: "50-day average", unit: "price" },
  sma200: { label: "200-day average", unit: "price" },
  ema20: { label: "20-day EMA", unit: "price" },
  cross: { label: "50/200-day cross", unit: "state" },
  cross_edge: { label: "50/200-day cross today", unit: "state" },
  rsi14: { label: "RSI", unit: "plain" },
  macd: { label: "MACD", unit: "price" },
  macd_signal: { label: "MACD signal", unit: "price" },
  macd_histogram: { label: "MACD histogram", unit: "price" },
  macd_turn: { label: "MACD turn", unit: "state" },
  atr14: { label: "Average true range", unit: "price" },
  move_atr: { label: "Move in ATRs", unit: "atrs" },
  volatility20: { label: "20-day volatility", unit: "percent" },
  bollinger_lower: { label: "Lower Bollinger band", unit: "price" },
  high52w: { label: "52-week high", unit: "price" },
  low52w: { label: "52-week low", unit: "price" },
  drawdown: { label: "Drop from high", unit: "percent" },
  from_low: { label: "Rise from low", unit: "percent" },
  days_since_high: { label: "Days since high", unit: "days" },
  volume_ratio: { label: "Volume vs average", unit: "ratio" },
  weekly_sma50: { label: "50-week average", unit: "price" },
  weekly_sma200: { label: "200-week average", unit: "price" },
  weekly_cross: { label: "50/200-week cross", unit: "state" },
  weekly_cross_edge: { label: "50/200-week cross this week", unit: "state" },
  relative_return_1m: { label: "1-month return", unit: "points" },
  relative_return_3m: { label: "3-month return", unit: "points" },
};

const words = (field: string) =>
  FIELD_WORDS[field] ?? { label: field, unit: "plain" as Unit };

export const OP_WORDS: Record<WhenOp, string> = {
  "<": "below",
  "<=": "at or below",
  ">": "above",
  ">=": "at or above",
};

const STATES: Record<string, Record<number, string>> = {
  cross: { 1: "golden", 0: "none", [-1]: "death" },
  weekly_cross: { 1: "golden", 0: "none", [-1]: "death" },
  cross_edge: { 1: "golden", 0: "none", [-1]: "death" },
  weekly_cross_edge: { 1: "golden", 0: "none", [-1]: "death" },
  macd_turn: { 1: "up", 0: "none", [-1]: "down" },
};

// the server renders when from what it stored, so it always parses; an
// unreadable one shows as its text
export function treeOf(when: string): WhenNode | null {
  try {
    return parseWhen(when);
  } catch {
    return null;
  }
}

export const comparisonsOf = (when: string): WhenComparison[] => {
  const n = treeOf(when);
  return n === null ? [] : whenComparisons(n);
};

// an index without Yahoo's caret: VIX, not ^VIX
export const tickerIn = (id: string, l: Listings) =>
  tickerOf(id, l[id]?.type).replace(/^\^/, "");

const symbolOf = (o: WhenOperand, own: string) => o.symbol ?? own;

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

// a field named, with its listing when it is not the alert's own
function subject(o: WhenOperand, own: string, l: Listings): string {
  const w = words(o.field).label;
  const bench = o.benchmark ? ` vs ${tickerIn(o.benchmark, l)}` : "";
  const s = symbolOf(o, own);
  return s === own
    ? `${w}${bench}`
    : `${tickerIn(s, l)}${o.field === "price" ? "" : ` ${w}`}${bench}`;
}

function target(
  right: number | WhenOperand,
  left: WhenOperand,
  own: string,
  l: Listings,
): string {
  if (typeof right === "number") {
    return valueText(left.field, right, symbolOf(left, own), l);
  }
  const s = subject(right, own, l);
  return symbolOf(right, own) === own ? lower(s) : s;
}

// "Price at or below 80.00 EUR", "VIX above 30", "RSI below 30"
export function comparisonText(
  c: WhenComparison,
  own: string,
  l: Listings,
): string {
  return `${subject(c.left, own, l)} ${OP_WORDS[c.op]} ${target(c.right, c.left, own, l)}`;
}

// "Lower Bollinger band" mid-sentence, never "mACD"
const lower = (s: string) =>
  /^[A-Z][a-z]/.test(s) ? s[0]!.toLowerCase() + s.slice(1) : s;

// a line per comparison, with its index in when's order, or a group's
// words leading its lines
export type Line = { text: string; depth: number; at: number | null };

export function conditionLines(n: WhenNode, own: string, l: Listings): Line[] {
  const out: Line[] = [];
  let at = 0;
  const walk = (x: WhenNode, depth: number) => {
    if (isWhenComparison(x)) {
      out.push({ text: comparisonText(x, own, l), depth, at: at++ });
      return;
    }
    const all = "all" in x;
    out.push({ text: all ? "All of" : "Any of", depth, at: null });
    for (const k of all ? x.all : x.any) walk(k, depth + 1);
  };
  walk(n, 0);
  return out;
}

export function gateText(a: Pick<Alert, "after_earnings">, l: Listings) {
  const g = a.after_earnings;
  if (g === undefined) return null;
  return `After ${tickerIn(g.symbol, l)}'s Q${g.fiscal_quarter} ${g.fiscal_year} results`;
}

// the condition on one line, for a row
export function ruleSummary(a: Alert, l: Listings): string {
  const n = treeOf(a.when);
  const gate = gateText(a, l);
  const body =
    n === null
      ? a.when
      : isWhenComparison(n)
        ? comparisonText(n, a.symbol, l)
        : inline(n, a.symbol, l);
  return gate === null ? body : `${gate}: ${lower(body)}`;
}

// a flat group read out, "Price at or below 165.00 EUR and RSI below 40";
// a nested one, or one too long for a row, by its count
const INLINE_MAX = 90;
function inline(n: WhenNode, own: string, l: Listings): string {
  const kids = "all" in n ? n.all : "any" in n ? n.any : [];
  const all = "all" in n;
  if (kids.every(isWhenComparison)) {
    const text = kids
      .map((k, i) => {
        const t = comparisonText(k, own, l);
        return i === 0 ? t : lower(t);
      })
      .join(all ? " and " : " or ");
    if (text.length <= INLINE_MAX) return text;
  }
  return `${all ? "All" : "Any"} of ${whenComparisons(n).length} conditions`;
}

const nowOperand = (n: Now): WhenOperand => ({
  field: n.field,
  symbol: n.symbol ?? null,
  ...(n.benchmark === undefined ? {} : { benchmark: n.benchmark }),
});

// a price as is, any other reading with its name: "RSI 34.5", "VIX 16.82"
export function nowText(n: Now, own: string, l: Listings): string {
  const o = nowOperand(n);
  const text = valueText(n.field, n.value, symbolOf(o, own), l);
  return symbolOf(o, own) === own && words(n.field).unit === "price"
    ? text
    : `${subject(o, own, l)} ${text}`;
}

export type Near = {
  // the server's distance to triggering, in percent, rounded
  distance: number | null;
  // the whole condition is true now, never read from a rounded distance
  met: boolean;
  holds: number;
  of: number;
  // the value shown on the row: the first comparison's left side
  shown: { text: string; field: string } | null;
};

// each comparison's holds combined as when joins them; a missing one
// leaves its group unknown, so never met
export function metOf(a: Pick<Alert, "when" | "now">): boolean {
  const n = treeOf(a.when);
  if (n === null) {
    return a.now.length > 0 && a.now.every((x) => x.holds === true);
  }
  let at = 0;
  const walk = (x: WhenNode): boolean | null => {
    if (isWhenComparison(x)) return a.now[at++]?.holds ?? null;
    const kids = ("all" in x ? x.all : x.any).map(walk);
    const decides = !("all" in x);
    if (kids.includes(decides)) return decides;
    return kids.includes(null) ? null : !decides;
  };
  return walk(n) === true;
}

export function nearOf(a: Alert, l: Listings): Near {
  const first = a.now[0];
  return {
    distance: a.gap_percent,
    met: metOf(a),
    holds: a.now.filter((n) => n.holds === true).length,
    of: a.now.length,
    shown:
      first === undefined
        ? null
        : { text: nowText(first, a.symbol, l), field: first.field },
  };
}

// the other side of a comparison now, named: "200-day average 438.99 USD"
export function rightNow(
  c: WhenComparison,
  n: Now,
  own: string,
  l: Listings,
): string | null {
  if (typeof c.right === "number") return null;
  const name = subject(c.right, own, l);
  const s = symbolOf(c.right, own);
  return `${s === own ? lower(name) : name} ${valueText(c.right.field, n.level, s, l)}`;
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
  fired: "Triggered",
  paused: "Paused",
  split: "Paused by a split",
  earnings: "Waiting for earnings",
  stale: "No fresh price",
  unknown: "Can't check now",
};

const FRESH_PRICE =
  /quote overdue|quote sync failed|no quote|session check failed|no live|no value/;

// the server's state in the page's words; a watched one already met
// triggers at its next quote
export function stateOf(a: Alert): StateKey {
  switch (a.state) {
    case "split_paused":
      return "split";
    case "paused":
      return "paused";
    case "waiting_for_earnings":
      return "earnings";
    case "triggered":
      return "fired";
    case "unknown":
      // a price that did not come in (STALE in src/market/stale.ts); bars
      // or signals still pending are another wait
      return (a.reasons ?? []).some((r) => FRESH_PRICE.test(r))
        ? "stale"
        : "unknown";
    default:
      return metOf(a) ? "holds" : "watching";
  }
}

export const NEAR_PERCENT = 5;
export const WEEK_MS = 7 * 24 * 3600 * 1000;

export type TileKey = "all" | "near" | "fired" | "paused";

// short names fit a phone's filter row; the full name is the hover title
export const TILES: readonly { key: TileKey; name: string; short: string }[] = [
  { key: "all", name: "All alerts", short: "All" },
  {
    key: "near",
    name: `Within ${NEAR_PERCENT}%`,
    short: `Within ${NEAR_PERCENT}%`,
  },
  { key: "fired", name: "Triggered this week", short: "This week" },
  { key: "paused", name: "Paused", short: "Paused" },
];

export function inTile(
  key: TileKey,
  a: Alert,
  triggers: readonly Trigger[],
  now: number,
): boolean {
  const s = stateOf(a);
  if (key === "paused") return s === "paused" || s === "split";
  if (key === "near") {
    const d = a.gap_percent;
    return s !== "paused" && s !== "split" && d !== null && d <= NEAR_PERCENT;
  }
  if (key === "fired") {
    return triggers.some(
      (t) => t.alert_id === a.id && now - Date.parse(t.triggered_at) < WEEK_MS,
    );
  }
  return true;
}

// nearest first, a symbol's alerts together, paused last
export function sortRules(alerts: readonly Alert[]): Alert[] {
  const rank = (a: Alert) => {
    const s = stateOf(a);
    return s === "paused" || s === "split" ? 2 : 0;
  };
  const d = (a: Alert) => a.gap_percent ?? Number.POSITIVE_INFINITY;
  const best = new Map<string, number>();
  for (const a of alerts) {
    if (rank(a) > 0) continue;
    best.set(a.symbol, Math.min(best.get(a.symbol) ?? Infinity, d(a)));
  }
  return [...alerts].sort(
    (a, b) =>
      rank(a) - rank(b) ||
      (best.get(a.symbol) ?? Infinity) - (best.get(b.symbol) ?? Infinity) ||
      a.symbol.localeCompare(b.symbol) ||
      d(a) - d(b) ||
      a.id - b.id,
  );
}

// "Price fell to 79.62 EUR, at or below 80.00 EUR", from what was read
export function firedText(
  c: WhenComparison,
  values: Trigger["values"],
  own: string,
  l: Listings,
) {
  const verb = c.op === "<" || c.op === "<=" ? "fell to" : "rose to";
  const left = symbolOf(c.left, own);
  const at = valueText(
    c.left.field,
    values[operandText(c.left)] ?? null,
    left,
    l,
  );
  const level =
    typeof c.right === "number"
      ? valueText(c.left.field, c.right, left, l)
      : `${target(c.right, c.left, own, l)} (${valueText(c.right.field, values[operandText(c.right)] ?? null, symbolOf(c.right, own), l)})`;
  return `${subject(c.left, own, l)} ${verb} ${at}, ${OP_WORDS[c.op]} ${level}`;
}

// what triggered, a comparison a phrase
export const triggerText = (t: Trigger, l: Listings): string =>
  comparisonsOf(t.when)
    .map((c) => firedText(c, t.values, t.symbol, l))
    .join("; ");

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
