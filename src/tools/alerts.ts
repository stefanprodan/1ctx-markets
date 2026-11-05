// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// The alerts' read tool and their write tool, listed per key's access.

import {
  ALERT_EDITS,
  alertsEdit,
  alertsRead,
  LAST_TRIGGERS,
  parseAlertsEdit,
  parseAlertsRead,
} from "../operations/alerts.ts";
import type { Markets } from "../operations/markets.ts";
import { type Access, NO_ACCESS } from "../operations/who.ts";
import { MAX_INSTRUMENTS, MAX_NOTE } from "../rules/format.ts";
import { ALERTS_KEPT_DAYS } from "../rules/store.ts";
import {
  isRelative,
  MAX_COMPARISONS,
  MAX_DEPTH,
  MAX_WHEN,
  WHEN_FIELD_NAMES,
} from "../shared/when.ts";
import { day, next, schema, symbol, type Tool } from "./schema.ts";

const STATES =
  "state: watching, triggered (waits for a false; again at most once a session), waiting_for_earnings, paused, split_paused (set new levels), unknown (see reasons; never triggers).";

const readDescription = (writes: boolean) =>
  `The owner's price alerts ("tell me when"). Each with its condition, state and how close it is now (each comparison's live value and gap); or, with history, what triggered, newest first, kept ${ALERTS_KEPT_DAYS} days. ${STATES}${writes ? " Changes: alerts_edit." : ""}`;

const EDIT = `Sets the owner's price alerts: create, update, pause, resume, delete. An alert triggers when its condition turns true, at most once a trading session of its symbol, again only after false; true when set, it triggers in the answer. when: comparisons joined by and/or, parens allowed: "price < 180", "rsi14 < 30 and price > sma200", "price(^VIX) > 25". A side is a number or a field as quote and screen name it; field(symbol) reads another symbol, relative_return_1m(benchmark); one unit per comparison; at most ${MAX_COMPARISONS} comparisons, ${MAX_INSTRUMENTS} symbols. after_earnings: a US share whose next results it waits for. update keeps the id and history. A split pauses price-level alerts: update them.`;

const FIELDS = WHEN_FIELD_NAMES.map((f) =>
  isRelative(f) ? `${f}(benchmark)` : f,
).join(" ");

const WHEN = `fields: ${FIELDS}; and binds before or; ${MAX_DEPTH} levels deep at most`;

const id = { type: "integer", minimum: 1 } as const;

export function alertsTools(m: Markets, access: Access): Tool[] {
  if (access === "none") return [];
  const read: Tool = {
    name: "alerts",
    description: readDescription(access === "write"),
    inputSchema: schema(
      {
        id: {
          ...id,
          description: `one alert and its last ${LAST_TRIGGERS} triggers; with history, its triggers, a deleted one's too`,
        },
        symbol: { ...symbol, description: "only this symbol's" },
        history: {
          type: "boolean",
          default: false,
          description: "triggers instead of alerts",
        },
        since: { ...day, description: "with history: from this UTC day" },
        next,
      },
      [],
    ),
    run: (input, who) =>
      alertsRead(m, who ?? NO_ACCESS, parseAlertsRead(input)),
  };
  if (access === "read") return [read];
  return [
    read,
    {
      name: "alerts_edit",
      description: EDIT,
      inputSchema: schema(
        {
          action: { type: "string", enum: [...ALERT_EDITS] },
          symbol: { ...symbol, description: "create: the alert's symbol" },
          when: {
            type: "string",
            minLength: 1,
            maxLength: MAX_WHEN,
            description: WHEN,
          },
          note: {
            type: ["string", "null"],
            maxLength: MAX_NOTE,
            description: "update: null clears it",
          },
          after_earnings: symbol,
          id: { ...id, description: "the alert acted on" },
        },
        ["action"],
      ),
      run: (input, who) =>
        alertsEdit(m, who ?? NO_ACCESS, parseAlertsEdit(input)),
      writes: true,
    },
  ];
}
