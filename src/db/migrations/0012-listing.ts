// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Migration } from "../migration.ts";

const SHAPE = `length(listing) between 1 and 20
  and listing not glob '*[^A-Za-z0-9.-]*'`;

// The other listing Finnhub answered a share for (an ADR as its home
// listing), null for the share's own; rows stored before are its own.
// Another listing's rows hold no figure per share, which is in its
// currency, and no earnings or insider rows.
export const m0012: Migration = {
  id: "0012-listing",
  up(db) {
    db.exec(`
      alter table research add column listing text check (listing is null
        or (${SHAPE} and kind in ('analysts', 'metric')
          and forward_pe is null and forward_peg is null and pe_ttm is null
          and ps_ttm is null and pb is null and dividend_yield_ttm is null
          and beta is null));

      alter table events add column listing text check (listing is null
        or (${SHAPE} and eps_estimate is null and eps_actual is null
          and revenue_estimate is null and revenue_actual is null));
    `);
  },
};
