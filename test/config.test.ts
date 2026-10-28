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
