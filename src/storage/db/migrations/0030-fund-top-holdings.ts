// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Migration } from "../migration.ts";

// Yahoo's top ten of a listed fund, its asset split, sectors and bond
// ratings, replaced whole; named apart from the owner-priced funds
export const m0030: Migration = {
  id: "0030-fund-top-holdings",
  up(db) {
    db.exec(`
      create table fund_top_holdings (
        instrument text primary key references instruments (id),
        fetched_at integer not null,
        stock real,
        bond real,
        cash real,
        other real,
        preferred real,
        convertible real,
        government real
      ) strict, without rowid;

      create table fund_top_holding_rows (
        instrument text not null references instruments (id),
        rank integer not null check (rank between 1 and 10),
        symbol text,
        name text not null,
        weight real not null,
        primary key (instrument, rank)
      ) strict, without rowid;

      create table fund_weights (
        instrument text not null references instruments (id),
        kind text not null check (kind in ('sector', 'rating')),
        key text not null,
        weight real not null,
        primary key (instrument, kind, key)
      ) strict, without rowid;
    `);
  },
};
