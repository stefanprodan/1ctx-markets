// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { OPERATOR, type Who } from "../src/operations/who.ts";
import { call, tools } from "../src/tools/index.ts";
import { mcpClient, seedKey, withApp } from "./helpers/app.ts";
import { listing, world } from "./helpers/world.ts";

const SKILL = join(import.meta.dir, "..", "skills", "market-analysis");

// Answer fields and values the skill names, checked in review; every other
// backticked name must be a tool, an argument or an argument's value.
const ANSWER_FIELDS = [
  "since_written",
  "price_now",
  "splits",
  "status",
  "reported",
  "conflict",
  "unavailable",
];

const EVERY = {
  portfolio: "write",
  alerts: "write",
  profile: "write",
  analysis: "write",
} as const;

type Listed = { name: string; inputSchema: unknown };

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? files(join(dir, e.name))
      : e.name.endsWith(".md")
        ? [join(dir, e.name)]
        : [],
  );
}

// the fence lines go first, so a template's inline names are read too
const text = files(SKILL)
  .map((f) => readFileSync(f, "utf8").replace(/^```.*$/gm, ""))
  .join("\n");

// a dotted path is checked a part at a time; anything not name-shaped is prose
const named = new Set(
  [...text.matchAll(/`([^`\n]+)`/g)]
    .flatMap((m) => m[1]!.split("."))
    .filter((x) => /^[a-z][a-z0-9_]*$/.test(x)),
);

// every property name and every enum value at any depth
function schemaWords(schema: unknown, into = new Set<string>()) {
  if (schema === null || typeof schema !== "object") return into;
  const s = schema as Record<string, unknown>;
  if (Array.isArray(s.enum)) {
    for (const v of s.enum) if (typeof v === "string") into.add(v);
  }
  if (s.properties && typeof s.properties === "object") {
    for (const [name, sub] of Object.entries(s.properties)) {
      into.add(name);
      schemaWords(sub, into);
    }
  }
  if (s.items) schemaWords(s.items, into);
  return into;
}

// a field the skill reads as `answer.field`, so a rename breaks the build
const pathsUnder = (head: string): string[] => [
  ...new Set(
    [...text.matchAll(new RegExp(`\`${head}\\.([a-z_]+)\``, "g"))].map(
      (m) => m[1]!,
    ),
  ),
];

const WRITER: Who = {
  name: "skill-agent",
  user: OPERATOR,
  credential: { kind: "key", id: "skill-agent" },
  portfolio: "none",
  alerts: "none",
  profile: "none",
  analysis: "write",
};

const actionsOf = (tool: Listed): string[] =>
  (tool.inputSchema as { properties: { action: { enum: string[] } } })
    .properties.action.enum;

// as a client sees them, so a tool no key lists counts as gone
async function listed(fn: (tools: Listed[]) => void) {
  await withApp(async (t) => {
    const client = await mcpClient(t, seedKey(t, "every", EVERY));
    const { tools } = await client.listTools();
    await client.close();
    fn(tools);
  });
}

describe("the market analysis skill", () => {
  test("names only tools the server lists, their arguments and values", () =>
    listed((tools) => {
      const names = new Set(tools.map((x) => x.name));
      const words = new Set<string>();
      for (const tool of tools) schemaWords(tool.inputSchema, words);
      for (const tool of ["analysis", "analysis_edit", "quote", "research"]) {
        expect(named).toContain(tool);
      }
      const unknown = [...named].filter(
        (x) => !names.has(x) && !words.has(x) && !ANSWER_FIELDS.includes(x),
      );
      expect(unknown).toEqual([]);
    }));

  test("names only actions its analysis tools take", () =>
    listed((tools) => {
      const pairs = [
        ...text.matchAll(/`(analysis(?:_edit)?)` `([a-z_]+)`/g),
      ].map((m) => [m[1]!, m[2]!] as const);
      for (const tool of ["analysis", "analysis_edit"]) {
        expect(pairs.some(([t]) => t === tool)).toBe(true);
      }
      const unknown = pairs.filter(
        ([tool, action]) =>
          !actionsOf(tools.find((x) => x.name === tool)!).includes(action),
      );
      expect(unknown).toEqual([]);
    }));

  test("reads only fields the answers carry", async () => {
    const { db, m } = world();
    listing(db, "US:MADE", { live: { atr14: 2 } });
    const run = (name: string, args: Record<string, unknown>) =>
      call(m, tools(m).find((t) => t.name === name)!, args, WRITER);

    const quoted = JSON.parse(
      (await run("quote", { symbols: ["US:MADE"] })).content[0]!.text,
    );
    // the due rule measures a move in ATRs from this row
    expect(quoted.items[0].signals.daily).toHaveProperty("atr14");

    await run("analysis_edit", {
      action: "replace",
      symbol: "US:MADE",
      text: "# MADE, 2026-10-23\n\nA made-up note.\n",
    });
    const read = (await run("analysis", { action: "read", symbol: "US:MADE" }))
      .content[0]!.text;
    const line = read.split("\n").find((l) => l.startsWith("since_written: "));
    const since = JSON.parse(line!.slice("since_written: ".length));
    const fields = pathsUnder("since_written");
    expect(fields.length).toBeGreaterThan(0);
    for (const field of fields) {
      expect(since).toHaveProperty(field);
    }
  });
});
