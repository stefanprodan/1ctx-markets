// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import type { ServiceDefinition } from "../src/service/backend.ts";
import {
  type LaunchdFiles,
  launchdBackend,
  parseLaunchdPrint,
  type Spawn,
} from "../src/service/launchd.ts";
import { type FakeClock, fakeClock } from "./helpers/clock.ts";
import { drive } from "./helpers/drive.ts";

const HOME = "/home/u";
const PLIST = "/home/u/Library/LaunchAgents/dev.1ctx.markets.plist";
const LOG = "/home/u/.1ctx-markets/markets.log";

const definition: ServiceDefinition = {
  programArguments: [
    "/home/u/.1ctx-markets/bin/1ctx-markets",
    "--listen",
    "127.0.0.1:11238",
  ],
  home: HOME,
  workingDirectory: "/home/u/.1ctx-markets",
  logPath: LOG,
  exitTimeout: 45,
};

// steps the fake clock from timer to timer until p settles
const settle = <T>(clock: FakeClock, p: Promise<T>) =>
  drive(clock, { due: () => clock.next() }, p);

function result(code = 0, stdout = "", stderr = "") {
  return { code, stdout, stderr };
}

function memoryFiles(events: string[], initial: Record<string, string> = {}) {
  const held = new Map(Object.entries(initial));
  const files: LaunchdFiles = {
    mkdir: async () => {},
    write: async (path, data) => {
      events.push(`write:${path}`);
      held.set(path, data);
    },
    read: async (path) => held.get(path) ?? null,
    size: async (path) => held.get(path)?.length ?? null,
    rename: async (from, to) => {
      events.push(`rename:${from}:${to}`);
      const value = held.get(from);
      if (value === undefined) throw new Error(`missing ${from}`);
      held.set(to, value);
      held.delete(from);
    },
    remove: async (path) => {
      events.push(`remove:${path}`);
      held.delete(path);
    },
  };
  return { files, held };
}

// launchctl over a loaded flag: print answers while loaded, bootout
// unloads, bootstrap loads
function launchctl(events: string[], start: { loaded: boolean }): Spawn {
  const job = { ...start };
  return async (argv) => {
    events.push(argv.slice(1).join(" "));
    if (argv[1] === "print") {
      return job.loaded ? result(0, "state = running\npid = 42") : result(113);
    }
    if (argv[1] === "bootout") job.loaded = false;
    if (argv[1] === "bootstrap") job.loaded = true;
    return result();
  };
}

describe("parseLaunchdPrint", () => {
  test("reads the state, the pid and the program", () => {
    expect(
      parseLaunchdPrint(
        [
          "dev.1ctx.markets = {",
          "\tstate = running",
          '\tprogram = "/Users/u/.1ctx-markets/bin/1ctx-markets"',
          "\tpid = 4711",
          "}",
        ].join("\n"),
      ),
    ).toEqual({
      state: "running",
      pid: 4711,
      program: "/Users/u/.1ctx-markets/bin/1ctx-markets",
    });
  });

  test("a job that is not running has no pid", () => {
    expect(parseLaunchdPrint("state = not running")).toEqual({
      state: "not running",
      pid: null,
      program: null,
    });
  });
});

