// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { join } from "node:path";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import type { HTMLBundle } from "bun";
import { type App, start } from "../../src/app.ts";
import type { WorldEntry } from "../../src/market/world.ts";
import type { Access } from "../../src/operations/who.ts";
import { MINUTE_MS } from "../../src/runtime/clock.ts";
import { keys, requireAdmin } from "../../src/runtime/keys.ts";
import { logger } from "../../src/runtime/log.ts";
import { tokenHash } from "../../src/server/access.ts";
import type { EmailSender } from "../../src/server/email/smtp.ts";
import type { Fetch } from "../../src/sources/source.ts";
import { type Db, open } from "../../src/storage/db/index.ts";
import { type FakeClock, fakeClock } from "./clock.ts";

export const SECRETS = join(import.meta.dir, "..", "fixtures", "secrets");

// made up, as an agent key the admin made; never a real key
export const AGENT_KEY = "1ctx-markets-test-agent-key-0123456789abcdef";

// the agent key's row, kept when a test's database is started again; it
// sets alerts, as the tests drive them over MCP
export function seedAgentKey(db: Db, at: number): void {
  db.query(
    `insert or ignore into keys (id, user_id, name, token_hash, created_at, alerts)
     values ('testagentkey', 'operator', 'test-agent', ?, ?, 'write')`,
  ).run(tokenHash(AGENT_KEY), at);
}

export type TestApp = {
  url: string;
  // an agent key's token, as an agent sends it
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
  edgarKey?: string;
  start?: number;
  // World markets as the server tracks it; none by default
  world?: WorldEntry[];
  // the Bucharest feed, on as with --source bvb
  bvb?: boolean;
  // false as with --no-sync
  sync?: boolean;
  // kept open after the app stops, so a second start reads it
  db?: Db;
  // the web UI's sign-in, and the page it serves
  ui?: boolean;
  page?: HTMLBundle;
  // a fixed path to the file served there beside the page
  files?: Readonly<Record<string, string>>;
  // the secrets directory email- key files are read from; none keeps
  // email off
  secrets?: string;
  // records each email; by default any send fails the test's email
  sender?: EmailSender;
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
  const bearer = AGENT_KEY;
  const admin = requireAdmin(store);
  const db = options.db ?? open(":memory:", clock).db;
  seedAgentKey(db, clock.now());
  const app = start({
    hostname: "127.0.0.1",
    port: 0,
    adminKey: admin,
    mask: store.mask,
    clock,
    log: logger(clock, store.values, (line) => lines.push(line)),
    version: "v0.0.0-test",
    db,
    quoteEveryMs: 5 * MINUTE_MS,
    fredKey: options.fredKey ?? null,
    finnhubKey: options.finnhubKey ?? null,
    massiveKey: options.massiveKey ?? null,
    edgarKey: options.edgarKey ?? null,
    world: options.world,
    bvb: options.bvb,
    sync: options.sync,
    ui: options.ui,
    secrets: options.secrets === undefined ? undefined : keys(options.secrets),
    sender:
      options.sender ??
      (async () => ({ ok: false, failure: "connect", reply: null })),
    page: options.page,
    files: options.files,
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
export async function mcpClient(
  t: TestApp,
  bearer = t.bearer,
): Promise<Client> {
  const client = new Client({ name: "test", version: "1" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${t.url}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${bearer}` } },
    }),
  );
  return client;
}

// a made-up key with this access, as the admin makes one, the operator's
// unless a person is named; its token
export function seedKey(
  t: TestApp,
  name: string,
  opens: {
    portfolio: Access;
    alerts: Access;
    profile?: Access;
    analysis?: Access;
    user?: string;
  },
): string {
  const token = `1ctx-markets-test-${name}-key-0123456789abcdef`;
  t.db
    .query(
      `insert into keys
         (id, user_id, name, token_hash, created_at, portfolio, alerts, profile,
          analysis)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      `key-${name}`,
      opens.user ?? "operator",
      name,
      tokenHash(token),
      t.clock.now(),
      opens.portfolio,
      opens.alerts,
      opens.profile ?? "none",
      opens.analysis ?? "none",
    );
  return token;
}

// every portfolio, profile and analysis access with no alerts and with
// alerts, as keys are made; the last opens everything, the longest
// instructions
export const ACCESS_LEVELS: {
  portfolio: Access;
  alerts: Access;
  profile: Access;
  analysis: Access;
}[] = [
  { portfolio: "none", alerts: "none", profile: "none", analysis: "none" },
  { portfolio: "read", alerts: "none", profile: "read", analysis: "write" },
  { portfolio: "write", alerts: "none", profile: "write", analysis: "read" },
  { portfolio: "none", alerts: "read", profile: "write", analysis: "none" },
  { portfolio: "read", alerts: "write", profile: "none", analysis: "read" },
  { portfolio: "write", alerts: "write", profile: "read", analysis: "none" },
  { portfolio: "write", alerts: "write", profile: "write", analysis: "write" },
];
