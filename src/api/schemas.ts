// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import {
  PARTS,
  RESEARCH_SECTIONS as REFETCH_SECTIONS,
} from "../admin/refetch.ts";
import { SCREEN_NAMES, SORT_NAMES } from "../admin/screener.ts";
import { UNITS } from "../market/instruments.ts";
import { EXTENDED } from "../market/stale.ts";
import { CALL_MS } from "../operations/markets.ts";
import { FIELD_NAMES } from "../operations/screen.ts";
import { ERRORS } from "../operations/targets.ts";
import { KEY_DAYS, MAX_NAME, MIN_NAME } from "../server/access.ts";

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

const extendedReason = (description: string): Schema =>
  note(
    { type: ["string", "null"], enum: [...Object.values(EXTENDED), null] },
    description,
  );
const EXTENDED_NULL = "Why `extended` is null; null when it holds a price.";

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
    list(values(["rule", "dashboard", "read", "world_markets"])),
    "What keeps it up to date: a rule, a dashboard, a recent read or the server's built-in World markets.",
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

const quarter = object({
  period: str,
  eps_estimate: nnum,
  eps_actual: nnum,
  surprise: nnum,
  surprise_percent: nnum,
  revenue_estimate: note(
    nnum,
    "From the quarter's reported earnings event; null when the calendar holds none.",
  ),
  revenue_actual: nnum,
  revenue_surprise_percent: note(
    nnum,
    "Revenue actual against estimate, in percent.",
  ),
  fetched_at: str,
});
const earnings = object(
  {
    currency: note(
      nstr,
      "The EPS and revenue figures' currency; null when not known to be the listing's.",
    ),
    history: note(list(quarter), "The newest quarters, newest first."),
  },
  ["history"],
  true,
);
const company = note(
  object({ source: str, earnings }, ["source"], true),
  "A US share's metrics, analysts, earnings, insider sentiment and next earnings event, with the sections asked.",
);
const valuation = note(
  object(
    {
      source: str,
      error: str,
      message: str,
      fetched_at: nstr,
      stale: note(list(str), STALE),
      currency: nstr,
      pe_ttm: note(nnum, "The stored quote's price over eps_ttm."),
      forward_pe: note(nnum, "The stored quote's price over eps_forward."),
      forward_peg: nnum,
      eps_ttm: nnum,
      eps_forward: nnum,
      note: str,
    },
    [
      "source",
      "fetched_at",
      "stale",
      "currency",
      "pe_ttm",
      "forward_pe",
      "forward_peg",
      "eps_ttm",
      "eps_forward",
      "note",
    ],
  ),
  "P/E, forward P/E, PEG and EPS per US share, for a share whose metrics come from a foreign listing; with `metric` asked.",
);
const share = (name: string) => object({ [name]: str, weight_percent: num });
export const topHoldings = note(
  object(
    {
      source: note(
        str,
        "The source's name, or `owner` for a fund the owner prices, whose holdings are entered by hand.",
      ),
      error: str,
      message: note(
        str,
        "Why there are none (the source has none for the fund, none were entered, or it is not a fund), or why the fetch failed, with `error`.",
      ),
      fetched_at: nstr,
      stale: note(list(str), STALE),
      entered_at: note(nstr, "A hand entry's: when it was last entered."),
      as_of: note(
        nstr,
        "A hand entry's: the day `top` and `assets` are as of, null until entered.",
      ),
      sectors_as_of: note(
        nstr,
        "A hand entry's: the day `sectors` are as of, null until entered.",
      ),
      top: note(
        list(
          object({
            rank: int,
            symbol: note(
              nstr,
              "The holding's symbol; null when the source gives a bare exchange code.",
            ),
            id: note(nstr, "The stored instrument with this symbol, if any."),
            name: str,
            weight_percent: num,
          }),
        ),
        "The fund's ten largest holdings, largest first.",
      ),
      top_weight_percent: note(nnum, "The ten's weights summed."),
      assets: nullable(
        object({
          stock_percent: nnum,
          bond_percent: nnum,
          cash_percent: nnum,
          other_percent: nnum,
          preferred_percent: nnum,
          convertible_percent: nnum,
        }),
      ),
      sectors: note(list(share("sector")), "Largest first."),
      bond_ratings: note(list(share("rating")), "Largest first."),
      government_bonds_percent: note(
        nnum,
        "US government bonds, which overlap the ratings.",
      ),
      note: str,
    },
    ["source"],
  ),
  "A fund's ten largest holdings, asset split, sectors and bond ratings, not its full list; with `top_holdings` asked.",
);
const news = object({ source: str }, ["source"], true);
const flag = (what: string) =>
  note(
    { type: ["boolean", "null"] },
    `${what}; null when EDGAR is off or has no data for the share.`,
  );
