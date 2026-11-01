// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { type ReadonlySignal, signal } from "@preact/signals";

export const SLOW_MS = 1000;

export type Later = (ms: number, fire: () => void) => () => void;

export const timer: Later = (ms, fire) => {
  const t = setTimeout(fire, ms);
  return () => clearTimeout(t);
};

export type Slow = {
  slow: ReadonlySignal<boolean>;
  track<T>(work: Promise<T>): Promise<T>;
};

export function slowFlag(later: Later = timer): Slow {
  const slow = signal(false);
  let late = 0;
  return {
    slow,
    track(work) {
      let counted = false;
      const cancel = later(SLOW_MS, () => {
        counted = true;
        late++;
        slow.value = true;
      });
      const done = () => {
        cancel();
        if (counted && --late === 0) slow.value = false;
      };
      work.then(done, done);
      return work;
    },
  };
}
