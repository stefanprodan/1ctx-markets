// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Migration } from "../migration.ts";

// when a rule is evaluated: on every quote, or once at its bar's close;
// on is an SQL keyword, hence trigger_on
export const m0049: Migration = {
  id: "0049-rules-on",
  up(db) {
    db.exec(`
      alter table rules add column trigger_on text not null default 'touch'
        check (trigger_on in ('touch', 'close', 'weekly_close'));
      alter table rules add column closed_session text
        check (closed_session glob '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]');
    `);
  },
};
