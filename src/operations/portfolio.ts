// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// Portfolios for the tool and the API alike. Holdings are private: no
// message here quotes a quantity, a price or a value, and nothing is logged.

import { iso } from "../market/format.ts";
import { type Instrument, readInstrument } from "../market/instruments.ts";
import { readQuote } from "../market/quotes.ts";
import { markRead } from "../market/tracking.ts";
import { checkZone, localDate } from "../market/zone.ts";
import { missingPairs, rates } from "../portfolios/fx.ts";
import {
  type Broker,
  brokerByName,
  brokerRows,
  chainOf,
  deleteBroker,
  deletePortfolio,
  displayCurrency,
  insertBroker,
  insertPortfolio,
  insertPosition,
  insertTrade,
  knownMarkets,
  listBrokers,
  listPortfolios,
  MAX_NAME,
  MAX_NOTE,
  MAX_POSITION_NAME,
  type NewPosition,
  type NewTrade,
  type Portfolio,
  type Position,
  type PositionKind,
  portfolioByName,
  portfolioRows,
  positionHistory,
  readBroker,
  readPortfolio,
  readPosition,
  readPositions,
  readTrade,
  readTrades,
  recentSameTrade,
  renameBroker,
  renamePortfolio,
  samePosition,
  setDisplayCurrency,
  setPositionRemoved,
  setTimeZone,
  setTradeRemoved,
  splitsOf,
  type Trade,
  timeZone,
} from "../portfolios/store.ts";
import {
  addsOversell,
  exact,
  type Holdings,
  holdings,
  newlyOversold,
  pairsNeeded,
  partTrades,
  pending,
  qty,
  scopeTrades,
  sellableOn,
  splitFactor,
  statedOf,
} from "../portfolios/value.ts";
import { errorFields } from "../runtime/log.ts";
import { inCirculation, isCurrencyCode } from "../shared/currencies.ts";
import { FRED } from "../sources/ids.ts";
import type { Db } from "../storage/db/index.ts";
import {
  cursor,
  errorResult,
  type Failure,
  fitPage,
  readCursor,
  type ToolResult,
  textResult,
} from "./answer.ts";
import { ArgError, date, fields, quoted, text } from "./args.ts";
import type { Markets } from "./markets.ts";
import { readTargets } from "./targets.ts";
import { opens, type Who } from "./who.ts";

export const PORTFOLIO_ACTIONS = [
  "setup",
  "list",
  "holdings",
  "trades",
  "add",
  "update",
  "remove",
  "restore",
  "rename_broker",
] as const;
type Action = (typeof PORTFOLIO_ACTIONS)[number];

export const ADD_KINDS = ["trade", "cash", "fund", "bond"] as const;
export type AddKind = (typeof ADD_KINDS)[number];

// no larger number is a real holding, and none can round to another
export const MAX_AMOUNT = 1e12;

const NO_READ = "this key has no portfolio access; the admin grants it";
const NO_WRITE = "this key reads portfolios only; the admin grants write";

export const forbidden = (write: boolean): Failure => ({
  error: "forbidden",
  message: write ? NO_WRITE : NO_READ,
});

// ---- argument shapes -----------------------------------------------------

export type Ref = number | string;

export type TradeArgs = {
  portfolio: Ref | null;
  symbol: string;
  side: "buy" | "sell";
  // all: what the part holds, a sell only
  quantity: number | "all";
  // null: the live price, shown back, unless a total gives it
  price: number | null;
  // what left or reached the account, fees in it; needs a currency
  total: number | null;
  fees: number;
  date: string | null;
  currency: string | null;
  broker: string | null;
  note: string | null;
  // a second fill equal to one just saved, never a retry
  again?: boolean;
};

export type PositionArgs = {
  kind: PositionKind;
  portfolio: Ref | null;
  name: string;
  symbol: string | null;
  currency: string | null;
  // cash's or a fund's market, as an instrument's
  market?: string | null;
  amount: number | null;
  units: number | null;
  price: number | null;
  cost: number | null;
  coupon: number | null;
  maturity: string | null;
  date: string | null;
  broker: string | null;
  note: string | null;
  dryPowder: boolean;
};

// what an update changes; the rest is the row's as it was
export type PositionChange = {
  // a new amount, in this currency, converted when not the position's
  // no currency: the position's own
  amount?: { amount: number; currency: string | null };
  // a cash balance moved by this much, in its own or another currency
  by?: { amount: number; currency: string | null };
  units?: number;
  price?: number;
  cost?: number | null;
  date?: string;
  note?: string | null;
  dryPowder?: boolean;
  // null takes it off
  market?: string | null;
};

export type HoldingsArgs = {
  portfolio: Ref | null;
  broker: string | null;
  currency: string | null;
};

export type TradesArgs = {
  portfolio: Ref | null;
  broker: string | null;
  symbol: string | null;
  from: string | null;
  to: string | null;
  removed: boolean;
};

export type PortfolioArgs =
  | {
      action: "setup";
      currency: string | null;
      zone: string | null;
      portfolio: string | null;
      brokers: string[];
    }
  | { action: "list" }
  | ({ action: "holdings"; next: string | null } & HoldingsArgs)
  | ({ action: "trades"; next: string | null } & TradesArgs)
  | { action: "add"; kind: "trade"; trade: TradeArgs }
  | { action: "add"; kind: PositionKind; position: PositionArgs }
  | {
      action: "update";
      // an id, or the portfolio's one dry powder position
      position: number | "dry_powder";
      portfolio: Ref | null;
      change: PositionChange;
    }
  | { action: "rename_broker"; broker: string; name: string }
  | {
      action: "remove" | "restore";
      trade: number | null;
      position: number | null;
      portfolio: Ref | null;
    };

export function amount(
  value: unknown,
  name: string,
  options: { positive?: boolean } = {},
): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > MAX_AMOUNT ||
    (options.positive === true && value === 0)
  ) {
    throw new ArgError(
      `${name} must be a number from ${options.positive ? "above 0" : "0"} to ${MAX_AMOUNT}`,
    );
  }
  return value;
}

const optionalAmount = (value: unknown, name: string): number | null =>
  value === undefined || value === null ? null : amount(value, name);

export function currencyArg(value: unknown, name = "currency"): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "string" && isCurrencyCode(value.trim())) {
    return value.trim();
  }
  throw new ArgError(
    `${name} must be an ISO 4217 currency code in circulation, such as EUR, or the listing's own (GBp)`,
  );
}

// a code named for a conversion: an ISO 4217 currency in circulation
export function namedCurrency(
  value: unknown,
  name = "currency",
): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "string" && inCirculation(value.trim())) {
    return value.trim();
  }
  throw new ArgError(
    `${name} must be an ISO 4217 currency code in circulation, such as EUR`,
  );
}

// an IANA zone, never an offset, which cannot follow a clock change
export function zoneArg(value: unknown, name = "time_zone"): string | null {
  if (value === undefined || value === null) return null;
  try {
    return checkZone(typeof value === "string" ? value.trim() : value);
  } catch {
    throw new ArgError(
      `${name} must be an IANA time zone, such as America/New_York`,
    );
  }
}

