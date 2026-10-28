// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { Database } from "bun:sqlite";
import type { Clock } from "../../runtime/clock.ts";
import type { Migration } from "./migration.ts";
import { MIGRATIONS } from "./migrations/index.ts";

export type Db = Database;

export type OpenedDb = { db: Db; migrations: string[] };

export function open(path: string, clock: Clock): OpenedDb {
  const db = new Database(path, { create: true, strict: true });
  db.exec("pragma journal_mode = wal");
  db.exec("pragma foreign_keys = on");
  db.exec("pragma busy_timeout = 5000");
  return { db, migrations: migrate(db, clock) };
}

// applies unrecorded migrations in list order; the first creates the record
// itself, so a fresh database has none applied
export function migrate(
  db: Db,
  clock: Clock,
  list: readonly Migration[] = MIGRATIONS,
): string[] {
  const recorded =
    db
      .query<{ n: number }, []>(
        "select count(*) as n from sqlite_master where type = 'table' and name = 'migrations'",
      )
      .get()!.n > 0;
  const applied = new Set(
    recorded
      ? db
          .query<{ id: string }, []>("select id from migrations")
          .all()
          .map((row) => row.id)
      : [],
  );
  const ran: string[] = [];
  for (const migration of list) {
    if (applied.has(migration.id)) continue;
    db.transaction(() => {
      migration.up(db);
      db.query("insert into migrations (id, applied_at) values (?, ?)").run(
        migration.id,
        clock.now(),
      );
    })();
    ran.push(migration.id);
  }
  return ran;
}
