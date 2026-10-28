// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import {
  MAX_BODY_BYTES as ADMIN_BODY_BYTES,
  MAX_SYMBOLS as ADMIN_SYMBOLS,
  DEFAULT_PAGE,
  MAX_PAGE,
} from "../admin/http.ts";
import { MAX_SYMBOL } from "../operations/args.ts";
import { MAX_EVENT_SYMBOLS } from "../operations/events.ts";
import { DEFAULT_MONTHS } from "../operations/history.ts";
import { AVERAGES } from "../operations/movers.ts";
import { MAX_SYMBOLS } from "../operations/quote.ts";
import {
  MAX_RESEARCH_SYMBOLS,
  RESEARCH_PARTS,
  SINCE_DAYS,
  WEEK_ITEMS,
} from "../operations/research.ts";
import { MAX_FIELDS, MAX_FILTERS } from "../operations/screen.ts";
import { MAX_NOTE } from "../rules/format.ts";
import { ALERT_PAGE_BYTES } from "./alerts.ts";
import { DOC_FILES } from "./docs.ts";
import { MAX_BODY_BYTES } from "./http.ts";
import {
  bool,
  DEADLINE_S,
  freeForm,
  int,
  list,
  num,
  ref,
  type Schema,
  str,
  values,
} from "./schemas.ts";

// the web UI's cookie opens the admin routes and every read
const READ_AUTH = [{ read: [] }, { session: [] }];
const ADMIN_AUTH = [{ admin: [] }, { session: [] }];

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

export const responses = {
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
  Forbidden: error(
    "forbidden: a write signed in by the web UI's cookie that the browser did not send from this server's own pages (Sec-Fetch-Site, else the Origin's host against Host).",
  ),
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

export const paths = {
  "/quotes": {
    get: {
      tags: ["market data"],
      operationId: "quotes",
      security: READ_AUTH,
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
      security: READ_AUTH,
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
      security: READ_AUTH,
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
      security: READ_AUTH,
      summary: "Quotes with research summaries and a week of news",
      description: `For each share, its brief quote as /quotes answers it, a research summary (metrics, analysts, earnings and insider sentiment with their newest rows, the next earnings event) and the stored news of the window (counts by sentiment and the ${WEEK_ITEMS} items that take a side first). Up to ${MAX_RESEARCH_SYMBOLS} symbols: a share never fetched costs five calls to the research source, whose per-minute limit is shared with the server's own jobs. Sections never fetched are fetched inside the call; news is read as stored. Research covers US shares only. ${DEADLINE}`,
      parameters: [
        csv(
          "symbols",
          `1 to ${MAX_RESEARCH_SYMBOLS} symbols, comma-separated. ${SYMBOL}`,
          str,
          true,
        ),
        csv(
          "sections",
          "The parts each share answers, all by default; a section left out is not fetched.",
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
      security: READ_AUTH,
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
      security: READ_AUTH,
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
      security: READ_AUTH,
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
      security: READ_AUTH,
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
      security: ADMIN_AUTH,
      responses: {
        200: ok("The status", ref("Status")),
        400: r("BadArguments"),
        401: r("Unauthorized"),
        500: r("Internal"),
      },
    },
  },
  "/admin/instruments": {
    get: {
      tags: ["admin"],
      operationId: "adminInstruments",
      summary: "The stored instruments and why each is tracked",
      description: `Paged by id, since the stored set grows with use and a page is a screen of rows: pass the last id answered as after while more is true. total counts every match. tracked_by names what keeps each one synced: a rule reading it, a read within the tracking window (read_until is when that ends), or the server's start options. Listing is no read and tracks nothing.`,
      security: ADMIN_AUTH,
      parameters: [
        query(
          "query",
          "Keeps the instruments whose id or name holds it, ignoring case.",
        ),
        query("after", "The last id of the page before."),
        query("limit", `1 to ${MAX_PAGE}; ${DEFAULT_PAGE} by default.`, int),
      ],
      responses: {
        200: ok("A page of instruments", ref("AdminInstruments")),
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
      security: ADMIN_AUTH,
      requestBody: body(ref("RefetchArgs")),
      responses: {
        200: ok("Each part's outcome per symbol", ref("Refetched")),
        400: r("BadArguments"),
        401: r("Unauthorized"),
        403: r("Forbidden"),
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
      security: ADMIN_AUTH,
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
        403: r("Forbidden"),
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
      description:
        "The page names each file with a fingerprint of its bytes, so a cache keyed by URL takes a changed file as a new one; any fingerprint, stale or none, answers the file as this build has it.",
      security: [],
      parameters: [
        {
          name: "file",
          in: "path",
          description: "One of the page's files.",
          required: true,
          schema: values(DOC_FILES),
        },
        query("h", "The file's fingerprint, as the page names it."),
      ],
      responses: {
        200: { description: "The file" },
        400: r("BadArguments"),
      },
    },
  },
};
