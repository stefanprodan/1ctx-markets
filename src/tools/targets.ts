// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// What every read shares: the symbols a caller names resolved to stored
// instruments, never by a guess, and fetched inside the call when the
// server has no bars for one or no job kept it, all within one deadline.
// Every instrument answered counts as read, which is what tracks it.

import { dailyRange } from "../bars.ts";
import {
  SOURCE as BVB,
  MARKET as BVB_MARKET,
  type Bvb,
} from "../bvb/client.ts";
import { resolveBoth } from "../bvb/resolve.ts";
import {
  NO_DATA as BVB_NO_DATA,
  catchUp as bvbCatchUp,
  fetchInstrument as bvbFetchInstrument,
  keyOf as bvbKey,
} from "../bvb/sync.ts";
import { type Clock, MINUTE_MS } from "../clock.ts";
import { DEFAULT_QUOTE_EVERY } from "../config.ts";
import type { Db } from "../db/index.ts";
import type { Finnhub } from "../finnhub/client.ts";
import { type Hooks, NO_HOOKS } from "../finnhub/store.ts";
import { SOURCE as FRED, type Fred } from "../fred/client.ts";
import {
  addSeries,
  MARKET as FRED_MARKET,
  NO_DATA,
  Refused,
  refetchSeries,
  seriesId,
} from "../fred/sync.ts";
import { type Instrument, readInstrument } from "../instruments.ts";
import { errorFields, type Log } from "../log.ts";
import type { Massive } from "../massive/client.ts";
import { NO_RULES, type RuleHooks } from "../rules/hooks.ts";
import { QueueClosed, SourceError } from "../source.ts";
import { isTracked, markRead, TRACK_MS } from "../tracking.ts";
import type { Writer } from "../writer.ts";
import { WriterClosed } from "../writer.ts";
import { SOURCE as YAHOO, type Yahoo } from "../yahoo/client.ts";
import { type Candidate, ResolveError, resolve } from "../yahoo/resolve.ts";
import { catchUp, fetchInstrument } from "../yahoo/sync.ts";

// 1ctx's untouched tool timeout is 20 seconds
export const CALL_MS = 15_000;

type Flight = { promise: Promise<unknown>; deadline: number };

export type Markets = {
  // for reads; every write goes through writer
  db: Db;
  clock: Clock;
  writer: Writer;
  // fail-fast clients: a read never waits out a source's back-off
  yahoo: Yahoo;
  fred: Fred | null;
  // null while the Bucharest feed is off
  bvb: Bvb | null;
  finnhub: Finnhub | null;
  massive: Massive | null;
  // what rules hand the research reads
  hooks: Hooks;
  // told of every write a read's fetch makes
  rules: RuleHooks;
  trackMs: number;
  // how often the quote job runs, so a quote it fell behind on is stale
  quoteEveryMs: number;
  callMs: number;
  log: Log;
  // fetches in flight, shared by every call naming the same instrument
  inflight: Map<string, Flight>;
};

export function markets(options: {
  db: Db;
  clock: Clock;
  writer: Writer;
  yahoo: Yahoo;
  fred: Fred | null;
  bvb?: Bvb | null;
  finnhub?: Finnhub | null;
  massive?: Massive | null;
  hooks?: Hooks;
  rules?: RuleHooks;
  log: Log;
  trackMs?: number;
  quoteEveryMs?: number;
  callMs?: number;
}): Markets {
  return {
    db: options.db,
    clock: options.clock,
    writer: options.writer,
    yahoo: options.yahoo.failFast(),
    fred: options.fred?.failFast() ?? null,
    bvb: options.bvb?.failFast() ?? null,
    finnhub: options.finnhub?.failFast() ?? null,
    massive: options.massive?.failFast() ?? null,
    hooks: options.hooks ?? NO_HOOKS,
    rules: options.rules ?? NO_RULES,
    trackMs: options.trackMs ?? TRACK_MS,
    quoteEveryMs: options.quoteEveryMs ?? DEFAULT_QUOTE_EVERY * MINUTE_MS,
    callMs: options.callMs ?? CALL_MS,
    log: options.log,
    inflight: new Map(),
  };
}

