// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Each market's hours come from its source's answers, never from a
// table kept by hand, so any exchange the source carries works.

import type { Db } from "./db/index.ts";
import { DAY_MS, MINUTE_MS } from "./runtime/clock.ts";
import {
  addDays,
  checkZone,
  fromWallTime,
  localDate,
  startOfDate,
  wallOfDate,
  wallTime,
} from "./zone.ts";

const HOUR_MS = 60 * MINUTE_MS;

// a longer one cannot be one local day's session
const MAX_SESSION_MS = 25 * HOUR_MS;

export const CRYPTO = "CRYPTO";

// a regular session, start and end in UTC epoch ms
export type Session = { zone: string; start: number; end: number };

export type StoredSession = Session & { market: string; fetchedAt: number };

// From a Yahoo chart meta, which the v7 spark answer carries per symbol.
export function sessionFromChartMeta(meta: unknown): Session {
  const m = meta as {
    exchangeTimezoneName?: unknown;
    currentTradingPeriod?: { regular?: { start?: unknown; end?: unknown } };
  } | null;
  const zone = checkZone(m?.exchangeTimezoneName);
  const regular = m?.currentTradingPeriod?.regular;
  const start = regular?.start;
  const end = regular?.end;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) {
    throw new Error("no regular trading period");
  }
  return session(zone, (start as number) * 1000, (end as number) * 1000);
}

export function session(zone: string, start: number, end: number): Session {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) {
    throw new Error("session times are not whole ms");
  }
  if (end <= start || end - start > MAX_SESSION_MS) {
    throw new Error("malformed regular trading period");
  }
  return { zone: checkZone(zone), start, end };
}

// moves back only while the stored session has not begun, to undo a bad answer
export function recordSession(
  db: Db,
  market: string,
  s: Session,
  fetchedAt: number,
): boolean {
  if (market === "") throw new Error("no market");
  if (!Number.isSafeInteger(fetchedAt)) throw new Error("bad fetch time");
  const checked = session(s.zone, s.start, s.end);
  const { changes } = db
    .query(
      `insert into markets (market, zone, session_start, session_end, fetched_at)
       values (?, ?, ?, ?, ?)
       on conflict (market) do update set
         zone = excluded.zone,
         session_start = excluded.session_start,
         session_end = excluded.session_end,
         fetched_at = excluded.fetched_at
       where excluded.fetched_at >= markets.fetched_at
         and (excluded.session_start >= markets.session_start
           or markets.session_start > excluded.fetched_at)`,
    )
    .run(market, checked.zone, checked.start, checked.end, fetchedAt);
  return changes > 0;
}

type Row = {
  market: string;
  zone: string;
  start: number;
  end: number;
  fetchedAt: number;
};

const SELECT = `select market, zone, session_start as start,
  session_end as end, fetched_at as fetchedAt from markets`;

export function readSession(db: Db, market: string): StoredSession | null {
  return (
    db.query<Row, [string]>(`${SELECT} where market = ?`).get(market) ?? null
  );
}

export function readSessions(db: Db): StoredSession[] {
  return db.query<Row, []>(`${SELECT} order by market`).all();
}

// A session's end names its last minute, so a 23:59 end runs to midnight.
export function isQuoted(
  market: string,
  s: Session | null,
  now: number,
): boolean {
  if (market === CRYPTO) return true;
  return s !== null && now >= s.start && now < s.end + MINUTE_MS;
}

// A closing auction can print after the end; crypto never closes.
export function closeQuoteAt(market: string, s: Session): number | null {
  return market === CRYPTO ? null : s.end + 15 * MINUTE_MS;
}

// a past session can show over a holiday: ask at local start, then hourly
export function nextCheck(s: Session, since: number): number {
  if (since < s.start) return s.start;
  const day = Math.floor(wallTime(s.zone, s.start) / DAY_MS) * DAY_MS;
  const from = wallTime(s.zone, s.start) - day;
  // an end that a clock change puts before the start still gets its start slot
  const until = Math.max(wallTime(s.zone, s.end) - day, from + 1);
  // a check stale by months starts near since, not at the session
  let wall = Math.max(
    day + DAY_MS,
    Math.floor(wallTime(s.zone, since) / DAY_MS) * DAY_MS - DAY_MS,
  );
  for (; ; wall += DAY_MS) {
    for (let at = from; at < until; at += HOUR_MS) {
      const check = fromWallTime(s.zone, wall + at);
      if (check > since) return check;
    }
  }
}

// the local date, never UTC: EURUSD=X's Friday bar starts Thursday 23:00 UTC
export function barDate(zone: string, at: number): string {
  return localDate(zone, at);
}

export function sessionDate(s: Session): string {
  return localDate(s.zone, s.start);
}

// final only at a later session, so late prints (a closing auction) land first
export function isBarFinal(date: string, latest: Session): boolean {
  // a malformed date would compare as a string and pass
  wallOfDate(date);
  return sessionDate(latest) > date;
}

export function weekOf(date: string): string {
  const weekday = new Date(wallOfDate(date)).getUTCDay();
  return addDays(date, -((weekday + 6) % 7));
}

export function weekEnd(zone: string, monday: string): number {
  if (weekOf(monday) !== monday) throw new Error(`not a Monday: ${monday}`);
  return startOfDate(checkZone(zone), addDays(monday, 7));
}

export function isWeekFinal(
  monday: string,
  lastBar: string,
  latest: Session,
  now: number,
): boolean {
  if (weekOf(lastBar) !== monday) {
    throw new Error(`${lastBar} is not in the week of ${monday}`);
  }
  return now >= weekEnd(latest.zone, monday) && isBarFinal(lastBar, latest);
}
