// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// What every read shares: the symbols a caller names resolved to stored
// instruments, never by a guess, and fetched inside the call when the
// server has no bars for one or no job kept it, all within one deadline.
// Every instrument answered counts as read, which is what tracks it.

import { dailyRange } from "../bars.ts";
import type { Clock } from "../clock.ts";
import type { Db } from "../db/index.ts";
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
import { QueueClosed, SourceError } from "../source.ts";
import { isTracked, markRead, TRACK_MS } from "../tracking.ts";
import type { Writer } from "../writer.ts";
import { WriterClosed } from "../writer.ts";
import { SOURCE as YAHOO, type Yahoo } from "../yahoo/client.ts";
import { type Candidate, ResolveError, resolve } from "../yahoo/resolve.ts";
import { catchUp, fetchInstrument } from "../yahoo/sync.ts";

// 1ctx's untouched tool timeout is 20 seconds
export const CALL_MS = 15_000;
export const INLINE_FETCH = 5;

type Flight = { promise: Promise<unknown>; deadline: number };

export type Markets = {
  // for reads; every write goes through writer
  db: Db;
  clock: Clock;
  writer: Writer;
  // fail-fast clients: a read never waits out a source's back-off
  yahoo: Yahoo;
  fred: Fred | null;
  trackMs: number;
  // the most symbols one call fetches
  inlineFetch: number;
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
  log: Log;
  trackMs?: number;
  inlineFetch?: number;
  callMs?: number;
}): Markets {
  return {
    db: options.db,
    clock: options.clock,
    writer: options.writer,
    yahoo: options.yahoo.failFast(),
    fred: options.fred?.failFast() ?? null,
    trackMs: options.trackMs ?? TRACK_MS,
    inlineFetch: options.inlineFetch ?? INLINE_FETCH,
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

const timeout = (m: Markets): ItemError => ({
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
function shared<T>(
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

function fredStep(m: Markets, id: string): Step {
  const fred = m.fred;
  if (fred === null) {
    return { kind: "error", error: { error: "no_data", message: NO_DATA } };
  }
  const ctx = { db: m.db, clock: m.clock, writer: m.writer, fred };
  const stored = readInstrument(m.db, id);
  if (stored !== null && hasBars(m.db, id)) {
    if (isTracked(m.db, id, m.clock.now(), m.trackMs)) {
      return { kind: "ready", instrument: stored };
    }
    return {
      kind: "fetch",
      key: id,
      run: async () => {
        await refetchSeries(ctx, stored);
        return stored;
      },
    };
  }
  return {
    kind: "fetch",
    key: id,
    run: async (live) => {
      const added = await addSeries(ctx, id, live);
      if (added.kind === "off") throw new Refused(NO_DATA);
      return added.instrument;
    },
  };
}

function storedStep(m: Markets, instrument: Instrument): Step {
  if (instrument.source === FRED) return fredStep(m, instrument.id);
  if (instrument.source !== YAHOO) return { kind: "ready", instrument };
  const ctx = { db: m.db, clock: m.clock, writer: m.writer, yahoo: m.yahoo };
  if (!hasBars(m.db, instrument.id)) {
    return {
      kind: "fetch",
      key: instrument.id,
      run: (live) =>
        fetchInstrument(ctx, instrument.sourceSymbol, instrument.id, live),
    };
  }
  if (isTracked(m.db, instrument.id, m.clock.now(), m.trackMs)) {
    return { kind: "ready", instrument };
  }
  return {
    kind: "fetch",
    key: instrument.id,
    run: (live) => catchUp(ctx, instrument, live),
  };
}

// A stored key is exact; FRED:<id> is FRED's before anything else; any
// other symbol or name goes through Yahoo's rules, sharing one search
// with any call resolving the same text.
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
  const ctx = { db: m.db, clock: m.clock, yahoo: m.yahoo };
  const r = await shared(m, `resolve:${upper}`, deadline, () =>
    resolve(ctx, given),
  );
  if (r.kind === "known") return storedStep(m, r.instrument);
  if (r.kind === "candidates") {
    return {
      kind: "error",
      error: {
        error: "candidates",
        message: "several listings match; call again with one id",
        candidates: r.candidates.map(candidateItem),
      },
    };
  }
  // stored by another call since the search answered
  const stored = readInstrument(m.db, r.id);
  if (stored !== null) return storedStep(m, stored);
  const yctx = { ...ctx, writer: m.writer };
  return {
    kind: "fetch",
    key: r.id,
    run: (live) => fetchInstrument(yctx, r.sourceSymbol, r.id, live),
  };
}

const EXPIRED = Symbol("expired");

// Each input in order to its instrument or an error, inside the call's
// deadline. Resolution runs first for every input, so the inputs that
// need a fetch take the call's budget in order; past it they answer
// timeout, as the deadline does. A fetch that misses the deadline
// stores nothing new.
export async function readTargets(
  m: Markets,
  inputs: readonly string[],
): Promise<Target[]> {
  const deadline = m.clock.now() + m.callMs;
  let cancel = () => {};
  const expired = new Promise<typeof EXPIRED>((resolve) => {
    cancel = m.clock.at(deadline, () => resolve(EXPIRED));
  });
  try {
    const steps = await Promise.all(
      inputs.map((input) =>
        Promise.race([
          step(m, input, deadline).catch(
            (error: unknown): Step => ({
              kind: "error",
              error: itemError(m, error),
            }),
          ),
          expired,
        ]),
      ),
    );
    const planned = new Set<string>();
    const targets = await Promise.all(
      steps.map(async (s, k): Promise<Target> => {
        const input = inputs[k]!;
        if (s === EXPIRED) return { input, error: timeout(m) };
        if (s.kind === "ready") return { input, instrument: s.instrument };
        if (s.kind === "error") return { input, error: s.error };
        if (!planned.has(s.key)) {
          if (planned.size >= m.inlineFetch) {
            return {
              input,
              error: {
                error: "timeout",
                message: `not fetched: at most ${m.inlineFetch} new symbols a call; ${RETRY}`,
              },
            };
          }
          planned.add(s.key);
        }
        const fetched = shared(m, `fetch:${s.key}`, deadline, s.run).then(
          (instrument): Target => ({ input, instrument }),
          (error: unknown): Target => ({ input, error: itemError(m, error) }),
        );
        const done = await Promise.race([fetched, expired]);
        return done === EXPIRED ? { input, error: timeout(m) } : done;
      }),
    );
    const ids = targets.flatMap((t) =>
      "instrument" in t ? [t.instrument.id] : [],
    );
    if (ids.length > 0) {
      await m.writer.write((db) => markRead(db, ids, m.clock.now()));
    }
    return targets;
  } finally {
    cancel();
  }
}
