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
import { DeadlinePassed } from "../source.ts";
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

// viewer names who reads the page, so one leaving keeps another's place
export type FastQuotes = {
  // whether the instrument refreshes fast; refetches its quote when old
  refresh(instrument: Instrument, viewer: string): Promise<boolean>;
  // its page was left: with no other viewer the place goes to the next at
  // once; a fetch in flight still lands
  release(instrument: Instrument, viewer: string): void;
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
  // by instrument id, then viewer, when that viewer last asked
  const held = new Map<string, Map<string, number>>();
  const inflight = new Map<string, { done: Promise<void>; deadline: number }>();
  // by instrument id, when its last call went out, answered or not
  const asked = new Map<string, number>();
  let lastStart = Number.NEGATIVE_INFINITY;
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
  const fetchOne = async (i: Instrument, deadline: number): Promise<void> => {
    let started = false;
    // ahead of the jobs' calls, given up once the page's read is answered;
    // the queue asks it as the call starts, so the spacing holds there
    const live = () => {
      const now = clock.now();
      if (now >= deadline) return false;
      if (started) return true;
      if (now < lastStart + FAST_SPACING_MS) return false;
      started = true;
      lastStart = now;
      asked.set(i.id, now);
      return true;
    };
    try {
      for (;;) {
        const turn = Math.max(clock.now(), lastStart + FAST_SPACING_MS);
        if (turn >= deadline) return;
        if (turn > clock.now()) await reached(turn).done;
        if (paused(clock.now())) return;
        const [batch] = await yahoo.within(live).sparkAll([i.sourceSymbol]);
        // a slot freed before its turn: it waits for the next
        if (!started && batch?.error instanceof DeadlinePassed) continue;
        const answer = batch?.answer;
        if (answer === undefined) return;
        await writer.write((db) => storeQuotes(db, answer, rules, clock.now()));
        return;
      }
    } catch {}
  };

  return {
    async refresh(i, viewer) {
      const now = clock.now();
      if (i.source !== SOURCE) return false;
      if (!isQuoted(i.market, readSession(db, i.market), now)) {
        held.delete(i.id);
        return false;
      }
      if (paused(now)) return false;
      for (const [id, viewers] of held) {
        for (const [v, at] of viewers) {
          if (now - at >= FAST_HOLD_MS) viewers.delete(v);
        }
        if (viewers.size === 0) held.delete(id);
      }
      for (const [id, at] of asked) if (now - at >= FAST_MS) asked.delete(id);
      let viewers = held.get(i.id);
      if (viewers === undefined) {
        if (held.size >= FAST_CAP) return false;
        viewers = new Map();
        held.set(i.id, viewers);
      }
      viewers.set(viewer, now);
      const at = Math.max(
        fetchedAt(i.id) ?? Number.NEGATIVE_INFINITY,
        asked.get(i.id) ?? Number.NEGATIVE_INFINITY,
      );
      if (now - at < FAST_MS) return true;
      let flight = inflight.get(i.id);
      // one past its wait lands or lapses alone; the read asks anew, spaced after it
      if (flight === undefined || flight.deadline <= now) {
        const deadline = now + FAST_WAIT_MS;
        const mine: { done: Promise<void>; deadline: number } = {
          done: fetchOne(i, deadline).finally(() => {
            if (inflight.get(i.id) === mine) inflight.delete(i.id);
          }),
          deadline,
        };
        flight = mine;
        inflight.set(i.id, flight);
      }
      const timer = reached(flight.deadline);
      await Promise.race([flight.done, timer.done]);
      timer.cancel();
      return !paused(clock.now());
    },
    release(i, viewer) {
      const viewers = held.get(i.id);
      viewers?.delete(viewer);
      if (viewers?.size === 0) held.delete(i.id);
    },
  };
}