export function ref(value: unknown, name = "portfolio"): Ref | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) {
    return value;
  }
  if (typeof value === "string" && value.trim() !== "") {
    return text(value, name, MAX_NAME);
  }
  throw new ArgError(`${name} must be a name or an id`);
}

const optionalName = (value: unknown, name: string, max = MAX_NAME) =>
  value === undefined || value === null ? null : text(value, name, max);

const note = (value: unknown) => optionalName(value, "note", MAX_NOTE);

export function rowId(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new ArgError(`${name} must be an id, a positive integer`);
  }
  return value;
}

export function parseTrade(f: Record<string, unknown>): TradeArgs {
  if (f.side !== "buy" && f.side !== "sell") {
    throw new ArgError("side must be buy or sell");
  }
  return {
    portfolio: ref(f.portfolio),
    symbol: text(f.symbol, "symbol"),
    side: f.side,
    quantity:
      f.quantity === "all"
        ? f.side === "sell"
          ? "all"
          : (() => {
              throw new ArgError("quantity all is a sell's");
            })()
        : amount(f.quantity, "quantity", { positive: true }),
    price: optionalAmount(f.price, "price"),
    total: (() => {
      const t = optionalAmount(f.total, "total");
      if (t !== null && f.price !== undefined && f.price !== null) {
        throw new ArgError("a trade takes price or total, not both");
      }
      return t;
    })(),
    fees: optionalAmount(f.fees, "fees") ?? 0,
    date: date(f.date, "date"),
    currency: currencyArg(f.currency),
    broker: optionalName(f.broker, "broker"),
    note: note(f.note),
    again: (() => {
      if (f.again !== undefined && typeof f.again !== "boolean") {
        throw new ArgError("again must be true or false");
      }
      return f.again === true;
    })(),
  };
}

export function parsePosition(
  kind: PositionKind,
  f: Record<string, unknown>,
): PositionArgs {
  const base: PositionArgs = {
    kind,
    portfolio: ref(f.portfolio),
    name: text(f.name, "name", MAX_POSITION_NAME),
    symbol: null,
    currency: currencyArg(f.currency),
    amount: null,
    units: null,
    price: null,
    cost: optionalAmount(f.cost, "cost"),
    coupon: null,
    maturity: null,
    date: date(f.date, "date"),
    broker: optionalName(f.broker, "broker"),
    note: note(f.note),
    dryPowder: false,
    market: optionalName(f.market, "market"),
  };
  if (kind === "cash") {
    if (base.cost !== null) throw new ArgError("cash has no cost");
    if (f.dry_powder !== undefined && typeof f.dry_powder !== "boolean") {
      throw new ArgError("dry_powder must be true or false");
    }
    return {
      ...base,
      amount: amount(f.amount, "amount"),
      dryPowder: f.dry_powder === true,
    };
  }
  if (kind === "fund") {
    return {
      ...base,
      units: amount(f.units, "units", { positive: true }),
      price: amount(f.price, "price"),
    };
  }
  let coupon: number | null = null;
  if (f.coupon !== undefined && f.coupon !== null) {
    if (typeof f.coupon !== "number" || !Number.isFinite(f.coupon)) {
      throw new ArgError("coupon must be a percent");
    }
    coupon = f.coupon;
  }
  return {
    ...base,
    symbol:
      f.symbol === undefined || f.symbol === null
        ? null
        : text(f.symbol, "symbol"),
    amount: amount(f.amount, "amount", { positive: true }),
    coupon,
    maturity: date(f.maturity, "maturity"),
  };
}

const ARGS: Record<Action, readonly string[]> = {
  setup: ["action", "display_currency", "time_zone", "portfolio", "broker"],
  list: ["action"],
  holdings: ["action", "portfolio", "broker", "currency", "next"],
  trades: [
    "action",
    "portfolio",
    "broker",
    "symbol",
    "from",
    "to",
    "removed",
    "next",
  ],
  add: [
    "action",
    "kind",
    "portfolio",
    "symbol",
    "side",
    "quantity",
    "price",
    "total",
    "fees",
    "date",
    "currency",
    "broker",
    "note",
    "name",
    "amount",
    "units",
    "cost",
    "coupon",
    "maturity",
    "dry_powder",
    "again",
    "market",
  ],
  update: [
    "action",
    "position",
    "amount",
    "units",
    "price",
    "cost",
    "date",
    "note",
    "dry_powder",
    "market",
    "by",
    "currency",
    "portfolio",
    "kind",
  ],
  // portfolio, when given, must be the row's, and kind is only checked to
  // be a known one: agents pass both out of habit from add
  remove: ["action", "trade", "position", "portfolio", "kind"],
  restore: ["action", "trade", "position", "portfolio", "kind"],
  rename_broker: ["action", "broker", "name"],
};

export const UPDATE_FIELDS = ARGS.update.filter(
  (n) =>
    n !== "action" &&
    n !== "position" &&
    n !== "currency" &&
    n !== "portfolio" &&
    n !== "kind",
);

export function parseChange(f: Record<string, unknown>): PositionChange {
  const c: PositionChange = {};
  const paid = currencyArg(f.currency);
  if (f.amount !== undefined) {
    c.amount = { amount: amount(f.amount, "amount"), currency: paid };
  }
  if (f.by !== undefined) {
    if (
      typeof f.by !== "number" ||
      !Number.isFinite(f.by) ||
      Math.abs(f.by) > MAX_AMOUNT
    ) {
      throw new ArgError(
        `by must be a number from -${MAX_AMOUNT} to ${MAX_AMOUNT}`,
      );
    }
    if (c.amount !== undefined) {
      throw new ArgError("update takes amount or by, not both");
    }
    c.by = { amount: f.by, currency: paid };
  } else if (f.currency !== undefined && f.amount === undefined) {
    throw new ArgError("currency goes with amount or by");
  }
  if (f.units !== undefined) {
    c.units = amount(f.units, "units", { positive: true });
  }
  if (f.price !== undefined) c.price = amount(f.price, "price");
  if (f.cost !== undefined) c.cost = optionalAmount(f.cost, "cost");
  if (f.date !== undefined) {
    const d = date(f.date, "date");
    if (d === null) throw new ArgError("date must be a date, YYYY-MM-DD");
    c.date = d;
  }
  if (f.note !== undefined) c.note = note(f.note);
  if (f.dry_powder !== undefined) {
    if (typeof f.dry_powder !== "boolean") {
      throw new ArgError("dry_powder must be true or false");
    }
    c.dryPowder = f.dry_powder;
  }
  if (f.market !== undefined) c.market = optionalName(f.market, "market");
  if (Object.keys(c).length === 0) {
    throw new ArgError(
      `update changes at least one of ${UPDATE_FIELDS.join(", ")}`,
    );
  }
  return c;
}

export const KIND_ARGS: Record<AddKind, readonly string[]> = {
  trade: [
    "symbol",
    "side",
    "quantity",
    "price",
    "total",
    "fees",
    "date",
    "currency",
    "broker",
    "note",
    "again",
  ],
  cash: [
    "name",
    "amount",
    "currency",
    "date",
    "broker",
    "note",
    "dry_powder",
    "market",
  ],
  fund: [
    "name",
    "units",
    "price",
    "currency",
    "cost",
    "date",
    "broker",
    "note",
    "market",
  ],
  bond: [
    "name",
    "symbol",
    "amount",
    "coupon",
    "maturity",
    "currency",
    "cost",
    "date",
    "broker",
    "note",
  ],
};

