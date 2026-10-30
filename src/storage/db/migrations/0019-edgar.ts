// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Migration } from "../migration.ts";

// SEC's ticker map, replaced whole each fetch; a filer row says what the
// last answer was for a share, so no CIK or a foreign filer reads as such
export const m0019: Migration = {
  id: "0019-edgar",
  up(db) {
    db.exec(`
      create table edgar_tickers (
        ticker text primary key check (ticker <> ''),
        cik integer not null check (cik > 0)
      ) strict, without rowid;

      create table edgar_filers (
        instrument text primary key references instruments (id),
        -- null when the ticker map has no entry for the share
        cik integer check (cik > 0),
        foreign_filer integer not null default 0 check (foreign_filer in (0, 1)),
        fetched_at integer not null
      ) strict, without rowid;

      create table filings (
        instrument text not null references instruments (id),
        accession text not null
          check (accession glob '[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9][0-9][0-9][0-9][0-9]'),
        form text not null check (form <> ''),
        accepted_at integer not null,
        filed text not null check (filed glob '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
        period text check (period glob '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
        -- an 8-K's item codes, comma separated, as SEC lists them
        items text not null default '',
        url text not null,
        fetched_at integer not null,
        primary key (instrument, accession)
      ) strict, without rowid;

      create index filings_by_accepted on filings (instrument, accepted_at);
      create index filings_by_age on filings (accepted_at);
    `);
  },
};
