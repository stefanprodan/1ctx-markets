// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Migration } from "../migration.ts";

// agent keys made by the admin: a key is a credential like a login, so a
// row holds the token's SHA-256, never the token; null expires_at never
// expires
export const m0016: Migration = {
  id: "0016-keys",
  up(db) {
    db.exec(`
      create table keys (
        id text primary key,
        name text not null unique,
        token_hash text not null unique,
        created_at integer not null,
        expires_at integer,
        last_used_at integer
      ) strict;
    `);
  },
};
