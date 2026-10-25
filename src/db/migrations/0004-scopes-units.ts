// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Migration } from "../migration.ts";

// A run's scope (the market of a quote or bar pass), so one market's
// failure marks only its own rows stale; and each instrument's unit, so
// a price is never read as another kind of number.
export const m0004: Migration = {
  id: "0004-scopes-units",
  up(db) {
    db.exec(`
      alter table sync_runs add column scope text;
      drop index sync_runs_by_job;
      create index sync_runs_by_scope on sync_runs (source, job, scope, started_at);

      alter table instruments add column unit text not null default 'unknown'
        check (unit in ('per_share', 'percent_of_par', 'index_points',
          'percent', 'per_unit', 'unknown'));
      update instruments set unit = case
          when type in ('EQUITY', 'ETF', 'MUTUALFUND') then 'per_share'
          when type in ('CRYPTOCURRENCY', 'CURRENCY') then 'per_unit'
          else 'unknown'
        end
        where source = 'yahoo';
    `);
  },
};
