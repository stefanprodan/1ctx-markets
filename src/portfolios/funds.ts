// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// A fund the owner prices: an instrument keyed fund:<ISIN> that no source
// fetches, and its dated prices. Rows only; holdings are private. A fund
// and its prices are shared by everyone who holds it; who holds it never is.

import { type Instrument, upsertInstrument } from "../market/instruments.ts";
import { FUND_MARKET, FUND_SOURCE } from "../sources/ids.ts";
import type { Db } from "../storage/db/index.ts";
import type { Trade } from "./store.ts";

export type Fund = {
  id: string;
  isin: string;
  name: string;
  currency: string;
  // the market its money is in, for the exposure; none unless named
  market: string | null;
};

export type FundPrice = {
  date: string;
  price: number;
  // the buy whose price stands for the day; null: one entered by hand
  trade: number | null;
  // users.id of who entered it, by hand or by their buy; null once they
  // are gone
  user: string | null;
  enteredBy: string;
  enteredAt: number;
};

export const fundKey = (isin: string): string => `${FUND_MARKET}:${isin}`;

// any case, as an agent may write the key back
export const isFundKey = (input: string): boolean =>
  input.trim().toLowerCase().startsWith(`${FUND_MARKET}:`);

export const isFund = (i: Pick<Instrument, "source">): boolean =>
  i.source === FUND_SOURCE;

const PRICE = `select date, price, trade, user_id as user,
  entered_by as enteredBy, entered_at as enteredAt from fund_prices`;

const FUND = `select i.id, i.symbol as isin, i.name, i.currency, f.market
  from funds f join instruments i on i.id = f.instrument`;

export function readFund(db: Db, id: string): Fund | null {
  return db.query<Fund, [string]>(`${FUND} where i.id = ?`).get(id) ?? null;
}

// a person sees a fund while a trade of theirs names it or they priced it
const SEEN = `(exists (select 1 from trades t
    join portfolios p on p.id = t.portfolio
    where t.instrument = i.id and p.owner = ?1)
  or exists (select 1 from fund_prices fp
    where fp.instrument = i.id and fp.user_id = ?1))`;

export function listFunds(db: Db, owner: string): Fund[] {
  return db
    .query<Fund, [string]>(
      `${FUND} where ${SEEN} order by i.name collate nocase, i.id`,
    )
    .all(owner);
}

export function seesFund(db: Db, owner: string, id: string): boolean {
  return (
    db
      .query<Fund, [string, string]>(`${FUND} where ${SEEN} and i.id = ?2`)
      .get(owner, id) !== null
  );
}

export function fundByName(db: Db, name: string): Fund | null {
  return (
    db
      .query<Fund, [string]>(`${FUND} where i.name = ? collate nocase`)
      .get(name.trim()) ?? null
  );
}

// by its ISIN or key, any case
export function fundByIsin(db: Db, input: string): Fund | null {
  const given = input.trim().toUpperCase();
  const isin = given.startsWith(`${FUND_MARKET.toUpperCase()}:`)
    ? given.slice(FUND_MARKET.length + 1)
    : given;
  return readFund(db, fundKey(isin));
}

export type NewFund = Omit<Fund, "id">;

// in its first trade's write, after every check, so a refused one makes
// no fund
export function insertFund(db: Db, f: NewFund, by: string, now: number): Fund {
  const i = upsertInstrument(
    db,
    {
      market: FUND_MARKET,
      symbol: f.isin,
      source: FUND_SOURCE,
      sourceSymbol: f.isin,
      exchange: "",
      name: f.name,
      type: "FUND",
      currency: f.currency,
      unit: "per_share",
      // no exchange: a fund's day is the owner's, set by the caller
      zone: "UTC",
    },
    now,
  );
  db.query(
    "insert into funds (instrument, market, entered_by, entered_at) values (?, ?, ?, ?)",
  ).run(i.id, f.market, by, now);
  return readFund(db, i.id)!;
}

