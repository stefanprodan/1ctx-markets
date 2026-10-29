// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import pkg from "../package.json";
import { AdminError, runAdmin } from "./admin/cli.ts";
import { runKeys } from "./admin/keys-cli.ts";
import { start } from "./app.ts";
import { MINUTE_MS, wallClock } from "./runtime/clock.ts";
import { dbPath, HELP, parseCli, secretsDir } from "./runtime/config.ts";
import { ADMIN_FILE, KeyError, keys, startKeys } from "./runtime/keys.ts";
import { errorFields, logger } from "./runtime/log.ts";
import { runService, ServiceError } from "./service/index.ts";
import { open } from "./storage/db/index.ts";
import icon192 from "./web/icon-192.png";
import icon512 from "./web/icon-512.png";
import maskable from "./web/icon-maskable-512.png";
import page from "./web/index.html";

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
if (cli.kind === "admin" || cli.kind === "keys") {
  try {
    await (cli.kind === "admin" ? runAdmin : runKeys)(cli.argv);
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

let adminKey: string;
let adminCreated = false;
try {
  ({ admin: adminKey, created: adminCreated } = startKeys(store));
} catch (error) {
  if (!(error instanceof KeyError)) throw error;
  console.error(`error: ${error.message}`);
  process.exit(1);
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
  adminKey,
  mask: store.mask,
  ui: config.ui,
  page,
  // the manifest's icons: the bundler hashes what the page links but
  // leaves the URLs inside the manifest alone, so they keep fixed paths
  files: {
    "/icon-192.png": icon192,
    "/icon-512.png": icon512,
    "/icon-maskable-512.png": maskable,
  },
  // a local preview rebuilds the page as its sources change, so an edit
  // never needs a restart; never set where the binary runs
  pageDev: process.env.MARKETS_PAGE_DEV === "1",
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
