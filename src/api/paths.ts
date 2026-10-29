// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import {
  MAX_BODY_BYTES as ADMIN_BODY_BYTES,
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
import { MAX_KEYS } from "../server/access.ts";
import { CALLS_PER_MINUTE } from "../server/ratelimit.ts";
import { ALERT_PAGE_BYTES } from "./alerts.ts";
import { DOC_FILES } from "./docs.ts";
import { MAX_BODY_BYTES, PROBLEM_TYPE } from "./http.ts";
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

// read is an agent key's scope; the admin key holds every scope; the web
// UI's cookie opens every route but the rules writes
const READ_AUTH = [{ read: [] }, { admin: [] }, { session: [] }];
const WRITE_AUTH = [{ read: [] }, { admin: [] }];
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
  content: { [PROBLEM_TYPE]: { schema: ref("Problem") } },
});

const kib = (bytes: number) => `${bytes / 1024} KiB`;

export const responses = {
  BadArguments: error(
    "A bad argument: unknown, repeated or out of range (`bad_arguments`), units that do not mix (`mixed_units`), no earnings source (`no_event_source`) or no event (`no_event`). The message says which.",
  ),
  Unauthorized: error("Missing, wrong, revoked or expired key."),
  NotFound: error(
    "No such route, rule, key, instrument or symbol (`not_found`); a name with several listings (`candidates`, with ids to pick from); a symbol whose source is off (`no_data`) or that this server does not serve (`refused`).",
  ),
  NotStored: error(
    "No stored instrument for the symbol (`not_found`). Nothing is fetched.",
  ),
  Conflict: error(
    "The rule or instrument refuses it in its current state (`conflict`, `split_paused`).",
  ),
  Forbidden: error(
    "A request other than GET or HEAD with the session cookie, not sent from this server's own pages (`forbidden`).",
  ),
  AdminOnly: error(
    "A key without this route's scope: an agent key on an admin route, or a cookie request not sent from this server's own pages (`forbidden`).",
  ),
  TooMany: {
    ...error(
      `Over ${CALLS_PER_MINUTE} calls in a minute with this key (\`too_many_requests\`). \`Retry-After\` says how many seconds until it opens again.`,
    ),
    headers: { "Retry-After": { schema: int } },
  },
  TooLarge: error(
    `A body over ${kib(MAX_BODY_BYTES)} (${kib(ADMIN_BODY_BYTES)} on refetch). Over 1 MiB the answer is an empty body and the connection closes.`,
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
  "a stored id (`US:NVDA`), a symbol as written with its exchange suffix (`VVSM.DE`, `BRK-B`, `^VIX`, `CL=F`), `FRED:<series id>` or a name";

const SYMBOL = `${FORMS[0].toUpperCase()}${FORMS.slice(1)}. At most ${MAX_SYMBOL} characters. A \`^\` may be sent raw or as \`%5E\`.`;

const STORED_SYMBOL =
  "A stored id (`US:NVDA`) or a symbol as written (`VVSM.DE`, `^VIX`). A `^` may be sent raw or as `%5E`.";

const symbolParam = (description: string) => ({
  name: "symbol",
  in: "path" as const,
  description,
  required: true,
  schema: str,
});

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
  429: r("TooMany"),
  500: r("Internal"),
  ...extra,
});