const filings = note(
  object(
    {
      source: str,
      message: str,
      reason: note(
        str,
        "Why EDGAR has no data: `foreign filer` or `not in SEC's ticker list`.",
      ),
      fetched_at: nstr,
      stale: note(list(str), STALE),
      late_filing: flag("An NT 10-K or NT 10-Q in the last 90 days"),
      restatement: flag("An 8-K with item 4.02 in the last 365 days"),
      offering: flag(
        "New securities, shares or debt, registered or offered (an S-1, S-3, 424B1, 424B4 or 424B5) in the last 90 days; the filing's link says which",
      ),
      recent: note(
        list(
          object({
            accession: str,
            form: str,
            accepted_at: note(str, "UTC, to the second."),
            filed: str,
            period: nstr,
            items: list(object({ code: str, name: nstr })),
            url: str,
          }),
        ),
        "The newest filings, newest first.",
      ),
    },
    ["source", "late_filing", "restatement", "offering"],
    true,
  ),
  "A US share's SEC filings: the newest few and three flags.",
);

// a live row once its market closes is the day's close, final next session
const rowKind = note(
  values(["live", "close", "final"]),
  "live: with today's price while its market is open; close: to the latest close while its market is closed (a weekly row: the week so far); final once its period is over and the next one shows.",
);

