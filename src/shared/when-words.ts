// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// The Alerts page's words for when, which a push notification uses too.

import type { WhenOp } from "./when.ts";

export type Unit =
  | "price"
  | "percent"
  | "points"
  | "ratio"
  | "atrs"
  | "days"
  | "plain"
  | "state";

// every field when takes (WHEN_FIELDS in when.ts)
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

export const OP_WORDS: Record<WhenOp, string> = {
  "<": "below",
  "<=": "at or below",
  ">": "above",
  ">=": "at or above",
};
