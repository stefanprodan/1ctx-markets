// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// The --track values: resolved as a read would, tracked without one.

import { nextCheck, readSession } from "../market/calendars.ts";
import { type Instrument, readInstrument } from "../market/instruments.ts";
import { JOBS } from "../market/stale.ts";
import { errorFields, type Log } from "../runtime/log.ts";
import type { Scheduler } from "../runtime/scheduler.ts";
import { seriesStale } from "../sources/fred/jobs.ts";
import { BVB, FRED } from "../sources/ids.ts";
import type { Db } from "../storage/db/index.ts";
import { lastStarted } from "../storage/runs.ts";
import type { Markets } from "./markets.ts";
import { type ItemError, resolveTargets, storedInstrument } from "./targets.ts";

export type TrackState = {
  value: string;
  // the instrument it resolved to, null until it does
  id: string | null;
  state: "pending" | "tracked" | ItemError["error"];
};

export type Tracker = {
  // resolves every value still owed one, one value at a time
  run(): Promise<void>;
  status(): TrackState[];
  schedule(jobs: Scheduler): void;
  // no value starts after this
  stop(): void;
  // the current value's resolution; app.stop() drains fetches past it
  settled(): Promise<void>;
};

// only the operator changes these: the value, a flag or a key
const FINAL = new Set<TrackState["state"]>([
  "candidates",
  "refused",
  "no_data",
]);

// synced in its market's latest session, and no newer one can be unseen
function whole(db: Db, i: Instrument, now: number): boolean {
  // a series has no session: its own staleness says whether it is due
  if (i.source === FRED) return seriesStale(db, i, now).length === 0;
  const session = readSession(db, i.market);
  const changed = db
    .query<{ at: number | null }, [string]>(
      "select max(fetched_at) as at from bars where instrument = ? and interval = '1d'",
    )
    .get(i.id)!.at;
  if (session === null || changed === null || changed < session.start) {
    return false;
  }
  const checked = lastStarted(db, i.source, JOBS.check, i.market);
  const since = Math.max(session.fetchedAt, checked?.startedAt ?? 0);
  return now < nextCheck(session, since);
}

// each stored value whose source is on is flagged before the startup prune
export function seed(options: {
  db: Db;
  values: readonly string[];
  on: { bvb: boolean; fred: boolean };
  flagged: Set<string>;
  owed: Set<string>;
  now: number;
}): TrackState[] {
  const { db, on, flagged, owed, now } = options;
  return options.values.map((value) => {
    const stored = storedInstrument(db, value, on.bvb);
    const off =
      (stored?.source === BVB && !on.bvb) ||
      (stored?.source === FRED && !on.fred);
    if (stored === null || off) return { value, id: null, state: "pending" };
    flagged.add(stored.id);
    if (whole(db, stored, now)) {
      return { value, id: stored.id, state: "tracked" };
    }
    // the tracker's first pass catches it up, as a read would
    owed.add(stored.id);
    return { value, id: stored.id, state: "pending" };
  });
}

export function tracker(options: {
  m: Markets;
  // seed()'s, one per value
  states: TrackState[];
  // the sets trackedIds() and the reads see, kept as values resolve
  flagged: Set<string>;
  owed: Set<string>;
  periodMs: number;
  log: Log;
}): Tracker {
  const { m, states, flagged, owed, periodMs, log } = options;
  let running: Promise<void> | null = null;
  let stopped = false;
  // a stored value's no_data asks no source, and a source switch can end it
  const final = (state: TrackState["state"], value: string) =>
    FINAL.has(state) &&
    !(
      state === "no_data" &&
      storedInstrument(m.db, value, m.bvb !== null) !== null
    );
  // twice a call's: as long as one source call may take before it times out
  const one = { ...m, callMs: 2 * m.callMs };

  async function resolveOne(s: TrackState): Promise<void> {
    const [t] = await resolveTargets(one, [s.value]);
    if (t === undefined) return;
    if ("instrument" in t) {
      s.id = t.instrument.id;
      s.state = "tracked";
      flagged.add(s.id);
      owed.delete(s.id);
      log.info("track value resolved", { value: s.value, id: s.id });
      return;
    }
    // once per value and reason, so a retried one does not log each pass
    if (t.error.error !== s.state) {
      log.warn("track value not resolved", {
        value: s.value,
        error: t.error.error,
        message: t.error.message,
        candidates: t.error.candidates?.map((c) => c.id).join(","),
        retried: !final(t.error.error, s.value),
      });
    }
    s.state = t.error.error;
  }

  // one at a time in the reads' lane, so a read waits behind one call at most
  async function pass(): Promise<void> {
    // deleted by the operator: the flag still names it, so fetch it again
    for (const s of states) {
      if (s.id === null || readInstrument(m.db, s.id) !== null) continue;
      flagged.delete(s.id);
      owed.delete(s.id);
      s.id = null;
      s.state = "pending";
    }
    for (const s of states) {
      if (stopped) return;
      if (s.state === "tracked" || final(s.state, s.value)) continue;
      await resolveOne(s);
    }
  }

  function run(): Promise<void> {
    running ??= pass()
      .catch((error: unknown) => {
        log.error("track failed", errorFields(error));
      })
      .finally(() => {
        running = null;
      });
    return running;
  }

  return {
    run,
    status: () => states.map((s) => ({ ...s })),
    schedule(jobs) {
      if (states.length > 0) jobs.every("track", periodMs, run);
    },
    stop() {
      stopped = true;
    },
    settled: async () => {
      await running;
    },
  };
}
