// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ServiceBackend,
  ServiceDefinition,
} from "../src/service/backend.ts";
import {
  runService,
  type ServiceDeps,
  ServiceError,
} from "../src/service/index.ts";
import { launchdBackend, WAIT_MS } from "../src/service/launchd.ts";
import { renderPlist } from "../src/service/plist.ts";
import { EXIT_TIMEOUT } from "../src/service/service.ts";
import { fakeClock } from "./helpers/clock.ts";
import { drive } from "./helpers/drive.ts";

const HOME = "/home/u";
const DATA = "/home/u/.1ctx-markets";
const BIN = "/home/u/.1ctx-markets/bin/1ctx-markets";
const STORED = [BIN, "--data", DATA];

function fake(
  start: { args?: string[] | null; loaded?: boolean; pid?: number | null } = {},
) {
  const calls: string[] = [];
  const held = { args: start.args ?? null, loaded: start.loaded ?? false };
  let definition: ServiceDefinition | null = null;
  const backend: ServiceBackend = {
    name: "fake.service",
    installed: async () => held.args,
    loaded: async () => held.loaded,
    install: async (next) => {
      calls.push("install");
      definition = next;
      held.args = next.programArguments;
      held.loaded = true;
    },
    start: async () => {
      calls.push("start");
      held.loaded = true;
    },
    stop: async () => {
      calls.push("stop");
      held.loaded = false;
    },
    remove: async () => {
      calls.push("remove");
      held.args = null;
      held.loaded = false;
    },
    state: async () =>
      held.loaded
        ? {
            state: start.pid === null ? "spawn scheduled" : "running",
            pid: start.pid === undefined ? 7 : start.pid,
            program: BIN,
          }
        : null,
  };
  return { backend, calls, definition: () => definition };
}

function deps(backend: ServiceBackend, more: Partial<ServiceDeps> = {}) {
  const lines: string[] = [];
  const probed: string[] = [];
  const removed: string[] = [];
  const clock = fakeClock();
  const all: ServiceDeps = {
    home: HOME,
    main: "/$bunfs/root/1ctx-markets",
    execPath: BIN,
    cwd: "/work",
    backend,
    clock,
    write: (line) => lines.push(line),
    probe: async (url) => {
      probed.push(url);
      return true;
    },
    remove: async (path) => {
      removed.push(path);
    },
    ...more,
  };
  // the health wait sleeps on the fake clock, stepped timer by timer
  const run = (argv: string[]) =>
    drive(clock, { due: () => clock.next() }, runService(argv, all));
  return { all, run, lines, probed, removed };
}

