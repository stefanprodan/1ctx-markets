// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import {
  type PlistSpec,
  plistPath,
  programArguments,
  renderPlist,
} from "../src/service/plist.ts";

const spec: PlistSpec = {
  label: "dev.example.a&b",
  programArguments: ["/opt/1ctx-markets", "--data", "/Users/a&b/<x>", "it's"],
  environmentVariables: { HOME: "/Users/a&b" },
  workingDirectory: "/Users/a&b/.1ctx-markets",
  runAtLoad: true,
  keepAlive: true,
  throttleInterval: 5,
  exitTimeOut: 35,
  standardOutPath: "/tmp/markets.log",
  standardErrorPath: "/tmp/markets.log",
};

describe("renderPlist", () => {
  test("renders the keys and escapes every value", () => {
    const xml = renderPlist(spec);
    expect(xml).toContain("<string>dev.example.a&amp;b</string>");
    expect(xml).toContain("/Users/a&amp;b/&lt;x&gt;");
    expect(xml).toContain("<key>RunAtLoad</key>\n  <true/>");
    expect(xml).toContain("<key>KeepAlive</key>\n  <true/>");
    expect(xml).toContain("<key>EnvironmentVariables</key>");
    expect(xml).toContain("<key>WorkingDirectory</key>");
    expect(xml).toContain("<integer>5</integer>");
    expect(xml).toContain("<key>ExitTimeOut</key>\n  <integer>35</integer>");
    expect(xml.match(/<key>Standard(?:Out|Error)Path<\/key>/g)).toHaveLength(2);
  });

  test("the program arguments read back as they went in", () => {
    expect(programArguments(renderPlist(spec))).toEqual(spec.programArguments);
  });

  test("a file that is not our plist has no arguments", () => {
    expect(programArguments("bplist00")).toEqual([]);
    expect(programArguments("<key>ProgramArguments</key><array>")).toEqual([]);
  });
});

describe("plistPath", () => {
  test("is the user's LaunchAgents directory", () => {
    expect(plistPath("dev.1ctx.markets", "/Users/test/")).toBe(
      "/Users/test/Library/LaunchAgents/dev.1ctx.markets.plist",
    );
  });
});
