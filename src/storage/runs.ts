// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// Staleness is read from runs: a failed last run marks only its job and scope.

import { type Clock, DAY_MS } from "../runtime/clock.ts";
import { phraseOf, STOPPED } from "../sources/source.ts";
import type { Db } from "./db/index.ts";
import type { Writer } from "./writer.ts";

export const RUNS_KEPT_MS = 30 * DAY_MS;

// the phrase a run left running by a crash is failed with at startup
export const INTERRUPTED = "interrupted";

// a failure that says something about the source: never a shutdown's cut
export const failedRun = <R extends Pick<Run, "status" | "error">>(
  r: R | null | undefined,
): r is R => r?.status === "failed" && r.error !== STOPPED;

export type Run = {
  id: number;
  source: string;
  job: string;
  // a market, else an instrument; null only in runs from before
  // backfill runs were scoped
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
  // a run with no scope would never show among a job's counts
  scope: string,
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
  scope: string,
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

// when a market's pass of these jobs last started, one cut by shutdown
// aside: a restart asks a market again only when its period holds no
// pass of it yet
export function lastPassAt(
  db: Db,
  source: string,
  jobs: readonly string[],
  market: string,
): number | null {
  const row = db
    .query<{ at: number | null }, [string, string, string, string]>(
      `select max(started_at) as at from sync_runs
       where source = ?1 and job in (select value from json_each(?2))
         and scope = ?3 and not (status = 'failed' and error is ?4)`,
    )
    .get(source, JSON.stringify(jobs), market, STOPPED);
  return row?.at ?? null;
}

// running ones included
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

// no job means any of the source's jobs, in any scope
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
