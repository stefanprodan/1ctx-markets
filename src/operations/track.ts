// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// The --track values: resolved as a read would, tracked without one.

import { readInstrument } from "../market/instruments.ts";
import { errorFields, type Log } from "../runtime/log.ts";
import type { Scheduler } from "../runtime/scheduler.ts";
import { BVB, FRED } from "../sources/ids.ts";
import type { Db } from "../storage/db/index.ts";
import type { Markets } from "./markets.ts";
import { type ItemError, resolveTargets, storedInstrument } from "./targets.ts";

export type TrackState = {
  value: string;
  // the instrument it resolved to, null until it does
  id: string | null;
  state: "pending" | "tracked" | ItemError["error"];
};

export type Tracker = {
  // resolves every value still owed one; one run at a time
  run(): Promise<void>;
  status(): TrackState[];
  schedule(jobs: Scheduler): void;
  settled(): Promise<void>;
};

// only the operator changes these: the value, a flag or a key
const FINAL = new Set<TrackState["state"]>([
  "candidates",
  "refused",
  "no_data",
]);

// Stored values are tracked before the startup prune, which would take
// their news, and before a read could catch them up; a source that is
// off leaves its own to the tracker, which answers no_data.
export function seed(
  db: Db,
  values: readonly string[],
  on: { bvb: boolean; fred: boolean },
  flagged: Set<string>,
): TrackState[] {
  return values.map((value) => {
    const stored = storedInstrument(db, value, on.bvb);
    const off =
      (stored?.source === BVB && !on.bvb) ||
      (stored?.source === FRED && !on.fred);
    if (stored === null || off) return { value, id: null, state: "pending" };
    flagged.add(stored.id);
    return { value, id: stored.id, state: "tracked" };
  });
}

export function tracker(options: {
  m: Markets;
  // seed()'s, one per value
  states: TrackState[];
  // the set trackedIds() reads, filled in as values resolve
  flagged: Set<string>;
  // a run's deadline and the retry period
  periodMs: number;
  log: Log;
}): Tracker {
  const { m, states, flagged, periodMs, log } = options;
  let running: Promise<void> | null = null;

  async function pass(): Promise<void> {
    // deleted by the operator: the flag still names it, so fetch it again
    for (const s of states) {
      if (s.id === null || readInstrument(m.db, s.id) !== null) continue;
      flagged.delete(s.id);
      s.id = null;
      s.state = "pending";
    }
    const owed = states.filter(
      (s) => s.state !== "tracked" && !FINAL.has(s.state),
    );
    if (owed.length === 0) return;
    // no caller waits on it, so it may take the whole period
    const targets = await resolveTargets(
      { ...m, callMs: periodMs },
      owed.map((s) => s.value),
    );
    targets.forEach((t, k) => {
      const s = owed[k]!;
      if ("instrument" in t) {
        s.id = t.instrument.id;
        s.state = "tracked";
        flagged.add(s.id);
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
          retried: !FINAL.has(t.error.error),
        });
      }
      s.state = t.error.error;
    });
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
    settled: async () => {
      await running;
    },
  };
}
