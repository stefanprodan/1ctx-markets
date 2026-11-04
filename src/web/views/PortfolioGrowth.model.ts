// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// The hero's growth line and the fit of its figure: words, the path and
// where each goes, no DOM.

import type { Growth, Holdings, TradeRow, View } from "../data/portfolios.ts";

// the line's share of the hero's width, and its widest beside the value
export const LINE_SHARE = 0.34;
export const LINE_MAX = 320;
// between the figure's currency and the line beside it
export const LINE_GAP = 16;
// a figure near the edge moving with each quote must not flip the line
// beside and under: it goes back beside only with this much more room
export const FIT_SLACK = 24;
// the smallest the figure shrinks to before it reads short
export const FIT_FLOOR = 20;

export type Fit = {
  line: "beside" | "under";
  // the figure's font size in px, null for the display size
  size: number | null;
  short: boolean;
};

export const FIT_START: Fit = { line: "beside", size: null, short: false };

// widths in px, measured at the display size
export type FitRoom = {
  width: number;
  figure: number;
  // the short form's width
  brief: number;
  currency: number;
  // the line beside, 0 with no line
  line: number;
  display: number;
};

// the figure is never cut, wrapped or rounded unasked: the line gives way
// first, then the font shrinks to a floor, then the figure reads short
export function heroFit(r: FitRoom, last: Fit): Fit {
  const need = r.figure + r.currency;
  const slack = last.line === "beside" ? 0 : FIT_SLACK;
  const beside = r.line > 0 ? need + LINE_GAP + r.line + slack : need;
  if (beside <= r.width) return FIT_START;
  if (need <= r.width) return { line: "under", size: null, short: false };
  const room = r.width - r.currency;
  // even pixels, so a figure a digit longer redraws at most one step
  const size = 2 * Math.floor((r.display * room) / r.figure / 2);
  if (size >= FIT_FLOOR) return { line: "under", size, short: false };
  const brief = Math.min(r.display, Math.floor((r.display * room) / r.brief));
  return { line: "under", size: Math.max(FIT_FLOOR, brief), short: true };
}

export const sameFit = (a: Fit, b: Fit): boolean =>
  a.line === b.line && a.size === b.size && a.short === b.short;

// the line beside the value at a hero this wide
export const lineWidth = (width: number, phone: boolean): number =>
  phone ? width * LINE_SHARE : Math.min(LINE_MAX, width * LINE_SHARE);

const brief = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 2,
});

// past the floor: "9.88T", the full figure in the currency menu
export function shortMoney(v: number | null): string {
  return v === null ? "—" : brief.format(v);
}

// the view and the currency its figures are in: the display currency
// when none is picked, so a new display currency reads again
export function growthScope(v: View, h: Holdings): string {
  return `${v.portfolio ?? "all"} ${v.currency ?? h.display_currency ?? ""}`;
}

// the view's series is read again only when its trades, a fund's hand
// price or a bond's face, cost or date change, never on the minute's
// refresh
export function growthKey(
  v: View,
  trades: readonly TradeRow[],
  h: Holdings,
): string {
  const live = trades
    .filter((t) => t.removed_at === null)
    .map((t) => t.id)
    .join(",");
  const kept = h.holdings
    .flatMap((x) =>
      x.kind === "fund"
        ? [`${x.id}:${x.price}:${x.as_of}`]
        : x.kind === "bond"
          ? [
              `${x.id ?? x.position}:${x.quantity}:${x.cost}:${x.as_of}`,
              ...x.parts.map((p) => `${p.position}:${p.amount}:${p.as_of}`),
            ]
          : [],
    )
    .join(",");
  return `${growthScope(v, h)} ${live} ${kept}`;
}

// the last series drawn and the view and currency it was for
export type Drawn<T = Growth> = { scope: string; series: T };

export type Shown<T = Growth> = {
  series: T | null;
  // a series of the same view and currency, held while the new one is read
  held: boolean;
  // no line and no slot: the read failed or held under two days
  none: boolean;
};