export function setFundMarket(db: Db, id: string, market: string | null) {
  db.query("update funds set market = ? where instrument = ?").run(market, id);
}

export function latestPrice(db: Db, id: string): FundPrice | null {
  return (
    db
      .query<FundPrice, [string]>(
        `${PRICE} where instrument = ? order by date desc limit 1`,
      )
      .get(id) ?? null
  );
}

// newest first
export function fundPrices(db: Db, id: string): FundPrice[] {
  return db
    .query<FundPrice, [string]>(
      `${PRICE} where instrument = ? order by date desc`,
    )
    .all(id);
}

export function priceOn(db: Db, id: string, date: string): FundPrice | null {
  return (
    db
      .query<FundPrice, [string, string]>(
        `${PRICE} where instrument = ? and date = ?`,
      )
      .get(id, date) ?? null
  );
}

// one price a day: one entered by hand replaces any for the day, a buy's too
export function setFundPrice(
  db: Db,
  id: string,
  date: string,
  price: number,
  by: { name: string; user: string },
  now: number,
): void {
  db.query(
    `insert into fund_prices (instrument, date, price, trade, user_id,
       entered_by, entered_at)
     values (?, ?, ?, null, ?, ?, ?) on conflict (instrument, date) do update set
       price = excluded.price, trade = null, user_id = excluded.user_id,
       entered_by = excluded.entered_by, entered_at = excluded.entered_at`,
  ).run(id, date, price, by.user, by.name, now);
}

type Buy = Pick<
  Trade,
  | "id"
  | "portfolio"
  | "instrument"
  | "side"
  | "date"
  | "price"
  | "currency"
  | "enteredBy"
>;

// the day's latest live buy in the fund's own currency stands for it
// while the owner has entered none; another currency's price is not the
// fund's
export function buyPrice(db: Db, t: Buy, now: number): void {
  if (t.side !== "buy" || t.currency !== readFund(db, t.instrument)?.currency)
    return;
  db.query(
    `insert into fund_prices (instrument, date, price, trade, user_id,
       entered_by, entered_at)
     values (?1, ?2, ?3, ?4, (select owner from portfolios where id = ?5),
       ?6, ?7)
     on conflict (instrument, date) do update set
       price = excluded.price, trade = excluded.trade,
       user_id = excluded.user_id,
       entered_by = excluded.entered_by, entered_at = excluded.entered_at
     where fund_prices.trade < excluded.trade`,
  ).run(t.instrument, t.date, t.price, t.id, t.portfolio, t.enteredBy, now);
}

// a removed buy's price goes with it; the day's latest live buy, if any,
// anyone's, since prices are shared, stands in its place
export function dropBuyPrice(db: Db, t: Buy, now: number): void {
  const gone = db
    .query("delete from fund_prices where trade = ?")
    .run(t.id).changes;
  if (gone === 0) return;
  const next = db
    .query<Buy, [string, string]>(
      `select id, portfolio, instrument, side, date, price, currency,
         entered_by as enteredBy
       from trades where instrument = ? and date = ? and side = 'buy'
         and removed_at is null order by id desc`,
    )
    .all(t.instrument, t.date)
    .find((x) => x.currency === readFund(db, x.instrument)?.currency);
  if (next !== undefined) buyPrice(db, next, now);
}

// a name or a currency set right; the caller checks the name is free and
// the currency has no live trade priced in it. Prices were in the old
// currency, so a new one drops them
export function setFundDetails(
  db: Db,
  id: string,
  change: { name?: string; currency?: string },
  now: number,
): void {
  if (
    change.currency !== undefined &&
    change.currency !== readFund(db, id)?.currency
  ) {
    db.query("delete from fund_prices where instrument = ?").run(id);
  }
  db.query(
    `update instruments set name = coalesce(?, name),
       currency = coalesce(?, currency), updated_at = ? where id = ?`,
  ).run(change.name ?? null, change.currency ?? null, now, id);
}
