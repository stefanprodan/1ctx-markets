// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import {
  INSTRUCTIONS_BYTES,
  instructions,
} from "../src/server/instructions.ts";
import { ACCESS_LEVELS, mcpClient, seedKey, withApp } from "./helpers/app.ts";

const ALL = instructions({
  portfolio: "write",
  rules: "write",
  profile: "write",
});

// Backticked names that are answer fields, checked in review; every other
// backticked name must be a registered tool or one of its arguments.
const ANSWER_FIELDS = [
  "returns",
  "session",
  "final",
  "counts",
  "no_event",
  "stale",
  "unavailable",
  "listing",
  "fetched_at",
  "unit",
  "previous_close",
  "valuation",
];

// an answer field that a portfolio tool also takes as an argument, so a
// key without portfolio access reads it as the field
const SHARED_FIELDS = ["currency"];

// the text goes to every user: no one's place or workspace
const DENIED = ["1ctx", "project", "Bucharest", "BVB", "Romania"];

const GROUPS = [
  "Which tool answers what",
  "Missing is not false",
  "Symbols:",
  "Live prices:",
  "Freshness:",
  "Units:",
  "Paging:",
  "does not hold",
];

// every property name at any depth, so a filter's own keys count too
function propertyNames(schema: unknown, into = new Set<string>()) {
  if (schema === null || typeof schema !== "object") return into;
  const s = schema as Record<string, unknown>;
  if (s.properties && typeof s.properties === "object") {
    for (const [name, sub] of Object.entries(s.properties)) {
      into.add(name);
      propertyNames(sub, into);
    }
  }
  if (s.items) propertyNames(s.items, into);
  return into;
}

const backticked = (text: string) =>
  new Set([...text.matchAll(/`([^`]+)`/g)].map((m) => m[1]!));

// each access level's key, its instructions and the tools it lists
async function perKey(
  t: Parameters<Parameters<typeof withApp>[0]>[0],
  fn: (
    text: string,
    tools: { name: string; description?: string; inputSchema: unknown }[],
    level: (typeof ACCESS_LEVELS)[number],
  ) => void,
) {
  for (const level of ACCESS_LEVELS) {
    const token = seedKey(
      t,
      `${level.portfolio}-${level.rules}-${level.profile}`,
      level,
    );
    const client = await mcpClient(t, token);
    const text = client.getInstructions()!;
    const { tools } = await client.listTools();
    await client.close();
    expect([level, text]).toEqual([level, instructions(level)]);
    fn(text, tools, level);
  }
}

describe("the server instructions", () => {
  test("are sent on initialize per key, each under the byte cap", () =>
    withApp((t) =>
      perKey(t, (text) => {
        expect(Buffer.byteLength(text)).toBeLessThanOrEqual(INSTRUCTIONS_BYTES);
      }),
    ));

  test("route between tools first and say what is not held last", () => {
    const at = GROUPS.map((g) => ALL.indexOf(g));
    for (const i of at) expect(i).toBeGreaterThanOrEqual(0);
    expect(at).toEqual([...at].sort((a, b) => a - b));
    expect(ALL.indexOf("`quote`")).toBeLessThan(at[1]!);
  });

  test("name every tool the key lists and only its arguments", () =>
    withApp((t) =>
      perKey(t, (text, tools, level) => {
        const names = new Set(tools.map((x) => x.name));
        const args = new Set<string>();
        for (const tool of tools) propertyNames(tool.inputSchema, args);

        const named = backticked(text);
        // profile's description names profile_edit, for want of room here;
        // the analysis is found by its pointer in quote and research
        for (const tool of names) {
          if (["profile_edit", "analysis", "analysis_edit"].includes(tool)) {
            continue;
          }
          expect([level, named.has(tool)]).toEqual([level, true]);
        }
        for (const field of ANSWER_FIELDS) {
          expect(named).toContain(field);
          // an argument is checked against the schemas, never listed here
          expect(args.has(field) || names.has(field)).toBe(false);
        }
        const unknown = [...named].filter(
          (x) =>
            !names.has(x) &&
            !args.has(x) &&
            !ANSWER_FIELDS.includes(x) &&
            !SHARED_FIELDS.includes(x),
        );
        expect([level, unknown]).toEqual([level, []]);
      }),
    ));

  test("send a question on the owner's holdings to portfolio first", () =>
    withApp((t) =>
      perKey(t, (text, tools, level) => {
        const line = text.split("\n").find((l) => l.includes("`portfolio`"));
        const tool = tools.find((x) => x.name === "portfolio");
        if (level.portfolio === "none") {
          expect(line).toBeUndefined();
          expect(tool).toBeUndefined();
          return;
        }
        for (const said of [line!, tool!.description!]) {
          for (const words of ['"my stocks"', '"my ETF"', '"my portfolio"']) {
            expect(said).toContain(words);
          }
          expect(said).toMatch(/holdings first, then its symbols to/);
        }
        // a new owner is set up only by a key that writes
        expect(line!.includes("`portfolio_setup` makes one")).toBe(
          level.portfolio === "write",
        );
      }),
    ));

  test("name no holding, place or workspace", () => {
    for (const word of DENIED) {
      expect(ALL.toLowerCase()).not.toContain(word.toLowerCase());
    }
  });
});
