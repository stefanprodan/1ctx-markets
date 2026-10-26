// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// No ticker list: tracked means read within the window or read by a rule;
// searches and jobs never count.

import { DAY_MS } from "./clock.ts";
import type { Db } from "./db/index.ts";
import { type Instrument, readInstruments } from "./instruments.ts";
import { ruleInstruments } from "./rules/store.ts";

export const TRACK_DAYS = 30;
export const TRACK_MS = TRACK_DAYS * DAY_MS;

// Runs inside a writer transaction; never moves a read back in time.
export function markRead(db: Db, ids: Iterable<string>, now: number): void {
  const update = db.query(
    `update instruments set last_read_at = ?1
     where id = ?2 and (last_read_at is null or last_read_at < ?1)`,
  );
  for (const id of new Set(ids)) update.run(now, id);
}

// The instruments read within the window and every one a rule reads,
// paused or not, so every job follows the same set.
export function trackedIds(
  db: Db,
  now: number,
  trackMs: number = TRACK_MS,
): Set<string> {
  const ids = new Set(
    db
      .query<{ id: string }, [number]>(
        "select id from instruments where last_read_at > ?",
      )
      .all(now - trackMs)
      .map((r) => r.id),
  );
  for (const id of ruleInstruments(db)) ids.add(id);
  return ids;
}

export function isTracked(
  db: Db,
  id: string,
  now: number,
  trackMs: number = TRACK_MS,
): boolean {
  return trackedIds(db, now, trackMs).has(id);
}

export function trackedInstruments(
  db: Db,
  now: number,
  trackMs: number = TRACK_MS,
): Instrument[] {
  const tracked = trackedIds(db, now, trackMs);
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