export const MAX_SETUP_BROKERS = 20;

// a name or a list of names, each once
function brokerNames(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  const list = Array.isArray(value) ? value : [value];
  if (list.length > MAX_SETUP_BROKERS) {
    throw new ArgError(`broker is at most ${MAX_SETUP_BROKERS} names`);
  }
  const out: string[] = [];
  for (const v of list) {
    const name = text(v, "broker", MAX_NAME);
    if (!out.some((x) => x.toLowerCase() === name.toLowerCase())) {
      out.push(name);
    }
  }
  return out;
}

const nextOf = (v: unknown): string | null => {
  if (v === undefined || v === null) return null;
  if (typeof v !== "string") {
    throw new ArgError("next must be a string from an earlier answer");
  }
  return v;
};

export function parsePortfolio(input: unknown): PortfolioArgs {
  const f = fields(input, [...new Set(Object.values(ARGS).flat())]);
  if (
    typeof f.action !== "string" ||
    !(PORTFOLIO_ACTIONS as readonly string[]).includes(f.action)
  ) {
    throw new ArgError(`action must be one of ${PORTFOLIO_ACTIONS.join(", ")}`);
  }
  const action = f.action as Action;
  if (
    (action === "update" || action === "remove" || action === "restore") &&
    f.kind !== undefined &&
    f.kind !== null &&
    !(ADD_KINDS as readonly string[]).includes(String(f.kind))
  ) {
    throw new ArgError(`kind must be one of ${ADD_KINDS.join(", ")}`);
  }
  for (const name of Object.keys(f)) {
    if (!ARGS[action].includes(name)) {
      throw new ArgError(`${quoted(name)} is not an argument of ${action}`);
    }
  }
  switch (action) {
    case "setup": {
      const made = {
        action,
        currency: namedCurrency(f.display_currency, "display_currency"),
        zone: zoneArg(f.time_zone),
        portfolio: optionalName(f.portfolio, "portfolio"),
        brokers: brokerNames(f.broker),
      };
      if (
        made.currency === null &&
        made.zone === null &&
        made.portfolio === null &&
        made.brokers.length === 0
      ) {
        throw new ArgError(
          "setup takes one or more of display_currency, time_zone, portfolio, broker",
        );
      }
      return made;
    }
    case "rename_broker":
      return {
        action,
        broker: text(f.broker, "broker", MAX_NAME),
        name: text(f.name, "name", MAX_NAME),
      };
    case "list":
      return { action };
    case "holdings":
      return {
        action,
        portfolio: ref(f.portfolio),
        broker: optionalName(f.broker, "broker"),
        currency: namedCurrency(f.currency),
        next: nextOf(f.next),
      };
    case "trades": {
      if (f.removed !== undefined && typeof f.removed !== "boolean") {
        throw new ArgError("removed must be true or false");
      }
      return {
        action,
        portfolio: ref(f.portfolio),
        broker: optionalName(f.broker, "broker"),
        symbol:
          f.symbol === undefined || f.symbol === null
            ? null
            : text(f.symbol, "symbol"),
        from: date(f.from, "from"),
        to: date(f.to, "to"),
        removed: f.removed === true,
        next: nextOf(f.next),
      };
    }
    case "add": {
      const kind = (f.kind ?? "trade") as AddKind;
      if (!(ADD_KINDS as readonly string[]).includes(kind)) {
        throw new ArgError(`kind must be one of ${ADD_KINDS.join(", ")}`);
      }
      for (const name of Object.keys(f)) {
        if (["action", "kind", "portfolio"].includes(name)) continue;
        if (!KIND_ARGS[kind].includes(name)) {
          throw new ArgError(`${quoted(name)} is not an argument of ${kind}`);
        }
      }
      if (kind === "trade") return { action, kind, trade: parseTrade(f) };
      return { action, kind, position: parsePosition(kind, f) };
    }
    case "update":
      return {
        action,
        position:
          f.position === "dry_powder"
            ? "dry_powder"
            : rowId(f.position, "position"),
        portfolio: ref(f.portfolio),
        change: parseChange(f),
      };
    case "remove":
    case "restore": {
      const trade =
        f.trade === undefined || f.trade === null
          ? null
          : rowId(f.trade, "trade");
      const position =
        f.position === undefined || f.position === null
          ? null
          : rowId(f.position, "position");
      if ((trade === null) === (position === null)) {
        throw new ArgError(`${action} takes one of trade or position`);
      }
      return { action, trade, position, portfolio: ref(f.portfolio) };
    }
  }
}

// ---- resolving names -----------------------------------------------------

const notFound = (message: string): Failure => ({
  error: "not_found",
  message,
});

export function findPortfolio(
  db: Db,
  r: Ref | null,
): Portfolio | Failure | null {
  if (r === null) return null;
  const p =
    typeof r === "number"
      ? readPortfolio(db, r)
      : (portfolioByName(db, r) ??
        (/^\d+$/.test(r) ? readPortfolio(db, Number(r)) : null));
  if (p !== null) return p;
  const names = listPortfolios(db).map((x) => x.name);
  return notFound(
    names.length === 0
      ? "no portfolio yet; make one first"
      : `no portfolio ${quoted(String(r))}; portfolios: ${names.join(", ")}`,
  );
}

// add needs one; with a single portfolio it is that one
function portfolioFor(db: Db, r: Ref | null): Portfolio | Failure {
  const found = findPortfolio(db, r);
  if (found !== null) return found;
  const all = listPortfolios(db);
  if (all.length === 1) return all[0]!;
  return {
    error: "bad_arguments",
    message:
      all.length === 0
        ? "no portfolio yet; make one first"
        : `name a portfolio: ${all.map((p) => p.name).join(", ")}`,
  };
}

export function findBroker(
  db: Db,
  name: string | null,
): Broker | Failure | null {
  if (name === null) return null;
  const b = brokerByName(db, name);
  if (b !== null) return b;
  const names = listBrokers(db).map((x) => x.name);
  return notFound(
    names.length === 0
      ? `no broker ${quoted(name)}; none is kept yet`
      : `no broker ${quoted(name)}; brokers: ${names.join(", ")}`,
  );
}

const isFailure = (v: unknown): v is Failure =>
  typeof v === "object" && v !== null && "error" in v;

// a market a stored instrument is in, spelled as its id spells it; none
// is assumed for a position
export function findMarket(
  db: Db,
  name: string | null,
): string | Failure | null {
  if (name === null) return null;
  const known = knownMarkets(db);
  const found = known.find((k) => k.toLowerCase() === name.toLowerCase());
  if (found !== undefined) return found;
  return notFound(`no market ${quoted(name)}; markets: ${known.join(", ")}`);
}

// ---- answers -------------------------------------------------------------

export const portfolioItem = (db: Db, p: Portfolio) => ({
  id: p.id,
  name: p.name,
  trades: readTrades(db, { portfolio: p.id }).length,
  positions: readPositions(db, { portfolio: p.id }).length,
  created_at: iso(p.createdAt),
});

