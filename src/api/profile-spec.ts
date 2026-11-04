// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// The profile routes' part of the spec, for people reading the docs page.

import { MAX_EDITS } from "../document/edit.ts";
import { KEPT_REVISIONS, MAX_DOCUMENT_BYTES } from "../document/store.ts";
import { PROBLEM_TYPE } from "./http.ts";
import { bool, int, list, object, ref, type Schema, str } from "./schemas.ts";

const nstr: Schema = { type: ["string", "null"] };
const nint: Schema = { type: ["integer", "null"] };
const note = (s: Schema, description: string): Schema => ({
  ...s,
  description,
});

const READS = [{ profileRead: [] }, { admin: [] }, { session: [] }];
const WRITES = [{ profileWrite: [] }, { admin: [] }, { session: [] }];

const r = (name: string) => ({ $ref: `#/components/responses/${name}` });
const content = (schema: Schema) => ({ "application/json": { schema } });
const ok = (description: string, schema: Schema) => ({
  description,
  content: content(schema),
});
const err = (description: string) => ({
  description,
  content: { [PROBLEM_TYPE]: { schema: ref("Problem") } },
});
const lines = (...parts: string[]) => parts.join("\n");

const base = (extra: object = {}) => ({
  400: r("BadArguments"),
  401: r("Unauthorized"),
  403: err(
    "A key without profile access, or one that reads only on a write (`forbidden`).",
  ),
  429: r("TooMany"),
  500: r("Internal"),
  ...extra,
});

const tags = ["profile"];

const revisionInfo = {
  revision: int,
  author: note(str, "`web`, `admin` or the agent key's name."),
  bytes: note(int, "The text's size in UTF-8 bytes."),
  updated_at: note(str, "When this revision was saved."),
};

const profile = object({
  text: note(nstr, "The Markdown as saved; null with no profile yet."),
  html: note(
    nstr,
    "The text drawn as HTML on the server: no raw HTML, only http, https and mailto links, images shown as text.",
  ),
  revision: nint,
  author: nstr,
  bytes: nint,
  updated_at: nstr,
});

export const profileSchemas: Record<string, Schema> = {
  Profile: profile,
  ProfileRevision: object(revisionInfo),
  ProfileSaved: object(
    {
      ...revisionInfo,
      unchanged: note(
        bool,
        "The text equals the live one: nothing is saved and the live revision is answered.",
      ),
    },
    Object.keys(revisionInfo),
  ),
  ProfileRevisions: object({ revisions: list(ref("ProfileRevision")) }),
  ProfilePreview: object({
    text: note(
      str,
      "The draft: well-formed UTF-8 with no NUL. The size cap applies only on save.",
    ),
  }),
  ProfileDrawn: object({
    html: note(str, "The draft drawn as `GET /profile` draws a saved text."),
  }),
  ProfileSave: object(
    {
      revision: note(
        int,
        "The revision read. Left out only for the first save, when there is no profile yet.",
      ),
      text: note(str, "The whole document, for a replace."),
      edits: note(
        list(object({ old: str, new: str })),
        `1 to ${MAX_EDITS} pairs, for an edit: each \`old\` matches once in that revision's text, all apply or none.`,
      ),
    },
    [],
  ),
};

export const profilePaths = {
  "/profile": {
    get: {
      tags,
      operationId: "profile",
      security: READS,
      summary: "The owner's profile",
      description:
        "How the owner invests: goals, risk, trading style, rules and analysis defaults, one Markdown document, with its HTML and its live revision. Every field is null with no profile yet.",
      responses: base({ 200: ok("The profile.", ref("Profile")) }),
    },
    put: {
      tags,
      operationId: "saveProfile",
      security: WRITES,
      summary: "Save the profile",
      description: lines(
        "Replaces the text (`text`) or changes part of it (`edits`), as a new revision. Answers the revision, never the text.",
        "",
        "- Every save names the revision it read; a stale one is refused (409) with the live `revision`.",
        `- The text is well-formed UTF-8 with no NUL, at most ${MAX_DOCUMENT_BYTES / 1024} KiB, and its tool read must fit one answer.`,
        "- A text equal to the live one saves nothing and answers the live revision with `unchanged`.",
        `- The last ${KEPT_REVISIONS} revisions are kept. The profile is never deleted.`,
      ),
      requestBody: { required: true, content: content(ref("ProfileSave")) },
      responses: base({
        200: ok("The revision saved.", ref("ProfileSaved")),
        409: err(
          "The revision sent is not the live one, or there is none yet (`conflict`, with the live `revision`, null with none).",
        ),
        413: r("TooLarge"),
        415: r("UnsupportedType"),
      }),
    },
  },
  "/profile/preview": {
    post: {
      tags,
      operationId: "previewProfile",
      security: WRITES,
      summary: "Draw a draft of the profile",
      description:
        "The web UI editor's Preview: the text drawn as HTML as a save would draw it. Nothing is saved and no revision is made.",
      requestBody: { required: true, content: content(ref("ProfilePreview")) },
      responses: base({
        200: ok("The draft drawn.", ref("ProfileDrawn")),
        413: r("TooLarge"),
        415: r("UnsupportedType"),
      }),
    },
  },
  "/profile/versions": {
    get: {
      tags,
      operationId: "profileVersions",
      security: READS,
      summary: "The profile's kept revisions",
      description: `The last ${KEPT_REVISIONS} revisions, newest first, without their text.`,
      responses: base({
        200: ok("The revisions.", ref("ProfileRevisions")),
      }),
    },
  },
  "/profile/versions/{revision}": {
    parameters: [
      {
        name: "revision",
        in: "path",
        description: "The revision's number.",
        required: true,
        schema: int,
      },
    ],
    get: {
      tags,
      operationId: "profileVersion",
      security: READS,
      summary: "One revision of the profile",
      description:
        "That revision's text and HTML. To restore it, save its text with the live revision.",
      responses: base({
        200: ok("The revision.", ref("Profile")),
        404: err(
          `No such revision, or one no longer kept (\`not_found\`): the last ${KEPT_REVISIONS} are.`,
        ),
      }),
    },
  },
};
