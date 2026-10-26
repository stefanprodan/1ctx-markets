// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// `1ctx-markets service`: the binary installs itself with the platform's
// service manager. The commands here know no platform; the backend does.

import { rm } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { type Clock, wallClock } from "../clock.ts";
import {
  type Config,
  configToArgs,
  dbPath,
  parseCli,
  VALUED_FLAGS,
} from "../config.ts";
import type { ServiceBackend } from "./backend.ts";
import { launchdBackend, sleeper } from "./launchd.ts";

const HEALTH_ATTEMPTS = 60;
const HEALTH_POLL_MS = 1_000;
// a source call already sent ends within its 30-second timeout, then the
// writer drains; launchd's kill comes after, inside the stop's wait
export const EXIT_TIMEOUT = 45;
const USAGE =
  "usage: 1ctx-markets service install|status|start|stop|restart|uninstall";

export class ServiceError extends Error {}

export type ServiceDeps = {
  home?: string;
  // Bun.main and the running executable: a service runs the compiled
  // binary, never the source
  main?: string;
  execPath?: string;
  cwd?: string;
  platform?: string;
  backend?: ServiceBackend;
  write?: (line: string) => void;
  clock?: Clock;
  // whether a server answers GET /health at this url
  probe?: (url: string) => Promise<boolean>;
  remove?: (path: string) => Promise<void>;
};

async function healthProbe(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(3_000) });
    return response.ok;
  } catch {
    return false;
  }
}

// a file already gone is purged; any other failure is the purge's
async function removeFile(path: string): Promise<void> {
  try {
    await rm(path);
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return;
    throw error;
  }
}

function backendFor(platform: string, home: string): ServiceBackend {
  if (platform === "darwin") return launchdBackend({ home });
  throw new ServiceError(`service is not supported on ${platform} yet`);
}

function resolveDeps(deps: ServiceDeps) {
  const home = deps.home ?? homedir();
  return {
    home,
    main: deps.main ?? Bun.main,
    execPath: deps.execPath ?? process.execPath,
    cwd: deps.cwd ?? process.cwd(),
    backend:
      deps.backend ?? backendFor(deps.platform ?? process.platform, home),
    write: deps.write ?? ((line: string) => console.log(line)),
    sleep: sleeper(deps.clock ?? wallClock),
    probe: deps.probe ?? healthProbe,
    remove: deps.remove ?? removeFile,
  };
}

type Resolved = ReturnType<typeof resolveDeps>;

function logPath(dataDir: string): string {
  return join(dataDir, "markets.log");
}

function configOf(args: string[], home: string): Config | null {
  const cli = parseCli(args, home);
  return cli.kind === "run" ? cli.config : null;
}

// install writes the binary's absolute path and every option, --data
// included, so a definition without them is torn or not ours
function storedConfig(args: string[], home: string): Config | null {
  const [binary, ...options] = args;
  if (binary === undefined || !isAbsolute(binary)) return null;
  if (!options.includes("--data")) return null;
  return configOf(options, home);
}

// where a client on this machine reaches the server
function urlOf(config: Config): string {
  let host = config.hostname;
  if (host === "0.0.0.0" || host === "::" || host === "[::]") {
    host = "127.0.0.1";
  } else if (host.includes(":") && !host.startsWith("[")) host = `[${host}]`;
  return `http://${host}:${config.port}`;
}

async function waitForHealth(url: string, r: Resolved): Promise<void> {
  for (let attempt = 0; attempt < HEALTH_ATTEMPTS; attempt++) {
    // another listener on the port answers too: the job must have a process
    if (
      (await r.probe(`${url}/health`)) &&
      ((await r.backend.state())?.pid ?? null) !== null
    ) {
      r.write(`1ctx-markets up at ${url}`);
      return;
    }
    await r.sleep(HEALTH_POLL_MS);
  }
  throw new ServiceError(`1ctx-markets did not come up at ${url}`);
}

async function installedConfig(r: Resolved): Promise<{
  args: string[] | null;
  config: Config | null;
}> {
  const args = await r.backend.installed();
  const config = args === null ? null : storedConfig(args, r.home);
  return { args, config };
}

async function stored(r: Resolved): Promise<Config> {
  const { args, config } = await installedConfig(r);
  if (args === null) throw new ServiceError("service is not installed");
  if (config === null) throw new ServiceError("service definition is invalid");
  return config;
}

