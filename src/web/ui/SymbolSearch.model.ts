// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Candidate } from "../data/store.ts";

// one letter matches too much upstream to be worth a source call
export const UPSTREAM_MIN = 2;
export const UPSTREAM_WAIT_MS = 250;
export const SHOWN = 12;

export type Search = (
  query: string,
  upstream: boolean,
  signal: AbortSignal,
) => Promise<Candidate[]>;

export type Timers = {
  set: (fn: () => void, ms: number) => unknown;
  clear: (timer: unknown) => void;
};

const browserTimers: Timers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
};

// stored matches cost no source call, so they never wait on upstream's
export function searcher(
  search: Search,
  show: (found: Candidate[] | null) => void,
  busy: (pending: boolean) => void,
  timers: Timers = browserTimers,
) {
  let abort: AbortController | null = null;
  let timer: unknown = null;
  const stop = () => {
    abort?.abort();
    abort = null;
    if (timer !== null) timers.clear(timer);
    timer = null;
  };
  return {
    ask(raw: string): void {
      stop();
      const query = raw.trim();
      if (query === "") {
        busy(false);
        show(null);
        return;
      }
      const mine = new AbortController();
      abort = mine;
      let stored: Candidate[] | null = null;
      let upstream: Candidate[] | null = null;
      const draw = () => {
        if (mine.signal.aborted) return;
        const seen = new Set((stored ?? []).map((c) => c.id));
        show(
          [
            ...(stored ?? []),
            ...(upstream ?? []).filter((c) => !seen.has(c.id)),
          ].slice(0, SHOWN),
        );
      };
      const wide = query.length >= UPSTREAM_MIN;
      busy(wide);
      void search(query, false, mine.signal)
        .catch(() => [])
        .then((c) => {
          stored = c;
          draw();
        });
      if (!wide) return;
      timer = timers.set(() => {
        timer = null;
        void search(query, true, mine.signal)
          .catch(() => [])
          .then((c) => {
            upstream = c;
            draw();
            if (!mine.signal.aborted) busy(false);
          });
      }, UPSTREAM_WAIT_MS);
    },
    stop,
  };
}

// the section picker first, so one Escape never loses the results
export const escapeFrom = (picking: string | null): "picker" | "results" =>
  picking === null ? "results" : "picker";

// the results show once answered, unless the only answer so far is an
// empty one still waiting on upstream
export const showsResults = (
  open: boolean,
  found: readonly Candidate[] | null,
  busy: boolean,
  refused: string | null,
): boolean =>
  open && found !== null && (found.length > 0 || !busy || refused !== null);
