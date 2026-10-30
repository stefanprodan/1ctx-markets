// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Migration } from "../migration.ts";

// a new key opens no rules until the admin says; keys made before keep the
// rules access every key had, so their agents keep working
export const m0023: Migration = {
  id: "0023-key-rules",
  up(db) {
    db.exec(`
      alter table keys add column rules text not null default 'none'
        check (rules in ('none', 'read', 'write'));
      update keys set rules = 'write';
    `);
  },
};
