// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// Every instrument a read answers counts as read, which is what tracks it.

import { dailyRange } from "../market/bars.ts";
import {
  type Instrument,
  readBySourceSymbol,
  readInstrument,
} from "../market/instruments.ts";
import { JOBS } from "../market/stale.ts";
import { isKept, markRead } from "../market/tracking.ts";
import { errorFields } from "../runtime/log.ts";
import type { Bvb } from "../sources/bvb/client.ts";
import { readByFeedSymbol, resolveBoth } from "../sources/bvb/resolve.ts";
import {
  NO_DATA as BVB_NO_DATA,
  catchUp as bvbCatchUp,
  fetchInstrument as bvbFetchInstrument,
  keyOf as bvbKey,
} from "../sources/bvb/sync.ts";
import {
  addSeries,
  NO_DATA,
  refetchSeries,
  seriesId,
} from "../sources/fred/sync.ts";
import { BVB, BVB_MARKET, FRED, FRED_MARKET, YAHOO } from "../sources/ids.ts";
import {
  Paused,
  QueueClosed,
  Refused,
  SourceError,
} from "../sources/source.ts";
import {
  type Candidate,
  ResolveError,
  resolve,
} from "../sources/yahoo/resolve.ts";
import { catchUp, fetchInstrument } from "../sources/yahoo/sync.ts";
import type { Db } from "../storage/db/index.ts";
import { endRun, startRun } from "../storage/runs.ts";
import { WriterClosed } from "../storage/writer.ts";
import { type Markets, shared } from "./markets.ts";

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

export type ErrorItem = { input: string } & ItemError;

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

// anything but these fixed messages is logged and answered as a source error
export function itemError(m: Markets, error: unknown): ItemError {
  if (error instanceof ResolveError) {
    return { error: "not_found", message: "no listing found; try search" };
  }
  if (error instanceof Refused) {
    return { error: "refused", message: error.message };
  }
  // refused before it was asked, so the phrase is another call's
  if (error instanceof Paused && error.phrase !== "rate limited") {
    return {
      error: "source_error",
      message: `the source is backing off after ${error.phrase}; ${RETRY} later`,
    };
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

const hasBars = (db: Db, id: string) => dailyRange(db, id) !== null;

// past the deadline, nothing new is asked for an answer no caller waits on
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
    if (isKept(m.db, id, m.clock.now(), m.tracking)) {
      return { kind: "ready", instrument: stored };
    }
    return {
      kind: "fetch",
      key: id,
      run: async (live) => {
        const at = m.clock.now();
        const written = await refetchSeries(ctx(live), stored, live);
        // as the series pass: the run ends, so the series is not due again
        await m.writer.write((db) => {
          const now = m.clock.now();
          endRun(db, startRun(db, FRED, JOBS.bars, at, id), now, written.rows);
          m.rules.evaluate(db, [id], now);
        });
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

// a Bucharest index or bond is feed-only: no data while the feed is off
function bvbStep(m: Markets, instrument: Instrument): Step {
  const bvb = m.bvb;
  if (bvb === null) return noBvb;
  if (!hasBars(m.db, instrument.id)) {
    return bvbFetchStep(m, instrument.sourceSymbol, instrument.id);
  }
  if (isKept(m.db, instrument.id, m.clock.now(), m.tracking)) {
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
  if (isKept(m.db, instrument.id, m.clock.now(), m.tracking)) {
    return { kind: "ready", instrument };
  }
  return {
    kind: "fetch",
    key: instrument.id,
    run: (live) => catchUp(yahooCtx(m, live), instrument, live),
  };
}

// a stored key is exact, never a guess; one search serves every call on a text
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

// the instrument step() finds stored for an input, asking no source;
// null when only a source can answer
export function storedInstrument(
  db: Db,
  input: string,
  bvb: boolean,
): Instrument | null {
  const given = input.trim();
  const upper = given.toUpperCase();
  if (upper.includes(":")) return readInstrument(db, upper);
  if (!bvb) return readBySourceSymbol(db, YAHOO, upper);
  const stored = [
    readByFeedSymbol(db, given),
    readBySourceSymbol(db, YAHOO, upper),
  ].filter((i) => i !== null);
  return stored.length === 1 ? stored[0]! : null;
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
export function readTargets(
  m: Markets,
  inputs: readonly string[],
  deadline = m.clock.now() + m.callMs,
): Promise<Target[]> {
  return resolveAll(m, inputs, deadline, true);
}

// as a read resolves, fetching what is new, but no read is marked
export function resolveTargets(
  m: Markets,
  inputs: readonly string[],
  deadline = m.clock.now() + m.callMs,
): Promise<Target[]> {
  return resolveAll(m, inputs, deadline, false);
}

async function resolveAll(
  m: Markets,
  inputs: readonly string[],
  deadline: number,
  read: boolean,
): Promise<Target[]> {
  let cancel = () => {};
  const expired = new Promise<typeof EXPIRED>((resolve) => {
    cancel = m.clock.at(deadline, () => resolve(EXPIRED));
  });
  // a second input naming a fetched instrument would catch it up again
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
      (instrument): Target => {
        // a landed fetch catches it up, whoever asked
        m.tracking.owed.delete(instrument.id);
        return { input, instrument };
      },
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
    if (read && ids.length > 0) {
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
