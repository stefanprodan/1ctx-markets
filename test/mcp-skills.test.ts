// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { SkillsClient } from "@modelcontextprotocol/client/ext/skills";
import { withApp } from "./helpers/app.ts";

const ROOT = join(import.meta.dir, "..", "skills");

// skill://<skill>/<path> → text, read from disk, not through the macro
function onDisk(): Map<string, string> {
  const out = new Map<string, string>();
  for (const e of readdirSync(ROOT, { recursive: true, withFileTypes: true })) {
    if (!e.isFile()) continue;
    const path = join(e.parentPath, e.name);
    const parts = relative(ROOT, path).split(sep);
    if (parts.some((p) => p.startsWith("."))) continue;
    out.set(`skill://${parts.join("/")}`, readFileSync(path, "utf8"));
  }
  return out;
}

const TOOLS = [
  "quote",
  "history",
  "movers",
  "search",
  "screen",
  "research",
  "events",
  "alerts",
  "alerts_edit",
];

describe("the MCP skills extension", () => {
  for (const era of ["2025-11-25", "2026-07-28"] as const) {
    test(`a ${era} client lists and reads every skill file, verified`, () =>
      withApp(async ({ url, bearer, lines }) => {
        const client = new Client(
          { name: "test", version: "1" },
          era === "2026-07-28"
            ? { versionNegotiation: { mode: { pin: era } } }
            : undefined,
        );
        await client.connect(
          new StreamableHTTPClientTransport(new URL(`${url}/mcp`), {
            requestInit: { headers: { authorization: `Bearer ${bearer}` } },
          }),
        );
        expect(client.getServerCapabilities()?.resources?.listChanged).toBe(
          false,
        );
        const skills = new SkillsClient(client);
        expect(skills.supported).toBe(true);
        const files = onDisk();
        const manifests = [...files.keys()].filter((u) =>
          u.endsWith("/SKILL.md"),
        );
        const listing = await skills.list();
        // only the 2026-07-28 era carries cache fields: the pin took
        expect(listing.ttlMs !== undefined).toBe(era === "2026-07-28");
        expect(listing.skills.map((s) => s.uri)).toEqual(manifests.sort());
        for (const skill of listing.skills) {
          const prefix = skill.uri.slice(0, -"SKILL.md".length);
          const own = [...files.keys()].filter((u) => u.startsWith(prefix));
          // published with digests, never "dynamic"; its SKILL.md is listed too
          if (skill.resources === "dynamic") throw new Error("dynamic skill");
          expect(skill.resources.map((r) => r.uri).sort()).toEqual(own.sort());
          for (const uri of own) {
            const file = await skills.read(skill, uri);
            expect([uri, file.verified]).toEqual([uri, true]);
            expect([uri, file.text]).toEqual([uri, files.get(uri)]);
          }
        }
        const resources = await client.listResources();
        expect(resources.resources.map((r) => r.uri).sort()).toEqual(
          manifests.sort(),
        );
        expect((await client.listTools()).tools.map((t) => t.name)).toEqual(
          TOOLS,
        );
        await client.close();
        expect(lines.filter((l) => l.includes("mcp skill"))).toEqual([]);
      }));
  }
});
