// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// The analysis routes' part of the spec, for people reading the docs page.

import { DEFAULT_PAGE, MAX_PAGE } from "../admin/http.ts";
import { MAX_EDITS } from "../document/edit.ts";
import { KEPT_REVISIONS, MAX_DOCUMENT_BYTES } from "../document/store.ts";
import { PROBLEM_TYPE } from "./http.ts";
import { SYMBOL, symbolParam } from "./paths.ts";
import { int, list, num, object, ref, type Schema, str } from "./schemas.ts";

const nstr: Schema = { type: ["string", "null"] };
const nint: Schema = { type: ["integer", "null"] };
const nnum: Schema = { type: ["number", "null"] };
const note = (s: Schema, description: string): Schema => ({
  ...s,
  description,
});

const READS = [{ analysisRead: [] }, { admin: [] }, { session: [] }];
const WRITES = [{ analysisWrite: [] }, { admin: [] }, { session: [] }];

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
    "A key without analysis access, or one that reads only on a write (`forbidden`).",
  ),
  429: r("TooMany"),
  500: r("Internal"),
  ...extra,
});

// a symbol resolves as every read resolves it, fetched when new
const resolved = (extra: object = {}) =>
  base({ 404: r("NotFound"), 503: r("Unavailable"), ...extra });

const tags = ["analysis"];

const revisionInfo = {
  revision: int,
  author: note(
    str,
    "The person and the agent key's name, as `Ana (claude-code)`; the person's name for a web UI save, `admin` for the admin key.",
  ),
  bytes: note(int, "The text's size in UTF-8 bytes."),
  written_at: note(str, "When this revision was saved."),
};

const STATUS: Schema = {
  type: "string",
  enum: ["scheduled", "awaiting results", "reported"],
};

const since = note(
  {
    ...object({
      price: note(num, "The stored quote's price when it was saved."),
      currency: nstr,
      priced_at: note(
        nstr,
        "When that price traded; when it was fetched for a quote with no trade time.",
      ),
      price_now: note(nnum, "The stored quote's price now."),
      fetched_at: note(nstr, "When the quote now was fetched."),
      change_percent: note(
        nnum,
        "The move from the price then to the price now, in percent, on today's share count; null when the currency changed or either price is missing.",
      ),
      splits: note(
        list(object({ date: str, ratio: num })),
        "The splits dated after the price's day; the price then is divided by their ratios before the move is measured.",
      ),
      earnings: list(object({ date: str, hour: str, status: STATUS })),
    }),
    type: ["object", "null"],
  },
  "What changed since it was written, measured, never judged: null when no quote was stored at the save. `earnings` lists the stored earnings dated from the save's day to today.",
);

const analysis = object({
  text: note(nstr, "The Markdown as saved; null with no analysis yet."),
  html: note(
    nstr,
    "The text drawn as HTML on the server: no raw HTML, only http, https and mailto links, images shown as text.",
  ),
  revision: nint,
  author: nstr,
  written_at: nstr,
  bytes: nint,
  since_written: since,
});

export const analysisSchemas: Record<string, Schema> = {
  Analysis: analysis,
  AnalysisRevision: object(revisionInfo),
  AnalysisSaved: object(
    {
      ...revisionInfo,
      unchanged: note(
        { type: "boolean" },
        "The text equals the live one: nothing is saved and the live revision is answered.",
      ),
    },
    Object.keys(revisionInfo),
  ),
  AnalysisRevisions: object({ revisions: list(ref("AnalysisRevision")) }),
  AnalysisListed: object({
    id: note(str, "The instrument's id."),
    ...revisionInfo,
  }),
  AnalysisList: object(
    {
      analyses: list(ref("AnalysisListed")),
      next_page_token: note(
        str,
        "Present while more follow: send it as `page_token`.",
      ),
    },
    ["analyses"],
  ),
  AnalysisSave: object(
    {
      revision: note(
        int,
        "The revision read. Left out only for the symbol's first save.",
      ),
      text: note(str, "The whole analysis, for a replace."),
      edits: note(
        list(object({ old: str, new: str })),
        `1 to ${MAX_EDITS} pairs, for an edit: each \`old\` matches once in that revision's text, all apply or none.`,
      ),
    },
    [],
  ),
  AnalysisPreview: object({
    text: note(
      str,
      "The draft: well-formed UTF-8 with no NUL. The size cap applies only on save.",
    ),
  }),
  AnalysisDrawn: object({
    html: note(
      str,
      "The draft drawn as `GET /instruments/{symbol}/analysis` draws a saved text.",
    ),
  }),
};

