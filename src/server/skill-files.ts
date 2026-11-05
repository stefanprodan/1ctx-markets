// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// Imported as a macro: runs at build time, so the binary carries the files.

import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

// every file under skills/, keyed <skill>/<path> with / separators; a dot
// file (Finder's .DS_Store, an editor's swap) is never the skill's
export function skillFiles(): Record<string, string> {
  const root = join(import.meta.dir, "..", "..", "skills");
  const files: Record<string, string> = {};
  for (const e of readdirSync(root, { recursive: true, withFileTypes: true })) {
    if (!e.isFile()) continue;
    const path = join(e.parentPath, e.name);
    const key = relative(root, path).split(sep).join("/");
    if (key.split("/").some((part) => part.startsWith("."))) continue;
    try {
      files[key] = new TextDecoder("utf-8", { fatal: true }).decode(
        readFileSync(path),
      );
    } catch {
      // Bun reports a macro's throw without its message
      const why = `skills/${key} is not UTF-8 text`;
      console.error(why);
      throw new Error(why);
    }
  }
  return files;
}
