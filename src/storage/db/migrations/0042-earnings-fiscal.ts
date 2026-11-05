// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Migration } from "../migration.ts";

// an earnings row's fiscal quarter, the key its event has: Finnhub's period
// is a calendar quarter after it when fiscal quarters are offset (NVDA)
export const m0042: Migration = {
  id: "0042-earnings-fiscal",
  up(db) {
    db.exec(`
      alter table research add column fiscal_year integer
        check (fiscal_year is null
          or (kind = 'earnings' and fiscal_year between 1900 and 2200));

      alter table research add column fiscal_quarter integer
        check ((fiscal_quarter is null) = (fiscal_year is null)
          and (fiscal_quarter is null or fiscal_quarter between 1 and 4));
    `);
  },
};
