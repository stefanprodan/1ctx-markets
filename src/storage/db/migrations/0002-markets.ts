// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Migration } from "../migration.ts";

// each market's latest regular session, as its source's answers give it
export const m0002: Migration = {
  id: "0002-markets",
  up(db) {
    db.exec(`
      create table markets (
        market text primary key,
        zone text not null,
        session_start integer not null,
        session_end integer not null,
        fetched_at integer not null,
        check (session_start < session_end)
      ) strict;
    `);
  },
};
