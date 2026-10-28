// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Migration } from "../migration.ts";

// when a read last named each instrument; one stored before starts one window
// from its last update, so an upgrade stops none at once
export const m0006: Migration = {
  id: "0006-tracking",
  up(db) {
    db.exec(`
      alter table instruments add column last_read_at integer;
      update instruments set last_read_at = updated_at;
      create index instruments_by_read on instruments (last_read_at);
    `);
  },
};
