// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The macOS backend: a LaunchAgent of the signed-in user, driven through
// launchctl. Every effect is injected, so a test runs it on any platform.

import {
  chmod,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname } from "node:path";
import { type Clock, wallClock } from "../clock.ts";
import type {
  ServiceBackend,
  ServiceDefinition,
  ServiceState,
} from "./backend.ts";
import {
  type PlistSpec,
  plistPath,
  programArguments,
  renderPlist,
} from "./plist.ts";

export const LABEL = "dev.1ctx.markets";
// how long a stop waits for the exit; above the kill timeout
// (EXIT_TIMEOUT in service.ts), so launchd's kill lands inside it
export const WAIT_MS = 60_000;

export type SpawnResult = { code: number; stdout: string; stderr: string };
export type Spawn = (argv: string[]) => Promise<SpawnResult>;

export interface LaunchdFiles {
  mkdir(path: string): Promise<void>;
  write(path: string, data: string): Promise<void>;
  // null when the file does not exist
  read(path: string): Promise<string | null>;
  size(path: string): Promise<number | null>;
  rename(from: string, to: string): Promise<void>;
  remove(path: string): Promise<void>;
}

export type LaunchdDeps = {
  home: string;
  uid?: number;
  spawn?: Spawn;
  clock?: Clock;
  files?: LaunchdFiles;
  // is this pid still a process; injected so tests never signal one
  alive?: (pid: number) => boolean;
};

const POLL_MS = 1_000;
const BOOTSTRAP_RETRY_MS = 1_000;
const LOG_LIMIT = 8 * 1024 * 1024;
const NOT_FOUND = 113;

async function bunSpawn(argv: string[]): Promise<SpawnResult> {
  const child = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, stdout: stdout.trim(), stderr: stderr.trim() };
}

function missing(error: unknown): boolean {
  return (error as { code?: string }).code === "ENOENT";
}

export const diskFiles: LaunchdFiles = {
  mkdir: async (path) => {
    await mkdir(path, { recursive: true });
  },
  // launchd refuses a plist others can write, whatever the umask made it
  write: async (path, data) => {
    await writeFile(path, data, { mode: 0o644 });
    await chmod(path, 0o644);
  },
  read: async (path) => {
    try {
      return await readFile(path, "utf8");
    } catch (error) {
      if (missing(error)) return null;
      throw error;
    }
  },
  size: async (path) => {
    try {
      return (await stat(path)).size;
    } catch (error) {
      if (missing(error)) return null;
      throw error;
    }
  },
  rename,
  remove: (path) => rm(path, { force: true }),
};

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM is somebody else's live process; only ESRCH means gone
    return (error as { code?: string }).code === "EPERM";
  }
}

export function sleeper(clock: Clock): (ms: number) => Promise<void> {
  return (ms) =>
    new Promise<void>((resolve) => {
      clock.at(clock.now() + ms, resolve);
    });
}

function integer(output: string, name: string): number | null {
  const match = new RegExp(`^\\s*${name}\\s*=\\s*(-?\\d+)\\s*$`, "im").exec(
    output,
  );
  return match ? Number(match[1]) : null;
}

export function parseLaunchdPrint(output: string): ServiceState {
  return {
    state: /^\s*state\s*=\s*(.+?)\s*$/im.exec(output)?.[1] ?? null,
    pid: integer(output, "pid"),
    program:
      /^\s*program\s*=\s*(.+?)\s*$/im
        .exec(output)?.[1]
        ?.replace(/^"|"$/g, "") ?? null,
  };
}

