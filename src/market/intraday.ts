// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// The 5-minute closes a quote answer carries, a few sessions per instrument.

import type { Db } from "../storage/db/index.ts";
import { localDate } from "./zone.ts";

export const INTRADAY_SESSIONS = 5;

// at in UTC epoch ms
export type Point = { at: number; close: number };

export type StoredPoint = Point & { session: string };

// Each answer holds its sessions so far, so replacing them leaves no hole a
// missed pass made; an answer with no points deletes nothing.
export function storeIntraday(
  db: Db,
  instrument: string,
  zone: string,
  points: readonly Point[],
  fetchedAt: number,
): void {
  if (points.length === 0) return;
  const sessions = new Map<string, Point[]>();
  for (const p of points) {
    const s = localDate(zone, p.at);
    const list = sessions.get(s);
    if (list === undefined) sessions.set(s, [p]);
    else list.push(p);
  }
  const drop = db.query(
    "delete from intraday where instrument = ? and session = ?",
  );
  const add = db.query(
    `insert into intraday (instrument, session, at, close, fetched_at)
     values (?, ?, ?, ?, ?)
     on conflict (instrument, session, at) do update set
       close = excluded.close, fetched_at = excluded.fetched_at`,
  );
  for (const [session, list] of sessions) {
    drop.run(instrument, session);
    for (const p of list)
      add.run(instrument, session, p.at, p.close, fetchedAt);
  }
  db.query(
    `delete from intraday where instrument = ?1 and session < (
       select min(session) from (
         select distinct session from intraday where instrument = ?1
         order by session desc limit ?2))`,
  ).run(instrument, INTRADAY_SESSIONS);
}

export function clearIntraday(db: Db, instrument: string): void {
  db.query("delete from intraday where instrument = ?").run(instrument);
}

export function newestSession(db: Db, instrument: string): string | null {
  return (
    db
      .query<{ s: string | null }, [string]>(
        "select max(session) as s from intraday where instrument = ?",
      )
      .get(instrument)?.s ?? null
  );
}

// oldest first, from the point at start on when given
export function readIntraday(
  db: Db,
  instrument: string,
  from: string,
  to: string,
  start: number | null = null,
): StoredPoint[] {
  return db
    .query<StoredPoint, [string, string, string, number]>(
      `select session, at, close from intraday
       where instrument = ? and session >= ? and session <= ? and at >= ?
       order by session, at`,
    )
    .all(instrument, from, to, start ?? Number.MIN_SAFE_INTEGER);
}

// each session's newest answer, oldest session first
export function intradaySessions(
  db: Db,
  instrument: string,
  from: string,
  to: string,
): { session: string; fetchedAt: number }[] {
  return db
    .query<{ session: string; fetchedAt: number }, [string, string, string]>(
      `select session, max(fetched_at) as fetchedAt from intraday
       where instrument = ? and session >= ? and session <= ?
       group by session order by session`,
    )
    .all(instrument, from, to);
}
