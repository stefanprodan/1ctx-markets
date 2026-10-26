// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Whether an instrument's quote or bars are stale, with fixed reasons,
// read from its own source's runs in its own market: a successful
// search never clears a failed quote pass, and one market's failure
// never marks another's rows. A quote pass that answered is judged
// per instrument, so one symbol that never answers marks only itself.

import { CRYPTO, closeQuoteAt, readSession } from "./calendars.ts";
import type { Db } from "./db/index.ts";
import type { Instrument } from "./instruments.ts";
import { lastRun, lastStarted } from "./runs.ts";

// the jobs whose runs carry a market as their scope
export const JOBS = {
  // every instrument of a market in session, and once after its close
  quotes: "quotes",
  // one instrument of a closed market, to see a new session
  check: "check",
  // the 30-day refetch when a market's session moves on
  bars: "bars",
} as const;

export const STALE = {
  quotesFailed: "quote sync failed",
  noQuote: "no quote in the last pass",
  noQuoteYet: "no quote yet",
  checkFailed: "session check failed",
  barsFailed: "bar sync failed",
  barsPending: "bar sync pending",
  noHistory: "no history",
  signalsPending: "signals pending",
  // a live row stepped over a stored day not final yet
  previousDayNotFinal: "previous day not final",
  // the market trades, and no pass refreshed the quote for two periods
  quoteOverdue: "quote overdue",
} as const;

export type StaleReason = (typeof STALE)[keyof typeof STALE];

type Scoped = Pick<Instrument, "id" | "source" | "market" | "addedAt">;

const failed = (db: Db, i: Scoped, job: string) =>
  lastRun(db, i.source, job, i.market)?.status === "failed";

// None when the quote is current. With due, a quote no pass refreshed
// within two periods of when one was last due is overdue, as after
// downtime, before Monday's first pass or a missed close.
export function quoteStale(
  db: Db,
  instrument: Scoped,
  due: { now: number; everyMs: number } | null = null,
): StaleReason[] {
  const reasons: StaleReason[] = [];
  const quote = db
    .query<{ fetchedAt: number }, [string]>(
      "select fetched_at as fetchedAt from quotes where instrument = ?",
    )
    .get(instrument.id);
  const pass = lastRun(db, instrument.source, JOBS.quotes, instrument.market);
  if (pass?.status === "failed") reasons.push(STALE.quotesFailed);
  if (quote === null) reasons.push(STALE.noQuoteYet);
  else if (
    pass?.status === "ok" &&
    pass.startedAt >= instrument.addedAt &&
    quote.fetchedAt < pass.startedAt
  ) {
    // asked in the last pass, and its quote did not come back
    reasons.push(STALE.noQuote);
  }
  if (due !== null && quote !== null) {
    const expected = lastQuoteDue(db, instrument.market, due.now);
    if (expected !== null && quote.fetchedAt < expected - 2 * due.everyMs) {
      reasons.push(STALE.quoteOverdue);
    }
  }
  // a closed market's new session can go unseen while its checks fail
  if (failed(db, instrument, JOBS.check)) reasons.push(STALE.checkFailed);
  return reasons;
}

// The last time a pass should have refreshed a market's quote: now
// while it trades, its post-close quote once it closed, and null before
// its stored session begins. A session left from Friday on Monday is
// what failed checks already mark.
function lastQuoteDue(db: Db, market: string, now: number): number | null {
  if (market === CRYPTO) return now;
  const s = readSession(db, market);
  if (s === null || now < s.start) return null;
  return Math.min(now, closeQuoteAt(market, s) ?? now);
}

// The bars miss a day while the market's current session began after
// the last bar pass that ended well, and until then the previous bar
// is not final. An instrument added since that session began came with
// its whole history, so it misses none.
export function barsStale(
  db: Db,
  instrument: Scoped,
  now: number,
): StaleReason[] {
  const has = db
    .query<{ n: number }, [string]>(
      "select count(*) as n from bars where instrument = ? and interval = '1d'",
    )
    .get(instrument.id)!.n;
  if (has === 0) return [STALE.noHistory];
  const reasons: StaleReason[] = [];
  if (failed(db, instrument, JOBS.bars)) reasons.push(STALE.barsFailed);
  const session = readSession(db, instrument.market);
  if (
    barsDue(db, instrument.source, instrument.market, now) &&
    (session === null || instrument.addedAt < session.start)
  ) {
    reasons.push(STALE.barsPending);
  }
  return reasons;
}

// A market's bars are due once its stored session has begun and no bar
// pass has ended well since; a restart after downtime is due the same
// way.
export function barsDue(
  db: Db,
  source: string,
  market: string,
  now: number,
): boolean {
  const session = readSession(db, market);
  if (session === null || session.start > now) return false;
  const ok = lastStarted(db, source, JOBS.bars, market, "ok");
  return ok === null || ok.startedAt < session.start;
}