export function launchdBackend(deps: LaunchdDeps): ServiceBackend {
  const spawn = deps.spawn ?? bunSpawn;
  const uid = deps.uid ?? process.getuid?.() ?? 0;
  const clock = deps.clock ?? wallClock;
  const sleep = sleeper(clock);
  const files = deps.files ?? diskFiles;
  const alive = deps.alive ?? processAlive;
  const path = plistPath(LABEL, deps.home);
  const target = `gui/${uid}/${LABEL}`;

  function failure(argv: string[], result: SpawnResult): Error {
    const detail = result.stderr || result.stdout || `exit ${result.code}`;
    return new Error(`${argv.join(" ")}: ${detail}`);
  }

  // launchctl answers 113 for a label it does not hold; any other failure
  // is launchd's own trouble, never a sign the job is gone
  async function state(): Promise<ServiceState | null> {
    const argv = ["launchctl", "print", target];
    const result = await spawn(argv);
    if (result.code === 0) return parseLaunchdPrint(result.stdout);
    if (result.code === NOT_FOUND) return null;
    throw failure(argv, result);
  }

  // Gone means both: launchd has dropped the label, and the process it
  // ran has exited. launchd forgets the job while the server is still
  // draining its writes and holding the port, and a bootstrap into that
  // window fails.
  async function waitForExit(pid: number | null): Promise<void> {
    const gone = async () =>
      (await state()) === null && (pid === null || !alive(pid));
    const started = clock.now();
    while (clock.now() - started < WAIT_MS) {
      if (await gone()) return;
      await sleep(POLL_MS);
    }
    if (await gone()) return;
    throw new Error(`timed out waiting for ${LABEL} to exit`);
  }

  async function stop(): Promise<void> {
    // read before the bootout: afterwards launchd no longer knows the pid
    const before = await state();
    if (before === null) return;
    const argv = ["launchctl", "bootout", target];
    const result = await spawn(argv);
    if (result.code !== 0) throw failure(argv, result);
    await waitForExit(before.pid);
  }

  async function start(): Promise<void> {
    const argv = ["launchctl", "bootstrap", `gui/${uid}`, path];
    let result = await spawn(argv);
    // launchd answers 5 for a moment after a bootout of the same label
    if (
      result.code !== 0 &&
      `${result.stdout}\n${result.stderr}`.includes("Bootstrap failed: 5")
    ) {
      await sleep(BOOTSTRAP_RETRY_MS);
      result = await spawn(argv);
    }
    if (result.code !== 0) throw failure(argv, result);
  }

  // launchd holds the log open while the service runs, so it is rotated
  // only here, between the stop and the start, to one .1
  async function rotate(logPath: string): Promise<void> {
    const size = await files.size(logPath);
    if (size === null || size < LOG_LIMIT) return;
    await files.remove(`${logPath}.1`);
    await files.rename(logPath, `${logPath}.1`);
  }

  async function install(definition: ServiceDefinition): Promise<void> {
    const spec: PlistSpec = {
      label: LABEL,
      programArguments: definition.programArguments,
      workingDirectory: definition.workingDirectory,
      environmentVariables: { HOME: definition.home },
      runAtLoad: true,
      keepAlive: true,
      throttleInterval: 5,
      exitTimeOut: definition.exitTimeout,
      standardOutPath: definition.logPath,
      standardErrorPath: definition.logPath,
    };
    const rendered = renderPlist(spec);
    // staged beside the live plist and read back before anything stops,
    // so a bad write never takes a running service down
    const staged = `${path}.tmp`;
    try {
      await files.mkdir(dirname(path));
      await files.mkdir(dirname(definition.logPath));
      await files.write(staged, rendered);
      const back = await files.read(staged);
      if (back !== rendered) {
        throw new Error(`staged plist did not read back intact: ${staged}`);
      }
      const parsed = programArguments(back);
      if (
        parsed.length !== spec.programArguments.length ||
        parsed.some((argument, i) => argument !== spec.programArguments[i])
      ) {
        throw new Error(`staged plist has invalid ProgramArguments: ${staged}`);
      }
    } catch (error) {
      await files.remove(staged).catch(() => undefined);
      throw error;
    }
    await stop();
    await files.rename(staged, path);
    await rotate(definition.logPath);
    await start();
  }

  return {
    name: LABEL,
    installed: async () => {
      const xml = await files.read(path);
      return xml === null ? null : programArguments(xml);
    },
    loaded: async () => (await state()) !== null,
    install,
    start,
    stop,
    remove: async () => {
      await stop();
      await files.remove(path);
      await files.remove(`${path}.tmp`);
    },
    state,
  };
}
