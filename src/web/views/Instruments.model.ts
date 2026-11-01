// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Listed } from "../data/store.ts";
import { kindOf, marketOf, symbolOf } from "../lib/names.ts";

// by the symbol people know, the market breaking a tie
// and an index's ^ ignored, so ^GSPC files under G
const sortKey = (id: string) => symbolOf(id).replace(/^\^/, "");
export const bySymbol = (a: Listed, b: Listed): number =>
  sortKey(a.id).localeCompare(sortKey(b.id)) || a.id.localeCompare(b.id);

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
