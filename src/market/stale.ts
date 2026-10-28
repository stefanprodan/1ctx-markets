// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// Scoped by source, job and market: one market's failure never marks another.

import { MINUTE_MS } from "../runtime/clock.ts";
import { BVB } from "../sources/ids.ts";
import type { Db } from "../storage/db/index.ts";
import { failedRun, lastRun, lastStarted } from "../storage/runs.ts";
import { CRYPTO, closeQuoteAt, readSession } from "./calendars.ts";
import type { Instrument } from "./instruments.ts";

export const JOBS = {
  quotes: "quotes",
  check: "check",
  // the 30-day refetch when a market's session moves on, one run per instrument
  bars: "bars",
  // a refetch owing the previous close, per instrument, after its bars run
  owed: "owed",
} as const;

// a chart can take hours to fill the close; often enough to land it early
export const OWED_RETRY_MS = 15 * MINUTE_MS;

// a market's prices moving to another source, a run scoped to the market
export const SWITCH = { source: "sources", job: "switch" } as const;

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
  // the market's whole history is being refetched from another source
  switchPending: "source switch pending",
  // its source is off since the last start, so its prices are its last
  sourceOff: "source off",
  // why quote's extended is null when asked; none says the price held
  extendedNone: "extended: no pre- or post-market trading",
  extendedUnreported: "extended: not reported by its source",
  extendedNoPrice: "extended: no price since the regular close",
  extendedOpen: "extended: regular session open",
  extendedTimeout: "extended: not fetched in time",
  extendedFailed: "extended: fetch failed",
} as const;

export type StaleReason = (typeof STALE)[keyof typeof STALE];

type Scoped = Pick<Instrument, "id" | "source" | "market" | "addedAt">;

const failed = (db: Db, i: Scoped, job: string) =>
  failedRun(lastRun(db, i.source, job, i.market));

// until the switch lands, running or failed
function switching(db: Db, market: string): boolean {
  const run = lastStarted(db, SWITCH.source, SWITCH.job, market);
  return run !== null && run.status !== "ok";
}

// the price sources on at the last start, written once a switch landed; empty
// means none is off. Only the feed can be turned off.
function sourceOff(db: Db, i: Scoped): boolean {
  if (i.source !== BVB || switching(db, i.market)) return false;
  const names = db
    .query<{ name: string }, []>("select name from sources")
    .all()
    .map((r) => r.name);
  return names.length > 0 && !names.includes(i.source);
}

// with due: no pass refreshed it within two periods, as after downtime
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
  if (failedRun(pass)) reasons.push(STALE.quotesFailed);
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
  if (switching(db, instrument.market)) reasons.push(STALE.switchPending);
  if (sourceOff(db, instrument)) reasons.push(STALE.sourceOff);
  return reasons;
}

// a Friday session still stored on Monday is left to the failed checks
function lastQuoteDue(db: Db, market: string, now: number): number | null {
  if (market === CRYPTO) return now;
  const s = readSession(db, market);
  if (s === null || now < s.start) return null;
  return Math.min(now, closeQuoteAt(market, s) ?? now);
}

// one added since the session began came with its whole history
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
  const reasons: StaleReason[] = switching(db, instrument.market)
    ? [STALE.switchPending]
    : sourceOff(db, instrument)
      ? [STALE.sourceOff]
      : [];
  if (has === 0) return [STALE.noHistory, ...reasons];
  // the market's pass, or this instrument's own refetch in it
  if (
    failed(db, instrument, JOBS.bars) ||
    lastRun(db, instrument.source, JOBS.bars, instrument.id)?.status ===
      "failed"
  ) {
    reasons.push(STALE.barsFailed);
  }
  const session = readSession(db, instrument.market);
  if (
    barsDue(db, instrument.source, instrument.market, now) &&
    (session === null || instrument.addedAt < session.start)
  ) {
    reasons.push(STALE.barsPending);
  }
  return reasons;
}

// read from stored state alone, so a restart after downtime catches up
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

// owed in this session only: the next starts a full pass, after which a day
// never closed is a gap; all asked at once, at most once per OWED_RETRY_MS
export function owedDue<T extends { id: string }>(
  db: Db,
  source: string,
  market: string,
  instruments: readonly T[],
  now: number,
): T[] {
  const session = readSession(db, market);
  if (session === null) return [];
  let earliest = now;
  const has = db.query<{ n: number }, [string]>(
    "select count(*) as n from (select 1 from bars where instrument = ? and interval = '1d' limit 1)",
  );
  const owed = instruments.filter((i) => {
    // the bar pass skips one with no bars, so its mark would never renew
    if (has.get(i.id)!.n === 0) return false;
    const mark = lastStarted(db, source, JOBS.owed, i.id);
    // any later bars run, landed or failed, settles it
    const bars = lastStarted(db, source, JOBS.bars, i.id);
    if (
      mark === null ||
      bars === null ||
      bars.id > mark.id ||
      mark.startedAt < session.start
    ) {
      return false;
    }
    earliest = Math.min(earliest, mark.startedAt);
    return true;
  });
  return now - earliest >= OWED_RETRY_MS ? owed : [];
}
