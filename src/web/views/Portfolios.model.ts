// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// The Portfolios page's words and numbers, with no DOM, so they are tested.

import { inCirculation } from "../../shared/currencies.ts";
import { symbolHref } from "../app/paths.ts";
import type {
  Holding,
  Holdings,
  Part,
  PositionChange,
  Total,
  TradeRow,
} from "../data/portfolios.ts";
import type { Candidate } from "../data/store.ts";
import { amount, day, quantity } from "../lib/format.ts";
import { nameOf, symbolOf, tickerOf } from "../lib/names.ts";

const decimals = (v: number) => {
  const a = Math.abs(v);
  return a >= 1 ? 2 : a >= 0.01 ? 4 : 6;
};

export function price(v: number | null, currency?: string | null): string {
  if (v === null) return "—";
  const d = decimals(v);
  const n = v.toLocaleString("en-US", {
    minimumFractionDigits: Math.min(d, 2),
    maximumFractionDigits: d,
  });
  return currency ? `${n} ${currency}` : n;
}

// the owner's today, as a date field takes it: the date in their zone,
// the UTC day until they name one, as the server dates a position
export function today(zone: string | null, now = Date.now()): string {
  const p: Record<string, string> = {};
  for (const x of new Intl.DateTimeFormat("en-US", {
    timeZone: zone ?? "UTC",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now)) {
    p[x.type] = x.value;
  }
  return `${p.year}-${p.month}-${p.day}`;
}

// every zone the browser knows, UTC among them
export function zones(): string[] {
  const all = Intl.supportedValuesOf("timeZone");
  return all.includes("UTC") ? all : ["UTC", ...all];
}

// "Europe/Bucharest" as "Bucharest" in "Europe"
export function zoneWords(zone: string): { city: string; area: string } {
  const at = zone.lastIndexOf("/");
  const words = (t: string) => t.replace(/_/g, " ");
  return at < 0
    ? { city: words(zone), area: "" }
    : { city: words(zone.slice(at + 1)), area: words(zone.slice(0, at)) };
}

// zones whose city or area holds every word typed, cities first
export function findZones(query: string, all = zones()): string[] {
  const q = query.trim().toLowerCase().replace(/_/g, " ");
  if (q === "") return all;
  const terms = q.split(/[\s/]+/).filter((t) => t !== "");
  const scored = all.flatMap((z) => {
    const { city, area } = zoneWords(z);
    const text = `${area} ${city}`.toLowerCase();
    if (!terms.every((t) => text.includes(t))) return [];
    return [{ z, first: city.toLowerCase().startsWith(terms[0]!) ? 0 : 1 }];
  });
  return scored.sort((a, b) => a.first - b.first).map((x) => x.z);
}

// the browser's own zone, offered for the owner to confirm, never saved
// unasked
export function browserZone(): string | null {
  try {
    return new Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
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

// a login writes as its person's name, so the reader's own reads "You";
// "web" is an older login's, before people signed in
export function enteredBy(by: string, self: string | null = null): string {
  if (self !== null && by === self) return "You";
  if (by === "web") return "Web";
  if (by === "admin") return "Admin";
  return by;
}

// a fund by its name, which its owner knows it by, never its ISIN; a
// coin without its quote currency
export const tradeName = (t: TradeRow): string =>
  isFundId(t.symbol) ? (t.name ?? symbolOf(t.symbol)) : tickerOf(t.symbol);

export const isFundId = (id: string): boolean => id.startsWith("fund:");

// a bond's price is a percent of its face, never an amount
export const unitPrice = (
  v: number | null,
  currency: string | null,
  unit: string | null | undefined,
): string => (unit === "percent_of_par" ? `${price(v)}%` : price(v, currency));

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
  h?.holdings.find(
    (x) => (x.kind === "holding" || x.kind === "fund") && x.id === id,
  )?.parts ?? [];

// where more of a holding goes: a portfolio or broker every part shares,
// each left out when the parts differ, so the owner picks it
export function heldWhere(parts: Part[]): {
  portfolio?: string;
  broker?: string | null;
} {
  if (parts.length === 0) return {};
  const ps = new Set(parts.map((p) => p.portfolio));
  const bs = new Set(parts.map((p) => p.broker ?? null));
  return {
    ...(ps.size === 1 ? { portfolio: parts[0]!.portfolio } : {}),
    ...(bs.size === 1 ? { broker: parts[0]!.broker ?? null } : {}),
  };
}

// parts at several brokers: more goes where the last trade went, among
// the places still held and in the portfolio picked
export function lastBroker(
  trades: TradeRow[],
  parts: Part[],
  portfolio?: string,
): string | null | undefined {
  const held = new Set(
    parts
      .filter((p) => portfolio === undefined || p.portfolio === portfolio)
      .map((p) => `${p.portfolio}\u0000${p.broker ?? ""}`),
  );
  let last: TradeRow | undefined;
  for (const t of trades) {
    if (t.removed_at !== null) continue;
    if (!held.has(`${t.portfolio}\u0000${t.broker ?? ""}`)) continue;
    if (
      last === undefined ||
      t.date > last.date ||
      (t.date === last.date && t.id > last.id)
    ) {
      last = t;
    }
  }
  return last === undefined ? undefined : last.broker;
}

export type DryPowder = {
  position: number;
  name: string;
  broker: string | null;
  currency: string;
};

// every dry powder row, each part on its own; all of it lives in Cash
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
                    name: x.name ?? "",
                    broker: p.broker,
                    currency: x.currency,
                  },
                ],
          )
        : x.position === null
          ? []
          : [
              {
                position: x.position,
                name: x.name ?? "",
                broker: null,
                currency: x.currency,
              },
            ],
    );
}

