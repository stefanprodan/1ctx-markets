// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// The context every read takes, so no read imports another for it.

import type { StaleReason } from "../market/stale.ts";
import { BY_USE, type Tracking } from "../market/tracking.ts";
import { NO_RULES, type RuleHooks } from "../rules/hooks.ts";
import { type Clock, MINUTE_MS } from "../runtime/clock.ts";
import { DEFAULT_QUOTE_EVERY } from "../runtime/config.ts";
import type { Log } from "../runtime/log.ts";
import type { Bvb } from "../sources/bvb/client.ts";
import type { Edgar } from "../sources/edgar/client.ts";
import type { Finnhub } from "../sources/finnhub/client.ts";
import { type Hooks, NO_HOOKS } from "../sources/finnhub/store.ts";
import type { Fred } from "../sources/fred/client.ts";
import type { Massive } from "../sources/massive/client.ts";
import type { Yahoo } from "../sources/yahoo/client.ts";
import type { Db } from "../storage/db/index.ts";
import type { Writer } from "../storage/writer.ts";

// 1ctx's untouched tool timeout is 20 seconds
export const CALL_MS = 15_000;

type Flight = { promise: Promise<unknown>; deadline: number };

export type Markets = {
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
  edgar: Edgar | null;
  hooks: Hooks;
  rules: RuleHooks;
  tracking: Tracking;
  // so a quote the job fell behind on reads stale
  quoteEveryMs: number;
  callMs: number;
  log: Log;
  // fetches in flight, shared by every call naming the same instrument
  inflight: Map<string, Flight>;
  extended: ExtendedCache;
  // REST's rule: a bare symbol is Yahoo's listing, the feed's only when
  // Yahoo has none; MCP answers both as candidates
  yahooFirst: boolean;
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
  edgar?: Edgar | null;
  hooks?: Hooks;
  rules?: RuleHooks;
  log: Log;
  tracking?: Tracking;
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
    edgar: options.edgar?.failFast() ?? null,
    hooks: options.hooks ?? NO_HOOKS,
    rules: options.rules ?? NO_RULES,
    tracking: options.tracking ?? BY_USE,
    quoteEveryMs: options.quoteEveryMs ?? DEFAULT_QUOTE_EVERY * MINUTE_MS,
    callMs: options.callMs ?? CALL_MS,
    log: options.log,
    inflight: new Map(),
    extended: new Map(),
    yahooFirst: false,
  };
}

export type Extended = {
  session: "pre" | "post";
  price: number | null;
  // from the regular close
  change: number | null;
  change_percent: number | null;
  time: string | null;
};

export type ExtendedRead =
  | { extended: Extended; reason: null }
  | { extended: null; reason: StaleReason };

// by instrument id, for the quote period it was fetched in
export type ExtendedPoint = {
  at: number;
  session: "pre" | "post";
  close: number;
};

export type ExtendedCache = Map<
  string,
  { slot: number; read: ExtendedRead; points: ExtendedPoint[] }
>;

// a joining caller extends the write's deadline, so it lands while anyone waits
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
