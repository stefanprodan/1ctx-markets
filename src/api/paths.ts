// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import {
  MAX_DASHBOARD_SYMBOLS,
  MAX_SECTION_NAME,
  MAX_SECTION_SYMBOLS,
  MAX_SECTIONS,
} from "../admin/dashboard.ts";
import {
  MAX_BODY_BYTES as ADMIN_BODY_BYTES,
  DEFAULT_PAGE,
  MAX_PAGE,
} from "../admin/http.ts";
import { SCREEN_NAMES, SCREENS, SORT_NAMES } from "../admin/screener.ts";
import { INTRADAY_SESSIONS } from "../market/intraday.ts";
import { TRACK_DAYS } from "../market/tracking.ts";
import { LAST_TRIGGERS } from "../operations/alerts.ts";
import { MAX_SYMBOL } from "../operations/args.ts";
import { MAX_EVENT_SYMBOLS } from "../operations/events.ts";
import { DEFAULT_MONTHS } from "../operations/history.ts";
import { AVERAGES } from "../operations/movers.ts";
import { MAX_SYMBOLS } from "../operations/quote.ts";
import {
  FILINGS_RECENT,
  MAX_RESEARCH_SYMBOLS,
  RESEARCH_PARTS,
  SINCE_DAYS,
  WEEK_ITEMS,
} from "../operations/research.ts";
import { MAX_FIELDS, MAX_FILTERS } from "../operations/screen.ts";
import {
  MAX_COMPARISONS,
  MAX_DEPTH,
  MAX_INSTRUMENTS,
  MAX_NOTE,
} from "../rules/format.ts";
import { ALERTS_KEPT_DAYS, ALERTS_PAGE } from "../rules/store.ts";
import { CALLS_PER_MINUTE } from "../server/ratelimit.ts";
import { SUMMARY_EXPIRIES } from "../sources/yahoo/options.ts";
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