// a buy pays from the dry powder at its broker in its currency, else in its currency
export function dryPowderFor(
  all: readonly DryPowder[],
  broker: string | null,
  currency: string | null,
): { pick: DryPowder | null; choices: DryPowder[] } {
  const same = all.filter((d) => d.currency === currency);
  const here = same.filter(
    (d) =>
      broker !== null &&
      d.broker !== null &&
      d.broker.toLowerCase() === broker.toLowerCase(),
  );
  const pick =
    here.length === 1 ? here[0]! : same.length === 1 ? same[0]! : null;
  return {
    pick,
    choices: pick
      ? [pick]
      : here.length > 1
        ? here
        : same.length > 0
          ? same
          : [...all],
  };
}

// a menu line per row; a name two rows share adds the broker
export function payFromLabel(d: DryPowder, choices: readonly DryPowder[]) {
  const shared = choices.some(
    (x) => x.position !== d.position && x.name === d.name,
  );
  return `Pay from ${d.name}${shared ? ` · ${d.broker ?? d.currency}` : ""}`;
}

// every word typed matches some field, so "nvda xtb" finds NVDA at XTB
const has = (q: string, ...fields: (string | null | undefined)[]) => {
  const text = fields.map((f) => (f ?? "").toLowerCase());
  return q
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w !== "")
    .every((w) => text.some((f) => f.includes(w)));
};

export const holdingMatches = (h: Holding, q: string): boolean =>
  has(
    q,
    holdingTicker(h),
    h.name,
    h.isin,
    h.kind === "cash" ? h.note : null,
    ...h.parts.map((p) => p.broker),
  );

// All's value leaves reserve out, so its rows show only in their portfolio
export const isReserve = (h: Holding): boolean =>
  h.kind === "cash" && h.dry_powder !== true;

export const cashWord = (h: Holding): string =>
  h.dry_powder ? "Dry powder" : "Reserve";

export const tradeMatches = (t: TradeRow, q: string): boolean =>
  has(q, t.side, symbolOf(t.symbol), t.name, t.broker, t.note);

// ---- the page: value band, holdings, activity -----------------------------

const KINDS: Record<string, string> = {
  EQUITY: "Stocks",
  ETF: "ETFs",
  FUND: "Funds",
  MUTUALFUND: "Funds",
  BOND: "Bonds",
  CASH: "Cash",
  CRYPTOCURRENCY: "Crypto",
  INDEX: "Indices",
};

export const kindName = (t: string | null): string =>
  t === null ? "Other" : (KINDS[t] ?? t.charAt(0) + t.slice(1).toLowerCase());

// what a row is called: cash, a hand-priced fund and a bond with no
// symbol by their names, anything listed by its ticker
export function holdingTicker(h: Holding): string {
  if (h.kind === "cash") return h.name ?? "Cash";
  if (h.id === null || isFundId(h.id)) return h.name ?? "—";
  return tickerOf(h.id, h.type);
}

// a new amount goes with the date shown; a name, broker or note edit keeps the date
export function figureEdits(
  h: Holding,
  edited: { amount: number; date: string },
): Pick<PositionChange, "amount" | "date"> {
  const p = h.parts[0];
  if (edited.amount !== (p?.amount ?? null)) {
    return { amount: edited.amount, date: edited.date };
  }
  return edited.date !== (p?.as_of ?? h.as_of ?? "")
    ? { date: edited.date }
    : {};
}

