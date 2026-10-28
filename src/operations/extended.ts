// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// Never stored: signals, movers, screen and rules stay on the regular session.

import { CRYPTO, isQuoted, readSession } from "../market/calendars.ts";
import { iso, price, round } from "../market/format.ts";
import type { Instrument } from "../market/instruments.ts";
import { STALE, type StaleReason } from "../market/stale.ts";
import { MINUTE_MS } from "../runtime/clock.ts";
import { YAHOO } from "../sources/ids.ts";
import { SourceError } from "../sources/source.ts";
import type { IntradayAnswer, Window } from "../sources/yahoo/client.ts";
import { checkAnswer } from "../sources/yahoo/history.ts";
import {
  type ExtendedPoint,
  type ExtendedRead,
  type Markets,
  shared,
} from "./markets.ts";

const none = (reason: StaleReason): ExtendedRead => ({
  extended: null,
  reason,
});

const inside = (windows: readonly Window[], at: number) =>
  windows.some((w) => at >= w.start && at < w.end);

// kept through the night: an evening move is the newest price before the open
export function latestExtended(
  answer: IntradayAnswer,
  now: number,
): ExtendedRead {
  if (answer.prePost !== true) return none(STALE.extendedNone);
  const { pre, regular, post } = answer.windows;
  if (inside(regular, now)) return none(STALE.extendedOpen);
  let closed = Number.NEGATIVE_INFINITY;
  for (const w of regular) if (w.end <= now) closed = Math.max(closed, w.end);
  for (let i = answer.rows.length - 1; i >= 0; i--) {
    const { at, close } = answer.rows[i]!;
    // the bar's minute must end after the last regular trade
    if (at < closed || at + MINUTE_MS <= answer.time) break;
    if (close === null || at > now) continue;
    const session = inside(pre, at) ? "pre" : inside(post, at) ? "post" : null;
    if (session === null) continue;
    const change = close - answer.price;
    return {
      extended: {
        session,
        price: price(close),
        change: round(change),
        change_percent:
          answer.price === 0 ? null : round((change / answer.price) * 100),
        time: iso(at),
      },
      reason: null,
    };
  }
  return none(STALE.extendedNoPrice);
}

// the spark flag decides without a call; a listing never in one asks its chart
async function readOne(
  m: Markets,
  instrument: Instrument,
  deadline: number,
): Promise<ExtendedRead> {
  if (instrument.source !== YAHOO) return none(STALE.extendedUnreported);
  if (instrument.market === CRYPTO) return none(STALE.extendedNone);
  if (m.yahoo.prePost(instrument.sourceSymbol) === false) {
    return none(STALE.extendedNone);
  }
  const now = m.clock.now();
  if (isQuoted(instrument.market, readSession(m.db, instrument.market), now)) {
    return none(STALE.extendedOpen);
  }
  const slot = Math.floor(now / m.quoteEveryMs);
  const cached = m.extended.get(instrument.id);
  if (cached?.slot === slot) return cached.read;
  try {
    const answer = await shared(
      m,
      `extended:${instrument.id}`,
      deadline,
      (live) => m.yahoo.within(live).intraday(instrument.sourceSymbol),
    );
    checkAnswer(instrument, answer);
    const read = latestExtended(answer, answer.fetchedAt);
    m.extended.set(instrument.id, {
      slot: Math.floor(answer.fetchedAt / m.quoteEveryMs),
      read,
      points: extendedPoints(answer),
    });
    return read;
  } catch (error) {
    if (error instanceof SourceError && error.phrase === "timed out") {
      return none(STALE.extendedTimeout);
    }
    return none(STALE.extendedFailed);
  }
}

// the last close of each 5 minutes, as the regular session's points are spaced
export function extendedPoints(answer: IntradayAnswer): ExtendedPoint[] {
  if (answer.prePost !== true) return [];
  const { pre, post } = answer.windows;
  const step = 5 * MINUTE_MS;
  const buckets = new Map<number, ExtendedPoint>();
  for (const r of answer.rows) {
    if (r.close === null) continue;
    const session = inside(pre, r.at)
      ? "pre"
      : inside(post, r.at)
        ? "post"
        : null;
    if (session === null) continue;
    const at = r.at - (r.at % step);
    buckets.set(at, { at, session, close: r.close });
  }
  return [...buckets.values()].sort((a, b) => a.at - b.at);
}

// the same read and cache as the extended price, so a chart costs no call more
export async function readExtendedPoints(
  m: Markets,
  instrument: Instrument,
  deadline: number,
): Promise<ExtendedPoint[]> {
  const read = (await readExtended(m, [instrument], deadline)).get(
    instrument.id,
  );
  // refused (open, none, a failure): a cached answer is not this read's
  if (read === undefined || REFUSED.has(read.reason)) return [];
  const cached = m.extended.get(instrument.id);
  const slot = Math.floor(m.clock.now() / m.quoteEveryMs);
  return cached?.slot === slot ? cached.points : [];
}

const REFUSED: ReadonlySet<StaleReason | null> = new Set([
  STALE.extendedOpen,
  STALE.extendedNone,
  STALE.extendedUnreported,
  STALE.extendedTimeout,
  STALE.extendedFailed,
]);

const EXPIRED = Symbol("expired");

// a listing past the deadline answers null and holds up no other
export async function readExtended(
  m: Markets,
  instruments: readonly Instrument[],
  deadline: number,
): Promise<Map<string, ExtendedRead>> {
  let cancel = () => {};
  const expired = new Promise<typeof EXPIRED>((resolve) => {
    cancel = m.clock.at(deadline, () => resolve(EXPIRED));
  });
  try {
    const reads = await Promise.all(
      instruments.map(async (i) => {
        const done = await Promise.race([readOne(m, i, deadline), expired]);
        return [i.id, done === EXPIRED ? none(STALE.extendedTimeout) : done];
      }),
    );
    return new Map(reads as [string, ExtendedRead][]);
  } finally {
    cancel();
  }
}
