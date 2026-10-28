// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Migration } from "../migration.ts";

// A deleted instrument's runs go with it; a reused id let a job still in
// flight end another job's run. No table points at sync_runs, so it is
// rebuilt inside the transaction.
export const m0014: Migration = {
  id: "0014-run-ids",
  up(db) {
    db.exec(`
      create table sync_runs_next (
        id integer primary key autoincrement,
        source text not null,
        job text not null,
        scope text,
        started_at integer not null,
        ended_at integer,
        status text not null check (status in ('running', 'ok', 'failed')),
        rows integer not null default 0,
        error text,
        check ((status = 'running') = (ended_at is null)),
        check ((status = 'failed') = (error is not null))
      ) strict;

      insert into sync_runs_next (id, source, job, scope, started_at,
        ended_at, status, rows, error)
      select id, source, job, scope, started_at, ended_at, status, rows, error
      from sync_runs;

      drop table sync_runs;
      alter table sync_runs_next rename to sync_runs;
      create index sync_runs_by_scope on sync_runs (source, job, scope, started_at);
    `);
  },
};
