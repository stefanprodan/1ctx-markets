// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// Never stored: signals, movers, screen and rules stay on the regular session.

import { CRYPTO, isQuoted, readSession } from "../market/calendars.ts";
import { iso, price, round } from "../market/format.ts";
import { type Instrument, readIsin } from "../market/instruments.ts";
import { readQuote } from "../market/quotes.ts";
import { EXTENDED, type ExtendedReason } from "../market/stale.ts";
import { fromWallTime, localDate, wallTime } from "../market/zone.ts";
import { DAY_MS, MINUTE_MS } from "../runtime/clock.ts";
import { XETRA_MARKET, YAHOO } from "../sources/ids.ts";
import { SourceError } from "../sources/source.ts";
import {
  CLOSES_AT,
  HELD_MS,
  OPENS_AT,
  CURRENCY as TRADEGATE_CURRENCY,
  type TradegateQuote,
  ZONE,
} from "../sources/tradegate/client.ts";
import type { IntradayAnswer, Window } from "../sources/yahoo/client.ts";
import { checkAnswer } from "../sources/yahoo/history.ts";
import {
  type ExtendedCache,
  type ExtendedHours,
  type ExtendedPoint,
  type ExtendedRead,
  type Markets,
  shared,
  type TradegateSession,
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
        source: YAHOO,
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

// the day's pre-market cannot change once its regular session trades, but
// its last minute bar can land after the open
export function heldOpen(answer: IntradayAnswer, periodMs: number): number {
  const now = answer.fetchedAt;
  const w = answer.windows.regular.find((x) => now >= x.start && now < x.end);
  if (w === undefined || now < w.start + periodMs) {
    return heldUntil(answer, periodMs);
  }
  return w.end;
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
  whileOpen: boolean,
): Promise<ExtendedRead> {
  if (instrument.source !== YAHOO) return none(EXTENDED.unreported);
  if (instrument.market === CRYPTO) return none(EXTENDED.none);
  const now = m.clock.now();
  const open = isQuoted(
    instrument.market,
    readSession(m.db, instrument.market),
    now,
  );
  if (open && !whileOpen) return unread(m, instrument, EXTENDED.open);
  if (open && m.yahoo.prePost(instrument.sourceSymbol) === false) {
    return none(EXTENDED.none);
  }
  try {
    return (await chartRead(m, instrument, deadline, open)).read;
  } catch (error) {
    if (error instanceof SourceError && error.phrase === "timed out") {
      return unread(m, instrument, EXTENDED.timeout);
    }
    return unread(m, instrument, EXTENDED.failed);
  }
}

type ChartRead = ExtendedCache extends Map<string, infer V> ? V : never;

// the chart's read, held for its period; a failure is never kept
async function chartRead(
  m: Markets,
  instrument: Instrument,
  deadline: number,
  open: boolean,
): Promise<ChartRead> {
  const cached = m.extended.get(instrument.id);
  if (cached !== undefined && m.clock.now() < cached.until) return cached;
  const answer = await shared(
    m,
    `extended:${instrument.id}`,
    deadline,
    (live) => m.yahoo.within(live).intraday(instrument.sourceSymbol),
  );
  checkAnswer(instrument, answer);
  const read: ChartRead = {
    until: open
      ? heldOpen(answer, m.quoteEveryMs)
      : heldUntil(answer, m.quoteEveryMs),
    read: latestExtended(answer, answer.fetchedAt),
    points: extendedPoints(answer),
    hours: extendedHours(answer),
    days: answer.windows.regular,
  };
  m.extended.set(instrument.id, read);
  return read;
}

// a quote's Xetra listing: undefined for any other, null without an ISIN
function tradegateIsin(
  m: Markets,
  instrument: Instrument,
): string | null | undefined {
  if (
    m.tradegate === null ||
    instrument.source !== YAHOO ||
    instrument.market !== XETRA_MARKET
  ) {
    return undefined;
  }
  return readIsin(m.db, instrument.id);
}

// Tradegate trades from 07:30 to 22:00 Berlin on a day Xetra trades; the
// day's Xetra session splits that into pre, regular and post
export function tradegateSession(
  now: number,
  days: readonly Window[],
): TradegateSession {
  const wall = wallTime(ZONE, now);
  const day = Math.floor(wall / DAY_MS) * DAY_MS;
  if (wall - day < OPENS_AT || wall - day >= CLOSES_AT) return "closed";
  const today = days.find(
    (w) => Math.floor(wallTime(ZONE, w.start) / DAY_MS) * DAY_MS === day,
  );
  if (today === undefined) return "closed";
  if (now < today.start) return "pre";
  // a session's end names its last minute, as the stored session's does
  return now < today.end + MINUTE_MS ? "regular" : "post";
}

// a closed quote's values are those of the last 22:00 close on a day
// Xetra traded; null when no day held names one
export function lastTradegateClose(
  now: number,
  days: readonly Window[],
): number | null {
  let last: number | null = null;
  for (const w of days) {
    const day = Math.floor(wallTime(ZONE, w.start) / DAY_MS) * DAY_MS;
    const close = fromWallTime(ZONE, day + CLOSES_AT);
    if (close <= now && (last === null || close > last)) last = close;
  }
  return last;
}

type XetraQuote = {
  price: number | null;
  previousClose: number | null;
  // the trade time, so a late quote still on yesterday is known
  time: number | null;
};

// Yahoo's Xetra quote is late, so until it trades today its price is the
// last close; once it has, the previous close stands until Xetra closes
function xetraBase(
  xetra: XetraQuote | null,
  session: TradegateSession,
  now: number,
): number | null {
  if (xetra === null) return null;
  const today =
    xetra.time !== null && localDate(ZONE, xetra.time) === localDate(ZONE, now);
  if (!today) return xetra.price;
  return session === "pre" || session === "regular"
    ? xetra.previousClose
    : xetra.price;
}

// session and a closed quote's time are read at now, so a held quote
// never says pre after the open
export function tradegateExtended(
  q: TradegateQuote,
  session: TradegateSession,
  xetra: XetraQuote | null,
  days: readonly Window[] = [],
  now: number = q.fetchedAt,
) {
  const base = xetraBase(xetra, session, now);
  const change = base === null ? null : q.last - base;
  return {
    session,
    price: price(q.last),
    change: round(change),
    change_percent:
      change === null || base === 0 ? null : round((change / base!) * 100),
    time: iso(
      session === "closed" ? lastTradegateClose(now, days) : q.fetchedAt,
    ),
    bid: price(q.bid),
    ask: price(q.ask),
    day_high: price(q.high),
    day_low: price(q.low),
    volume: q.volume,
    tradegate_close: price(q.close),
    source: "tradegate" as const,
  };
}

// one call per ISIN in HELD_MS, whoever asks; a failure is never kept
async function tradegateQuote(
  m: Markets,
  isin: string,
  deadline: number,
): Promise<TradegateQuote> {
  const cached = m.tradegateQuotes.get(isin);
  if (cached !== undefined && m.clock.now() < cached.until) {
    return cached.answer;
  }
  const answer = await shared(m, `tradegate:${isin}`, deadline, (live) =>
    m.tradegate!.within(live).quote(isin),
  );
  m.tradegateQuotes.set(isin, {
    until: answer.fetchedAt + HELD_MS,
    answer,
  });
  return answer;
}

// how long Tradegate's answer waits for a chart still in flight
export const CHART_WAIT_MS = 1000;
// kept before the deadline for the answer to return
export const RETURN_MS = 50;

// the chart if it lands within ms, else null: a slow Yahoo never holds
// up Tradegate's answer
function within<T>(m: Markets, p: Promise<T>, ms: number): Promise<T | null> {
  let cancel = () => {};
  const late = new Promise<null>((resolve) => {
    cancel = m.clock.at(m.clock.now() + ms, () => resolve(null));
  });
  return Promise.race([p, late]).finally(() => cancel());
}

// answered in Xetra's regular session too, since Yahoo's Xetra price is
// late; the chart is read only while Xetra is closed, for its day and open
async function readTradegate(
  m: Markets,
  instrument: Instrument,
  isin: string,
  deadline: number,
): Promise<ExtendedRead> {
  // Tradegate prices in EUR: another currency's listing is not its
  if (instrument.currency !== TRADEGATE_CURRENCY) {
    return none(EXTENDED.notListed);
  }
  const stored = readSession(m.db, instrument.market);
  const open = isQuoted(instrument.market, stored, m.clock.now());
  const asked = open
    ? Promise.resolve(null)
    : chartRead(m, instrument, deadline, false).catch(() => null);
  const got = await tradegateQuote(m, isin, deadline).then(
    (quote) => ({ quote }),
    (error: unknown) => ({ error }),
  );
  // the answer must still land before the caller's deadline
  const wait = Math.min(CHART_WAIT_MS, deadline - m.clock.now() - RETURN_MS);
  const fresh = open || wait <= 0 ? null : await within(m, asked, wait);
  // a chart past its period still names the days it held
  const chart =
    fresh ?? (open ? null : (m.extended.get(instrument.id) ?? null));
  const now = m.clock.now();
  const named = chart?.read.opens ?? null;
  const opens =
    open || named === null || Date.parse(named) <= now ? null : named;
  if ("error" in got) {
    const phrase = got.error instanceof SourceError ? got.error.phrase : null;
    return none(
      phrase === "not found"
        ? EXTENDED.notListed
        : phrase === "timed out"
          ? EXTENDED.timeout
          : EXTENDED.failed,
      opens,
    );
  }
  const days = [...(stored === null ? [] : [stored]), ...(chart?.days ?? [])];
  const { quote } = got;
  const session = tradegateSession(now, days);
  return {
    extended: tradegateExtended(
      quote,
      session,
      readQuote(m.db, instrument.id),
      days,
      now,
    ),
    reason: null,
    opens,
  };
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

// each regular window widened by the pre and post windows that touch it, so
// a chart's day can span the hours it may trade
export function extendedHours(answer: IntradayAnswer): ExtendedHours[] {
  if (answer.prePost !== true) return [];
  const { pre, regular, post } = answer.windows;
  const days = new Map<number, ExtendedHours>();
  for (const r of regular) {
    if (r.end <= r.start) continue;
    const before = pre.find((w) => w.end === r.start && w.start < w.end);
    const after = post.find((w) => w.start === r.end && w.start < w.end);
    days.set(r.start, {
      start: before?.start ?? r.start,
      end: after?.end ?? r.end,
    });
  }
  return [...days.values()].sort((a, b) => a.start - b.start);
}

// the same read and cache as the extended price, so a chart costs no call more
// while closed; while open, one read keeps the day's pre-market to the close
export async function readExtendedPoints(
  m: Markets,
  instrument: Instrument,
  deadline: number,
): Promise<ExtendedPoints> {
  const read = (await readExtended(m, [instrument], deadline, true)).get(
    instrument.id,
  )!;
  // refused (none, a failure): a cached answer is not this read's
  if (REFUSED.has(read.reason)) {
    return { points: [], hours: [], reason: read.reason };
  }
  const cached = m.extended.get(instrument.id);
  const held = cached !== undefined && m.clock.now() < cached.until;
  return {
    points: held ? cached.points : [],
    hours: held ? cached.hours : [],
    // read in the session: an empty list is none in the sessions answered
    reason: read.reason === EXTENDED.open ? null : read.reason,
  };
}

export type ExtendedPoints = {
  points: ExtendedPoint[];
  hours: ExtendedHours[];
  reason: ExtendedReason | null;
};

const REFUSED: ReadonlySet<ExtendedReason | null> = new Set([
  EXTENDED.none,
  EXTENDED.unreported,
  EXTENDED.timeout,
  EXTENDED.failed,
]);

const EXPIRED = Symbol("expired");

// a Xetra listing with no ISIN still reads its chart, for its next open
const withoutIsin = (read: ExtendedRead): ExtendedRead => ({
  extended: null,
  reason: EXTENDED.noIsin,
  opens: read.opens,
});

// a quote's Xetra listing reads Tradegate; a chart's points stay Yahoo's
async function readAny(
  m: Markets,
  i: Instrument,
  deadline: number,
  whileOpen: boolean,
): Promise<ExtendedRead> {
  const isin = whileOpen ? undefined : tradegateIsin(m, i);
  if (isin === undefined) return readOne(m, i, deadline, whileOpen);
  if (isin === null) return withoutIsin(await readOne(m, i, deadline, false));
  return readTradegate(m, i, isin, deadline);
}

const late = (m: Markets, i: Instrument, whileOpen: boolean) => {
  const isin = whileOpen ? undefined : tradegateIsin(m, i);
  if (isin === undefined) return unread(m, i, EXTENDED.timeout);
  return isin === null ? none(EXTENDED.noIsin) : none(EXTENDED.timeout);
};

// a listing past the deadline answers null and holds up no other
export async function readExtended(
  m: Markets,
  instruments: readonly Instrument[],
  deadline: number,
  // a chart's points: read in the regular session too, for its pre-market
  whileOpen = false,
): Promise<Map<string, ExtendedRead>> {
  let cancel = () => {};
  const expired = new Promise<typeof EXPIRED>((resolve) => {
    cancel = m.clock.at(deadline, () => resolve(EXPIRED));
  });
  try {
    const reads = await Promise.all(
      instruments.map(async (i) => {
        const done = await Promise.race([
          readAny(m, i, deadline, whileOpen),
          expired,
        ]);
        return [i.id, done === EXPIRED ? late(m, i, whileOpen) : done];
      }),
    );
    return new Map(reads as [string, ExtendedRead][]);
  } finally {
    cancel();
  }
}
