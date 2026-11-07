// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A package the release bundles cannot ship without its license.

import { expect, test } from "bun:test";
import { RELEASE } from "../scripts/build.ts";

// the last node_modules segment names the package, nested installs too
const PACKAGE = /.*node_modules\/((?:@[^/]+\/)?[^/]+)\//;

test("THIRD_PARTY_LICENSES.md names every bundled package", async () => {
  const out = await Bun.build({ ...RELEASE, metafile: true });
  if (!out.success) throw new AggregateError(out.logs, "the build failed");
  const bundled = new Set<string>();
  for (const input of Object.keys(out.metafile?.inputs ?? {})) {
    const name = PACKAGE.exec(input)?.[1];
    if (name !== undefined) bundled.add(name);
  }
  // an empty set would pass anything: the bundle always holds the MCP server
  expect(bundled).toContain("@modelcontextprotocol/server");
  const text = await Bun.file(
    new URL("../THIRD_PARTY_LICENSES.md", import.meta.url),
  ).text();
  const named = new Set(
    [...text.matchAll(/^## (\S+)$/gm)].map((m) => m[1] as string),
  );
  expect([...bundled].filter((name) => !named.has(name)).sort()).toEqual([]);
});
