// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Migration } from "../migration.ts";

// only the runner's own record; each schema change appends a migration
export const m0001: Migration = {
  id: "0001-init",
  up(db) {
    db.exec(`
      create table migrations (
        id text primary key,
        applied_at integer not null
      );
    `);
  },
};
