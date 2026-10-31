// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// What a portfolio holds and is worth. No currency is a base: a value is
// in its instrument's currency, totals are per currency, and a sum across
// currencies exists only in a currency the caller names.

import { iso } from "../market/format.ts";
import { type Instrument, readInstrument } from "../market/instruments.ts";
import { type QuoteRow, readQuote } from "../market/quotes.ts";
import { quoteStale, STALE } from "../market/stale.ts";
import { localDate } from "../market/zone.ts";
import type { Db } from "../storage/db/index.ts";
import { type Rate, type Rates, rates as ratesOf } from "./fx.ts";
import {
  type Broker,
  chainOf,
  type Portfolio,
  type Position,
  readPositions,
  readTrades,
  type Split,
  splitsOf,
  type Trade,
} from "./store.ts";

// a quantity sold down to this is gone; float sums never reach zero
const EPSILON = 1e-9;

// what a sell leaves of what was held: within a billionth of it is
// nothing, so a large holding's float noise empties it too; shared by the
// holdings, a sell of all and an import's check, so they never disagree
export function sellStep(
  held: number,
  side: "buy" | "sell",
  shares: number,
): { held: number; over: boolean } {
  if (side === "buy") return { held: held + shares, over: false };
  if (held <= EPSILON) return { held, over: true };
  const over = shares > held * (1 + EPSILON);
  const left = held - Math.min(shares, held);
  return { held: left <= EPSILON * Math.max(1, held) ? 0 : left, over };
}

// unrounded: an answer rounds money once, to its currency's minor units
const finite = (v: number | null): number | null =>
  v === null || !Number.isFinite(v) ? null : v;

// float noise off, every digit a double holds kept
export const exact = (v: number | null): number | null =>
  v === null || !Number.isFinite(v) ? null : Number(v.toPrecision(15));

// 8 decimals from a cent up, so a sum of many lots loses its float noise;
// below that significant digits, so a tiny coin price keeps its digits
export const money = (v: number | null): number | null =>
  v === null || !Number.isFinite(v)
    ? null
    : Math.abs(v) >= 0.01
      ? Number(v.toFixed(8))
      : Number(v.toPrecision(15));
export const qty = exact;

const ISO = new Set(Intl.supportedValuesOf("currency"));

// a currency's minor units (JPY 0, KWD 3); a code ISO lacks, a coin, keeps 8
export function minorUnits(currency: string): number {
  const code = currency.toUpperCase();
  if (!ISO.has(code)) return 8;
  return (
    new Intl.NumberFormat("en", {
      style: "currency",
      currency: code,
    }).resolvedOptions().maximumFractionDigits ?? 2
  );
}

const cents = (v: number | null, digits: number): number | null =>
  v === null ? null : Number(v.toFixed(digits)) + 0;
const pct = (v: number | null): number | null =>
  v === null || !Number.isFinite(v) ? null : Math.round(v * 100) / 100;

// a bond's price is a percent of its face
const perUnit = (i: Pick<Instrument, "unit">): number =>
  i.unit === "percent_of_par" ? 0.01 : 1;

// the ratio of every split after the day a quantity is stated as of
export function splitFactor(splits: readonly Split[], date: string): number {
  let f = 1;
  for (const s of splits) if (s.date > date) f *= s.ratio;
  return f;
}

// the day a trade's figures are stated as of
export const statedOf = (t: Pick<Trade, "date" | "statedOn">): string =>
  t.statedOn ?? t.date;

export type Part = {
  portfolio: number;
  broker: number | null;
  quantity: number;
  // in the instrument's currency; null when a trade paid in another
  // currency has no rate for its day
  cost: number | null;
  // what was paid, by currency, reduced pro rata as cost is
  paid: Map<string, number>;
  // in the named currency, at each trade day's close
  costIn: number | null;
  oversold: boolean;
  // sells past what the part held, counted, so a change is judged by
  // whether it adds one
  oversells: number;
  // why the lot held now has no cost; a part sold to nothing starts clean
  reasons: Set<string>;
};

const add = (a: number | null, b: number | null) =>
  a === null || b === null ? null : a + b;

