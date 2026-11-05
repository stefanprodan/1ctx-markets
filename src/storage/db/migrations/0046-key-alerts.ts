// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Migration } from "../migration.ts";

// a key's access to alerts, named as the tools and routes name them
export const m0046: Migration = {
  id: "0046-key-alerts",
  up(db) {
    db.exec("alter table keys rename column rules to alerts;");
  },
};
