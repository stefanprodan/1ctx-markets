// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// What every source shares: its errors carry a fixed phrase, which is
// all a sync run or an answer repeats, and its calls go through one
// queue that backs off after a failure instead of retrying.

import { type Clock, MINUTE_MS } from "./clock.ts";

export type Fetch = (url: string, init: RequestInit) => Promise<Response>;

export const PHRASES = [
  "rate limited",
  "not found",
  "bad request",
  "source error",
  "network error",
  "timed out",
  "malformed answer",
] as const;

export type Phrase = (typeof PHRASES)[number];

export class SourceError extends Error {
  constructor(
    readonly phrase: Phrase,
    detail?: string,
  ) {
    super(detail ? `${phrase}: ${detail}` : phrase);
    this.name = "SourceError";
  }
}

// the phrase a run records for any error, so no message text is stored
export function phraseOf(error: unknown): string {
  return error instanceof SourceError ? error.phrase : "failed";
}

// an unknown symbol or a wrong request is no sign the source is unwell
const backsOff = (error: unknown): boolean =>
  !(
    error instanceof SourceError &&
    (error.phrase === "not found" || error.phrase === "bad request")
  );

export const RATE_LIMIT_BACKOFF_MS = 5 * MINUTE_MS;
export const FAILURE_BACKOFF_MS = 30_000;

export type Queue = {
  run<T>(task: () => Promise<T>): Promise<T>;
};

// A few calls at a time; after a 429 or a failure, no call starts until
// the back-off has passed, and the failed call is not retried.
export function queue(clock: Clock, concurrency: number): Queue {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
    throw new Error("concurrency is a whole number above 0");
  }
  const waiting: (() => void)[] = [];
  let active = 0;
  let until = 0;
  let armed = false;
  const pump = () => {
    while (active < concurrency && waiting.length > 0) {
      if (clock.now() < until) {
        if (!armed) {
          armed = true;
          clock.at(until, () => {
            armed = false;
            pump();
          });
        }
        return;
      }
      active++;
      waiting.shift()!();
    }
  };
  return {
    run<T>(task: () => Promise<T>): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        waiting.push(() => {
          Promise.resolve()
            .then(task)
            .then(resolve, (error: unknown) => {
              if (backsOff(error)) {
                const pause =
                  error instanceof SourceError &&
                  error.phrase === "rate limited"
                    ? RATE_LIMIT_BACKOFF_MS
                    : FAILURE_BACKOFF_MS;
                until = Math.max(until, clock.now() + pause);
              }
              reject(error);
            })
            .finally(() => {
              active--;
              pump();
            });
        });
        pump();
      });
    },
  };
}