// trades oldest first; a sell takes its share of cost from its own part
export function partsOf(
  trades: readonly Trade[],
  instrument: Instrument,
  splits: readonly Split[],
  fx: Rates,
  named: string | null,
): Part[] {
  const parts = new Map<string, Part>();
  const sorted = [...trades].sort((a, b) =>
    a.date === b.date ? a.id - b.id : a.date < b.date ? -1 : 1,
  );
  const listed = instrument.currency;
  for (const t of sorted) {
    const key = `${t.portfolio}/${t.broker ?? ""}`;
    let p = parts.get(key);
    if (p === undefined) {
      p = {
        portfolio: t.portfolio,
        broker: t.broker,
        quantity: 0,
        cost: 0,
        paid: new Map(),
        costIn: named === null ? null : 0,
        oversold: false,
        oversells: 0,
        reasons: new Set(),
      };
      parts.set(key, p);
    }
    const shares = t.quantity * splitFactor(splits, statedOf(t));
    if (t.side === "buy") {
      const gross = t.quantity * t.price * perUnit(instrument) + t.fees;
      const toListed =
        listed === null
          ? ({ rate: null, reason: "no listing currency" } as const)
          : fx.rate(t.currency, listed, t.date);
      if (toListed.rate === null) p.reasons.add(toListed.reason);
      p.quantity += shares;
      p.cost = add(
        p.cost,
        toListed.rate === null ? null : gross * toListed.rate,
      );
      p.paid.set(t.currency, (p.paid.get(t.currency) ?? 0) + gross);
      if (named !== null) {
        const r = fx.rate(t.currency, named, t.date);
        if (r.rate === null) p.reasons.add(r.reason);
        p.costIn = add(p.costIn, r.rate === null ? null : gross * r.rate);
      }
      continue;
    }
    const s = sellStep(p.quantity, "sell", shares);
    if (s.over) {
      p.oversold = true;
      p.oversells++;
    }
    if (p.quantity <= EPSILON) continue;
    const kept = 1 - Math.min(1, shares / p.quantity);
    p.quantity = s.held;
    p.cost = p.cost === null ? null : p.cost * kept;
    p.costIn = p.costIn === null ? null : p.costIn * kept;
    for (const [c, v] of p.paid) p.paid.set(c, v * kept);
    if (p.quantity === 0) {
      p.quantity = 0;
      p.cost = 0;
      p.costIn = named === null ? null : 0;
      p.paid.clear();
      p.reasons.clear();
    }
  }
  return [...parts.values()];
}

// a trade on the quote's day moves from its own price, so a buy at the
// live price shows no move it never had
export function dayChangeOf(
  trades: readonly Trade[],
  instrument: Instrument,
  splits: readonly Split[],
  q: QuoteRow,
  held: number,
  fx: Rates,
): number | null {
  if (q.change === null) return null;
  const day = localDate(instrument.zone, q.time ?? q.fetchedAt);
  let open = held;
  let flows = 0;
  for (const t of trades) {
    if (t.date < day) continue;
    const f = splitFactor(splits, statedOf(t));
    const shares = t.quantity * f;
    const r =
      instrument.currency === null
        ? null
        : fx.rate(t.currency, instrument.currency, t.date).rate;
    if (r === null) return null;
    const money = shares * (t.price / f) * r;
    if (t.side === "buy") {
      open -= shares;
      flows -= money;
    } else {
      open += shares;
      flows += money;
    }
  }
  const before = q.price - q.change;
  return (
    (held * q.price - Math.max(0, open) * before + flows) * perUnit(instrument)
  );
}

export type Converted = {
  currency: string;
  rate: number | null;
  rate_at: string | null;
  value: number | null;
  cost: number | null;
  pl: number | null;
  pl_percent: number | null;
  weight: number | null;
};

export type PartItem = {
  portfolio: string;
  broker: string | null;
  quantity: number | null;
  average_cost: number | null;
  cost: number | null;
  value: number | null;
  // a position's own row, so each purchase of a merged bond is edited alone
  position?: number;
  as_of?: string;
  // as stored: cash's balance or a bond's face, never rounded for show
  amount?: number | null;
};

export type Row = {
  kind: "holding" | "cash" | "fund" | "bond";
  // the instrument's id, null for a position with no listing
  id: string | null;
  position: number | null;
  name: string | null;
  type: string;
  market: string | null;
  currency: string;
  // the listing's unit: percent_of_par prices are a percent of face
  unit: string | null;
  quantity: number | null;
  average_cost: number | null;
  cost: number | null;
  // live, or the hand price with its date, or a bond's listing
  price: number | null;
  priced: "quote" | "hand" | "listing" | "face" | "amount";
  as_of: string | null;
  value: number | null;
  pl: number | null;
  pl_percent: number | null;
  day_change: number | null;
  change_percent: number | null;
  // of the value in its own currency; converted.weight is of the total
  currency_weight: number | null;
  paid?: { currency: string; amount: number | null }[];
  converted?: Converted;
  coupon?: number | null;
  maturity?: string | null;
  // cash kept for buying
  dry_powder?: boolean;
  // all of it sold on the quote's day: kept until then for the day's move
  sold_today?: boolean;
  note?: string | null;
  trade_time: string | null;
  fetched_at: string | null;
  stale: string[];
  parts: PartItem[];
};

// the value split three ways, each with its share of the whole
export type Split3 = {
  invested: number | null;
  cash: number | null;
  dry_powder: number | null;
  invested_weight: number | null;
  cash_weight: number | null;
  dry_powder_weight: number | null;
};

