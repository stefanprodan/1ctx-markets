// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// The holdings' growth per day over the past year, rebuilt from stored
// rows only: trades, splits, daily closes, fund prices and bond
// positions. Nothing is fetched; a day with no row to price counts 0.

import type { Instrument } from "../market/instruments.ts";
import { HUNDREDTHS } from "../shared/currencies.ts";
import { YAHOO } from "../sources/ids.ts";
import type { Db } from "../storage/db/index.ts";
import { isFund } from "./funds.ts";
import { pairSymbols } from "./fx.ts";
import type { Broker, Portfolio, Split, Trade } from "./store.ts";
import {
  type Holdings,
  holdings,
  minorUnits,
  scopeTrades,
  sellStep,
  splitFactor,
  statedOf,
} from "./value.ts";

export type GrowthPoint = {
  date: string;
  value: number;
  invested: number;
  gain: number;
};

export type Growth = {
  currency: string;
  from: string;
  to: string;
  points: GrowthPoint[];
  eased: string[];
  missing: string[];
};

type Scope = {
  owner: string;
  portfolios: readonly Portfolio[];
  brokers: readonly Broker[];
  portfolio: number | null;
  currency: string;
};

export type Close = { date: string; close: number };

type Bond = {
  instrument: string | null;
  currency: string;
  amount: number;
  cost: number | null;
  // its chain's first as_of: an edit dates the row, not the buy
  start: string;
};

const major = (c: string): [string, number] => HUNDREDTHS[c] ?? [c, 1];

const DAY = 86_400_000;
const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const ms = (day: string) => Date.parse(`${day}T00:00:00Z`);

// the same day a year before; 29 Feb falls back to 28 Feb
export function yearBefore(day: string): string {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  const last = new Date(Date.UTC(y - 1, m, 0)).getUTCDate();
  return dayOf(Date.UTC(y - 1, m - 1, Math.min(d, last)));
}

