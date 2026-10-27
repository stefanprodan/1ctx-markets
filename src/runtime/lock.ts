// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// One fetch-and-store per instrument and database at a time, held
// across the call and its write, so an answer fetched before another
// write never lands after it.

import type { Db } from "../db/index.ts";

const held = new WeakMap<Db, Map<string, Promise<void>>>();

export async function exclusive<T>(
  db: Db,
  id: string,
  fn: () => Promise<T>,
): Promise<T> {
  let locks = held.get(db);
  if (locks === undefined) {
    locks = new Map();
    held.set(db, locks);
  }
  const run = (locks.get(id) ?? Promise.resolve()).then(fn);
  // a holder's failure must not fail the next one waiting
  const tail = run.then(
    () => {},
    () => {},
  );
  locks.set(id, tail);
  try {
    return await run;
  } finally {
    if (locks.get(id) === tail) locks.delete(id);
  }
}