export const ERRORS = [
  "candidates",
  "not_found",
  "timeout",
  "rate_limited",
  "source_error",
  "no_data",
  "refused",
] as const;

export type CandidateItem = {
  id: string;
  name: string | null;
  type: string | null;
  exchange: string;
  source_symbol: string;
};

export type ItemError = {
  error: (typeof ERRORS)[number];
  message: string;
  candidates?: CandidateItem[];
};

export type Target =
  | { input: string; instrument: Instrument }
  | { input: string; error: ItemError };

export const RETRY = "retry this symbol";

export const timeout = (m: Markets): ItemError => ({
  error: "timeout",
  message: `not done within ${m.callMs / 1000} seconds; ${RETRY}`,
});

export const candidateItem = (c: Candidate): CandidateItem => ({
  id: c.id,
  name: c.name,
  type: c.type,
  exchange: c.exchange,
  source_symbol: c.sourceSymbol,
});

// errors a caller can act on, each a fixed message; anything else is
// logged and answered as a source error
export function itemError(m: Markets, error: unknown): ItemError {
  if (error instanceof ResolveError) {
    return { error: "not_found", message: "no listing found; try search" };
  }
  if (error instanceof Refused) {
    return { error: "refused", message: error.message };
  }
  if (error instanceof SourceError) {
    switch (error.phrase) {
      case "not found":
        return { error: "not_found", message: "the source has no such symbol" };
      case "bad request":
        return { error: "not_found", message: "not a symbol the source takes" };
      case "rate limited":
        return {
          error: "rate_limited",
          message: `rate limited by the source; ${RETRY} later`,
        };
      case "timed out":
        return timeout(m);
      default:
        return {
          error: "source_error",
          message: `${error.phrase}; ${RETRY} later`,
        };
    }
  }
  if (error instanceof QueueClosed || error instanceof WriterClosed) {
    return { error: "source_error", message: "the server is stopping" };
  }
  m.log.error("read failed", errorFields(error));
  return { error: "source_error", message: `failed; ${RETRY} later` };
}

type Step =
  | { kind: "ready"; instrument: Instrument }
  | {
      kind: "fetch";
      key: string;
      run: (live: () => boolean) => Promise<Instrument>;
    }
  | { kind: "error"; error: ItemError };

// One promise per key while it runs; a caller joining later extends the
// deadline its write is held to, so a fetch lands while anyone waits.
export function shared<T>(
  m: Markets,
  key: string,
  deadline: number,
  run: (live: () => boolean) => Promise<T>,
): Promise<T> {
  const running = m.inflight.get(key);
  if (running !== undefined) {
    running.deadline = Math.max(running.deadline, deadline);
    return running.promise as Promise<T>;
  }
  const flight: Flight = { promise: Promise.resolve(), deadline };
  const live = () => m.clock.now() < flight.deadline;
  const promise = Promise.resolve()
    .then(() => run(live))
    .finally(() => {
      if (m.inflight.get(key) === flight) m.inflight.delete(key);
    });
  flight.promise = promise;
  m.inflight.set(key, flight);
  return promise;
}

const hasBars = (db: Db, id: string) => dailyRange(db, id) !== null;

// The source clients a fetch uses, refusing any call once its deadline
// passed, so nothing new is asked for an answer no caller waits on.
const yahooCtx = (m: Markets, live: () => boolean) => ({
  db: m.db,
  clock: m.clock,
  writer: m.writer,
  yahoo: m.yahoo.within(live),
  rules: m.rules,
});

