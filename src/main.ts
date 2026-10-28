// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import pkg from "../package.json";
import { AdminError, runAdmin } from "./admin/cli.ts";
import { start } from "./app.ts";
import { MINUTE_MS, wallClock } from "./runtime/clock.ts";
import { dbPath, HELP, parseCli, secretsDir } from "./runtime/config.ts";
import {
  ADMIN_FILE,
  BEARER_FILE,
  createAdmin,
  createBearer,
  KeyError,
  keys,
  requireAdmin,
  requireBearer,
} from "./runtime/keys.ts";
import { errorFields, logger } from "./runtime/log.ts";
import { runService, ServiceError } from "./service/index.ts";
import { open } from "./storage/db/index.ts";

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
if (cli.kind === "service") {
  try {
    await runService(cli.argv);
  } catch (error) {
    if (!(error instanceof ServiceError)) throw error;
    console.error(`error: ${error.message}`);
    process.exit(1);
  }
  process.exit(0);
}
if (cli.kind === "admin") {
  try {
    await runAdmin(cli.argv);
  } catch (error) {
    if (!(error instanceof AdminError)) throw error;
    console.error(`error: ${error.message}`);
    process.exit(1);
  }
  process.exit(0);
}

const config = cli.config;
const store = keys(secretsDir(config));
const log = logger(wallClock, store.values);
const main = log("markets");

let bearer: string;
let adminKey: string;
let created = false;
let adminCreated = false;
try {
  created = createBearer(store.dir);
  bearer = requireBearer(store);
  adminCreated = createAdmin(store.dir);
  adminKey = requireAdmin(store, bearer);
} catch (error) {
  if (!(error instanceof KeyError)) throw error;
  console.error(`error: ${error.message}`);
  process.exit(1);
}
if (created) {
  main.info("bearer key created", {
    path: displayPath(join(store.dir, BEARER_FILE)),
  });
}
if (adminCreated) {
  main.info("admin key created", {
    path: displayPath(join(store.dir, ADMIN_FILE)),
  });
}

mkdirSync(config.dataDir, { recursive: true });
const { db, migrations } = open(dbPath(config), wallClock);

const app = start({
  hostname: config.hostname,
  port: config.port,
  bearer,
  adminKey,
  ui: config.ui,
  clock: wallClock,
  log,
  version: VERSION,
  db,
  quoteEveryMs: config.quoteEveryMs,
  trackDays: config.trackDays,
  track: config.track,
  // read through the keys module, so the log masks it
  fredKey: store.source("fred"),
  finnhubKey: store.source("finnhub"),
  massiveKey: store.source("massive"),
  bvb: config.sources.includes("bvb"),
});

main.info("startup", {
  version: VERSION,
  listen: `http://${app.server.hostname}:${app.server.port}`,
  data: displayPath(config.dataDir),
  migrations: migrations.length > 0 ? migrations.join(",") : "current",
  quote_every: config.quoteEveryMs / MINUTE_MS,
  track_days: config.trackDays,
  ui: config.ui ? "on" : "off",
});
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
