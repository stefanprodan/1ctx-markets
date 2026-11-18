// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Migration } from "../migration.ts";

// unset by default: a schedule is never assumed
export const m0050: Migration = {
  id: "0050-bond-schedule",
  up(db) {
    db.exec(`
      alter table positions add column coupons_per_year integer
        check (coupons_per_year in (1, 2, 4));
      alter table positions add column issued text
        check (issued glob '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]');
    `);
  },
};