// a new balance is true today, so a changed amount moves an untouched date
export function cashDate(
  h: Holding,
  amount: number | null,
  today: string,
): string {
  const p = h.parts[0];
  return amount !== null &&
    !Number.isNaN(amount) &&
    amount !== (p?.amount ?? null)
    ? today
    : (p?.as_of ?? h.as_of ?? today);
}

// "" takes the broker off
export function brokerEdit(
  h: Holding,
  broker: string,
): Pick<PositionChange, "broker"> {
  return broker !== (h.parts[0]?.broker ?? "")
    ? { broker: broker === "" ? null : broker }
    : {};
}

// "" takes the note off
export function noteEdit(
  h: Holding,
  note: string,
): Pick<PositionChange, "note"> {
  const n = note.trim();
  return n !== (h.note ?? "") ? { note: n === "" ? null : n } : {};
}

// only what differs is sent; null takes a broker or a note off
export function cashEdits(
  h: Holding,
  edited: {
    name: string;
    broker: string;
    note: string;
    // "" takes it off
    maturity?: string;
    dry?: boolean;
  },
): Pick<
  PositionChange,
  "name" | "broker" | "note" | "maturity" | "dry_powder"
> {
  const name = edited.name.trim();
  const maturity = edited.maturity ?? h.maturity ?? "";
  return {
    ...(name !== (h.name ?? "") ? { name } : {}),
    ...brokerEdit(h, edited.broker),
    ...noteEdit(h, edited.note),
    ...(maturity !== (h.maturity ?? "")
      ? { maturity: maturity === "" ? null : maturity }
      : {}),
    ...(edited.dry !== undefined && edited.dry !== (h.dry_powder === true)
      ? { dry_powder: edited.dry }
      : {}),
  };
}

// in parts, so a row can drop what its label says or a phone cannot fit
export function cashLine(
  h: Holding,
  now = Date.now(),
): { what: string; broker: string | null; date: string | null } {
  return {
    what: cashWord(h),
    broker: h.parts.length === 1 ? h.parts[0]!.broker : null,
    // a term deposit says when it ends in place of the day it was set
    date: h.maturity
      ? `matures ${day(h.maturity, now)}`
      : h.as_of
        ? day(h.as_of, now)
        : null,
  };
}

// repaid on its maturity day, by the viewer's date
export const matured = (h: Holding, now = Date.now()): boolean =>
  (h.kind === "bond" || h.kind === "cash") &&
  !!h.maturity &&
  h.maturity <= today(browserZone(), now);

// the line under the ticker
export function holdingName(h: Holding, now = Date.now()): string {
  if (h.kind === "cash") {
    const c = cashLine(h, now);
    return [c.what, c.broker, c.date].filter(Boolean).join(" · ");
  }
  // the broker, not the kind word, tells two bonds or funds apart
  const at = [...new Set(h.parts.map((p) => p.broker).filter(Boolean))].join(
    ", ",
  );
  if (h.kind === "fund") {
    return [at, h.isin].filter(Boolean).join(" · ") || "Fund";
  }
  if (h.kind === "bond") {
    const c = h.coupon != null ? `${h.coupon}%` : null;
    const m = h.maturity ? day(h.maturity, now) : null;
    return [at, c, m].filter(Boolean).join(" · ") || "Bond";
  }
  const name = nameOf(h.name, h.type, h.id ?? undefined);
  return h.sold_today ? (name ? `${name} · Sold today` : "Sold today") : name;
}

// a phone fits a bond's coupon only; a matured one's tag says all
export function bondPhoneLine(h: Holding, now = Date.now()): string {
  if (matured(h, now)) return "";
  return h.coupon != null ? `${h.coupon}%` : holdingName(h, now);
}

export const portfolioOf = (h: Holding): string =>
  h.parts[0]?.portfolio ?? "Other";

// in the display currency when converted, else its own; a row the server
// could not convert (no rate) has none, never its own figure in its place
export const shownValue = (h: Holding): number | null =>
  h.converted ? h.converted.value : h.value;

export const shownGain = (h: Holding): number | null =>
  h.converted ? h.converted.pl : h.pl;

// the gain's percent on the same base as its money: the display
// currency's, the rate's move in, when converted
export const shownGainPercent = (h: Holding): number | null =>
  h.converted ? h.converted.pl_percent : h.pl_percent;