const admins = (extra: object = {}) => ({
  400: r("BadArguments"),
  401: r("Unauthorized"),
  403: r("AdminOnly"),
  429: r("TooMany"),
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
        "The live price, change and moving averages of each symbol, in the order asked. Each item is a quote or its own `error`.",
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
  "/research": {
    get: {
      tags: ["market data"],
      operationId: "research",
      security: READ_AUTH,
      summary: "Research and news",
      description: lines(
        "For each symbol, in the order asked: a US share's `company` research and its recent `news`; a US ETF's news only. Each item is a result or its own `error`.",
        "",
        "- `company` holds metrics, analysts, earnings and insider sentiment with their newest rows, and the next earnings event.",
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
      responses: reads({ 200: ok("The research.", ref("Research")) }),
    },
  },
  "/symbols": {
    get: {
      tags: ["market data"],
      operationId: "symbols",
      security: READ_AUTH,
      summary: "Find instruments",
      description: lines(
        "Listings that match a name or symbol, each with the `id` to pass to the other routes.",
        "",
        "- Stored instruments come first, then other listings.",
        "- Fetches no prices and does not count as a read.",
        "- A source that failed is listed in `errors`, beside the other matches.",
        "- A series not stored yet is found only as `FRED:<series id>`.",
      ),
      parameters: [query("query", "A name or symbol.", str, true)],
      responses: reads({ 200: ok("The matches.", ref("Symbols")) }),
    },
  },
  "/earnings": {
    get: {
      tags: ["market data"],
      operationId: "earnings",
      security: READ_AUTH,
      summary: "Earnings dates",
      description: lines(
        "Earnings between `from` and `to`, by date, for the tracked US shares or the symbols named.",
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
      responses: reads({ 200: ok("The earnings.", ref("Earnings")) }),
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
        "The symbols whose latest signals pass every filter, sorted, with any extra `fields`. A read: it creates nothing.",
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
  "/instruments": {
    get: {
      tags: ["instruments"],
      operationId: "listInstruments",
      security: ADMIN_AUTH,
      summary: "Stored instruments",
      description: lines(
        "A page of the stored instruments, by id, with what keeps each one up to date.",
        "",
        "- Pass `next_page_token` as `page_token` for the next page; it is absent on the last.",
        "- `total` counts every match.",
        "- `tracked_by`: a rule, a recent read (until `read_until`), or the watchlist.",
        "- Listing does not count as a read and fetches nothing.",
      ),
      parameters: [
        query("query", "Matches the id or name, ignoring case."),
        query("page_size", `1 to ${MAX_PAGE}. Default: ${DEFAULT_PAGE}.`, int),
        query("page_token", "The `next_page_token` of the page before."),
      ],
      responses: admins({
        200: ok("A page of instruments.", ref("Instruments")),
      }),
    },
  },
  "/instruments/{symbol}": {
    get: {
      tags: ["instruments"],
      operationId: "getInstrument",
      security: READ_AUTH,
      summary: "One instrument",
      description: lines(
        "One instrument with its full quote: returns, market session and any pre- or post-market price.",
        "",
        "- A stored instrument whose read fails answers its stored row, a null `quote` and the `error`.",
        UNSEEN,
        DEADLINE,
        READ,
      ),
      parameters: [symbolParam(SYMBOL)],
      responses: reads({
        200: ok("The instrument.", ref("Instrument")),
        404: r("NotFound"),
        503: r("Unavailable"),
      }),
    },
    delete: {
      tags: ["instruments"],
      operationId: "deleteInstrument",
      security: ADMIN_AUTH,
      summary: "Delete an instrument",
      description: lines(
        "Deletes a stored instrument and all its stored rows.",
        "",
        "- Refused with `conflict` while a rule reads it; `rules` names them.",
        "- Its alerts are kept.",
      ),
      parameters: [symbolParam(STORED_SYMBOL)],
      responses: admins({
        204: { description: "Deleted." },
        404: r("NotStored"),
        409: r("Conflict"),
      }),
    },
  },
  "/instruments/{symbol}/refetch": {
    post: {
      tags: ["instruments"],
      operationId: "refetchInstrument",
      security: ADMIN_AUTH,
      summary: "Fetch an instrument again",
      description: lines(
        "Fetches the asked parts of a stored instrument again, such as after a parser fix. Answers each part's outcome.",
        "",
        `- A body of at most ${kib(ADMIN_BODY_BYTES)}.`,
        "- Spends the sources' rate limits.",
        `- The call has a ${DEADLINE_S}-second deadline.`,
      ),
      parameters: [symbolParam(STORED_SYMBOL)],
      requestBody: body(ref("RefetchArgs")),
      responses: admins({
        200: ok("Each part's outcome.", ref("Refetched")),
        404: r("NotStored"),
        413: r("TooLarge"),
        415: r("UnsupportedType"),
      }),
    },
  },
  "/instruments/{symbol}/bars": {
    get: {
      tags: ["instruments"],
      operationId: "bars",
      security: READ_AUTH,
      summary: "Daily or weekly bars, or 5-minute closes",
      description: lines(
        "One instrument's daily or weekly bars, oldest first, with open, high, low, close, volume and SMA 50 and SMA 200; or with `interval` `5m`, its 5-minute closes. The instrument's facts come in `instrument`.",
        "",
        "- Up to ten years of history.",
        "- The latest session's bar is the live quote. `final` stays false until the source reports a later session.",
        "- Prices are split-adjusted, without dividends or currency conversion.",
        "- `session` is the market's last regular session.",
        "- A range with `to` before today and only final bars, without `benchmark`, may be cached for an hour.",
        `- \`5m\` answers \`points\` instead of \`bars\`: the regular session's closes as the quote passes stored them, up to the last ${INTRADAY_SESSIONS} sessions, without averages, and \`previous_close\`, what a move is measured from. \`from\` and \`to\` are session dates, the newest stored session by default. A source with no such closes, or none stored in the range, answers \`no_data\`.`,
        STALE,
        UNSEEN,
        DEADLINE,
        READ,
      ),
      parameters: [
        symbolParam(SYMBOL),
        query(
          "interval",
          "`1d`, `1wk` or `5m`. Default: `1d`.",
          values(["1d", "1wk", "5m"]),
        ),
        query(
          "from",
          `\`YYYY-MM-DD\`. Default: ${DEFAULT_MONTHS["1d"]} months before \`to\` for \`1d\`, ${DEFAULT_MONTHS["1wk"]} months for \`1wk\`.`,
        ),
        query(
          "to",
          "`YYYY-MM-DD`. Default: the latest bar; with `5m`, the newest stored session.",
        ),
        query(
          "benchmark",
          "A symbol to compare with. Adds `relative`: the 1- and 3-month return against it, in percentage points. Not taken with `5m`.",
        ),
        query(
          "extended",
          "With `5m` only: `true` adds `extended_points`, the pre- and post-market closes of the sessions answered, read while the regular session is closed. Default: `false`.",
          bool,
        ),
      ],
      responses: reads({
        200: ok("The bars, or the points.", ref("BarsAnswer")),
        404: r("NotFound"),
        503: r("Unavailable"),
      }),
    },
  },
  "/watchlist": {
    get: {
      tags: ["instruments"],
      operationId: "watchlist",
      security: READ_AUTH,
      summary: "The watchlist",
      description: lines(
        "The instruments this server keeps up to date by its configuration, in its order, each with its stored price and its market's session.",
        "",
        "- Set where the server starts; it cannot be changed here.",
        "- A value is `pending` until it resolves, or names the error that stopped it.",
        "- Fetches nothing and does not count as a read.",
      ),
      responses: reads({ 200: ok("The watchlist.", ref("Watchlist")) }),
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
      security: WRITE_AUTH,
      summary: "Create a price rule",
      description: lines(
        "Creates a rule on live quotes. Answers the rule, its first evaluation and any alert it fired, with the rule's path in `Location`.",
        "",
        "- The condition is a fixed tree, not an expression.",
        "- An alert fires when the condition turns true, and again only after it was false.",
        `- \`note\` is at most ${MAX_NOTE} characters.`,
        "- Every symbol it names is resolved within the call. On any failure no rule is stored.",
        DEADLINE,
      ),
      requestBody: body(ref("RuleArgs")),
      responses: reads({
        201: {
          ...ok("The rule created.", ref("Created")),
          headers: { Location: { schema: str } },
        },
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
    get: {
      tags: ["rules"],
      operationId: "getRule",
      security: READ_AUTH,
      summary: "One price rule",
      description:
        "The rule with its condition, pause, whether it is armed, and its last result.",
      responses: reads({
        200: ok("The rule.", ref("OneRule")),
        404: r("NotFound"),
      }),
    },
    patch: {
      tags: ["rules"],
      operationId: "pauseRule",
      security: WRITE_AUTH,
      summary: "Pause or resume a rule",
      description: lines(
        "Sets or clears the rule's manual pause.",
        "",
        "- A rule paused by a split cannot be resumed (`split_paused`): its levels predate the split. Delete it and create it again.",
      ),
      requestBody: body(ref("Pause")),
      responses: reads({
        200: ok("The rule.", ref("OneRule")),
        404: r("NotFound"),
        409: r("Conflict"),
        413: r("TooLarge"),
        415: r("UnsupportedType"),
      }),
    },
    delete: {
      tags: ["rules"],
      operationId: "deleteRule",
      security: WRITE_AUTH,
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
        429: r("TooMany"),
        500: r("Internal"),
      },
    },
  },
  "/keys": {
    get: {
      tags: ["keys"],
      operationId: "listKeys",
      security: ADMIN_AUTH,
      summary: "Agent keys",
      description:
        "Every agent key, expired ones included, with when it was made, last used and expires. Never a key's token.",
      responses: admins({ 200: ok("The keys.", ref("Keys")) }),
    },
    post: {
      tags: ["keys"],
      operationId: "createKey",
      security: ADMIN_AUTH,
      summary: "Make an agent key",
      description: lines(
        "Makes a key for an agent and answers its token, once.",
        "",
        "- An agent key opens what the read scope opens: market data, instruments, rules, the alerts feed and MCP. Never an admin route.",
        `- At most ${MAX_KEYS} keys, expired ones included. Revoke one to make another.`,
        "- A name is unique among the keys (`conflict`).",
      ),
      requestBody: body(ref("KeyArgs")),
      responses: admins({
        201: ok("The key and its token.", ref("MadeKey")),
        409: error(
          "The name is taken, or there are already as many keys as allowed (`conflict`).",
        ),
        413: r("TooLarge"),
        415: r("UnsupportedType"),
      }),
    },
  },
  "/keys/{id}": {
    delete: {
      tags: ["keys"],
      operationId: "revokeKey",
      security: ADMIN_AUTH,
      summary: "Revoke an agent key",
      description: "Deletes the key. Its next call is refused.",
      parameters: [
        {
          name: "id",
          in: "path",
          description: "The key's id.",
          required: true,
          schema: str,
        },
      ],
      responses: admins({
        204: { description: "Revoked." },
        404: r("NotFound"),
      }),
    },
  },
  "/status": {
    get: {
      tags: ["server"],
      operationId: "status",
      security: ADMIN_AUTH,
      summary: "Server status",
      description:
        "The version, each source's state and back-off, the jobs, the instrument counts and the database size.\n\n- Each source has a `label`, `short` and `mark` for people, and a source that needs a key its `key`: the file, what it adds and where to get one. Each job has a `label` and what it does in `about`.\n- A scope is a market or an instrument a job runs for. `instruments` and `markets` count those with a run in the last 30 days, `failing_instruments` and `failing_markets` those whose latest run failed, `failing_scopes` both, and `failing` names up to 5 of them, newest first, with their error.",
      responses: admins({ 200: ok("The status.", ref("Status")) }),
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
