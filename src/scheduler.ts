// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Jobs on a fixed period, run off the clock, so a test steps a fake
// clock and sees every run without waiting.

import type { Clock } from "./clock.ts";
import { errorFields, type Log } from "./log.ts";

// gets the time it was due, which a late timer does not move
export type Job = (due: number) => Promise<void> | void;

export type Scheduler = {
  // the first run is one period from now
  every(name: string, periodMs: number, job: Job): void;
  // resolves once every run still going has settled
  stop(): Promise<void>;
};

export function scheduler(clock: Clock, log: Log): Scheduler {
  const cancels = new Map<string, () => void>();
  const runs = new Set<Promise<void>>();
  return {
    every(name, periodMs, job) {
      if (!Number.isSafeInteger(periodMs) || periodMs <= 0) {
        throw new Error("a period is a positive whole number of ms");
      }
      if (cancels.has(name)) throw new Error(`job ${name} is scheduled`);
      let running = false;
      const arm = (due: number) => {
        cancels.set(
          name,
          clock.at(due, () => run(due)),
        );
      };
      const run = (due: number) => {
        // the next run keeps to the period, and a clock that jumped past
        // several (a host that slept) runs once, not once per missed one
        let next = due + periodMs;
        const now = clock.now();
        if (next <= now) {
          next += Math.ceil((now - next + 1) / periodMs) * periodMs;
        }
        arm(next);
        // a run still going takes the turn, so a source is never asked
        // twice at once
        if (running) {
          log.warn("job skipped", { job: name });
          return;
        }
        running = true;
        const settled = (async () => {
          try {
            await job(due);
          } catch (error) {
            log.error("job failed", { job: name, ...errorFields(error) });
          } finally {
            running = false;
          }
        })();
        runs.add(settled);
        void settled.then(() => runs.delete(settled));
      };
      arm(clock.now() + periodMs);
    },
    async stop() {
      for (const cancel of cancels.values()) cancel();
      cancels.clear();
      await Promise.all(runs);
    },
  };
}
