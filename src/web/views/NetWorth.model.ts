// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// Home's Wealth tab: the band's figures, the net worth line's words and
// path, and the loader's remembered shape, no DOM.

import {
  addressOf,
  type NetWorth,
  PORTFOLIOS_PAGE,
  type Total,
  type Worth,
} from "../data/portfolios.ts";
import { day } from "../lib/format.ts";
import type { GrowthPath } from "./PortfolioGrowth.model.ts";
import { today } from "./Portfolios.model.ts";

export type WorthPoint = { date: string; total: number };

// the line's points, none from a series in another currency than the
// band; today's ends on the band's figure, as a refresh reads only it
export function pointsOf(series: NetWorth | null, t: Total): WorthPoint[] {
  if (series === null || series.currency !== t.currency) return [];
  return series.points.map((p) => ({
    date: p.date,
    total: p.date === series.to && t.net_worth != null ? t.net_worth : p.total,
  }));
}

// a refresh keeps the series through the owner's day: its past days hold
// stored rows that a minute never changes
export const keptSeries = (w: Worth, now = Date.now()): NetWorth | null =>
  w.series !== null && w.series.to === today(w.overview.time_zone ?? null, now)
    ? w.series
    : null;

// the band's total: converted when a currency is, else the first
export const totalOf = (w: Worth): Total | null =>
  w.holdings.converted ?? w.holdings.totals[0] ?? null;

// the day's change as a percent of net worth before it
export function dayPercent(t: Total): number | null {
  const value = t.net_worth ?? null;
  if (value === null || t.day_change === null) return null;
  const before = value - t.day_change;
  return before !== 0 ? (t.day_change / before) * 100 : null;
}

// Cash links to the Cash portfolio, the rest to Portfolios
export function cashHref(w: Worth): string {
  const box = w.overview.portfolios.find((p) => p.cash);
  return box
    ? addressOf({ portfolio: box.id, currency: null })
    : PORTFOLIOS_PAGE;
}

const DAY = 86_400_000;

export type WorthWords = { label: string; title: string };

// under a month the first day, then whole months, then the year
export function worthWords(
  points: readonly WorthPoint[],
  now = Date.now(),
): WorthWords {
  const first = points[0]!.date;
  const days = (Date.parse(points.at(-1)!.date) - Date.parse(first)) / DAY;
  const since = day(first, now);
  return {
    label:
      days >= 365 ? "1Y" : days >= 30 ? `${Math.round(days / 30.44)}M` : since,
    title: `Net worth since ${since}`,
  };
}

// a few tenths of a percent never fill the height: the scale spans at
// least this share of the value, the line centred in it
export const MIN_SPAN = 0.02;

export function worthPath(
  points: readonly WorthPoint[],
  w: number,
  h: number,
): GrowthPath | null {
  const v = points.map((p) => p.total);
  if (v.length < 2) return null;
  const low = Math.min(...v);
  const high = Math.max(...v);
  const pad = Math.max(0, Math.abs(high) * MIN_SPAN - (high - low)) / 2;
  const lo = low - pad;
  const span = high - low + 2 * pad || 1;
  const x = (i: number) => (i / (v.length - 1)) * w;
  const y = (n: number) => 2 + (1 - (n - lo) / span) * (h - 4);
  const line = v
    .map((n, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(n).toFixed(1)}`)
    .join("");
  return { line, area: `${line}L${w},${h}L0,${h}Z`, up: v.at(-1)! >= v[0]! };
}

// the legend items' widths from the last band, in px and never amounts,
// so the loader's items wrap at the same widths as the band's
export const SHAPE_KEY = "markets-networth-legend";
export const SHAPE_GUESS: readonly number[] = [190, 170];

export function shapeOf(raw: string | null): readonly number[] {
  try {
    const v: unknown = JSON.parse(raw ?? "null");
    return Array.isArray(v) &&
      v.length > 0 &&
      v.every((x) => typeof x === "number" && Number.isFinite(x) && x > 0)
      ? v
      : SHAPE_GUESS;
  } catch {
    return SHAPE_GUESS;
  }
}

// whether the person has a Wealth tab: a portfolio and a total to show;
// null until their portfolios are read
export const wealthOf = (w: Worth | null): boolean | null =>
  w === null ? null : w.overview.portfolios.length > 0 && totalOf(w) !== null;
