// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Migration } from "../migration.ts";

// cash counts by its currency and a bond by its listing, so no position
// names a market; the column stays, unread, so an older binary still opens
export const m0031: Migration = {
  id: "0031-cash-no-market",
  up(db) {
    db.exec("update positions set market = null where market is not null;");
  },
};
