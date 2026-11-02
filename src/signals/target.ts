// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// What dates a live row: the stored quote inside its market's session.

import {
  CRYPTO,
  readSession,
  type Session,
  sessionDate,
} from "../market/calendars.ts";
import type { Instrument } from "../market/instruments.ts";
import { fromWallTime, localDate, wallTime } from "../market/zone.ts";
import { DAY_MS, MINUTE_MS } from "../runtime/clock.ts";
import type { Db } from "../storage/db/index.ts";

export type Scoped = Pick<Instrument, "id" | "market">;

export type LiveTarget = { date: string; quote: LiveQuote };

export type LiveQuote = {
  price: number;
  dayHigh: number | null;
  dayLow: number | null;
  volume: number | null;
  time: number;
};

// a closing auction prints late; keep it covering closeQuoteAt's 15 minutes
export const LIVE_AFTER_END_MS = 15 * MINUTE_MS;

// Nothing of the next session trades before its local start, while an
// index's value can be stamped long after the end (^NDX 75 minutes).
export function liveUntil(s: Session): number {
  const next = fromWallTime(s.zone, wallTime(s.zone, s.start) + DAY_MS);
  return Math.max(s.end + LIVE_AFTER_END_MS, next - 1);
}

// dated by the market's stored session, never the trade's own day: past
// midnight Yahoo's crypto trade is the new day's while its day fields are
// the old one's until the period rolls
export function liveTarget(db: Db, instrument: Scoped): LiveTarget | null {
  const row = db
    .query<
      Omit<LiveQuote, "time"> & { time: number | null; fetchedAt: number },
      [string]
    >(
      `select price, day_high as dayHigh, day_low as dayLow, volume, time,
         fetched_at as fetchedAt
       from quotes where instrument = ?`,
    )
    .get(instrument.id);
  if (row === null) return null;
  const session = readSession(db, instrument.market);
  // an untimed index page is current while its market trades: its fetch, at
  // most the session's end, dates the live row; the stored quote keeps no time
  const { fetchedAt, ...rest } = row;
  const quote: LiveQuote = {
    ...rest,
    time:
      row.time ??
      (session === null ? fetchedAt : Math.min(fetchedAt, session.end)),
  };
  // a crypto market with no period stored yet still gets its live row
  if (session === null && instrument.market === CRYPTO) {
    return { date: localDate("UTC", quote.time), quote };
  }
  if (
    session === null ||
    quote.time < session.start ||
    quote.time > liveUntil(session)
  ) {
    return null;
  }
  return { date: sessionDate(session), quote };
}
