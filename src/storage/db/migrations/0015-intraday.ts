// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Migration } from "../migration.ts";

// a quote answer's 5-minute closes; the key leads with the session, so a
// session is replaced and pruned by key
export const m0015: Migration = {
  id: "0015-intraday",
  up(db) {
    db.exec(`
      create table intraday (
        instrument text not null references instruments (id),
        session text not null check (session glob '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
        at integer not null,
        close real not null,
        fetched_at integer not null,
        primary key (instrument, session, at)
      ) strict, without rowid;
    `);
  },
};