export type Total = {
  currency: string;
  // the sum of the values known; missing names the rest
  value: number | null;
  // null when no row has a cost
  cost: number | null;
  pl: number | null;
  pl_percent: number | null;
  day_change: number | null;
  missing: string[];
} & Split3;

const bucket = (r: Row): "invested" | "cash" | "dry_powder" =>
  r.kind !== "cash" ? "invested" : r.dry_powder ? "dry_powder" : "cash";

function split3(
  rows: readonly Row[],
  worth: (r: Row) => number | null,
): Split3 {
  const sums = { invested: 0, cash: 0, dry_powder: 0 };
  for (const r of rows) {
    const v = worth(r);
    if (v !== null) sums[bucket(r)] += v;
  }
  const all = sums.invested + sums.cash + sums.dry_powder;
  const w = (v: number) => (all === 0 ? null : pct((v / all) * 100));
  return {
    invested: finite(sums.invested),
    cash: finite(sums.cash),
    dry_powder: finite(sums.dry_powder),
    invested_weight: w(sums.invested),
    cash_weight: w(sums.cash),
    dry_powder_weight: w(sums.dry_powder),
  };
}

export type Share = { key: string | null; value: number; weight: number };

export type Exposure = {
  currency: string;
  // what the weights are in: the named currency, or this one's own
  currency_weights: Share[] | null;
  market: Share[];
  type: Share[];
  portfolio: Share[];
  broker: Share[];
};

export type Holdings = {
  // the caller's named currency, null without one
  currency: string | null;
  totals: Total[];
  converted: Total | null;
  // the live rates the named currency was read at
  rates: {
    from: string;
    to: string;
    rate: number | null;
    pair: string | null;
    at: string | null;
    stale: string[];
    reason?: string;
  }[];
  // the closes costs were converted at, one entry per pair and outcome:
  // how many days, the first and the last, and why when none was had
  cost_rates: {
    from: string;
    to: string;
    pair: string | null;
    count: number;
    first: string;
    last: string;
    reason?: string;
  }[];
  exposure: Exposure[];
  holdings: Row[];
};

type Scope = {
  portfolios: readonly Portfolio[];
  brokers: readonly Broker[];
  portfolio: number | null;
  broker: number | null;
  currency: string | null;
};

// held or a position, but cash: worth what was paid
const plOf = (value: number | null, cost: number | null) =>
  value === null || cost === null ? null : value - cost;
const plPct = (value: number | null, cost: number | null) =>
  value === null || cost === null || cost === 0
    ? null
    : ((value - cost) / cost) * 100;

// a share's figures to the caller: rounded, the parts by name
// the scope's live trades, filtered in SQL, read once per answer
export const scopeTrades = (
  db: Db,
  scope: Pick<Scope, "portfolio" | "broker">,
): Trade[] =>
  readTrades(db, { portfolio: scope.portfolio, broker: scope.broker });

