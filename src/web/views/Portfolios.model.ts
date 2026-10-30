// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// The Portfolios page's words and numbers, with no DOM, so they are tested.

import { inCirculation } from "../../shared/currencies.ts";
import type {
  Holding,
  Holdings,
  Part,
  Total,
  TradeRow,
} from "../data/portfolios.ts";
import type { Candidate } from "../data/store.ts";
import { kindOf, symbolOf } from "./Instruments.model.ts";

const decimals = (v: number) => {
  const a = Math.abs(v);
  return a >= 1 ? 2 : a >= 0.01 ? 4 : 6;
};

let iso: Set<string> | null = null;

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

export function price(v: number | null, currency?: string | null): string {
  if (v === null) return "—";
  const d = decimals(v);
  const n = v.toLocaleString("en-US", {
    minimumFractionDigits: Math.min(d, 2),
    maximumFractionDigits: d,
  });
  return currency ? `${n} ${currency}` : n;
}

export function quantity(v: number | null): string {
  if (v === null) return "—";
  return v.toLocaleString("en-US", { maximumFractionDigits: 8 });
}

export type Signed = { text: string; dir: -1 | 0 | 1 };

// a gain or loss with its sign; one that rounds to nothing reads flat
export function change(v: number | null, currency?: string | null): Signed {
  if (v === null) return { text: "", dir: 0 };
  const d = minorUnits(currency);
  const r = Number(v.toFixed(d));
  const dir = r > 0 ? 1 : r < 0 ? -1 : 0;
  const n = amount(Math.abs(r), currency);
  return { text: `${dir > 0 ? "+" : dir < 0 ? "−" : ""}${n}`, dir };
}

export function percent(v: number | null): Signed {
  if (v === null) return { text: "", dir: 0 };
  const n = Math.abs(v).toFixed(2);
  const dir = Number(n) === 0 ? 0 : v > 0 ? 1 : -1;
  return { text: `${dir > 0 ? "+" : dir < 0 ? "−" : ""}${n}%`, dir };
}

