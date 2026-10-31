// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// Rows only; what they are worth is value.ts. Holdings are private: no
// function here logs, and no error quotes a row.

import { CRYPTO } from "../market/calendars.ts";
import { FRED_MARKET, FUND_SOURCE } from "../sources/ids.ts";
import type { Db } from "../storage/db/index.ts";

export const MAX_NAME = 40;
export const MAX_POSITION_NAME = 80;
export const MAX_NOTE = 500;

export type Portfolio = { id: number; name: string; createdAt: number };
export type Broker = { id: number; name: string; createdAt: number };

export type Side = "buy" | "sell";

export type Trade = {
  id: number;
  portfolio: number;
  instrument: string;
  side: Side;
  date: string;
  quantity: number;
  price: number;
  fees: number;
  // what it was paid in, which may differ from the listing's
  currency: string;
  // the day its quantity and price are stated as of, so only splits after
  // it apply; null for its own date
  statedOn: string | null;
  broker: number | null;
  note: string | null;
  enteredBy: string;
  enteredAt: number;
  removedAt: number | null;
  removedBy: string | null;
};

export const POSITION_KINDS = ["cash", "bond"] as const;
export type PositionKind = (typeof POSITION_KINDS)[number];

export type Position = {
  id: number;
  portfolio: number;
  kind: PositionKind;
  name: string;
  currency: string;
  // a bond's listing, when the server prices one
  instrument: string | null;
  // cash's market, as an instrument's: none unless named
  market: string | null;
  // cash: the amount; bond: the face amount
  amount: number | null;
  cost: number | null;
  coupon: number | null;
  maturity: string | null;
  asOf: string;
  broker: number | null;
  note: string | null;
  // cash set aside for buying
  dryPowder: boolean;
  // the row this one updated, removed by the update
  replaces: number | null;
  enteredBy: string;
  enteredAt: number;
  removedAt: number | null;
  removedBy: string | null;
};

export function listPortfolios(db: Db): Portfolio[] {
  return db
    .query<Portfolio, []>(
      "select id, name, created_at as createdAt from portfolios order by name collate nocase, id",
    )
    .all();
}

export function readPortfolio(db: Db, id: number): Portfolio | null {
  return (
    db
      .query<Portfolio, [number]>(
        "select id, name, created_at as createdAt from portfolios where id = ?",
      )
      .get(id) ?? null
  );
}

export function portfolioByName(db: Db, name: string): Portfolio | null {
  return (
    db
      .query<Portfolio, [string]>(
        "select id, name, created_at as createdAt from portfolios where name = ? collate nocase",
      )
      .get(name) ?? null
  );
}

export function insertPortfolio(db: Db, name: string, now: number): number {
  return Number(
    db
      .query("insert into portfolios (name, created_at) values (?, ?)")
      .run(name, now).lastInsertRowid,
  );
}

export function renamePortfolio(db: Db, id: number, name: string): void {
  db.query("update portfolios set name = ? where id = ?").run(name, id);
}

// the live rows; removed ones go with the portfolio
export function portfolioRows(db: Db, id: number): number {
  return db
    .query<{ n: number }, [number, number]>(
      `select (select count(*) from trades where portfolio = ?1
          and removed_at is null)
        + (select count(*) from positions where portfolio = ?2
          and removed_at is null) as n`,
    )
    .get(id, id)!.n;
}

// with its removed rows, in the caller's write; a live row keeps it
export function deletePortfolio(db: Db, id: number): boolean {
  db.query(
    "delete from trades where portfolio = ? and removed_at is not null",
  ).run(id);
  db.query(
    "delete from positions where portfolio = ? and removed_at is not null",
  ).run(id);
  return db.query("delete from portfolios where id = ?").run(id).changes > 0;
}

export function listBrokers(db: Db): Broker[] {
  return db
    .query<Broker, []>(
      "select id, name, created_at as createdAt from brokers order by name collate nocase, id",
    )
    .all();
}

export function readBroker(db: Db, id: number): Broker | null {
  return (
    db
      .query<Broker, [number]>(
        "select id, name, created_at as createdAt from brokers where id = ?",
      )
      .get(id) ?? null
  );
}

export function brokerByName(db: Db, name: string): Broker | null {
  return (
    db
      .query<Broker, [string]>(
        "select id, name, created_at as createdAt from brokers where name = ? collate nocase",
      )
      .get(name) ?? null
  );
}

