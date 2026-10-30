// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Migration } from "../migration.ts";

// the day a trade's quantity and price are stated as of: only splits after
// it apply. A trade typed in is stated on its own date; one read from an
// export that restates old lots in today's shares, on the export's day.
// Null reads as the trade's date, as every trade before this one was.
export const m0021: Migration = {
  id: "0021-stated-on",
  up(db) {
    db.exec(`
      alter table trades add column stated_on text
        check (stated_on is null
          or stated_on glob '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]');
    `);
  },
};