describe("service install", () => {
  test("writes every server option and waits for health", async () => {
    const { backend, definition } = fake();
    const { run, lines, probed } = deps(backend);

    await run(["install", "--source", "bvb"]);

    expect(definition()).toEqual({
      programArguments: [
        BIN,
        "--listen",
        "127.0.0.1:11238",
        "--data",
        DATA,
        "--quote-every",
        "5",
        "--track-days",
        "30",
        "--source",
        "bvb",
      ],
      home: HOME,
      workingDirectory: DATA,
      logPath: `${DATA}/markets.log`,
      exitTimeout: EXIT_TIMEOUT,
    });
    expect(probed).toEqual(["http://127.0.0.1:11238/health"]);
    expect(lines).toEqual(["1ctx-markets up at http://127.0.0.1:11238"]);
  });

  test("the kill timeout covers a source call's timeout and the drain", () => {
    // a call already sent ends within 30 s, then the writer drains
    expect(EXIT_TIMEOUT).toBeGreaterThan(30);
    expect(EXIT_TIMEOUT * 1_000).toBeLessThan(WAIT_MS);
  });

  test("pins a relative data directory to where it was typed", async () => {
    const { backend, definition } = fake();
    const { run } = deps(backend);

    await run([
      "install",
      "--data",
      "data/markets",
      "--listen",
      "0.0.0.0:9000",
      "--quote-every",
      "2",
      "--track-days",
      "7",
    ]);

    expect(definition()?.programArguments.slice(1)).toEqual([
      "--listen",
      "0.0.0.0:9000",
      "--data",
      "/work/data/markets",
      "--quote-every",
      "2",
      "--track-days",
      "7",
    ]);
    expect(definition()?.workingDirectory).toBe("/work/data/markets");
    expect(definition()?.logPath).toBe("/work/data/markets/markets.log");
  });

  test("refuses what the server would refuse, before touching anything", async () => {
    const { backend, calls } = fake();
    const { run } = deps(backend);

    await expect(run(["install", "--nope"])).rejects.toThrow(
      "unknown option --nope",
    );
    await expect(run(["install", "--listen", "h:0"])).rejects.toThrow(
      "--listen port must be 1 to 65535",
    );
    await expect(run(["install", "--source", "nyse"])).rejects.toThrow(
      "unknown source nyse",
    );
    await expect(run(["install", "--quote-every", "0"])).rejects.toThrow(
      "--quote-every must be a whole number above 0",
    );
    await expect(run(["install", "--data", ""])).rejects.toThrow(
      "--data is empty",
    );
    await expect(run(["install", "-v"])).rejects.toThrow(
      "takes the server's options",
    );
    expect(calls).toEqual([]);
  });

  test("--restart is the switch anywhere it cannot be a value", async () => {
    const { backend, calls, definition } = fake({ args: STORED, loaded: true });
    const { run } = deps(backend);

    await run(["install", "--restart", "--listen", "h:1"]);
    await run(["install", "--listen", "h:1", "--restart"]);
    expect(calls).toEqual(["install", "install"]);
    // right after --data it is the directory's name, and no switch
    await expect(run(["install", "--data", "--restart"])).rejects.toThrow(
      "service is running; use install --restart",
    );
    expect(definition()?.programArguments).not.toContain("--restart");
  });

  test("a second install replaces the first", async () => {
    const { backend, calls, definition } = fake();
    const { run } = deps(backend);

    await run(["install", "--source", "bvb"]);
    await expect(run(["install"])).rejects.toThrow(
      "service is running; use install --restart",
    );
    await run(["install", "--restart", "--track-days", "9"]);

    expect(calls).toEqual(["install", "install"]);
    expect(definition()?.programArguments).not.toContain("--source");
    expect(definition()?.programArguments.slice(-2)).toEqual([
      "--track-days",
      "9",
    ]);
  });

  test("needs the compiled binary", async () => {
    const { backend } = fake();
    const { run } = deps(backend, { main: "/repo/src/main.ts" });

    await expect(run(["install"])).rejects.toThrow("needs the compiled binary");
  });

  test("waits for health until the server answers", async () => {
    const { backend } = fake();
    let asked = 0;
    const { run, lines } = deps(backend, { probe: async () => ++asked > 3 });

    await run(["install"]);

    expect(asked).toBe(4);
    expect(lines).toEqual(["1ctx-markets up at http://127.0.0.1:11238"]);
  });

  test("a health answer from a job with no process is not up", async () => {
    const { backend } = fake({ pid: null });
    const { run, lines } = deps(backend);

    await expect(run(["install"])).rejects.toThrow(
      "1ctx-markets did not come up at http://127.0.0.1:11238",
    );
    expect(lines).toEqual([]);
  });

  test("a server that never answers is an error", async () => {
    const { backend } = fake();
    const { run } = deps(backend, { probe: async () => false });

    await expect(run(["install"])).rejects.toThrow(
      "1ctx-markets did not come up at http://127.0.0.1:11238",
    );
  });
});