// with no display currency each currency stands alone: nothing in two
// currencies is ever summed or shared out
export const mixed = (h: Holdings): boolean =>
  h.converted === null && h.totals.length > 1;

export const shownWeight = (h: Holding): number | null =>
  h.converted ? h.converted.weight : h.currency_weight;

const dayShown = (h: Holding): number | null => {
  if (h.day_change === null) return null;
  if (!h.converted) return h.day_change;
  return h.converted.rate === null ? null : h.day_change * h.converted.rate;
};

export type Sums = { value: number; day: number; dayKnown: boolean };

export function sums(rows: readonly Holding[]): Sums {
  const s: Sums = { value: 0, day: 0, dayKnown: false };
  for (const h of rows) {
    s.value += shownValue(h) ?? 0;
    const d = dayShown(h);
    if (d !== null) {
      s.day += d;
      s.dayKnown = true;
    }
  }
  return s;
}

export type HoldingGroup = { key: string; rows: Holding[]; value: number };

const CASH_GROUPS = ["Dry powder", "Reserve"];

// on All by portfolio in the list's order (order: their names), one not
// in it last; inside one by kind, the largest first, dry powder before reserve
export function groupsOf(
  rows: readonly Holding[],
  all: boolean,
  order: readonly string[] = [],
): HoldingGroup[] {
  const by = new Map<string, Holding[]>();
  for (const r of rows) {
    const k = all
      ? portfolioOf(r)
      : r.kind === "cash"
        ? cashWord(r)
        : kindName(r.type);
    by.set(k, [...(by.get(k) ?? []), r]);
  }
  const placed = (k: string) => {
    const i = order.indexOf(k);
    return i < 0 ? order.length : i;
  };
  const pinned = (k: string) => (all ? -1 : CASH_GROUPS.indexOf(k));
  return [...by.entries()]
    .map(([key, rs]) => ({ key, rows: rs, value: sums(rs).value }))
    .sort(
      (a, b) =>
        (all ? placed(a.key) - placed(b.key) : 0) ||
        (pinned(a.key) >= 0 && pinned(b.key) >= 0
          ? pinned(a.key) - pinned(b.key)
          : 0) ||
        b.value - a.value,
    );
}

// the places a portfolio's arrows send, at its 0-based index among the n
// portfolios but Cash; places are 1-based, null at an end
export const movePlaces = (
  at: number,
  n: number,
): { up: number | null; down: number | null } => ({
  up: at > 0 ? at : null,
  down: at < n - 1 ? at + 2 : null,
});

// the holding groups shut, per view ("all" or a portfolio id), kept as
// one JSON text; text that is not that shuts nothing
export const SHUT_KEY = "markets-portfolio-shut";

function shutViews(text: string | null): Record<string, string[]> {
  try {
    const v: unknown = JSON.parse(text ?? "{}");
    if (typeof v !== "object" || v === null || Array.isArray(v)) return {};
    const out: Record<string, string[]> = {};
    for (const [view, keys] of Object.entries(v)) {
      if (Array.isArray(keys)) {
        out[view] = keys.filter((k): k is string => typeof k === "string");
      }
    }
    return out;
  } catch {
    return {};
  }
}

export const shutOf = (text: string | null, view: string): Set<string> =>
  new Set(shutViews(text)[view] ?? []);

// the text with one group of one view opened or shut, the others kept
export function toggleShut(
  text: string | null,
  view: string,
  key: string,
): string {
  const views = shutViews(text);
  const keys = new Set(views[view] ?? []);
  if (keys.has(key)) keys.delete(key);
  else keys.add(key);
  if (keys.size === 0) delete views[view];
  else views[view] = [...keys];
  return JSON.stringify(views);
}

// a group's share of the whole view
export function groupShare(h: Holdings, value: number): string {
  if (mixed(h)) return "";
  const total = h.converted?.value ?? h.totals[0]?.value ?? 0;
  return total > 0 ? `${((value / total) * 100).toFixed(1)}%` : "";
}

export type SortKey = "value" | "today" | "gain";

// a row with nothing to sort by goes last either way
export function sortRows(
  rows: readonly Holding[],
  key: SortKey,
  dir: "asc" | "desc" = "desc",
): Holding[] {
  const of = (h: Holding): number | null =>
    key === "today"
      ? h.change_percent
      : key === "gain"
        ? shownGainPercent(h)
        : shownValue(h);
  const sign = dir === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    const x = of(a);
    const y = of(b);
    if (x === null || y === null)
      return (x === null ? 1 : 0) - (y === null ? 1 : 0);
    return (x - y) * sign;
  });
}