function fredStep(m: Markets, id: string): Step {
  const fred = m.fred;
  if (fred === null) {
    return { kind: "error", error: { error: "no_data", message: NO_DATA } };
  }
  const ctx = (live: () => boolean) => ({
    db: m.db,
    clock: m.clock,
    writer: m.writer,
    fred: fred.within(live),
    rules: m.rules,
  });
  const stored = readInstrument(m.db, id);
  if (stored !== null && hasBars(m.db, id)) {
    if (isTracked(m.db, id, m.clock.now(), m.trackMs)) {
      return { kind: "ready", instrument: stored };
    }
    return {
      kind: "fetch",
      key: id,
      run: async (live) => {
        await refetchSeries(ctx(live), stored, live);
        return stored;
      },
    };
  }
  return {
    kind: "fetch",
    key: id,
    run: async (live) => {
      const added = await addSeries(ctx(live), id, live);
      if (added.kind === "off") throw new Refused(NO_DATA);
      return added.instrument;
    },
  };
}

const bvbCtx = (m: Markets, bvb: Bvb, live: () => boolean) => ({
  db: m.db,
  clock: m.clock,
  writer: m.writer,
  bvb: bvb.within(live),
  rules: m.rules,
});

const noBvb: Step = {
  kind: "error",
  error: { error: "no_data", message: BVB_NO_DATA },
};

function bvbFetchStep(m: Markets, symbol: string, id: string): Step {
  const bvb = m.bvb;
  if (bvb === null) return noBvb;
  return {
    kind: "fetch",
    key: id,
    run: (live) => bvbFetchInstrument(bvbCtx(m, bvb, live), symbol, id, live),
  };
}

// a Bucharest index or bond exists only on the feed, so it has no data
// while the feed is off
function bvbStep(m: Markets, instrument: Instrument): Step {
  const bvb = m.bvb;
  if (bvb === null) return noBvb;
  if (!hasBars(m.db, instrument.id)) {
    return bvbFetchStep(m, instrument.sourceSymbol, instrument.id);
  }
  if (isTracked(m.db, instrument.id, m.clock.now(), m.trackMs)) {
    return { kind: "ready", instrument };
  }
  return {
    kind: "fetch",
    key: instrument.id,
    run: (live) => bvbCatchUp(bvbCtx(m, bvb, live), instrument, live),
  };
}

function storedStep(m: Markets, instrument: Instrument): Step {
  if (instrument.source === FRED) return fredStep(m, instrument.id);
  if (instrument.source === BVB) return bvbStep(m, instrument);
  if (instrument.source !== YAHOO) return { kind: "ready", instrument };
  if (!hasBars(m.db, instrument.id)) {
    return {
      kind: "fetch",
      key: instrument.id,
      run: (live) =>
        fetchInstrument(
          yahooCtx(m, live),
          instrument.sourceSymbol,
          instrument.id,
          live,
        ),
    };
  }
  if (isTracked(m.db, instrument.id, m.clock.now(), m.trackMs)) {
    return { kind: "ready", instrument };
  }
  return {
    kind: "fetch",
    key: instrument.id,
    run: (live) => catchUp(yahooCtx(m, live), instrument, live),
  };
}

