// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Migration } from "../migration.ts";

// the last alert a person's browser showed, so the rail counts the new ones
export const m0044: Migration = {
  id: "0044-alerts-seen",
  up(db) {
    db.exec(`
      alter table users add column alerts_seen integer not null default 0;
    `);
  },
};
