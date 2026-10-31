// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Migration } from "../migration.ts";

// a fund is an instrument the owner prices, bought and sold as trades so
// each purchase keeps its date, priced by dated rows; fund positions are
// dropped, not moved. The new positions points at itself, so the old one
// drops with nothing pointing at it, and its ids go on, never reused.
export const m0026: Migration = {
  id: "0026-fund-trades",
  up(db) {
    db.exec(`
      create table funds (
        instrument text primary key references instruments (id)
          check (instrument glob 'fund:*'),
        market text check (market is null or length(market) between 1 and 40),
        entered_by text not null,
        entered_at integer not null
      ) strict;

      create table fund_prices (
        instrument text not null references funds (instrument),
        date text not null
          check (date glob '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
        price real not null check (price >= 0),
        entered_by text not null,
        entered_at integer not null,
        primary key (instrument, date)
      ) strict, without rowid;

      -- no other kind's update ever named a fund row; kept safe if one did
      update positions set replaces = null
        where kind <> 'manual'
        and replaces in (select id from positions where kind = 'manual');
      delete from positions where kind = 'manual';

      create table positions_next (
        id integer primary key autoincrement,
        portfolio integer not null references portfolios (id),
        kind text not null check (kind in ('cash', 'bond')),
        name text not null check (length(name) between 1 and 80),
        currency text not null,
        instrument text references instruments (id),
        amount real check (amount is null or amount >= 0),
        units real check (units is null or units > 0),
        price real check (price is null or price >= 0),
        cost real check (cost is null or cost >= 0),
        coupon real,
        maturity text,
        as_of text not null
          check (as_of glob '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
        broker integer references brokers (id),
        dry_powder integer not null default 0 check (dry_powder in (0, 1)),
        replaces integer references positions_next (id),
        note text check (note is null or length(note) <= 500),
        entered_by text not null,
        entered_at integer not null,
        removed_at integer,
        removed_by text,
        market text
          check (market is null or length(market) between 1 and 40),
        check ((removed_at is null) = (removed_by is null)),
        check (kind != 'cash' or amount is not null),
        check (dry_powder = 0 or kind = 'cash'),
        check (kind != 'bond' or amount is not null)
      ) strict;

      insert into positions_next (id, portfolio, kind, name, currency,
        instrument, amount, units, price, cost, coupon, maturity, as_of,
        broker, dry_powder, replaces, note, entered_by, entered_at,
        removed_at, removed_by, market)
      select id, portfolio, kind, name, currency, instrument, amount, units,
        price, cost, coupon, maturity, as_of, broker, dry_powder, replaces,
        note, entered_by, entered_at, removed_at, removed_by, market
      from positions order by id;

      delete from sqlite_sequence where name = 'positions_next';
      insert into sqlite_sequence (name, seq)
        select 'positions_next', seq from sqlite_sequence
        where name = 'positions';

      drop table positions;
      alter table positions_next rename to positions;
      create index positions_by_portfolio on positions (portfolio);
      create index positions_by_instrument on positions (instrument);
    `);
  },
};
