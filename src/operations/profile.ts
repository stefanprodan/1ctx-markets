// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// The profile's reads and writes the tools and REST share. Its text is in
// no answer but its own and in no log line: logs carry revision and bytes.

import type { Revision } from "../document/read.ts";
import {
  KEPT_REVISIONS,
  type RevisionInfo,
  type Save,
  type Saved,
} from "../document/store.ts";
import { iso } from "../market/format.ts";
import { MAKE_ONE, NO_PROFILE, profileRead } from "../profile/read.ts";
import {
  liveRevision,
  profileVersion,
  profileVersions,
  readProfile,
  saveProfile,
} from "../profile/store.ts";
import {
  errorResult,
  type Failure,
  type ToolResult,
  textResult,
} from "./answer.ts";
import { ArgError, fields, textValues } from "./args.ts";
import { actionOf, parseWrite, revisionOf } from "./document.ts";
import type { Markets } from "./markets.ts";
import { opens, type Who } from "./who.ts";

export const PROFILE_READS = ["read", "versions", "version"] as const;
export const PROFILE_WRITES = ["edit", "replace"] as const;

export type ProfileReadArgs =
  | { action: "read" }
  | { action: "versions" }
  | { action: "version"; revision: number };

const NO_READ = "this key has no profile access; its owner grants it";
const NO_WRITE = "this key reads the profile only; its owner grants write";

const forbidden = (write: boolean): Failure => ({
  error: "forbidden",
  message: write ? NO_WRITE : NO_READ,
});

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

export function parseProfileEdit(input: unknown): Save {
  const f = textValues(fields(input, ["action", "revision", "edits", "text"]), {
    ids: ["revision"],
  });
  return parseWrite(f, PROFILE_WRITES);
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
export function missingRevision(
  m: Markets,
  owner: string,
  revision: number,
): Failure {
  const live = liveRevision(m.db, owner);
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
  const done = await saveProfile(
    m.writer,
    who.user,
    save,
    who.name,
    m.clock.now(),
  );
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
      return textResult(read(who, readProfile(m.db, who.user)));
    case "versions":
      return textResult(
        JSON.stringify({
          revisions: profileVersions(m.db, who.user).map(revisionItem),
        }),
      );
    case "version": {
      const r = profileVersion(m.db, who.user, args.revision);
      if (r === null) {
        return errorResult(missingRevision(m, who.user, args.revision));
      }
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