// read is an agent key's scope; the admin key holds every scope; a login
// opens every route, the admin routes an admin's only
const READ_AUTH = [{ read: [] }, { admin: [] }, { session: [] }];
const ALERTS_READ_AUTH = [{ alertsRead: [] }, { admin: [] }, { session: [] }];
const ALERTS_WRITE_AUTH = [{ alertsWrite: [] }, { admin: [] }, { session: [] }];
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
    "No such route, alert, key, instrument or symbol (`not_found`); a name with several listings (`candidates`, with ids to pick from); a symbol whose source is off (`no_data`) or that this server does not serve (`refused`).",
  ),
  NotStored: error(
    "No stored instrument for the symbol (`not_found`). Nothing is fetched.",
  ),
  Conflict: error(
    "The alert or instrument refuses it in its current state (`conflict`, `split_paused`).",
  ),
  Forbidden: error(
    "A request other than GET or HEAD with the session cookie, not sent from this server's own pages (`forbidden`).",
  ),
  NoAlerts: error(
    "A key without alerts access, or one that reads only on a write (`forbidden`).",
  ),
  AdminOnly: error(
    "Not for this caller: an agent key on an admin or web UI route, a member's sign-in on an admin route, or a cookie request not sent from this server's own pages (`forbidden`).",
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

export const SYMBOL = `${FORMS[0].toUpperCase()}${FORMS.slice(1)}. At most ${MAX_SYMBOL} characters. A \`^\` may be sent raw or as \`%5E\`.`;

const STORED_SYMBOL =
  "A stored id (`US:NVDA`) or a symbol as written (`VVSM.DE`, `^VIX`). A `^` may be sent raw or as `%5E`.";

export const symbolParam = (description: string) => ({
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

const alerted = (extra: object = {}) => reads({ 403: r("NoAlerts"), ...extra });

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
        "- `sma` holds the daily and weekly SMA 50 and SMA 200, with today's price counted (`live`, or `close` once its market closed) or as of the last final bar (`final`).",
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
          "`true` adds `extended`, the last pre- or post-market price, `extended_reason`, why it is null, and `opens`, the next regular start while closed once the source names it. Default: `false`.",
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
        "- `valuation`, for a share whose metrics come from a foreign listing, holds its P/E, forward P/E, PEG and EPS per US share.",
        `- News gives counts by sentiment and the ${WEEK_ITEMS} articles that take a side first.`,
        `- \`filings\` holds a US share's ${FILINGS_RECENT} newest SEC filings and three flags: a late filing, a restatement, new securities registered or offered.`,
        "- `top_holdings`, only when asked, holds an ETF's or mutual fund's ten largest holdings, asset split and sectors, on any exchange.",
        `- \`options\`, only when asked and for one symbol, holds the implied move, implied volatility and open interest of the nearest ${SUMMARY_EXPIRIES} expiries and of the first to price the next earnings report.`,
        "- A share not researched before is fetched within the call, from a rate-limited source.",
        DEADLINE,
        READ,
      ),
      parameters: [
        csv("symbols", symbols(MAX_RESEARCH_SYMBOLS), str, true),
        csv(
          "sections",
          "Comma-separated. Default: all but `top_holdings` and `options`. A section left out is not fetched. `options` takes one symbol.",
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
        "- A regional source's listings come from the lists it last read, none before its first read.",
      ),
      parameters: [
        query("query", "A name or symbol.", str, true),
        query(
          "upstream",
          "`false` answers only what is stored: instruments and a regional source's listings, asking no source, for an answer at once. Default: `true`.",
          bool,
        ),
      ],
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
        "- `tracked_by`: a rule, a dashboard, a recent read (until `read_until`), or `world_markets`: the server's built-in list of indices, commodities, currencies and crypto, always kept up to date.",
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
  "/screener": {
    get: {
      tags: ["instruments"],
      operationId: "screenInstruments",
      security: ADMIN_AUTH,
      summary: "Screen the stored instruments",
      description: lines(
        "A page of the instruments kept up to date that one ready-made screen keeps, read from their stored quotes and latest daily signals in one pass. It fetches nothing and counts as no read.",
        "",
        "- `moves`: every instrument, by the size of the day's move either way.",
        "- `near_high`: `drawdown` -3 or above. `off_high`: `drawdown` -20 or below.",
        "- `oversold`: `rsi14` 30 or under. `overbought`: `rsi14` 70 or over. Currencies stay out of both.",
        "- A series (`SERIES`) is in `moves` only.",
        "- `counts` holds every screen's matches for the `type` asked; `kinds` every stored kind with its instruments, whatever the `type`.",
        "- A sort puts rows without the figure last either way; ties go by ticker.",
        "- `return_1m` and `return_1y` are the quote's `returns`, in points for a series whose `unit` is percent.",
        "- `trend`: `up` with the 50-day average over the 200-day and the price above the 200-day, `down` with both the other way, `mixed` otherwise; null without the figures.",
        "- Pass `next_page_token` as `page_token`, with the same arguments, for the next page; it is absent on the last.",
      ),
      parameters: [
        csv(
          "type",
          "Stored kinds to keep, as `kinds` names them (`EQUITY`, `ETF`). Default: every kind.",
        ),
        query(
          "screen",
          `The screen. Default: \`moves\`.`,
          values(SCREEN_NAMES),
        ),
        query(
          "sort",
          `The order. Default: the screen's own (${SCREEN_NAMES.map((s) => `\`${s}\` by \`${SCREENS[s].sort}\` ${SCREENS[s].order}`).join(", ")}).`,
          values(SORT_NAMES),
        ),
        query(
          "order",
          "`asc` or `desc`; needs `sort`. Default: `asc` for `symbol`, else `desc`.",
          values(["asc", "desc"]),
        ),
        query("page_size", `1 to ${MAX_PAGE}. Default: ${DEFAULT_PAGE}.`, int),
        query("page_token", "The `next_page_token` of the page before."),
      ],
      responses: admins({
        200: ok("A page of the screen.", ref("Screener")),
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
        "- An ETF or mutual fund adds `top_holdings`: its ten largest holdings, asset split and sectors.",
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
        "- Refused with `conflict` while an alert reads it; `rules` names their ids.",
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
  "/instruments/{symbol}/stored": {
    get: {
      tags: ["instruments"],
      operationId: "instrumentStored",
      security: ADMIN_AUTH,
      summary: "Whether an instrument is stored",
      description: lines(
        "Whether reading this symbol answers from what the server already holds (`stored: true`), or first fetches it from its source (`false`), which can take seconds.",
        "",
        "- Asks no source, fetches nothing and does not count as a read.",
        "- A symbol never seen answers `false`.",
      ),
      parameters: [symbolParam(STORED_SYMBOL)],
      responses: admins({
        200: ok("Whether it is stored.", ref("Stored")),
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
          "With `5m` only: `true` adds `extended_points`, the pre- and post-market closes of the sessions answered, read while the regular session is closed, and `extended_reason`, why the list is empty. Default: `false`.",
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
  "/alerts": {
    get: {
      tags: ["alerts"],
      operationId: "listAlerts",
      security: ALERTS_READ_AUTH,
      summary: "Price alerts",
      description: lines(
        "Your alerts, by id, each with its condition, state and how close it is now.",
        "",
        "- `when` is the condition in its canonical form, to edit and send back.",
        "- `state`: `watching` (the next true triggers), `triggered` (it waits for a false, then triggers again at most once a trading session), `waiting_for_earnings`, `paused`, `split_paused` (update it with new levels), `unknown` (`reasons` say why; it never triggers).",
        "- `now` holds each comparison, in the order `when` gives them: the left side's `value`, the `level` it is compared with, `gap` (level minus value, signed) and, between price levels, `gap_percent`.",
        "- The alert's `gap_percent` is how far from triggering: the farthest comparison of an `and`, the nearest of an `or`, price levels only, 0 once it holds.",
        "- Evaluated at this read on the stored prices and stored nowhere: a read never triggers.",
        `- ${ALERTS_PAGE} alerts a page. Pass \`next_page_token\` as \`page_token\` for the next; it is absent on the last.`,
      ),
      parameters: [
        query("symbol", "Only this symbol's alerts. Nothing is fetched."),
        query("page_token", "The `next_page_token` of the page before."),
      ],
      responses: alerted({ 200: ok("A page of alerts.", ref("AlertList")) }),
    },
    post: {
      tags: ["alerts"],
      operationId: "createAlert",
      security: ALERTS_WRITE_AUTH,
      summary: "Create a price alert",
      description: lines(
        "Creates an alert on live quotes. Answers it and its trigger, if its condition is true already, with its path in `Location`.",
        "",
        '- `when` is comparisons joined by `and` (first) and `or`, with parentheses: `"price < 180"`, `"rsi14 < 30 and price > sma200"`, `"price(^VIX) > 25"`.',
        "- A side is a number or a field as `quote` and `screen` name it; `field(symbol)` reads another symbol, `relative_return_1m(benchmark)` and `_3m` a relative return.",
        `- One unit per comparison, at most ${MAX_COMPARISONS} comparisons, ${MAX_DEPTH} levels and ${MAX_INSTRUMENTS} symbols. A refusal names the token and its position.`,
        "- It triggers when its condition turns true, at most once a trading session of its symbol, and again only after false.",
        `- \`note\` is at most ${MAX_NOTE} characters.`,
        "- Every symbol it names is resolved within the call. On any failure no alert is stored.",
        DEADLINE,
      ),
      requestBody: body(ref("AlertArgs")),
      responses: alerted({
        201: {
          ...ok("The alert created.", ref("AlertChanged")),
          headers: { Location: { schema: str } },
        },
        404: r("NotFound"),
        413: r("TooLarge"),
        415: r("UnsupportedType"),
        503: r("Unavailable"),
      }),
    },
  },
  "/alerts/history": {
    get: {
      tags: ["alerts"],
      operationId: "alertHistory",
      security: ALERTS_READ_AUTH,
      summary: "What triggered",
      description: lines(
        "Your triggers, newest first, with the `instruments` they name. For reading back; poll the feed to be told of new ones.",
        "",
        "- `values` holds each side read when it triggered, keyed as `when` writes it.",
        `- ${ALERTS_PAGE} a page. Pass \`next_page_token\` as \`page_token\` for the next older page; it is absent on the last.`,
        `- Kept ${ALERTS_KEPT_DAYS} days, also after their alert is deleted.`,
      ),
      parameters: [
        query("since", "From this UTC day, `YYYY-MM-DD`."),
        query("symbol", "Only this symbol's alerts. Nothing is fetched."),
        query("alert", "Only this alert's, a deleted one's too.", int),
        query("page_token", "The `next_page_token` of the page before."),
      ],
      responses: alerted({ 200: ok("A page of triggers.", ref("History")) }),
    },
  },
  "/alerts/feed": {
    get: {
      tags: ["alerts"],
      operationId: "alertFeed",
      security: ALERTS_READ_AUTH,
      summary: "Alerts feed",
      description: lines(
        "The triggers after the `If-None-Match` cursor, oldest first, or all kept ones without one. Meant to be polled on a schedule.",
        "",
        '- Send the last `ETag` (`W/"alerts-<id>"`) back as `If-None-Match` to get only newer ones.',
        `- A page stays under ${kib(ALERT_PAGE_BYTES)}. \`more\` is true when more wait for the next poll.`,
        "- The same triggers always answer the same bytes.",
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
          ...ok("Triggers after the cursor.", ref("Feed")),
          headers: { ETag: { schema: str } },
        },
        204: { description: "No cursor and no triggers." },
        304: {
          description: "Nothing after the cursor.",
          headers: { ETag: { schema: str } },
        },
        400: r("BadArguments"),
        401: r("Unauthorized"),
        403: r("NoAlerts"),
        429: r("TooMany"),
        500: r("Internal"),
      },
    },
  },
  "/alerts/seen": {
    get: {
      tags: ["alerts"],
      operationId: "alertsSeen",
      security: ADMIN_AUTH,
      summary: "Alerts seen",
      description:
        "The newest of your triggers the web UI marked seen, and how many came after it. A web UI route: an agent key is refused (`forbidden`).",
      responses: admins({ 200: ok("Seen and unseen.", ref("Seen")) }),
    },
    put: {
      tags: ["alerts"],
      operationId: "markAlertsSeen",
      security: ADMIN_AUTH,
      summary: "Mark alerts seen",
      description: lines(
        "Marks your triggers up to `id` seen and answers as the read.",
        "",
        "- It only moves forward: an older id leaves it as it was.",
        "- It stops at your newest trigger, so one triggered later is never seen ahead of time.",
      ),
      requestBody: body(ref("SeenArgs")),
      responses: admins({
        200: ok("Seen and unseen.", ref("Seen")),
        413: r("TooLarge"),
        415: r("UnsupportedType"),
      }),
    },
  },
  "/alerts/{id}": {
    parameters: [
      {
        name: "id",
        in: "path",
        description: "The alert's id.",
        required: true,
        schema: int,
      },
    ],
    get: {
      tags: ["alerts"],
      operationId: "getAlert",
      security: ALERTS_READ_AUTH,
      summary: "One price alert",
      description: `The alert as the list gives it, its last ${LAST_TRIGGERS} triggers, newest first, and the \`instruments\` they name.`,
      responses: alerted({
        200: ok("The alert.", ref("OneAlert")),
        404: r("NotFound"),
      }),
    },
    patch: {
      tags: ["alerts"],
      operationId: "updateAlert",
      security: ALERTS_WRITE_AUTH,
      summary: "Update, pause or resume an alert",
      description: lines(
        "Changes `when`, `note` or both, keeping the id and history; or, alone, `paused` pauses or resumes it.",
        "",
        "- A new `when` is a new question: it clears the session it last triggered in and a split pause, and is checked at once, its trigger in the answer when true.",
        "- The symbol never changes: another symbol is another alert.",
        "- `note` null clears it.",
        "- An alert paused by a split resumes only with a new `when` (`split_paused`).",
        DEADLINE,
      ),
      requestBody: body(ref("AlertChange")),
      responses: alerted({
        200: ok("The alert.", ref("AlertChanged")),
        404: r("NotFound"),
        409: r("Conflict"),
        413: r("TooLarge"),
        415: r("UnsupportedType"),
        503: r("Unavailable"),
      }),
    },
    delete: {
      tags: ["alerts"],
      operationId: "deleteAlert",
      security: ALERTS_WRITE_AUTH,
      summary: "Delete an alert",
      description: `Deletes the alert. Its history is kept until ${ALERTS_KEPT_DAYS} days old.`,
      responses: alerted({
        204: { description: "Deleted." },
        404: r("NotFound"),
      }),
    },
  },
  "/keys": {
    get: {
      tags: ["keys"],
      operationId: "listKeys",
      security: ADMIN_AUTH,
      summary: "Agent keys",
      description:
        "Your agent keys, expired ones included, with when each was made, last used and expires; an admin's list holds every person's, each with its `owner`. Never a key's token.",
      responses: admins({ 200: ok("The keys.", ref("Keys")) }),
    },
    post: {
      tags: ["keys"],
      operationId: "createKey",
      security: ADMIN_AUTH,
      summary: "Make an agent key",
      description: lines(
        "Makes a key for your agent and answers its token, once. It acts as you; nobody makes a key for someone else.",
        "",
        "- An agent key opens what the read scope opens: market data, instruments and MCP. Never an admin route.",
        "- `portfolio` is `read` or `write` to open the portfolio routes and the portfolio tool; `none` by default.",
        "- `alerts` is `read` to open the alerts, their history and the feed, and the `alerts` tool, `write` to also create, update, pause and delete them and list `alerts_edit`; `none` by default.",
        "- `profile` is `read` to open the profile routes and the `profile` tool, `write` to also save it and list `profile_edit`; `none` by default.",
        "- `analysis` is `read` to open the analysis routes and the `analysis` tool, `write` to also save one and list `analysis_edit`; `none` by default.",
        "- `trade_plans` is `read` to open the trade plans routes, the `trade_plans` tool and the `trade_plans` pointer in `quote`, `write` to also save them and list `trade_plans_edit`; `none` by default.",
        "- At most `limit` keys a person (`GET /keys`), expired ones included. Revoke one to make another.",
        "- A name is unique among your keys (`conflict`).",
      ),
      requestBody: body(ref("KeyArgs")),
      responses: admins({
        201: ok("The key and its token.", ref("MadeKey")),
        409: error(
          "The name is taken or reserved, or there are already as many keys as allowed (`conflict`).",
        ),
        413: r("TooLarge"),
        415: r("UnsupportedType"),
      }),
    },
  },
  "/keys/{id}": {
    patch: {
      tags: ["keys"],
      operationId: "setKeyAccess",
      security: ADMIN_AUTH,
      summary: "Change an agent key's access",
      description: lines(
        "Sets the key's portfolio, alerts, profile, analysis or trade plans access, or more than one. Answers the key as the list does.",
        "",
        "- The token, name and expiry stay. An expired key changes too.",
        "- The key's next call is held to the new access.",
      ),
      parameters: [
        {
          name: "id",
          in: "path",
          description: "The key's id.",
          required: true,
          schema: str,
        },
      ],
      requestBody: body(ref("KeyAccess")),
      responses: admins({
        200: ok("The key.", ref("OneKey")),
        404: r("NotFound"),
        413: r("TooLarge"),
        415: r("UnsupportedType"),
      }),
    },
    delete: {
      tags: ["keys"],
      operationId: "revokeKey",
      security: ADMIN_AUTH,
      summary: "Revoke an agent key",
      description:
        "Deletes the key. Its next call is refused, and a write it has in flight writes nothing. An admin revokes anyone's.",
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
  "/dashboard": {
    get: {
      tags: ["dashboard"],
      operationId: "getDashboard",
      security: ADMIN_AUTH,
      summary: "The dashboard",
      description: lines(
        "The web UI's home page: named sections of instruments, each item with its stored price, its market's session and its distance from its averages.",
        "",
        "- Until the first save, `created` is false and the sections are World markets' groups in order, each with its first four symbols that resolved; one that failed lets the next move up. `track` says which are in or still `pending`; a save while one is pending would leave it out for good.",
        "- While a World markets index's market is closed and its futures traded after its close, the item carries `futures`, which a page shows in the index's place.",
        "- Each instrument on a saved dashboard is kept up to date while it is there; `tracked_by` says `dashboard`.",
        "- `averages` are in percent from the price to the daily 50 and 200 day and the weekly 200 week simple moving averages; `crossed_today` follows `movers`: the last final close on or below the average and the price above it, or the reverse.",
        "- Fetches nothing and does not count as a read.",
      ),
      responses: admins({ 200: ok("The dashboard.", ref("Dashboard")) }),
    },
    put: {
      tags: ["dashboard"],
      operationId: "saveDashboard",
      security: ADMIN_AUTH,
      summary: "Save the dashboard",
      description: lines(
        "Replaces the whole layout and answers the saved dashboard.",
        "",
        "- `revision` is the one the dashboard last answered; another answers `conflict` with the stored dashboard, so a second tab never overwrites a change unseen.",
        `- At most ${MAX_SECTIONS} sections, ${MAX_SECTION_SYMBOLS} symbols in one and ${MAX_DASHBOARD_SYMBOLS} in all. A name is 1 to ${MAX_SECTION_NAME} characters, unique ignoring case. \`view\` is \`cards\` or \`table\`.`,
        `- Each symbol is ${FORMS}. An instrument named twice keeps its first place.`,
        "- A symbol not seen before is fetched within the call. If any symbol does not resolve, nothing is saved and `errors` says why for each.",
        `- The call has a ${DEADLINE_S}-second deadline.`,
      ),
      requestBody: body(ref("DashboardArgs")),
      responses: admins({
        200: ok("The saved dashboard.", ref("Dashboard")),
        409: error(
          "The dashboard changed since `revision` (`conflict`); `dashboard` is the stored one.",
        ),
        413: r("TooLarge"),
        415: r("UnsupportedType"),
        422: error(
          "A symbol did not resolve (`unresolved`); `errors` holds each one's input and error. Nothing is saved.",
        ),
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
        "The version, each source's state and back-off, the jobs, the instrument counts and the database size.\n\n- `sync` is false while the server is set to run no job: each job's last run is from before, and a read still fetches a symbol not stored.\n- Each source has a `label`, `short` and `mark` for people, and a source that needs a key its `key`: the file, what it adds and where to get one. Each job has a `label` and what it does in `about`.\n- A scope is a market or an instrument a job runs for. `instruments` and `markets` count those with a run in the last 30 days, `failing_instruments` and `failing_markets` those whose latest run failed, `failing_scopes` both, and `failing` names up to 5 of them, newest first, with their error: a fixed phrase, which may be followed by the symbols the failure is down to (`source error: AMD`).",
      responses: admins({ 200: ok("The status.", ref("Status")) }),
    },
  },
  "/status/retry": {
    post: {
      tags: ["server"],
      operationId: "retryFailed",
      security: ADMIN_AUTH,
      summary: "Retry failed jobs",
      description: lines(
        "Asks again, at once, for each instrument whose latest run of a job failed, as listed by `GET /status`: only what failed, such as one share's news or key figures. Answers how many were asked, fetched, failed and left out.",
        "",
        "- Takes no body.",
        "- Leaves out a job that runs for a whole market, such as live prices; it runs again soon on its own.",
        "- Leaves out a job whose source is off.",
        "- A job that succeeds leaves the failing list; one that fails again stays in it with its new error.",
        "- Spends the sources' rate limits.",
        `- The call has a ${DEADLINE_S}-second deadline; what it cuts off waits for its job's next run.`,
      ),
      responses: admins({
        200: ok("How many were asked again.", ref("Retried")),
      }),
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
