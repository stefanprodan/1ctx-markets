// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Migration } from "../migration.ts";

// a device's subscription goes with the login that saved it, so a sign-out
// or an expired login stops its pushes; the cursor starts at the newest
// alert, so turning push on never sends the history
export const m0048: Migration = {
  id: "0048-push-subscriptions",
  up(db) {
    db.exec(`
      create table push_subscriptions (
        id integer primary key,
        owner text not null references users (id) on delete cascade,
        login text not null references logins (id) on delete cascade,
        endpoint text not null unique,
        p256dh text not null,
        auth text not null,
        created_at integer not null
      ) strict;
      create index push_subscriptions_by_owner on push_subscriptions (owner);
      create index push_subscriptions_by_login on push_subscriptions (login);
      create table push_sent (
        id integer primary key check (id = 1),
        alert integer not null
      ) strict;
      insert into push_sent (id, alert)
        select 1, coalesce(max(id), 0) from alerts;
    `);
  },
};
