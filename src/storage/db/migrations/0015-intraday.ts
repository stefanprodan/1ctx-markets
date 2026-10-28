// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Migration } from "../migration.ts";

// the session leads the key, so replacing and pruning one read it;
// point_close marks a currency pair's close taken from its session's last
// 5-minute close, kept after the points are pruned
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

      alter table bars add column point_close integer not null default 0
        check (point_close in (0, 1));
    `);
  },
};
