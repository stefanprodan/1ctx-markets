// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// The trade plans routes' part of the spec, for people reading the docs page.

import { DEFAULT_PAGE, MAX_PAGE } from "../admin/http.ts";
import { MAX_EDITS } from "../document/edit.ts";
import { KEPT_REVISIONS, MAX_DOCUMENT_BYTES } from "../document/store.ts";
import { MAX_SECTIONS } from "../operations/trade-plans.ts";
import {
  LIST_STATUSES,
  MAX_ACTIVE_PLANS,
  MAX_PLAN_NAME,
  MAX_PLAN_SYMBOLS,
  PLAN_STATUSES,
} from "../trade-plans/store.ts";
import { PROBLEM_TYPE } from "./http.ts";
import {
  bool,
  int,
  list,
  object,
  ref,
  type Schema,
  str,
  values,
} from "./schemas.ts";

const nstr: Schema = { type: ["string", "null"] };
const note = (s: Schema, description: string): Schema => ({
  ...s,
  description,
});

const READS = [{ tradePlansRead: [] }, { admin: [] }, { session: [] }];
const WRITES = [{ tradePlansWrite: [] }, { admin: [] }, { session: [] }];

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
    "A key without trade plans access, or one that reads only on a write (`forbidden`).",
  ),
  429: r("TooMany"),
  500: r("Internal"),
  ...extra,
});

const NO_PLAN = err(
  "No such trade plan of yours, or one deleted when it is changed (`not_found`).",
);

const STALE = err(
  "The revision sent is not the live one (`conflict`, with the live `revision`), an active plan already holds the name, or there are already as many active plans as allowed (`conflict`).",
);

// a symbol resolves as a write resolves it, fetched when new
const SYMBOLS = {
  404: err(
    "No such trade plan, or a symbol with no listing, several listings (`candidates`) or a fund the key cannot see (`not_found`); the detail names the symbol.",
  ),
  503: err(
    "A new symbol's fetch ran past the call's deadline or its source refused (`timeout`, `rate_limited`, `source_error`): call again. Nothing is saved.",
  ),
};

const tags = ["trade plans"];

const fieldsOf = {
  id: int,
  name: note(str, "Unique among your active plans, any case."),
  status: values(["active", "archived", "removed"]),
  symbols: note(
    list(str),
    "The instruments' ids it is tagged with, in the order given.",
  ),
  review_by: note(nstr, "A date to review it by, YYYY-MM-DD."),
  review_due: note(
    bool,
    "True once your own day (your time zone, else UTC) is past `review_by`.",
  ),
  revision: int,
  updated_at: note(str, "When its live revision was saved."),
  author: note(
    str,
    "The person and the agent key's name, as `Ana (claude-code)`; the person's name for a web UI save, `admin` for the admin key.",
  ),
  bytes: note(int, "The text's size in UTF-8 bytes."),
};

const html = note(
  str,
  "The text drawn as HTML on the server: no raw HTML, only http, https and mailto links, images shown as text.",
);

const revisionState = {
  id: int,
  name: str,
  status: values([...PLAN_STATUSES]),
  symbols: list(str),
  review_by: nstr,
  revision: int,
  updated_at: note(str, "When this revision was saved."),
  author: str,
  bytes: int,
};

const section = object({
  heading: note(str, "The heading's plain text, cut at 120 characters."),
  level: int,
  line: note(int, "The heading's line in the text, from 1."),
  anchor: note(
    nstr,
    "The heading's `id` in `html`, `md-` and its words lowercased, so a link opens the section; null when none is drawn.",
  ),
});

