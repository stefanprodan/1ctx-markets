// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import {
  INSTRUCTIONS,
  INSTRUCTIONS_BYTES,
} from "../src/server/instructions.ts";
import { mcpClient, withApp } from "./helpers/app.ts";

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
  "currency",
  "unit",
  "previous_close",
];

// the text goes to every user: no one's holdings, place or workspace
const DENIED = [
  "portfolio",
  "holding",
  "1ctx",
  "project",
  "Bucharest",
  "BVB",
  "Romania",
];

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

const backticked = () =>
  new Set([...INSTRUCTIONS.matchAll(/`([^`]+)`/g)].map((m) => m[1]!));

describe("the server instructions", () => {
  test("are sent on initialize, under the byte cap", () =>
    withApp(async (t) => {
      const client = await mcpClient(t);
      expect(client.getInstructions()).toBe(INSTRUCTIONS);
      await client.close();
      expect(Buffer.byteLength(INSTRUCTIONS)).toBeLessThanOrEqual(
        INSTRUCTIONS_BYTES,
      );
    }));

  test("route between tools first and say what is not held last", () => {
    const at = GROUPS.map((g) => INSTRUCTIONS.indexOf(g));
    for (const i of at) expect(i).toBeGreaterThanOrEqual(0);
    expect(at).toEqual([...at].sort((a, b) => a - b));
    expect(INSTRUCTIONS.indexOf("`quote`")).toBeLessThan(at[1]!);
  });

  test("name every registered tool and only its arguments", () =>
    withApp(async (t) => {
      const client = await mcpClient(t);
      const { tools } = await client.listTools();
      await client.close();
      const names = new Set(tools.map((x) => x.name));
      const args = new Set<string>();
      for (const tool of tools) propertyNames(tool.inputSchema, args);

      const named = backticked();
      for (const tool of names) expect(named).toContain(tool);
      for (const field of ANSWER_FIELDS) {
        expect(named).toContain(field);
        // an argument is checked against the schemas, never listed here
        expect(args.has(field) || names.has(field)).toBe(false);
      }
      const unknown = [...named].filter(
        (x) => !names.has(x) && !args.has(x) && !ANSWER_FIELDS.includes(x),
      );
      expect(unknown).toEqual([]);
    }));

  test("name no holding, place or workspace", () => {
    for (const word of DENIED) {
      expect(INSTRUCTIONS.toLowerCase()).not.toContain(word.toLowerCase());
    }
  });
});
