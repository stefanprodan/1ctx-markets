// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Migration } from "../migration.ts";

// the trading session a rule last fired in, so it fires once a session
export const m0045: Migration = {
  id: "0045-rules-fired-session",
  up(db) {
    db.exec(`
      alter table rules add column fired_session text
        check (fired_session glob '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]');
    `);
  },
};