export function readHoldingRows(
  db: Db,
  scope: Scope,
  now: number,
  everyMs: number,
  fx: Rates = ratesOf(db, now, everyMs),
  trades: readonly Trade[] = scopeTrades(db, scope),
): {
  rows: Row[];
  parts: Map<
    Row,
    { portfolio: number; broker: number | null; value: number | null }[]
  >;
} {
  const names = new Map(scope.portfolios.map((p) => [p.id, p.name]));
  const brokers = new Map(scope.brokers.map((b) => [b.id, b.name]));
  const byInstrument = new Map<string, Trade[]>();
  for (const t of trades) {
    const list = byInstrument.get(t.instrument);
    if (list) list.push(t);
    else byInstrument.set(t.instrument, [t]);
  }
  const rows: Row[] = [];
  const shares = new Map<
    Row,
    { portfolio: number; broker: number | null; value: number | null }[]
  >();
  for (const [id, list] of byInstrument) {
    const instrument = readInstrument(db, id);
    if (instrument === null) continue;
    const splits = splitsOf(db, id);
    const parts = partsOf(list, instrument, splits, fx, scope.currency).filter(
      (p) => p.quantity > 0 || p.oversold,
    );
    const held = parts.filter((p) => p.quantity > 0);
    const q = readQuote(db, id);
    const soldToday =
      parts.length === 0 &&
      q !== null &&
      list.some(
        (t) =>
          t.side === "sell" &&
          t.date >= localDate(instrument.zone, q.time ?? q.fetchedAt),
      );
    // sold past what was bought: kept at nothing, with why
    if (parts.length === 0 && !soldToday) continue;
    const unit = perUnit(instrument);
    const quantity = held.reduce((s, p) => s + p.quantity, 0);
    const cost = held.reduce<number | null>((s, p) => add(s, p.cost), 0);
    const value = q === null ? null : quantity * q.price * unit;
    const stale: string[] = [...quoteStale(db, instrument, { now, everyMs })];
    const reasons = new Set<string>();
    for (const p of parts) {
      for (const r of p.reasons) reasons.add(r);
      if (p.oversold) reasons.add("sells more than bought");
    }
    stale.push(...reasons);
    const paid = new Map<string, number>();
    for (const p of held) {
      for (const [c, v] of p.paid) paid.set(c, (paid.get(c) ?? 0) + v);
    }
    const currency = instrument.currency ?? "";
    const otherPaid = [...paid.keys()].some((c) => c !== currency);
    const row: Row = {
      kind: "holding",
      id,
      position: null,
      name: instrument.name,
      type: instrument.type,
      market: instrument.market,
      currency,
      unit: instrument.unit,
      quantity: qty(quantity),
      average_cost:
        cost === null || quantity === 0 ? null : money(cost / quantity / unit),
      cost: finite(cost),
      price: q?.price ?? null,
      priced: "quote",
      as_of: null,
      value: finite(value),
      pl: finite(plOf(value, cost)),
      pl_percent: pct(plPct(value, cost)),
      day_change:
        q === null
          ? null
          : finite(dayChangeOf(list, instrument, splits, q, quantity, fx)),
      change_percent: pct(q?.changePercent ?? null),
      currency_weight: null,
      ...(soldToday ? { sold_today: true } : {}),
      ...(otherPaid
        ? {
            paid: [...paid].map(([c, v]) => ({
              currency: c,
              amount: finite(v),
            })),
          }
        : {}),
      trade_time: iso(q?.time ?? null),
      fetched_at: iso(q?.fetchedAt ?? null),
      stale,
      parts: parts.map((p) => ({
        portfolio: names.get(p.portfolio) ?? String(p.portfolio),
        broker: p.broker === null ? null : (brokers.get(p.broker) ?? null),
        quantity: qty(p.quantity),
        average_cost:
          p.cost === null || p.quantity === 0
            ? null
            : money(p.cost / p.quantity / unit),
        cost: finite(p.cost),
        value: q === null ? null : finite(p.quantity * q.price * unit),
      })),
    };
    if (scope.currency !== null) {
      const costIn = held.reduce<number | null>((s, p) => add(s, p.costIn), 0);
      row.converted = convert(fx, currency, scope.currency, value, costIn);
    }
    RAW.set(row, { value, cost });
    rows.push(row);
    shares.set(
      row,
      parts.map((p) => ({
        portfolio: p.portfolio,
        broker: p.broker,
        value: q === null ? null : p.quantity * q.price * unit,
      })),
    );
  }
  const positions = readPositions(db, {
    portfolio: scope.portfolio,
    broker: scope.broker,
  });
  for (const p of positions) {
    const row = positionRow(db, p, now, everyMs, names, brokers);
    if (scope.currency !== null) {
      const raw = rawOf(row);
      const costIn =
        raw.cost === null
          ? null
          : (() => {
              const r = fx.rate(p.currency, scope.currency!, costSetOn(db, p));
              return r.rate === null ? null : raw.cost * r.rate;
            })();
      row.converted = convert(
        fx,
        p.currency,
        scope.currency,
        raw.value,
        p.kind === "cash" ? raw.value : costIn,
        p.kind === "cash",
      );
    }
    rows.push(row);
    shares.set(row, [
      { portfolio: p.portfolio, broker: p.broker, value: rawOf(row).value },
    ]);
  }
  // several purchases of one listed bond are one holding, as trades are
  const bonds = new Map<string, Row[]>();
  for (const r of rows) {
    if (r.kind !== "bond" || r.id === null) continue;
    const key = `${r.id}/${r.currency}`;
    const list = bonds.get(key);
    if (list) list.push(r);
    else bonds.set(key, [r]);
  }
  for (const list of bonds.values()) {
    if (list.length < 2) continue;
    const one = mergeBonds(list);
    shares.set(
      one,
      list.flatMap((r) => shares.get(r) ?? []),
    );
    for (const r of list) shares.delete(r);
    const at = rows.indexOf(list[0]!);
    const rest = rows.filter((r) => !list.includes(r));
    rest.splice(at, 0, one);
    rows.splice(0, rows.length, ...rest);
  }
  return { rows, parts: shares };
}

const sumOrNull = (xs: (number | null)[]): number | null =>
  xs.some((x) => x === null) ? null : xs.reduce<number>((a, x) => a + x!, 0);