export const brokerItem = (b: Broker) => ({ id: b.id, name: b.name });

export function listAll(m: Markets) {
  return {
    display_currency: displayCurrency(m.db),
    time_zone: timeZone(m.db),
    portfolios: listPortfolios(m.db).map((p) => portfolioItem(m.db, p)),
    brokers: listBrokers(m.db).map(brokerItem),
    // what a cash or fund position can name as its market
    markets: knownMarkets(m.db),
  };
}

export function tradeItem(db: Db, t: Trade) {
  const i = readInstrument(db, t.instrument);
  const f = splitFactor(splitsOf(db, t.instrument), statedOf(t));
  const p = readPortfolio(db, t.portfolio);
  const b = t.broker === null ? null : readBroker(db, t.broker);
  return {
    id: t.id,
    portfolio: p?.name ?? null,
    portfolio_id: t.portfolio,
    symbol: t.instrument,
    name: i?.name ?? null,
    side: t.side,
    date: t.date,
    quantity: t.quantity,
    price: exact(t.price),
    fees: t.fees,
    currency: t.currency,
    listing_currency: i?.currency ?? null,
    // percent_of_par: the price is a percent of face
    unit: i?.unit ?? null,
    // the day its quantity and price are stated as of
    stated_on: statedOf(t),
    // today's shares, after the splits since the trade
    ...(f === 1
      ? {}
      : {
          split_adjusted: {
            quantity: qty(t.quantity * f),
            price: exact(t.price / f),
          },
        }),
    broker: b?.name ?? null,
    note: t.note,
    entered_by: t.enteredBy,
    entered_at: iso(t.enteredAt),
    removed_at: iso(t.removedAt),
    removed_by: t.removedBy,
  };
}

export function positionItem(db: Db, p: Position) {
  const pf = readPortfolio(db, p.portfolio);
  const b = p.broker === null ? null : readBroker(db, p.broker);
  return {
    id: p.id,
    kind: p.kind,
    portfolio: pf?.name ?? null,
    portfolio_id: p.portfolio,
    name: p.name,
    symbol: p.instrument,
    market: p.market,
    currency: p.currency,
    amount: p.amount,
    units: p.units,
    price: p.price,
    cost: p.cost,
    coupon: p.coupon,
    maturity: p.maturity,
    as_of: p.asOf,
    ...(p.kind === "cash" ? { dry_powder: p.dryPowder } : {}),
    broker: b?.name ?? null,
    note: p.note,
    replaces: p.replaces,
    entered_by: p.enteredBy,
    entered_at: iso(p.enteredAt),
    removed_at: iso(p.removedAt),
    removed_by: p.removedBy,
  };
}

// ---- reads ---------------------------------------------------------------

export type HoldingsAnswer = Holdings & {
  portfolio: string | null;
  broker: string | null;
  display_currency: string | null;
};

// the caller's currency, else the owner's display currency, else none
export async function readHoldings(
  m: Markets,
  args: HoldingsArgs,
): Promise<HoldingsAnswer | Failure> {
  const p = findPortfolio(m.db, args.portfolio);
  if (isFailure(p)) return p;
  const b = findBroker(m.db, args.broker);
  if (isFailure(b)) return b;
  const shown = displayCurrency(m.db);
  const currency = args.currency ?? shown;
  const scope = {
    portfolio: p?.id ?? null,
    broker: b?.id ?? null,
    currency,
  };
  let trades = scopeTrades(m.db, scope);
  const missing = missingPairs(m.db, pairsNeeded(m.db, scope, trades));
  // a pair never seen is fetched once; one that fails stays null
  if (missing.length > 0) {
    await readTargets(m, missing);
    // a write may have landed while the pair was fetched
    trades = scopeTrades(m.db, scope);
  }
  const now = m.clock.now();
  const read = holdings(
    m.db,
    {
      ...scope,
      portfolios: listPortfolios(m.db),
      brokers: listBrokers(m.db),
    },
    now,
    m.quoteEveryMs,
    trades,
  );
  // a pair a holding is valued by is a read, so it stays synced
  const pairs = [
    ...new Set(
      [...read.rates, ...read.cost_rates].flatMap((r) =>
        r.pair === null ? [] : [r.pair],
      ),
    ),
  ];
  if (pairs.length > 0) {
    await m.writer
      .write((db) => markRead(db, pairs, m.clock.now()))
      .catch((error: unknown) => {
        m.log.error("tracking failed", errorFields(error));
      });
  }
  return {
    portfolio: p?.name ?? null,
    broker: b?.name ?? null,
    display_currency: shown,
    ...read,
  };
}

export function readTradeList(
  m: Markets,
  args: TradesArgs,
): ReturnType<typeof tradeItem>[] | Failure {
  const p = findPortfolio(m.db, args.portfolio);
  if (isFailure(p)) return p;
  const b = findBroker(m.db, args.broker);
  if (isFailure(b)) return b;
  let instrument: string | null = null;
  if (args.symbol !== null) {
    const upper = args.symbol.toUpperCase();
    // a trade names its instrument by id; a bare symbol matches any market
    const ids = new Set(
      readTrades(m.db, { removed: true }).map((t) => t.instrument),
    );
    instrument =
      [...ids].find((id) => id === upper) ??
      [...ids].find((id) => id.slice(id.indexOf(":") + 1) === upper) ??
      [...ids].find((id) => readInstrument(m.db, id)?.sourceSymbol === upper) ??
      `${upper}\u0000`;
  }
  return readTrades(m.db, {
    portfolio: p?.id ?? null,
    broker: b?.id ?? null,
    instrument,
    from: args.from,
    to: args.to,
    removed: args.removed,
  }).map((t) => tradeItem(m.db, t));
}

// ---- writes --------------------------------------------------------------

// a price this server can value: a share, a coin or pair, a bond's percent
const PRICED = new Set(["per_share", "per_unit", "percent_of_par"]);

const OVERSOLD = "sells more than that broker holds";
// names the sale, so an agent clearing a portfolio removes it first
export const undoesSale = (t: Pick<Trade, "id" | "date">): string =>
  `a later sale at that broker would sell more than it holds: remove sale ${t.id} (${t.date}) first`;
const SELLS_PAST = "it sells more than that broker held then";

async function instrumentOf(
  m: Markets,
  symbol: string,
): Promise<Instrument | Failure> {
  const [t] = await readTargets(m, [symbol]);
  if ("error" in t!) {
    const { candidates, ...error } = t.error;
    return {
      ...error,
      message: `${quoted(symbol)}: ${error.message}`,
      ...(candidates === undefined ? {} : { candidates }),
    };
  }
  const i = t!.instrument;
  if (i.source === FRED || !PRICED.has(i.unit)) {
    return {
      error: "bad_arguments",
      message: `${i.id} has no price a holding can be valued at`,
    };
  }
  return i;
}

// today somewhere on earth: a trader east of the exchange dates a trade
// a day ahead of the exchange's own today
export const latestDay = (now: number): string => localDate("Etc/GMT-14", now);

