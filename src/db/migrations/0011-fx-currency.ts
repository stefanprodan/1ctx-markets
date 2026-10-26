// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Migration } from "../migration.ts";

// Yahoo answers no currency for some pairs (EURRON=X), and no later fetch
// of a stored instrument rewrites it, so a pair stored before the client
// read it from the symbol gets it here: AAABBB=X and BBB=X quote in BBB.
export const m0011: Migration = {
  id: "0011-fx-currency",
  up(db) {
    db.exec(`
      update instruments
        set currency = substr(upper(source_symbol), length(source_symbol) - 4, 3)
        where source = 'yahoo' and upper(type) = 'CURRENCY'
          and currency is null
          and (upper(source_symbol) glob '[A-Z][A-Z][A-Z]=X'
            or upper(source_symbol) glob '[A-Z][A-Z][A-Z][A-Z][A-Z][A-Z]=X');
    `);
  },
};
