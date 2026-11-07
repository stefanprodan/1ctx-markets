// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// The owner's trade plans: the read tool and the write tool, listed per
// key's access.

import { MAX_EDITS } from "../document/edit.ts";
import { MAX_DOCUMENT_BYTES } from "../document/store.ts";
import type { Markets } from "../operations/markets.ts";
import {
  parseTradePlansEdit,
  parseTradePlansRead,
  QUOTE_PLANS,
  TRADE_PLANS_READS,
  TRADE_PLANS_WRITES,
  tradePlansAnswer,
} from "../operations/trade-plans.ts";
import { type Access, NO_ACCESS } from "../operations/who.ts";
import {
  LIST_STATUSES,
  MAX_PLAN_NAME,
  MAX_PLAN_SYMBOLS,
  PLAN_STATUSES,
} from "../trade-plans/store.ts";
import { next, schema, symbol, type Tool } from "./schema.ts";

const readDescription = (writes: boolean) =>
  `The owner's trade plans: buy ladders, dry powder to deploy, bond subscriptions, as Markdown tagged with symbols; intent, never an order. ${writes ? "Changes go through trade_plans_edit. " : ""}Weigh a plan against quote's live price. list: status (active default, archived, removed, all), symbol (every plan tagged with it; quote names the ${QUOTE_PLANS} newest); newest updated first. read: id, the text and its fields; symbol adds the headings of that symbol's sections. versions: id; the kept revisions and what each changed. version: id, revision; that revision's whole state.`;

const EDIT = `Writes the owner's trade plans: buy ladders, dry powder to deploy, bond subscriptions, as Markdown tagged with symbols. A plan is intent, never an order. create: name, text, symbols, review_by. edit, preferred: id, revision, edits: 1-${MAX_EDITS} {old, new}, each old found once, all or none. replace: id, revision, whole text. set: id, revision and name, symbols (the whole list), status (active, archived) or review_by. delete: id, revision; restore: id. Symbols as quote takes them; several listings answer candidates and nothing is saved. A stale revision is refused with the live one: read again, retry. At most ${MAX_DOCUMENT_BYTES / 1024} KiB. Example: {"action": "edit", "id": 3, "revision": 7, "edits": [{"old": "| 1 | $181 |", "new": "| 1 | $178 |"}]}`;

const id = { type: "integer", minimum: 1 } as const;
const revision = { type: "integer", minimum: 1 } as const;

export function tradePlansTools(m: Markets, access: Access): Tool[] {
  if (access === "none") return [];
  const read: Tool = {
    name: "trade_plans",
    description: readDescription(access === "write"),
    inputSchema: schema(
      {
        action: { type: "string", enum: [...TRADE_PLANS_READS] },
        id,
        status: { type: "string", enum: [...LIST_STATUSES] },
        symbol,
        revision: { ...revision, description: "version: the revision to read" },
        next,
      },
      ["action"],
    ),
    run: (input, who) =>
      tradePlansAnswer(m, who ?? NO_ACCESS, parseTradePlansRead(input)),
  };
  if (access === "read") return [read];
  return [
    read,
    {
      name: "trade_plans_edit",
      description: EDIT,
      inputSchema: schema(
        {
          action: { type: "string", enum: [...TRADE_PLANS_WRITES] },
          id,
          revision: { ...revision, description: "the revision read" },
          name: { type: "string", minLength: 1, maxLength: MAX_PLAN_NAME },
          text: { type: "string", description: "the whole plan" },
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
          symbols: {
            type: "array",
            maxItems: MAX_PLAN_SYMBOLS,
            items: symbol,
            description: "the whole list; empty clears it",
          },
          status: { type: "string", enum: [...PLAN_STATUSES] },
          review_by: {
            type: ["string", "null"],
            pattern: "^\\d{4}-\\d{2}-\\d{2}$",
            description: "a date to review it by; null clears it",
          },
        },
        ["action"],
      ),
      run: (input, who) =>
        tradePlansAnswer(m, who ?? NO_ACCESS, parseTradePlansEdit(input)),
      writes: true,
    },
  ];
}
