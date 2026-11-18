// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// The open instrument page's quote, refetched between the passes.

import { isQuoted, readSession } from "../../market/calendars.ts";
import type { Instrument } from "../../market/instruments.ts";
import { NO_RULES, type RuleHooks } from "../../rules/hooks.ts";
import { type Clock, MINUTE_MS } from "../../runtime/clock.ts";
import type { Log } from "../../runtime/log.ts";
import type { Db } from "../../storage/db/index.ts";
import type { Writer } from "../../storage/writer.ts";
import { SOURCE, type Yahoo } from "./client.ts";
import { storeQuotes } from "./quotes.ts";

export const FAST_MS = 10_000;
// one call per instrument each FAST_MS: at most 18 a minute beside the pass
export const FAST_CAP = 3;
export const FAST_SPACING_MS = 2_000;
// after a rate limit, so the pass gets Yahoo's calls back first; any
// other back-off pauses it only while it lasts
export const FAST_COOLDOWN_MS = 30 * MINUTE_MS;
// a page's read never waits longer on a busy queue: it answers the stored quote
export const FAST_WAIT_MS = 5_000;
// a page asks every FAST_MS, so a slot not asked for this long is free
export const FAST_HOLD_MS = 3 * FAST_MS;

export type FastQuotes = {
  // whether the instrument refreshes fast; refetches its quote when old
  refresh(instrument: Instrument): Promise<boolean>;
  // its page was left: the place goes to the next at once; a fetch in
  // flight still lands
  release(instrument: Instrument): void;
};

export type FastOptions = {
  db: Db;
  clock: Clock;
  writer: Writer;
  yahoo: Yahoo;
  rules?: RuleHooks;
  log: Log;
};

export function fastQuotes(options: FastOptions): FastQuotes {
  const { db, clock, writer, log, yahoo } = options;
  const rules = options.rules ?? NO_RULES;
  // by instrument id, when its page last asked
  const held = new Map<string, number>();
  const inflight = new Map<string, { done: Promise<void>; deadline: number }>();
  let nextStart = Number.NEGATIVE_INFINITY;
  let pausedUntil = 0;

  const paused = (now: number): boolean => {
    const limited = yahoo.limitedUntil();
    const until = Math.max(
      yahoo.backoff()?.until ?? 0,
      limited === 0 ? 0 : limited + FAST_COOLDOWN_MS,
    );
    if (now >= until) return false;
    if (until > pausedUntil) {
      pausedUntil = until;
      log.info("yahoo fast refresh paused", {
        until: new Date(until).toISOString(),
      });
    }
    held.clear();
    return true;
  };

  const fetchedAt = (id: string): number | null =>
    db
      .query<{ fetched_at: number }, [string]>(
        "select fetched_at from quotes where instrument = ?",
      )
      .get(id)?.fetched_at ?? null;

  const reached = (at: number): { done: Promise<void>; cancel: () => void } => {
    let cancel = () => {};
    const done = new Promise<void>((resolve) => {
      cancel = clock.at(at, resolve);
    });
    return { done, cancel };
  };

  // as the pass asks it, so a symbol Yahoo refuses on spark goes to its
  // chart and never backs the queue off; a failure leaves the stored quote
  const fetchOne = async (
    i: Instrument,
    start: number,
    deadline: number,
  ): Promise<void> => {
    if (start > clock.now()) await reached(start).done;
    if (paused(clock.now())) return;
    try {
      // ahead of the jobs' calls, given up once the page's read is answered
      const live = () => clock.now() < deadline;
      const [batch] = await yahoo.within(live).sparkAll([i.sourceSymbol]);
      const answer = batch?.answer;
      if (answer === undefined) return;
      await writer.write((db) => storeQuotes(db, answer, rules, clock.now()));
    } catch {}
  };

  return {
    async refresh(i) {
      const now = clock.now();
      if (i.source !== SOURCE) return false;
      if (!isQuoted(i.market, readSession(db, i.market), now)) {
        held.delete(i.id);
        return false;
      }
      if (paused(now)) return false;
      for (const [id, at] of held) {
        if (now - at >= FAST_HOLD_MS) held.delete(id);
      }
      if (!held.has(i.id) && held.size >= FAST_CAP) return false;
      held.set(i.id, now);
      const at = fetchedAt(i.id);
      if (at !== null && now - at < FAST_MS) return true;
      let flight = inflight.get(i.id);
      if (flight === undefined) {
        const start = Math.max(now, nextStart);
        nextStart = start + FAST_SPACING_MS;
        const deadline = start + FAST_WAIT_MS;
        const done = fetchOne(i, start, deadline).finally(() =>
          inflight.delete(i.id),
        );
        flight = { done, deadline };
        inflight.set(i.id, flight);
      }
      const timer = reached(flight.deadline);
      await Promise.race([flight.done, timer.done]);
      timer.cancel();
      return !paused(clock.now());
    },
    release(i) {
      held.delete(i.id);
    },
  };
}
