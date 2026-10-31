// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Migration } from "../migration.ts";

// the owner's IANA zone, so a position dated today is the owner's today;
// none until the owner names one, checked by the code, which knows zones
export const m0024: Migration = {
  id: "0024-time-zone",
  up(db) {
    db.exec(`
      alter table portfolio_settings add column time_zone text
        check (time_zone is null or length(time_zone) between 1 and 64);
    `);
  },
};