export function insertBroker(db: Db, name: string, now: number): number {
  return Number(
    db
      .query("insert into brokers (name, created_at) values (?, ?)")
      .run(name, now).lastInsertRowid,
  );
}

export function renameBroker(db: Db, id: number, name: string): void {
  db.query("update brokers set name = ? where id = ?").run(name, id);
}

// the live rows naming it; removed ones lose the name when it goes
export function brokerRows(db: Db, id: number): number {
  return db
    .query<{ n: number }, [number, number]>(
      `select (select count(*) from trades where broker = ?1
          and removed_at is null)
        + (select count(*) from positions where broker = ?2
          and removed_at is null) as n`,
    )
    .get(id, id)!.n;
}

export function deleteBroker(db: Db, id: number): boolean {
  db.query(
    "update trades set broker = null where broker = ? and removed_at is not null",
  ).run(id);
  db.query(
    "update positions set broker = null where broker = ? and removed_at is not null",
  ).run(id);
  return db.query("delete from brokers where id = ?").run(id).changes > 0;
}

const TRADE = `select id, portfolio, instrument, side, date, quantity, price,
  fees, currency, stated_on as statedOn, broker, note,
  entered_by as enteredBy,
  entered_at as enteredAt, removed_at as removedAt, removed_by as removedBy
  from trades`;

export type NewTrade = Omit<
  Trade,
  "id" | "enteredAt" | "removedAt" | "removedBy"
>;