// A stored key is exact; FRED:<id> is FRED's before anything else, and
// BVB:<symbol> the feed's while it is on; any other symbol or name goes
// through Yahoo's rules, beside the exchange's own search while the feed
// is on, sharing one search with any call resolving the same text.
async function step(
  m: Markets,
  input: string,
  deadline: number,
): Promise<Step> {
  const given = input.trim();
  const upper = given.toUpperCase();
  if (upper.includes(":")) {
    const stored = readInstrument(m.db, upper);
    if (stored !== null) return storedStep(m, stored);
  }
  if (upper.startsWith(`${FRED_MARKET}:`)) {
    return fredStep(m, `${FRED_MARKET}:${seriesId(upper)}`);
  }
  const bvb = m.bvb;
  if (upper.startsWith(`${BVB_MARKET}:`) && bvb !== null) {
    // the symbol as written: the exchange writes some in mixed case
    const symbol = given.slice(BVB_MARKET.length + 1).trim();
    return bvbFetchStep(m, symbol, bvbKey(symbol));
  }
  if (!upper.includes(":") && bvb !== null) {
    const both = await shared(m, `resolve:${upper}`, deadline, (live) =>
      resolveBoth({ ...yahooCtx(m, live), bvb: bvb.within(live) }, given),
    );
    if (both.kind === "known") return storedStep(m, both.instrument);
    if (both.kind === "candidates") return candidates(both.candidates);
    const stored = readInstrument(m.db, both.id);
    if (stored !== null) return storedStep(m, stored);
    if (both.source === BVB) return bvbFetchStep(m, both.sourceSymbol, both.id);
    return {
      kind: "fetch",
      key: both.id,
      run: (live) =>
        fetchInstrument(yahooCtx(m, live), both.sourceSymbol, both.id, live),
    };
  }
  let r: Awaited<ReturnType<typeof resolve>>;
  try {
    r = await shared(m, `resolve:${upper}`, deadline, (live) =>
      resolve(yahooCtx(m, live), given),
    );
  } catch (error) {
    // Yahoo carries Bucharest shares only: the rest is on the feed
    if (error instanceof ResolveError && upper.startsWith(`${BVB_MARKET}:`)) {
      return noBvb;
    }
    throw error;
  }
  if (r.kind === "known") return storedStep(m, r.instrument);
  if (r.kind === "candidates") return candidates(r.candidates);
  // stored by another call since the search answered
  const stored = readInstrument(m.db, r.id);
  if (stored !== null) return storedStep(m, stored);
  return {
    kind: "fetch",
    key: r.id,
    run: (live) =>
      fetchInstrument(yahooCtx(m, live), r.sourceSymbol, r.id, live),
  };
}

const candidates = (list: readonly Candidate[]): Step => ({
  kind: "error",
  error: {
    error: "candidates",
    message: "several listings match; call again with one id",
    candidates: list.map(candidateItem),
  },
});

const EXPIRED = Symbol("expired");

// each input resolves on its own under one deadline; the queue paces fetches
export async function readTargets(
  m: Markets,
  inputs: readonly string[],
): Promise<Target[]> {
  const deadline = m.clock.now() + m.callMs;
  let cancel = () => {};
  const expired = new Promise<typeof EXPIRED>((resolve) => {
    cancel = m.clock.at(deadline, () => resolve(EXPIRED));
  });
  // a fetch this call already made, by instrument: a second input
  // naming it, resolved after the first landed, finds it stored yet not
  // read, and would catch it up again
  const fetches = new Map<string, Promise<Instrument>>();
  const one = async (input: string): Promise<Target> => {
    const s = await step(m, input, deadline).catch(
      (error: unknown): Step => ({ kind: "error", error: itemError(m, error) }),
    );
    if (s.kind === "ready") return { input, instrument: s.instrument };
    if (s.kind === "error") return { input, error: s.error };
    if (m.clock.now() >= deadline) return { input, error: timeout(m) };
    let fetched = fetches.get(s.key);
    if (fetched === undefined) {
      fetched = shared(m, `fetch:${s.key}`, deadline, s.run);
      fetches.set(s.key, fetched);
    }
    return fetched.then(
      (instrument): Target => ({ input, instrument }),
      (error: unknown): Target => ({ input, error: itemError(m, error) }),
    );
  };
  try {
    const targets = await Promise.all(
      inputs.map(async (input): Promise<Target> => {
        const done = await Promise.race([one(input), expired]);
        return done === EXPIRED ? { input, error: timeout(m) } : done;
      }),
    );
    const ids = targets.flatMap((t) =>
      "instrument" in t ? [t.instrument.id] : [],
    );
    if (ids.length > 0) {
      // queued behind other writes, it waits no longer than the call
      const wrote = m.writer
        .write((db) => {
          if (m.clock.now() < deadline) markRead(db, ids, m.clock.now());
        })
        .catch((error: unknown) => {
          m.log.error("tracking failed", errorFields(error));
        });
      await Promise.race([wrote, expired]);
    }
    return targets;
  } finally {
    cancel();
  }
}