// got: the key's cached series, undefined while read, null when it failed
export function growthShown<T extends { points: readonly unknown[] }>(
  got: T | null | undefined,
  last: Drawn<T> | null,
  scope: string,
): Shown<T> {
  if (got === undefined) {
    const held = last?.scope === scope ? last.series : null;
    return { series: held, held: held !== null, none: false };
  }
  if (got === null) return { series: null, held: false, none: true };
  return { series: got, held: false, none: got.points.length < 2 };
}

// a Cash tab, or a view of cash alone, has no line and no slot for one
export function hasGrowth(h: Holdings, cash: boolean): boolean {
  return !cash && h.holdings.some((x) => x.kind !== "cash");
}

// the Cash tab's line is the person's own cash, never a shared Cash
// portfolio's: net worth is read for the caller alone
export function hasCashLine(
  row: { cash?: boolean } | undefined,
  mine: boolean,
): boolean {
  return mine && row?.cash === true;
}

// the same month and day a year before; 29 Feb falls back to 28 Feb
export function yearBefore(day: string): string {
  const y = Number(day.slice(0, 4)) - 1;
  const md = day.slice(5) === "02-29" ? "02-28" : day.slice(5);
  return `${String(y).padStart(4, "0")}-${md}`;
}

const dayMonth = (d: string): string =>
  new Date(`${d}T00:00:00Z`).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });

export type GrowthWords = { label: string; title: string };

// a view younger than a year is drawn from its first day and says so
export function growthWords(g: Growth): GrowthWords {
  const first = g.points[0]?.date ?? g.from;
  if (first <= yearBefore(g.to))
    return { label: "1Y", title: "Past year growth excluding cash" };
  const days = (Date.parse(g.to) - Date.parse(first)) / 86_400_000;
  const months = Math.max(1, Math.round(days / 30.44));
  return {
    label: `${months}M`,
    title: `Growth since ${dayMonth(first)} excluding cash`,
  };
}

// a day of a hero line: the figure it draws
export type LinePoint = { date: string; value: number };

// end: the last point's height in the box, for where its label goes
export type GrowthPath = {
  line: string;
  area: string;
  up: boolean;
  end: number;
};

// a few tenths of a percent never fill the height: the scale spans at
// least this share of the value drawn against, the line centred in it
export const MIN_SPAN = 0.02;

// the box's own units, stretched to the slot; room for the stroke at the
// top and bottom
export const GROWTH_PAD = 4;
export const WORTH_PAD = 2;

// against: the value the floor is a share of, the points' highest when
// they are that value themselves; the growth line's gain is against the
// view's value
export function linePath(
  points: readonly LinePoint[],
  w: number,
  h: number,
  pad: number,
  against?: number,
): GrowthPath | null {
  const v = points.map((p) => p.value);
  if (v.length < 2) return null;
  const low = Math.min(...v);
  const high = Math.max(...v);
  const floor = Math.abs(against ?? high) * MIN_SPAN;
  const room = Math.max(0, floor - (high - low)) / 2;
  const lo = low - room;
  const span = high - low + 2 * room;
  const x = (i: number) => (i / (v.length - 1)) * w;
  // nothing to scale against: a flat line in the middle, as any other
  const y = (n: number) =>
    span === 0 ? h / 2 : pad + (1 - (n - lo) / span) * (h - 2 * pad);
  const line = v
    .map((n, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(n).toFixed(1)}`)
    .join("");
  return {
    line,
    area: `${line}L${w},${h}L0,${h}Z`,
    up: v.at(-1)! >= v[0]!,
    end: y(v.at(-1)!),
  };
}

// the label sits under the line's end, above it when the line ends in
// the lower half, so it never lies on the line
export const labelOver = (p: GrowthPath, h: number): boolean => p.end > h / 2;

// the growth line draws the gain, its floor a share of the view's value
export function growthPoints(g: Growth): {
  points: LinePoint[];
  against: number | undefined;
} {
  return {
    points: g.points.map((p) => ({ date: p.date, value: p.gain })),
    against: g.points.at(-1)?.value,
  };
}
