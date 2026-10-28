// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Migration } from "../migration.ts";

// instruments, daily and weekly bars, quotes and runs; splits already applied
export const m0003: Migration = {
  id: "0003-yahoo",
  up(db) {
    db.exec(`
      create table instruments (
        id text primary key,
        market text not null,
        symbol text not null,
        source text not null,
        source_symbol text not null,
        exchange text not null,
        name text,
        type text not null,
        currency text,
        zone text not null,
        added_at integer not null,
        updated_at integer not null,
        check (id = market || ':' || symbol),
        check (market <> '' and symbol <> '' and source_symbol <> ''),
        unique (source, source_symbol)
      ) strict;

      create table bars (
        instrument text not null references instruments (id),
        interval text not null check (interval in ('1d', '1wk')),
        date text not null check (date glob '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
        open real,
        high real,
        low real,
        close real not null,
        volume integer,
        final integer not null check (final in (0, 1)),
        fetched_at integer not null,
        primary key (instrument, interval, date)
      ) strict, without rowid;

      create table quotes (
        instrument text primary key references instruments (id),
        price real not null,
        previous_close real,
        previous_close_field text check (previous_close_field in ('previousClose', 'chartPreviousClose')),
        change real,
        change_percent real,
        day_high real,
        day_low real,
        volume integer,
        time integer not null,
        source text not null,
        fetched_at integer not null,
        check ((previous_close is null) = (previous_close_field is null)),
        check ((previous_close is null) = (change is null))
      ) strict;

      create table splits (
        instrument text not null references instruments (id),
        date text not null check (date glob '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
        numerator real not null check (numerator > 0),
        denominator real not null check (denominator > 0),
        ratio text not null,
        applied_at integer not null,
        primary key (instrument, date)
      ) strict, without rowid;

      create table sync_runs (
        id integer primary key,
        source text not null,
        job text not null,
        started_at integer not null,
        ended_at integer,
        status text not null check (status in ('running', 'ok', 'failed')),
        rows integer not null default 0,
        error text,
        check ((status = 'running') = (ended_at is null)),
        check ((status = 'failed') = (error is not null))
      ) strict;

      create index sync_runs_by_job on sync_runs (source, job, started_at);
    `);
  },
};
