// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Migration } from "../migration.ts";

// the order the lists showed before, so nothing moves until the owner moves it
export const m0034: Migration = {
  id: "0034-portfolio-order",
  up(db) {
    db.exec(`
      alter table portfolios add column position integer not null default 0;
      update portfolios set position = (
        select count(*) from portfolios o
        where o.name < portfolios.name collate nocase
          or (o.name = portfolios.name collate nocase and o.id <= portfolios.id)
      );
    `);
  },
};
