// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// Portfolios for the tool and the API alike. Holdings are private: no
// message here quotes a quantity, a price or a value, and nothing is logged.

import { iso } from "../market/format.ts";
import { type Instrument, readInstrument } from "../market/instruments.ts";
import { readQuote } from "../market/quotes.ts";
import { markRead } from "../market/tracking.ts";
import { checkZone, localDate } from "../market/zone.ts";
import { standing } from "../portfolios/balances.ts";
import { writeFundHoldings } from "../portfolios/fund-holdings.ts";
import {
  buyPrice,
  dropBuyPrice,
  type Fund,
  type FundPrice,
  fundByIsin,
  fundByName,
  fundKey,
  fundPrices,
  insertFund,
  isFund,
  isFundKey,
  latestPrice,
  listFunds,
  type NewFund,
  priceOn,
  readFund,
  seesFund,
  setFundDetails,
  setFundMarket,
  setFundPrice,
} from "../portfolios/funds.ts";
import { missingPairs, rates } from "../portfolios/fx.ts";
import { type Growth, growth } from "../portfolios/growth.ts";
import {
  type Broker,
  brokerByName,
  brokerRows,
  CASH_NAME,
  cashPortfolio,
  chainOf,
  deleteBroker,
  deletePortfolio,
  displayCurrency,
  ensureCash,
  entriesOf,
  insertBroker,
  insertPortfolio,
  insertPosition,
  insertTrade,
  isCashName,
  knownMarkets,
  listBrokers,
  listPortfolios,
  liveTradesOf,
  MAX_NAME,
  MAX_NOTE,
  MAX_POSITION_NAME,
  movePortfolio,
  type NewPosition,
  type NewTrade,
  type Portfolio,
  type Position,
  type PositionKind,
  portfolioByName,
  portfolioRows,
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
import { recheck } from "../server/caller.ts";
import { inCirculation, isCurrencyCode } from "../shared/currencies.ts";
import { isIsin } from "../shared/isin.ts";
import { FRED, FUND_MARKET, FUND_SOURCE } from "../sources/ids.ts";
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
import {
  type FundHoldingsArgs,
  fundHoldingsAnswer,
  holdingsEntry,
  olderHoldings,
  parseHoldings,
} from "./funds.ts";
import type { Markets } from "./markets.ts";
import { readTargets } from "./targets.ts";
import { opens, type Who } from "./who.ts";

export const ADD_KINDS = ["trade", "cash", "fund", "bond"] as const;
export type AddKind = (typeof ADD_KINDS)[number];

// no larger number is a real holding, and none can round to another
export const MAX_AMOUNT = 1e12;

const NO_READ = "this key has no portfolio access; its owner grants it";
const NO_WRITE = "this key reads portfolios only; its owner grants write";

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

// a buy or sell of a fund the owner prices, named by its ISIN or, once
// made, its name; the first buy makes it
export type FundTradeArgs = {
  isin: string | null;
  name: string | null;
  // the market its money is in; null leaves it as it is
  market: string | null;
  trade: Omit<TradeArgs, "symbol">;
};

// a fund's price for a day, the market its money is in, and its name and
// currency set right
export type FundChange = {
  price?: number;
  // the day the price is for, the owner's today by default
  date?: string;
  // null takes it off
  market?: string | null;
  name?: string;
  // only while no live trade is priced in it
  currency?: string;
  holdings?: FundHoldingsArgs;
};

export type PositionArgs = {
  kind: PositionKind;
  portfolio: Ref | null;
  name: string;
  symbol: string | null;
  currency: string | null;
  amount: number | null;
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
  // refused: only a fund takes a price
  price?: number;
  cost?: number | null;
  date?: string;
  note?: string | null;
  dryPowder?: boolean;
  name?: string;
  // null takes it off
  broker?: string | null;
  // a term deposit's last day, null takes it off; a bond's never changes
  maturity?: string | null;
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
  | ({
      action: "holdings";
      // adds the cash and bond rows removed and not replaced
      removed: boolean;
      next: string | null;
    } & HoldingsArgs)
  | ({ action: "trades"; next: string | null } & TradesArgs)
  | { action: "history"; position: number }
  | { action: "add"; kind: "trade"; trade: TradeArgs }
  | { action: "add"; kind: "fund"; fund: FundTradeArgs }
  | { action: "add"; kind: PositionKind; position: PositionArgs }
  | {
      action: "update";
      position: number;
      // the tool's kind: a row of the other kind is refused
      kind: PositionKind;
      change: PositionChange;
    }
  | {
      action: "update";
      // its ISIN or name
      fund: string;
      change: FundChange;
    }
  | { action: "rename_broker"; broker: string; name: string }
  | { action: "remove" | "restore"; trade: number; portfolio: Ref | null }
  | { action: "remove" | "restore"; position: number; kind: PositionKind };

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

// a fund names the market of the shares it holds; cash and a bond never do
export const NO_POSITION_MARKET =
  "cash has no market, it counts by its currency; a bond's is its listing's";

export function rowId(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new ArgError(`${name} must be an id, a positive integer`);
  }
  return value;
}

export function parseTrade(f: Record<string, unknown>): TradeArgs {
  return { symbol: text(f.symbol, "symbol"), ...tradeFigures(f, "quantity") };
}

// a trade's figures, its quantity under a share's word or a fund's
function tradeFigures(
  f: Record<string, unknown>,
  units: "quantity" | "units",
): Omit<TradeArgs, "symbol"> {
  if (f.side !== "buy" && f.side !== "sell") {
    throw new ArgError("side must be buy or sell");
  }
  return {
    portfolio: ref(f.portfolio),
    side: f.side,
    quantity:
      f[units] === "all"
        ? f.side === "sell"
          ? "all"
          : (() => {
              throw new ArgError(`${units} all is a sell's`);
            })()
        : amount(f[units], units, { positive: true }),
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

// upper case, its check digit checked, so a typo never makes a fund
export function isinArg(value: unknown, name = "isin"): string | null {
  if (value === undefined || value === null) return null;
  const isin = text(value, name, 12).toUpperCase();
  if (!isIsin(isin)) {
    throw new ArgError(
      `${name} must be an ISIN: 2 letters, 9 letters or digits, and a check digit that matches`,
    );
  }
  return isin;
}

// units: the word its quantity comes under, the tool's quantity
export function parseFundTrade(
  f: Record<string, unknown>,
  units: "quantity" | "units" = "units",
): FundTradeArgs {
  const isin = isinArg(f.isin);
  const name = optionalName(f.name, "name", MAX_POSITION_NAME);
  if (isin === null && name === null) {
    throw new ArgError("a fund's trade names the fund by isin or name");
  }
  return {
    isin,
    name,
    market: optionalName(f.market, "market"),
    trade: tradeFigures(f, units),
  };
}

// renames: the fund is named by its ISIN, so a name is a new one; named
// by its name alone, the name only finds it
export function parseFundChange(
  f: Record<string, unknown>,
  renames: boolean,
): FundChange {
  const c: FundChange = {};
  for (const name of Object.keys(f)) {
    if (!FUND_UPDATE.includes(name)) {
      throw new ArgError(
        `a fund's update takes ${FUND_UPDATE.filter((n) => n !== "isin").join(", ")}, not ${quoted(name)}`,
      );
    }
  }
  if (renames && f.name !== undefined) {
    c.name = text(f.name, "name", MAX_POSITION_NAME);
  }
  if (f.currency !== undefined) {
    const code = currencyArg(f.currency);
    if (code === null) throw new ArgError("currency must be a currency code");
    c.currency = code;
  }
  if (f.price !== undefined) c.price = amount(f.price, "price");
  if (f.date !== undefined) {
    const d = date(f.date, "date");
    if (d === null) throw new ArgError("date must be a date, YYYY-MM-DD");
    if (c.price === undefined) throw new ArgError("date goes with price");
    c.date = d;
  }
  if (f.market !== undefined) c.market = optionalName(f.market, "market");
  if (f.holdings !== undefined) c.holdings = parseHoldings(f.holdings);
  if (
    c.price === undefined &&
    c.market === undefined &&
    c.name === undefined &&
    c.currency === undefined &&
    c.holdings === undefined
  ) {
    throw new ArgError(
      renames
        ? "a fund's update changes price, market, name, currency or holdings"
        : "a fund's update changes price, market, currency or holdings; named by its isin or symbol, its name too",
    );
  }
  return c;
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
    cost: optionalAmount(f.cost, "cost"),
    coupon: null,
    maturity: null,
    date: date(f.date, "date"),
    broker: optionalName(f.broker, "broker"),
    note: note(f.note),
    dryPowder: false,
  };
  if (f.market !== undefined) throw new ArgError(NO_POSITION_MARKET);
  if (kind === "cash") {
    if (base.cost !== null) throw new ArgError("cash has no cost");
    if (f.dry_powder !== undefined && typeof f.dry_powder !== "boolean") {
      throw new ArgError("dry_powder must be true or false");
    }
    return {
      ...base,
      amount: amount(f.amount, "amount"),
      maturity: date(f.maturity, "maturity"),
      dryPowder: f.dry_powder === true,
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

// what a position's update changes; currency goes with amount or by
export const UPDATE_FIELDS = [
  "amount",
  "by",
  "cost",
  "date",
  "note",
  "dry_powder",
  "name",
  "broker",
  "maturity",
] as const;

// a fund's update: its price for a day and its market; kind and
// portfolio are passed out of habit
const FUND_UPDATE = [
  "action",
  "isin",
  "name",
  "price",
  "date",
  "market",
  "currency",
  "holdings",
  "kind",
  "portfolio",
];

export function parseChange(
  f: Record<string, unknown>,
  named: readonly string[] = UPDATE_FIELDS,
): PositionChange {
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
  if (f.market !== undefined) throw new ArgError(NO_POSITION_MARKET);
  if (f.name !== undefined) c.name = text(f.name, "name", MAX_POSITION_NAME);
  if (f.broker !== undefined) c.broker = optionalName(f.broker, "broker");
  if (f.maturity !== undefined) c.maturity = date(f.maturity, "maturity");
  if (Object.keys(c).length === 0) {
    throw new ArgError(`update changes at least one of ${named.join(", ")}`);
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
    "maturity",
  ],
  fund: [
    "isin",
    "name",
    "side",
    "units",
    "price",
    "total",
    "fees",
    "date",
    "currency",
    "broker",
    "note",
    "market",
    "again",
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
export function brokerNames(value: unknown): string[] {
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

export const nextOf = (v: unknown): string | null => {
  if (v === undefined || v === null) return null;
  if (typeof v !== "string") {
    throw new ArgError("next must be a string from an earlier answer");
  }
  return v;
};

// ---- resolving names -----------------------------------------------------

const notFound = (message: string): Failure => ({
  error: "not_found",
  message,
});

// the owner's own: another person's id or name reads as none
export function findPortfolio(
  db: Db,
  owner: string,
  r: Ref | null,
): Portfolio | Failure | null {
  if (r === null) return null;
  const p =
    typeof r === "number"
      ? readPortfolio(db, owner, r)
      : (portfolioByName(db, owner, r) ??
        (/^\d+$/.test(r) ? readPortfolio(db, owner, Number(r)) : null));
  if (p !== null) return p;
  const names = listPortfolios(db, owner).map((x) => x.name);
  return notFound(
    names.length === 0
      ? "no portfolio yet; make one first"
      : `no portfolio ${quoted(String(r))}; portfolios: ${names.join(", ")}`,
  );
}

export const CASH_ONLY = `${CASH_NAME} holds only cash; name another portfolio`;
export const CASH_LIVES = `cash lives in ${CASH_NAME}; leave portfolio out`;
export const NAME_KEPT = `the name ${CASH_NAME} is kept for cash`;

// a trade, fund or bond: never Cash; with none named, the only other one
function portfolioFor(
  db: Db,
  owner: string,
  r: Ref | null,
): Portfolio | Failure {
  const found = findPortfolio(db, owner, r);
  if (found !== null && !isFailure(found) && found.cash) {
    return { error: "bad_arguments", message: CASH_ONLY };
  }
  if (found !== null) return found;
  const all = listPortfolios(db, owner).filter((p) => !p.cash);
  if (all.length === 1) return all[0]!;
  return {
    error: "bad_arguments",
    message:
      all.length === 0
        ? "no portfolio for investments yet; make one first"
        : `name a portfolio: ${all.map((p) => p.name).join(", ")}`,
  };
}

// cash goes to Cash alone, named or not
function cashFor(db: Db, owner: string, r: Ref | null): Portfolio | Failure {
  const found = findPortfolio(db, owner, r);
  if (found !== null && isFailure(found)) return found;
  if (found !== null && !found.cash) {
    return { error: "bad_arguments", message: CASH_LIVES };
  }
  return (
    cashPortfolio(db, owner) ??
    conflict(
      `no ${CASH_NAME} portfolio yet; setup makes it with the display currency`,
    )
  );
}

export function findBroker(
  db: Db,
  owner: string,
  name: string | null,
): Broker | Failure | null {
  if (name === null) return null;
  const b = brokerByName(db, owner, name);
  if (b !== null) return b;
  const names = listBrokers(db, owner).map((x) => x.name);
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

export const portfolioItem = (db: Db, owner: string, p: Portfolio) => ({
  id: p.id,
  name: p.name,
  // the one that holds all cash: fixed, never renamed or removed
  cash: p.cash,
  trades: readTrades(db, owner, { portfolio: p.id }).length,
  positions: readPositions(db, owner, { portfolio: p.id }).length,
  created_at: iso(p.createdAt),
});

export const brokerItem = (b: Broker) => ({ id: b.id, name: b.name });

// a fund the owner prices, with its latest price and that price's day
export function fundItem(db: Db, f: Fund) {
  const p = latestPrice(db, f.id);
  return {
    id: f.id,
    isin: f.isin,
    name: f.name,
    currency: f.currency,
    market: f.market,
    price: p?.price ?? null,
    as_of: p?.date ?? null,
  };
}

// a price is shared, but who entered it and the buy it came from are only
// its own person's to see
const priceItem = (owner: string, p: FundPrice) => {
  const own = p.user === owner;
  return {
    date: p.date,
    price: p.price,
    trade: own ? p.trade : null,
    entered_by: own ? p.enteredBy : null,
    entered_at: iso(p.enteredAt),
  };
};

export function listAll(m: Markets, owner: string) {
  return {
    display_currency: displayCurrency(m.db, owner),
    time_zone: timeZone(m.db, owner),
    portfolios: listPortfolios(m.db, owner).map((p) =>
      portfolioItem(m.db, owner, p),
    ),
    brokers: listBrokers(m.db, owner).map(brokerItem),
    // what a fund can name as the market its money is in
    markets: knownMarkets(m.db),
    funds: listFunds(m.db, owner).map((f) => fundItem(m.db, f)),
  };
}

export function tradeItem(db: Db, owner: string, t: Trade) {
  const i = readInstrument(db, t.instrument);
  const f = splitFactor(splitsOf(db, t.instrument), statedOf(t));
  const p = readPortfolio(db, owner, t.portfolio);
  const b = t.broker === null ? null : readBroker(db, owner, t.broker);
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

export function positionItem(db: Db, owner: string, p: Position) {
  const pf = readPortfolio(db, owner, p.portfolio);
  const b = p.broker === null ? null : readBroker(db, owner, p.broker);
  return {
    id: p.id,
    kind: p.kind,
    portfolio: pf?.name ?? null,
    portfolio_id: p.portfolio,
    name: p.name,
    symbol: p.instrument,
    currency: p.currency,
    amount: p.amount,
    cost: p.cost,
    coupon: p.coupon,
    maturity: p.maturity,
    as_of: p.asOf,
    ...(p.kind === "cash" ? { dry_powder: p.dryPowder } : {}),
    broker: b?.name ?? null,
    note: p.note,
    replaces: p.replaces,
    ...(p.pastOf === null ? {} : { past: true }),
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
  owner: string,
  args: HoldingsArgs,
): Promise<HoldingsAnswer | Failure> {
  const p = findPortfolio(m.db, owner, args.portfolio);
  if (isFailure(p)) return p;
  const b = findBroker(m.db, owner, args.broker);
  if (isFailure(b)) return b;
  const shown = displayCurrency(m.db, owner);
  const currency = args.currency ?? shown;
  const scope = {
    owner,
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
      portfolios: listPortfolios(m.db, owner),
      brokers: listBrokers(m.db, owner),
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

// the past year's growth, from stored rows only: never a fetch, so a
// page drawing it never waits on a source
export function readGrowth(
  m: Markets,
  owner: string,
  args: { portfolio: Ref | null; currency: string | null },
): Growth | Failure {
  const p = findPortfolio(m.db, owner, args.portfolio);
  if (isFailure(p)) return p;
  const currency = args.currency ?? displayCurrency(m.db, owner);
  if (currency === null) {
    return {
      error: "bad_arguments",
      message: "no display currency is set; name a currency",
    };
  }
  const now = m.clock.now();
  return growth(
    m.db,
    {
      owner,
      portfolios: listPortfolios(m.db, owner),
      brokers: listBrokers(m.db, owner),
      portfolio: p?.id ?? null,
      currency,
    },
    ownerToday(m.db, owner, now),
    now,
    m.quoteEveryMs,
  );
}

export function readTradeList(
  m: Markets,
  owner: string,
  args: TradesArgs,
): ReturnType<typeof tradeItem>[] | Failure {
  const p = findPortfolio(m.db, owner, args.portfolio);
  if (isFailure(p)) return p;
  const b = findBroker(m.db, owner, args.broker);
  if (isFailure(b)) return b;
  let instrument: string | null = null;
  if (args.symbol !== null) {
    const upper = args.symbol.toUpperCase();
    // a trade names its instrument by id; a bare symbol matches any market
    const ids = new Set(
      readTrades(m.db, owner, { removed: true }).map((t) => t.instrument),
    );
    instrument =
      [...ids].find((id) => id.toUpperCase() === upper) ??
      [...ids].find((id) => id.slice(id.indexOf(":") + 1) === upper) ??
      [...ids].find((id) => readInstrument(m.db, id)?.sourceSymbol === upper) ??
      `${upper}\u0000`;
  }
  return readTrades(m.db, owner, {
    portfolio: p?.id ?? null,
    broker: b?.id ?? null,
    instrument,
    from: args.from,
    to: args.to,
    removed: args.removed,
  }).map((t) => tradeItem(m.db, owner, t));
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
export const ownerToday = (db: Db, owner: string, now: number): string =>
  localDate(timeZone(db, owner) ?? "UTC", now);

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
  owner: string,
  portfolio: number,
  i: Instrument,
  day: string,
): { broker: number | null; quantity: number }[] {
  const splits = splitsOf(m.db, i.id);
  const byBroker = new Map<number | null, Trade[]>();
  // oldest first, so the parts answer in the order they were opened
  for (const t of readTrades(m.db, owner, {
    portfolio,
    instrument: i.id,
  }).reverse()) {
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
  // a fund's key, as holdings and trades answer it, names the fund
  if (isFundKey(args.symbol)) {
    const f = fundByIsin(m.db, args.symbol);
    if (f === null) return notFound(`${quoted(args.symbol)}: ${NO_FUND}`);
    return addTradeOn(m, who, args, readInstrument(m.db, f.id)!, null);
  }
  const i = await instrumentOf(m, args.symbol);
  if (isFailure(i)) return i;
  return addTradeOn(m, who, args, i, null);
}

const NO_FUND = "no such fund; its first buy makes it, with its isin";

// make: a fund new with this trade, made in the trade's own write after
// every check, so a refused trade makes none
async function addTradeOn(
  m: Markets,
  who: Who,
  args: TradeArgs,
  i: Instrument,
  make: { fund: NewFund } | { market: string | null } | null,
): Promise<Added | Failure> {
  const owner = who.user;
  const p = portfolioFor(m.db, owner, args.portfolio);
  if (isFailure(p)) return p;
  const b = findBroker(m.db, owner, args.broker);
  if (isFailure(b)) return b;
  const fund = isFund(i);
  // a fund's day is the owner's: it trades on no exchange
  const day =
    args.date ??
    (fund
      ? ownerToday(m.db, owner, m.clock.now())
      : localDate(i.zone, m.clock.now()));
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
    const held = heldOn(m, owner, p.id, i, day).filter(
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
  } else if (price === null && fund) {
    return {
      error: "bad_arguments",
      message: "a fund has no live price; name its price or total",
    };
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
    recheck(db);
    const now = m.clock.now();
    // made by another call since this one looked: that one stands
    const making =
      make !== null && "fund" in make && readFund(db, i.id) === null
        ? make.fund
        : null;
    if (making !== null) {
      const taken = fundByName(db, making.name);
      if (taken !== null) return nameTaken(db, owner, taken);
    } else if (readInstrument(db, i.id) === null) {
      return notFound(`${i.id}: deleted while the trade was added`);
    }
    if (!args.again) {
      const since = now - RETRY_MS;
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
    if (oversells(db, owner, rows, i)) {
      return { error: "bad_arguments", message: OVERSOLD };
    }
    if (making !== null) insertFund(db, making, who.name, now);
    const ids = rows.map((row) => insertTrade(db, row, now));
    if (make !== null && "market" in make && make.market !== null) {
      setFundMarket(db, i.id, make.market);
    }
    // a fund added from one confirmation is valued at once
    if (fund) {
      for (const id of ids) buyPrice(db, readTrade(db, owner, id)!, now);
    }
    return ids;
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
      const where = heldOn(m, owner, p.id, i, day);
      if (where.some((x) => x.broker !== null)) {
        const names = where.map((x) =>
          x.broker === null
            ? `${exact(x.quantity)} with no broker`
            : `${readBroker(m.db, owner, x.broker)?.name ?? "a broker"} ${exact(x.quantity)}`,
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
  const items = done.map((id) =>
    tradeItem(m.db, owner, readTrade(m.db, owner, id)!),
  );
  return {
    ...(items.length === 1 ? { trade: items[0]! } : { trades: items }),
    ...(live === undefined ? {} : { live_price: live }),
    ...(total === undefined ? {} : { total }),
  };
}

// fund names are shared, so one taken by a fund the caller never held is
// refused without naming that fund
function nameTaken(db: Db, owner: string, taken: Fund): Failure {
  return conflict(
    seesFund(db, owner, taken.id)
      ? `the fund ${taken.isin} has this name; name a new fund apart`
      : "a fund has this name; name a new fund apart",
  );
}

// a fund the owner holds or priced, named by its ISIN or name; any other
// reads as unknown, and an unknown name lists the funds they see
export function findFund(db: Db, owner: string, named: string): Fund | Failure {
  const found =
    isIsin(named.trim().toUpperCase()) || isFundKey(named)
      ? fundByIsin(db, named)
      : fundByName(db, named);
  const f = found !== null && seesFund(db, owner, found.id) ? found : null;
  if (f !== null) return f;
  const all = listFunds(db, owner);
  return notFound(
    all.length === 0
      ? `no fund ${quoted(named)}; none is kept yet`
      : `no fund ${quoted(named)}; funds: ${all.map((x) => `${x.name} (${x.isin})`).join(", ")}`,
  );
}

// a buy or sell of a fund the owner prices; its first buy makes it, with
// its ISIN, name and currency
export async function addFundTrade(
  m: Markets,
  who: Who,
  args: FundTradeArgs,
): Promise<(Added & { fund: ReturnType<typeof fundItem> }) | Failure> {
  const market = findMarket(m.db, args.market);
  if (isFailure(market)) return market;
  // by its ISIN a fund is found whoever holds it: the ISIN is the fund
  const kept =
    args.isin === null
      ? findFund(m.db, who.user, args.name!)
      : fundByIsin(m.db, args.isin);
  if (kept !== null && isFailure(kept)) return kept;
  // a name that is not the fund's is a mistake, never ignored
  if (
    kept !== null &&
    args.isin !== null &&
    args.name !== null &&
    args.name.toLowerCase() !== kept.name.toLowerCase()
  ) {
    return {
      error: "bad_arguments",
      message: `the fund ${kept.isin} is named ${quoted(kept.name)}; leave name out, or rename it with update`,
    };
  }
  let done: Added | Failure;
  if (kept !== null) {
    done = await addTradeOn(
      m,
      who,
      { ...args.trade, symbol: kept.id },
      readInstrument(m.db, kept.id)!,
      market === kept.market ? null : { market },
    );
  } else {
    if (args.trade.side === "sell") {
      return notFound(`no fund ${args.isin}; its first trade is a buy`);
    }
    if (args.name === null) {
      return {
        error: "bad_arguments",
        message: `no fund ${args.isin} yet; its first buy names it`,
      };
    }
    if (args.trade.currency === null) {
      return {
        error: "bad_arguments",
        message: `no fund ${args.isin} yet; its first buy names its currency`,
      };
    }
    const fund: NewFund = {
      isin: args.isin!,
      name: args.name,
      currency: args.trade.currency,
      market,
    };
    const now = m.clock.now();
    done = await addTradeOn(
      m,
      who,
      { ...args.trade, symbol: fundKey(fund.isin) },
      {
        id: fundKey(fund.isin),
        market: FUND_MARKET,
        symbol: fund.isin,
        source: FUND_SOURCE,
        sourceSymbol: fund.isin,
        exchange: "",
        name: fund.name,
        type: "FUND",
        currency: fund.currency,
        unit: "per_share",
        zone: "UTC",
        addedAt: now,
        updatedAt: now,
      },
      { fund },
    );
  }
  if (isFailure(done)) return done;
  const id = kept?.id ?? fundKey(args.isin!);
  return { ...done, fund: fundItem(m.db, readFund(m.db, id)!) };
}

// a price for a day: an entry for a day already priced replaces it, and
// earlier days are kept; a name or currency set right
export async function updateFund(
  m: Markets,
  who: Who,
  named: string,
  change: FundChange,
): Promise<
  | {
      fund: ReturnType<typeof fundItem>;
      price?: { date: string; price: number };
      replaced?: ReturnType<typeof priceItem> | null;
      renamed_from?: string;
      holdings?: ReturnType<typeof fundHoldingsAnswer>;
    }
  | Failure
> {
  const owner = who.user;
  // only a person holding it or who priced it changes it
  const kept = findFund(m.db, owner, named);
  if (isFailure(kept)) return kept;
  const market =
    change.market === undefined ? undefined : findMarket(m.db, change.market);
  if (isFailure(market)) return market;
  const day = change.date ?? ownerToday(m.db, owner, m.clock.now());
  if (day > latestDay(m.clock.now())) {
    return {
      error: "bad_arguments",
      message: "date is in the future",
    } as const;
  }
  if (
    change.holdings !== undefined &&
    change.holdings.asOf > latestDay(m.clock.now())
  ) {
    return {
      error: "bad_arguments",
      message: "holdings.as_of is in the future",
    } as const;
  }
  // refused before any symbol is fetched; checked again in the write
  if (change.holdings !== undefined) {
    const older = olderHoldings(m.db, kept.id, change.holdings);
    if (older !== null) return older;
  }
  // a holding's symbol may be fetched, so before the write
  const entry =
    change.holdings === undefined
      ? null
      : await holdingsEntry(m, change.holdings);
  if (entry !== null && isFailure(entry)) return entry;
  const replaced = await m.writer.write(
    (db): { before: FundPrice | null; name: string } | Failure => {
      recheck(db);
      const now = m.clock.now();
      const fund = readFund(db, kept.id)!;
      // every check before any write, so a refused update changes nothing
      if (change.name !== undefined) {
        const taken = fundByName(db, change.name);
        if (taken !== null && taken.id !== fund.id) {
          return nameTaken(db, owner, taken);
        }
      }
      // every holder's live trades, since their prices were in the old one
      if (
        change.currency !== undefined &&
        change.currency !== fund.currency &&
        liveTradesOf(db, fund.id) > 0
      ) {
        return {
          error: "bad_arguments",
          message:
            "a fund's currency changes only while it has no live trades; its owner removes them first",
        };
      }
      if (entry !== null) {
        const older = olderHoldings(db, kept.id, entry);
        if (older !== null) return older;
      }
      const before =
        change.price === undefined ? null : priceOn(db, kept.id, day);
      // a new currency drops the old prices, so a price sent with it comes after
      if (change.name !== undefined || change.currency !== undefined) {
        setFundDetails(db, kept.id, change, now);
      }
      if (change.price !== undefined) {
        setFundPrice(db, kept.id, day, change.price, who, now);
      }
      if (market !== undefined) setFundMarket(db, kept.id, market);
      if (entry !== null) writeFundHoldings(db, kept.id, entry, now);
      return { before, name: fund.name };
    },
  );
  if (isFailure(replaced)) return replaced;
  const after = readFund(m.db, kept.id)!;
  return {
    fund: fundItem(m.db, after),
    // said back, so a name sent beside the ISIN is seen to rename it
    ...(after.name === replaced.name ? {} : { renamed_from: replaced.name }),
    ...(change.price === undefined
      ? {}
      : {
          price: { date: day, price: change.price },
          replaced:
            replaced.before === null ? null : priceItem(owner, replaced.before),
        }),
    ...(entry === null ? {} : { holdings: fundHoldingsAnswer(m.db, kept.id) }),
  };
}

// a fund with every price it was given, newest first, and the owner's
// trades of it, never another holder's
export function fundDetail(m: Markets, owner: string, named: string) {
  const f = findFund(m.db, owner, named);
  if (isFailure(f)) return f;
  return {
    fund: fundItem(m.db, f),
    prices: fundPrices(m.db, f.id).map((p) => priceItem(owner, p)),
    trades: readTrades(m.db, owner, { instrument: f.id }).map((t) =>
      tradeItem(m.db, owner, t),
    ),
  };
}

// the part these rows touch, replayed whole with them added
function oversells(
  db: Db,
  owner: string,
  rows: readonly NewTrade[],
  i: Instrument,
): boolean {
  const first = rows[0]!;
  const splits = splitsOf(db, i.id);
  const brokers = new Set(rows.map((r) => r.broker));
  for (const broker of brokers) {
    const before = partTrades(db, owner, {
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
  const owner = who.user;
  const p =
    args.kind === "cash"
      ? cashFor(m.db, owner, args.portfolio)
      : portfolioFor(m.db, owner, args.portfolio);
  if (isFailure(p)) return p;
  const b = findBroker(m.db, owner, args.broker);
  if (isFailure(b)) return b;
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
  const day = args.date ?? ownerToday(m.db, owner, m.clock.now());
  if (day > latestDay(m.clock.now())) {
    return { error: "bad_arguments", message: "date is in the future" };
  }
  const row: NewPosition = {
    portfolio: p.id,
    kind: args.kind,
    name: args.name,
    currency,
    instrument: instrument?.id ?? null,
    amount: args.amount,
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
    recheck(db);
    const now = m.clock.now();
    const old = samePosition(db, row);
    // cash added again for a day before its row's is a past balance, as
    // an update with that date is, so the row's own figures stand
    if (old !== null && old.kind === "cash" && day < old.asOf) {
      if (
        args.amount === null ||
        args.note !== null ||
        args.cost !== null ||
        args.coupon !== null ||
        args.maturity !== null ||
        (args.dryPowder && !old.dryPowder)
      ) {
        return { error: "bad_arguments", message: PAST_ONLY } as Failure;
      }
      return {
        id: insertPosition(
          db,
          {
            ...row,
            maturity: old.maturity,
            dryPowder: old.dryPowder,
            pastOf: old.id,
          },
          now,
        ),
        replaced: null,
      };
    }
    if (old !== null) setPositionRemoved(db, owner, old.id, who.name, now);
    return {
      id: insertPosition(db, { ...row, replaces: old?.id ?? null }, now),
      replaced: old?.id ?? null,
    };
  });
  if (isFailure(done)) return done;
  return {
    position: positionItem(m.db, owner, readPosition(m.db, owner, done.id)!),
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
      // none for a past balance, which replaces nothing
      replaced: number | null;
      rate?: { from: string; to: string; rate: number; at: string | null };
    }
  | Failure
> {
  const owner = who.user;
  if (change.date !== undefined && change.date > latestDay(m.clock.now())) {
    return { error: "bad_arguments", message: "date is in the future" };
  }
  const row = readPosition(m.db, owner, id);
  if (row !== null && row.pastOf !== null) {
    return { error: "bad_arguments", message: PAST_FIXED };
  }
  if (
    row !== null &&
    row.kind === "cash" &&
    change.date !== undefined &&
    change.date < row.asOf
  ) {
    return addPastBalance(m, who, row, change);
  }
  const broker =
    change.broker === undefined
      ? undefined
      : findBroker(m.db, owner, change.broker);
  if (isFailure(broker)) return broker;
  const before = readPosition(m.db, owner, id);
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
    recheck(db);
    const old = readPosition(db, owner, id);
    if (old === null) return notFound(`no position ${id}`);
    if (old.removedAt !== null) {
      return conflict(
        `position ${id} was removed or updated; restore it first`,
      );
    }
    if (change.dryPowder === true && old.kind !== "cash") {
      return { error: "bad_arguments", message: "only cash is dry powder" };
    }
    if (change.maturity !== undefined && old.kind !== "cash") {
      return {
        error: "bad_arguments",
        message: "a bond's maturity never changes: remove it and add it again",
      };
    }
    const name = change.name ?? old.name;
    const at = broker === undefined ? old.broker : (broker?.id ?? null);
    // add takes cash of one name, broker and currency as one row
    if (old.kind === "cash" && (name !== old.name || at !== old.broker)) {
      const same = samePosition(db, { ...old, name, broker: at });
      if (same !== null && same.id !== id) {
        return conflict(
          `position ${same.id} has this name, broker and currency; update or remove it instead`,
        );
      }
    }
    if (
      old.kind === "cash" &&
      (change.price !== undefined || (change.cost ?? null) !== null)
    ) {
      return { error: "bad_arguments", message: "cash takes an amount" };
    }
    if (old.kind === "bond" && change.price !== undefined) {
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
    const revalued = old.kind === "cash" && given !== undefined;
    const asOf =
      change.date ?? (revalued ? ownerToday(db, owner, now) : old.asOf);
    setPositionRemoved(db, owner, id, who.name, now);
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
        cost: change.cost === undefined ? old.cost : change.cost,
        asOf,
        note: change.note === undefined ? old.note : change.note,
        dryPowder: change.dryPowder ?? old.dryPowder,
        maturity:
          change.maturity === undefined ? old.maturity : change.maturity,
        name,
        broker: at,
        replaces: id,
        enteredBy: who.name,
      },
      now,
    );
  });
  if (isFailure(done)) return done;
  return {
    position: positionItem(m.db, owner, readPosition(m.db, owner, done)!),
    replaced: id,
    ...(rate === undefined ? {} : { rate }),
  };
}

export const PAST_ONLY =
  "a date before the row's own day takes only amount: its balance that day";
export const PAST_FIXED =
  "a past balance never changes: remove it, or add another for its day";

// a balance for a day before the row's own: kept in its history, the
// row's figures untouched; the latest entry on a day is its balance
async function addPastBalance(
  m: Markets,
  who: Who,
  row: Position,
  change: PositionChange,
): Promise<
  { position: ReturnType<typeof positionItem>; replaced: null } | Failure
> {
  const owner = who.user;
  const other = Object.keys(change).filter(
    (k) => k !== "amount" && k !== "date",
  );
  const given = change.amount;
  if (
    other.length > 0 ||
    given === undefined ||
    (given.currency !== null && given.currency !== row.currency)
  ) {
    return { error: "bad_arguments", message: PAST_ONLY };
  }
  const done = await m.writer.write((db): number | Failure => {
    recheck(db);
    const old = readPosition(db, owner, row.id);
    if (old === null) return notFound(`no position ${row.id}`);
    if (old.removedAt !== null) {
      return conflict(
        `position ${row.id} was removed or updated; restore it first`,
      );
    }
    return insertPosition(
      db,
      {
        portfolio: old.portfolio,
        kind: old.kind,
        name: old.name,
        currency: old.currency,
        instrument: null,
        amount: given.amount,
        cost: null,
        coupon: null,
        maturity: old.maturity,
        asOf: change.date!,
        broker: old.broker,
        note: null,
        dryPowder: old.dryPowder,
        replaces: null,
        pastOf: old.id,
        enteredBy: who.name,
      },
      m.clock.now(),
    );
  });
  if (isFailure(done)) return done;
  return {
    position: positionItem(m.db, owner, readPosition(m.db, owner, done)!),
    replaced: null,
  };
}

// the position's rows and past balances, its updates and removals with
// who and when; a past balance's id answers its account's
export function historyOf(m: Markets, owner: string, id: number) {
  const p = readPosition(m.db, owner, id);
  if (p === null) return notFound(`no position ${id}`);
  return {
    history: entriesOf(m.db, owner, p.id).map((r) =>
      positionItem(m.db, owner, r),
    ),
  };
}

// a row's kept updates for an agent, oldest first: what the owner set
// and when, never who. An update and the row it replaces share one
// instant; any other removal set the row aside for a restore (undone),
// or took it off by hand (removed) when no row was live just after
export function rowHistory(m: Markets, owner: string, id: number) {
  const p = readPosition(m.db, owner, id);
  if (p === null) return notFound(`no position ${id}`);
  const all = entriesOf(m.db, owner, p.id).reverse();
  const chain = all.filter((r) => r.pastOf === null);
  const byHand = (r: Position): boolean => {
    const t = r.removedAt;
    if (t === null) return false;
    if (chain.some((c) => c.replaces === r.id && c.enteredAt === t)) {
      return false;
    }
    return !chain.some(
      (x) =>
        x.id !== r.id &&
        x.enteredAt <= t &&
        (x.removedAt === null || x.removedAt > t),
    );
  };
  const stands = standing(chain);
  return {
    position: p.pastOf ?? p.id,
    kind: p.kind,
    history: all.map((r) => {
      const b = r.broker === null ? null : readBroker(m.db, owner, r.broker);
      return {
        position: r.id,
        date: r.asOf,
        amount: r.amount,
        currency: r.currency,
        name: r.name,
        broker: b?.name ?? null,
        ...(r.kind === "cash" ? { dry_powder: r.dryPowder } : {}),
        ...(r.maturity === null ? {} : { maturity: r.maturity }),
        note: r.note,
        ...(r.pastOf === null ? {} : { past: true }),
        removed: r.pastOf === null ? byHand(r) : r.removedAt !== null,
        ...(r.pastOf !== null || stands.has(r.id) ? {} : { undone: true }),
      };
    }),
  };
}

const TOOL_OF: Record<PositionKind, string> = {
  cash: "portfolio_cash",
  bond: "portfolio_bond",
};
const ROW_OF: Record<PositionKind, string> = {
  cash: "cash row",
  bond: "bond",
};

// at most this many rows named in a refusal
const NAMED_ROWS = 10;

function rowLabel(db: Db, owner: string, p: Position): string {
  const broker =
    p.broker === null ? null : (readBroker(db, owner, p.broker)?.name ?? null);
  const said = [p.name, broker, p.currency];
  if (p.kind === "cash" && p.dryPowder) said.push("dry powder");
  return `${p.id} (${said.filter((x) => x !== null).join(", ")})`;
}

// the live rows of a kind, so a stale or mistyped id is retried right
function liveRows(db: Db, owner: string, kind: PositionKind): string {
  const cash = cashPortfolio(db, owner);
  const rows =
    kind === "cash"
      ? cash === null
        ? []
        : readPositions(db, owner, { portfolio: cash.id }).filter(
            (x) => x.kind === "cash",
          )
      : readPositions(db, owner).filter((x) => x.kind === "bond");
  const where = kind === "cash" ? `${CASH_NAME} holds` : "bonds kept:";
  if (rows.length === 0) return `${where} none`;
  const named = rows.slice(0, NAMED_ROWS).map((x) => rowLabel(db, owner, x));
  const more = rows.length - named.length;
  return `${where} ${named.join(", ")}${more > 0 ? `, and ${more} more` : ""}`;
}

// a row the cash or bond tool names by position: the other kind's is
// refused naming its tool, one an update replaced naming the live row
export function positionFor(
  m: Markets,
  owner: string,
  kind: PositionKind,
  id: number,
  action: "update" | "remove" | "restore",
): Failure | null {
  const p = readPosition(m.db, owner, id);
  if (p === null) {
    return notFound(
      action === "restore"
        ? `no ${ROW_OF[kind]} at position ${id}`
        : `no ${ROW_OF[kind]} at position ${id}; ${liveRows(m.db, owner, kind)}`,
    );
  }
  if (p.kind !== kind) {
    return {
      error: "bad_arguments",
      message: `position ${id} is ${p.kind === "cash" ? "cash" : "a bond"}; ${TOOL_OF[p.kind]} changes it`,
    };
  }
  if (p.pastOf !== null && action === "update") {
    return { error: "bad_arguments", message: PAST_FIXED };
  }
  if (p.removedAt === null || action === "restore") return null;
  const now = chainOf(m.db, owner, id).find((x) => x.removedAt === null);
  if (now !== undefined) {
    return conflict(`position ${id} was updated; it is position ${now.id} now`);
  }
  // a second removal keeps who removed it first
  if (action === "remove") return null;
  return notFound(
    `position ${id} was removed; restore brings it back; ${liveRows(m.db, owner, kind)}`,
  );
}

// the row's id named position, as the cash and bond tools take it
const asPosition = <T extends { id: number }>({ id, ...rest }: T) => ({
  position: id,
  ...rest,
});

const withPosition = <T extends object>(body: T | Failure): T | Failure =>
  isFailure(body) || !("position" in body)
    ? body
    : {
        ...body,
        position: asPosition(body.position as { id: number }),
      };

// the latest removed rows a holdings read lists
export const MAX_REMOVED = 20;

// cash and bond rows removed and not replaced by an update, newest first
function removedRows(m: Markets, owner: string, args: HoldingsArgs) {
  const p = findPortfolio(m.db, owner, args.portfolio);
  const b = findBroker(m.db, owner, args.broker);
  const all = readPositions(m.db, owner, {
    portfolio: p === null || isFailure(p) ? null : p.id,
    broker: b === null || isFailure(b) ? null : b.id,
    removed: true,
  });
  const replaced = new Set(
    readPositions(m.db, owner, { removed: true }).flatMap((x) =>
      x.replaces === null ? [] : [x.replaces],
    ),
  );
  return all
    .filter((x) => x.removedAt !== null && !replaced.has(x.id))
    .sort((a, z) => z.removedAt! - a.removedAt! || z.id - a.id)
    .slice(0, MAX_REMOVED)
    .map((x) => ({
      position: x.id,
      kind: x.kind,
      portfolio: readPortfolio(m.db, owner, x.portfolio)?.name ?? null,
      name: x.name,
      broker:
        x.broker === null
          ? null
          : (readBroker(m.db, owner, x.broker)?.name ?? null),
      currency: x.currency,
      removed_at: iso(x.removedAt),
    }));
}

// a removal is a stamp: the row stays, restorable
export async function setTradeState(
  m: Markets,
  who: Who,
  id: number,
  removed: boolean,
): Promise<{ trade: ReturnType<typeof tradeItem> } | Failure> {
  const owner = who.user;
  const done = await m.writer.write((db): Failure | null | number => {
    recheck(db);
    const t = readTrade(db, owner, id);
    if (t === null) return null;
    // a second removal keeps who removed it first
    if (removed === (t.removedAt !== null)) return id;
    const i = readInstrument(db, t.instrument);
    if (i !== null) {
      const before = partTrades(db, owner, t);
      const after = removed
        ? before.filter((x) => x.id !== id)
        : [...before, { ...t, removedAt: null, removedBy: null }];
      const sales = newlyOversold(before, after, splitsOf(db, i.id));
      const sale = sales.find((x) => x.id !== id);
      if (sale !== undefined) return conflict(undoesSale(sale));
      if (sales.length > 0) return conflict(SELLS_PAST);
    }
    const now = m.clock.now();
    setTradeRemoved(db, owner, id, removed ? who.name : null, now);
    // a buy's price for its day goes and comes back with it
    if (i !== null && isFund(i)) {
      if (removed) dropBuyPrice(db, t, now);
      else buyPrice(db, t, now);
    }
    return id;
  });
  if (done === null) return notFound(`no trade ${id}`);
  if (isFailure(done)) return done;
  return { trade: tradeItem(m.db, owner, readTrade(m.db, owner, id)!) };
}

export async function setPositionState(
  m: Markets,
  who: Who,
  id: number,
  removed: boolean,
): Promise<{ position: ReturnType<typeof positionItem> } | Failure> {
  const owner = who.user;
  const done = await m.writer.write((db): number | null | Failure => {
    recheck(db);
    const p = readPosition(db, owner, id);
    if (p === null) return null;
    // a second removal keeps who removed it first
    if (removed === (p.removedAt !== null)) return id;
    // a past balance stands beside its chain, never in another row's way
    if (!removed && p.pastOf === null) {
      // a restore puts every other live row of its chain out of the way,
      // whatever the updates changed; cash also a live row of its identity,
      // while two equal bond purchases are two bonds
      const out = new Set(
        chainOf(db, owner, id)
          .filter((x) => x.removedAt === null)
          .map((x) => x.id),
      );
      const same = p.kind === "bond" ? null : samePosition(db, p);
      if (same !== null) out.add(same.id);
      out.delete(id);
      for (const x of out) {
        setPositionRemoved(db, owner, x, who.name, m.clock.now());
      }
    }
    setPositionRemoved(db, owner, id, removed ? who.name : null, m.clock.now());
    return id;
  });
  if (done === null) return notFound(`no position ${id}`);
  if (isFailure(done)) return done;
  return {
    position: positionItem(m.db, owner, readPosition(m.db, owner, id)!),
  };
}

function otherPortfolio(
  m: Markets,
  owner: string,
  portfolio: Ref | null,
  id: number,
): Failure | null {
  if (portfolio === null) return null;
  const p = findPortfolio(m.db, owner, portfolio);
  if (isFailure(p)) return p;
  const row = readTrade(m.db, owner, id);
  if (row === null || p === null || row.portfolio === p.id) return null;
  const its =
    readPortfolio(m.db, owner, row.portfolio)?.name ?? "another portfolio";
  return {
    error: "bad_arguments",
    message: `trade ${id} is in ${its}, not ${p.name}`,
  };
}

const nameArg = (value: unknown, name = "name") => text(value, name, MAX_NAME);

const placeArg = (value: unknown): number => {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new ArgError("position must be a whole number from 1");
  }
  return value;
};

const conflict = (message: string): Failure => ({ error: "conflict", message });

export async function createPortfolio(
  m: Markets,
  owner: string,
  body: unknown,
) {
  const f = fields(body, ["name"]);
  const name = nameArg(f.name);
  const done = await m.writer.write((db): number | Failure => {
    recheck(db);
    // every total converts into it, and none is assumed for the owner
    if (displayCurrency(db, owner) === null) {
      return conflict("Set a display currency first.");
    }
    if (isCashName(name)) return conflict(NAME_KEPT);
    if (portfolioByName(db, owner, name) !== null) {
      return conflict("a portfolio has this name");
    }
    return insertPortfolio(db, owner, name, m.clock.now());
  });
  if (isFailure(done)) return done;
  return {
    portfolio: portfolioItem(m.db, owner, readPortfolio(m.db, owner, done)!),
  };
}

export async function updatePortfolio(
  m: Markets,
  owner: string,
  id: number,
  body: unknown,
) {
  const f = fields(body, ["name", "position"]);
  if (f.name === undefined && f.position === undefined) {
    throw new ArgError("name or position is required");
  }
  const name = f.name === undefined ? null : nameArg(f.name);
  const place = f.position === undefined ? null : placeArg(f.position);
  const done = await m.writer.write((db): Portfolio | Failure | null => {
    recheck(db);
    const p = readPortfolio(db, owner, id);
    if (p === null) return null;
    if (p.cash && name !== null) {
      return conflict(`${CASH_NAME} keeps its name`);
    }
    if (p.cash) return conflict(`${CASH_NAME} stays first`);
    if (name !== null) {
      if (isCashName(name)) return conflict(NAME_KEPT);
      const other = portfolioByName(db, owner, name);
      if (other !== null && other.id !== id) {
        return conflict("a portfolio has this name");
      }
      renamePortfolio(db, owner, id, name);
    }
    if (place !== null) movePortfolio(db, owner, id, place);
    return readPortfolio(db, owner, id)!;
  });
  if (done === null) return notFound(`no portfolio ${id}`);
  if (isFailure(done)) return done;
  return { portfolio: portfolioItem(m.db, owner, done) };
}

export async function removePortfolio(m: Markets, owner: string, id: number) {
  const done = await m.writer.write((db): Failure | null | true => {
    recheck(db);
    const p = readPortfolio(db, owner, id);
    if (p === null) return null;
    if (p.cash) return conflict(`${CASH_NAME} is kept for cash`);
    // removed rows go with it: kept for a restore, never a reason to stay
    if (portfolioRows(db, id) > 0) {
      return conflict("the portfolio holds trades or positions");
    }
    deletePortfolio(db, owner, id);
    return true;
  });
  if (done === null) return notFound(`no portfolio ${id}`);
  return done;
}

export async function createBroker(m: Markets, owner: string, body: unknown) {
  const f = fields(body, ["name"]);
  const name = nameArg(f.name);
  const done = await m.writer.write((db): number | Failure => {
    recheck(db);
    if (brokerByName(db, owner, name) !== null)
      return conflict("a broker has this name");
    return insertBroker(db, owner, name, m.clock.now());
  });
  if (isFailure(done)) return done;
  return { broker: brokerItem(readBroker(m.db, owner, done)!) };
}

export async function updateBroker(
  m: Markets,
  owner: string,
  id: number,
  body: unknown,
) {
  const f = fields(body, ["name"]);
  const name = nameArg(f.name);
  const done = await m.writer.write((db): Broker | Failure | null => {
    recheck(db);
    if (readBroker(db, owner, id) === null) return null;
    const other = brokerByName(db, owner, name);
    if (other !== null && other.id !== id)
      return conflict("a broker has this name");
    renameBroker(db, owner, id, name);
    return readBroker(db, owner, id)!;
  });
  if (done === null) return notFound(`no broker ${id}`);
  if (isFailure(done)) return done;
  return { broker: brokerItem(done) };
}

export async function removeBroker(m: Markets, owner: string, id: number) {
  const done = await m.writer.write((db): Failure | null | true => {
    recheck(db);
    if (readBroker(db, owner, id) === null) return null;
    // removed rows lose the name instead
    if (brokerRows(db, id) > 0) {
      return conflict("trades or positions name this broker");
    }
    deleteBroker(db, owner, id);
    return true;
  });
  if (done === null) return notFound(`no broker ${id}`);
  return done;
}

export const settingsItem = (db: Db, owner: string) => ({
  display_currency: displayCurrency(db, owner),
  time_zone: timeZone(db, owner),
});

// each can be changed, never cleared; one left out is kept
export async function saveSettings(m: Markets, owner: string, body: unknown) {
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
    recheck(db);
    const now = m.clock.now();
    if (c !== null) setDisplayCurrency(db, owner, c, now);
    if (z !== null) setTimeZone(db, owner, z, now);
    // cash has its place from the first currency on
    if (displayCurrency(db, owner) !== null) ensureCash(db, owner, now);
  });
  return settingsItem(m.db, owner);
}

// ---- the tool ------------------------------------------------------------

// a new owner's first steps in one call; a name already there is kept,
// so a retried setup makes nothing twice
async function setup(
  m: Markets,
  owner: string,
  args: Extract<PortfolioArgs, { action: "setup" }>,
) {
  const made: string[] = [];
  const done = await m.writer.write((db): Failure | null => {
    recheck(db);
    const now = m.clock.now();
    // every check before any write, so a refused setup saves nothing
    // the owner's own setting: an agent passing one out of habit never
    // changes it, only sets the first
    const shown = displayCurrency(db, owner);
    if (args.currency !== null && shown !== null && shown !== args.currency) {
      return conflict(
        `the display currency is ${shown}; the owner changes it in the web UI's settings`,
      );
    }
    // the same rule for the owner's zone
    const zone = timeZone(db, owner);
    if (args.zone !== null && zone !== null && zone !== args.zone) {
      return conflict(
        `the time zone is ${zone}; the owner changes it in the web UI's settings`,
      );
    }
    // Cash is made with the currency, never by its name
    const cashNamed = args.portfolio !== null && isCashName(args.portfolio);
    const newPortfolio =
      args.portfolio !== null &&
      !cashNamed &&
      portfolioByName(db, owner, args.portfolio) === null;
    // every total converts into it, and none is assumed for the owner
    if ((newPortfolio || cashNamed) && (shown ?? args.currency) === null) {
      return conflict(
        "name display_currency too, the currency totals are shown in: ask the owner, never assume one",
      );
    }
    if (args.currency !== null && shown === null) {
      setDisplayCurrency(db, owner, args.currency, now);
    }
    if (args.zone !== null && zone === null) {
      setTimeZone(db, owner, args.zone, now);
    }
    if (displayCurrency(db, owner) !== null && ensureCash(db, owner, now)) {
      made.push(`portfolio ${CASH_NAME}`);
    }
    if (newPortfolio) {
      insertPortfolio(db, owner, args.portfolio!, now);
      made.push(`portfolio ${args.portfolio}`);
    }
    for (const name of args.brokers) {
      if (brokerByName(db, owner, name) !== null) continue;
      insertBroker(db, owner, name, now);
      made.push(`broker ${name}`);
    }
    return null;
  });
  if (done !== null) return done;
  return { ...listAll(m, owner), made };
}

// by its name, as an agent knows it; the routes' rename and its refusals
async function renameBrokerNamed(
  m: Markets,
  owner: string,
  args: Extract<PortfolioArgs, { action: "rename_broker" }>,
) {
  const b = findBroker(m.db, owner, args.broker);
  if (isFailure(b)) return b;
  return updateBroker(m, owner, b!.id, { name: args.name });
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
  owner: string,
  args: Extract<PortfolioArgs, { action: "holdings" }>,
): Promise<ToolResult> {
  const { next, removed, ...scope } = args;
  const rest = { ...scope, removed };
  const from = offsetOf(next, rest);
  const read = await readHoldings(m, owner, scope);
  if (isFailure(read)) return errorResult(read);
  const { holdings: all, ...shell } = read;
  // symbol is what quote takes; REST keeps the instrument's id as id
  const rows = all.map(({ kind, id, ...row }) => ({
    kind,
    symbol: id,
    ...row,
  }));
  const gone = removed ? { removed: removedRows(m, owner, scope) } : {};
  const list = rows.slice(from);
  const page = fitPage(
    list,
    (count) => ({
      ...shell,
      ...gone,
      next:
        from + count < rows.length ? cursor(String(from + count), rest) : null,
    }),
    "holdings",
  );
  return textResult(page.text);
}

function tradesPage(
  m: Markets,
  owner: string,
  args: Extract<PortfolioArgs, { action: "trades" }>,
): ToolResult {
  const { next, ...rest } = args;
  const from = offsetOf(next, rest);
  const all = readTradeList(m, owner, rest);
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
  const owner = who.user;
  switch (args.action) {
    case "setup":
      return answered(await setup(m, owner, args));
    case "list":
      return textResult(JSON.stringify(listAll(m, owner)));
    case "rename_broker":
      return answered(await renameBrokerNamed(m, owner, args));
    case "holdings":
      return holdingsPage(m, owner, args);
    case "trades":
      return tradesPage(m, owner, args);
    case "history":
      return answered(rowHistory(m, owner, args.position));
    case "add":
      return answered(
        "trade" in args
          ? await addTrade(m, who, args.trade)
          : "fund" in args
            ? await addFundTrade(m, who, args.fund)
            : withPosition(await addPosition(m, who, args.position)),
      );
    case "update": {
      if ("fund" in args) {
        return answered(await updateFund(m, who, args.fund, args.change));
      }
      const wrong = positionFor(m, owner, args.kind, args.position, "update");
      if (wrong !== null) return errorResult(wrong);
      return answered(
        withPosition(await updatePosition(m, who, args.position, args.change)),
      );
    }
    case "remove":
    case "restore": {
      const removed = args.action === "remove";
      if ("trade" in args) {
        const wrong = otherPortfolio(m, owner, args.portfolio, args.trade);
        if (wrong !== null) return errorResult(wrong);
        return answered(await setTradeState(m, who, args.trade, removed));
      }
      const wrong = positionFor(
        m,
        owner,
        args.kind,
        args.position,
        args.action,
      );
      if (wrong !== null) return errorResult(wrong);
      return answered(
        withPosition(await setPositionState(m, who, args.position, removed)),
      );
    }
  }
}
