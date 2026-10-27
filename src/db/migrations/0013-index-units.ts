// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Migration } from "../migration.ts";

// A Yahoo index is in index points, as one resolved from now on is; a
// stored one was left unknown and would keep it, since only a fetch of
// a new listing sets the unit.
export const m0013: Migration = {
  id: "0013-index-units",
  up(db) {
    db.exec(`
      update instruments set unit = 'index_points'
        where source = 'yahoo' and upper(type) = 'INDEX' and unit = 'unknown';
    `);
  },
};