// the owner's today, the UTC day until the owner names a zone: the day a
// position with no date is true on
export const ownerToday = (db: Db, now: number): string =>
  localDate(timeZone(db) ?? "UTC", now);

// a retry within this of the first add is the same trade
export const RETRY_MS = 10 * 60_000;

export type Added = {
  trade?: ReturnType<typeof tradeItem>;
  // a sell of all with no broker: one per broker's part
  trades?: ReturnType<typeof tradeItem>[];
  live_price?: { price: number; at: string | null; rate: number | null };
  total?: { amount: number; currency: string; includes_fees: true };
};

// the sellable amount as held, never more, so the part reaches zero; only
// noise far below what a part counts as nothing is trimmed (0.1 + 0.2)
const trimDown = (v: number): number => {
  const t = Number(v.toPrecision(15));
  return t <= v && v - t <= 1e-12 * Math.max(1, v) ? t : v;
};

// what each broker's part can sell on a day, in that day's shares, with
// the trades after it replayed, so a sell of all never sells twice
function heldOn(
  m: Markets,
  portfolio: number,
  i: Instrument,
  day: string,
): { broker: number | null; quantity: number }[] {
  const splits = splitsOf(m.db, i.id);
  const byBroker = new Map<number | null, Trade[]>();
  // oldest first, so the parts answer in the order they were opened
  for (const t of readTrades(m.db, { portfolio, instrument: i.id }).reverse()) {
    const list = byBroker.get(t.broker);
    if (list) list.push(t);
    else byBroker.set(t.broker, [t]);
  }
  return [...byBroker]
    .map(([broker, list]) => ({
      broker,
      quantity: trimDown(sellableOn(list, splits, day)),
    }))
    .filter((x) => x.quantity > 0);
}

export async function addTrade(
  m: Markets,
  who: Who,
  args: TradeArgs,
): Promise<Added | Failure> {
  const p = portfolioFor(m.db, args.portfolio);
  if (isFailure(p)) return p;
  const b = findBroker(m.db, args.broker);
  if (isFailure(b)) return b;
  const i = await instrumentOf(m, args.symbol);
  if (isFailure(i)) return i;
  const day = args.date ?? localDate(i.zone, m.clock.now());
  if (day > latestDay(m.clock.now())) {
    return { error: "bad_arguments", message: "date is in the future" };
  }
  const currency = args.currency ?? i.currency;
  if (currency === null) {
    return {
      error: "bad_arguments",
      message: `${i.id} has no listing currency; name the currency paid`,
    };
  }
  // a cost paid in another currency reads its pair's close of the day
  if (currency !== i.currency && i.currency !== null) {
    const missing = missingPairs(m.db, [[currency, i.currency]]);
    if (missing.length > 0) await readTargets(m, missing);
  }
  let lots: { broker: number | null; quantity: number }[];
  if (args.quantity === "all") {
    const held = heldOn(m, p.id, i, day).filter(
      (x) => b === null || x.broker === b.id,
    );
    if (held.length === 0) {
      return {
        error: "bad_arguments",
        message: b === null ? "none is held" : "none is held at that broker",
      };
    }
    lots = held;
  } else lots = [{ broker: b?.id ?? null, quantity: args.quantity }];
  const shares = lots.reduce((a, x) => a + x.quantity, 0);
  let price = args.price;
  let live: Added["live_price"];
  let total: Added["total"];
  if (args.total !== null) {
    // what left or reached the account, fees in it
    const net =
      args.side === "buy" ? args.total - args.fees : args.total + args.fees;
    if (net < 0) {
      return {
        error: "bad_arguments",
        message: "fees are more than the total",
      };
    }
    // unrounded, so quantity × price gives the total back: 100 over 3
    // shares costs 100, never 99.9999999999999
    price = net / shares / (i.unit === "percent_of_par" ? 0.01 : 1);
    total = { amount: args.total, currency, includes_fees: true };
  } else if (price === null) {
    const q = readQuote(m.db, i.id);
    if (q === null || i.currency === null) {
      return {
        error: "no_data",
        message: `${i.id} has no live price; name the price`,
      };
    }
    const r = rates(m.db, m.clock.now(), m.quoteEveryMs).rate(
      i.currency,
      currency,
      null,
    );
    if (r.rate === null) {
      return { error: "no_data", message: `${r.reason}; name the price` };
    }
    price = q.price * r.rate;
    live = {
      price,
      at: iso(q.time ?? q.fetchedAt),
      rate: r.pair === null ? null : exact(r.rate),
    };
  }
  const rows: NewTrade[] = lots.map((x) => ({
    portfolio: p.id,
    instrument: i.id,
    side: args.side,
    date: day,
    // typed in as traded: every split since applies
    statedOn: null,
    quantity: x.quantity,
    price: price!,
    // fees split by quantity when one sell is made per broker
    fees: lots.length === 1 ? args.fees : (args.fees * x.quantity) / shares,
    currency,
    broker: x.broker,
    note: args.note,
    enteredBy: who.name,
  }));
  const done = await m.writer.write((db): number[] | Failure => {
    if (readInstrument(db, i.id) === null) {
      return notFound(`${i.id}: deleted while the trade was added`);
    }
    if (!args.again) {
      const since = m.clock.now() - RETRY_MS;
      for (const row of rows) {
        const same = recentSameTrade(db, row, since);
        if (same !== null) {
          return {
            ...conflict(
              `the same trade was saved as trade ${same.id} in the last ${RETRY_MS / 60_000} minutes, so a retry adds nothing; again: true saves a second fill`,
            ),
            trade: same.id,
          };
        }
      }
    }
    if (oversells(db, rows)) {
      return { error: "bad_arguments", message: OVERSOLD };
    }
    return rows.map((row) => insertTrade(db, row, m.clock.now()));
  });
  if (isFailure(done)) {
    // a sell of a number with no broker, of a share held at brokers: say
    // where, so the agent names one instead of guessing
    if (
      done.message === OVERSOLD &&
      b === null &&
      args.side === "sell" &&
      args.quantity !== "all"
    ) {
      const where = heldOn(m, p.id, i, day);
      if (where.some((x) => x.broker !== null)) {
        const names = where.map((x) =>
          x.broker === null
            ? `${exact(x.quantity)} with no broker`
            : `${readBroker(m.db, x.broker)?.name ?? "a broker"} ${exact(x.quantity)}`,
        );
        const list =
          names.length === 1
            ? names[0]
            : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
        return {
          error: "bad_arguments",
          message: `more than is held with no broker; held at ${list}: name a broker or sell all`,
        };
      }
    }
    return done;
  }
  const items = done.map((id) => tradeItem(m.db, readTrade(m.db, id)!));
  return {
    ...(items.length === 1 ? { trade: items[0]! } : { trades: items }),
    ...(live === undefined ? {} : { live_price: live }),
    ...(total === undefined ? {} : { total }),
  };
}

// the part these rows touch, replayed whole with them added
function oversells(db: Db, rows: readonly NewTrade[]): boolean {
  const first = rows[0]!;
  const i = readInstrument(db, first.instrument)!;
  const splits = splitsOf(db, i.id);
  const brokers = new Set(rows.map((r) => r.broker));
  for (const broker of brokers) {
    const before = partTrades(db, {
      portfolio: first.portfolio,
      instrument: i.id,
      broker,
    });
    const added = pending(rows.filter((r) => r.broker === broker));
    if (addsOversell(before, [...before, ...added], i, splits)) return true;
  }
  return false;
}

