// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Migration } from "../migration.ts";

// holdings across portfolios read every live trade in date order, and a
// broker's holdings only its own: without these each read scans the table,
// removed rows included, and sorts it
export const m0022: Migration = {
  id: "0022-trade-indexes",
  up(db) {
    db.exec(`
      create index trades_live_by_date on trades (date)
        where removed_at is null;
      create index trades_by_broker on trades (broker, date);
    `);
  },
};