const symbol = symbolParam(SYMBOL);
const P = "/instruments/{symbol}/analysis";

export const analysisPaths = {
  [P]: {
    parameters: [symbol],
    get: {
      tags,
      operationId: "analysis",
      security: READS,
      summary: "A symbol's analysis",
      description:
        "An agent's dated analysis of the symbol, shared by everyone on this server: one Markdown document, with its HTML, its live revision and the price move since it was written. Every field is null with no analysis yet.",
      responses: resolved({ 200: ok("The analysis.", ref("Analysis")) }),
    },
    put: {
      tags,
      operationId: "saveAnalysis",
      security: WRITES,
      summary: "Save a symbol's analysis",
      description: lines(
        "Replaces the text (`text`) or changes part of it (`edits`), as a new revision that everyone on this server reads. Answers the revision, never the text.",
        "",
        "- About the symbol only: never holdings, quantities, cost, gains or the owner's profile.",
        "- Every save names the revision it read; a stale one is refused (409) with the live `revision`.",
        `- The text is well-formed UTF-8 with no NUL, at most ${MAX_DOCUMENT_BYTES / 1024} KiB, and its tool read must fit one answer.`,
        "- A text equal to the live one saves nothing and answers the live revision with `unchanged`.",
        `- The last ${KEPT_REVISIONS} revisions are kept. An analysis is never deleted.`,
      ),
      requestBody: { required: true, content: content(ref("AnalysisSave")) },
      responses: resolved({
        200: ok("The revision saved.", ref("AnalysisSaved")),
        409: err(
          "The revision sent is not the live one, or there is none yet (`conflict`, with the live `revision`, null with none).",
        ),
        413: r("TooLarge"),
        415: r("UnsupportedType"),
      }),
    },
  },
  [`${P}/preview`]: {
    parameters: [symbol],
    post: {
      tags,
      operationId: "previewAnalysis",
      security: WRITES,
      summary: "Draw a draft of an analysis",
      description:
        "The web UI editor's Preview: the text drawn as HTML as a save would draw it. Nothing is saved and no revision is made.",
      requestBody: { required: true, content: content(ref("AnalysisPreview")) },
      responses: base({
        200: ok("The draft drawn.", ref("AnalysisDrawn")),
        413: r("TooLarge"),
        415: r("UnsupportedType"),
      }),
    },
  },
  [`${P}/versions`]: {
    parameters: [symbol],
    get: {
      tags,
      operationId: "analysisVersions",
      security: READS,
      summary: "A symbol's kept analysis revisions",
      description: `The last ${KEPT_REVISIONS} revisions, newest first, without their text.`,
      responses: resolved({
        200: ok("The revisions.", ref("AnalysisRevisions")),
      }),
    },
  },
  [`${P}/versions/{revision}`]: {
    parameters: [
      symbol,
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
      operationId: "analysisVersion",
      security: READS,
      summary: "One revision of a symbol's analysis",
      description:
        "That revision's text and HTML, with the move since it was saved. To restore it, save its text with the live revision.",
      responses: resolved({
        200: ok("The revision.", ref("Analysis")),
        404: err(
          `No such symbol, revision, or one no longer kept (\`not_found\`): the last ${KEPT_REVISIONS} are.`,
        ),
      }),
    },
  },
  "/analysis": {
    get: {
      tags,
      operationId: "listAnalyses",
      security: READS,
      summary: "The symbols with an analysis",
      description:
        "Each symbol's live revision, newest first, without its text. A fund's is listed only to one who holds or priced it.",
      parameters: [
        {
          name: "page_size",
          in: "query",
          description: `1 to ${MAX_PAGE}. Default: ${DEFAULT_PAGE}.`,
          schema: int,
        },
        {
          name: "page_token",
          in: "query",
          description: "The `next_page_token` of the page before.",
          schema: str,
        },
      ],
      responses: base({ 200: ok("The analyses.", ref("AnalysisList")) }),
    },
  },
};
