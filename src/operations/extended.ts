// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Never stored: signals, movers, screen and rules stay on the regular session.

import { CRYPTO, isQuoted, readSession } from "../market/calendars.ts";
import { iso, price, round } from "../market/format.ts";
import type { Instrument } from "../market/instruments.ts";
import { STALE, type StaleReason } from "../market/stale.ts";
import { MINUTE_MS } from "../runtime/clock.ts";
import { YAHOO } from "../sources/ids.ts";
import { SourceError } from "../sources/source.ts";
import type { IntradayAnswer, Window } from "../sources/yahoo/client.ts";
import { type ExtendedRead, type Markets, shared } from "./markets.ts";

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
    const read = latestExtended(answer, answer.fetchedAt);
    m.extended.set(instrument.id, {
      slot: Math.floor(answer.fetchedAt / m.quoteEveryMs),
      read,
    });
    return read;
  } catch (error) {
    if (error instanceof SourceError && error.phrase === "timed out") {
      return none(STALE.extendedTimeout);
    }
    return none(STALE.extendedFailed);
  }
}

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
