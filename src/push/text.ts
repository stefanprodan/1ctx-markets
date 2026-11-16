// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// A fired alert as a notification's words, the Alerts page's own.

import { minorUnits } from "../shared/currencies.ts";
import {
  operandText,
  parseWhen,
  type TriggerOn,
  type WhenComparison,
  type WhenOperand,
  whenComparisons,
} from "../shared/when.ts";
import {
  closeName,
  FIELD_WORDS,
  OP_WORDS,
  STATES,
} from "../shared/when-words.ts";

export type Listing = {
  name: string | null;
  type: string;
  currency: string | null;
  unit: string;
};

export type Trigger = {
  symbol: string;
  when: string;
  note: string | null;
  values: Record<string, number | null>;
  on?: TriggerOn;
  session?: string | null;
};

const CRYPTO = "CRYPTOCURRENCY";

// as the page names it: no market, a coin without its quote currency, an
// index without its caret
export function tickerOf(id: string, l?: Listing): string {
  const s = id.slice(id.indexOf(":") + 1);
  const bare =
    l?.type === CRYPTO || id.startsWith("CRYPTO:")
      ? s.replace(/-[A-Z]{3}$/, "")
      : s;
  return bare.replace(/^\^/, "");
}

const round = (v: number, d: number) =>
  Number(v.toFixed(d)).toLocaleString("en-US", { maximumFractionDigits: d });

// in the currency's minor units, as the Alerts page shows it
const price = (v: number, currency: string | null) => {
  const d = currency === null ? 2 : minorUnits(currency);
  const n = v.toLocaleString("en-US", {
    minimumFractionDigits: Math.min(d, 2),
    maximumFractionDigits: d,
  });
  return currency === null ? n : `${n} ${currency}`;
};

function valueText(field: string, v: number | null, l?: Listing): string {
  if (v === null) return "–";
  const unit = FIELD_WORDS[field]?.unit ?? "plain";
  if (unit === "price") {
    if (l?.unit === "index_points") return round(v, 2);
    if (l?.unit === "percent") return `${round(v, 2)}%`;
    return price(v, l?.currency ?? null);
  }
  if (unit === "percent") return `${round(v, 2)}%`;
  if (unit === "points") return `${round(v, 2)} pts`;
  if (unit === "ratio") return `${round(v, 2)}×`;
  if (unit === "atrs") return `${round(v, 2)} ATRs`;
  if (unit === "days") return `${Math.round(v)} days`;
  if (unit === "state") return STATES[field]?.[v] ?? String(v);
  return String(round(v, 1));
}

const VERBS: Record<string, string> = {
  "<": "fell below",
  "<=": "fell to",
  ">": "rose above",
  ">=": "rose to",
};

function subject(o: WhenOperand, own: string, l: Record<string, Listing>) {
  const s = o.symbol ?? own;
  const field =
    o.field === "price" ? "" : ` ${FIELD_WORDS[o.field]?.label ?? o.field}`;
  const bench = o.benchmark
    ? ` vs ${tickerOf(o.benchmark, l[o.benchmark])}`
    : "";
  return `${tickerOf(s, l[s])}${field}${bench}`;
}

// "NVDA fell below 170.00 USD: 168.40 USD", "NVDA RSI below 30: 28.4"
function line(
  c: WhenComparison,
  t: Trigger,
  l: Record<string, Listing>,
): string {
  const own = c.left.symbol ?? t.symbol;
  const value = valueText(
    c.left.field,
    t.values[operandText(c.left)] ?? null,
    l[own],
  );
  const level =
    typeof c.right === "number"
      ? valueText(c.left.field, c.right, l[own])
      : subject(c.right, t.symbol, l);
  const op = c.left.field === "price" ? VERBS[c.op] : OP_WORDS[c.op];
  return `${subject(c.left, t.symbol, l)} ${op} ${level}: ${value}`;
}

const holds = (c: WhenComparison, values: Trigger["values"]) => {
  const left = values[operandText(c.left)];
  const right =
    typeof c.right === "number" ? c.right : values[operandText(c.right)];
  if (left == null || right == null) return false;
  return c.op === "<"
    ? left < right
    : c.op === "<="
      ? left <= right
      : c.op === ">"
        ? left > right
        : left >= right;
};

// title: the symbol's name; body: what held, then the note
export function notification(
  t: Trigger,
  l: Record<string, Listing>,
): { title: string; body: string } {
  const own = l[t.symbol];
  const name =
    own?.name === null || own?.name === undefined
      ? tickerOf(t.symbol, own)
      : own.type === CRYPTO
        ? own.name.replace(/ [A-Z]{3}$/, "")
        : own.name;
  let all: WhenComparison[] = [];
  try {
    all = whenComparisons(parseWhen(t.when));
  } catch {}
  const held = all.filter((c) => holds(c, t.values));
  const lines = (held.length > 0 ? held : all).map((c) => line(c, t, l));
  const close = closeName(t.on, t.session);
  const body = [
    `${close === null ? "" : `At ${close}: `}${lines.join("; ")}`,
    t.note ?? "",
  ].filter((s) => s !== "");
  return { title: name, body: body.join("\n") };
}