function mergeBonds(list: readonly Row[]): Row {
  const first = list[0]!;
  const value = sumOrNull(list.map((r) => rawOf(r).value));
  const cost = sumOrNull(list.map((r) => rawOf(r).cost));
  const dates = new Set(list.map((r) => r.as_of));
  const row: Row = {
    ...first,
    // no one position: edit or remove each purchase on its own
    position: null,
    cost: finite(cost),
    as_of: dates.size === 1 ? first.as_of : null,
    value: finite(value),
    pl: finite(plOf(value, cost)),
    pl_percent: pct(plPct(value, cost)),
    day_change: sumOrNull(list.map((r) => r.day_change)),
    stale: [...new Set(list.flatMap((r) => r.stale))],
    parts: list.flatMap((r) => r.parts),
  };
  if (first.converted !== undefined) {
    const raws = list.map((r) =>
      r.converted === undefined ? undefined : RAW_IN.get(r.converted),
    );
    const v = sumOrNull(raws.map((x) => x?.value ?? null));
    const c = sumOrNull(raws.map((x) => x?.cost ?? null));
    const out: Converted = {
      ...first.converted,
      value: finite(v),
      cost: finite(c),
      pl: finite(plOf(v, c)),
      pl_percent: pct(plPct(v, c)),
    };
    RAW_IN.set(out, { value: v, cost: c });
    row.converted = out;
  }
  RAW.set(row, { value, cost });
  return row;
}

// the unrounded value and cost a row was made from, for sums
const RAW = new WeakMap<Row, { value: number | null; cost: number | null }>();
const rawOf = (row: Row) =>
  RAW.get(row) ?? { value: row.value, cost: row.cost };

// the unrounded converted value and cost, for the converted total
const RAW_IN = new WeakMap<
  Converted,
  { value: number | null; cost: number | null }
>();

function convert(
  fx: Rates,
  from: string,
  to: string,
  value: number | null,
  costIn: number | null,
  cash = false,
): Converted {
  const r: Rate = fx.rate(from, to, null);
  const v = value === null || r.rate === null ? null : value * r.rate;
  // cash is worth what it is today, in either currency
  const c = cash ? v : costIn;
  const out: Converted = {
    currency: to,
    rate: exact(r.rate),
    rate_at: r.at,
    value: finite(v),
    cost: finite(c),
    pl: cash ? null : finite(plOf(v, c)),
    pl_percent: cash ? null : pct(plPct(v, c)),
    weight: null,
  };
  RAW_IN.set(out, { value: v, cost: c });
  return out;
}

const KIND_TYPES = { cash: "CASH", fund: "FUND", bond: "BOND" } as const;

// a fund repriced today still cost what it did when the cost was set, so
// its cost converts at that day: the oldest row back with the same cost
function costSetOn(db: Db, p: Position): string {
  if (p.kind !== "fund") return p.asOf;
  const rows = new Map(chainOf(db, p.id).map((r) => [r.id, r]));
  let at = p;
  for (;;) {
    const prev = at.replaces === null ? undefined : rows.get(at.replaces);
    if (prev === undefined || prev.cost !== p.cost) return at.asOf;
    at = prev;
  }
}

function positionRow(
  db: Db,
  p: Position,
  now: number,
  everyMs: number,
  names: Map<number, string>,
  brokers: Map<number, string>,
): Row {
  let value: number | null = null;
  let cost: number | null = p.cost;
  let price: number | null = null;
  let priced: Row["priced"] = "amount";
  const stale: string[] = [];
  let fetchedAt: number | null = null;
  let tradeTime: number | null = null;
  let dayChange: number | null = null;
  let changePercent: number | null = null;
  let instrument: Instrument | null = null;
  if (p.kind === "cash") {
    value = p.amount;
    cost = null;
  } else if (p.kind === "fund") {
    price = p.price;
    value = (p.units ?? 0) * (p.price ?? 0);
    priced = "hand";
  } else {
    instrument =
      p.instrument === null ? null : readInstrument(db, p.instrument);
    const q = instrument === null ? null : readQuote(db, instrument.id);
    if (
      instrument !== null &&
      q !== null &&
      instrument.unit === "percent_of_par"
    ) {
      price = q.price;
      value = (p.amount ?? 0) * q.price * 0.01;
      priced = "listing";
      dayChange = q.change === null ? null : (p.amount ?? 0) * q.change * 0.01;
      changePercent = q.changePercent;
      fetchedAt = q.fetchedAt;
      tradeTime = q.time;
      stale.push(...quoteStale(db, instrument, { now, everyMs }));
    } else {
      value = p.amount;
      priced = "face";
      if (instrument !== null) stale.push(STALE.noQuoteYet);
    }
  }
  const average =
    p.kind === "fund" && cost !== null && p.units
      ? money(cost / p.units)
      : null;
  const row: Row = {
    kind: p.kind,
    id: instrument?.id ?? p.instrument,
    position: p.id,
    name: p.name,
    type: KIND_TYPES[p.kind],
    market: instrument?.market ?? null,
    currency: p.currency,
    unit: instrument?.unit ?? null,
    quantity: p.kind === "fund" ? qty(p.units) : null,
    average_cost: average,
    cost: finite(cost),
    price,
    priced,
    as_of: p.asOf,
    value: finite(value),
    pl: p.kind === "cash" ? null : finite(plOf(value, cost)),
    pl_percent: p.kind === "cash" ? null : pct(plPct(value, cost)),
    day_change: dayChange,
    change_percent: pct(changePercent),
    currency_weight: null,
    ...(p.kind === "bond" ? { coupon: p.coupon, maturity: p.maturity } : {}),
    ...(p.kind === "cash" ? { dry_powder: p.dryPowder } : {}),
    note: p.note,
    trade_time: iso(tradeTime),
    fetched_at: iso(fetchedAt),
    stale,
    parts: [
      {
        portfolio: names.get(p.portfolio) ?? String(p.portfolio),
        broker: p.broker === null ? null : (brokers.get(p.broker) ?? null),
        quantity: p.kind === "fund" ? qty(p.units) : null,
        average_cost: average,
        cost: finite(cost),
        value: finite(value),
        position: p.id,
        as_of: p.asOf,
        ...(p.kind === "fund" ? {} : { amount: p.amount }),
      },
    ],
  };
  RAW.set(row, { value, cost });
  return row;
}

