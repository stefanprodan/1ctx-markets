// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Migration } from "../migration.ts";

// no reference to instruments, so deleting one never takes its note
export const m0041: Migration = {
  id: "0041-analysis",
  up(db) {
    db.exec(`
      create table analysis_versions (
        symbol text not null,
        revision integer not null,
        text text not null,
        bytes integer not null,
        author text not null,
        user_id text references users (id) on delete set null,
        price real,
        currency text,
        priced_at integer,
        created_at integer not null,
        primary key (symbol, revision)
      ) strict;
      -- the list, a pointer and the revisions read it alone, never a text
      create index analysis_by_symbol on analysis_versions
        (symbol, revision, created_at, bytes, author);
      alter table keys add column analysis text not null default 'none'
        check (analysis in ('none', 'read', 'write'));
    `);
  },
};