export async function addPosition(
  m: Markets,
  who: Who,
  args: PositionArgs,
): Promise<
  | { position: ReturnType<typeof positionItem>; replaced: number | null }
  | Failure
> {
  const p = portfolioFor(m.db, args.portfolio);
  if (isFailure(p)) return p;
  const b = findBroker(m.db, args.broker);
  if (isFailure(b)) return b;
  const market = findMarket(m.db, args.market ?? null);
  if (isFailure(market)) return market;
  let instrument: Instrument | null = null;
  if (args.symbol !== null) {
    const i = await instrumentOf(m, args.symbol);
    if (isFailure(i)) return i;
    instrument = i;
  }
  const currency = args.currency ?? instrument?.currency ?? null;
  if (currency === null) {
    return { error: "bad_arguments", message: "name the currency" };
  }
  // a listed bond is valued in its listing's currency, never relabelled
  if (instrument !== null && instrument.currency !== currency) {
    return {
      error: "bad_arguments",
      message: `${instrument.id} is listed in ${instrument.currency ?? "no currency"}; a bond takes its listing's currency`,
    };
  }
  const day = args.date ?? ownerToday(m.db, m.clock.now());
  if (day > latestDay(m.clock.now())) {
    return { error: "bad_arguments", message: "date is in the future" };
  }
  const row: NewPosition = {
    portfolio: p.id,
    kind: args.kind,
    name: args.name,
    currency,
    instrument: instrument?.id ?? null,
    market,
    amount: args.amount,
    units: args.units,
    price: args.price,
    cost: args.cost,
    coupon: args.coupon,
    maturity: args.maturity,
    asOf: day,
    broker: b?.id ?? null,
    note: args.note,
    dryPowder: args.dryPowder,
    replaces: null,
    enteredBy: who.name,
  };
  const done = await m.writer.write((db) => {
    const now = m.clock.now();
    const old = samePosition(db, row);
    if (old !== null) setPositionRemoved(db, old.id, who.name, now);
    return {
      // a market named before stays unless this add names another
      id: insertPosition(
        db,
        {
          ...row,
          market: row.market ?? old?.market ?? null,
          replaces: old?.id ?? null,
        },
        now,
      ),
      replaced: old?.id ?? null,
    };
  });
  return {
    position: positionItem(m.db, readPosition(m.db, done.id)!),
    replaced: done.replaced,
  };
}

// a new row in place of the old, so who changed what and when stays, and
// restoring the old row sets a wrong update back
export async function updatePosition(
  m: Markets,
  who: Who,
  id: number,
  change: PositionChange,
): Promise<
  | {
      position: ReturnType<typeof positionItem>;
      replaced: number;
      rate?: { from: string; to: string; rate: number; at: string | null };
    }
  | Failure
> {
  if (change.date !== undefined && change.date > latestDay(m.clock.now())) {
    return { error: "bad_arguments", message: "date is in the future" };
  }
  const market =
    change.market === undefined ? undefined : findMarket(m.db, change.market);
  if (isFailure(market)) return market;
  const before = readPosition(m.db, id);
  let rate:
    | { from: string; to: string; rate: number; at: string | null }
    | undefined;
  let by: number | null = null;
  let to: number | null = null;
  const given = change.by ?? change.amount;
  if (given !== undefined && before !== null) {
    if (change.by !== undefined && before.kind !== "cash") {
      return { error: "bad_arguments", message: "by moves a cash balance" };
    }
    const from = given.currency ?? before.currency;
    let factor = 1;
    if (from !== before.currency) {
      const missing = missingPairs(m.db, [[from, before.currency]]);
      if (missing.length > 0) await readTargets(m, missing);
      const r = rates(m.db, m.clock.now(), m.quoteEveryMs).rate(
        from,
        before.currency,
        null,
      );
      if (r.rate === null) {
        return {
          error: "no_data",
          message: `${r.reason}; give the amount in ${before.currency}`,
        };
      }
      rate = { from, to: before.currency, rate: exact(r.rate)!, at: r.at };
      factor = r.rate;
    }
    if (change.by !== undefined) by = change.by.amount * factor;
    else to = given.amount * factor;
  }
  const done = await m.writer.write((db): number | Failure => {
    const old = readPosition(db, id);
    if (old === null) return notFound(`no position ${id}`);
    if (old.removedAt !== null) {
      return conflict(
        `position ${id} was removed or updated; restore it first`,
      );
    }
    if (change.dryPowder === true && old.kind !== "cash") {
      return { error: "bad_arguments", message: "only cash is dry powder" };
    }
    if (market !== undefined && old.kind === "bond") {
      return {
        error: "bad_arguments",
        message: "a bond's market is its listing's",
      };
    }
    if (
      old.kind === "cash" &&
      (change.units !== undefined ||
        change.price !== undefined ||
        (change.cost ?? null) !== null)
    ) {
      return { error: "bad_arguments", message: "cash takes an amount" };
    }
    if (old.kind === "fund" && change.amount !== undefined) {
      return {
        error: "bad_arguments",
        message: "a fund takes units and a NAV per unit",
      };
    }
    if (
      old.kind === "bond" &&
      (change.units !== undefined || change.price !== undefined)
    ) {
      return {
        error: "bad_arguments",
        message: "a bond takes its face amount",
      };
    }
    // a balance moved since the rate was read moves from where it is now
    const moved = by === null ? null : (old.amount ?? 0) + by;
    if (moved !== null && moved < -1e-9) {
      return {
        error: "bad_arguments",
        message: "the change is more than the balance",
      };
    }
    const now = m.clock.now();
    // as_of says when the figure was true; a bond's is its purchase date
    const revalued =
      (old.kind === "cash" && given !== undefined) ||
      (old.kind === "fund" &&
        (change.units !== undefined || change.price !== undefined));
    const asOf = change.date ?? (revalued ? ownerToday(db, now) : old.asOf);
    setPositionRemoved(db, id, who.name, now);
    const {
      id: _,
      enteredAt: __,
      removedAt: ___,
      removedBy: ____,
      ...kept
    } = old;
    return insertPosition(
      db,
      {
        ...kept,
        amount:
          moved !== null ? Math.max(0, moved) : to !== null ? to : old.amount,
        units: change.units ?? old.units,
        price: change.price ?? old.price,
        cost: change.cost === undefined ? old.cost : change.cost,
        asOf,
        note: change.note === undefined ? old.note : change.note,
        dryPowder: change.dryPowder ?? old.dryPowder,
        market: market === undefined ? old.market : market,
        replaces: id,
        enteredBy: who.name,
      },
      now,
    );
  });
  if (isFailure(done)) return done;
  return {
    position: positionItem(m.db, readPosition(m.db, done)!),
    replaced: id,
    ...(rate === undefined ? {} : { rate }),
  };
}

