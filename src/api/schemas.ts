// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import {
  PARTS,
  RESEARCH_SECTIONS as REFETCH_SECTIONS,
} from "../admin/refetch.ts";
import { UNITS } from "../market/instruments.ts";
import { CALL_MS } from "../operations/markets.ts";
import { FIELD_NAMES } from "../operations/screen.ts";
import { ERRORS } from "../operations/targets.ts";

type JsonType =
  | "string"
  | "number"
  | "integer"
  | "boolean"
  | "object"
  | "array"
  | "null";

// the only keywords a schema here may use; description only annotates
export type Schema = {
  type?: JsonType | JsonType[];
  properties?: Record<string, Schema>;
  required?: string[];
  additionalProperties?: boolean | Schema;
  items?: Schema;
  enum?: (string | number | boolean | null)[];
  // exactly one branch matches, as an item that is a result or its error
  oneOf?: Schema[];
  $ref?: string;
  description?: string;
};

export const ref = (name: string): Schema => ({
  $ref: `#/components/schemas/${name}`,
});
export const str: Schema = { type: "string" };
const nstr: Schema = { type: ["string", "null"] };
export const num: Schema = { type: "number" };
const nnum: Schema = { type: ["number", "null"] };
export const int: Schema = { type: "integer" };
export const bool: Schema = { type: "boolean" };
// an object whose fields a doc gives, not this spec
export const freeForm = (doc: string): Schema => ({
  type: "object",
  description: `Its fields are described in ${doc}.`,
});
const described = (s: Schema, doc: string): Schema => ({
  ...s,
  description: `Its fields beyond those listed are described in ${doc}.`,
});
export const list = (items: Schema): Schema => ({ type: "array", items });
export const values = (allowed: readonly (string | number)[]): Schema => ({
  type: typeof allowed[0] === "number" ? "integer" : "string",
  enum: [...allowed],
});
export const object = (
  properties: Record<string, Schema>,
  required: string[] = Object.keys(properties),
  extra = false,
): Schema => ({
  type: "object",
  properties,
  required,
  additionalProperties: extra,
});
const nullable = (s: Schema): Schema => ({
  ...s,
  type: [s.type as JsonType, "null"],
});

export const DEADLINE_S = CALL_MS / 1000;

const TOOLS = "docs/tools.md";
const RESEARCH = "docs/research.md";
const RULES = "docs/rules.md";
const ADMIN = "docs/admin.md";

const itemError = object(
  {
    input: str,
    error: values(ERRORS),
    message: str,
    candidates: list(ref("Candidate")),
  },
  ["input", "error", "message"],
);

const averages = nullable(
  object({
    kind: values(["live", "final"]),
    date: str,
    sma50: nnum,
    sma200: nnum,
  }),
);

const brief = {
  input: str,
  id: str,
  kind: values(["market_quote", "observation"]),
  price: nnum,
  observation: nullable(object({ date: str, value: num })),
  previous_close: nnum,
  change: nnum,
  change_percent: nnum,
  unit: values(UNITS),
  currency: nstr,
  trade_time: nstr,
  fetched_at: nstr,
  stale: list(str),
  sma: object({ daily: averages, weekly: averages }),
  last_final: nullable(
    object({
      daily: object({ date: str, close: nnum, sma50: nnum, sma200: nnum }),
    }),
  ),
};

// every brief field but a FRED series' observation is always there
const briefRequired = Object.keys(brief).filter((k) => k !== "observation");

// a $ref takes no null beside it, so an alert that may be null is inline
const alert = described(
  object(
    { id: int, rule_id: int, fired_at: str, truncated: bool },
    ["id", "rule_id", "fired_at"],
    true,
  ),
  RULES,
);

const unavailable = object(
  {
    input: str,
    id: str,
    status: values(["unavailable"]),
    missing: list(str),
    stale: list(str),
    reason: str,
  },
  ["input", "id", "status", "missing", "stale"],
);

const oneOf = (...names: string[]): Schema => ({ oneOf: names.map(ref) });

