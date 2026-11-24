// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// called at a test file's top: its folders go once the file is done, never
// after each test, since tests run side by side
export function tempDirs(): (prefix: string) => string {
  const made: string[] = [];
  afterAll(() => {
    for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  return (prefix) => {
    const d = mkdtempSync(join(tmpdir(), prefix));
    made.push(d);
    return d;
  };
}
