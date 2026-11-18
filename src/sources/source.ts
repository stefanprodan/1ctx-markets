// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { type Clock, HOUR_MS, MINUTE_MS } from "../runtime/clock.ts";
import type { Log } from "../runtime/log.ts";

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

// a run cut by shutdown, which the next run settles; a crash's is
// interrupted, which counts, since a run that kills the server would
// otherwise never show
export const STOPPED = "stopped";

// the phrase a run records for any error, so no message text is stored
export function phraseOf(error: unknown): string {
  if (error instanceof QueueClosed) return STOPPED;
  return error instanceof SourceError ? error.phrase : "failed";
}

// a 429; waitMs is the answer's Retry-After, null without a usable one
export class RateLimited extends SourceError {
  constructor(readonly waitMs: number | null = null) {
    super("rate limited");
  }
}

// Retry-After is seconds or an HTTP date
export function rateLimited(res: Response, now: number): RateLimited {
  const raw = res.headers.get("retry-after")?.trim() ?? "";
  if (/^\d+$/.test(raw)) return new RateLimited(Number(raw) * 1000);
  const at = raw === "" ? Number.NaN : Date.parse(raw);
  return new RateLimited(Number.isNaN(at) ? null : Math.max(0, at - now));
}

// not the source's format at all, such as a consent page: the source is unwell
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
    // it never reached the source, and the back-off it met is in force
    error instanceof Paused ||
    (error instanceof SourceError &&
      (error.phrase === "not found" ||
        error.phrase === "bad request" ||
        (error.phrase === "malformed answer" &&
          !(error instanceof Unreadable))))
  );

export const RATE_LIMIT_BACKOFF_MS = 5 * MINUTE_MS;
export const FAILURE_BACKOFF_MS = 30_000;
// a Retry-After past this is taken as this, so one odd header never
// silences a source for days
export const MAX_RETRY_AFTER_MS = HOUR_MS;

// the pause a failure sets: a 429's Retry-After lengthens it, never shortens
export function pauseOf(error: unknown): number {
  if (!(error instanceof SourceError && error.phrase === "rate limited")) {
    return FAILURE_BACKOFF_MS;
  }
  const asked = error instanceof RateLimited ? (error.waitMs ?? 0) : 0;
  return Math.max(RATE_LIMIT_BACKOFF_MS, Math.min(asked, MAX_RETRY_AFTER_MS));
}

export type RunOptions = {
  // a tool fails at once while the queue backs off; a job waits it out
  failFast?: boolean;
  // false once the caller's deadline passed, so a waiting call never starts
  live?: () => boolean;
  // among calls with a deadline, a lower order goes first, so one fetch's
  // chain of calls ends before a later fetch's starts
  order?: number;
};

// a back-off in force: when calls go again and the phrase that started it
export type Backoff = { until: number; after: Phrase };

export type Queue = {
  run<T>(task: () => Promise<T>, options?: RunOptions): Promise<T>;
  // at shutdown: fails waiting calls, so none goes out after
  close(): void;
  // for a task that makes more than one call, so none goes out after close
  isClosed(): boolean;
  // when calls waiting out a back-off resume, null with none waiting
  due(): number | null;
  // null once it ended, whether or not a call waits
  backoff(): Backoff | null;
  // when the latest back-off a 429 set ends or ended, 0 before any
  limitedUntil(): number;
};

// a source's back-offs are logged once each, never per call
export type QueueLog = { source: string; log: Log };

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
  order: number | undefined;
  reject: (error: unknown) => void;
};

export function queue(
  clock: Clock,
  concurrency: number,
  logged?: QueueLog,
): Queue {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
    throw new Error("concurrency is a whole number above 0");
  }
  let waiting: Waiting[] = [];
  let active = 0;
  let until = 0;
  let pausedBy: Phrase = "rate limited";
  let armed = false;
  let closed = false;
  let resume: (() => void) | null = null;
  let limited = 0;
  const backOff = (pause: number, phrase: Phrase) => {
    const next = clock.now() + pause;
    if (phrase === "rate limited") limited = Math.max(limited, next);
    if (next <= until) return;
    until = next;
    pausedBy = phrase;
    if (logged === undefined) return;
    logged.log.warn("source backing off", {
      source: logged.source,
      reason: phrase,
      until: new Date(until).toISOString(),
    });
    resume?.();
    resume = clock.at(until, () => {
      resume = null;
      logged.log.info("source resumed", { source: logged.source });
    });
  };
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
                backOff(
                  pauseOf(error),
                  error instanceof SourceError ? error.phrase : "source error",
                );
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
          order: options.order,
          reject,
        };
        // a call with a deadline goes ahead of the jobs' calls, in order
        // among its own, so a read never times out behind a pass
        const order = call.order;
        const behind = call.deadline
          ? waiting.findIndex(
              (w) =>
                !w.deadline ||
                (order !== undefined &&
                  w.order !== undefined &&
                  w.order > order),
            )
          : -1;
        if (behind === -1) waiting.push(call);
        else waiting.splice(behind, 0, call);
        pump();
      });
    },
    close() {
      closed = true;
      resume?.();
      resume = null;
      const left = waiting;
      waiting = [];
      for (const w of left) w.reject(new QueueClosed());
    },
    isClosed: () => closed,
    due: () => (armed ? until : null),
    backoff: () => (clock.now() < until ? { until, after: pausedBy } : null),
    limitedUntil: () => limited,
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
export function limiter(
  clock: Clock,
  spacingMs: number,
  logged?: QueueLog,
): Limiter {
  const calls = queue(clock, 1, logged);
  let lastStart = Number.NEGATIVE_INFINITY;
  let closed = false;
  let parked: number | null = null;
  const waits = new Set<{ cancel: () => void; reject: (e: unknown) => void }>();
  // an answered ordered call's hold on the queue, by its order
  const holds = new Map<number, () => void>();

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

  const started = async <T>(
    task: () => Promise<T>,
    run: RunOptions,
  ): Promise<T> => {
    if (closed) throw new QueueClosed();
    if (run.live !== undefined && !run.live()) throw new DeadlinePassed();
    await slot();
    // closed or past the deadline while it waited: the slot stays free
    if (closed) throw new QueueClosed();
    if (run.live !== undefined && !run.live()) throw new DeadlinePassed();
    lastStart = clock.now();
    return task();
  };

  return {
    run: (task, run = {}) => {
      const order = run.order;
      if (order === undefined) return calls.run(() => started(task, run), run);
      // an ordered call answers at once but holds the queue until its
      // fetch's next call is queued, or a turn passes with none, however
      // long the answer took, so no later fetch's call slips in between
      const p = new Promise<Awaited<ReturnType<typeof task>>>(
        (resolve, reject) => {
          calls
            .run(async () => {
              resolve(await started(task, run));
              await new Promise<void>((done) => {
                const release = () => {
                  clearImmediate(turn);
                  if (holds.get(order) === release) holds.delete(order);
                  done();
                };
                const turn = setImmediate(release);
                holds.set(order, release);
              });
            }, run)
            .catch(reject);
        },
      );
      holds.get(order)?.();
      return p;
    },
    due: () => parked ?? calls.due(),
    backoff: () => calls.backoff(),
    close() {
      closed = true;
      calls.close();
      for (const release of holds.values()) release();
      for (const wait of waits) {
        wait.cancel();
        wait.reject(new QueueClosed());
      }
      waits.clear();
    },
  };
}
