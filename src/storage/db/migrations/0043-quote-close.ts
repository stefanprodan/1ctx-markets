// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Migration } from "../migration.ts";

// a day's close taken from the next session's quote, kept against an
// empty row until the source answers its own
export const m0043: Migration = {
  id: "0043-quote-close",
  up(db) {
    db.exec(`
      alter table bars add column quote_close integer not null default 0
        check (quote_close in (0, 1));
    `);
  },
};
