// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { FakeClock } from "./clock.ts";

// a client or limiter that says when its next waiting call may go
export type Paced = { due(): number | null };

const turn = () => new Promise<void>((resolve) => setImmediate(resolve));

// the clock moves only to a limiter's due time, so no deadline fires early
export async function drive<T>(
  clock: FakeClock,
  limiters: Paced | readonly Paced[],
  p: Promise<T>,
): Promise<T> {
  const paced = Array.isArray(limiters) ? limiters : [limiters as Paced];
  let done = false;
  const settled = p.finally(() => {
    done = true;
  });
  settled.catch(() => {});
  for (let k = 0; k < 200_000 && !done; k++) {
    let due: number | null = null;
    for (const s of paced) {
      const at = s.due();
      if (at !== null && (due === null || at < due)) due = at;
    }
    if (due === null) await turn();
    else await clock.advance(Math.max(0, due - clock.now()));
  }
  if (!done) throw new Error("did not settle");
  return settled;
}

// the limiters a read's fetches wait on
export const pacedOf = (m: {
  finnhub: Paced | null;
  massive: Paced | null;
  edgar?: Paced | null;
}): Paced[] =>
  [m.finnhub, m.massive, m.edgar ?? null].filter((p) => p !== null);
