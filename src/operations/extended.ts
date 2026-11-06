// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// Never stored: signals, movers, screen and rules stay on the regular session.

import { CRYPTO, isQuoted, readSession } from "../market/calendars.ts";
import { iso, price, round } from "../market/format.ts";
import type { Instrument } from "../market/instruments.ts";
import { EXTENDED, type ExtendedReason } from "../market/stale.ts";
import { fromWallTime, wallTime } from "../market/zone.ts";
import { DAY_MS, MINUTE_MS } from "../runtime/clock.ts";
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

const HOUR_MS = 60 * MINUTE_MS;

const none = (
  reason: ExtendedReason,
  opens: string | null = null,
): ExtendedRead => ({
  extended: null,
  reason,
  opens,
});

function nextStart(windows: readonly Window[], now: number): number | null {
  let at: number | null = null;
  for (const w of windows) {
    if (w.start > now && (at === null || w.start < at)) at = w.start;
  }
  return at;
}

// Yahoo names the next session from its pre window's start, indexes included
export function nextOpen(answer: IntradayAnswer, now: number): string | null {
  const at = nextStart(answer.windows.regular, now);
  return at === null ? null : iso(at);
}

const inside = (windows: readonly Window[], at: number) =>
  windows.some((w) => at >= w.start && at < w.end);

// kept through the night: an evening move is the newest price before the open
export function latestExtended(
  answer: IntradayAnswer,
  now: number,
): ExtendedRead {
  const opens = nextOpen(answer, now);
  if (answer.prePost !== true) return none(EXTENDED.none, opens);
  const { pre, regular, post } = answer.windows;
  if (inside(regular, now)) return none(EXTENDED.open);
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
      opens,
    };
  }
  return none(EXTENDED.noPrice, opens);
}

// Yahoo names the next session only once its pre window starts, so an answer
// read after every window it holds cannot change before the next pre start
export function heldUntil(answer: IntradayAnswer, periodMs: number): number {
  const now = answer.fetchedAt;
  const periodEnd = (Math.floor(now / periodMs) + 1) * periodMs;
  const { pre, regular, post } = answer.windows;
  if (pre.length === 0) return periodEnd;
  // without pre or post bars only the next open can change, and once named
  // it holds until it starts
  const flat = answer.prePost !== true;
  const open = flat ? nextStart(regular, now) : null;
  if (open !== null) return open;
  const all = flat ? regular : [...pre, ...regular, ...post];
  // a window's last minute bar can land after its end
  if (all.some((w) => w.end + periodMs > now)) return periodEnd;
  const newest = pre.reduce((a, w) => (w.start > a.start ? w : a));
  const { last, next } = preStarts(answer.session.zone, newest.start, now);
  if (last === newest.start) return next;
  // an empty pre window names the session only at its open
  if (flat && pre.every((w) => w.end === w.start)) return next;
  // a pre start passed with no new day: a weekend, a holiday or a late rollover
  if (!flat && now < last + (newest.end - newest.start)) return periodEnd;
  return Math.min(next, now + HOUR_MS);
}

// whole days at the same wall time, so a clock change keeps the local hour
export function preStarts(
  zone: string,
  start: number,
  now: number,
): { last: number; next: number } {
  let last = start;
  let next = start;
  let wall = wallTime(zone, start);
  while (next <= now) {
    last = next;
    wall += DAY_MS;
    next = fromWallTime(zone, wall);
  }
  return { last, next };
}

// a listing known to lack pre and post trading answers none whatever its
// chart does
const unread = (m: Markets, instrument: Instrument, reason: ExtendedReason) =>
  none(
    m.yahoo.prePost(instrument.sourceSymbol) === false ? EXTENDED.none : reason,
  );

// a listing with no pre or post trading still asks its chart, for its next open
async function readOne(
  m: Markets,
  instrument: Instrument,
  deadline: number,
): Promise<ExtendedRead> {
  if (instrument.source !== YAHOO) return none(EXTENDED.unreported);
  if (instrument.market === CRYPTO) return none(EXTENDED.none);
  const now = m.clock.now();
  if (isQuoted(instrument.market, readSession(m.db, instrument.market), now)) {
    return unread(m, instrument, EXTENDED.open);
  }
  const cached = m.extended.get(instrument.id);
  if (cached !== undefined && now < cached.until) return cached.read;
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
      until: heldUntil(answer, m.quoteEveryMs),
      read,
      points: extendedPoints(answer),
    });
    return read;
  } catch (error) {
    if (error instanceof SourceError && error.phrase === "timed out") {
      return unread(m, instrument, EXTENDED.timeout);
    }
    return unread(m, instrument, EXTENDED.failed);
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
): Promise<ExtendedPoints> {
  const read = (await readExtended(m, [instrument], deadline)).get(
    instrument.id,
  )!;
  // refused (open, none, a failure): a cached answer is not this read's
  if (REFUSED.has(read.reason)) return { points: [], reason: read.reason };
  const cached = m.extended.get(instrument.id);
  return {
    points:
      cached !== undefined && m.clock.now() < cached.until ? cached.points : [],
    reason: read.reason,
  };
}

export type ExtendedPoints = {
  points: ExtendedPoint[];
  reason: ExtendedReason | null;
};

const REFUSED: ReadonlySet<ExtendedReason | null> = new Set([
  EXTENDED.open,
  EXTENDED.none,
  EXTENDED.unreported,
  EXTENDED.timeout,
  EXTENDED.failed,
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
        return [i.id, done === EXPIRED ? unread(m, i, EXTENDED.timeout) : done];
      }),
    );
    return new Map(reads as [string, ExtendedRead][]);
  } finally {
    cancel();
  }
}
