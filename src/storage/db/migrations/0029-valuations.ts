// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Migration } from "../migration.ts";

// Yahoo's EPS and PEG per US share for a share Finnhub answers from a
// foreign listing; one row per instrument, replaced, no history
export const m0029: Migration = {
  id: "0029-valuations",
  up(db) {
    db.exec(`
      create table valuations (
        instrument text primary key references instruments (id),
        eps_ttm real,
        eps_forward real,
        peg real,
        currency text not null check (length(currency) between 1 and 8),
        fetched_at integer not null
      ) strict, without rowid;
    `);
  },
};
