// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// Words and numbers more than one page writes, so they read alike.

// a change as text, its sign already written, and which way it went
export type Signed = { text: string; dir: -1 | 0 | 1 };

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

let iso: Set<string> | null = null;

export function figure(v: number | null): string {
  if (v === null) return "—";
  const a = Math.abs(v);
  const d = a >= 10 ? 2 : a >= 1 ? 3 : 4;
  return v.toLocaleString("en-US", {
    minimumFractionDigits: Math.min(d, 2),
    maximumFractionDigits: d,
  });
}

export function volumeText(v: number | null): string {
  if (v === null) return "—";
  if (v >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
  return String(v);
}

// not the store's Listed: the store imports this file through the chart
type Priced = { price: number | null; unit: string; currency: string | null };

// the figure and the currency apart, for a view that sets the currency
// small beside it; a percent keeps its sign in the figure
export function priceParts(row: Priced): {
  value: string;
  currency: string | null;
} {
  if (row.price === null) return { value: "—", currency: null };
  const n = figure(row.price);
  if (row.unit === "percent" || row.unit === "percent_of_par")
    return { value: `${n}%`, currency: null };
  return { value: n, currency: row.currency };
}

export function price(row: Priced): string {
  const p = priceParts(row);
  return p.currency ? `${p.value} ${p.currency}` : p.value;
}

// a move that rounds to nothing reads flat, never "−0.00%"
export function change(row: { change_percent: number | null }): Signed {
  if (row.change_percent === null) return { text: "", dir: 0 };
  const n = Math.abs(row.change_percent).toFixed(2);
  const p = Number(n) === 0 ? 0 : row.change_percent;
  const dir = p > 0 ? 1 : p < 0 ? -1 : 0;
  return { text: `${dir > 0 ? "+" : dir < 0 ? "−" : ""}${n}%`, dir };
}

// a currency's minor units (JPY 0, KWD 3), 2 when unknown; a coin's 8
export function minorUnits(currency?: string | null): number {
  if (!currency) return 2;
  const code = currency.toUpperCase();
  try {
    iso ??= new Set(Intl.supportedValuesOf("currency"));
    if (!iso.has(code)) return 8;
    return (
      new Intl.NumberFormat("en", {
        style: "currency",
        currency: code,
      }).resolvedOptions().maximumFractionDigits ?? 2
    );
  } catch {
    return 2;
  }
}

// in the currency's minor units; bare leaves the code off
export function amount(
  v: number | null,
  currency?: string | null,
  bare = false,
): string {
  if (v === null) return "—";
  const d = minorUnits(currency);
  const n = v.toLocaleString("en-US", {
    minimumFractionDigits: Math.min(d, 2),
    maximumFractionDigits: d,
  });
  const signed = v < 0 ? `−${n.slice(1)}` : n;
  return currency && !bare ? `${signed} ${currency}` : signed;
}

// a gain or loss with its sign; one that rounds to nothing reads flat
export function signedAmount(
  v: number | null,
  currency?: string | null,
): Signed {
  if (v === null) return { text: "", dir: 0 };
  const d = minorUnits(currency);
  const r = Number(v.toFixed(d));
  const dir = r > 0 ? 1 : r < 0 ? -1 : 0;
  const n = amount(Math.abs(r), currency);
  return { text: `${dir > 0 ? "+" : dir < 0 ? "−" : ""}${n}`, dir };
}

// whole units at a glance; cents only where the figure is small
export function money(v: number | null, currency?: string | null): string {
  if (v === null) return "—";
  const a = Math.abs(v);
  if (a < 1000) return amount(v, currency);
  const n = Math.round(a).toLocaleString("en-US");
  return `${v < 0 ? "−" : ""}${n}${currency ? ` ${currency}` : ""}`;
}

export function signedMoney(
  v: number | null,
  currency?: string | null,
): Signed {
  if (v === null) return { text: "", dir: 0 };
  if (Math.abs(v) < 1000) return signedAmount(v, currency);
  const r = Math.round(v);
  const dir = r > 0 ? 1 : r < 0 ? -1 : 0;
  return {
    text: `${dir > 0 ? "+" : dir < 0 ? "−" : ""}${money(Math.abs(r), currency)}`,
    dir,
  };
}

export const percent = (v: number | null): Signed => signedChange(v);

export function quantity(v: number | null): string {
  if (v === null) return "—";
  return v.toLocaleString("en-US", { maximumFractionDigits: 8 });
}

// a glance, not a ledger, but a fraction of a coin keeps its digits
export function briefQuantity(v: number | null): string {
  if (v === null) return "—";
  return Math.abs(v) >= 1
    ? v.toLocaleString("en-US", { maximumFractionDigits: 2 })
    : v.toLocaleString("en-US", { maximumSignificantDigits: 4 });
}

// "5 Jan", the year only when it is not this one
export function day(date: string, now = Date.now()): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const at = new Date(y, m - 1, d);
  const year = y !== new Date(now).getFullYear();
  return at.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    ...(year ? { year: "numeric" } : {}),
  });
}

// the server's times are UTC; an operator reads them as a distance from now
export function ago(at: string | null, now: number): string {
  if (at === null) return "never";
  const ms = now - Date.parse(at);
  if (!Number.isFinite(ms)) return "unknown";
  if (ms < MINUTE) return "just now";
  if (ms < HOUR) return `${Math.floor(ms / MINUTE)} min ago`;
  if (ms < DAY) return `${Math.floor(ms / HOUR)} h ago`;
  return `${Math.floor(ms / DAY)} d ago`;
}

// the server's error phrases, as someone who runs it reads them
const PLAIN: Record<string, string> = {
  "rate limited": "too many requests",
  "not found": "not found",
  "bad request": "request refused",
  "source error": "the source failed",
  "network error": "no connection",
  "timed out": "no answer in time",
  "malformed answer": "answer not readable",
  "key refused": "key not accepted",
  // a --track value's read
  timeout: "no answer in time",
  candidates: "several matches",
  "no data": "no data",
  refused: "not supported",
  failed: "failed",
};

export function plain(error: string | null): string {
  if (error === null) return "failed";
  const phrase = Object.keys(PLAIN).find((p) => error.startsWith(p));
  if (phrase === undefined) return error;
  // a run some symbols failed names them after its phrase: "source error: AMD"
  const who = /^: (.+)$/.exec(error.slice(phrase.length))?.[1];
  return who ? `${who}: ${PLAIN[phrase]!}` : PLAIN[phrase]!;
}

// a series that is itself a percent (a yield) changes in points; flat
// is what rounds to zero, unsigned
export function signedChange(
  v: number | null,
  { empty = "", points = false }: { empty?: string; points?: boolean } = {},
): Signed {
  if (v === null) return { text: empty, dir: 0 };
  const n = Math.abs(v).toFixed(2);
  const dir = Number(n) === 0 ? 0 : v > 0 ? 1 : -1;
  const sign = dir > 0 ? "+" : dir < 0 ? "−" : "";
  return { text: `${sign}${n}${points ? " pts" : "%"}`, dir };
}