export const schemas: Record<string, Schema> = {
  Error: described(
    object({ error: str, message: str }, ["error", "message"], true),
    "docs/api.md",
  ),
  Candidate: object({
    id: str,
    name: nstr,
    type: nstr,
    exchange: str,
    source_symbol: str,
  }),
  ItemError: itemError,
  Quote: object(
    {
      ...brief,
      extended: nullable(
        object({
          session: values(["pre", "post"]),
          price: nnum,
          change: nnum,
          change_percent: nnum,
          time: nstr,
        }),
      ),
    },
    briefRequired,
  ),
  QuoteItem: oneOf("Quote", "ItemError"),
  Quotes: object({ attribution: str, items: list(ref("QuoteItem")) }, [
    "items",
  ]),
  Bar: object({
    date: str,
    close: nnum,
    final: bool,
    sma50: nnum,
    sma200: nnum,
  }),
  History: object(
    {
      id: str,
      name: nstr,
      exchange: str,
      type: str,
      currency: nstr,
      unit: values(UNITS),
      source: str,
      basis: str,
      stale: list(str),
      attribution: str,
      from: str,
      to: str,
      session: nullable(
        object({ state: values(["open", "closed"]), start: nstr, end: nstr }, [
          "state",
          "start",
          "end",
        ]),
      ),
      interval: values(["1d", "1wk"]),
      relative: described(
        object({ benchmark: freeForm(TOOLS) }, ["benchmark"], true),
        TOOLS,
      ),
      bars: list(ref("Bar")),
    },
    [
      "id",
      "name",
      "exchange",
      "type",
      "currency",
      "unit",
      "source",
      "basis",
      "stale",
      "from",
      "to",
      "session",
      "interval",
      "bars",
    ],
  ),
  Search: object(
    {
      query: str,
      errors: list(object({ source: str, error: str, message: str })),
      candidates: list(
        object(
          {
            id: str,
            name: nstr,
            type: nstr,
            exchange: str,
            source: str,
            source_symbol: str,
            isin: nstr,
            stored: bool,
            note: str,
          },
          [
            "id",
            "name",
            "type",
            "exchange",
            "source",
            "source_symbol",
            "stored",
          ],
        ),
      ),
    },
    ["query", "candidates"],
  ),
  ResearchResult: object(
    {
      ...brief,
      research: described(object({ source: str }, ["source"], true), RESEARCH),
      news: described(object({ source: str }, ["source"], true), RESEARCH),
    },
    briefRequired,
  ),
  ResearchItem: oneOf("ResearchResult", "ItemError"),
  Research: object({ attribution: str, items: list(ref("ResearchItem")) }, [
    "items",
  ]),
  Events: object(
    {
      from: str,
      to: str,
      source: str,
      message: str,
      unavailable: list(
        described(
          object({ input: str, message: str }, ["input", "message"], true),
          RESEARCH,
        ),
      ),
      no_event: list(
        object(
          {
            input: str,
            id: str,
            last: nullable(freeForm(RESEARCH)),
            next: nullable(freeForm(RESEARCH)),
          },
          ["input", "id"],
        ),
      ),
      events: list(
        described(
          object({ id: str, date: str, status: str }, ["id", "date"], true),
          RESEARCH,
        ),
      ),
    },
    ["from", "to", "events"],
  ),
  Counts: object({
    matched: int,
    not_matched: int,
    unavailable: int,
    errors: int,
  }),
  Unavailable: unavailable,
  Mover: object(
    {
      input: str,
      id: str,
      status: values(["matched"]),
      name: nstr,
      unit: values(UNITS),
      currency: nstr,
      price: nnum,
      previous_close: nnum,
      change: nnum,
      change_percent: nnum,
      trade_time: nstr,
      fetched_at: nstr,
      average: freeForm(TOOLS),
    },
    [
      "input",
      "id",
      "status",
      "name",
      "unit",
      "currency",
      "price",
      "previous_close",
      "change",
      "change_percent",
      "trade_time",
      "fetched_at",
    ],
  ),
  MoverItem: oneOf("Mover", "Unavailable", "ItemError"),
  Screened: object(
    {
      input: str,
      id: str,
      status: values(["matched"]),
      name: nstr,
      unit: values(UNITS),
      currency: nstr,
      kind: values(["market_quote", "observation"]),
      price: nnum,
      observation: nullable(object({ date: str, value: num })),
      trade_time: nstr,
      fetched_at: nstr,
      fields: {
        type: "object",
        additionalProperties: nullable(
          object(
            {
              value: nnum,
              unit: str,
              kind: values(["live", "final"]),
              date: str,
              note: str,
            },
            ["value", "unit", "kind", "date"],
          ),
        ),
      },
    },
    [
      "input",
      "id",
      "status",
      "name",
      "unit",
      "currency",
      "kind",
      "price",
      "trade_time",
      "fetched_at",
      "fields",
    ],
  ),
  ScreenItem: oneOf("Screened", "Unavailable", "ItemError"),
  Movers: object(
    {
      sort: str,
      counts: ref("Counts"),
      attribution: str,
      items: list(ref("MoverItem")),
    },
    ["sort", "counts", "items"],
  ),
  Screen: object(
    {
      benchmark: freeForm(TOOLS),
      sort: object({ field: str, order: values(["asc", "desc"]) }),
      attribution: str,
      counts: ref("Counts"),
      items: list(ref("ScreenItem")),
    },
    ["sort", "counts", "items"],
  ),
  ScreenArgs: object(
    {
      symbols: list(str),
      filters: list(
        object(
          {
            field: values(FIELD_NAMES),
            min: num,
            max: num,
            eq: values([-1, 0, 1]),
          },
          ["field"],
        ),
      ),
      benchmark: str,
      sort: values(FIELD_NAMES),
      order: values(["asc", "desc"]),
      fields: list(values(FIELD_NAMES)),
    },
    ["symbols"],
  ),
  Rule: object(
    {
      id: int,
      symbol: str,
      condition: freeForm(RULES),
      note: nstr,
      paused: { type: ["string", "null"], enum: ["manual", "split", null] },
      message: str,
      armed: bool,
      created_at: str,
      last_result: nstr,
      last_evaluated_at: nstr,
      after_earnings: freeForm(RULES),
    },
    [
      "id",
      "symbol",
      "condition",
      "note",
      "paused",
      "armed",
      "created_at",
      "last_result",
      "last_evaluated_at",
    ],
  ),
  Rules: object({ rules: list(ref("Rule")) }),
  RuleArgs: object({ symbol: str, condition: freeForm(RULES), note: nstr }, [
    "symbol",
    "condition",
  ]),
  Created: object({
    rule: ref("Rule"),
    evaluation: described(
      object(
        { result: str, values: list(freeForm(RULES)), reasons: list(str) },
        ["result", "reasons"],
        true,
      ),
      RULES,
    ),
    alert: nullable(alert),
  }),
  Pause: object({ paused: bool }),
  Paused: object({ rule: ref("Rule") }),
  Alert: alert,
  Alerts: object(
    {
      retention_gap: bool,
      cursor_reset: bool,
      more: bool,
      alerts: list(ref("Alert")),
    },
    ["more", "alerts"],
  ),
  Status: object({
    version: str,
    sources: list(
      object({
        name: str,
        state: values(["on", "off"]),
        why: str,
        backing_off: nullable(object({ until: nstr, after: str })),
      }),
    ),
    jobs: list(freeForm(ADMIN)),
    instruments: int,
    tracked: int,
    database_bytes: int,
  }),
  RefetchArgs: object(
    {
      symbols: list(str),
      fetch: list(values(PARTS)),
      sections: list(values(REFETCH_SECTIONS)),
    },
    ["symbols", "fetch"],
  ),
  Refetched: object({
    results: list(described(object({ symbol: str }, ["symbol"], true), ADMIN)),
  }),
  Deleted: object({
    deleted: str,
    rows: { type: "object", additionalProperties: int },
  }),
};