const nameOf = (r: Row): string => r.id ?? r.name ?? "";

// the known values summed, the rest named; cost and gain over the rows
// with both a cost and a value, so cash and an unknown cost never count
function sumOf(
  rows: readonly Row[],
  currency: string,
  worth: (r: Row) => { value: number | null; cost: number | null },
  day: (r: Row) => number | null,
  missing: (r: Row) => string,
): Total {
  let value = 0;
  let cost = 0;
  let costed = 0;
  let any = false;
  let days = 0;
  const gone = new Set<string>();
  for (const r of rows) {
    const w = worth(r);
    if (w.value === null) {
      gone.add(missing(r));
      continue;
    }
    value += w.value;
    if (r.kind !== "cash" && w.cost !== null) {
      cost += w.cost;
      costed += w.value;
      any = true;
    }
    days += day(r) ?? 0;
  }
  return {
    currency,
    value: finite(value),
    cost: any ? finite(cost) : null,
    pl: any ? finite(costed - cost) : null,
    pl_percent: any ? pct(plPct(costed, cost)) : null,
    day_change: finite(days),
    missing: [...gone],
    ...split3(rows, (r) => worth(r).value),
  };
}

const sharesOf = (
  entries: { key: string | null; value: number | null }[],
): Share[] => {
  const sums = new Map<string | null, number>();
  for (const e of entries) {
    if (e.value === null || e.value === 0) continue;
    sums.set(e.key, (sums.get(e.key) ?? 0) + e.value);
  }
  const all = [...sums.values()].reduce((a, b) => a + b, 0);
  return [...sums]
    .map(([key, value]) => ({
      key,
      value: value,
      weight: all === 0 ? 0 : pct((value / all) * 100)!,
    }))
    .sort((a, b) => b.value - a.value);
};

