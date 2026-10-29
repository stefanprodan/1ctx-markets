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
// an object whose fields this spec leaves open
export const freeForm: Schema = { type: "object" };
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
const note = (s: Schema, description: string): Schema => ({
  ...s,
  description,
});

export const DEADLINE_S = CALL_MS / 1000;

const itemError = object({
  input: str,
  error: object(
    {
      code: values(ERRORS),
      detail: str,
      candidates: list(ref("Candidate")),
    },
    ["code", "detail"],
  ),
});

const session = nullable(
  object({ state: values(["open", "closed"]), start: nstr, end: nstr }),
);

// a stored instrument as the list gives it: no read, no fetch
const instrumentRow = object({
  id: str,
  name: nstr,
  market: str,
  exchange: str,
  currency: nstr,
  kind: str,
  unit: values(UNITS),
  source: str,
  tracked: bool,
  tracked_by: note(
    list(values(["rule", "read", "track"])),
    "What keeps it up to date: a rule, a recent read or the watchlist.",
  ),
  read_at: nstr,
  read_until: nstr,
  price: note(
    nnum,
    "The stored price, or a series' latest value. Listing fetches nothing.",
  ),
  change: nnum,
  change_percent: nnum,
  fetched_at: nstr,
});

const facts = {
  id: str,
  name: nstr,
  exchange: str,
  type: str,
  currency: nstr,
  unit: values(UNITS),
  source: str,
};

const STALE = "Why a value may be out of date. Empty means current.";

const company = note(
  object({ source: str }, ["source"], true),
  "A US share's metrics, analysts, earnings, insider sentiment and next earnings event, with the sections asked.",
);
const news = object({ source: str }, ["source"], true);

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
  observation: note(
    nullable(object({ date: str, value: num })),
    "The last value of a `FRED:<series id>` symbol.",
  ),
  previous_close: nnum,
  change: nnum,
  change_percent: nnum,
  unit: note(values(UNITS), "What the price measures."),
  currency: nstr,
  trade_time: nstr,
  fetched_at: note(nstr, "When the source answered."),
  stale: note(
    list(str),
    "Why a value may be out of date. Empty means current.",
  ),
  sma: note(
    object({ daily: averages, weekly: averages }),
    "SMA 50 and SMA 200, `live` with today's price or `final` as of the last final bar. Null with too few bars.",
  ),
  last_final: note(
    nullable(
      object({
        daily: object({ date: str, close: nnum, sma50: nnum, sma200: nnum }),
      }),
    ),
    "The last final daily close and its averages. Null with no final bar.",
  ),
};

// every brief field but a FRED series' observation is always there
const briefRequired = Object.keys(brief).filter((k) => k !== "observation");

