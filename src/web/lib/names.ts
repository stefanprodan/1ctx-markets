// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// How an instrument is named on screen, for views and models alike.

import type { Listed } from "../data/store.ts";

const CRYPTO = "CRYPTOCURRENCY";

// the market is said on its own
export const symbolOf = (id: string): string => {
  const at = id.indexOf(":");
  return at < 0 ? id : id.slice(at + 1);
};

// the symbol as people write it, without its market; a coin without the
// currency it is quoted in (BTC, not BTC-USD)
export function tickerOf(id: string, type?: string | null): string {
  const s = id.slice(id.indexOf(":") + 1);
  return type === CRYPTO || id.startsWith("CRYPTO:")
    ? s.replace(/-[A-Z]{3}$/, "")
    : s;
}

// a coin without its quote currency (Bitcoin, not Bitcoin USD)
export function nameOf(
  name: string | null,
  type?: string | null,
  id?: string,
): string {
  if (name === null) return "";
  return type === CRYPTO || id?.startsWith("CRYPTO:") === true
    ? name.replace(/ [A-Z]{3}$/, "")
    : name;
}

const KINDS: Record<string, string> = {
  EQUITY: "Stock",
  ETF: "ETF",
  INDEX: "Index",
  BOND: "Bond",
  FUTURE: "Future",
  // Yahoo's type for another contract of a future, such as a micro one
  ALTSYMBOL: "Future",
  CRYPTOCURRENCY: "Crypto",
  CURRENCY: "Currency",
  SERIES: "Series",
};

// an instrument's kind in a word; one not listed in its own word
export const kindOf = (kind: string): string =>
  KINDS[kind] ?? kind.charAt(0) + kind.slice(1).toLowerCase();

// said only when it stopped: an instrument kept up to date is the norm
// a fund the owner prices is never fetched, so never stops
export const stopped = (row: Listed): string | null =>
  row.tracked || row.id.startsWith("fund:") ? null : "No longer updated";

// blank where it only repeats the kind (Yahoo's crypto market is CRYPTO)
export const marketOf = (row: Pick<Listed, "kind" | "market">): string =>
  row.market.toLowerCase() === kindOf(row.kind).toLowerCase() ? "" : row.market;

export function about(row: Listed): string {
  return [kindOf(row.kind), marketOf(row), stopped(row)]
    .filter(Boolean)
    .join(" · ");
}
