// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Clock } from "../../src/runtime/clock.ts";

export type FakeClock = Clock & {
  // fires every timer due on the way, in time order, letting each
  // run's promises settle before the next
  advance(ms: number): Promise<void>;
  // when the earliest timer is due, null with none
  next(): number | null;
};

// a Monday morning in Bucharest, in winter time
export const START = Date.UTC(2026, 9, 26, 7, 0);

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

export function fakeClock(start = START): FakeClock {
  let now = start;
  let next = 0;
  const timers = new Map<number, { at: number; fire: () => void }>();
  return {
    now: () => now,
    next() {
      let at: number | null = null;
      for (const t of timers.values()) if (at === null || t.at < at) at = t.at;
      return at;
    },
    at(at, fire) {
      const id = next++;
      timers.set(id, { at, fire });
      return () => timers.delete(id);
    },
    async advance(ms) {
      const end = now + ms;
      await settle();
      for (;;) {
        let due: [number, { at: number; fire: () => void }] | undefined;
        for (const entry of timers) {
          if (
            entry[1].at <= end &&
            (due === undefined || entry[1].at < due[1].at)
          ) {
            due = entry;
          }
        }
        if (due === undefined) break;
        timers.delete(due[0]);
        now = Math.max(now, due[1].at);
        due[1].fire();
        await settle();
      }
      now = end;
      await settle();
    },
  };
}
