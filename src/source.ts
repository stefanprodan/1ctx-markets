// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// What every source shares: its errors carry a fixed phrase, which is
// all a sync run or an answer repeats, and its calls go through one
// queue that backs off after a failure instead of retrying.

import { type Clock, MINUTE_MS } from "./runtime/clock.ts";

export type Fetch = (url: string, init: RequestInit) => Promise<Response>;

export const PHRASES = [
  "rate limited",
  "not found",
  "bad request",
  "source error",
  "network error",
  "timed out",
  "malformed answer",
  "key refused",
] as const;

export type Phrase = (typeof PHRASES)[number];

export class SourceError extends Error {
  constructor(
    readonly phrase: Phrase,
    readonly detail?: string,
  ) {
    super(detail ? `${phrase}: ${detail}` : phrase);
    this.name = "SourceError";
  }
}

// an echoed text may hold the key raw, percent- or query-encoded
export function scrub(value: string, key: string): string {
  if (key === "") return value;
  let out = value;
  const forms = new Set([
    key,
    encodeURIComponent(key),
    new URLSearchParams({ k: key }).toString().slice(2),
  ]);
  // case-blind, since percent escapes come in either case
  for (const form of [...forms].sort((a, b) => b.length - a.length)) {
    out = out.replace(
      new RegExp(form.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"),
      "REDACTED",
    );
  }
  return out;
}

// the phrase a run records for any error, so no message text is stored
export function phraseOf(error: unknown): string {
  return error instanceof SourceError ? error.phrase : "failed";
}

// A body that is not the source's format at all, such as a proxy or
// consent page: the source is unwell. An answer of an odd shape is that
// answer's fault alone, so it fails its call and the queue runs on.
export class Unreadable extends SourceError {
  constructor(detail = "not JSON") {
    super("malformed answer", detail);
  }
}

// the read's own deadline, never a sign the source is unwell
export class DeadlinePassed extends SourceError {
  constructor() {
    super("timed out", "the call's deadline passed");
  }
}

export const expired = () => new DeadlinePassed();

// it never reached the source, so no run records it
export class Paused extends SourceError {
  constructor(phrase: Phrase) {
    super(phrase, "backing off");
  }
}

// an instrument the server will not keep, said to the caller as it is
export class Refused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Refused";
  }
}

// an unknown symbol, a wrong request or one odd answer is no sign the
// source is unwell
const backsOff = (error: unknown): boolean =>
  !(
    error instanceof DeadlinePassed ||
    (error instanceof SourceError &&
      (error.phrase === "not found" ||
        error.phrase === "bad request" ||
        (error.phrase === "malformed answer" &&
          !(error instanceof Unreadable))))
  );

export const RATE_LIMIT_BACKOFF_MS = 5 * MINUTE_MS;
export const FAILURE_BACKOFF_MS = 30_000;

export type RunOptions = {
  // a tool fails at once while the queue backs off; a job waits it out
  failFast?: boolean;
  // false once the caller's deadline passed, so a waiting call never starts
  live?: () => boolean;
};

// a back-off in force: when calls go again and the phrase that started it
export type Backoff = { until: number; after: Phrase };

export type Queue = {
  run<T>(task: () => Promise<T>, options?: RunOptions): Promise<T>;
  // at shutdown: fails waiting calls, so none goes out after
  close(): void;
  // when calls waiting out a back-off resume, null with none waiting
  due(): number | null;
  // null once it ended, whether or not a call waits
  backoff(): Backoff | null;
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
  live: () => boolean;
  deadline: boolean;
  reject: (error: unknown) => void;
};

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
      for (const w of fast) w.reject(new Paused(pausedBy));
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
      const next = waiting.shift()!;
      if (!next.live()) {
        next.reject(new DeadlinePassed());
        continue;
      }
      active++;
      next.start();
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
        const call = {
          start,
          failFast: options.failFast === true,
          live: options.live ?? (() => true),
          deadline: options.live !== undefined,
          reject,
        };
        // a call with a deadline goes ahead of the jobs' calls, in order
        // among its own, so a read never times out behind a pass
        const behind = call.deadline
          ? waiting.findIndex((w) => !w.deadline)
          : -1;
        if (behind === -1) waiting.push(call);
        else waiting.splice(behind, 0, call);
        pump();
      });
    },
    close() {
      closed = true;
      const left = waiting;
      waiting = [];
      for (const w of left) w.reject(new QueueClosed());
    },
    due: () => (armed ? until : null),
    backoff: () => (clock.now() < until ? { until, after: pausedBy } : null),
  };
}

export type Limiter = {
  run<T>(task: () => Promise<T>, options?: RunOptions): Promise<T>;
  due(): number | null;
  backoff(): Backoff | null;
  // at shutdown: fails waiting calls, so none goes out after
  close(): void;
};

// spaced starts, so a source's own rate limit holds across its jobs and tools
export function limiter(clock: Clock, spacingMs: number): Limiter {
  const calls = queue(clock, 1);
  let lastStart = Number.NEGATIVE_INFINITY;
  let closed = false;
  let parked: number | null = null;
  const waits = new Set<{ cancel: () => void; reject: (e: unknown) => void }>();

  // waits, holding the queue, until the spacing since the last start
  const slot = async (): Promise<void> => {
    const until = lastStart + spacingMs;
    if (clock.now() < until) {
      parked = until;
      try {
        await new Promise<void>((resolve, reject) => {
          const wait = { cancel: () => {}, reject };
          wait.cancel = clock.at(until, () => {
            waits.delete(wait);
            resolve();
          });
          waits.add(wait);
        });
      } finally {
        parked = null;
      }
    }
  };

  return {
    run: (task, run = {}) =>
      calls.run(async () => {
        if (closed) throw new QueueClosed();
        if (run.live !== undefined && !run.live()) throw new DeadlinePassed();
        await slot();
        // closed or past the deadline while it waited: the slot stays free
        if (closed) throw new QueueClosed();
        if (run.live !== undefined && !run.live()) throw new DeadlinePassed();
        lastStart = clock.now();
        return task();
      }, run),
    due: () => parked ?? calls.due(),
    backoff: () => calls.backoff(),
    close() {
      closed = true;
      calls.close();
      for (const wait of waits) {
        wait.cancel();
        wait.reject(new QueueClosed());
      }
      waits.clear();
    },
  };
}