export function insertTrade(db: Db, t: NewTrade, now: number): number {
  return Number(
    db
      .query(
        `insert into trades (portfolio, instrument, side, date, quantity,
           price, fees, currency, stated_on, broker, note, entered_by,
           entered_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        t.portfolio,
        t.instrument,
        t.side,
        t.date,
        t.quantity,
        t.price,
        t.fees,
        t.currency,
        t.statedOn,
        t.broker,
        t.note,
        t.enteredBy,
        now,
      ).lastInsertRowid,
  );
}

export function readTrade(db: Db, id: number): Trade | null {
  return db.query<Trade, [number]>(`${TRADE} where id = ?`).get(id) ?? null;
}

export type TradeFilter = {
  portfolio?: number | null;
  broker?: number | null;
  instrument?: string | null;
  from?: string | null;
  to?: string | null;
  removed?: boolean;
};

// newest first, the later entry first within a day
export function readTrades(db: Db, f: TradeFilter = {}): Trade[] {
  const where: string[] = [];
  const args: (string | number)[] = [];
  if (f.portfolio != null) {
    where.push("portfolio = ?");
    args.push(f.portfolio);
  }
  if (f.broker != null) {
    where.push("broker = ?");
    args.push(f.broker);
  }
  if (f.instrument != null) {
    where.push("instrument = ?");
    args.push(f.instrument);
  }
  if (f.from != null) {
    where.push("date >= ?");
    args.push(f.from);
  }
  if (f.to != null) {
    where.push("date <= ?");
    args.push(f.to);
  }
  if (!f.removed) where.push("removed_at is null");
  return db
    .query<Trade, (string | number)[]>(
      `${TRADE} ${where.length > 0 ? `where ${where.join(" and ")}` : ""}
       order by date desc, id desc`,
    )
    .all(...args);
}

export function setTradeRemoved(
  db: Db,
  id: number,
  by: string | null,
  now: number,
): void {
  db.query("update trades set removed_at = ?, removed_by = ? where id = ?").run(
    by === null ? null : now,
    by,
    id,
  );
}

const POSITION = `select id, portfolio,
  kind, name, currency, instrument, market,
  amount, cost, coupon, maturity, as_of as asOf, broker, note,
  dry_powder as dryPowder, replaces, entered_by as enteredBy, entered_at as enteredAt, removed_at as removedAt,
  removed_by as removedBy from positions`;

export type NewPosition = Omit<
  Position,
  "id" | "enteredAt" | "removedAt" | "removedBy"
>;

export function insertPosition(db: Db, p: NewPosition, now: number): number {
  return Number(
    db
      .query(
        `insert into positions (portfolio, kind, name, currency, instrument,
           market, amount, cost, coupon, maturity, as_of, broker, note,
           dry_powder, replaces, entered_by, entered_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        p.portfolio,
        p.kind,
        p.name,
        p.currency,
        p.instrument,
        p.market,
        p.amount,
        p.cost,
        p.coupon,
        p.maturity,
        p.asOf,
        p.broker,
        p.note,
        p.dryPowder ? 1 : 0,
        p.replaces,
        p.enteredBy,
        now,
      ).lastInsertRowid,
  );
}

type RawPosition = Omit<Position, "dryPowder"> & { dryPowder: number };
const positionOf = (r: RawPosition): Position => ({
  ...r,
  dryPowder: r.dryPowder === 1,
});

export function readPosition(db: Db, id: number): Position | null {
  return (() => {
    const r = db
      .query<RawPosition, [number]>(`${POSITION} where id = ?`)
      .get(id);
    return r === null ? null : positionOf(r);
  })();
}

export function readPositions(
  db: Db,
  f: {
    portfolio?: number | null;
    broker?: number | null;
    removed?: boolean;
  } = {},
): Position[] {
  const where: string[] = [];
  const args: number[] = [];
  if (f.portfolio != null) {
    where.push("portfolio = ?");
    args.push(f.portfolio);
  }
  if (f.broker != null) {
    where.push("broker = ?");
    args.push(f.broker);
  }
  if (!f.removed) where.push("removed_at is null");
  return db
    .query<RawPosition, number[]>(
      `${POSITION} ${where.length > 0 ? `where ${where.join(" and ")}` : ""}
       order by kind, name collate nocase, id`,
    )
    .all(...args)
    .map(positionOf);
}

// the one a new position of the same kind and name at the same broker
// replaces, so an updated balance is one row, the old one restorable
export function samePosition(
  db: Db,
  p: Pick<
    Position,
    "portfolio" | "kind" | "name" | "broker" | "instrument" | "asOf" | "amount"
  >,
  // undated: a bond read with no purchase date, any date matches; skip:
  // rows another line of the same file already matched
  opts: { undated?: boolean; skip?: readonly number[] } = {},
): Position | null {
  // a bond is one purchase: its listing, or its name when either has none
  // (a listing resolved on a later read), its purchase date and face;
  // several purchases of one bond are kept apart
  const r =
    p.kind === "bond"
      ? db
          .query<
            RawPosition,
            [
              number,
              string | null,
              string,
              string | null,
              number | null,
              number | null,
              string,
            ]
          >(
            `${POSITION} where portfolio = ?1 and kind = 'bond'
             and (instrument = ?2
               or ((instrument is null or ?2 is null)
                 and name = ?3 collate nocase))
             and (?4 is null or as_of = ?4) and amount is ?5 and broker is ?6
             and removed_at is null
             and id not in (select value from json_each(?7))
             order by instrument is null, id`,
          )
          .get(
            p.portfolio,
            p.instrument,
            p.name,
            opts.undated ? null : p.asOf,
            p.amount,
            p.broker,
            JSON.stringify(opts.skip ?? []),
          )
      : db
          .query<RawPosition, [number, string, string, number | null]>(
            `${POSITION} where portfolio = ? and kind = ? and name = ? collate nocase
             and broker is ? and removed_at is null`,
          )
          .get(p.portfolio, p.kind, p.name, p.broker);
  return r === null ? null : positionOf(r);
}

export function setPositionRemoved(
  db: Db,
  id: number,
  by: string | null,
  now: number,
): void {
  db.query(
    "update positions set removed_at = ?, removed_by = ? where id = ?",
  ).run(by === null ? null : now, by, id);
}

// held or with a position, removed rows aside: tracked as a rule's are;
// a fund the owner prices is never fetched, so never tracked
export function portfolioInstruments(db: Db): Set<string> {
  return new Set(
    db
      .query<{ id: string }, [string]>(
        `select instrument as id from trades t where removed_at is null
           and not exists (select 1 from instruments i
             where i.id = t.instrument and i.source = ?1)
         union select instrument from positions
         where removed_at is null and instrument is not null`,
      )
      .all(FUND_SOURCE)
      .map((r) => r.id),
  );
}

// every instrument a trade or position ever named, removed ones too, so a
// restore never finds its instrument deleted
export function portfolioHolds(db: Db, id: string): boolean {
  return (
    db
      .query<{ n: number }, [string, string]>(
        `select (select count(*) from trades where instrument = ?1)
          + (select count(*) from positions where instrument = ?2) as n`,
      )
      .get(id, id)!.n > 0
  );
}

export type Split = { date: string; ratio: number };

// the markets a fund's or cash's money can be in, as instrument ids spell
// them: where a share, an ETF or a bond is listed, and crypto; currency
// pairs (Yahoo's CCY), FRED series and index-only or futures markets
// hold nothing a fund buys; a fund's own key is no market
export function knownMarkets(db: Db): string[] {
  return db
    .query<{ market: string }, [string, string, string]>(
      `select distinct market from instruments
       where (unit in ('per_share', 'percent_of_par') or market = ?1)
       and market not in (?2, 'CCY') and source <> ?3
       order by market`,
    )
    .all(CRYPTO, FRED_MARKET, FUND_SOURCE)
    .map((r) => r.market);
}

// shares after a split are shares before times the ratio
export function splitsOf(db: Db, instrument: string): Split[] {
  return db
    .query<{ date: string; ratio: number }, [string]>(
      `select date, numerator / denominator as ratio from splits
       where instrument = ? order by date`,
    )
    .all(instrument);
}

// one owner until people sign in
export const OWNER = "admin";

export function displayCurrency(db: Db, owner = OWNER): string | null {
  return (
    db
      .query<{ c: string | null }, [string]>(
        "select display_currency as c from portfolio_settings where owner = ?",
      )
      .get(owner)?.c ?? null
  );
}

export function setDisplayCurrency(
  db: Db,
  currency: string | null,
  now: number,
  owner = OWNER,
): void {
  db.query(
    `insert into portfolio_settings (owner, display_currency, updated_at)
     values (?, ?, ?) on conflict (owner) do update set
       display_currency = excluded.display_currency,
       updated_at = excluded.updated_at`,
  ).run(owner, currency, now);
}

export function timeZone(db: Db, owner = OWNER): string | null {
  return (
    db
      .query<{ z: string | null }, [string]>(
        "select time_zone as z from portfolio_settings where owner = ?",
      )
      .get(owner)?.z ?? null
  );
}

export function setTimeZone(
  db: Db,
  zone: string,
  now: number,
  owner = OWNER,
): void {
  db.query(
    `insert into portfolio_settings (owner, time_zone, updated_at)
     values (?, ?, ?) on conflict (owner) do update set
       time_zone = excluded.time_zone,
       updated_at = excluded.updated_at`,
  ).run(owner, zone, now);
}

// a live trade equal to one being added, entered since a moment: a retry
// after a timeout, not a second fill
export function recentSameTrade(
  db: Db,
  t: NewTrade,
  since: number,
): Trade | null {
  return (
    db
      .query<
        Trade,
        [
          number,
          string,
          string,
          string,
          number,
          number,
          number,
          string,
          number | null,
          string | null,
          number,
        ]
      >(
        `${TRADE} where portfolio = ? and instrument = ? and side = ?
         and date = ? and quantity = ? and price = ? and fees = ?
         and currency = ? and broker is ? and stated_on is ?
         and removed_at is null and entered_at >= ?
         order by id desc limit 1`,
      )
      .get(
        t.portfolio,
        t.instrument,
        t.side,
        t.date,
        t.quantity,
        t.price,
        t.fees,
        t.currency,
        t.broker,
        t.statedOn,
        since,
      ) ?? null
  );
}

// every row a position's updates chained, both ways, the latest first: a
// bond's update may change its face or date, so its name never ties them
export function chainOf(db: Db, id: number): Position[] {
  return db
    .query<RawPosition, [number]>(
      `with recursive up(id, replaces) as (
         select id, replaces from positions where id = ?
         union select p.id, p.replaces from positions p
           join up on p.id = up.replaces
       ),
       root(id) as (select id from up where replaces is null),
       down(id) as (
         select id from root
         union select p.id from positions p join down on p.replaces = down.id
       )
       ${POSITION} where id in (select id from down)
       order by entered_at desc, id desc`,
    )
    .all(id)
    .map(positionOf);
}

// every row of a position, the latest entry first: its updates, who made
// them and when; cash by name at its broker, a bond by
// its chain of updates
export function positionHistory(
  db: Db,
  p: Pick<Position, "id" | "portfolio" | "kind" | "name" | "broker">,
): Position[] {
  if (p.kind === "bond") return chainOf(db, p.id);
  return db
    .query<RawPosition, [number, string, string, number | null]>(
      `${POSITION} where portfolio = ? and kind = ? and name = ? collate nocase
       and broker is ? order by entered_at desc, id desc`,
    )
    .all(p.portfolio, p.kind, p.name, p.broker)
    .map(positionOf);
}