// a quoted or listed price moves within a day; cash, a hand-priced fund
// and a face-value bond never do
export const moves = (h: Holding): boolean =>
  h.priced === "quote" || h.priced === "listing";

// the columns something in view fills
export function columnsFor(rows: readonly Holding[]): {
  spark: boolean;
  price: boolean;
  priceHead: "Change" | "Price";
  gain: boolean;
} {
  const listed = rows.some(moves);
  return {
    spark: listed,
    price: !rows.every((x) => x.kind === "cash"),
    priceHead: listed ? "Change" : "Price",
    gain: !rows.every((x) => x.pl === null),
  };
}

// the value band: today only when something in view moves within a day,
// all time only when a cost gives a gain
export function heroOf(h: Holdings): {
  total: Total;
  // with nothing converted, each other currency's total, for lines in
  // the text's size under the one large figure
  others: Total[];
  dayPercent: number | null;
  today: boolean;
  allTime: boolean;
} | null {
  const byValue = [...h.totals].sort((a, b) => (b.value ?? 0) - (a.value ?? 0));
  const t = h.converted ?? byValue[0] ?? null;
  if (t === null) return null;
  const before =
    t.day_change !== null && t.value !== null ? t.value - t.day_change : 0;
  return {
    total: t,
    others: h.converted ? [] : byValue.slice(1),
    dayPercent: before !== 0 ? (t.day_change! / before) * 100 : null,
    today: h.holdings.some(moves),
    allTime: t.pl !== null && (t.cost ?? 0) > 0,
  };
}

export type BarSide = {
  key: "invested" | "cash" | "dry" | "reserve";
  label: string;
  value: number;
  pct: number;
};

// All: invested against dry powder, reserve being outside its value; shown only when both are above 0
export function barOf(t: Total, all = false): BarSide[] | null {
  const inv = t.invested ?? 0;
  const dry = t.dry_powder ?? 0;
  const reserve = t.reserve ?? 0;
  const sides: Omit<BarSide, "pct">[] = all
    ? [
        { key: "invested", label: "Invested", value: inv },
        { key: "dry", label: "Dry powder", value: dry },
      ]
    : inv > 0
      ? [
          { key: "invested", label: "Invested", value: inv },
          { key: "cash", label: "Cash", value: dry + reserve },
        ]
      : [
          { key: "dry", label: "Dry powder", value: dry },
          { key: "reserve", label: "Reserve", value: reserve },
        ];
  if (!sides.every((x) => x.value > 0)) return null;
  const sum = sides.reduce((a, x) => a + x.value, 0);
  return sides.map((x) => ({ ...x, pct: Math.round((x.value / sum) * 100) }));
}

// balance: a cash row's drawer with its details folded
export type EditWhat = "edit" | "balance" | "price" | "purchases";

// a fund the owner prices has a page of its own, read only by who holds
// or priced it, so a viewer of shared portfolios gets none
export const pageOf = (h: Holding, viewOnly = false): string | null =>
  h.id && (isFundId(h.id) ? !viewOnly : h.priced !== "hand")
    ? symbolHref(h.id)
    : null;

export const tradePage = (symbol: string, viewOnly = false): string | null =>
  isFundId(symbol) && viewOnly ? null : symbolHref(symbol);

// with no instrument page, a row opens what edits it
export function homeOf(h: Holding): EditWhat | null {
  if (h.position !== null) return h.kind === "cash" ? "balance" : "edit";
  if (h.kind === "fund" && h.id && h.isin) return "price";
  if (h.kind === "bond") return "purchases";
  return null;
}

export type RowAction =
  | "buy"
  | "sell"
  | "price"
  | "edit"
  | "purchases"
  | "page";

// a row's ⋯: trade what trades, price what the owner prices, edit a
// position, list a merged bond's purchases, and its page when it has one
export function rowActions(h: Holding): RowAction[] {
  const out: RowAction[] = [];
  const fund = h.kind === "fund" && h.isin !== undefined && h.id !== null;
  if (h.id && (h.kind === "holding" || fund)) {
    out.push("buy");
    if (!(h.kind === "holding" && h.sold_today)) out.push("sell");
  }
  if (fund) out.push("price");
  if (h.kind !== "holding" && h.position !== null) out.push("edit");
  if (h.kind === "bond" && h.position === null) out.push("purchases");
  if (pageOf(h)) out.push("page");
  return out;
}

