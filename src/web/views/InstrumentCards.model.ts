// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Detail, Returns } from "../data/store.ts";
import { price, type Signed, signedChange, volumeText } from "../lib/format.ts";
import { tradesToday } from "./Instrument.model.ts";

export type Tone = "up" | "down" | null;
export type Fact = {
  label: string;
  value: string;
  note?: string;
  tone?: Tone;
};
export type Span = { low: string; high: string; at: number };
export type Gauge = { span: Span | null; facts: Fact[] };

// each null or empty when the quote has nothing for it, so its card goes
export type Signals = {
  returns: { label: string; value: Signed }[] | null;
  range: Gauge | null;
  session: (Gauge & { today: boolean }) | null;
  trend: Fact[];
};

export const RETURNS: readonly { key: keyof Returns; label: string }[] = [
  { key: "1w", label: "1 week" },
  { key: "1m", label: "1 month" },
  { key: "3m", label: "3 months" },
  { key: "ytd", label: "Year to date" },
];

const pct = (v: number) => `${Math.abs(v).toFixed(2)}%`;
const toneOf = (v: number): Tone => (v > 0 ? "up" : v < 0 ? "down" : null);
const priceOf = (d: Detail, v: number) => price({ ...d.instrument, price: v });
// a yield moves in points, as the head's move does
const inPoints = (d: Detail) => d.instrument.unit === "percent";
const pointsOf = (v: number) => `${Math.abs(v).toFixed(2)} pts`;
const flat = (v: number) => Number(Math.abs(v).toFixed(2)) === 0;

function span(
  d: Detail,
  low: number | null,
  high: number | null,
  now: number | null,
): Span | null {
  if (low === null || high === null || now === null || high <= low) return null;
  const at = Math.min(1, Math.max(0, (now - low) / (high - low)));
  return { low: priceOf(d, low), high: priceOf(d, high), at };
}

function besideAverage(
  d: Detail,
  label: string,
  avg: number | null | undefined,
  now: number | null,
): Fact | null {
  if (avg == null || avg === 0 || now === null) return null;
  const by = inPoints(d) ? now - avg : ((now - avg) / Math.abs(avg)) * 100;
  const side = flat(by)
    ? "at it"
    : `${inPoints(d) ? pointsOf(by) : pct(by)} ${by > 0 ? "above" : "below"}`;
  return {
    label,
    value: side,
    note: priceOf(d, avg),
    tone: flat(by) ? null : toneOf(by),
  };
}

function rsiWord(v: number): string {
  if (v >= 70) return "overbought";
  if (v <= 30) return "oversold";
  return "neutral";
}

const sessionsAgo = (n: number) =>
  n === 0 ? "today" : `${n} trading ${n === 1 ? "day" : "days"} ago`;

function rangeOf(d: Detail, now: number | null): Gauge | null {
  const s = d.quote?.signals?.daily ?? null;
  if (s === null) return null;
  const facts: Fact[] = [];
  if (s.drawdown !== null) {
    const at = flat(s.drawdown);
    facts.push({
      label: "From the high",
      value: at ? "at the high" : `${pct(s.drawdown)} below`,
      note:
        s.days_since_high === null ? undefined : sessionsAgo(s.days_since_high),
      tone: at ? null : "down",
    });
  }
  if (s.from_low !== null) {
    const at = flat(s.from_low);
    facts.push({
      label: "From the low",
      value: at ? "at the low" : `${pct(s.from_low)} above`,
      tone: at ? null : "up",
    });
  }
  const bar = span(d, s.low52w, s.high52w, now);
  return bar || facts.length > 0 ? { span: bar, facts } : null;
}

function sessionOf(
  d: Detail,
  now: number | null,
): (Gauge & { today: boolean }) | null {
  const q = d.quote;
  const s = q?.signals?.daily ?? null;
  const today = tradesToday(d);
  const facts: Fact[] = [];
  if (q?.volume) {
    const ratio = s?.volume_ratio ?? null;
    facts.push({
      label: today ? "Volume so far" : "Volume",
      value: volumeText(q.volume),
      note:
        ratio === null ? undefined : `${ratio.toFixed(2)}× the 20-day average`,
    });
  }
  if (s?.volatility20 != null) {
    facts.push({
      label: "Typical daily move",
      value: `${s.volatility20.toFixed(2)}%`,
      note: "over 20 days",
    });
  }
  if (s?.atr14 != null) {
    const pts = inPoints(d) || d.instrument.unit === "percent_of_par";
    facts.push({
      label: "Average daily range",
      value: pts ? pointsOf(s.atr14) : priceOf(d, s.atr14),
      note: "over 14 days",
    });
  }
  const bar = span(d, q?.day_low ?? null, q?.day_high ?? null, now);
  return bar || facts.length > 0 ? { span: bar, facts, today } : null;
}

function trendOf(d: Detail, now: number | null): Fact[] {
  const s = d.quote?.signals?.daily ?? null;
  if (s === null) return [];
  const facts = [
    besideAverage(d, "50-day average", s.sma50, now),
    besideAverage(d, "200-day average", s.sma200, now),
    besideAverage(d, "200-week average", d.quote?.signals?.weekly?.sma200, now),
  ].filter((f): f is Fact => f !== null);
  if (s.cross !== null && s.cross !== 0) {
    const above = s.cross > 0;
    // the cross is news only on its day; after it, the side says it
    facts.push({
      label: "50-day vs 200-day",
      value: above ? "above" : "below",
      note: s.cross_edge
        ? `${above ? "golden" : "death"} cross today`
        : undefined,
      tone: above ? "up" : "down",
    });
  }
  if (s.rsi14 !== null) {
    facts.push({
      label: "RSI 14",
      value: s.rsi14.toFixed(1),
      note: rsiWord(s.rsi14),
    });
  }
  if (s.macd_histogram !== null) {
    // a turn is the histogram's direction changing, which can come on
    // either side, so it is only the day's note beside the side
    const h = s.macd_histogram;
    const turn = s.macd_turn ?? 0;
    facts.push({
      label: "Momentum",
      value: h > 0 ? "upward" : h < 0 ? "downward" : "flat",
      note:
        turn > 0
          ? "turning up today"
          : turn < 0
            ? "turning down today"
            : undefined,
      tone: h > 0 ? "up" : h < 0 ? "down" : null,
    });
  }
  return facts;
}

export function signalsOf(d: Detail): Signals {
  const q = d.quote;
  const now = q?.price ?? q?.observation?.value ?? d.instrument.price;
  const r = q?.returns ?? null;
  const points = inPoints(d);
  return {
    returns:
      r === null
        ? null
        : RETURNS.map((x) => ({
            label: x.label,
            value: signedChange(r[x.key] as number | null, {
              empty: "—",
              points,
            }),
          })),
    range: rangeOf(d, now),
    session: sessionOf(d, now),
    trend: trendOf(d, now),
  };
}
