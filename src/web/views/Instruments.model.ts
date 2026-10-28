// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Listed } from "../data/store.ts";

// the symbol as people write it; the market is said on its own
export const symbolOf = (id: string): string => {
  const at = id.indexOf(":");
  return at < 0 ? id : id.slice(at + 1);
};

const KINDS: Record<string, string> = {
  EQUITY: "Stock",
  ETF: "ETF",
  INDEX: "Index",
  BOND: "Bond",
  FUTURE: "Future",
  CRYPTOCURRENCY: "Crypto",
  CURRENCY: "Currency",
  SERIES: "Series",
};

export const kindOf = (kind: string): string =>
  KINDS[kind] ?? kind.charAt(0) + kind.slice(1).toLowerCase();

const decimals = (v: number) => {
  const a = Math.abs(v);
  return a >= 1000 ? 2 : a >= 10 ? 2 : a >= 1 ? 3 : 4;
};

export function price(row: Listed): string {
  if (row.price === null) return "—";
  const d = decimals(row.price);
  const n = row.price.toLocaleString("en-US", {
    minimumFractionDigits: Math.min(d, 2),
    maximumFractionDigits: d,
  });
  if (row.unit === "percent" || row.unit === "percent_of_par") return `${n}%`;
  return row.currency ? `${n} ${row.currency}` : n;
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

// the kind and the market, the market left out where it only repeats
// the kind (Yahoo's crypto market is CRYPTO)
export function about(row: Listed): string {
  const kind = kindOf(row.kind);
  const parts =
    row.market.toLowerCase() === kind.toLowerCase()
      ? [kind]
      : [kind, row.market];
  const end = stopped(row);
  return [...parts, ...(end ? [end] : [])].join(" · ");
}

export function matches(row: Listed, q: string): boolean {
  const t = q.trim().toLowerCase();
  if (t === "") return true;
  return (
    row.id.toLowerCase().includes(t) ||
    (row.name ?? "").toLowerCase().includes(t)
  );
}
