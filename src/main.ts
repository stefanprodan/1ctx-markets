// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The entry: flags, the bearer, the db, start().

import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import pkg from "../package.json";
import { start } from "./app.ts";
import { MINUTE_MS, wallClock } from "./clock.ts";
import { dbPath, HELP, parseCli, secretsDir } from "./config.ts";
import { open } from "./db/index.ts";
import { KeyError, keys, requireBearer } from "./keys.ts";
import { errorFields, logger } from "./log.ts";

const buildVersion = process.env.MARKETS_BUILD_VERSION;
export const VERSION = buildVersion || `v${pkg.version}`;

function displayPath(path: string): string {
  const home = homedir();
  if (path === home) return "~";
  return path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

const cli = parseCli(process.argv.slice(2));
if (cli.kind === "error") {
  console.error(`error: ${cli.message}\n\n${HELP}`);
  process.exit(1);
}
if (cli.kind === "version") {
  console.log(VERSION);
  process.exit(0);
}
if (cli.kind === "help") {
  console.log(HELP);
  process.exit(0);
}

const config = cli.config;
const store = keys(secretsDir(config));
const log = logger(wallClock, store.values);
const main = log("markets");

let bearer: string;
try {
  bearer = requireBearer(store);
} catch (error) {
  if (!(error instanceof KeyError)) throw error;
  console.error(`error: ${error.message}`);
  process.exit(1);
}

mkdirSync(config.dataDir, { recursive: true });
const { db, migrations } = open(dbPath(config), wallClock);

const app = start({
  hostname: config.hostname,
  port: config.port,
  bearer,
  clock: wallClock,
  log,
  version: VERSION,
  db,
  quoteEveryMs: config.quoteEveryMs,
  trackDays: config.trackDays,
  inlineFetch: config.inlineFetch,
  // read through the keys module, so the log masks it
  fredKey: store.source("fred"),
});

main.info("startup", {
  version: VERSION,
  listen: `http://${app.server.hostname}:${app.server.port}`,
  data: displayPath(config.dataDir),
  migrations: migrations.length > 0 ? migrations.join(",") : "current",
  quote_every: config.quoteEveryMs / MINUTE_MS,
  track_days: config.trackDays,
  inline_fetch: config.inlineFetch,
});
// one field per source with its state and why; Yahoo needs no key
main.info("sources", app.sources);

let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  try {
    await app.stop();
    db.close();
    main.info("shutdown", { signal });
    process.exit(0);
  } catch (error) {
    main.error("shutdown failed", { signal, ...errorFields(error) });
    process.exit(1);
  }
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
