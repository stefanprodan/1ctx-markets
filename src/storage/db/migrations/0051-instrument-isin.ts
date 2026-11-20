// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Migration } from "../migration.ts";

// set by hand, never seeded: two listings of one fund share it, so it is
// not unique
export const m0051: Migration = {
  id: "0051-instrument-isin",
  up(db) {
    db.exec(`
      alter table instruments add column isin text
        check (isin glob '[A-Z][A-Z][A-Z0-9][A-Z0-9][A-Z0-9][A-Z0-9][A-Z0-9][A-Z0-9][A-Z0-9][A-Z0-9][A-Z0-9][0-9]');
    `);
  },
};
