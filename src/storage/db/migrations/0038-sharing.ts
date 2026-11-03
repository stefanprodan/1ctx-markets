// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Migration } from "../migration.ts";

// a person lets others see all their portfolios, read only; removing
// either person ends it
export const m0038: Migration = {
  id: "0038-sharing",
  up(db) {
    db.exec(`
      create table portfolio_viewers (
        owner text not null references users (id) on delete cascade,
        viewer text not null references users (id) on delete cascade,
        created_at integer not null,
        primary key (owner, viewer)
      ) strict, without rowid;
      create index portfolio_viewers_by_viewer on portfolio_viewers (viewer);
    `);
  },
};
