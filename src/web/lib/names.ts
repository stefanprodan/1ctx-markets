// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// How an instrument is named on screen, for views and models alike.

const CRYPTO = "CRYPTOCURRENCY";

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
  CRYPTOCURRENCY: "Crypto",
  CURRENCY: "Currency",
  SERIES: "Series",
};

// an instrument's kind in a word; one not listed in its own word
export const kindOf = (kind: string): string =>
  KINDS[kind] ?? kind.charAt(0) + kind.slice(1).toLowerCase();
