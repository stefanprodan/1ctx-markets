// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Migration } from "../migration.ts";

// no currency on a portfolio: a trade keeps the one it was paid in;
// a trade keeps the instrument it resolved to, so a symbol change never
// moves it; a removal is a stamp, so a mistake is seen and undone; an
// agent key reads or writes portfolios only when the admin says so; a
// display currency is the owner's choice, none until set; dry powder is
// cash kept for buying, edited by hand, never moved by a trade; an update is a new
// row replacing the old, so a wrong one is seen and set back
export const m0020: Migration = {
  id: "0020-portfolios",
  up(db) {
    db.exec(`
      alter table keys add column portfolio text not null default 'none'
        check (portfolio in ('none', 'read', 'write'));

      create table portfolios (
        id integer primary key autoincrement,
        name text not null unique collate nocase
          check (length(name) between 1 and 40),
        created_at integer not null
      ) strict;

      create table brokers (
        id integer primary key autoincrement,
        name text not null unique collate nocase
          check (length(name) between 1 and 40),
        created_at integer not null
      ) strict;

      create table trades (
        id integer primary key autoincrement,
        portfolio integer not null references portfolios (id),
        instrument text not null references instruments (id),
        side text not null check (side in ('buy', 'sell')),
        date text not null
          check (date glob '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
        quantity real not null check (quantity > 0),
        price real not null check (price >= 0),
        fees real not null default 0 check (fees >= 0),
        currency text not null,
        broker integer references brokers (id),
        note text check (note is null or length(note) <= 500),
        entered_by text not null,
        entered_at integer not null,
        removed_at integer,
        removed_by text,
        check ((removed_at is null) = (removed_by is null))
      ) strict;

      create index trades_by_portfolio on trades (portfolio, date);
      create index trades_by_instrument on trades (instrument);

      create table positions (
        id integer primary key autoincrement,
        portfolio integer not null references portfolios (id),
        kind text not null check (kind in ('cash', 'manual', 'bond')),
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
        replaces integer references positions (id),
        note text check (note is null or length(note) <= 500),
        entered_by text not null,
        entered_at integer not null,
        removed_at integer,
        removed_by text,
        check ((removed_at is null) = (removed_by is null)),
        check (kind != 'cash' or amount is not null),
        check (dry_powder = 0 or kind = 'cash'),
        check (kind != 'manual' or (units is not null and price is not null)),
        check (kind != 'bond' or amount is not null)
      ) strict;

      create index positions_by_portfolio on positions (portfolio);
      create index positions_by_instrument on positions (instrument);

      create table portfolio_settings (
        owner text primary key,
        display_currency text
          check (display_currency is null or display_currency glob '[A-Z][A-Z][A-Z]'),
        updated_at integer not null
      ) strict;
    `);
  },
};
