// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { HELP, KNOWN_SOURCES, parseCli } from "../src/config.ts";

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
