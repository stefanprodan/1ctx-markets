// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// One row per source job run, which is where staleness is read from:
// a job whose last run in its scope failed marks that scope's rows
// stale, and never another job's, scope's or source's.

import { type Clock, DAY_MS } from "./clock.ts";
import type { Db } from "./db/index.ts";
import { phraseOf } from "./source.ts";
import type { Writer } from "./writer.ts";

export const RUNS_KEPT_MS = 30 * DAY_MS;

// the phrase a run left running by a crash is failed with at startup
export const INTERRUPTED = "interrupted";

export type Run = {
  id: number;
  source: string;
  job: string;
  // a Yahoo pass's or Finnhub market calendar's market, else the
  // instrument; null for Yahoo's backfill
  scope: string | null;
  startedAt: number;
  endedAt: number | null;
  status: "running" | "ok" | "failed";
  rows: number;
  error: string | null;
};

const SELECT = `select id, source, job, scope, started_at as startedAt,
  ended_at as endedAt, status, rows, error from sync_runs`;

export function startRun(
  db: Db,
  source: string,
  job: string,
  now: number,
  scope: string | null = null,
): number {
  return Number(
    db
      .query(
        `insert into sync_runs (source, job, scope, started_at, status)
         values (?, ?, ?, ?, 'running')`,
      )
      .run(source, job, scope, now).lastInsertRowid,
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

// a run still running at startup was cut by a crash or a kill
export function failInterrupted(db: Db, now: number): number {
  return db
    .query(
      `update sync_runs set status = 'failed', ended_at = ?, error = ?
       where status = 'running'`,
    )
    .run(now, INTERRUPTED).changes;
}

// a failure is recorded and thrown on, so the scheduler logs it
export async function runJob(
  writer: Writer,
  clock: Clock,
  source: string,
  job: string,
  fn: () => Promise<number>,
  scope: string | null = null,
): Promise<number> {
  const id = await writer.write((db) =>
    startRun(db, source, job, clock.now(), scope),
  );
  try {
    const rows = await fn();
    await writer.write((db) => endRun(db, id, clock.now(), rows));
    return rows;
  } catch (error) {
    await writer.write((db) => failRun(db, id, clock.now(), error));
    throw error;
  }
}

// ended runs only; a null scope matches null-scoped runs, no scope any
export function lastRun(
  db: Db,
  source: string,
  job: string,
  scope?: string | null,
): Run | null {
  if (scope === undefined) {
    return (
      db
        .query<Run, [string, string]>(
          `${SELECT} where source = ? and job = ? and status <> 'running'
           order by started_at desc, id desc limit 1`,
        )
        .get(source, job) ?? null
    );
  }
  return (
    db
      .query<Run, [string, string, string | null]>(
        `${SELECT} where source = ? and job = ? and scope is ?
           and status <> 'running'
         order by started_at desc, id desc limit 1`,
      )
      .get(source, job, scope) ?? null
  );
}

// the latest run, running ones included, for when a pass is next due
export function lastStarted(
  db: Db,
  source: string,
  job: string,
  scope: string | null,
  status?: Run["status"],
): Run | null {
  return (
    db
      .query<Run, [string, string, string | null, string | null]>(
        `${SELECT} where source = ?1 and job = ?2 and scope is ?3
           and (?4 is null or status = ?4)
         order by started_at desc, id desc limit 1`,
      )
      .get(source, job, scope, status ?? null) ?? null
  );
}

// the source's jobs whose latest ended run failed in any of their scopes
export function staleJobs(db: Db, source: string): string[] {
  return db
    .query<{ job: string }, [string]>(
      `select distinct job from sync_runs r
       where source = ?1 and status = 'failed'
         and id = (select id from sync_runs
           where source = ?1 and job = r.job and scope is r.scope
             and status <> 'running'
           order by started_at desc, id desc limit 1)
       order by job`,
    )
    .all(source)
    .map((r) => r.job);
}

// with no job, any of the source's jobs in any scope
export function isStale(
  db: Db,
  source: string,
  job?: string,
  scope?: string | null,
): boolean {
  if (job === undefined) return staleJobs(db, source).length > 0;
  if (scope === undefined) return staleJobs(db, source).includes(job);
  return lastRun(db, source, job, scope)?.status === "failed";
}

export function pruneRuns(db: Db, now: number): number {
  return db
    .query("delete from sync_runs where started_at < ?")
    .run(now - RUNS_KEPT_MS).changes;
}
