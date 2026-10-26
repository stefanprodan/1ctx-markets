// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Migration } from "../migration.ts";

// Price rules and the alerts they fire. Ids autoincrement so an id is
// never reused after a delete or retention, which GET /alerts relies on
// as its cursor; an alert has no foreign key, so it outlives its rule.
export const m0009: Migration = {
  id: "0009-rules",
  up(db) {
    db.exec(`
      create table rules (
        id integer primary key autoincrement,
        instrument text not null references instruments (id),
        condition text not null check (json_valid(condition)),
        note text check (note is null or length(note) <= 500),
        paused text check (paused in ('manual', 'split')),
        armed integer not null default 1 check (armed in (0, 1)),
        created_at integer not null,
        last_result text check (last_result in ('true', 'false', 'unknown')),
        last_evaluated_at integer,
        check ((last_result is null) = (last_evaluated_at is null))
      ) strict;

      create table alerts (
        id integer primary key autoincrement,
        rule_id integer not null,
        fired_at integer not null,
        snapshot text not null check (json_valid(snapshot))
      ) strict;

      create index alerts_by_fired on alerts (fired_at);
    `);
  },
};