export const tradePlansSchemas: Record<string, Schema> = {
  TradePlan: object(fieldsOf),
  TradePlanSaved: object(
    {
      ...fieldsOf,
      unchanged: note(
        { type: "boolean" },
        "The save changes nothing: no revision is made and the live one is answered.",
      ),
    },
    Object.keys(fieldsOf),
  ),
  TradePlanList: object(
    {
      plans: list(ref("TradePlan")),
      next_page_token: note(
        str,
        "Present while more follow: send it as `page_token`.",
      ),
    },
    ["plans"],
  ),
  TradePlanRead: object(
    {
      ...fieldsOf,
      created_at: note(str, "When the plan was made."),
      symbol: note(str, "The `symbol` asked, as a stored id."),
      sections: note(
        list(section),
        `With \`symbol\`: the headings whose text names it, each to the next heading of its level or higher; at most ${MAX_SECTIONS}.`,
      ),
      text: note(str, "The Markdown as saved."),
      html,
    },
    [...Object.keys(fieldsOf), "created_at", "text", "html"],
  ),
  TradePlanCreate: object(
    {
      name: note(str, `1 to ${MAX_PLAN_NAME} characters.`),
      text: note(str, "The plan, as Markdown."),
      symbols: note(
        list(str),
        `At most ${MAX_PLAN_SYMBOLS}, as \`GET /quotes\` takes them; a fund as \`fund:<ISIN>\`.`,
      ),
      review_by: note(nstr, "A date to review it by, YYYY-MM-DD."),
    },
    ["name", "text"],
  ),
  TradePlanSave: object(
    {
      revision: note(int, "The revision read."),
      text: note(str, "The whole plan, for a replace."),
      edits: note(
        list(object({ old: str, new: str })),
        `1 to ${MAX_EDITS} pairs, for an edit: each \`old\` matches once in that revision's text, all apply or none.`,
      ),
      name: note(str, `1 to ${MAX_PLAN_NAME} characters.`),
      symbols: note(
        list(str),
        `The whole list, at most ${MAX_PLAN_SYMBOLS}; empty clears it.`,
      ),
      status: values([...PLAN_STATUSES]),
      review_by: note(nstr, "YYYY-MM-DD; null clears it."),
    },
    ["revision"],
  ),
  TradePlanRevision: object({
    revision: int,
    author: str,
    updated_at: str,
    bytes: int,
    changed: note(
      {
        type: ["array", "null"],
        items: values(["text", "name", "symbols", "status", "review_by"]),
      },
      "What this revision changed from the one before it; null when that one is not kept.",
    ),
  }),
  TradePlanRevisions: object({
    id: int,
    revisions: list(ref("TradePlanRevision")),
  }),
  TradePlanVersion: object({ ...revisionState, text: str, html }),
  TradePlanPreview: object({
    text: note(
      str,
      "The draft: well-formed UTF-8 with no NUL. The size cap applies only on save.",
    ),
  }),
  TradePlanDrawn: object({
    html: note(str, "The draft drawn as `GET /trade-plans/{id}` draws a text."),
  }),
};

const id = {
  name: "id",
  in: "path",
  description: "The trade plan's id.",
  required: true,
  schema: int,
};

const P = "/trade-plans";

