// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { symbolHref } from "../app/paths.ts";
import type { Listed, TopHoldings } from "../data/store.ts";
import { day } from "../lib/format.ts";
import type { Weight } from "../ui/Weights.tsx";
import { isFund } from "./Instrument.model.ts";

export type Fund = {
  line: string | null;
  top: Weight[];
  split: {
    title: "Sectors" | "Bond ratings";
    rows: Weight[];
    // US government bonds, which the ratings overlap
    note: string | null;
  } | null;
};

const SECTORS: Record<string, string> = {
  basic_materials: "Basic materials",
  communication_services: "Communication services",
  consumer_cyclical: "Consumer cyclical",
  consumer_defensive: "Consumer defensive",
  energy: "Energy",
  financial_services: "Financial services",
  healthcare: "Healthcare",
  industrials: "Industrials",
  realestate: "Real estate",
  technology: "Technology",
  utilities: "Utilities",
};

const spaced = (key: string): string => {
  const s = key.replaceAll("_", " ");
  return s.charAt(0).toUpperCase() + s.slice(1);
};

export const sectorName = (key: string): string => SECTORS[key] ?? spaced(key);

// the source writes grades in lower case
export function ratingName(key: string): string {
  if (key === "us_government") return "US government";
  if (key === "below_b") return "Below B";
  return /^[a-z]{1,3}$/.test(key) ? key.toUpperCase() : spaced(key);
}

const share = (w: number) => `${w.toFixed(1)}%`;

const pageOf = (h: { id: string | null; symbol: string | null }) => {
  const to = h.id ?? h.symbol;
  return to ? symbolHref(to) : null;
};

function headLine(t: TopHoldings, now: number): string | null {
  const said = [
    t.top_weight_percent != null
      ? `Top ${t.top?.length ?? 0}: ${share(t.top_weight_percent)} of the fund`
      : null,
    // the owner's entry is as of its report's day, not the day it was typed
    t.as_of
      ? `as of ${day(t.as_of, now)}`
      : t.fetched_at
        ? `fetched ${day(t.fetched_at.slice(0, 10), now)}`
        : null,
    (t.stale ?? []).length > 0 ? "not current" : null,
  ].filter((x) => x !== null);
  return said.length > 0 ? said.join(" · ") : null;
}

export function fundOf(
  row: Listed,
  t: TopHoldings | undefined,
  now = Date.now(),
): Fund | null {
  if (!(isFund(row) || row.kind === "FUND") || t === undefined) return null;
  const top = t.top ?? [];
  // a fund the owner prices may hold sectors entered before any rows
  if (top.length === 0 && (t.sectors ?? []).length === 0) {
    return {
      line: t.error
        ? "Could not get its top holdings."
        : "No top holdings listed for this fund.",
      top: [],
      split: null,
    };
  }
  const ratings = t.bond_ratings ?? [];
  const sectors = t.sectors ?? [];
  const split: Fund["split"] =
    ratings.length > 0
      ? {
          title: "Bond ratings",
          rows: ratings.map((r) => ({
            key: r.rating,
            label: ratingName(r.rating),
            weight: r.weight_percent,
          })),
          note:
            t.government_bonds_percent != null
              ? `US government bonds: ${share(t.government_bonds_percent)}`
              : null,
        }
      : sectors.length > 0
        ? {
            title: "Sectors",
            rows: sectors.map((s) => ({
              key: s.sector,
              label: sectorName(s.sector),
              weight: s.weight_percent,
            })),
            // sectors come from a half-year report, older than the rows
            note:
              t.sectors_as_of && t.sectors_as_of !== t.as_of
                ? `As of ${day(t.sectors_as_of, now)}`
                : null,
          }
        : null;
  return {
    line: headLine(t, now),
    top: top.map((h) => ({
      key: String(h.rank),
      label: h.symbol ?? h.name,
      name: h.name,
      href: pageOf(h),
      weight: h.weight_percent,
    })),
    split,
  };
}
