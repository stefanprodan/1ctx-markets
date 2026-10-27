// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The OpenAPI 3.1 description of /api/v1, written by hand so each limit
// carries its reason. Schemas keep to a small subset of JSON Schema that
// the contract test checks every answer against; a keyword outside it
// would be one the test cannot hold true.

import {
  MAX_BODY_BYTES as ADMIN_BODY_BYTES,
  MAX_SYMBOLS as ADMIN_SYMBOLS,
} from "../admin/http.ts";
import {
  PARTS,
  RESEARCH_SECTIONS as REFETCH_SECTIONS,
} from "../admin/refetch.ts";
import { UNITS } from "../instruments.ts";
import { MAX_NOTE } from "../rules/format.ts";
import { ALERT_PAGE_BYTES } from "../tools/alerts.ts";
import { MAX_SYMBOL } from "../tools/args.ts";
import { MAX_EVENT_SYMBOLS } from "../tools/events.ts";
import { DEFAULT_MONTHS } from "../tools/history.ts";
import { AVERAGES } from "../tools/movers.ts";
import { MAX_SYMBOLS } from "../tools/quote.ts";
import {
  MAX_RESEARCH_SYMBOLS,
  RESEARCH_PARTS,
  SINCE_DAYS,
  WEEK_ITEMS,
} from "../tools/research.ts";
import { FIELD_NAMES, MAX_FIELDS, MAX_FILTERS } from "../tools/screen.ts";
import { CALL_MS, ERRORS } from "../tools/targets.ts";
import { DOC_FILES } from "./docs.ts";
import { MAX_BODY_BYTES } from "./http.ts";

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

