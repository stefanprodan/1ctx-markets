// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Migration } from "../migration.ts";

// a quarter ending after the day it was fetched was not reported: Finnhub
// mislabels a fresh report's period now and then, and the row stayed
export const m0027: Migration = {
  id: "0027-earnings-ahead",
  up(db) {
    db.exec(`
      delete from research where kind = 'earnings'
        and period > strftime('%Y-%m-%d', fetched_at / 1000, 'unixepoch');
    `);
  },
};