describe("launchd backend", () => {
  test("install stages, stops, renames, then starts", async () => {
    const events: string[] = [];
    const { files, held } = memoryFiles(events, { [PLIST]: "old plist" });
    const backend = launchdBackend({
      home: HOME,
      uid: 501,
      spawn: launchctl(events, { loaded: true }),
      files,
      alive: () => false,
      clock: fakeClock(),
    });

    await backend.install(definition);

    expect(events).toEqual([
      `write:${PLIST}.tmp`,
      "print gui/501/dev.1ctx.markets",
      "bootout gui/501/dev.1ctx.markets",
      "print gui/501/dev.1ctx.markets",
      `rename:${PLIST}.tmp:${PLIST}`,
      `bootstrap gui/501 ${PLIST}`,
    ]);
    expect(await backend.installed()).toEqual(definition.programArguments);
    expect(held.get(PLIST)).toContain("<string>dev.1ctx.markets</string>");
    expect(held.get(PLIST)).toContain(`<string>${LOG}</string>`);
    expect(held.get(PLIST)).toContain("<key>HOME</key>");
    expect(held.get(PLIST)).toContain(
      "<key>ExitTimeOut</key>\n  <integer>45</integer>",
    );
  });

  test("a staged plist that reads back wrong stops nothing", async () => {
    const events: string[] = [];
    const { files } = memoryFiles(events, { [PLIST]: "old plist" });
    const backend = launchdBackend({
      home: HOME,
      uid: 501,
      spawn: launchctl(events, { loaded: true }),
      files: { ...files, read: async () => "torn" },
    });

    await expect(backend.install(definition)).rejects.toThrow(
      "did not read back intact",
    );
    expect(events).toEqual([`write:${PLIST}.tmp`, `remove:${PLIST}.tmp`]);
  });

  test("a log past the limit is rotated between the stop and the start", async () => {
    const events: string[] = [];
    const { files, held } = memoryFiles(events);
    const backend = launchdBackend({
      home: HOME,
      uid: 501,
      spawn: launchctl(events, { loaded: false }),
      files: {
        ...files,
        size: async (path) => (path === LOG ? 9 * 1024 * 1024 : null),
        rename: async (from, to) => {
          events.push(`rename:${from}:${to}`);
          if (from !== LOG) held.set(to, held.get(from) ?? "");
        },
      },
    });

    await backend.install(definition);

    const rotated = events.indexOf(`rename:${LOG}:${LOG}.1`);
    expect(rotated).toBeGreaterThan(
      events.indexOf(`rename:${PLIST}.tmp:${PLIST}`),
    );
    expect(rotated).toBeLessThan(events.indexOf(`bootstrap gui/501 ${PLIST}`));
  });

  test("stop waits for the process after launchd forgot the job", async () => {
    const events: string[] = [];
    const clock = fakeClock();
    let checks = 0;
    const backend = launchdBackend({
      home: HOME,
      uid: 501,
      spawn: launchctl(events, { loaded: true }),
      files: memoryFiles(events).files,
      clock,
      alive: (pid) => {
        expect(pid).toBe(42);
        return ++checks < 3;
      },
    });

    await settle(clock, backend.stop());

    expect(checks).toBe(3);
    expect(clock.next()).toBeNull();
  });

  test("stop gives up on a process that never exits", async () => {
    const clock = fakeClock();
    const backend = launchdBackend({
      home: HOME,
      uid: 501,
      spawn: launchctl([], { loaded: true }),
      files: memoryFiles([]).files,
      alive: () => true,
      clock,
    });

    await expect(settle(clock, backend.stop())).rejects.toThrow(
      "timed out waiting for dev.1ctx.markets to exit",
    );
  });

  test("a launchctl print that fails for another reason is an error", async () => {
    const backend = launchdBackend({
      home: HOME,
      uid: 501,
      spawn: async () => result(1, "", "Could not find service: not permitted"),
      files: memoryFiles([]).files,
    });

    await expect(backend.stop()).rejects.toThrow("not permitted");
    await expect(backend.install(definition)).rejects.toThrow("not permitted");
  });

  test("stop on a service that is not loaded does nothing", async () => {
    const events: string[] = [];
    const backend = launchdBackend({
      home: HOME,
      uid: 501,
      spawn: launchctl(events, { loaded: false }),
      files: memoryFiles(events).files,
    });

    await backend.stop();

    expect(events).toEqual(["print gui/501/dev.1ctx.markets"]);
  });

  test("start retries once on launchd's error 5", async () => {
    let attempts = 0;
    const clock = fakeClock();
    const backend = launchdBackend({
      home: HOME,
      uid: 501,
      spawn: async () =>
        ++attempts === 1
          ? result(5, "", "Bootstrap failed: 5: Input/output error")
          : result(),
      files: memoryFiles([]).files,
      clock,
    });

    await settle(clock, backend.start());

    expect(attempts).toBe(2);
  });

  test("a launchctl failure carries its words", async () => {
    const backend = launchdBackend({
      home: HOME,
      uid: 501,
      spawn: async () => result(37, "", "Operation already in progress"),
      files: memoryFiles([]).files,
    });

    await expect(backend.start()).rejects.toThrow(
      "Operation already in progress",
    );
  });

  test("remove stops the job and forgets the plist", async () => {
    const events: string[] = [];
    const { files, held } = memoryFiles(events, { [PLIST]: "x" });
    const backend = launchdBackend({
      home: HOME,
      uid: 501,
      spawn: launchctl(events, { loaded: true }),
      files,
      alive: () => false,
    });

    await backend.remove();

    expect(held.has(PLIST)).toBe(false);
    expect(await backend.installed()).toBeNull();
    expect(await backend.loaded()).toBe(false);
  });
});