const ref = (name: string): Schema => ({
  $ref: `#/components/schemas/${name}`,
});
const str: Schema = { type: "string" };
const nstr: Schema = { type: ["string", "null"] };
const num: Schema = { type: "number" };
const nnum: Schema = { type: ["number", "null"] };
const int: Schema = { type: "integer" };
const bool: Schema = { type: "boolean" };
// an object whose fields a doc gives, not this spec
const freeForm = (doc: string): Schema => ({
  type: "object",
  description: `Its fields are described in ${doc}.`,
});
const described = (s: Schema, doc: string): Schema => ({
  ...s,
  description: `Its fields beyond those listed are described in ${doc}.`,
});
const list = (items: Schema): Schema => ({ type: "array", items });
const values = (allowed: readonly (string | number)[]): Schema => ({
  type: typeof allowed[0] === "number" ? "integer" : "string",
  enum: [...allowed],
});
const object = (
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

const DEADLINE_S = CALL_MS / 1000;

const TOOLS = "docs/tools.md";
const RESEARCH = "docs/research.md";
const RULES = "docs/rules.md";
const ADMIN = "docs/admin.md";

// what an item holds when its symbol did not resolve or fetch in time
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

const schemas: Record<string, Schema> = {
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

const content = (schema: Schema) => ({
  "application/json": { schema },
});

const ok = (description: string, schema: Schema) => ({
  description,
  content: content(schema),
});

const error = (description: string) => ({
  description,
  content: content(ref("Error")),
});

const responses = {
  BadArguments: error(
    "bad_arguments: an argument the route does not take, given twice, or out of its limits; the message names which and why. Other codes the tool refuses with: mixed_units, no_event_source, no_event.",
  ),
  Unauthorized: error(
    "unauthorized: no bearer key or a wrong one, checked before the route is looked up.",
  ),
  NotFound: error(
    "not_found: no such route, rule or instrument; or a symbol that did not resolve to one instrument (not_found, candidates with the listings to pick an id from, no_data while its source is off, refused).",
  ),
  Conflict: error("conflict or split_paused: the stored state refuses it."),
  TooLarge: error(
    `payload_too_large: a body over ${MAX_BODY_BYTES} bytes, as this JSON. A body over 1 MiB is refused by the HTTP server before any route runs: status 413 with an empty body and the connection closed.`,
  ),
  UnsupportedType: error(
    "unsupported_media_type: the body is application/json.",
  ),
  Internal: error(
    "internal: logged on the server and answered without detail, since a thrown message can quote a source.",
  ),
  Unavailable: error(
    `timeout, rate_limited or source_error: the source failed, is backing off, or the ${DEADLINE_S}-second deadline passed; ask again later.`,
  ),
};

const r = (name: keyof typeof responses) => ({
  $ref: `#/components/responses/${name}`,
});

type Param = {
  name: string;
  in: "query" | "path" | "header";
  description: string;
  required?: boolean;
  schema: Schema;
  style?: "form";
  explode?: false;
};

const query = (
  name: string,
  description: string,
  schema: Schema = str,
  required = false,
): Param => ({ name, in: "query", description, required, schema });

// a list is one comma-separated value, as a shell script builds it
const csv = (
  name: string,
  description: string,
  items: Schema = str,
  required = false,
): Param => ({
  ...query(name, description, list(items), required),
  style: "form",
  explode: false,
});

const SYMBOL = `A stored id (US:NVDA), a Yahoo symbol (VVSM.DE, ^VIX), FRED:<series id> or a name, at most ${MAX_SYMBOL} characters. One the server never read is resolved, never by a guess, and its history fetched inside the call; several listings answer candidates to pick an id from.`;

const DEADLINE = `The whole call has one ${DEADLINE_S}-second deadline, under the 20-second tool timeout common clients use; a symbol not done by then answers timeout as its own error: ask again. Every symbol answered counts as read, which keeps it synced for 30 days.`;

const STALE =
  "stale lists fixed reasons when a source failed or a sync is behind; an empty list means current.";

const reads = (extra: object = {}) => ({
  400: r("BadArguments"),
  401: r("Unauthorized"),
  500: r("Internal"),
  ...extra,
});

const body = (schema: Schema) => ({
  required: true,
  content: content(schema),
});

const paths = {
  "/quotes": {
    get: {
      tags: ["market data"],
      operationId: "quotes",
      summary: "Live quotes with their averages",
      description: `Every symbol asked in one answer, in the order asked, each a quote or its own error. Up to ${MAX_SYMBOLS} symbols: each one never read costs a fetch of ten years of bars inside the call, and the limit keeps that bounded. ${DEADLINE} ${STALE} sma holds the daily and weekly SMA 50 and 200 of the live row (closed days plus today's price) or the last final one; last_final.daily holds the last final close and its averages, to tell a crossing since that close. A FRED series is an observation with a null price.`,
      parameters: [
        csv(
          "symbols",
          `1 to ${MAX_SYMBOLS} symbols, comma-separated. ${SYMBOL}`,
          str,
          true,
        ),
        query(
          "extended",
          "true adds extended per item: the last pre- or post-market price since the regular close, or null with why in stale. Fetched only when asked, so a large quote at night makes no extra calls.",
          bool,
        ),
      ],
      responses: reads({ 200: ok("The quotes", ref("Quotes")) }),
    },
  },
  "/history": {
    get: {
      tags: ["market data"],
      operationId: "history",
      summary: "Daily or weekly bars with their averages",
      description: `One symbol's bars from from to to, oldest first, all of them: the server keeps up to ten years, about 2,520 daily bars. Each bar has its close, whether it is final, and the SMA 50 and 200 of that date's signal row, null where it has none. A bar is final once its source shows a later session, so a closed day's bar stays not final until the next session opens. The latest session's bar is its live quote's, with the live row's averages, even before the source has a bar for it. session is the market's last regular session, as the quote tool answers it: state open or closed, start and end in UTC; crypto is always open with null bounds, a FRED series null. Prices are split-adjusted; dividends and FX conversion are excluded (basis). ${DEADLINE} ${STALE} A range whose bars are all final, ending before today in the instrument's own zone, with no benchmark, may be kept by the client for an hour, since final bars change only by a split or a revision; every other answer is no-store.`,
      parameters: [
        query("symbol", SYMBOL, str, true),
        query("interval", "1d (default) or 1wk.", values(["1d", "1wk"])),
        query(
          "from",
          `YYYY-MM-DD; ${DEFAULT_MONTHS["1d"]} months before to for 1d and ${DEFAULT_MONTHS["1wk"]} for 1wk by default.`,
        ),
        query("to", "YYYY-MM-DD; the latest bar by default."),
        query(
          "benchmark",
          "Any symbol; adds relative: the 1- and 3-month return relative to it at to, in percentage points, naming both currencies.",
        ),
      ],
      responses: reads({
        200: ok("The bars", ref("History")),
        404: r("NotFound"),
        503: r("Unavailable"),
      }),
    },
  },
  "/search": {
    get: {
      tags: ["market data"],
      operationId: "search",
      summary: "Instruments by name or symbol",
      description:
        "Every match: stored instruments first, then the regional feeds that are on, then Yahoo's listings, each with the id to pass to the other routes; a regional feed's listings add their ISIN and the type the feed gives. It fetches no prices and counts nothing as read, so a search never keeps an instrument synced. A source that failed is in errors beside what the others found. A FRED series not stored yet is found only as FRED:<series id>.",
      parameters: [query("query", "A name or symbol.", str, true)],
      responses: reads({ 200: ok("The candidates", ref("Search")) }),
    },
  },
  "/research": {
    get: {
      tags: ["market data"],
      operationId: "research",
      summary: "Quotes with research summaries and a week of news",
      description: `For each share, its brief quote as /quotes answers it, a Finnhub summary (metrics, analysts, earnings and insider sentiment with their newest rows, the next earnings event) and the stored news of the window (counts by sentiment and the ${WEEK_ITEMS} items that take a side first). Up to ${MAX_RESEARCH_SYMBOLS} symbols: a share never fetched costs five Finnhub calls, and the free key allows 60 a minute shared with the server's own jobs. Sections never fetched are fetched inside the call; news is read as stored. Finnhub covers US shares only. ${DEADLINE}`,
      parameters: [
        csv(
          "symbols",
          `1 to ${MAX_RESEARCH_SYMBOLS} symbols, comma-separated. ${SYMBOL}`,
          str,
          true,
        ),
        csv(
          "sections",
          "The parts each share answers, all by default; a Finnhub section left out is not fetched.",
          values(RESEARCH_PARTS),
        ),
        query(
          "since",
          `YYYY-MM-DD, UTC: the news window's start, at most ${SINCE_DAYS} days back (what is kept); seven days back by default. Needs news in sections.`,
        ),
      ],
      responses: reads({ 200: ok("The summaries", ref("Research")) }),
    },
  },
  "/events": {
    get: {
      tags: ["market data"],
      operationId: "events",
      summary: "Earnings events between two dates",
      description: `Earnings events of the tracked US shares, or of the shares named, by date. Company events only: no macro dates. unavailable says why a share has no calendar to show; no_event lists a named share with nothing in the range, with its nearest stored events either side, so an empty list is never read as missing data. ${DEADLINE}`,
      parameters: [
        query("from", "YYYY-MM-DD, inclusive.", str, true),
        query("to", "YYYY-MM-DD, inclusive.", str, true),
        csv(
          "symbols",
          `1 to ${MAX_EVENT_SYMBOLS} symbols, comma-separated; the tracked shares by default. ${SYMBOL}`,
        ),
      ],
      responses: reads({ 200: ok("The events", ref("Events")) }),
    },
  },
  "/movers": {
    get: {
      tags: ["market data"],
      operationId: "movers",
      summary: "The day's movers among the symbols named",
      description: `Every match, largest absolute change first, then the symbols unavailable and the errors; counts cover them all. min_move_pct is the live change from the previous close; an average with a relation compares the live price with it, and crossed_up or crossed_down compare the last final close with the average then and the live price with it now. Give a move, an average or both. A symbol with a stale or missing input is unavailable with why, never a match: only a match can be wrong in silence. ${DEADLINE}`,
      parameters: [
        csv(
          "symbols",
          `1 to ${MAX_SYMBOLS} symbols, comma-separated. ${SYMBOL}`,
          str,
          true,
        ),
        query("min_move_pct", "0 or more, in percent.", num),
        query(
          "direction",
          "up, down or either (default); needs min_move_pct.",
          values(["up", "down", "either"]),
        ),
        query(
          "average",
          "The average to compare with; goes with relation.",
          values(Object.keys(AVERAGES)),
        ),
        query(
          "relation",
          "above, below, crossed_up or crossed_down; goes with average.",
          values(["above", "below", "crossed_up", "crossed_down"]),
        ),
      ],
      responses: reads({ 200: ok("The movers", ref("Movers")) }),
    },
  },
  "/screen": {
    post: {
      tags: ["market data"],
      operationId: "screen",
      summary: "Filter and rank symbols on their latest signals",
      description: `The screen tool's arguments as a JSON body, since filters are a structure: up to ${MAX_SYMBOLS} symbols, at most ${MAX_FILTERS} filters that must all hold ({field, min, max} inclusive, or {field, eq} for a state), a sort, and up to ${MAX_FIELDS} more fields shown. The fields are a fixed list, never an expression, so each is checked once in code. Price-level fields refuse symbols of mixed units (mixed_units). Every match, then the unavailable and the errors; counts cover them all. ${DEADLINE}`,
      requestBody: body(ref("ScreenArgs")),
      responses: reads({
        200: ok("The screen", ref("Screen")),
        404: r("NotFound"),
        413: r("TooLarge"),
        415: r("UnsupportedType"),
        503: r("Unavailable"),
      }),
    },
  },
  "/rules": {
    get: {
      tags: ["rules"],
      operationId: "listRules",
      summary: "Every price rule",
      description:
        "Every rule by id, with its condition, pause, whether it is armed, and its last result.",
      responses: reads({ 200: ok("The rules", ref("Rules")) }),
    },
    post: {
      tags: ["rules"],
      operationId: "createRule",
      summary: "Create a price rule",
      description: `A rule on live quotes, as the rules tool creates it: a fixed condition tree, never an expression; turning true writes one alert, and again only after it was false. The note is at most ${MAX_NOTE} characters. Every symbol it names resolves inside the call, and any failure stores no rule. Answers the rule, its first evaluation and any alert it fired. ${DEADLINE}`,
      requestBody: body(ref("RuleArgs")),
      responses: reads({
        201: ok("The rule created", ref("Created")),
        404: r("NotFound"),
        413: r("TooLarge"),
        415: r("UnsupportedType"),
        503: r("Unavailable"),
      }),
    },
  },
  "/rules/{id}": {
    parameters: [
      {
        name: "id",
        in: "path",
        description: "The rule's id.",
        required: true,
        schema: int,
      },
    ],
    patch: {
      tags: ["rules"],
      operationId: "pauseRule",
      summary: "Set or clear a rule's manual pause",
      description:
        "A rule paused by a split stays paused (split_paused): its price levels are from before the split; delete it and create it again.",
      requestBody: body(ref("Pause")),
      responses: reads({
        200: ok("The rule", ref("Paused")),
        404: r("NotFound"),
        409: r("Conflict"),
        413: r("TooLarge"),
        415: r("UnsupportedType"),
      }),
    },
    delete: {
      tags: ["rules"],
      operationId: "deleteRule",
      summary: "Delete a rule",
      description: "Its alerts stay until retention.",
      responses: reads({
        204: { description: "Deleted" },
        404: r("NotFound"),
      }),
    },
  },
  "/alerts": {
    get: {
      tags: ["rules"],
      operationId: "alerts",
      summary: "The alerts feed",
      description: `A feed polled on a schedule, not a list: the ETag W/"alerts-<id>" names the last alert answered, sent back in If-None-Match. A page holds whole alerts oldest first and stays under ${ALERT_PAGE_BYTES} bytes, so a client that fell behind catches up over polls (more). The same alerts answer the same bytes. Delivery is at least once: deduplicate by id.`,
      parameters: [
        {
          name: "If-None-Match",
          in: "header",
          description: 'The ETag of the last page stored, W/"alerts-<id>".',
          schema: str,
        },
      ],
      responses: {
        200: {
          ...ok("Alerts after the cursor", ref("Alerts")),
          headers: { ETag: { schema: str } },
        },
        204: { description: "No cursor and no alerts" },
        304: {
          description: "Nothing after the cursor",
          headers: { ETag: { schema: str } },
        },
        400: r("BadArguments"),
        401: r("Unauthorized"),
        500: r("Internal"),
      },
    },
  },
  "/admin/status": {
    get: {
      tags: ["admin"],
      operationId: "adminStatus",
      summary: "What the server and its sources are doing",
      security: [{ admin: [] }],
      responses: {
        200: ok("The status", ref("Status")),
        400: r("BadArguments"),
        401: r("Unauthorized"),
        500: r("Internal"),
      },
    },
  },
  "/admin/refetch": {
    post: {
      tags: ["admin"],
      operationId: "adminRefetch",
      summary: "Ask the sources again for stored instruments",
      description: `For after a parser fix. Stored ids only, at most ${ADMIN_SYMBOLS}, in a body of at most ${ADMIN_BODY_BYTES} bytes: the operator's routes are bounded tighter since they spend the free sources' limits. Its calls queue with the tools' own under the ${DEADLINE_S}-second deadline.`,
      security: [{ admin: [] }],
      requestBody: body(ref("RefetchArgs")),
      responses: {
        200: ok("Each part's outcome per symbol", ref("Refetched")),
        400: r("BadArguments"),
        401: r("Unauthorized"),
        413: r("TooLarge"),
        415: r("UnsupportedType"),
        500: r("Internal"),
      },
    },
  },
  "/admin/instruments/{id}": {
    delete: {
      tags: ["admin"],
      operationId: "adminDelete",
      summary: "Remove an instrument and every row of it",
      description: "Refused (conflict) while a rule reads it.",
      security: [{ admin: [] }],
      parameters: [
        {
          name: "id",
          in: "path",
          description: "A stored instrument id, such as US:NVDA.",
          required: true,
          schema: str,
        },
      ],
      responses: {
        200: ok("What was deleted", ref("Deleted")),
        400: r("BadArguments"),
        401: r("Unauthorized"),
        404: r("NotFound"),
        409: r("Conflict"),
        500: r("Internal"),
      },
    },
  },
  "/openapi.json": {
    get: {
      tags: ["docs"],
      operationId: "spec",
      summary: "This description",
      security: [],
      responses: {
        200: {
          description: "The OpenAPI document",
          content: content(freeForm("the OpenAPI 3.1 specification")),
        },
        400: r("BadArguments"),
      },
    },
  },
  "/docs": {
    get: {
      tags: ["docs"],
      operationId: "docs",
      summary: "This page",
      description:
        "Swagger UI, embedded in the binary: nothing is fetched from another host.",
      security: [],
      responses: {
        200: { description: "The page", content: { "text/html": {} } },
      },
    },
  },
  "/docs/{file}": {
    get: {
      tags: ["docs"],
      operationId: "docsFile",
      summary: "The page's script and style",
      security: [],
      parameters: [
        {
          name: "file",
          in: "path",
          description: "One of the page's files.",
          required: true,
          schema: values(DOC_FILES),
        },
      ],
      responses: {
        200: { description: "The file" },
      },
    },
  },
};

export const spec = {
  openapi: "3.1.0",
  info: {
    title: "1ctx-markets",
    version: "v1",
    // no identifier or url: the page would link to another host
    license: { name: "Apache-2.0" },
    description: `Market data and price rules for scripts and other tools, the same reads the MCP tools answer. JSON in and out; query parameters for reads, a JSON body where the arguments are a structure. Nothing is paged: every route answers its whole result, since a script that does not follow a cursor would lose what is past it. An argument a route does not take is refused (400), next included. Every error is {"error": code, "message": text}, with the tools' own codes. Another method on a path answers 405 with Allow. Reads answer cache-control: no-store, since prices are live. The read key is the server's bearer; the admin key is for the operator's routes alone, and neither is taken where the other is.`,
  },
  servers: [{ url: "/api/v1" }],
  security: [{ read: [] }],
  tags: [
    { name: "market data" },
    { name: "rules" },
    { name: "admin" },
    { name: "docs" },
  ],
  paths,
  components: {
    securitySchemes: {
      read: {
        type: "http",
        scheme: "bearer",
        description: "The server's bearer, secrets/bearer.key.",
      },
      admin: {
        type: "http",
        scheme: "bearer",
        description: "The operator's key, secrets/admin.key.",
      },
    },
    schemas,
    responses,
  },
};