async function install(argv: string[], r: Resolved): Promise<void> {
  if (r.main.endsWith(".ts")) {
    throw new ServiceError("service install needs the compiled binary");
  }
  // --restart is the switch wherever it cannot be a value, which is
  // anywhere but right after a flag that takes one
  const flags: string[] = [];
  let restart = false;
  for (const [i, argument] of argv.entries()) {
    const value = i > 0 && VALUED_FLAGS.includes(argv[i - 1]!);
    if (argument === "--restart" && !value) restart = true;
    else flags.push(argument);
  }
  const cli = parseCli(flags, r.home);
  if (cli.kind === "error") throw new ServiceError(cli.message);
  if (cli.kind !== "run") {
    throw new ServiceError("service install takes the server's options");
  }
  // the service starts elsewhere, so a relative path is pinned to where
  // it was typed
  const dataDir = isAbsolute(cli.config.dataDir)
    ? cli.config.dataDir
    : resolve(r.cwd, cli.config.dataDir);
  const config: Config = { ...cli.config, dataDir };
  if ((await r.backend.loaded()) && !restart) {
    throw new ServiceError("service is running; use install --restart");
  }
  await r.backend.install({
    programArguments: [r.execPath, ...configToArgs(config)],
    home: r.home,
    workingDirectory: dataDir,
    logPath: logPath(dataDir),
    exitTimeout: EXIT_TIMEOUT,
  });
  await waitForHealth(urlOf(config), r);
}

async function start(r: Resolved): Promise<void> {
  const config = await stored(r);
  if (await r.backend.loaded()) {
    throw new ServiceError("service is already running");
  }
  await r.backend.start();
  await waitForHealth(urlOf(config), r);
}

async function restart(r: Resolved): Promise<void> {
  const config = await stored(r);
  await r.backend.stop();
  await r.backend.start();
  await waitForHealth(urlOf(config), r);
}

async function status(r: Resolved): Promise<void> {
  const { args, config } = await installedConfig(r);
  const state = await r.backend.state();
  const url = config === null ? null : urlOf(config);
  const health =
    state === null || url === null
      ? "-"
      : (await r.probe(`${url}/health`))
        ? "ok"
        : "no answer";
  const fallback = args === null ? "not installed" : "stopped";
  const invalid = args !== null && config === null;
  r.write(
    [
      `service: ${r.backend.name}`,
      `state: ${invalid ? "invalid definition" : (state?.state ?? fallback)}`,
      `pid: ${state?.pid ?? "-"}`,
      `binary: ${state?.program ?? args?.[0] ?? "-"}`,
      `health: ${health}`,
      `url: ${url ?? "-"}`,
      `data: ${config?.dataDir ?? "-"}`,
    ].join("\n"),
  );
}

async function uninstall(purge: boolean, r: Resolved): Promise<void> {
  const { args, config } = await installedConfig(r);
  // a definition that names no readable data directory is never guessed
  // at: purge would remove the wrong files
  if (purge && args !== null && config === null) {
    throw new ServiceError(
      "service definition is invalid; uninstall without --purge",
    );
  }
  if (purge) {
    // the definition goes last, so a purge cut short can be run again on
    // the same directory
    await r.backend.stop();
    // nothing installed: the default directory, as a bare start uses
    const purged = config ?? configOf([], r.home)!;
    const db = dbPath(purged);
    const log = logPath(purged.dataDir);
    for (const path of [db, `${db}-shm`, `${db}-wal`, log, `${log}.1`]) {
      try {
        await r.remove(path);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new ServiceError(`could not remove ${path}: ${reason}`);
      }
    }
  }
  await r.backend.remove();
  r.write(`uninstalled ${r.backend.name}${purge ? " and purged data" : ""}`);
}

export async function runService(
  argv: string[],
  deps: ServiceDeps = {},
): Promise<void> {
  const [command, ...rest] = argv;
  const known = ["install", "status", "start", "stop", "restart", "uninstall"];
  if (command === undefined || !known.includes(command)) {
    throw new ServiceError(USAGE);
  }
  const r = resolveDeps(deps);
  try {
    if (command === "install") return await install(rest, r);
    if (command === "uninstall") {
      if (rest.length === 0) return await uninstall(false, r);
      if (rest.length === 1 && rest[0] === "--purge") {
        return await uninstall(true, r);
      }
      throw new ServiceError(USAGE);
    }
    if (rest.length > 0) throw new ServiceError(USAGE);
    if (command === "status") return await status(r);
    if (command === "start") return await start(r);
    if (command === "restart") return await restart(r);
    await r.backend.stop();
    r.write(`stopped ${r.backend.name}`);
  } catch (error) {
    if (error instanceof ServiceError) throw error;
    // the manager's own words: a launchctl failure, a file it could not write
    throw new ServiceError(
      error instanceof Error ? error.message : String(error),
    );
  }
}