// the last close on or before a day
export function closeOn(series: readonly Close[] | undefined, day: string) {
  if (series === undefined) return null;
  let lo = 0;
  let hi = series.length - 1;
  let found: Close | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (series[mid]!.date <= day) {
      found = series[mid]!;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found;
}

// a straight line between the owner's prices, flat before the first and
// after the last; exact when a price is the day's own
function eased(series: readonly Close[], day: string) {
  const before = closeOn(series, day);
  if (before === null) return { price: series[0]!.close, exact: false };
  if (before.date === day) return { price: before.close, exact: true };
  const after = series[series.indexOf(before) + 1];
  if (after === undefined) return { price: before.close, exact: false };
  const t = (ms(day) - ms(before.date)) / (ms(after.date) - ms(before.date));
  return {
    price: before.close + (after.close - before.close) * t,
    exact: false,
  };
}

const unitOf = (i: Pick<Instrument, "unit">) =>
  i.unit === "percent_of_par" ? 1 / 100 : 1;

export function growth(
  db: Db,
  scope: Scope,
  today: string,
  now: number,
  everyMs: number,
  // what the caller read already: the scope's trades and the holdings
  // answer today's point is read from
  given: { trades?: readonly Trade[]; live?: Holdings } = {},
): Growth {
  const to = today;
  const target = scope.currency;
  const empty: Growth = {
    currency: target,
    from: to,
    to,
    points: [],
    eased: [],
    missing: [],
  };
  const trades =
    given.trades ??
    scopeTrades(db, {
      owner: scope.owner,
      portfolio: scope.portfolio,
      broker: null,
    });
  const bonds = bondsOf(db, scope.owner, scope.portfolio);
  const ids = [
    ...new Set([
      ...trades.map((t) => t.instrument),
      ...bonds.flatMap((b) => (b.instrument === null ? [] : [b.instrument])),
    ]),
  ];
  const instruments = new Map(
    db
      .query<Instrument, [string]>(
        `select id, market, symbol, source, source_symbol as sourceSymbol,
           exchange, name, type, currency, unit, zone, added_at as addedAt,
           updated_at as updatedAt
         from instruments where id in (select value from json_each(?))`,
      )
      .all(JSON.stringify(ids))
      .map((i) => [i.id, i]),
  );
  const held = trades.filter(
    (t) => t.date <= to && instruments.has(t.instrument),
  );
  const firsts = [
    ...held.filter((t) => t.side === "buy").map((t) => t.date),
    ...bonds.map((b) => b.start).filter((d) => d <= to),
  ].sort();
  if (firsts.length === 0) return empty;
  const yearAgo = yearBefore(to);
  // where the rebuild starts; the answer starts on the first day held
  const start = [firsts[0]!, yearAgo].sort()[1]!;
  if (start >= to) return empty;

  const splits = new Map<string, Split[]>();
  for (const s of db
    .query<Split & { instrument: string }, [string]>(
      `select instrument, date, numerator / denominator as ratio from splits
       where instrument in (select value from json_each(?)) order by date`,
    )
    .all(JSON.stringify(ids))) {
    const list = splits.get(s.instrument);
    if (list) list.push(s);
    else splits.set(s.instrument, [s]);
  }

  // every currency a value or a sum of money is in, and the pairs to it
  const currencies = new Set<string>();
  for (const i of instruments.values()) {
    if (i.currency !== null) currencies.add(i.currency);
  }
  for (const t of trades) currencies.add(t.currency);
  for (const b of bonds) currencies.add(b.currency);
  const pairs = pairsTo(db, currencies, target);

  // money in is converted at its own day's close, which can be years back
  const earliest = [
    start,
    ...held.map((t) => t.date),
    ...bonds.map((b) => b.start),
  ].sort()[0]!;
  const want: [string, string, number][] = [
    ...ids
      .filter((id) => !isFund(instruments.get(id) ?? { source: "" }))
      .map((id): [string, string, number] => [id, start, 0]),
    ...[...pairs.values()].map((id): [string, string, number] => [
      id,
      earliest,
      1,
    ]),
  ];
  const closes = dailyCloses(db, want, to);

  const fundPrices = new Map<string, Close[]>();
  for (const r of db
    .query<Close & { id: string }, [string]>(
      `select instrument as id, date, price as close from fund_prices
       where instrument in (select value from json_each(?))
       order by instrument, date`,
    )
    .all(JSON.stringify(ids))) {
    const list = fundPrices.get(r.id);
    if (list) list.push({ date: r.date, close: r.close });
    else fundPrices.set(r.id, [{ date: r.date, close: r.close }]);
  }

  const missing = new Set<string>();
  // never priced in the window: left out whole, so its cost never draws
  // as a loss
  const unpriced = new Set<string>();
  for (const [id, i] of instruments) {
    const priced = isFund(i)
      ? (fundPrices.get(id)?.length ?? 0) > 0
      : (closes.get(id)?.length ?? 0) > 0;
    if (!priced && trades.some((t) => t.instrument === id)) {
      unpriced.add(id);
      missing.add(id);
    }
  }
  const { rate, pairName } = rateBook(pairs, closes, target, missing);

  const flowOf = (t: Trade, i: Instrument) => {
    const gross = t.quantity * t.price * unitOf(i);
    return t.side === "buy" ? gross + t.fees : -(gross - t.fees);
  };

  const sorted = [...trades].sort((a, b) =>
    a.date === b.date ? a.id - b.id : a.date < b.date ? -1 : 1,
  );
  // held per instrument, by portfolio and broker part, as partsOf holds it
  const parts = new Map<string, Map<string, number>>();
  const quantity = (id: string) => {
    let q = 0;
    for (const v of parts.get(id)?.values() ?? []) q += v;
    return q;
  };
  let invested = 0;
  let next = 0;
  const apply = (until: string) => {
    while (next < sorted.length && sorted[next]!.date <= until) {
      const t = sorted[next++]!;
      const i = instruments.get(t.instrument);
      if (i === undefined || unpriced.has(i.id)) continue;
      const shares =
        t.quantity * splitFactor(splits.get(i.id) ?? [], statedOf(t));
      const byPart = parts.get(i.id) ?? new Map<string, number>();
      parts.set(i.id, byPart);
      const key = `${t.portfolio}/${t.broker ?? ""}`;
      byPart.set(key, sellStep(byPart.get(key) ?? 0, t.side, shares).held);
      const r = rate(t.currency, t.date);
      if (r !== null) invested += flowOf(t, i) * r;
    }
  };
  // bonds' money in counts once, on their first day
  const bondsIn = new Set<Bond>();
  const bondFlows = (until: string) => {
    for (const b of bonds) {
      if (b.start > until || bondsIn.has(b)) continue;
      bondsIn.add(b);
      const r = rate(b.currency, b.start);
      if (r !== null) invested += (b.cost ?? b.amount) * r;
    }
  };

  // a listed bond moves with its closes from today's live value
  const live =
    given.live ??
    holdings(
      db,
      {
        owner: scope.owner,
        portfolios: scope.portfolios,
        brokers: scope.brokers,
        portfolio: scope.portfolio,
        broker: null,
        currency: target,
      },
      now,
      everyMs,
      trades,
    );
  // live price over the last close, so each day's close scales today's value
  const bondScale = new Map<string, number>();
  for (const b of bonds) {
    const i = b.instrument === null ? undefined : instruments.get(b.instrument);
    if (i === undefined || i.unit !== "percent_of_par") continue;
    const row = live.holdings.find((r) => r.kind === "bond" && r.id === i.id);
    const last = closeOn(closes.get(i.id), to);
    if (row?.price == null || last === null || last.close <= 0) continue;
    bondScale.set(i.id, row.price / last.close);
  }

  const easedIds = new Set<string>();
  const points: (GrowthPoint & { held: boolean })[] = [];
  let days = 0;
  const d = minorUnits(target);
  const round = (v: number) => Number(v.toFixed(d)) + 0;
  for (let t = ms(start); t < ms(to); t += DAY) {
    const day = dayOf(t);
    apply(day);
    bondFlows(day);
    let value = 0;
    let any = false;
    for (const [id] of parts) {
      const q = quantity(id);
      if (q <= 0) continue;
      any = true;
      const i = instruments.get(id)!;
      let price: number | null = null;
      if (isFund(i)) {
        const list = fundPrices.get(id);
        if (list !== undefined && list.length > 0) {
          const e = eased(list, day);
          price = e.price;
          if (!e.exact) easedIds.add(id);
        }
      } else price = closeOn(closes.get(id), day)?.close ?? null;
      if (price === null || i.currency === null) {
        missing.add(id);
        continue;
      }
      const r = rate(i.currency, day);
      if (r !== null) value += q * price * unitOf(i) * r;
    }
    for (const b of bonds) {
      if (b.start > day) continue;
      any = true;
      const scale =
        b.instrument === null ? undefined : bondScale.get(b.instrument);
      const close =
        scale === undefined ? null : closeOn(closes.get(b.instrument!), day);
      const worth =
        close === null ? b.amount : (b.amount * close.close * scale!) / 100;
      const r = rate(b.currency, day);
      if (r !== null) value += worth * r;
    }
    if (any) days++;
    points.push({
      held: any,
      date: day,
      value: round(value),
      invested: round(invested),
      gain: round(value - invested),
    });
  }

  // today is the holdings' own live value; every trade counts in money in
  apply("9999-12-31");
  bondFlows("9999-12-31");
  for (const r of live.holdings) {
    if (r.kind === "cash" || r.converted?.value != null) continue;
    missing.add(
      r.value === null ? (r.id ?? r.name ?? "") : pairName(r.currency),
    );
  }
  // the converted total's invested is the sum of the rows but cash
  let value = live.converted?.invested ?? 0;
  for (const r of live.holdings) {
    if (r.id !== null && unpriced.has(r.id)) value -= r.converted?.value ?? 0;
  }
  if (
    live.holdings.some(
      (r) =>
        r.kind !== "cash" &&
        (r.quantity ?? 1) > 0 &&
        !(r.id !== null && unpriced.has(r.id)),
    )
  ) {
    days++;
  }
  if (days < 2) return { ...empty, missing: [...missing].sort() };
  // a stretch held nothing mid-window stays; one before the first day goes
  const first = points.findIndex((p) => p.held);
  const kept = first === -1 ? [] : points.slice(first);
  const from = kept[0]?.date ?? to;
  const out: GrowthPoint[] = kept.map(({ held: _, ...p }) => p);
  out.push({
    date: to,
    value: round(value),
    invested: round(invested),
    gain: round(value - invested),
  });
  return {
    currency: target,
    from,
    to,
    points: out,
    eased: [...easedIds].sort(),
    missing: [...missing].sort(),
  };
}

// the view's live bonds, each dated by the first row of its chain; every
// bond row of the owner's is read once, as an edit may have moved it
// between portfolios
function bondsOf(db: Db, owner: string, portfolio: number | null): Bond[] {
  const rows = db
    .query<
      {
        id: number;
        portfolio: number;
        instrument: string | null;
        currency: string;
        amount: number | null;
        cost: number | null;
        asOf: string;
        replaces: number | null;
        removedAt: number | null;
      },
      [string]
    >(
      `select id, portfolio, instrument, currency, amount, cost,
         as_of as asOf, replaces, removed_at as removedAt
       from positions where kind = 'bond'
         and portfolio in (select id from portfolios where owner = ?)`,
    )
    .all(owner);
  const byId = new Map(rows.map((r) => [r.id, r]));
  const out: Bond[] = [];
  for (const r of rows) {
    if (r.removedAt !== null) continue;
    if (portfolio !== null && r.portfolio !== portfolio) continue;
    let first = r;
    const seen = new Set<number>();
    while (first.replaces !== null && !seen.has(first.id)) {
      seen.add(first.id);
      const up = byId.get(first.replaces);
      if (up === undefined) break;
      first = up;
    }
    out.push({
      instrument: r.instrument,
      currency: r.currency,
      amount: r.amount ?? 0,
      cost: r.cost,
      start: first.asOf,
    });
  }
  return out;
}

// the stored pairs between each currency and the target, by Yahoo symbol
export function pairsTo(
  db: Db,
  currencies: Iterable<string>,
  target: string,
): Map<string, string> {
  const symbols = [...currencies].flatMap((c) => pairSymbols(c, target));
  return new Map(
    db
      .query<{ id: string; symbol: string }, [string, string]>(
        `select id, source_symbol as symbol from instruments
         where source = ? and source_symbol in (select value from json_each(?))`,
      )
      .all(YAHOO, JSON.stringify(symbols))
      .map((r) => [r.symbol, r.id]),
  );
}

// each id's daily closes up to a day, from its last close on or before
// its own start; pair 1 reads final closes only, as a rate must
export function dailyCloses(
  db: Db,
  want: readonly (readonly [string, string, number])[],
  to: string,
): Map<string, Close[]> {
  const closes = new Map<string, Close[]>();
  for (const r of db
    .query<Close & { id: string }, [string, string]>(
      `with want(id, lo, pair) as (
         select value ->> 0, value ->> 1, value ->> 2 from json_each(?1)
       ),
       start(id, lo, pair) as (
         select id, coalesce((select max(date) from bars
           where instrument = want.id and interval = '1d'
             and (final = 1 or want.pair = 0) and date <= want.lo), want.lo),
           pair
         from want
       )
       select b.instrument as id, b.date, b.close from start s
       join bars b on b.instrument = s.id and b.interval = '1d'
         and b.date >= s.lo and b.date <= ?2
       where b.final = 1 or s.pair = 0
       order by b.instrument, b.date`,
    )
    .all(JSON.stringify(want), to)) {
    const list = closes.get(r.id);
    const c = { date: r.date, close: r.close };
    if (list) list.push(c);
    else closes.set(r.id, [c]);
  }
  return closes;
}

// a pair's last final close on or before the day, either way listed; a
// day with none names the pair in missing
export function rateBook(
  pairs: ReadonlyMap<string, string>,
  closes: ReadonlyMap<string, readonly Close[]>,
  target: string,
  missing: Set<string>,
) {
  const pairName = (c: string) => {
    const [direct, inverse] = pairSymbols(c, target);
    const stored = pairs.get(direct!) ?? pairs.get(inverse!);
    return stored ?? `CCY:${direct}`;
  };
  const rate = (c: string, day: string): number | null => {
    const [a, am] = major(c);
    const [b, bm] = major(target);
    if (a === b) return am / bm;
    for (const [symbol, inverse] of [
      [`${a}${b}=X`, false],
      [`${b}${a}=X`, true],
    ] as const) {
      const id = pairs.get(symbol);
      const close = id === undefined ? null : closeOn(closes.get(id), day);
      if (close === null || close.close <= 0) continue;
      return (inverse ? 1 / close.close : close.close) * (am / bm);
    }
    missing.add(pairName(c));
    return null;
  };
  return { rate, pairName };
}
