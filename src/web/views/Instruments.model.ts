// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Listed } from "../data/store.ts";
import { kindOf } from "../lib/names.ts";

// the symbol as people write it; the market is said on its own
export const symbolOf = (id: string): string => {
  const at = id.indexOf(":");
  return at < 0 ? id : id.slice(at + 1);
};

const decimals = (v: number) => {
  const a = Math.abs(v);
  return a >= 1000 ? 2 : a >= 10 ? 2 : a >= 1 ? 3 : 4;
};

// the figure and the currency apart, for a view that sets the currency
// small beside it; a percent keeps its sign in the figure
export function priceParts(row: Listed): {
  value: string;
  currency: string | null;
} {
  if (row.price === null) return { value: "—", currency: null };
  const d = decimals(row.price);
  const n = row.price.toLocaleString("en-US", {
    minimumFractionDigits: Math.min(d, 2),
    maximumFractionDigits: d,
  });
  if (row.unit === "percent" || row.unit === "percent_of_par")
    return { value: `${n}%`, currency: null };
  return { value: n, currency: row.currency };
}

export function price(row: Listed): string {
  const p = priceParts(row);
  return p.currency ? `${p.value} ${p.currency}` : p.value;
}

export function change(row: Listed): { text: string; dir: -1 | 0 | 1 } {
  if (row.change_percent === null) return { text: "", dir: 0 };
  // a move that rounds to nothing reads flat, never "−0.00%"
  const n = Math.abs(row.change_percent).toFixed(2);
  const p = Number(n) === 0 ? 0 : row.change_percent;
  const dir = p > 0 ? 1 : p < 0 ? -1 : 0;
  return { text: `${dir > 0 ? "+" : dir < 0 ? "−" : ""}${n}%`, dir };
}

// said only when it stopped: an instrument kept up to date is the norm
export const stopped = (row: Listed): string | null =>
  row.tracked ? null : "No longer updated";

// by the symbol people know, the market breaking a tie
// and an index's ^ ignored, so ^GSPC files under G
const sortKey = (id: string) => symbolOf(id).replace(/^\^/, "");
export const bySymbol = (a: Listed, b: Listed): number =>
  sortKey(a.id).localeCompare(sortKey(b.id)) || a.id.localeCompare(b.id);

// the market, blank where it only repeats the kind (Yahoo's crypto
// market is CRYPTO)
export const marketOf = (row: Pick<Listed, "kind" | "market">): string =>
  row.market.toLowerCase() === kindOf(row.kind).toLowerCase() ? "" : row.market;

export function about(row: Listed): string {
  const end = stopped(row);
  return [kindOf(row.kind), marketOf(row), end].filter(Boolean).join(" · ");
}

export type SortKey = "symbol" | "kind" | "market" | "change";

// the list's order: by symbol unless a column head asks; a tie, and a
// row with nothing to sort on, falls back to the symbol
export function sortRows(
  rows: readonly Listed[],
  key: SortKey,
  dir: "asc" | "desc",
): Listed[] {
  const sign = dir === "asc" ? 1 : -1;
  const by = (a: Listed, b: Listed): number => {
    if (key === "kind")
      return sign * kindOf(a.kind).localeCompare(kindOf(b.kind));
    if (key === "market") return sign * marketOf(a).localeCompare(marketOf(b));
    if (key === "change") {
      if (a.change_percent === null || b.change_percent === null)
        return (
          (a.change_percent === null ? 1 : 0) -
          (b.change_percent === null ? 1 : 0)
        );
      return sign * (a.change_percent - b.change_percent);
    }
    return sign * bySymbol(a, b);
  };
  return [...rows].sort((a, b) => by(a, b) || bySymbol(a, b));
}

export function matches(row: Listed, q: string): boolean {
  const t = q.trim().toLowerCase();
  if (t === "") return true;
  return (
    row.id.toLowerCase().includes(t) ||
    (row.name ?? "").toLowerCase().includes(t)
  );
}
