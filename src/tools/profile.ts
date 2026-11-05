// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// The profile's read tool and its write tool, listed per key's access.

import { MAX_EDITS } from "../document/edit.ts";
import { MAX_DOCUMENT_BYTES } from "../document/store.ts";
import type { Markets } from "../operations/markets.ts";
import {
  PROFILE_READS,
  PROFILE_WRITES,
  parseProfileEdit,
  parseProfileRead,
  profileAnswer,
} from "../operations/profile.ts";
import { type Access, NO_ACCESS } from "../operations/who.ts";
import { schema, type Tool } from "./schema.ts";

const readDescription = (writes: boolean) =>
  `How the owner invests: goals, risk, trading style, rules and analysis defaults. Read it before any work on their portfolio, not for a quote alone. ${writes ? "Changes go through profile_edit. " : ""}read: the text and its revision. versions: the kept revisions, newest first. version: revision; that revision's text.`;

const EDIT = `Changes the owner's profile. edit, preferred: revision, edits: 1-${MAX_EDITS} {old, new}, each old found once, all or none. replace: revision and the whole text, to restructure; no revision only for the first. A stale revision is refused with the live one: read again, retry. Restore: version, then replace. At most ${MAX_DOCUMENT_BYTES / 1024} KiB. Not for trades, holdings, cash, scorecards, per-symbol calls or dated logs, nor setup's currency and time zone; date any figure that changes. Example: {"action": "edit", "revision": 7, "edits": [{"old": "Horizon: 5 years", "new": "Horizon: 10 years"}]}`;

const revision = { type: "integer", minimum: 1 } as const;

export function profileTools(m: Markets, access: Access): Tool[] {
  if (access === "none") return [];
  const read: Tool = {
    name: "profile",
    description: readDescription(access === "write"),
    inputSchema: schema(
      {
        action: { type: "string", enum: [...PROFILE_READS] },
        revision: { ...revision, description: "version: the revision to read" },
      },
      ["action"],
    ),
    run: (input, who) =>
      profileAnswer(m, who ?? NO_ACCESS, parseProfileRead(input)),
  };
  if (access === "read") return [read];
  return [
    read,
    {
      name: "profile_edit",
      description: EDIT,
      inputSchema: schema(
        {
          action: { type: "string", enum: [...PROFILE_WRITES] },
          revision: {
            ...revision,
            description:
              "the revision read; replace leaves it out only for the first",
          },
          edits: {
            type: "array",
            minItems: 1,
            maxItems: MAX_EDITS,
            items: {
              type: "object",
              properties: {
                old: { type: "string", minLength: 1 },
                new: { type: "string" },
              },
              required: ["old", "new"],
              additionalProperties: false,
            },
          },
          text: { type: "string", description: "replace: the whole document" },
        },
        ["action"],
      ),
      run: (input, who) =>
        profileAnswer(m, who ?? NO_ACCESS, parseProfileEdit(input)),
      writes: true,
    },
  ];
}