export function holdings(
  db: Db,
  scope: Scope,
  now: number,
  everyMs: number,
  trades: readonly Trade[] = scopeTrades(db, scope),
): Holdings {
  const fx = ratesOf(db, now, everyMs);
  const { rows, parts } = readHoldingRows(db, scope, now, everyMs, fx, trades);
  const names = new Map(scope.portfolios.map((p) => [p.id, p.name]));
  const brokers = new Map(scope.brokers.map((b) => [b.id, b.name]));
  for (const r of rows) {
    if (!RAW.has(r)) {
      const share = parts.get(r) ?? [];
      const value = share.every((s) => s.value !== null)
        ? share.reduce((a, s) => a + (s.value ?? 0), 0)
        : null;
      const cost = r.cost;
      RAW.set(r, { value, cost });
    }
  }
  const currencies = [...new Set(rows.map((r) => r.currency))].sort();
  const totals = currencies.map((c) =>
    sumOf(
      rows.filter((r) => r.currency === c),
      c,
      rawOf,
      (r) => r.day_change,
      nameOf,
    ),
  );
  // weights within one currency, never across
  for (const c of currencies) {
    const inC = rows.filter((r) => r.currency === c);
    const all = inC.reduce((a, r) => a + (rawOf(r).value ?? 0), 0);
    for (const r of inC) {
      const v = rawOf(r).value;
      r.currency_weight = v === null || all === 0 ? null : pct((v / all) * 100);
    }
  }
  const dims = (
    list: readonly Row[],
    worth: (r: Row, v: number | null) => number | null,
  ) => {
    const each = list.flatMap((r) =>
      (parts.get(r) ?? []).map((s) => ({ r, s, v: worth(r, s.value) })),
    );
    return {
      market: sharesOf(each.map((e) => ({ key: e.r.market, value: e.v }))),
      type: sharesOf(each.map((e) => ({ key: e.r.type, value: e.v }))),
      portfolio: sharesOf(
        each.map((e) => ({
          key: names.get(e.s.portfolio) ?? null,
          value: e.v,
        })),
      ),
      broker: sharesOf(
        each.map((e) => ({
          key: e.s.broker === null ? null : (brokers.get(e.s.broker) ?? null),
          value: e.v,
        })),
      ),
    };
  };
  let exposure: Exposure[];
  let converted: Holdings["converted"] = null;
  const usedRates: Holdings["rates"] = [];
  if (scope.currency !== null) {
    const to = scope.currency;
    const fxOf = new Map<string, Rate>();
    for (const c of currencies) {
      const r = fx.rate(c, to, null);
      fxOf.set(c, r);
      usedRates.push({
        from: c,
        to,
        rate: exact(r.rate),
        pair: r.pair,
        at: r.at,
        stale: r.stale,
        ...("reason" in r ? { reason: r.reason } : {}),
      });
    }
    const valueIn = (r: Row, v: number | null) => {
      const rate = fxOf.get(r.currency)?.rate ?? null;
      return v === null || rate === null ? null : v * rate;
    };
    const all = rows.reduce((a, r) => a + (valueIn(r, rawOf(r).value) ?? 0), 0);
    for (const r of rows) {
      const v = valueIn(r, rawOf(r).value);
      if (r.converted !== undefined) {
        r.converted.weight =
          v === null || all === 0 ? null : pct((v / all) * 100);
      }
    }
    converted = sumOf(
      rows,
      to,
      (r) => {
        const raw =
          r.converted === undefined ? undefined : RAW_IN.get(r.converted);
        return {
          value: valueIn(r, rawOf(r).value),
          cost: raw?.cost ?? null,
        };
      },
      (r) => {
        const rate = fxOf.get(r.currency)?.rate ?? null;
        return r.day_change === null || rate === null
          ? null
          : r.day_change * rate;
      },
      (r) => {
        const rate = fxOf.get(r.currency);
        return rate !== undefined && "reason" in rate ? rate.reason : nameOf(r);
      },
    );
    exposure = [
      {
        currency: to,
        currency_weights: sharesOf(
          rows.map((r) => ({
            key: r.currency,
            value: valueIn(r, rawOf(r).value),
          })),
        ),
        ...dims(rows, valueIn),
      },
    ];
  } else {
    exposure = currencies.map((c) => ({
      currency: c,
      currency_weights: null,
      ...dims(
        rows.filter((r) => r.currency === c),
        (_r, v) => v,
      ),
    }));
  }
  // the closes costs were converted at, by pair, never one per day: a
  // long history would fill the answer
  const costRates = new Map<string, Holdings["cost_rates"][number]>();
  for (const u of fx.used()) {
    if (u.date === null || (u.rate.rate !== null && u.rate.pair === null)) {
      continue;
    }
    const missing = "reason" in u.rate;
    const key = `${u.from}>${u.to}${missing ? "!" : ""}`;
    const had = costRates.get(key);
    if (had === undefined) {
      costRates.set(key, {
        from: u.from,
        to: u.to,
        pair: u.rate.pair,
        count: 1,
        first: u.date,
        last: u.date,
        ...("reason" in u.rate ? { reason: u.rate.reason } : {}),
      });
    } else {
      had.count++;
      if (u.date < had.first) {
        had.first = u.date;
        // the earliest day's, as a reason names its day
        if ("reason" in u.rate) had.reason = u.rate.reason;
      }
      if (u.date > had.last) had.last = u.date;
    }
  }
  for (const r of rows) roundRow(r);
  for (const t of totals) roundTotal(t);
  if (converted !== null) roundTotal(converted);
  for (const e of exposure) {
    const d = minorUnits(e.currency);
    for (const list of [
      e.currency_weights ?? [],
      e.market,
      e.type,
      e.portfolio,
      e.broker,
    ]) {
      for (const x of list) x.value = cents(x.value, d)!;
    }
  }
  rows.sort(
    (a, b) =>
      a.currency.localeCompare(b.currency) ||
      (rawOf(b).value ?? 0) - (rawOf(a).value ?? 0) ||
      (a.id ?? a.name ?? "").localeCompare(b.id ?? b.name ?? ""),
  );
  return {
    currency: scope.currency,
    totals,
    converted,
    rates: usedRates,
    cost_rates: [...costRates.values()].sort(
      (a, b) =>
        a.from.localeCompare(b.from) ||
        a.to.localeCompare(b.to) ||
        (a.reason === undefined ? 0 : 1) - (b.reason === undefined ? 0 : 1),
    ),
    exposure,
    holdings: rows,
  };
}

// money to the currency's minor units in the answer; the sums before it
// were made unrounded, and prices, quantities and rates keep their digits
function roundRow(r: Row): void {
  const d = minorUnits(r.currency);
  r.cost = cents(r.cost, d);
  r.value = cents(r.value, d);
  r.pl = cents(r.pl, d);
  r.day_change = cents(r.day_change, d);
  for (const p of r.parts) {
    p.cost = cents(p.cost, d);
    p.value = cents(p.value, d);
  }
  for (const p of r.paid ?? [])
    p.amount = cents(p.amount, minorUnits(p.currency));
  if (r.converted !== undefined) {
    const c = minorUnits(r.converted.currency);
    r.converted.value = cents(r.converted.value, c);
    r.converted.cost = cents(r.converted.cost, c);
    r.converted.pl = cents(r.converted.pl, c);
  }
}

