// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Migration } from "../migration.ts";

// sources is written only once a switch's refetch landed, so a restart redoes
// it; no table points at quotes, so it is rebuilt inside the transaction
export const m0010: Migration = {
  id: "0010-bvb",
  up(db) {
    db.exec(`
      create table sources (
        name text primary key check (name <> ''),
        since integer not null
      ) strict;

      create table quotes_next (
        instrument text primary key references instruments (id),
        price real not null,
        previous_close real,
        previous_close_field text check (previous_close_field in
          ('previousClose', 'chartPreviousClose', 'reference', 'change')),
        change real,
        change_percent real,
        day_high real,
        day_low real,
        volume integer,
        time integer,
        source text not null,
        fetched_at integer not null,
        check ((previous_close is null) = (previous_close_field is null)),
        check ((previous_close is null) = (change is null))
      ) strict;

      insert into quotes_next (instrument, price, previous_close,
        previous_close_field, change, change_percent, day_high, day_low,
        volume, time, source, fetched_at)
      select instrument, price, previous_close, previous_close_field, change,
        change_percent, day_high, day_low, volume, time, source, fetched_at
      from quotes;

      drop table quotes;
      alter table quotes_next rename to quotes;
    `);
  },
};
