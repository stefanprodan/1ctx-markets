// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Migration } from "../migration.ts";

// the market a fund's or cash's money is in, so a fund holding one
// market's shares counts in it; none until the owner names one
export const m0025: Migration = {
  id: "0025-position-market",
  up(db) {
    db.exec(`
      alter table positions add column market text
        check (market is null or length(market) between 1 and 40);
    `);
  },
};
