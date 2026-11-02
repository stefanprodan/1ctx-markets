// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Screened, ScreenKey } from "../data/store.ts";
import { type Signed, signedChange } from "../lib/format.ts";
import { kindOf } from "../lib/names.ts";

// a screen's own figure, beside the price and under it on a phone
export type Own = {
  key: "drawdown" | "rsi14";
  head: string;
  text: (v: number) => string;
};

export type ScreenText = {
  key: ScreenKey;
  name: string;
  // one faint line under the card's title: what it keeps
  why: string;
  empty: string;
  // the order its own figure sorts first, as the server's own sort
  order: "asc" | "desc";
  own?: Own;
};

// within a twentieth of a point reads as at the high, not "0.0% below"
export const fromHigh = (v: number): string =>
  v > -0.05 ? "At its high" : `${Math.abs(v).toFixed(1)}% below`;

const FROM_HIGH: Own = { key: "drawdown", head: "From high", text: fromHigh };
const RSI: Own = { key: "rsi14", head: "RSI", text: (v) => v.toFixed(0) };

export const SCREEN_TEXT: readonly ScreenText[] = [
  {
    key: "moves",
    name: "Biggest moves",
    why: "Largest moves today, up or down.",
    empty: "No instrument is kept up to date yet.",
    order: "desc",
  },
  {
    key: "near_high",
    name: "Near the high",
    why: "Within 3% of the year's high.",
    empty: "Nothing is near its high today.",
    order: "desc",
    own: FROM_HIGH,
  },
  {
    key: "off_high",
    name: "Well off the high",
    why: "20% or more below the year's high.",
    empty: "Nothing is 20% or more below its high.",
    order: "asc",
    own: FROM_HIGH,
  },
  {
    key: "oversold",
    name: "Oversold",
    why: "Fallen hard lately: RSI 30 or under.",
    empty: "Nothing is oversold today.",
    order: "asc",
    own: RSI,
  },
  {
    key: "overbought",
    name: "Overbought",
    why: "Risen hard lately: RSI 70 or over.",
    empty: "Nothing is overbought today.",
    order: "desc",
    own: RSI,
  },
];

export const screenText = (key: ScreenKey): ScreenText =>
  SCREEN_TEXT.find((s) => s.key === key) ?? SCREEN_TEXT[0]!;

const KIND_ORDER = [
  "Stock",
  "ETF",
  "Fund",
  "Crypto",
  "Index",
  "Currency",
  "Future",
  "Bond",
  "Series",
];

const PLURAL: Record<string, string> = {
  Stock: "Stocks",
  ETF: "ETFs",
  Fund: "Funds",
  Index: "Indexes",
  Currency: "Currencies",
  Future: "Futures",
  Bond: "Bonds",
};

export type TypeTab = { key: string; label: string; types: string[] };

export const ALL_TYPES: TypeTab = { key: "all", label: "All", types: [] };

// the kinds stored, one tab per word: two kinds said alike (a future and
// Yahoo's other contract of one) are one tab
export function typeTabs(
  kinds: readonly { kind: string; count: number }[],
): TypeTab[] {
  const words = new Map<string, string[]>();
  for (const { kind } of kinds) {
    const word = kindOf(kind);
    words.set(word, [...(words.get(word) ?? []), kind]);
  }
  const rank = (w: string) => {
    const i = KIND_ORDER.indexOf(w);
    return i < 0 ? KIND_ORDER.length : i;
  };
  const tabs = [...words.entries()]
    .sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b))
    .map(([word, types]) => ({
      key: word,
      label: PLURAL[word] ?? word,
      types: [...types].sort(),
    }));
  return [ALL_TYPES, ...tabs];
}

// the tab the asked kinds are, All when none
export const tabOf = (types: readonly string[]): string =>
  types.length === 0 ? ALL_TYPES.key : kindOf(types[0]!);

// a yield's return is a change of its level, in points
export const returnOf = (row: Screened, v: number | null): Signed =>
  signedChange(v, { points: row.unit === "percent" });

export const TREND: Record<NonNullable<Screened["trend"]>, string> = {
  up: "Uptrend",
  down: "Downtrend",
  mixed: "Mixed",
};