// a currency's gain in its own money, the rate's move left out
export function currencyGain(totals: readonly Total[], code: string | null) {
  return percent(totals.find((t) => t.currency === code)?.pl_percent ?? null);
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

// the viewer's own today, as a date field takes it
export function today(now = Date.now()): string {
  const d = new Date(now);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// a typed number: a dot or a lone comma for decimals, spaces and
// thousands commas ignored; null when empty, NaN when not a number
export function typed(text: string): number | null {
  let t = text.trim().replace(/\s+/g, "");
  if (t === "") return null;
  if (!t.includes(".") && /^\d+,\d+$/.test(t)) t = t.replace(",", ".");
  else t = t.replace(/,/g, "");
  return /^\d*\.?\d+$|^\d+\.$/.test(t) ? Number(t) : Number.NaN;
}

export const holdingTitle = (h: Holding): string =>
  h.kind === "holding" && h.id !== null ? symbolOf(h.id) : (h.name ?? "");

export function holdingSub(h: Holding, now = Date.now()): string {
  if (h.kind === "cash") {
    return [
      h.dry_powder ? "Dry powder" : "Reserve",
      h.as_of && day(h.as_of, now),
    ]
      .filter(Boolean)
      .join(" · ");
  }
  if (h.kind === "fund") {
    return h.as_of ? `Fund · priced ${day(h.as_of, now)}` : "Fund";
  }
  if (h.kind === "bond") {
    const parts = [
      "Bond",
      h.coupon != null ? `${h.coupon}%` : null,
      h.maturity ? `until ${day(h.maturity, now)}` : null,
      h.priced === "face" ? "at face" : null,
    ];
    return parts.filter(Boolean).join(" · ");
  }
  return [h.name, kindOf(h.type)].filter(Boolean).join(" · ");
}

// quantity × average cost, as a holding's line under its name
export function costLine(h: Holding): string {
  if (h.kind === "cash") return "";
  if (h.kind === "bond") {
    return h.priced === "listing" ? `${price(h.price)}% of face` : "";
  }
  // a fund shows the NAV it was given
  const each = h.kind === "fund" ? h.price : h.average_cost;
  return `${quantity(h.quantity)} × ${priceOf(each, h.currency, h.unit)}`;
}

export const brokerName = (b: string | null): string => b ?? "No broker";

// where a listing trades, in the source's words else its market, and its
// currency when known
export function listingWords(c: {
  id: string;
  exchange_name?: string;
  currency?: string | null;
}): string {
  const at = c.id.indexOf(":");
  const market = c.exchange_name ?? (at < 0 ? "" : c.id.slice(0, at));
  return [market, c.currency].filter(Boolean).join(" · ");
}

export function enteredBy(by: string): string {
  if (by === "web") return "Web";
  if (by === "admin") return "Admin";
  return by;
}

export function tradeTitle(t: TradeRow): string {
  return `${t.side === "buy" ? "Buy" : "Sell"} ${symbolOf(t.symbol)}`;
}

// a bond's price is a percent of its face, never an amount
const priceOf = (
  v: number | null,
  currency: string,
  unit: string | null | undefined,
): string => (unit === "percent_of_par" ? `${price(v)}%` : price(v, currency));

export function tradeLine(t: TradeRow): string {
  return `${quantity(t.quantity)} × ${priceOf(t.price, t.currency, t.unit)}${
    t.fees > 0 ? ` + ${amount(t.fees)} fees` : ""
  }`;
}

// a phone wraps between facts, never inside one
export const whole = (line: string): string =>
  line
    .split(" · ")
    .map((f) => f.replace(/ /g, "\u00a0"))
    .join(" · ");

export function tradeSub(t: TradeRow, now = Date.now()): string {
  return [
    day(t.date, now),
    t.portfolio,
    t.broker,
    `by ${enteredBy(t.entered_by)}`,
  ]
    .filter(Boolean)
    .join(" · ");
}

// the three parts of a total, each with its share
export function splitOf(t: Total) {
  return [
    {
      key: "invested",
      label: "Invested",
      value: t.invested,
      weight: t.invested_weight,
    },
    { key: "cash", label: "Reserve", value: t.cash, weight: t.cash_weight },
    {
      key: "dry",
      label: "Dry powder",
      value: t.dry_powder,
      weight: t.dry_powder_weight,
    },
  ].filter((p) => (p.value ?? 0) !== 0);
}

// the codes a picker offers: those held, and the display currency
export function currencies(h: Holdings | null): string[] {
  if (h === null) return [];
  const all = new Set(h.totals.map((t) => t.currency));
  if (h.display_currency) all.add(h.display_currency);
  if (h.currency) all.add(h.currency);
  // the server converts only into a currency in circulation
  return [...all].filter(inCirculation).sort();
}

// "1 EUR = 1.25 USD · 14:05", the rate a converted figure used
export function rateLine(
  r: Holdings["rates"][number],
  now = Date.now(),
): string | null {
  if (r.from === r.to) return null;
  if (r.rate === null) return `No ${r.from} to ${r.to} rate`;
  const when =
    r.at === null
      ? ""
      : r.at.length === 10
        ? ` · ${day(r.at, now)}`
        : ` · ${new Date(r.at).toLocaleTimeString("en-GB", {
            hour: "2-digit",
            minute: "2-digit",
          })}`;
  return `1 ${r.from} = ${price(r.rate)} ${r.to}${when}`;
}

// a reason a figure may be out of date, in a few plain words
export function staleWords(reason: string): string {
  if (reason === "sells more than bought") return "Sold more than bought";
  const rate = /^no (\S+) to (\S+) (rate|close)/.exec(reason);
  if (rate) return `No ${rate[1]} rate`;
  if (reason === "no listing currency") return "No currency";
  return "Not current";
}

// what a total left out: a listing by its symbol, a rate in words
export function missingWords(m: string): string {
  if (/^[^\s]+:[^\s]+$/.test(m)) return symbolOf(m);
  const rate = /^no (\S+) to (\S+) (rate|close)/.exec(m);
  if (rate) return `No ${rate[1]} to ${rate[2]} rate`;
  return m;
}

export const EXPOSURE_TABS = [
  { key: "market", label: "Market" },
  { key: "type", label: "Kind" },
  { key: "portfolio", label: "Portfolio" },
  { key: "broker", label: "Broker" },
  { key: "currency", label: "Currency" },
] as const;

export type ExposureTab = (typeof EXPOSURE_TABS)[number]["key"];

const TYPE_WORDS: Record<string, string> = {
  CASH: "Cash",
  FUND: "Fund",
  BOND: "Bond",
};

export function shareLabel(tab: ExposureTab, key: string | null): string {
  if (key === null) {
    return tab === "broker"
      ? "No broker"
      : tab === "market"
        ? "Not listed"
        : "—";
  }
  if (tab === "type") return TYPE_WORDS[key] ?? kindOf(key);
  return key;
}

// what the add form remembers between visits, per browser
export const ADD_KEY = "markets-portfolio-add";

// only the kind: a portfolio or broker carried from the last add files
// the next one wrongly when it is for something else
export type Remembered = {
  kind: "trade" | "cash" | "fund" | "bond";
};

export const FORGOTTEN: Remembered = { kind: "trade" };

export function readRemembered(raw: string | null): Remembered {
  try {
    const v = JSON.parse(raw ?? "null") as Partial<Remembered> | null;
    if (v === null || typeof v !== "object") return FORGOTTEN;
    // saved before a fund was called a fund
    if ((v.kind as string) === "manual") return { kind: "fund" };
    return {
      kind: ["trade", "cash", "fund", "bond"].includes(v.kind as string)
        ? (v.kind as Remembered["kind"])
        : "trade",
    };
  } catch {
    return FORGOTTEN;
  }
}

export const IMPORT_KINDS: Record<string, string> = {
  trades: "Trades",
  cash: "Cash",
  funds: "Funds",
  bonds: "Bonds",
};

const STATUS_WORDS: Record<string, string> = {
  ok: "Ready",
  bad: "Not read",
  skipped: "Skipped",
  saved: "Saved",
};

export const importStatus = (s: string): string => STATUS_WORDS[s] ?? s;

// a row of the preview in a line: what it would save
// the server's advice is for an agent, not the reader
export const importReason = (reason: string): string =>
  reason
    .replace(/; try search\.?$/, "")
    .replace(/: no listing found$/, ": not found");

export function importLine(item: Record<string, unknown> | undefined): string {
  if (item === undefined) return "";
  const n = (k: string) =>
    typeof item[k] === "number" ? (item[k] as number) : null;
  const s = (k: string) =>
    typeof item[k] === "string" ? (item[k] as string) : null;
  if (s("side") !== null) {
    return `${s("side") === "buy" ? "Buy" : "Sell"} ${symbolOf(s("symbol") ?? "")} · ${quantity(n("quantity"))} × ${price(n("price"), s("currency"))}${
      s("date") ? ` · ${day(s("date")!)}` : ""
    }`;
  }
  const what = s("name") ?? "";
  if (s("kind") === "cash")
    return `${what} · ${amount(n("amount"), s("currency"))}`;
  if (s("kind") === "fund") {
    return `${what} · ${quantity(n("units"))} × ${price(n("price"), s("currency"))}`;
  }
  return `${what} · ${amount(n("amount"), s("currency"))}`;
}

// ---- the add panel ---------------------------------------------------------

// what a person buys outright comes before futures, options and the like
const PLAIN = new Set(["EQUITY", "ETF", "MUTUALFUND", "CRYPTOCURRENCY"]);

export const ranked = (found: readonly Candidate[]): Candidate[] =>
  found
    .map((c, i) => ({
      c,
      i,
      r: PLAIN.has((c.type ?? "").toUpperCase()) ? 0 : 1,
    }))
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .map((x) => x.c);

// a trade's money: the gross, plus fees on a buy, less them on a sell; a
// price per hundred of face counts a hundredth
export function tradeMoney(
  side: "buy" | "sell",
  quantity: number,
  price: number,
  fees: number,
  unit: string | null | undefined,
): number {
  const gross = quantity * price * (unit === "percent_of_par" ? 0.01 : 1);
  return side === "buy" ? gross + fees : gross - fees;
}

// an amount in the display currency, by the rate the holdings used
export function shownIn(
  h: Holdings | null,
  value: number,
  currency: string,
): { value: number; currency: string } | null {
  const to = h?.display_currency;
  if (!h || !to || to === currency) return null;
  const r = h.rates.find((x) => x.from === currency && x.to === to);
  return r?.rate == null ? null : { value: value * r.rate, currency: to };
}

// where a listing is held now: each portfolio and broker with its quantity
export const heldAt = (h: Holdings | null, id: string): Part[] =>
  h?.holdings.find((x) => x.kind === "holding" && x.id === id)?.parts ?? [];

export type DryPowder = {
  position: number;
  portfolio: string;
  currency: string;
};

// every dry powder position, each part on its own
export function dryPowders(h: Holdings | null): DryPowder[] {
  return (h?.holdings ?? [])
    .filter((x) => x.kind === "cash" && x.dry_powder)
    .flatMap((x) =>
      x.parts.length > 0
        ? x.parts.flatMap((p) =>
            p.position === undefined
              ? []
              : [
                  {
                    position: p.position,
                    portfolio: p.portfolio,
                    currency: x.currency,
                  },
                ],
          )
        : x.position === null
          ? []
          : [{ position: x.position, portfolio: "", currency: x.currency }],
    );
}

// the dry powder a buy is paid from: its own portfolio's in its currency
// first, then its currency, then its portfolio's, then any
export function dryPowderFor(
  all: readonly DryPowder[],
  portfolio: string | null,
  currency: string | null,
): DryPowder | null {
  const score = (d: DryPowder) =>
    (d.currency === currency ? 2 : 0) + (d.portfolio === portfolio ? 1 : 0);
  return [...all].sort((a, b) => score(b) - score(a))[0] ?? null;
}

// one ranking across currencies by the converted value; a row with no
// rate goes last, and the server's order breaks ties
export function largestFirst(rows: Holding[]): Holding[] {
  const v = (r: Holding) => r.converted?.value ?? null;
  return [...rows].sort((a, b) => {
    const x = v(a);
    const y = v(b);
    if (x === null || y === null)
      return (x === null ? 1 : 0) - (y === null ? 1 : 0);
    return y - x;
  });
}
