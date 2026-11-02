// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Migration } from "../migration.ts";

// the 1M and 1Y returns a list shows, written on each instrument's newest
// daily row so a page of thousands reads them without a bar
export const m0035: Migration = {
  id: "0035-stored-returns",
  up(db) {
    db.exec(`
      alter table signals add column return_1m real;
      alter table signals add column return_1y real;
    `);
  },
};
