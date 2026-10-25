// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { join } from "node:path";
import { start } from "../../src/app.ts";
import { MINUTE_MS } from "../../src/clock.ts";
import { open } from "../../src/db/index.ts";
import { keys, requireBearer } from "../../src/keys.ts";
import { logger } from "../../src/log.ts";
import { fakeClock } from "./clock.ts";

export const SECRETS = join(import.meta.dir, "..", "fixtures", "secrets");

export type TestApp = {
  url: string;
  bearer: string;
  // every log line the app wrote
  lines: string[];
};

// on loopback, on a port the system picks; stopped when fn ends, since
// tests in a file run concurrently
export async function withApp(fn: (t: TestApp) => Promise<void>) {
  const store = keys(SECRETS);
  const clock = fakeClock();
  const lines: string[] = [];
  const bearer = requireBearer(store);
  const { db } = open(":memory:", clock);
  const app = start({
    hostname: "127.0.0.1",
    port: 0,
    bearer,
    clock,
    log: logger(clock, store.values, (line) => lines.push(line)),
    version: "v0.0.0-test",
    db,
    quoteEveryMs: 5 * MINUTE_MS,
    // no test reaches a network
    fetch: async (url) => {
      throw new Error(`no network in tests: ${url}`);
    },
  });
  try {
    await fn({ url: `http://127.0.0.1:${app.server.port}`, bearer, lines });
  } finally {
    await app.stop();
    db.close();
  }
}
