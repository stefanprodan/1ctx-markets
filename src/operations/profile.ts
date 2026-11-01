// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// The profile's reads and writes the tools and REST share. Its text is in
// no answer but its own and in no log line: logs carry revision and bytes.

import { iso } from "../market/format.ts";
import { MAX_EDITS, type ProfileEdit } from "../profile/edit.ts";
import {
  MAKE_ONE,
  NO_PROFILE,
  profileRead,
  type Revision,
} from "../profile/read.ts";
import {
  KEPT_REVISIONS,
  liveRevision,
  profileVersion,
  profileVersions,
  type RevisionInfo,
  readProfile,
  type Save,
  type Saved,
  saveProfile,
} from "../profile/store.ts";
import {
  errorResult,
  type Failure,
  type ToolResult,
  textResult,
} from "./answer.ts";
import { ArgError, fields, quoted, textValues } from "./args.ts";
import type { Markets } from "./markets.ts";
import { opens, type Who } from "./who.ts";

export const PROFILE_READS = ["read", "versions", "version"] as const;
export const PROFILE_WRITES = ["edit", "replace"] as const;

export type ProfileReadArgs =
  | { action: "read" }
  | { action: "versions" }
  | { action: "version"; revision: number };

const NO_READ = "this key has no profile access; the admin grants it";
const NO_WRITE = "this key reads the profile only; the admin grants write";

const forbidden = (write: boolean): Failure => ({
  error: "forbidden",
  message: write ? NO_WRITE : NO_READ,
});

export function revisionOf(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new ArgError("revision must be a positive integer");
  }
  return value;
}

// a request body's cap: 50 pairs of a 24 KiB profile's lines fit in it
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

function editsOf(sent: unknown): ProfileEdit[] {
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

function actionOf<T extends string>(value: unknown, actions: readonly T[]): T {
  if (typeof value !== "string" || !actions.includes(value as T)) {
    throw new ArgError(`action must be one of ${actions.join(", ")}`);
  }
  return value as T;
}

export function parseProfileRead(input: unknown): ProfileReadArgs {
  const f = textValues(fields(input, ["action", "revision"]), {
    ids: ["revision"],
  });
  const action = actionOf(f.action, PROFILE_READS);
  if (action !== "version") {
    if (f.revision !== undefined) {
      throw new ArgError(`revision is not an argument of ${action}`);
    }
    return { action };
  }
  return { action, revision: revisionOf(f.revision) };
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

export function parseProfileEdit(input: unknown): Save {
  const f = textValues(fields(input, ["action", "revision", "edits", "text"]), {
    ids: ["revision"],
  });
  const action = actionOf(f.action, PROFILE_WRITES);
  if (action === "edit" && f.edits === undefined) {
    throw new ArgError("edit takes revision and edits");
  }
  if (action === "replace" && f.text === undefined) {
    throw new ArgError("replace takes text, and revision once one exists");
  }
  const save = parseSave(f);
  if (save.action !== action) {
    throw new ArgError(
      `${action === "edit" ? "text" : "edits"} is not an argument of ${action}`,
    );
  }
  return save;
}

export const revisionItem = (r: RevisionInfo) => ({
  revision: r.revision,
  author: r.author,
  bytes: r.bytes,
  updated_at: iso(r.createdAt),
});

export const savedItem = (s: Saved) => ({
  ...revisionItem(s.saved),
  ...(s.unchanged ? { unchanged: true } : {}),
});

// an evicted revision says why it is gone, so an agent stops looking
export function missingRevision(m: Markets, revision: number): Failure {
  const live = liveRevision(m.db);
  return {
    error: "not_found",
    message:
      live !== null && revision < live
        ? `revision ${revision} is no longer kept; the last ${KEPT_REVISIONS} are`
        : `no revision ${revision}`,
  };
}

export async function saveAnswer(
  m: Markets,
  who: Who,
  save: Save,
): Promise<Saved | Failure> {
  const done = await saveProfile(m.writer, save, who.name, m.clock.now());
  if ("error" in done) return done;
  if (!done.unchanged) {
    m.log.info("profile saved", {
      revision: done.saved.revision,
      bytes: done.saved.bytes,
    });
  }
  return done;
}

const read = (who: Who, r: Revision | null): string =>
  r === null
    ? `${NO_PROFILE}${who.profile === "write" ? MAKE_ONE : ""}`
    : profileRead(r);

export async function profileAnswer(
  m: Markets,
  who: Who,
  args: ProfileReadArgs | Save,
): Promise<ToolResult> {
  const writes = args.action === "edit" || args.action === "replace";
  if (!opens(who.profile, writes)) return errorResult(forbidden(writes));
  switch (args.action) {
    case "read":
      return textResult(read(who, readProfile(m.db)));
    case "versions":
      return textResult(
        JSON.stringify({ revisions: profileVersions(m.db).map(revisionItem) }),
      );
    case "version": {
      const r = profileVersion(m.db, args.revision);
      if (r === null) return errorResult(missingRevision(m, args.revision));
      return textResult(profileRead(r));
    }
    case "edit":
    case "replace": {
      const done = await saveAnswer(m, who, args);
      if ("error" in done) return errorResult(done);
      return textResult(JSON.stringify(savedItem(done)));
    }
  }
}
