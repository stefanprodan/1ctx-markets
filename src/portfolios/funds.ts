// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// A fund the owner prices: an instrument keyed fund:<ISIN> that no source
// fetches, and its dated prices. Rows only; holdings are private.

import { type Instrument, upsertInstrument } from "../market/instruments.ts";
import { FUND_MARKET, FUND_SOURCE } from "../sources/ids.ts";
import type { Db } from "../storage/db/index.ts";

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
  enteredBy: string;
  enteredAt: number;
};

export const fundKey = (isin: string): string => `${FUND_MARKET}:${isin}`;

// any case, as an agent may write the key back
export const isFundKey = (input: string): boolean =>
  input.trim().toLowerCase().startsWith(`${FUND_MARKET}:`);

export const isFund = (i: Pick<Instrument, "source">): boolean =>
  i.source === FUND_SOURCE;

const FUND = `select i.id, i.symbol as isin, i.name, i.currency, f.market
  from funds f join instruments i on i.id = f.instrument`;

export function readFund(db: Db, id: string): Fund | null {
  return db.query<Fund, [string]>(`${FUND} where i.id = ?`).get(id) ?? null;
}

export function listFunds(db: Db): Fund[] {
  return db
    .query<Fund, []>(`${FUND} order by i.name collate nocase, i.id`)
    .all();
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

// in the caller's write, so a refused first trade makes no fund
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
        `select date, price, entered_by as enteredBy, entered_at as enteredAt
         from fund_prices where instrument = ? order by date desc limit 1`,
      )
      .get(id) ?? null
  );
}

// newest first
export function fundPrices(db: Db, id: string): FundPrice[] {
  return db
    .query<FundPrice, [string]>(
      `select date, price, entered_by as enteredBy, entered_at as enteredAt
       from fund_prices where instrument = ? order by date desc`,
    )
    .all(id);
}

export function priceOn(db: Db, id: string, date: string): FundPrice | null {
  return (
    db
      .query<FundPrice, [string, string]>(
        `select date, price, entered_by as enteredBy, entered_at as enteredAt
         from fund_prices where instrument = ? and date = ?`,
      )
      .get(id, date) ?? null
  );
}

// one price a day: a second entry for the day replaces the first
export function setFundPrice(
  db: Db,
  id: string,
  date: string,
  price: number,
  by: string,
  now: number,
): void {
  db.query(
    `insert into fund_prices (instrument, date, price, entered_by, entered_at)
     values (?, ?, ?, ?, ?) on conflict (instrument, date) do update set
       price = excluded.price, entered_by = excluded.entered_by,
       entered_at = excluded.entered_at`,
  ).run(id, date, price, by, now);
}

// a buy's price stands for its day until the owner enters one
export function priceIfNone(
  db: Db,
  id: string,
  date: string,
  price: number,
  by: string,
  now: number,
): void {
  db.query(
    `insert into fund_prices (instrument, date, price, entered_by, entered_at)
     values (?, ?, ?, ?, ?) on conflict (instrument, date) do nothing`,
  ).run(id, date, price, by, now);
}
