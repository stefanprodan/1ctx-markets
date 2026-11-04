// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// The analysis's read tool and its write tool, listed per key's access.

import { MAX_EDITS } from "../document/edit.ts";
import { MAX_DOCUMENT_BYTES } from "../document/store.ts";
import {
  ANALYSIS_READS,
  ANALYSIS_WRITES,
  analysisAnswer,
  parseAnalysisEdit,
  parseAnalysisRead,
} from "../operations/analysis.ts";
import type { Markets } from "../operations/markets.ts";
import { type Access, NO_ACCESS } from "../operations/who.ts";
import { next, schema, symbol, type Tool } from "./schema.ts";

const readDescription = (writes: boolean) =>
  `${writes ? "Changes go through analysis_edit. " : ""}A symbol's dated analysis (trend, earnings, news, valuation, risks), written earlier and shared by everyone on this server. Check it against quote and research, which hold the live figures. read: symbol; the text, its author, date and the price move since. list: the symbols with one, newest first. versions: symbol; the kept revisions. version: symbol, revision; that revision's text.`;

const EDIT = `Writes a symbol's analysis, which everyone on this server reads: about the symbol only, never holdings, cost, gains or the owner's profile. replace: symbol, revision read and the whole text; no revision only for the first. edit: symbol, revision, edits: 1-${MAX_EDITS} {old, new}, each old found once, for a few lines. A stale revision is refused with the live one: read again, retry. At most ${MAX_DOCUMENT_BYTES / 1024} KiB; date every figure. Example: {"action": "replace", "symbol": "NVDA", "revision": 3, "text": "# NVDA, 2026-11-05\\nTrend: up since the October earnings."}`;

const revision = { type: "integer", minimum: 1 } as const;

export function analysisTools(m: Markets, access: Access): Tool[] {
  if (access === "none") return [];
  const read: Tool = {
    name: "analysis",
    description: readDescription(access === "write"),
    inputSchema: schema(
      {
        action: { type: "string", enum: [...ANALYSIS_READS] },
        symbol,
        revision: { ...revision, description: "version: the revision to read" },
        next,
      },
      ["action"],
    ),
    run: (input, who) =>
      analysisAnswer(m, who ?? NO_ACCESS, parseAnalysisRead(input)),
  };
  if (access === "read") return [read];
  return [
    read,
    {
      name: "analysis_edit",
      description: EDIT,
      inputSchema: schema(
        {
          action: { type: "string", enum: [...ANALYSIS_WRITES] },
          symbol,
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
          text: { type: "string", description: "replace: the whole analysis" },
        },
        ["action", "symbol"],
      ),
      run: (input, who) =>
        analysisAnswer(m, who ?? NO_ACCESS, parseAnalysisEdit(input)),
      writes: true,
    },
  ];
}
