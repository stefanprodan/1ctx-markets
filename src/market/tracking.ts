// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// Tracked means read within the window, by a rule or by --track; searches
// and jobs don't.

import { ruleInstruments } from "../rules/store.ts";
import { DAY_MS } from "../runtime/clock.ts";
import type { Db } from "../storage/db/index.ts";
import { type Instrument, readInstruments } from "./instruments.ts";

export const TRACK_DAYS = 30;
export const TRACK_MS = TRACK_DAYS * DAY_MS;

export type Tracking = {
  readMs: number;
  // ids the --track values resolved to, filled in as they resolve
  flagged: ReadonlySet<string>;
  // flagged ids that missed a session, until their catch-up lands
  owed: ReadonlySet<string>;
};

export const BY_USE: Tracking = {
  readMs: TRACK_MS,
  flagged: new Set(),
  owed: new Set(),
};

// tracked and whole, so a read takes it as it is; else it catches up
export function isKept(
  db: Db,
  id: string,
  now: number,
  tracking: Tracking = BY_USE,
): boolean {
  return !tracking.owed.has(id) && isTracked(db, id, now, tracking);
}

// Runs inside a writer transaction; never moves a read back in time.
export function markRead(db: Db, ids: Iterable<string>, now: number): void {
  const update = db.query(
    `update instruments set last_read_at = ?1
     where id = ?2 and (last_read_at is null or last_read_at < ?1)`,
  );
  for (const id of new Set(ids)) update.run(now, id);
}

// read within the window, every one a rule reads, paused or not, and each
// --track id
export function trackedIds(
  db: Db,
  now: number,
  tracking: Tracking = BY_USE,
): Set<string> {
  const ids = new Set(
    db
      .query<{ id: string }, [number]>(
        "select id from instruments where last_read_at > ?",
      )
      .all(now - tracking.readMs)
      .map((r) => r.id),
  );
  for (const id of ruleInstruments(db)) ids.add(id);
  for (const id of tracking.flagged) ids.add(id);
  return ids;
}

export function isTracked(
  db: Db,
  id: string,
  now: number,
  tracking: Tracking = BY_USE,
): boolean {
  return trackedIds(db, now, tracking).has(id);
}

export function trackedInstruments(
  db: Db,
  now: number,
  tracking: Tracking = BY_USE,
): Instrument[] {
  const tracked = trackedIds(db, now, tracking);
  return readInstruments(db).filter((i) => tracked.has(i.id));
}

export function lastReadAt(db: Db, id: string): number | null {
  return (
    db
      .query<{ at: number | null }, [string]>(
        "select last_read_at as at from instruments where id = ?",
      )
      .get(id)?.at ?? null
  );
}
