// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Migration } from "../migration.ts";

// the exchange's list pages as last read, so its search asks no feed;
// a few hundred rows, matched by substring, so a scan is the plan
export const m0018: Migration = {
  id: "0018-bvb-listings",
  up(db) {
    db.exec(`
      create table bvb_listings (
        kind text not null check (kind in ('shares', 'units', 'bonds', 'indices')),
        symbol text not null check (symbol <> ''),
        isin text,
        name text,
        type text not null,
        listed_at integer not null,
        primary key (kind, symbol)
      ) strict;
    `);
  },
};