describe("service start, stop, restart", () => {
  const args = [BIN, "--listen", "[::1]:9000", "--data", "/d"];

  test("start reads the address from the stored arguments", async () => {
    const { backend, calls } = fake({ args });
    const { run, lines, probed } = deps(backend);

    await run(["start"]);

    expect(calls).toEqual(["start"]);
    expect(probed).toEqual(["http://[::1]:9000/health"]);
    expect(lines).toEqual(["1ctx-markets up at http://[::1]:9000"]);
  });

  test("start refuses when nothing is installed or it already runs", async () => {
    await expect(deps(fake().backend).run(["start"])).rejects.toThrow(
      "service is not installed",
    );
    await expect(
      deps(fake({ args, loaded: true }).backend).run(["start"]),
    ).rejects.toThrow("service is already running");
  });

  test("restart stops, then starts", async () => {
    const { backend, calls } = fake({ args, loaded: true });

    await deps(backend).run(["restart"]);

    expect(calls).toEqual(["stop", "start"]);
  });

  test("stop names the service", async () => {
    const { backend } = fake({ args, loaded: true });
    const { run, lines } = deps(backend);

    await run(["stop"]);

    expect(lines).toEqual(["stopped fake.service"]);
  });

  test("stored arguments the server would refuse are an error", async () => {
    const { backend } = fake({ args: [BIN, "--gone"] });

    await expect(deps(backend).run(["start"])).rejects.toThrow(
      "service definition is invalid",
    );
  });
});

describe("service status", () => {
  test("reads the definition back", async () => {
    const { backend } = fake();
    const { run, lines } = deps(backend);
    await run(["install", "--listen", "0.0.0.0:9000", "--data", "/d"]);
    lines.length = 0;

    await run(["status"]);

    expect(lines[0]!.split("\n")).toEqual([
      "service: fake.service",
      "state: running",
      "pid: 7",
      `binary: ${BIN}`,
      "health: ok",
      "url: http://127.0.0.1:9000",
      "data: /d",
    ]);
  });

  test("a running server that does not answer says so", async () => {
    const { backend } = fake({ args: STORED, loaded: true });
    const { run, lines } = deps(backend, { probe: async () => false });

    await run(["status"]);

    expect(lines[0]).toContain("health: no answer");
  });

  test("stopped asks no server", async () => {
    const { backend } = fake({ args: STORED });
    const { run, lines, probed } = deps(backend);

    await run(["status"]);

    expect(lines[0]).toContain("state: stopped");
    expect(lines[0]).toContain("health: -");
    expect(lines[0]).toContain(`data: ${DATA}`);
    expect(probed).toEqual([]);
  });

  test("not installed", async () => {
    const { run, lines } = deps(fake().backend);

    await run(["status"]);

    expect(lines[0]).toContain("state: not installed");
    expect(lines[0]).toContain("url: -");
  });
});

describe("service uninstall", () => {
  const args = [BIN, "--data", "/data/m"];

  test("keeps the data", async () => {
    const { backend, calls } = fake({ args, loaded: true });
    const { run, lines, removed } = deps(backend);

    await run(["uninstall"]);

    expect(calls).toEqual(["remove"]);
    expect(removed).toEqual([]);
    expect(lines).toEqual(["uninstalled fake.service"]);
  });

  test("--purge refuses a definition it cannot read", async () => {
    const { backend, calls } = fake({ args: [BIN, "--gone"] });
    const { run, removed } = deps(backend);

    await expect(run(["uninstall", "--purge"])).rejects.toThrow(
      "uninstall without --purge",
    );
    expect(calls).toEqual([]);
    expect(removed).toEqual([]);
    await run(["uninstall"]);
    expect(calls).toEqual(["remove"]);
  });

  test("--purge removes the database and the log, never the secrets", async () => {
    const { backend } = fake({ args });
    const { run, removed } = deps(backend);

    await run(["uninstall", "--purge"]);

    expect(removed).toEqual([
      "/data/m/markets.db",
      "/data/m/markets.db-shm",
      "/data/m/markets.db-wal",
      "/data/m/markets.log",
      "/data/m/markets.log.1",
    ]);
  });

  test("--purge with nothing installed removes the default directory's", async () => {
    const { run, removed } = deps(fake().backend);

    await run(["uninstall", "--purge"]);

    expect(removed[0]).toBe(`${DATA}/markets.db`);
    expect(removed.some((path) => path.includes("secrets"))).toBe(false);
  });
});