// the price cell's figure: a bond's as a percent of par
export function priceLine(h: Holding): string {
  if (h.kind === "cash") return "";
  if (h.unit === "percent_of_par") return `${price(h.price)}%`;
  return price(h.price, h.currency);
}

// the grey weight bar: a quarter of the view fills it
export const weightBar = (w: number | null): number =>
  Math.min(100, (w ?? 0) * 4);

export const isReward = (t: TradeRow): boolean =>
  t.side === "buy" && t.price === 0;

export const sideWord = (t: TradeRow): string =>
  isReward(t) ? "Reward" : t.side === "buy" ? "Buy" : "Sell";

export const sideTag = (t: TradeRow): string =>
  `tag tag-side${isReward(t) ? "" : t.side === "buy" ? " tag-up" : " tag-down"}`;

export const tradeAmount = (t: TradeRow): number =>
  tradeMoney(t.side, t.quantity, t.price, t.fees, t.unit);

// one order's figures across its fills
export function orderOf(fills: readonly TradeRow[]): {
  quantity: number;
  amount: number;
  fees: number;
  price: number;
} {
  const q = fills.reduce((a, x) => a + x.quantity, 0);
  return {
    quantity: Number(q.toFixed(8)),
    amount: fills.reduce((a, x) => a + tradeAmount(x), 0),
    fees: fills.reduce((a, x) => a + x.fees, 0),
    price:
      fills.length > 1 && q !== 0
        ? fills.reduce((a, x) => a + x.quantity * x.price, 0) / q
        : (fills[0]?.price ?? 0),
  };
}

// newest first, the newer id first on one day
const newest = (a: TradeRow, b: TradeRow): number =>
  a.date < b.date ? 1 : a.date > b.date ? -1 : b.id - a.id;

// fills of one order land as several trades: one day, portfolio,
// symbol, side, broker and reward or not read as the order they were
export function foldFills(trades: readonly TradeRow[]): TradeRow[][] {
  const out: TradeRow[][] = [];
  for (const t of [...trades].sort(newest)) {
    const same = out.find((r) => {
      const o = r[0]!;
      return (
        o.date === t.date &&
        o.portfolio === t.portfolio &&
        o.symbol === t.symbol &&
        o.side === t.side &&
        o.broker === t.broker &&
        isReward(o) === isReward(t)
      );
    });
    if (same) same.push(t);
    else out.push([t]);
  }
  return out;
}

export type Month = {
  key: string;
  label: string;
  // "13 trades": rewards count too
  trail: string;
  rows: TradeRow[][];
};

export function monthsOf(trades: readonly TradeRow[]): Month[] {
  const by = new Map<string, TradeRow[][]>();
  for (const order of foldFills(trades)) {
    const k = order[0]!.date.slice(0, 7);
    by.set(k, [...(by.get(k) ?? []), order]);
  }
  return [...by.entries()].map(([key, rows]) => {
    const [y, m] = key.split("-").map(Number) as [number, number];
    return {
      key,
      label: new Date(y, m - 1, 1).toLocaleDateString("en-GB", {
        month: "long",
        year: "numeric",
      }),
      trail: `${rows.length} ${rows.length === 1 ? "trade" : "trades"}`,
      rows,
    };
  });
}

// the activity list: the live trades or the removed ones, searched
export function activityOf(
  trades: readonly TradeRow[],
  removed: boolean,
  q: string,
): { months: Month[]; count: number; kept: number; removed: number } {
  const kept = trades.filter((t) => (t.removed_at !== null) === removed);
  const months = monthsOf(kept.filter((t) => tradeMatches(t, q)));
  // counted as the rows read: one per order, not per fill
  return {
    months,
    count: months.reduce((a, m) => a + m.rows.length, 0),
    kept: kept.length,
    removed: foldFills(trades.filter((t) => t.removed_at !== null)).length,
  };
}

// what Add opens on in one portfolio: Cash takes cash, else the kind most
// of its holdings are; none in All or an empty one, where the kind last
// saved stands
export function addKindOf(
  holdings: readonly Pick<Holding, "kind">[],
  cash: boolean,
): "trade" | "cash" | "fund" | "bond" | undefined {
  if (cash) return "cash";
  const count = new Map<string, number>();
  for (const h of holdings) {
    const k = h.kind === "holding" ? "trade" : h.kind;
    count.set(k, (count.get(k) ?? 0) + 1);
  }
  let best: string | undefined;
  for (const [k, n] of count)
    if (best === undefined || n > count.get(best)!) best = k;
  return best as "trade" | "cash" | "fund" | "bond" | undefined;
}
