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

export type RunOptions = {
  // a tool answering a caller fails at once while the queue is paused,
  // where a job waits the back-off out
  failFast?: boolean;
};

export type Queue = {
  run<T>(task: () => Promise<T>, options?: RunOptions): Promise<T>;
  // At shutdown: refuses new calls and fails the waiting ones, so no job
  // waits out a back-off; calls already sent finish.
  close(): void;
};

export class QueueClosed extends Error {
  constructor() {
    super("the source queue is closed");
    this.name = "QueueClosed";
  }
}

type Waiting = {
  start: () => void;
  failFast: boolean;
  reject: (error: unknown) => void;
};

// A few calls at a time; after a 429 or a failure, no call starts until
// the back-off has passed, and the failed call is not retried.
export function queue(clock: Clock, concurrency: number): Queue {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
    throw new Error("concurrency is a whole number above 0");
  }
  let waiting: Waiting[] = [];
  let active = 0;
  let until = 0;
  let pausedBy: Phrase = "rate limited";
  let armed = false;
  let closed = false;
  const pump = () => {
    if (closed) return;
    if (clock.now() < until) {
      const fast = waiting.filter((w) => w.failFast);
      waiting = waiting.filter((w) => !w.failFast);
      for (const w of fast) w.reject(new SourceError(pausedBy, "backing off"));
      if (!armed && waiting.length > 0) {
        armed = true;
        clock.at(until, () => {
          armed = false;
          pump();
        });
      }
      return;
    }
    while (active < concurrency && waiting.length > 0) {
      active++;
      waiting.shift()!.start();
    }
  };
  return {
    run<T>(task: () => Promise<T>, options: RunOptions = {}): Promise<T> {
      if (closed) return Promise.reject(new QueueClosed());
      return new Promise<T>((resolve, reject) => {
        const start = () => {
          Promise.resolve()
            .then(task)
            .then(resolve, (error: unknown) => {
              if (backsOff(error)) {
                const limited =
                  error instanceof SourceError &&
                  error.phrase === "rate limited";
                const pause = limited
                  ? RATE_LIMIT_BACKOFF_MS
                  : FAILURE_BACKOFF_MS;
                if (clock.now() + pause > until) {
                  until = clock.now() + pause;
                  pausedBy =
                    error instanceof SourceError
                      ? error.phrase
                      : "source error";
                }
              }
              reject(error);
            })
            .finally(() => {
              active--;
              pump();
            });
        };
        waiting.push({ start, failFast: options.failFast === true, reject });
        pump();
      });
    },
    close() {
      closed = true;
      const left = waiting;
      waiting = [];
      for (const w of left) w.reject(new QueueClosed());
    },
  };
}