// the position's rows, its updates and removals with who and when
export function historyOf(m: Markets, id: number) {
  const p = readPosition(m.db, id);
  if (p === null) return notFound(`no position ${id}`);
  return {
    history: positionHistory(m.db, p).map((r) => positionItem(m.db, r)),
  };
}

// the one dry powder position meant: by the portfolio and the currency
// named, else refused with the candidates so the owner is asked
function dryPowderOf(
  m: Markets,
  portfolio: Ref | null,
  change: PositionChange,
): number | Failure {
  const p = findPortfolio(m.db, portfolio);
  if (isFailure(p)) return p;
  const named = (change.by ?? change.amount)?.currency ?? null;
  const all = readPositions(m.db, { portfolio: p?.id ?? null }).filter(
    (x) => x.kind === "cash" && x.dryPowder,
  );
  const fit = named === null ? all : all.filter((x) => x.currency === named);
  const pick = fit.length === 1 ? fit : named === null ? [] : all;
  if (pick.length === 1) return pick[0]!.id;
  if (all.length === 0) return notFound("no dry powder is kept");
  return {
    error: "bad_arguments",
    message: "several dry powder positions; name one by its id",
    positions: all.map((x) => ({
      id: x.id,
      name: x.name,
      currency: x.currency,
      portfolio: readPortfolio(m.db, x.portfolio)?.name ?? null,
    })),
  };
}

// a removal is a stamp: the row stays, restorable
export async function setTradeState(
  m: Markets,
  who: Who,
  id: number,
  removed: boolean,
): Promise<{ trade: ReturnType<typeof tradeItem> } | Failure> {
  const done = await m.writer.write((db): Failure | null | number => {
    const t = readTrade(db, id);
    if (t === null) return null;
    // a second removal keeps who removed it first
    if (removed === (t.removedAt !== null)) return id;
    const i = readInstrument(db, t.instrument);
    if (i !== null) {
      const before = partTrades(db, t);
      const after = removed
        ? before.filter((x) => x.id !== id)
        : [...before, { ...t, removedAt: null, removedBy: null }];
      const sales = newlyOversold(before, after, splitsOf(db, i.id));
      const sale = sales.find((x) => x.id !== id);
      if (sale !== undefined) return conflict(undoesSale(sale));
      if (sales.length > 0) return conflict(SELLS_PAST);
    }
    setTradeRemoved(db, id, removed ? who.name : null, m.clock.now());
    return id;
  });
  if (done === null) return notFound(`no trade ${id}`);
  if (isFailure(done)) return done;
  return { trade: tradeItem(m.db, readTrade(m.db, id)!) };
}

export async function setPositionState(
  m: Markets,
  who: Who,
  id: number,
  removed: boolean,
): Promise<{ position: ReturnType<typeof positionItem> } | Failure> {
  const done = await m.writer.write((db): number | null | Failure => {
    const p = readPosition(db, id);
    if (p === null) return null;
    // a second removal keeps who removed it first
    if (removed === (p.removedAt !== null)) return id;
    if (!removed) {
      // a restore puts every other live row of its chain out of the way,
      // whatever the updates changed; cash and a hand price also a live
      // row of their name, while two equal bond purchases are two bonds
      const out = new Set(
        chainOf(db, id)
          .filter((x) => x.removedAt === null)
          .map((x) => x.id),
      );
      const same = p.kind === "bond" ? null : samePosition(db, p);
      if (same !== null) out.add(same.id);
      out.delete(id);
      for (const x of out) setPositionRemoved(db, x, who.name, m.clock.now());
    }
    setPositionRemoved(db, id, removed ? who.name : null, m.clock.now());
    return id;
  });
  if (done === null) return notFound(`no position ${id}`);
  if (isFailure(done)) return done;
  return { position: positionItem(m.db, readPosition(m.db, id)!) };
}

// a portfolio named beside a row's id must be the row's own
function otherPortfolio(
  m: Markets,
  portfolio: Ref | null,
  kind: "trade" | "position",
  id: number,
): Failure | null {
  if (portfolio === null) return null;
  const p = findPortfolio(m.db, portfolio);
  if (isFailure(p)) return p;
  const row = kind === "trade" ? readTrade(m.db, id) : readPosition(m.db, id);
  if (row === null || p === null || row.portfolio === p.id) return null;
  const its = readPortfolio(m.db, row.portfolio)?.name ?? "another portfolio";
  return {
    error: "bad_arguments",
    message: `${kind} ${id} is in ${its}, not ${p.name}`,
  };
}

const nameArg = (value: unknown, name = "name") => text(value, name, MAX_NAME);

const conflict = (message: string): Failure => ({ error: "conflict", message });

export async function createPortfolio(m: Markets, body: unknown) {
  const f = fields(body, ["name"]);
  const name = nameArg(f.name);
  const done = await m.writer.write((db): number | Failure => {
    // every total converts into it, and none is assumed for the owner
    if (displayCurrency(db) === null) {
      return conflict("Set a display currency first.");
    }
    if (portfolioByName(db, name) !== null) {
      return conflict("a portfolio has this name");
    }
    return insertPortfolio(db, name, m.clock.now());
  });
  if (isFailure(done)) return done;
  return { portfolio: portfolioItem(m.db, readPortfolio(m.db, done)!) };
}

export async function updatePortfolio(m: Markets, id: number, body: unknown) {
  const f = fields(body, ["name"]);
  const name = nameArg(f.name);
  const done = await m.writer.write((db): Portfolio | Failure | null => {
    const p = readPortfolio(db, id);
    if (p === null) return null;
    const other = portfolioByName(db, name);
    if (other !== null && other.id !== id) {
      return conflict("a portfolio has this name");
    }
    renamePortfolio(db, id, name);
    return readPortfolio(db, id)!;
  });
  if (done === null) return notFound(`no portfolio ${id}`);
  if (isFailure(done)) return done;
  return { portfolio: portfolioItem(m.db, done) };
}

export async function removePortfolio(m: Markets, id: number) {
  const done = await m.writer.write((db): Failure | null | true => {
    if (readPortfolio(db, id) === null) return null;
    // removed rows go with it: kept for a restore, never a reason to stay
    if (portfolioRows(db, id) > 0) {
      return conflict("the portfolio holds trades or positions");
    }
    deletePortfolio(db, id);
    return true;
  });
  if (done === null) return notFound(`no portfolio ${id}`);
  return done;
}

export async function createBroker(m: Markets, body: unknown) {
  const f = fields(body, ["name"]);
  const name = nameArg(f.name);
  const done = await m.writer.write((db): number | Failure => {
    if (brokerByName(db, name) !== null)
      return conflict("a broker has this name");
    return insertBroker(db, name, m.clock.now());
  });
  if (isFailure(done)) return done;
  return { broker: brokerItem(readBroker(m.db, done)!) };
}

export async function updateBroker(m: Markets, id: number, body: unknown) {
  const f = fields(body, ["name"]);
  const name = nameArg(f.name);
  const done = await m.writer.write((db): Broker | Failure | null => {
    if (readBroker(db, id) === null) return null;
    const other = brokerByName(db, name);
    if (other !== null && other.id !== id)
      return conflict("a broker has this name");
    renameBroker(db, id, name);
    return readBroker(db, id)!;
  });
  if (done === null) return notFound(`no broker ${id}`);
  if (isFailure(done)) return done;
  return { broker: brokerItem(done) };
}

