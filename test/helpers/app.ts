// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { join } from "node:path";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { type App, start } from "../../src/app.ts";
import { MINUTE_MS } from "../../src/runtime/clock.ts";
import { keys, requireAdmin, requireBearer } from "../../src/runtime/keys.ts";
import { logger } from "../../src/runtime/log.ts";
import type { Fetch } from "../../src/sources/source.ts";
import { type Db, open } from "../../src/storage/db/index.ts";
import { type FakeClock, fakeClock } from "./clock.ts";

export const SECRETS = join(import.meta.dir, "..", "fixtures", "secrets");

export type TestApp = {
  url: string;
  bearer: string;
  admin: string;
  // every log line the app wrote
  lines: string[];
  clock: FakeClock;
  db: Db;
  app: App;
};

export type TestOptions = {
  // answers every source call; by default any call fails the test
  fetch?: Fetch;
  fredKey?: string;
  finnhubKey?: string;
  massiveKey?: string;
  start?: number;
  track?: string[];
  // the Bucharest feed, on as with --source bvb
  bvb?: boolean;
  // kept open after the app stops, so a second start reads it
  db?: Db;
};

// on loopback, on a port the system picks; stopped when fn ends, since
// tests in a file run concurrently
export async function withApp(
  fn: (t: TestApp) => Promise<void>,
  options: TestOptions = {},
) {
  const store = keys(SECRETS);
  const clock = fakeClock(options.start);
  const lines: string[] = [];
  const bearer = requireBearer(store);
  const admin = requireAdmin(store, bearer);
  const db = options.db ?? open(":memory:", clock).db;
  const app = start({
    hostname: "127.0.0.1",
    port: 0,
    bearer,
    adminKey: admin,
    clock,
    log: logger(clock, store.values, (line) => lines.push(line)),
    version: "v0.0.0-test",
    db,
    quoteEveryMs: 5 * MINUTE_MS,
    fredKey: options.fredKey ?? null,
    finnhubKey: options.finnhubKey ?? null,
    massiveKey: options.massiveKey ?? null,
    track: options.track,
    bvb: options.bvb,
    // no test reaches a network
    fetch:
      options.fetch ??
      (async (url) => {
        throw new Error(`no network in tests: ${url}`);
      }),
  });
  try {
    await fn({
      url: `http://127.0.0.1:${app.server.port}`,
      bearer,
      admin,
      lines,
      clock,
      db,
      app,
    });
  } finally {
    await app.stop();
    if (options.db === undefined) db.close();
  }
}

// an SDK client on the app's /mcp, closed by the caller
export async function mcpClient(t: TestApp): Promise<Client> {
  const client = new Client({ name: "test", version: "1" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${t.url}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${t.bearer}` } },
    }),
  );
  return client;
}