const averages = nullable(
  object({
    kind: rowKind,
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
    "SMA 50 and SMA 200, `live` with today's price, `close` on the day's close while its market is closed, or `final` as of the last final bar. Null with too few bars.",
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

// a $ref takes no null beside it, so a trigger that may be null is inline
const trigger = object(
  {
    id: int,
    alert_id: int,
    symbol: str,
    when: note(str, "The alert's condition when it triggered."),
    note: nstr,
    triggered_at: str,
    values: note(
      { type: "object", additionalProperties: nnum },
      "Each side read when it triggered, keyed as `when` writes it: `price`, `price(^VIX)`.",
    ),
    after_earnings: note(
      freeForm,
      "The earnings event it waited for: symbol, fiscal year and quarter, date and when the results were seen.",
    ),
    truncated: note(
      bool,
      "Too large for a feed page, or a stored trigger this server cannot read: only the id, alert and time are kept.",
    ),
  },
  ["id", "alert_id", "triggered_at"],
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

const gap = (daily: boolean): Schema =>
  nullable(
    object(
      daily
        ? { distance_pct: nnum, crossed_today: bool }
        : { distance_pct: nnum },
    ),
  );

const nowItem = object(
  {
    field: note(str, "The left side's field, as `when` names it."),
    symbol: note(str, "Another symbol's, absent for the alert's own."),
    benchmark: note(str, "A relative return's benchmark."),
    value: note(nnum, "The left side now."),
    level: note(nnum, "The number or the right side's value now."),
    gap: note(
      nnum,
      "Level minus value, signed, in the field's unit: the move left to the level.",
    ),
    gap_percent: note(
      nnum,
      "The gap as a percent of the value; between price levels only.",
    ),
    holds: note(
      { type: ["boolean", "null"] },
      "Null while a side is missing or stale.",
    ),
  },
  ["field", "value", "level", "gap", "holds"],
);

const alertItem = object(
  {
    id: int,
    symbol: note(str, "The listing it watches, a stored id."),
    when: note(str, "Its condition in canonical form, to edit and send back."),
    note: nstr,
    after_earnings: note(
      freeForm,
      "The earnings event it waits for: symbol, fiscal year and quarter, date and status.",
    ),
    state: values([
      "watching",
      "triggered",
      "waiting_for_earnings",
      "paused",
      "split_paused",
      "unknown",
    ]),
    reasons: note(
      list(str),
      "Why it is unknown, or what it waits for; only with those states.",
    ),
    last_triggered_at: note(nstr, "Null when no kept trigger."),
    gap_percent: note(
      nnum,
      "How far from triggering, in percent: an and's farthest comparison, an or's nearest, price levels only; 0 once it holds.",
    ),
    now: list(nowItem),
  },
  [
    "id",
    "symbol",
    "when",
    "note",
    "state",
    "last_triggered_at",
    "gap_percent",
    "now",
  ],
);

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
      rules: note(
        list(int),
        "With `conflict`: the ids of the alerts reading it.",
      ),
      revision: note(
        { type: ["integer", "null"] },
        "With `conflict` on saving the profile or an analysis: its live revision, null with none.",
      ),
      trade: note(
        int,
        "With `conflict` on adding a trade: the equal trade saved in the last 10 minutes.",
      ),
      positions: note(
        list(freeForm),
        "With several dry powder positions: each one's id, name, currency and portfolio.",
      ),
      dashboard: ref("Dashboard"),
      errors: note(
        list(itemError),
        "With `unresolved`: each symbol that did not resolve.",
      ),
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
      extended_reason: extendedReason(EXTENDED_NULL),
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
        "With `extended=true`: the pre- and post-market closes of the sessions answered, read while the regular session is closed, never stored; when empty, `extended_reason` says why.",
      ),
      extended_reason: extendedReason(
        "Why `extended_points` is empty; null when it holds points.",
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
            exchange_name: note(
              str,
              "The exchange in words, as the source's search writes it.",
            ),
            currency: note(nstr, "A stored listing's currency."),
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
  ResearchCompany: object(
    {
      input: str,
      id: str,
      company,
      valuation,
      filings,
      top_holdings: topHoldings,
    },
    ["input", "id", "company"],
  ),
  ResearchNews: object(
    { input: str, id: str, news, filings, top_holdings: topHoldings },
    ["input", "id", "news"],
  ),
  ResearchBoth: object(
    {
      input: str,
      id: str,
      company,
      valuation,
      news,
      filings,
      top_holdings: topHoldings,
    },
    ["input", "id", "company", "news"],
  ),
  ResearchFilings: object(
    { input: str, id: str, filings, top_holdings: topHoldings },
    ["input", "id", "filings"],
  ),
  ResearchTopHoldings: object({
    input: str,
    id: str,
    top_holdings: topHoldings,
  }),
  ResearchItem: oneOf(
    "ResearchCompany",
    "ResearchNews",
    "ResearchBoth",
    "ResearchFilings",
    "ResearchTopHoldings",
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
        object(
          {
            id: str,
            date: str,
            status: str,
            filed_at: note(
              nstr,
              "When the 8-K with results (item 2.02) nearest the date, from a day before it to three after, was accepted, UTC; null when none or EDGAR is off.",
            ),
          },
          ["id", "date"],
          true,
        ),
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
              kind: rowKind,
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
  Listings: note(
    { type: "object", additionalProperties: ref("Listing") },
    "Every listing the answer names, by its id, so a page can name and price it without another call.",
  ),
  Listing: object({
    name: nstr,
    type: str,
    currency: nstr,
    unit: values(UNITS),
  }),
  Alert: alertItem,
  Trigger: trigger,
  AlertList: object(
    {
      alerts: list(ref("Alert")),
      instruments: ref("Listings"),
      next_page_token: note(
        str,
        "Pass as `page_token` for the next page. Absent on the last page.",
      ),
    },
    ["alerts", "instruments"],
  ),
  OneAlert: object({
    alert: ref("Alert"),
    history: list(ref("Trigger")),
    instruments: ref("Listings"),
  }),
  AlertArgs: object(
    {
      symbol: str,
      when: str,
      note: nstr,
      after_earnings: note(str, "A US share whose next results it waits for."),
    },
    ["symbol", "when"],
  ),
  AlertChange: object(
    {
      when: str,
      note: nstr,
      paused: note(bool, "Alone: pause or resume."),
    },
    [],
  ),
  AlertChanged: object({
    alert: ref("Alert"),
    triggered: nullable(trigger),
  }),
  History: object(
    {
      triggers: list(ref("Trigger")),
      instruments: ref("Listings"),
      next_page_token: note(
        str,
        "Pass as `page_token` for the next older page. Absent on the last page.",
      ),
    },
    ["triggers", "instruments"],
  ),
  Key: object({
    id: str,
    name: note(str, "Unique among its person's keys."),
    owner: note(
      object({ id: str, name: str }),
      "The person who made it, whose rows it reads and writes.",
    ),
    created_at: str,
    last_used_at: note(nstr, "Null until first used. Kept to the minute."),
    expires_at: note(nstr, "Null for a key that never expires."),
    portfolio: note(
      values(["none", "read", "write"]),
      "What the key may do with portfolios.",
    ),
    alerts: note(
      values(["none", "read", "write"]),
      "What the key may do with alerts: read opens them, their history and the feed.",
    ),
    profile: note(
      values(["none", "read", "write"]),
      "What the key may do with the owner's profile.",
    ),
    analysis: note(
      values(["none", "read", "write"]),
      "What the key may do with the analysis every person shares.",
    ),
  }),
  OneKey: object({ key: ref("Key") }),
  KeyAccess: object(
    {
      portfolio: note(
        values(["none", "read", "write"]),
        "What the key may do with portfolios.",
      ),
      alerts: note(
        values(["none", "read", "write"]),
        "What the key may do with alerts.",
      ),
      profile: note(
        values(["none", "read", "write"]),
        "What the key may do with the owner's profile.",
      ),
      analysis: note(
        values(["none", "read", "write"]),
        "What the key may do with the analysis every person shares. At least one of the four.",
      ),
    },
    [],
  ),
  Keys: object({
    keys: list(ref("Key")),
    limit: note(int, "How many keys there may be, expired ones included."),
  }),
  KeyArgs: object(
    {
      portfolio: note(
        values(["none", "read", "write"]),
        "What the key may do with portfolios; none by default.",
      ),
      alerts: note(
        values(["none", "read", "write"]),
        "What the key may do with alerts: read opens them, their history and the feed; none by default.",
      ),
      profile: note(
        values(["none", "read", "write"]),
        "What the key may do with the owner's profile; none by default.",
      ),
      analysis: note(
        values(["none", "read", "write"]),
        "What the key may do with the analysis every person shares; none by default.",
      ),
      name: note(
        str,
        `${MIN_NAME} to ${MAX_NAME} lowercase letters, digits, dashes and underscores, starting with a letter or digit.`,
      ),
      expiresInDays: note(
        { type: ["integer", "null"], enum: [...KEY_DAYS, null] },
        "Days until the key expires, or null for never, the default.",
      ),
    },
    ["name"],
  ),
  MadeKey: object({
    key: ref("Key"),
    token: note(str, "The key to send as a bearer. It is never shown again."),
  }),
  Seen: object({
    seen: note(int, "The newest trigger id marked seen; 0 before any."),
    unseen: note(int, "How many of your triggers are newer than `seen`."),
  }),
  SeenArgs: object({
    id: note(int, "A trigger id, usually the newest shown."),
  }),
  Feed: object(
    {
      retention_gap: note(
        bool,
        "Triggers after the cursor were deleted by retention.",
      ),
      cursor_reset: note(
        bool,
        "The cursor is unknown to this server, so the feed starts over.",
      ),
      more: note(bool, "More triggers wait for the next poll."),
      triggers: list(ref("Trigger")),
    },
    ["more", "triggers"],
  ),
  Status: object({
    version: str,
    sync: bool,
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
        failing: list(
          object({ scope: nstr, error: nstr, at: nstr, next_at: nstr }),
        ),
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
  Screener: object(
    {
      attribution: note(
        str,
        "A source's required notice, when the page holds one of its values.",
      ),
      screen: values(SCREEN_NAMES),
      type: note(list(str), "The kinds asked; empty for every kind."),
      sort: object({
        field: values(SORT_NAMES),
        order: values(["asc", "desc"]),
      }),
      counts: note(
        object(Object.fromEntries(SCREEN_NAMES.map((s) => [s, int])), [
          ...SCREEN_NAMES,
        ]),
        "Each screen's matches for the kinds asked, across all pages.",
      ),
      kinds: note(
        list(object({ kind: str, count: int })),
        "Every stored kind kept up to date, with its instruments.",
      ),
      instruments: list(
        object({
          ...instrumentRow.properties!,
          return_1m: note(
            nnum,
            "The quote's 1-month return, stored with its latest signals.",
          ),
          return_1y: note(nnum, "The quote's 1-year return, the same way."),
          drawdown: note(nnum, "Percent below the 52-week high."),
          rsi14: nnum,
          distance_sma200: note(
            nnum,
            "Percent from the 200-day average to the price.",
          ),
          cross: note(
            { type: ["integer", "null"], enum: [-1, 0, 1, null] },
            "1 with the 50-day average over the 200-day, -1 under it.",
          ),
          trend: {
            type: ["string", "null"],
            enum: ["up", "down", "mixed", null],
          },
        }),
      ),
      next_page_token: note(
        str,
        "Pass as `page_token` for the next page. Absent on the last page.",
      ),
    },
    ["screen", "type", "sort", "counts", "kinds", "instruments"],
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
      intraday: note(
        bool,
        "Whether its source gives 5-minute closes (`/instruments/{symbol}/bars?interval=5m`).",
      ),
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
              kind: note(
                values(["market_quote", "observation", "hand_price"]),
                "`hand_price` for a fund the owner prices: its latest entered price, with no day change, session or returns.",
              ),
              price: nnum,
              as_of: note(str, "A hand price's day."),
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
                "Returns over `1w`, `1m`, `3m`, `ytd` and `1y`, to `to`: in percent, or in points for a series whose `unit` is percent (a yield); `live` when today's price counts.",
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
                "Pre or post trading while the regular session is closed, as the quote tool's `extended`; null with the reason in `extended_reason`.",
              ),
              extended_reason: extendedReason(EXTENDED_NULL),
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
      top_holdings: note(
        topHoldings,
        "For an ETF or mutual fund, as the research route's `top_holdings`; for a fund the owner prices, its holdings once entered.",
      ),
    },
    ["input", "instrument", "intraday", "credit", "quote", "error"],
  ),
  Dashboard: object(
    {
      attribution: note(
        str,
        "A source's required notice, when an item is one of its series.",
      ),
      revision: note(int, "Send it back with the next save. 0 until saved."),
      created: note(bool, "False until the first save."),
      track: note(
        list(
          object({
            value: str,
            state: values(["ready", "pending"]),
          }),
        ),
        "Until the first save: each World markets symbol the sections are seeded with, in their order, and whether the sections hold it (`ready`) or it is still resolving (`pending`).",
      ),
      sections: list(
        object({
          name: str,
          view: values(["cards", "table"]),
          items: list(
            object(
              {
                id: str,
                instrument: note(
                  instrumentRow,
                  "The stored instrument, as the instrument list gives it.",
                ),
                session: note(
                  session,
                  "Its market's last regular session. Null for a series.",
                ),
                intraday: note(
                  bool,
                  "Whether its source gives 5-minute closes (`/instruments/{symbol}/bars?interval=5m`).",
                ),
                averages: note(
                  object({
                    daily_sma50: gap(true),
                    daily_sma200: gap(true),
                    weekly_sma200: gap(false),
                  }),
                  "The price's distance from each average, in percent; null without a price or an average.",
                ),
                futures: note(
                  object(
                    {
                      label: note(
                        str,
                        "What the futures are called, as `S&P Futures`.",
                      ),
                      instrument: note(
                        instrumentRow,
                        "The futures' stored instrument, as the instrument list gives it.",
                      ),
                      session: note(
                        session,
                        "Its market's last regular session; `state` is `open` while its last trade is at most 30 minutes old.",
                      ),
                      intraday: note(
                        bool,
                        "Whether its source gives 5-minute closes.",
                      ),
                    },
                    ["label", "instrument", "session", "intraday"],
                  ),
                  "A World markets index's futures, present only while the index's market is closed and the futures traded after its close.",
                ),
              },
              ["id", "instrument", "session", "intraday", "averages"],
            ),
          ),
        }),
      ),
    },
    ["revision", "created", "sections"],
  ),
  DashboardArgs: object({
    revision: int,
    sections: list(
      object({
        name: str,
        view: values(["cards", "table"]),
        symbols: list(str),
      }),
    ),
  }),
  RefetchArgs: object(
    {
      parts: list(values(PARTS)),
      sections: list(values(REFETCH_SECTIONS)),
    },
    ["parts"],
  ),
  Stored: object({
    input: note(str, "The symbol as sent."),
    stored: bool,
  }),
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
  Retried: object({
    asked: note(int, "Failing jobs asked again."),
    fetched: note(int, "Of those, the ones that succeeded."),
    failed: note(int, "Of those, the ones that failed again."),
    left_out: note(int, "Failing jobs not asked again."),
  }),
};
