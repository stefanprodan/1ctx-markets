// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Migration } from "../migration.ts";

// a hand-priced fund's holdings come from its own reports: the top rows
// and asset split are as of one day, its sectors often of another; both
// null for Yahoo's, which gives no as-of day
export const m0039: Migration = {
  id: "0039-fund-holdings-as-of",
  up(db) {
    db.exec(`
      alter table fund_top_holdings add column as_of text;
      alter table fund_top_holdings add column sectors_as_of text;
    `);
  },
};