export const tradePlansPaths = {
  [P]: {
    get: {
      tags,
      operationId: "listTradePlans",
      security: READS,
      summary: "Your trade plans",
      description:
        "Your own trade plans, newest updated first, without their text. Never another person's, even one whose portfolios you see.",
      parameters: [
        {
          name: "status",
          in: "query",
          description: `${LIST_STATUSES.join(", ")}. Default: active. all is active and archived; a deleted plan lists only under removed.`,
          schema: values([...LIST_STATUSES]),
        },
        {
          name: "symbol",
          in: "query",
          description:
            "Only the plans tagged with it: a stored id or a symbol as written, never fetched.",
          schema: str,
        },
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
      responses: base({ 200: ok("The plans.", ref("TradePlanList")) }),
    },
    post: {
      tags,
      operationId: "createTradePlan",
      security: WRITES,
      summary: "Make a trade plan",
      description: lines(
        "A new active plan at revision 1: intent as Markdown, tagged with symbols. Never an order; its text is stored as sent and never parsed.",
        "",
        `- At most ${MAX_ACTIVE_PLANS} active plans, each name unique among them, any case.`,
        `- Symbols resolve as \`GET /quotes\` resolves them, a stored one first with no fetch; any symbol's error refuses the whole plan. At most ${MAX_PLAN_SYMBOLS}, the same instrument once.`,
        `- The text is well-formed UTF-8 with no NUL, at most ${MAX_DOCUMENT_BYTES / 1024} KiB.`,
      ),
      requestBody: {
        required: true,
        content: content(ref("TradePlanCreate")),
      },
      responses: base({
        201: ok("The plan made.", ref("TradePlan")),
        409: STALE,
        413: r("TooLarge"),
        415: r("UnsupportedType"),
        ...SYMBOLS,
      }),
    },
  },
  [`${P}/preview`]: {
    post: {
      tags,
      operationId: "previewTradePlan",
      security: WRITES,
      summary: "Draw a draft of a trade plan",
      description:
        "The web UI editor's Preview: the text drawn as HTML as a save would draw it. Nothing is saved.",
      requestBody: {
        required: true,
        content: content(ref("TradePlanPreview")),
      },
      responses: base({
        200: ok("The draft drawn.", ref("TradePlanDrawn")),
        413: r("TooLarge"),
        415: r("UnsupportedType"),
      }),
    },
  },
  [`${P}/{id}`]: {
    parameters: [id],
    get: {
      tags,
      operationId: "tradePlan",
      security: READS,
      summary: "One of your trade plans",
      description:
        "Its text, HTML and every field, a deleted one's too. With `symbol`, the headings of that symbol's sections.",
      parameters: [
        {
          name: "symbol",
          in: "query",
          description: "A stored id or a symbol as written, never fetched.",
          schema: str,
        },
      ],
      responses: base({
        200: ok("The plan.", ref("TradePlanRead")),
        404: NO_PLAN,
      }),
    },
    put: {
      tags,
      operationId: "saveTradePlan",
      security: WRITES,
      summary: "Change a trade plan",
      description: lines(
        "One new revision of the whole state, with the revision read: `text` replaces the text, `edits` changes part of it, or any of `name`, `symbols`, `status` and `review_by` set those.",
        "",
        "- A stale revision is refused (409) with the live `revision`.",
        "- A save that changes nothing makes no revision and answers `unchanged`.",
        `- Making an archived plan active, or renaming an active one, keeps the names unique and the active plans at most ${MAX_ACTIVE_PLANS}.`,
        `- The last ${KEPT_REVISIONS} revisions are kept.`,
      ),
      requestBody: { required: true, content: content(ref("TradePlanSave")) },
      responses: base({
        200: ok("The plan as saved.", ref("TradePlanSaved")),
        409: STALE,
        413: r("TooLarge"),
        415: r("UnsupportedType"),
        ...SYMBOLS,
      }),
    },
    delete: {
      tags,
      operationId: "deleteTradePlan",
      security: WRITES,
      summary: "Delete a trade plan",
      description:
        "Deletes it softly, with the revision read: it lists only under `status=removed` and restores with no time limit at the revision it had. Not a revision.",
      parameters: [
        {
          name: "revision",
          in: "query",
          description: "The revision read.",
          required: true,
          schema: int,
        },
      ],
      responses: base({
        200: ok("The plan, now removed.", ref("TradePlan")),
        404: NO_PLAN,
        409: err(
          "The revision sent is not the live one (`conflict`, with the live `revision`).",
        ),
      }),
    },
  },
  [`${P}/{id}/restore`]: {
    parameters: [id],
    post: {
      tags,
      operationId: "restoreTradePlan",
      security: WRITES,
      summary: "Restore a deleted trade plan",
      description:
        "Brings a deleted plan back at the revision it had. An active one must keep the names unique and the active plans within the limit.",
      responses: base({
        200: ok("The plan restored.", ref("TradePlan")),
        404: NO_PLAN,
        409: err(
          "It is not deleted, an active plan holds its name, or there are already as many active plans as allowed (`conflict`).",
        ),
      }),
    },
  },
  [`${P}/{id}/versions`]: {
    parameters: [id],
    get: {
      tags,
      operationId: "tradePlanVersions",
      security: READS,
      summary: "A trade plan's kept revisions",
      description: `The last ${KEPT_REVISIONS} revisions, newest first, each with what it changed, without their text.`,
      responses: base({
        200: ok("The revisions.", ref("TradePlanRevisions")),
        404: NO_PLAN,
      }),
    },
  },
  [`${P}/{id}/versions/{revision}`]: {
    parameters: [
      id,
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
      operationId: "tradePlanVersion",
      security: READS,
      summary: "One revision of a trade plan",
      description:
        "That revision's whole state: name, text and HTML, symbols, status and review date.",
      responses: base({
        200: ok("The revision.", ref("TradePlanVersion")),
        404: err(
          `No such plan, revision, or one no longer kept (\`not_found\`): the last ${KEPT_REVISIONS} are.`,
        ),
      }),
    },
  },
};
