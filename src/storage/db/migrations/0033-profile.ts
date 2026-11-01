// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Migration } from "../migration.ts";

// the live profile is the highest revision; every key, the ones made
// before too, opens it only when the admin says
export const m0033: Migration = {
  id: "0033-profile",
  up(db) {
    db.exec(`
      create table profile_versions (
        revision integer primary key,
        text text not null,
        bytes integer not null,
        author text not null,
        created_at integer not null
      ) strict;
      alter table keys add column profile text not null default 'none'
        check (profile in ('none', 'read', 'write'));
    `);
  },
};
