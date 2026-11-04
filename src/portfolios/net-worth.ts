// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// Net worth per day: the holdings' value as growth rebuilds it plus every
// cash account's balance on the day, from stored rows only, its last
// point the holdings answer's own figures.

import { localDate } from "../market/zone.ts";
import type { Db } from "../storage/db/index.ts";
import { balanceOn, counted } from "./balances.ts";
import {
  dailyCloses,
  growth,
  pairsTo,
  rateBook,
  yearBefore,
} from "./growth.ts";
import type { Broker, Portfolio, Position } from "./store.ts";
import { cashEntriesOf } from "./store.ts";
import { holdings, minorUnits, scopeTrades } from "./value.ts";

export type NetWorthPoint = {
  date: string;
  invested: number;
  cash: number;
  total: number;
};

export type NetWorth = {
  currency: string;
  from: string;
  to: string;
  points: NetWorthPoint[];
  eased: string[];
  missing: string[];
};

type Scope = {
  owner: string;
  portfolios: readonly Portfolio[];
  brokers: readonly Broker[];
  currency: string;
  // the owner's zone, which dates a removal
  zone: string;
};

type Account = {
  entries: Position[];
  // the day it was removed, null while live: counted only before it
  until: string | null;
};

const DAY = 86_400_000;
const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const ms = (day: string) => Date.parse(`${day}T00:00:00Z`);

// the owner's cash rows grouped by account: a row's chain through
// replaces, a past balance with the row it was entered on
export function accountsOf(rows: readonly Position[], zone: string): Account[] {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const roots = new Map<number, number>();
  const rootOf = (r: Position): number => {
    const known = roots.get(r.id);
    if (known !== undefined) return known;
    const seen = new Set<number>();
    let at = r;
    for (;;) {
      seen.add(at.id);
      const up = at.pastOf ?? at.replaces;
      const next = up === null ? undefined : byId.get(up);
      if (next === undefined || seen.has(next.id)) break;
      at = next;
    }
    for (const id of seen) roots.set(id, at.id);
    return at.id;
  };
  const chains = new Map<number, Position[]>();
  for (const r of rows) {
    const root = rootOf(r);
    const list = chains.get(root);
    if (list) list.push(r);
    else chains.set(root, [r]);
  }
  const out: Account[] = [];
  for (const all of chains.values()) {
    const entries = counted(all);
    if (entries.length === 0) continue;
    const own = all.filter((r) => r.pastOf === null);
    const live = own.some((r) => r.removedAt === null);
    const gone = Math.max(...own.map((r) => r.removedAt ?? 0));
    out.push({ entries, until: live ? null : localDate(zone, gone) });
  }
  return out;
}

export function netWorth(
  db: Db,
  scope: Scope,
  today: string,
  now: number,
  everyMs: number,
): NetWorth {
  const target = scope.currency;
  const to = today;
  const trades = scopeTrades(db, {
    owner: scope.owner,
    portfolio: null,
    broker: null,
  });
  const live = holdings(
    db,
    {
      owner: scope.owner,
      portfolios: scope.portfolios,
      brokers: scope.brokers,
      portfolio: null,
      broker: null,
      currency: target,
    },
    now,
    everyMs,
    trades,
  );
  const g = growth(
    db,
    {
      owner: scope.owner,
      portfolios: scope.portfolios,
      brokers: scope.brokers,
      portfolio: null,
      currency: target,
    },
    to,
    now,
    everyMs,
    { trades, live },
  );
  const accounts = accountsOf(cashEntriesOf(db, scope.owner), scope.zone);
  const open = accounts.filter((a) => a.until === null);
  const missing = new Set(g.missing);
  if (open.length === 0 && g.points.length === 0) {
    return { ...g, points: [] };
  }
  // the line starts once every live account has a balance, so none counts
  // as nothing before it was entered; a removed one never holds it
  const firsts = open.map((a) => a.entries.map((e) => e.asOf).sort()[0]!);
  let from =
    firsts.length === 0
      ? g.from
      : [firsts.sort().at(-1)!, yearBefore(to)].sort()[1]!;
  if (from > to) from = to;

  const currencies = new Set(
    accounts.flatMap((a) => a.entries.map((e) => e.currency)),
  );
  const pairs = pairsTo(db, currencies, target);
  const closes = dailyCloses(
    db,
    [...pairs.values()].map((id) => [id, from, 1] as const),
    to,
  );
  const { rate, pairName } = rateBook(pairs, closes, target, missing);

  const d = minorUnits(target);
  const round = (v: number) => Number(v.toFixed(d)) + 0;
  const invested = new Map(g.points.map((p) => [p.date, p.value]));
  const cashOn = (day: string) => {
    let sum = 0;
    for (const a of accounts) {
      if (a.until !== null && day >= a.until) continue;
      const e = balanceOn(a.entries, day);
      if (e === null) continue;
      const r = rate(e.currency, day);
      if (r !== null) sum += (e.amount ?? 0) * r;
    }
    return sum;
  };
  const points: NetWorthPoint[] = [];
  for (let t = ms(from); t < ms(to); t += DAY) {
    const day = dayOf(t);
    const inv = invested.get(day) ?? 0;
    const cash = round(cashOn(day));
    points.push({ date: day, invested: inv, cash, total: round(inv + cash) });
  }

  // today is the holdings answer's own: its net worth, cash being dry
  // powder and reserve, so the two never differ
  for (const r of live.holdings) {
    if (r.kind === "cash" && r.converted?.value == null) {
      missing.add(pairName(r.currency));
    }
  }
  const c = live.converted;
  if (
    c !== null &&
    c.net_worth != null &&
    c.dry_powder !== null &&
    c.reserve !== null
  ) {
    const cash = round(c.dry_powder + c.reserve);
    points.push({
      date: to,
      invested: round(c.net_worth - cash),
      cash,
      total: c.net_worth,
    });
  } else {
    const inv = invested.get(to) ?? 0;
    const cash = round(cashOn(to));
    points.push({ date: to, invested: inv, cash, total: round(inv + cash) });
  }
  return {
    currency: target,
    from,
    to,
    points,
    eased: g.eased,
    missing: [...missing].sort(),
  };
}