describe("service definition", () => {
  test("one without the binary or --data is invalid for every reader", async () => {
    for (const args of [[], ["bin", "--data", "/d"], [BIN]]) {
      const { backend, calls } = fake({ args });
      const { run, lines, removed } = deps(backend);
      for (const argv of [["start"], ["restart"], ["uninstall", "--purge"]]) {
        await expect(run(argv)).rejects.toThrow("definition is invalid");
      }
      await run(["status"]);
      expect(lines[0]).toContain("state: invalid definition");
      expect(calls).toEqual([]);
      expect(removed).toEqual([]);
    }
  });

  test("a binary, torn or empty plist is refused by purge", async () => {
    const plist = renderPlist({
      label: "dev.1ctx.markets",
      programArguments: STORED,
    });
    for (const xml of [
      "bplist00\u0000\u0001",
      plist.slice(0, plist.indexOf("</array>") + 8),
      "",
    ]) {
      const backend = launchdBackend({
        home: HOME,
        spawn: async () => ({ code: 113, stdout: "", stderr: "" }),
        files: {
          mkdir: async () => {},
          write: async () => {},
          read: async () => xml,
          size: async () => null,
          rename: async () => {},
          remove: async () => {
            throw new Error("removed the plist");
          },
        },
      });
      const { run, removed } = deps(backend);

      await expect(run(["uninstall", "--purge"])).rejects.toThrow(
        "uninstall without --purge",
      );
      expect(removed).toEqual([]);
    }
  });
});

describe("service purge on disk", () => {
  test("a file already gone is no error", async () => {
    const dir = mkdtempSync(join(tmpdir(), "markets-purge-"));
    writeFileSync(join(dir, "markets.db"), "x");
    const { backend } = fake({ args: [BIN, "--data", dir] });
    const { all, lines } = deps(backend);
    delete all.remove;

    await runService(["uninstall", "--purge"], all);

    expect(lines).toEqual(["uninstalled fake.service and purged data"]);
    expect(await Bun.file(join(dir, "markets.db")).exists()).toBe(false);
  });

  test("a file that cannot be removed fails the purge", async () => {
    const dir = mkdtempSync(join(tmpdir(), "markets-purge-"));
    // a directory in place of the log: rm without recursion refuses it
    mkdirSync(join(dir, "markets.log", "held"), { recursive: true });
    const { backend } = fake({ args: [BIN, "--data", dir] });
    const { all, lines } = deps(backend);
    delete all.remove;

    const failed = runService(["uninstall", "--purge"], all);

    await expect(failed).rejects.toBeInstanceOf(ServiceError);
    await expect(failed).rejects.toThrow("markets.log");
    expect(lines).toEqual([]);
  });
});

describe("service command line", () => {
  test("anything else is the usage", async () => {
    const { run } = deps(fake().backend);
    for (const argv of [
      [],
      ["nope"],
      ["status", "x"],
      ["uninstall", "--all"],
    ]) {
      await expect(run(argv)).rejects.toThrow("usage: 1ctx-markets service");
    }
  });

  test("a platform without a backend says so", async () => {
    await expect(
      runService(["status"], { home: HOME, platform: "linux" }),
    ).rejects.toThrow("service is not supported on linux yet");
  });

  test("a backend failure is a service error with its words", async () => {
    const { backend } = fake({ args: STORED, loaded: true });
    backend.stop = async () => {
      throw new Error("launchctl bootout: Operation not permitted");
    };

    const failed = deps(backend).run(["stop"]);

    await expect(failed).rejects.toBeInstanceOf(ServiceError);
    await expect(failed).rejects.toThrow("Operation not permitted");
  });
});
