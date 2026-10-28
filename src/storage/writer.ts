// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// One FIFO of short synchronous transactions; network calls never run inside.

import type { Db } from "./db/index.ts";

export type Writer = {
  // fn's result once its transaction commits; a throw rolls it back and
  // rejects only this caller
  write<T>(fn: (db: Db) => T): Promise<T>;
  // refuses new writes, then resolves once every queued one has run
  close(): Promise<void>;
};

export class WriterClosed extends Error {
  constructor() {
    super("the writer is closed");
    this.name = "WriterClosed";
  }
}

const isThenable = (v: unknown): boolean =>
  (typeof v === "object" || typeof v === "function") &&
  v !== null &&
  typeof (v as { then?: unknown }).then === "function";

export function writer(db: Db): Writer {
  let tail: Promise<unknown> = Promise.resolve();
  let closed = false;
  return {
    write<T>(fn: (db: Db) => T): Promise<T> {
      if (closed) return Promise.reject(new WriterClosed());
      const run = tail.then(() =>
        db.transaction((): T => {
          const result = fn(db);
          // an awaiting closure would commit before its writes ran
          if (isThenable(result)) {
            throw new Error("a write closure must not return a promise");
          }
          return result;
        })(),
      );
      tail = run.catch(() => {});
      return run;
    },
    async close() {
      closed = true;
      await tail;
    },
  };
}
