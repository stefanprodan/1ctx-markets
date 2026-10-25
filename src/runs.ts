// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// One row per source job run, which is where staleness is read from:
// a job whose last run failed marks its source's rows stale, and never
// another source's.

import { type Clock, DAY_MS } from "./clock.ts";
import type { Db } from "./db/index.ts";
import { phraseOf } from "./source.ts";

export const RUNS_KEPT_MS = 30 * DAY_MS;

export type Run = {
  id: number;
  source: string;
  job: string;
  startedAt: number;
  endedAt: number | null;
  status: "running" | "ok" | "failed";
  rows: number;
  error: string | null;
};

const SELECT = `select id, source, job, started_at as startedAt,
  ended_at as endedAt, status, rows, error from sync_runs`;

export function startRun(db: Db, source: string, job: string, now: number) {
  return Number(
    db
      .query(
        `insert into sync_runs (source, job, started_at, status)
         values (?, ?, ?, 'running')`,
      )
      .run(source, job, now).lastInsertRowid,
  );
}

export function endRun(db: Db, id: number, now: number, rows: number): void {
  db.query(
    `update sync_runs set status = 'ok', ended_at = ?, rows = ?
     where id = ? and status = 'running'`,
  ).run(now, rows, id);
}

// only the fixed phrase is kept, never an error's own text
export function failRun(
  db: Db,
  id: number,
  now: number,
  error: unknown,
  rows = 0,
): void {
  db.query(
    `update sync_runs set status = 'failed', ended_at = ?, rows = ?, error = ?
     where id = ? and status = 'running'`,
  ).run(now, rows, phraseOf(error), id);
}

// Records the run around fn, which answers the rows it wrote; a failure
// is recorded and thrown on, so the scheduler logs it.
export async function runJob(
  db: Db,
  clock: Clock,
  source: string,
  job: string,
  fn: () => Promise<number>,
): Promise<number> {
  const id = startRun(db, source, job, clock.now());
  try {
    const rows = await fn();
    endRun(db, id, clock.now(), rows);
    return rows;
  } catch (error) {
    failRun(db, id, clock.now(), error);
    throw error;
  }
}

// the latest run of the job that has ended
export function lastRun(db: Db, source: string, job: string): Run | null {
  return (
    db
      .query<Run, [string, string]>(
        `${SELECT} where source = ? and job = ? and status <> 'running'
         order by started_at desc, id desc limit 1`,
      )
      .get(source, job) ?? null
  );
}

// the source's jobs whose latest ended run failed
export function staleJobs(db: Db, source: string): string[] {
  return db
    .query<{ job: string }, [string]>(
      `select job from sync_runs r
       where source = ?1 and status = 'failed'
         and id = (select id from sync_runs
           where source = ?1 and job = r.job and status <> 'running'
           order by started_at desc, id desc limit 1)
       order by job`,
    )
    .all(source)
    .map((r) => r.job);
}

// one job's rows, or with no job any of the source's
export function isStale(db: Db, source: string, job?: string): boolean {
  if (job === undefined) return staleJobs(db, source).length > 0;
  return lastRun(db, source, job)?.status === "failed";
}

export function pruneRuns(db: Db, now: number): number {
  return db
    .query("delete from sync_runs where started_at < ?")
    .run(now - RUNS_KEPT_MS).changes;
}
