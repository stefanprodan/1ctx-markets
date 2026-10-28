// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import {
  MAX_BODY_BYTES as ADMIN_BODY_BYTES,
  MAX_SYMBOLS as ADMIN_SYMBOLS,
  DEFAULT_PAGE,
  MAX_PAGE,
} from "../admin/http.ts";
import { INTRADAY_SESSIONS } from "../market/intraday.ts";
import { TRACK_DAYS } from "../market/tracking.ts";
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
import { ALERTS_KEPT_DAYS } from "../rules/store.ts";
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

const kib = (bytes: number) => `${bytes / 1024} KiB`;

export const responses = {
  BadArguments: error(
    "A bad argument: unknown, repeated or out of range (`bad_arguments`), units that do not mix (`mixed_units`), no earnings source (`no_event_source`) or no event (`no_event`). The message says which.",
  ),
  Unauthorized: error("Missing or wrong key."),
  NotFound: error(
    "No such route, rule, instrument or symbol (`not_found`); a name with several listings (`candidates`, with ids to pick from); a symbol whose source is off (`no_data`) or that this server does not serve (`refused`).",
  ),
  Conflict: error(
    "The rule or instrument refuses it in its current state (`conflict`, `split_paused`).",
  ),
  Forbidden: error(
    "A request other than GET or HEAD with the session cookie, not sent from this server's own pages.",
  ),
  TooLarge: error(
    `A body over ${kib(MAX_BODY_BYTES)} (${kib(ADMIN_BODY_BYTES)} on \`/admin\` routes). Over 1 MiB the answer is an empty body and the connection closes.`,
  ),
  UnsupportedType: error("The body is not `application/json`."),
  Internal: error("Server error, logged on the server."),
  Unavailable: error(
    `A source failed or is rate-limited, or the ${DEADLINE_S}-second deadline passed (\`timeout\`, \`rate_limited\`, \`source_error\`). Retry later.`,
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

const FORMS =
  "a stored id (`US:NVDA`), a symbol with its exchange suffix (`VVSM.DE`), an index (`^VIX`), `FRED:<series id>` or a name";

const SYMBOL = `${FORMS[0].toUpperCase()}${FORMS.slice(1)}. At most ${MAX_SYMBOL} characters.`;

const symbols = (max: number, extra = "") =>
  `Comma-separated, 1 to ${max}${extra}. Each is ${FORMS}, at most ${MAX_SYMBOL} characters.`;

const UNSEEN =
  "- A symbol not seen before is fetched within the call. A name that matches several listings answers `candidates` to pick an id from.";

const DEADLINE = `- The call has a ${DEADLINE_S}-second deadline. A symbol not done by then answers \`timeout\`. Retry later.`;

const READ = `- Each symbol answered counts as a read and is kept up to date for ${TRACK_DAYS} days after its last read, by default.`;

const STALE =
  "- `stale` lists why a value may be out of date. An empty list means current.";

const lines = (...parts: string[]) => parts.join("\n");

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
      summary: "Live quotes",
      description: lines(
        "The live price, change and moving averages of each symbol, in the order asked. Each item is a quote or its own error.",
        "",
        "- `sma` holds the daily and weekly SMA 50 and SMA 200, with today's price counted (`live`) or as of the last final bar (`final`).",
        "- `last_final.daily` is the last final close and its averages, to tell a crossing since that close.",
        "- A `FRED:<series id>` symbol has an `observation` and a null `price`.",
        STALE,
        UNSEEN,
        DEADLINE,
        READ,
      ),
      parameters: [
        csv("symbols", symbols(MAX_SYMBOLS), str, true),
        query(
          "extended",
          "`true` adds the last pre- or post-market price, or null with the reason in `stale`. Default: `false`.",
          bool,
        ),
      ],
      responses: reads({ 200: ok("The quotes.", ref("Quotes")) }),
    },
  },
  "/history": {
    get: {
      tags: ["market data"],
      operationId: "history",
      security: READ_AUTH,
      summary: "Daily or weekly bars, or 5-minute closes",
      description: lines(
        "One symbol's daily or weekly bars, oldest first, with SMA 50 and SMA 200; or with `interval` `5m`, its 5-minute closes.",
        "",
        "- Up to ten years of history.",
        "- The latest session's bar is the live quote. `final` stays false until the source reports a later session.",
        "- Prices are split-adjusted, without dividends or currency conversion.",
        "- `session` is the market's last regular session.",
        "- A range with `to` before today and only final bars, without `benchmark`, may be cached for an hour.",
        `- \`5m\` answers \`points\` instead of \`bars\`: the regular session's closes as the quote passes stored them, up to the last ${INTRADAY_SESSIONS} sessions, without averages. \`from\` and \`to\` are session dates, the newest stored session by default. A source with no such closes, or none stored in the range, answers \`no_data\`.`,
        STALE,
        UNSEEN,
        DEADLINE,
        READ,
      ),
      parameters: [
        query("symbol", SYMBOL, str, true),
        query(
          "interval",
          "`1d`, `1wk` or `5m`. Default: `1d`.",
          values(["1d", "1wk", "5m"]),
        ),
        query(
          "from",
          `\`YYYY-MM-DD\`. Default: ${DEFAULT_MONTHS["1d"]} months before \`to\` for \`1d\`, ${DEFAULT_MONTHS["1wk"]} months for \`1wk\`.`,
        ),
        query("to", "`YYYY-MM-DD`. Default: the latest bar."),
        query(
          "benchmark",
          "A symbol to compare with. Adds `relative`: the 1- and 3-month return against it, in percentage points. Not taken with `5m`.",
        ),
        query(
          "ohlc",
          "`true` adds each bar's open, high, low and volume, for a chart. Default: `false`. Not taken with `5m`.",
          bool,
        ),
      ],
      responses: reads({
        200: ok("The bars, or the points.", ref("HistoryAnswer")),
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
      summary: "Find instruments",
      description: lines(
        "Instruments that match a name or symbol, each with the `id` to pass to the other routes.",
        "",
        "- Stored instruments come first, then other listings.",
        "- Fetches no prices and does not count as a read.",
        "- A source that failed is listed in `errors`, beside the other matches.",
        "- A series not stored yet is found only as `FRED:<series id>`.",
      ),
      parameters: [query("query", "A name or symbol.", str, true)],
      responses: reads({ 200: ok("The matches.", ref("Search")) }),
    },
  },
  "/research": {
    get: {
      tags: ["market data"],
      operationId: "research",
      security: READ_AUTH,
      summary: "Research and news",
      description: lines(
        "For each symbol: its quote, and for a US share a research summary and recent news. US ETFs get news only.",
        "",
        "- The summary holds metrics, analysts, earnings and insider sentiment with their newest rows, and the next earnings event.",
        `- News gives counts by sentiment and the ${WEEK_ITEMS} articles that take a side first.`,
        "- A share not researched before is fetched within the call, from a rate-limited source.",
        DEADLINE,
        READ,
      ),
      parameters: [
        csv("symbols", symbols(MAX_RESEARCH_SYMBOLS), str, true),
        csv(
          "sections",
          "Comma-separated. Default: all. A section left out is not fetched.",
          values(RESEARCH_PARTS),
        ),
        query(
          "since",
          `\`YYYY-MM-DD\`, UTC. Start of the news window, at most ${SINCE_DAYS} days back. Default: seven days back. Needs \`news\` in \`sections\`.`,
        ),
      ],
      responses: reads({ 200: ok("The summaries.", ref("Research")) }),
    },
  },
  "/events": {
    get: {
      tags: ["market data"],
      operationId: "events",
      security: READ_AUTH,
      summary: "Earnings dates",
      description: lines(
        "Earnings events between `from` and `to`, by date, for the tracked US shares or the symbols named.",
        "",
        "- Company earnings only, no macro dates.",
        "- `unavailable` lists the shares with no calendar, and why.",
        "- `no_event` lists the named shares with no event in the range, with their nearest events before and after.",
        DEADLINE,
        READ,
      ),
      parameters: [
        query("from", "`YYYY-MM-DD`, inclusive.", str, true),
        query("to", "`YYYY-MM-DD`, inclusive.", str, true),
        csv(
          "symbols",
          symbols(MAX_EVENT_SYMBOLS, ". Default: the tracked shares"),
        ),
      ],
      responses: reads({ 200: ok("The events.", ref("Events")) }),
    },
  },
  "/movers": {
    get: {
      tags: ["market data"],
      operationId: "movers",
      security: READ_AUTH,
      summary: "Today's movers",
      description: lines(
        "The symbols that moved at least `min_move_pct` today, or stand above, below or across an average. With both given, both must hold. Largest absolute change first, then `unavailable` and errors.",
        "",
        "- Give `min_move_pct`, `average` with `relation`, or both.",
        "- The move is the live change from the previous close.",
        "- `crossed_up` and `crossed_down` compare the last final close with the average then, and the live price with the average now.",
        "- A symbol with a stale or missing input is `unavailable`, with the reason, never a match.",
        "- `counts` covers every symbol asked.",
        DEADLINE,
        READ,
      ),
      parameters: [
        csv("symbols", symbols(MAX_SYMBOLS), str, true),
        query("min_move_pct", "Percent, 0 or more.", num),
        query(
          "direction",
          "Default: `either`. Needs `min_move_pct`.",
          values(["up", "down", "either"]),
        ),
        query(
          "average",
          "The average to compare with. Needs `relation`.",
          values(Object.keys(AVERAGES)),
        ),
        query(
          "relation",
          "Needs `average`.",
          values(["above", "below", "crossed_up", "crossed_down"]),
        ),
      ],
      responses: reads({ 200: ok("The movers.", ref("Movers")) }),
    },
  },
  "/screen": {
    post: {
      tags: ["market data"],
      operationId: "screen",
      security: READ_AUTH,
      summary: "Filter and rank symbols",
      description: lines(
        "The symbols whose latest signals pass every filter, sorted, with any extra `fields`.",
        "",
        `- Up to ${MAX_SYMBOLS} symbols, ${MAX_FILTERS} filters and ${MAX_FIELDS} extra fields.`,
        "- A filter is `{field, min, max}`, inclusive, or `{field, eq}` for a state.",
        "- Price-level fields refuse symbols of different units (`mixed_units`).",
        "- Matches come first, then `unavailable` and errors. `counts` covers every symbol asked.",
        DEADLINE,
        READ,
      ),
      requestBody: body(ref("ScreenArgs")),
      responses: reads({
        200: ok("The screen.", ref("Screen")),
        403: r("Forbidden"),
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
      summary: "List price rules",
      description:
        "Every rule with its condition, pause, whether it is armed, and its last result.",
      responses: reads({ 200: ok("The rules.", ref("Rules")) }),
    },
    post: {
      tags: ["rules"],
      operationId: "createRule",
      summary: "Create a price rule",
      description: lines(
        "Creates a rule on live quotes. Answers the rule, its first evaluation and any alert it fired.",
        "",
        "- The condition is a fixed tree, not an expression.",
        "- An alert fires when the condition turns true, and again only after it was false.",
        `- \`note\` is at most ${MAX_NOTE} characters.`,
        "- Every symbol it names is resolved within the call. On any failure no rule is stored.",
        DEADLINE,
      ),
      requestBody: body(ref("RuleArgs")),
      responses: reads({
        201: ok("The rule created.", ref("Created")),
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
      summary: "Pause or resume a rule",
      description: lines(
        "Sets or clears the rule's manual pause.",
        "",
        "- A rule paused by a split cannot be resumed (`split_paused`): its levels predate the split. Delete it and create it again.",
      ),
      requestBody: body(ref("Pause")),
      responses: reads({
        200: ok("The rule.", ref("Paused")),
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
      description: `Deletes the rule. Its alerts are kept until they are ${ALERTS_KEPT_DAYS} days old.`,
      responses: reads({
        204: { description: "Deleted." },
        404: r("NotFound"),
      }),
    },
  },
  "/alerts": {
    get: {
      tags: ["rules"],
      operationId: "alerts",
      security: READ_AUTH,
      summary: "Alerts feed",
      description: lines(
        "The alerts after the `If-None-Match` cursor, oldest first, or all kept alerts without one. Meant to be polled on a schedule.",
        "",
        '- Send the last `ETag` (`W/"alerts-<id>"`) back as `If-None-Match` to get only newer alerts.',
        `- A page stays under ${kib(ALERT_PAGE_BYTES)}. \`more\` is true when more alerts wait for the next poll.`,
        "- The same alerts always answer the same bytes.",
        "- Delivery is at least once: deduplicate by `id`.",
      ),
      parameters: [
        {
          name: "If-None-Match",
          in: "header",
          description: 'The last `ETag` received, `W/"alerts-<id>"`.',
          schema: str,
        },
      ],
      responses: {
        200: {
          ...ok("Alerts after the cursor.", ref("Alerts")),
          headers: { ETag: { schema: str } },
        },
        204: { description: "No cursor and no alerts." },
        304: {
          description: "Nothing after the cursor.",
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
      summary: "Server status",
      description:
        "The version, each source's state and back-off, the jobs, the instrument counts and the database size.\n\n- Each source has a `label`, `short` and `mark` for people, and a source that needs a key its `key`: the file, what it adds and where to get one. Each job has a `label` and what it does in `about`.\n- A scope is a market or an instrument a job runs for. `instruments` and `markets` count those with a run in the last 30 days, `failing_instruments` and `failing_markets` those whose latest run failed, `failing_scopes` both, and `failing` names up to 5 of them, newest first, with their error.",
      security: ADMIN_AUTH,
      responses: {
        200: ok("The status.", ref("Status")),
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
      summary: "Stored instruments",
      description: lines(
        "A page of the stored instruments, by id, with what keeps each one up to date.",
        "",
        "- Pass the last `id` as `after` while `more` is true.",
        "- `total` counts every match.",
        "- `tracked_by`: a rule, a recent read (until `read_until`), or the server's track list.",
        "- Listing does not count as a read.",
      ),
      security: ADMIN_AUTH,
      parameters: [
        query("query", "Matches the id or name, ignoring case."),
        query("after", "The last `id` of the previous page."),
        query("limit", `1 to ${MAX_PAGE}. Default: ${DEFAULT_PAGE}.`, int),
      ],
      responses: {
        200: ok("A page of instruments.", ref("AdminInstruments")),
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
      summary: "Fetch instruments again",
      description: lines(
        "Fetches the asked parts of stored instruments again, such as after a parser fix.",
        "",
        `- Stored ids only, at most ${ADMIN_SYMBOLS}, in a body of at most ${kib(ADMIN_BODY_BYTES)}.`,
        "- Spends the sources' rate limits.",
        `- The call has a ${DEADLINE_S}-second deadline.`,
      ),
      security: ADMIN_AUTH,
      requestBody: body(ref("RefetchArgs")),
      responses: {
        200: ok("Each part's outcome per symbol.", ref("Refetched")),
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
    get: {
      tags: ["admin"],
      operationId: "adminInstrument",
      summary: "One instrument",
      description: lines(
        "A stored instrument with its quote, returns and market session.",
        "",
        "- Counts as a read: keeps the instrument up to date and fetches a price that is due.",
      ),
      security: ADMIN_AUTH,
      parameters: [
        {
          name: "id",
          in: "path",
          description: "A stored instrument id, such as `US:NVDA`.",
          required: true,
          schema: str,
        },
      ],
      responses: {
        200: ok("The instrument.", ref("AdminInstrument")),
        400: r("BadArguments"),
        401: r("Unauthorized"),
        404: r("NotFound"),
        500: r("Internal"),
      },
    },
    delete: {
      tags: ["admin"],
      operationId: "adminDelete",
      summary: "Delete an instrument",
      description:
        "Deletes the instrument and all its stored rows. Refused with `conflict` while a rule reads it.",
      security: ADMIN_AUTH,
      parameters: [
        {
          name: "id",
          in: "path",
          description: "A stored instrument id, such as `US:NVDA`.",
          required: true,
          schema: str,
        },
      ],
      responses: {
        200: ok("What was deleted.", ref("Deleted")),
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
      summary: "OpenAPI document",
      security: [],
      responses: {
        200: {
          description: "The OpenAPI 3.1 document.",
          content: content(freeForm),
        },
        400: r("BadArguments"),
      },
    },
  },
  "/docs": {
    get: {
      tags: ["docs"],
      operationId: "docs",
      summary: "API docs page",
      description: "This page. It loads nothing from other hosts.",
      security: [],
      responses: {
        200: { description: "The page.", content: { "text/html": {} } },
      },
    },
  },
  "/docs/{file}": {
    get: {
      tags: ["docs"],
      operationId: "docsFile",
      summary: "Docs page files",
      description:
        "The page's script and style. Any `h`, stale or missing, answers the current file.",
      security: [],
      parameters: [
        {
          name: "file",
          in: "path",
          description: "One of the page's files.",
          required: true,
          schema: values(DOC_FILES),
        },
        query("h", "The file's fingerprint, for caching."),
      ],
      responses: {
        200: { description: "The file." },
        400: r("BadArguments"),
      },
    },
  },
};