// a $ref takes no null beside it, so an alert that may be null is inline
const alert = object(
  {
    id: int,
    rule_id: int,
    fired_at: str,
    truncated: note(
      bool,
      "Too large for a page: only the id, rule and time are kept.",
    ),
  },
  ["id", "rule_id", "fired_at"],
  true,
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
  Problem: object(
    {
      title: note(str, "The HTTP status's phrase."),
      status: note(int, "The HTTP status."),
      detail: str,
      code: note(
        str,
        "The error, such as `bad_arguments`, `not_found` or `candidates`.",
      ),
      input: note(str, "The symbol the error is about."),
      candidates: note(
        list(ref("Candidate")),
        "With `candidates`: the listings to pick an id from.",
      ),
      rules: note(list(int), "With `conflict`: the rules reading it."),
    },
    ["title", "status", "detail", "code"],
    true,
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
  Quotes: object({ attribution: str, quotes: list(ref("QuoteItem")) }, [
    "quotes",
  ]),
  Bar: object({
    date: str,
    open: nnum,
    high: nnum,
    low: nnum,
    close: nnum,
    volume: note(nnum, "Null where the source gives none."),
    final: note(
      bool,
      "False until the source reports a later session; a weekly bar also waits for its week to end.",
    ),
    sma50: nnum,
    sma200: nnum,
  }),
  Bars: object(
    {
      input: note(str, "The symbol as sent."),
      instrument: object({
        ...facts,
        basis: note(str, "How prices are adjusted."),
      }),
      stale: note(list(str), STALE),
      attribution: str,
      from: str,
      to: str,
      session: note(
        session,
        "The last regular session, in UTC. Crypto is always open with null times. Null for a `FRED:<series id>` symbol.",
      ),
      interval: values(["1d", "1wk"]),
      relative: object({ benchmark: freeForm }, ["benchmark"], true),
      bars: list(ref("Bar")),
    },
    [
      "input",
      "instrument",
      "stale",
      "from",
      "to",
      "session",
      "interval",
      "bars",
    ],
  ),
  Point: object({
    at: note(str, "UTC, to the second."),
    session: note(str, "The session's date in the market's zone."),
    close: num,
    final: note(
      bool,
      "False only for the newest point while its session trades; crypto's newest point never is.",
    ),
  }),
  Intraday: object(
    {
      input: note(str, "The symbol as sent."),
      instrument: object(facts),
      stale: note(list(str), STALE),
      from: note(str, "The first session date."),
      to: note(str, "The last session date."),
      session: note(
        session,
        "The last regular session, in UTC. Crypto is always open with null times.",
      ),
      interval: values(["5m"]),
      sessions: note(
        list(object({ session: str, fetched_at: str })),
        "Each session's newest answer.",
      ),
      previous_close: note(
        nullable(num),
        "What a move is measured from: the quote's previous close when the quote's trade date is the first session's, else the last daily close before the first session.",
      ),
      points: list(ref("Point")),
      extended_points: note(
        list(
          object({
            at: note(str, "UTC, the start of its 5 minutes."),
            session: values(["pre", "post"]),
            close: num,
          }),
        ),
        "With `extended=true`: the pre- and post-market closes of the sessions answered, read while the regular session is closed, never stored.",
      ),
    },
    [
      "input",
      "instrument",
      "stale",
      "from",
      "to",
      "session",
      "interval",
      "sessions",
      "previous_close",
      "points",
    ],
  ),
  BarsAnswer: oneOf("Bars", "Intraday"),
  Symbols: object(
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
            isin: note(nstr, "A regional listing's ISIN."),
            stored: note(bool, "Already stored on this server."),
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
  // a result holds the blocks its sections asked, at least one
  ResearchCompany: object({ input: str, id: str, company }),
  ResearchNews: object({ input: str, id: str, news }),
  ResearchBoth: object({ input: str, id: str, company, news }),
  ResearchItem: oneOf(
    "ResearchCompany",
    "ResearchNews",
    "ResearchBoth",
    "ItemError",
  ),
  Research: object({ research: list(ref("ResearchItem")) }),
  Earnings: object(
    {
      from: str,
      to: str,
      source: str,
      message: str,
      unavailable: list(
        object({ input: str, message: str }, ["input", "message"], true),
      ),
      no_event: list(
        object(
          {
            input: str,
            id: str,
            last: nullable(freeForm),
            next: nullable(freeForm),
          },
          ["input", "id"],
        ),
      ),
      earnings: list(
        object({ id: str, date: str, status: str }, ["id", "date"], true),
      ),
    },
    ["from", "to", "earnings"],
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
      average: freeForm,
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
      movers: list(ref("MoverItem")),
    },
    ["sort", "counts", "movers"],
  ),
  Screen: object(
    {
      benchmark: freeForm,
      sort: object({ field: str, order: values(["asc", "desc"]) }),
      attribution: str,
      counts: ref("Counts"),
      matches: list(ref("ScreenItem")),
    },
    ["sort", "counts", "matches"],
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
      condition: freeForm,
      note: nstr,
      paused: {
        type: ["string", "null"],
        enum: ["manual", "split", null],
        description: "`manual`, `split` (cannot be resumed) or null.",
      },
      message: str,
      armed: note(bool, "The next true result fires an alert."),
      created_at: str,
      last_result: nstr,
      last_evaluated_at: nstr,
      after_earnings: freeForm,
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
  RuleArgs: object({ symbol: str, condition: freeForm, note: nstr }, [
    "symbol",
    "condition",
  ]),
  Created: object({
    rule: ref("Rule"),
    evaluation: object(
      { result: str, values: list(freeForm), reasons: list(str) },
      ["result", "reasons"],
      true,
    ),
    alert: nullable(alert),
  }),
  Pause: object({ paused: bool }),
  OneRule: object({ rule: ref("Rule") }),
  Alert: alert,
  Alerts: object(
    {
      retention_gap: note(
        bool,
        "Alerts after the cursor were deleted by retention.",
      ),
      cursor_reset: note(
        bool,
        "The cursor is unknown to this server, so the feed starts over.",
      ),
      more: note(bool, "More alerts wait for the next poll."),
      alerts: list(ref("Alert")),
    },
    ["more", "alerts"],
  ),
  Status: object({
    version: str,
    sources: list(
      object({
        name: str,
        label: str,
        short: str,
        mark: str,
        state: values(["on", "off"]),
        why: str,
        backing_off: nullable(object({ until: nstr, after: str })),
        key: nullable(object({ file: str, adds: str, signup: str })),
      }),
    ),
    jobs: list(
      object({
        source: str,
        job: str,
        label: str,
        about: nstr,
        last: object({
          scope: nstr,
          started_at: nstr,
          ended_at: nstr,
          status: values(["running", "ok", "failed"]),
          rows: int,
          error: nstr,
        }),
        instruments: int,
        markets: int,
        failing_instruments: int,
        failing_markets: int,
        failing_scopes: int,
        failing: list(object({ scope: nstr, error: nstr, at: nstr })),
      }),
    ),
    instruments: int,
    tracked: int,
    database_bytes: int,
  }),
  InstrumentRow: instrumentRow,
  Instruments: object(
    {
      attribution: note(
        str,
        "A source's required notice, when the page holds one of its values.",
      ),
      total: note(int, "Every match, across all pages."),
      instruments: list(ref("InstrumentRow")),
      next_page_token: note(
        str,
        "Pass as `page_token` for the next page. Absent on the last page.",
      ),
    },
    ["total", "instruments"],
  ),
  Instrument: object(
    {
      input: note(str, "The symbol as sent."),
      attribution: note(
        str,
        "A source's required notice, when the series is one of its.",
      ),
      credit: note(
        nullable(object({ name: str, url: str })),
        "Who the prices are from, with a link to its site.",
      ),
      instrument: ref("InstrumentRow"),
      quote: note(
        nullable(
          object(
            {
              input: str,
              id: str,
              name: nstr,
              type: str,
              source: str,
              unit: brief.unit,
              currency: nstr,
              kind: brief.kind,
              price: nnum,
              observation: brief.observation,
              previous_close: nnum,
              change: nnum,
              change_percent: nnum,
              day_high: nnum,
              day_low: nnum,
              volume: nnum,
              trade_time: nstr,
              fetched_at: brief.fetched_at,
              signals: note(
                nullable(freeForm),
                "The daily and weekly signals, as the quote tool gives them.",
              ),
              returns: note(
                nullable(freeForm),
                "Returns over `1w`, `1m`, `3m` and `ytd`, to `to`: in percent, or in points for a series whose `unit` is percent (a yield); `live` when today's price counts.",
              ),
              session: note(
                nullable(freeForm),
                "The market's last regular session: `state` open or closed, `start` and `end` in UTC. Null for a series.",
              ),
              extended: note(
                nullable(
                  object({
                    session: values(["pre", "post"]),
                    price: nnum,
                    change: nnum,
                    change_percent: nnum,
                    time: nstr,
                  }),
                ),
                "Pre or post trading while the regular session is closed, as the quote tool's `extended`; null with the reason in `stale`.",
              ),
              stale: brief.stale,
            },
            [
              "input",
              "id",
              "name",
              "type",
              "source",
              "unit",
              "currency",
              "kind",
              "price",
              "previous_close",
              "change",
              "change_percent",
              "day_high",
              "day_low",
              "volume",
              "trade_time",
              "fetched_at",
              "signals",
              "returns",
              "session",
              "stale",
            ],
          ),
        ),
        "The quote as the quote tool gives it. Null when the read failed: `error` says why, and `instrument` keeps the stored price.",
      ),
      error: note(
        nullable(object({ code: values(ERRORS), detail: str })),
        "Why the read failed, else null.",
      ),
    },
    ["input", "instrument", "credit", "quote", "error"],
  ),
  Watchlist: object(
    {
      attribution: note(
        str,
        "A source's required notice, when an entry is one of its series.",
      ),
      entries: list(
        object({
          value: note(str, "The value as configured."),
          id: note(nstr, "The instrument it resolved to; null until it does."),
          state: note(
            values(["pending", "tracked", ...ERRORS]),
            "`pending` until resolved, `tracked`, or the error that stopped it.",
          ),
          instrument: note(
            nullable(instrumentRow),
            "The stored instrument, as the instrument list gives it.",
          ),
          session: note(
            session,
            "Its market's last regular session. Null for a series or until resolved.",
          ),
        }),
      ),
    },
    ["entries"],
  ),
  RefetchArgs: object(
    {
      parts: list(values(PARTS)),
      sections: list(values(REFETCH_SECTIONS)),
    },
    ["parts"],
  ),
  Refetched: object({
    input: note(str, "The symbol as sent."),
    id: str,
    parts: list(
      object(
        {
          part: values(PARTS),
          section: values(REFETCH_SECTIONS),
          status: values(["fetched", "not covered", "source off", "failed"]),
          rows: int,
          error: str,
        },
        ["part", "status"],
      ),
    ),
  }),
};
