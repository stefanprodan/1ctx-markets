// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// Held across fetch and write, so an older answer never lands after a newer.

import type { Db } from "../storage/db/index.ts";

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
