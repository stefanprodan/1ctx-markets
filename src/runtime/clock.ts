// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The only reader of the wall clock, so a test steps a fake one instead.

export type Clock = {
  // UTC epoch milliseconds
  now(): number;
  // runs fire once the clock reaches at; the returned function cancels it
  at(at: number, fire: () => void): () => void;
};

export const MINUTE_MS = 60_000;
export const DAY_MS = 24 * 60 * MINUTE_MS;

// a longer setTimeout delay overflows and fires at once
const MAX_TIMEOUT_MS = 2 ** 31 - 1;

export const wallClock: Clock = {
  now: () => Date.now(),
  at(at, fire) {
    let timer: ReturnType<typeof setTimeout>;
    const arm = () => {
      const wait = at - Date.now();
      timer =
        wait > MAX_TIMEOUT_MS
          ? setTimeout(arm, MAX_TIMEOUT_MS)
          : setTimeout(fire, Math.max(0, wait));
    };
    arm();
    return () => clearTimeout(timer);
  },
};
