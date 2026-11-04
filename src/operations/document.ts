// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// The arguments both documents' tools and routes take, kept as sent.

import { type Edit, MAX_EDITS } from "../document/edit.ts";
import type { Save } from "../document/store.ts";
import { ArgError, quoted } from "./args.ts";

export function revisionOf(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new ArgError("revision must be a positive integer");
  }
  return value;
}

// a request body's cap: 50 pairs of a 24 KiB document's lines fit in it
export const MAX_EDITS_BYTES = 64 * 1024;

// edits sent as JSON text are that list, as rules reads a condition sent so;
// text that does not parse is refused as any other non-list
function editsJson(value: unknown): unknown {
  if (typeof value !== "string" || !value.trim().startsWith("[")) {
    return value;
  }
  // the size limit before parsing, so no large text is walked
  if (Buffer.byteLength(value) > MAX_EDITS_BYTES) {
    throw new ArgError(`edits is longer than ${MAX_EDITS_BYTES} bytes`);
  }
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function editsOf(sent: unknown): Edit[] {
  const value = editsJson(sent);
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_EDITS) {
    throw new ArgError(
      `edits must be a list of 1 to ${MAX_EDITS} {old, new} pairs`,
    );
  }
  return value.map((e, i) => {
    const name = `edit ${i + 1}`;
    if (typeof e !== "object" || e === null || Array.isArray(e)) {
      throw new ArgError(`${name}: must be {old, new}`);
    }
    for (const key of Object.keys(e)) {
      if (key !== "old" && key !== "new") {
        throw new ArgError(`${name}: unknown field ${quoted(key)}`);
      }
    }
    const pair = e as Record<string, unknown>;
    if (typeof pair.old !== "string" || typeof pair.new !== "string") {
      throw new ArgError(`${name}: old and new must be strings`);
    }
    return { old: pair.old, new: pair.new };
  });
}

export function actionOf<T extends string>(
  value: unknown,
  actions: readonly T[],
): T {
  if (typeof value !== "string" || !actions.includes(value as T)) {
    throw new ArgError(`action must be one of ${actions.join(", ")}`);
  }
  return value as T;
}

// text, old and new are kept as sent: never trimmed, never cut
export function parseSave(f: Record<string, unknown>): Save {
  if (f.edits !== undefined && f.text !== undefined) {
    throw new ArgError("give text or edits, not both");
  }
  if (f.edits !== undefined) {
    if (f.revision === undefined) {
      throw new ArgError("edit needs the revision it read");
    }
    return {
      action: "edit",
      revision: revisionOf(f.revision),
      edits: editsOf(f.edits),
    };
  }
  if (typeof f.text !== "string") throw new ArgError("text must be a string");
  return {
    action: "replace",
    revision:
      f.revision === undefined || f.revision === null
        ? null
        : revisionOf(f.revision),
    text: f.text,
  };
}

// a tool's write: its action names text or edits, never both
export function parseWrite(
  f: Record<string, unknown>,
  actions: readonly ("edit" | "replace")[],
  more = "",
): Save {
  const action = actionOf(f.action, actions);
  if (action === "edit" && f.edits === undefined) {
    throw new ArgError(`edit takes ${more}revision and edits`);
  }
  if (action === "replace" && f.text === undefined) {
    throw new ArgError(
      `replace takes ${more}text, and revision once one exists`,
    );
  }
  const save = parseSave(f);
  if (save.action !== action) {
    throw new ArgError(
      `${action === "edit" ? "text" : "edits"} is not an argument of ${action}`,
    );
  }
  return save;
}
