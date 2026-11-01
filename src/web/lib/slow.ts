// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { type ReadonlySignal, signal } from "@preact/signals";

export const SLOW_MS = 1000;
// a read faster than this never shows placeholders: the page on screen
// stays until it lands, so a fast connection switches in one frame
export const HOLD_MS = 250;
// placeholders that did show stay this long, so a read landing just
// past the hold never flashes them
export const SHOW_MS = 300;

export type Later = (ms: number, fire: () => void) => () => void;

export const timer: Later = (ms, fire) => {
  const t = setTimeout(fire, ms);
  return () => clearTimeout(t);
};

// work's answer, at once if it lands within HOLD_MS, else no sooner than
// SHOW_MS after the hold ends
export function paced<T>(work: Promise<T>, later: Later = timer): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let shown: Promise<void> | null = null;
    const cancel = later(HOLD_MS, () => {
      shown = new Promise((r) => later(SHOW_MS, r));
    });
    const settle = (land: () => void) => {
      if (shown === null) {
        cancel();
        land();
      } else void shown.then(land);
    };
    work.then(
      (v) => settle(() => resolve(v)),
      (e: unknown) => settle(() => reject(e)),
    );
  });
}

// show() once work settles or HOLD_MS pass, whichever is first; the
// returned function drops it, for a hold a newer one replaced
export function hold(
  work: Promise<unknown>,
  show: () => void,
  later: Later = timer,
): () => void {
  let done = false;
  const go = () => {
    if (done) return;
    done = true;
    cancel();
    show();
  };
  const cancel = later(HOLD_MS, go);
  work.then(go, go);
  return () => {
    done = true;
    cancel();
  };
}

export type Slow = {
  slow: ReadonlySignal<boolean>;
  // the read paced as paced() does, for a page waiting on it
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
      return paced(work, later);
    },
  };
}
