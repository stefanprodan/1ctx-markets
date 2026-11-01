// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Migration } from "../migration.ts";

// cash counts by its currency, a bond by its listing; the column stays for older binaries
export const m0031: Migration = {
  id: "0031-cash-no-market",
  up(db) {
    db.exec("update positions set market = null where market is not null;");
  },
};