function roundTotal(t: Total): void {
  const d = minorUnits(t.currency);
  t.value = cents(t.value, d);
  t.cost = cents(t.cost, d);
  t.pl = cents(t.pl, d);
  t.day_change = cents(t.day_change, d);
  t.invested = cents(t.invested, d);
  t.cash = cents(t.cash, d);
  t.dry_powder = cents(t.dry_powder, d);
}

// every currency pair a conversion in this scope would read, so missing
// ones are fetched before the answer is made
export function pairsNeeded(
  db: Db,
  scope: Pick<Scope, "portfolio" | "broker" | "currency">,
  trades: readonly Trade[] = scopeTrades(db, scope),
): [string, string][] {
  const out: [string, string][] = [];
  const listing = new Map<string, string | null>();
  for (const t of trades) {
    if (!listing.has(t.instrument)) {
      listing.set(
        t.instrument,
        readInstrument(db, t.instrument)?.currency ?? null,
      );
    }
    const l = listing.get(t.instrument);
    if (l != null && l !== t.currency) out.push([t.currency, l]);
    if (scope.currency !== null) {
      out.push([t.currency, scope.currency]);
      if (l != null) out.push([l, scope.currency]);
    }
  }
  if (scope.currency !== null) {
    for (const p of readPositions(db, {
      portfolio: scope.portfolio,
      broker: scope.broker,
    })) {
      out.push([p.currency, scope.currency]);
    }
  }
  return out;
}

// counting sells needs no rate
const NO_RATES: Rates = {
  rate: () => ({ rate: 1, pair: null, at: null, stale: [] }),
  used: () => [],
};

const byDate = (a: Trade, b: Trade) =>
  a.date === b.date ? a.id - b.id : a.date < b.date ? -1 : 1;

// one part's trades, removed ones aside
export function partTrades(
  db: Db,
  part: { portfolio: number; instrument: string; broker: number | null },
): Trade[] {
  return readTrades(db, {
    portfolio: part.portfolio,
    instrument: part.instrument,
  }).filter((t) => t.broker === part.broker);
}

// sells past what the part held, over its whole history
export function oversellsOf(
  trades: readonly Trade[],
  instrument: Instrument,
  splits: readonly Split[],
): number {
  return partsOf(trades, instrument, splits, NO_RATES, null).reduce(
    (n, p) => n + p.oversells,
    0,
  );
}

// a change is refused only when it adds a sell past what is held at any
// date, so a part already oversold by an old entry never blocks the rest
export function addsOversell(
  before: readonly Trade[],
  after: readonly Trade[],
  instrument: Instrument,
  splits: readonly Split[],
): boolean {
  return (
    oversellsOf(after, instrument, splits) >
    oversellsOf(before, instrument, splits)
  );
}

// the sells of one part a change leaves oversold that were not before,
// oldest first, so a refusal names the sale to remove first
export function newlyOversold(
  before: readonly Trade[],
  after: readonly Trade[],
  splits: readonly Split[],
): Trade[] {
  const over = (list: readonly Trade[]) => {
    const out: Trade[] = [];
    let held = 0;
    for (const t of [...list].sort(byDate)) {
      const s = sellStep(
        held,
        t.side,
        t.quantity * splitFactor(splits, statedOf(t)),
      );
      held = s.held;
      if (s.over) out.push(t);
    }
    return out;
  };
  const was = new Set(over(before).map((t) => t.id));
  return over(after).filter((t) => !was.has(t.id));
}

// what a sell on a day can take, in that day's shares: the least the
// part holds from that day on, so it never sells what a later sell sold
export function sellableOn(
  trades: readonly Trade[],
  splits: readonly Split[],
  day: string,
): number {
  let held = 0;
  let least = Number.POSITIVE_INFINITY;
  let reached = false;
  for (const t of [...trades].sort(byDate)) {
    if (t.date > day && !reached) {
      least = held;
      reached = true;
    }
    const shares = t.quantity * splitFactor(splits, statedOf(t));
    // emptied as partsOf empties a part, so all never sells float noise
    held = sellStep(held, t.side, shares).held;
    if (reached) least = Math.min(least, held);
  }
  if (!reached) least = held;
  return Math.max(0, least) / splitFactor(splits, day);
}

// trades of a new row, numbered after every stored one
export const pending = (
  rows: readonly Omit<Trade, "id" | "enteredAt" | "removedAt" | "removedBy">[],
): Trade[] =>
  rows.map((r, k) => ({
    ...r,
    id: Number.MAX_SAFE_INTEGER - rows.length + k,
    enteredAt: 0,
    removedAt: null,
    removedBy: null,
  }));