export async function removeBroker(m: Markets, id: number) {
  const done = await m.writer.write((db): Failure | null | true => {
    if (readBroker(db, id) === null) return null;
    // removed rows lose the name instead
    if (brokerRows(db, id) > 0) {
      return conflict("trades or positions name this broker");
    }
    deleteBroker(db, id);
    return true;
  });
  if (done === null) return notFound(`no broker ${id}`);
  return done;
}

export const settingsItem = (db: Db) => ({
  display_currency: displayCurrency(db),
  time_zone: timeZone(db),
});

// each can be changed, never cleared; one left out is kept
export async function saveSettings(m: Markets, body: unknown) {
  const f = fields(body, ["display_currency", "time_zone"]);
  if (f.display_currency === undefined && f.time_zone === undefined) {
    throw new ArgError("settings take display_currency, time_zone or both");
  }
  const c = namedCurrency(f.display_currency, "display_currency");
  if (f.display_currency !== undefined && c === null) {
    throw new ArgError(
      "display_currency must be an ISO 4217 currency code in circulation, such as EUR",
    );
  }
  const z = zoneArg(f.time_zone);
  if (f.time_zone !== undefined && z === null) {
    throw new ArgError(
      "time_zone must be an IANA time zone, such as America/New_York",
    );
  }
  await m.writer.write((db) => {
    const now = m.clock.now();
    if (c !== null) setDisplayCurrency(db, c, now);
    if (z !== null) setTimeZone(db, z, now);
  });
  return settingsItem(m.db);
}

// ---- the tool ------------------------------------------------------------

// a new owner's first steps in one call; a name already there is kept,
// so a retried setup makes nothing twice
async function setup(
  m: Markets,
  args: Extract<PortfolioArgs, { action: "setup" }>,
) {
  const made: string[] = [];
  const done = await m.writer.write((db): Failure | null => {
    const now = m.clock.now();
    // every check before any write, so a refused setup saves nothing
    // the owner's own setting: an agent passing one out of habit never
    // changes it, only sets the first
    const shown = displayCurrency(db);
    if (args.currency !== null && shown !== null && shown !== args.currency) {
      return conflict(
        `the display currency is ${shown}; the owner changes it in the web UI's settings`,
      );
    }
    // the same rule for the owner's zone
    const zone = timeZone(db);
    if (args.zone !== null && zone !== null && zone !== args.zone) {
      return conflict(
        `the time zone is ${zone}; the owner changes it in the web UI's settings`,
      );
    }
    const newPortfolio =
      args.portfolio !== null && portfolioByName(db, args.portfolio) === null;
    // every total converts into it, and none is assumed for the owner
    if (newPortfolio && (shown ?? args.currency) === null) {
      return conflict(
        "name display_currency too, the currency totals are shown in: ask the owner, never assume one",
      );
    }
    if (args.currency !== null && shown === null) {
      setDisplayCurrency(db, args.currency, now);
    }
    if (args.zone !== null && zone === null) setTimeZone(db, args.zone, now);
    if (newPortfolio) {
      insertPortfolio(db, args.portfolio!, now);
      made.push(`portfolio ${args.portfolio}`);
    }
    for (const name of args.brokers) {
      if (brokerByName(db, name) !== null) continue;
      insertBroker(db, name, now);
      made.push(`broker ${name}`);
    }
    return null;
  });
  if (done !== null) return done;
  return { ...listAll(m), made };
}

// by its name, as an agent knows it; the routes' rename and its refusals
async function renameBrokerNamed(
  m: Markets,
  args: Extract<PortfolioArgs, { action: "rename_broker" }>,
) {
  const b = findBroker(m.db, args.broker);
  if (isFailure(b)) return b;
  return updateBroker(m, b!.id, { name: args.name });
}

const answered = (body: object | Failure): ToolResult =>
  isFailure(body) ? errorResult(body) : textResult(JSON.stringify(body));

function offsetOf(next: string | null, args: object): number {
  if (next === null) return 0;
  const at = readCursor(next, args);
  if (at === null || !/^\d{1,9}$/.test(at)) {
    throw new ArgError("next does not continue this list");
  }
  return Number(at);
}

async function holdingsPage(
  m: Markets,
  args: Extract<PortfolioArgs, { action: "holdings" }>,
): Promise<ToolResult> {
  const { next, ...rest } = args;
  const from = offsetOf(next, rest);
  const read = await readHoldings(m, rest);
  if (isFailure(read)) return errorResult(read);
  const { holdings: rows, ...shell } = read;
  const list = rows.slice(from);
  const page = fitPage(
    list,
    (count) => ({
      ...shell,
      next:
        from + count < rows.length ? cursor(String(from + count), rest) : null,
    }),
    "holdings",
  );
  return textResult(page.text);
}

function tradesPage(
  m: Markets,
  args: Extract<PortfolioArgs, { action: "trades" }>,
): ToolResult {
  const { next, ...rest } = args;
  const from = offsetOf(next, rest);
  const all = readTradeList(m, rest);
  if (isFailure(all)) return errorResult(all);
  const list = all.slice(from);
  const page = fitPage(
    list,
    (count) => ({
      count: all.length,
      next:
        from + count < all.length ? cursor(String(from + count), rest) : null,
    }),
    "trades",
  );
  return textResult(page.text);
}

export async function portfolioAnswer(
  m: Markets,
  who: Who,
  args: PortfolioArgs,
): Promise<ToolResult> {
  const writes =
    args.action === "setup" ||
    args.action === "add" ||
    args.action === "update" ||
    args.action === "remove" ||
    args.action === "restore" ||
    args.action === "rename_broker";
  if (!opens(who.portfolio, writes)) {
    return errorResult(forbidden(writes));
  }
  switch (args.action) {
    case "setup":
      return answered(await setup(m, args));
    case "list":
      return textResult(JSON.stringify(listAll(m)));
    case "rename_broker":
      return answered(await renameBrokerNamed(m, args));
    case "holdings":
      return holdingsPage(m, args);
    case "trades":
      return tradesPage(m, args);
    case "add":
      return answered(
        "trade" in args
          ? await addTrade(m, who, args.trade)
          : await addPosition(m, who, args.position),
      );
    case "update": {
      const id =
        args.position === "dry_powder"
          ? dryPowderOf(m, args.portfolio, args.change)
          : args.position;
      if (typeof id !== "number") return errorResult(id);
      const wrong = otherPortfolio(m, args.portfolio, "position", id);
      if (wrong !== null) return errorResult(wrong);
      return answered(await updatePosition(m, who, id, args.change));
    }
    case "remove":
    case "restore": {
      const removed = args.action === "remove";
      const wrong =
        args.trade !== null
          ? otherPortfolio(m, args.portfolio, "trade", args.trade)
          : otherPortfolio(m, args.portfolio, "position", args.position!);
      if (wrong !== null) return errorResult(wrong);
      return answered(
        args.trade !== null
          ? await setTradeState(m, who, args.trade, removed)
          : await setPositionState(m, who, args.position!, removed),
      );
    }
  }
}
