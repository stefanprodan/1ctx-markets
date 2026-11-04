// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import {
  configToArgs,
  HELP,
  KNOWN_SOURCES,
  parseCli,
} from "../src/runtime/config.ts";

describe("--source", () => {
  test("turns a keyless source on, each named once", () => {
    const cli = parseCli(["--source", "bvb", "--source", "bvb"], "/home/x");
    expect(cli.kind).toBe("run");
    if (cli.kind === "run") expect(cli.config.sources).toEqual(["bvb"]);
    const none = parseCli([], "/home/x");
    if (none.kind === "run") expect(none.config.sources).toEqual([]);
  });

  test("an unknown name stops the start with the list of known names", () => {
    expect(parseCli(["--source", "nyse"], "/home/x")).toEqual({
      kind: "error",
      message: `unknown source nyse; known sources: ${KNOWN_SOURCES.join(", ")}`,
    });
    expect(parseCli(["--source"], "/home/x")).toEqual({
      kind: "error",
      message: "--source needs a value",
    });
  });

  test("the help names every known source", () => {
    for (const name of KNOWN_SOURCES) expect(HELP).toContain(name);
    expect(HELP).toContain("--source <name>");
  });
});

describe("--track", () => {
  test("is no flag: World markets is tracked in its place", () => {
    expect(parseCli(["--track", "^GSPC"], "/home/x")).toEqual({
      kind: "error",
      message: "unknown option --track",
    });
    expect(HELP).not.toContain("--track ");
  });
});

describe("--no-ui", () => {
  test("the UI is on unless the flag turns it off, and a service keeps it", () => {
    const on = parseCli([], "/home/x");
    if (on.kind !== "run") throw new Error(on.kind);
    expect(on.config.ui).toBe(true);
    expect(configToArgs(on.config)).not.toContain("--no-ui");
    const off = parseCli(["--no-ui"], "/home/x");
    if (off.kind !== "run") throw new Error(off.kind);
    expect(off.config.ui).toBe(false);
    expect(configToArgs(off.config)).toContain("--no-ui");
    expect(parseCli(configToArgs(off.config), "/home/y")).toEqual(off);
    expect(HELP).toContain("--no-ui");
  });
});

describe("--no-sync", () => {
  test("sync is on unless the flag turns it off, and a service keeps it", () => {
    const on = parseCli([], "/home/x");
    if (on.kind !== "run") throw new Error(on.kind);
    expect(on.config.sync).toBe(true);
    expect(configToArgs(on.config)).not.toContain("--no-sync");
    const off = parseCli(["--no-sync"], "/home/x");
    if (off.kind !== "run") throw new Error(off.kind);
    expect(off.config.sync).toBe(false);
    expect(configToArgs(off.config)).toContain("--no-sync");
    expect(parseCli(configToArgs(off.config), "/home/y")).toEqual(off);
    expect(HELP).toContain("--no-sync");
  });
});

describe("service arguments", () => {
  test("a config written out reads back unchanged", () => {
    const cli = parseCli(
      [
        "--listen",
        "0.0.0.0:9000",
        "--data",
        "/d",
        "--quote-every",
        "3",
        "--track-days",
        "12",
        "--source",
        "bvb",
      ],
      "/home/x",
    );
    if (cli.kind !== "run") throw new Error(cli.kind);
    expect(parseCli(configToArgs(cli.config), "/home/y")).toEqual(cli);
  });

  test("service is a command of its own, parsed by the service", () => {
    expect(parseCli(["service", "install", "--nope"], "/home/x")).toEqual({
      kind: "service",
      argv: ["install", "--nope"],
    });
    expect(HELP).toContain("1ctx-markets service install");
  });
});
