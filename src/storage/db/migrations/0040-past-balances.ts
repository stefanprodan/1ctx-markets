// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Migration } from "../migration.ts";

// a cash balance dated before its row's own day: a row of its own, kept
// beside the chain row it was entered on, never replacing or replaced, so
// removal and restore work as for any row and every read of live rows
// leaves it out by this column; a chain is read down through replaces
export const m0040: Migration = {
  id: "0040-past-balances",
  up(db) {
    db.exec(`
      alter table positions add column past_of integer
        references positions (id);
      create index positions_by_past_of on positions (past_of)
        where past_of is not null;
      create index positions_by_replaces on positions (replaces)
        where replaces is not null;
    `);
  },
};
