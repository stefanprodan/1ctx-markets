// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// The portfolio routes' part of the spec, for people reading the docs page.

import {
  MAX_CSV_BYTES,
  MAX_IMPORT_BODY,
} from "../operations/portfolio-import.ts";
import { MAX_NAME, MAX_NOTE } from "../portfolios/store.ts";
import { PROBLEM_TYPE } from "./http.ts";
import {
  bool,
  freeForm,
  int,
  list,
  num,
  object,
  ref,
  type Schema,
  str,
  values,
} from "./schemas.ts";

const nstr: Schema = { type: ["string", "null"] };
const nnum: Schema = { type: ["number", "null"] };
const note = (s: Schema, description: string): Schema => ({
  ...s,
  description,
});

const share = object({ key: nstr, value: num, weight: num });

const total = {
  currency: str,
  value: nnum,
  cost: nnum,
  pl: nnum,
  pl_percent: nnum,
  day_change: nnum,
  invested: nnum,
  cash: nnum,
  dry_powder: note(nnum, "Cash kept for buying."),
  invested_weight: nnum,
  cash_weight: nnum,
  dry_powder_weight: nnum,
  missing: note(
    list(str),
    "What has no value or rate and is left out of the sum, by id or name, or the missing rate.",
  ),
};

const part = object(
  {
    portfolio: str,
    broker: nstr,
    quantity: nnum,
    average_cost: nnum,
    cost: nnum,
    value: nnum,
    position: note(
      { type: "integer" },
      "A position's own id: each purchase of a merged bond is edited or removed by it.",
    ),
    as_of: str,
    amount: note(
      nnum,
      "Cash's balance or a bond purchase's face, as stored, unrounded.",
    ),
  },
  ["portfolio", "broker", "quantity", "average_cost", "cost", "value"],
);

const converted = object({
  currency: str,
  rate: nnum,
  rate_at: nstr,
  value: nnum,
  cost: nnum,
  pl: nnum,
  pl_percent: nnum,
  weight: note(nnum, "Its share of the converted total, in percent."),
});

const trade = object(
  {
    id: int,
    portfolio: nstr,
    portfolio_id: int,
    symbol: str,
    name: nstr,
    side: values(["buy", "sell"]),
    date: str,
    quantity: num,
    price: num,
    fees: num,
    currency: note(str, "What it was paid in."),
    listing_currency: nstr,
    unit: note(
      nstr,
      "The listing's unit; `percent_of_par`: the price is a percent of face.",
    ),
    stated_on: note(
      str,
      "The day its quantity and price are stated as of: its date when typed in; read from an export, the day its `[as of]` tag names, else the import's day.",
    ),
    split_adjusted: object({ quantity: nnum, price: nnum }),
    broker: nstr,
    note: nstr,
    entered_by: note(str, "`web`, `admin` or the agent key's name."),
    entered_at: nstr,
    removed_at: nstr,
    removed_by: nstr,
  },
  [
    "id",
    "portfolio",
    "portfolio_id",
    "symbol",
    "name",
    "side",
    "date",
    "quantity",
    "price",
    "fees",
    "currency",
    "listing_currency",
    "unit",
    "stated_on",
    "broker",
    "note",
    "entered_by",
    "entered_at",
    "removed_at",
    "removed_by",
  ],
);

const MARKET_NOTE =
  "The market its money is in, as instruments name it (`markets` in the list), so the exposure counts it there; none unless named.";

const position = object(
  {
    id: int,
    kind: values(["cash", "bond"]),
    portfolio: nstr,
    portfolio_id: int,
    name: str,
    symbol: nstr,
    market: note(nstr, `Cash's market. ${MARKET_NOTE}`),
    currency: str,
    amount: note(nnum, "Cash's amount, or a bond's face."),
    cost: nnum,
    coupon: nnum,
    maturity: nstr,
    as_of: note(
      str,
      "Cash's amount is as of this day; a bond's is the day it was bought, its listed price dated by `fetched_at`.",
    ),
    dry_powder: bool,
    broker: nstr,
    note: nstr,
    replaces: note({ type: ["integer", "null"] }, "The row this one updated."),
    entered_by: str,
    entered_at: nstr,
    removed_at: nstr,
    removed_by: nstr,
  },
  [
    "id",
    "kind",
    "portfolio",
    "portfolio_id",
    "name",
    "symbol",
    "market",
    "currency",
    "amount",
    "cost",
    "coupon",
    "maturity",
    "as_of",
    "broker",
    "note",
    "replaces",
    "entered_by",
    "entered_at",
    "removed_at",
    "removed_by",
  ],
);

const portfolio = object({
  id: int,
  name: str,
  trades: int,
  positions: int,
  created_at: nstr,
});

const broker = object({ id: int, name: str });

const fund = object({
  id: note(str, "`fund:<isin>`, as holdings and trades name it."),
  isin: str,
  name: str,
  currency: str,
  market: note(nstr, MARKET_NOTE),
  price: note(nnum, "Its latest price per unit, null before the first."),
  as_of: note(nstr, "The day its latest price is for."),
});

const fundPrice = object({
  date: note(str, "The day the price is for."),
  price: num,
  entered_by: str,
  entered_at: nstr,
});

const named = object({ name: note(str, `1 to ${MAX_NAME} characters.`) });

const holding = object(
  {
    kind: note(
      values(["holding", "cash", "fund", "bond"]),
      "`fund`: a fund the owner prices, held through its trades.",
    ),
    id: nstr,
    position: { type: ["integer", "null"] },
    name: nstr,
    type: str,
    market: note(
      nstr,
      "The listing's market; a fund's or cash's, the one its money is in.",
    ),
    isin: note(str, "A fund's."),
    currency: str,
    unit: note(
      nstr,
      "The listing's unit; `percent_of_par`: price and average cost are a percent of face.",
    ),
    quantity: nnum,
    average_cost: nnum,
    cost: nnum,
    price: nnum,
    priced: note(
      values(["quote", "hand", "listing", "face", "amount"]),
      "`hand`: a fund's latest price, entered by the owner or taken from a buy.",
    ),
    as_of: note(
      nstr,
      "The day a fund's price is for, or cash's amount is true on; a bond's is the day it was bought, its listed price dated by `fetched_at`.",
    ),
    value: nnum,
    pl: nnum,
    pl_percent: nnum,
    day_change: nnum,
    change_percent: nnum,
    currency_weight: note(
      nnum,
      "Its share of the value in its own currency, in percent; `converted.weight` is its share of the converted total.",
    ),
    paid: list(object({ currency: str, amount: nnum })),
    converted,
    coupon: nnum,
    maturity: nstr,
    dry_powder: bool,
    sold_today: note(
      bool,
      "All of it sold on the quote's day: kept at nothing until then, so the day's change counts the sale.",
    ),
    note: nstr,
    trade_time: nstr,
    fetched_at: nstr,
    stale: list(str),
    parts: list(part),
  },
  [
    "kind",
    "id",
    "currency",
    "unit",
    "quantity",
    "cost",
    "price",
    "priced",
    "value",
    "pl",
    "currency_weight",
    "stale",
    "parts",
  ],
);

export const portfolioSchemas: Record<string, Schema> = {
  Portfolio: portfolio,
  OnePortfolio: object({ portfolio }),
  Portfolios: object({
    display_currency: nstr,
    time_zone: note(nstr, "The owner's IANA time zone, null until set."),
    portfolios: list(portfolio),
    brokers: list(broker),
    markets: note(
      list(str),
      "The markets stored instruments are in: what cash or a fund can name.",
    ),
    funds: note(list(fund), "The funds the owner prices."),
  }),
  Fund: fund,
  Funds: object({ funds: list(fund) }),
  FundDetail: object({
    fund,
    prices: note(list(fundPrice), "Every price it was given, newest first."),
    trades: note(list(trade), "Its live trades, newest first."),
  }),
  FundTradeArgs: object(
    {
      portfolio: note(
        { type: ["string", "integer"] },
        "A name or an id; may be left out while there is one portfolio.",
      ),
      isin: note(
        str,
        "The fund's ISIN, its check digit checked; its first buy makes it.",
      ),
      name: note(
        str,
        "The fund's name: needed on its first buy, and enough alone after it.",
      ),
      side: values(["buy", "sell"]),
      units: note({ type: ["number", "string"] }, "Units, or `all` on a sell."),
      price: note(
        num,
        "Per unit; it or `total` is needed, a fund has no live price.",
      ),
      total: note(num, "What left or reached the account, fees in it."),
      fees: num,
      date: note(str, "The trade date, the owner's today by default."),
      currency: note(
        str,
        "What it was paid in; needed on the first buy, which makes it the fund's.",
      ),
      broker: note(str, "A broker's name, as the list has it."),
      market: note(str, MARKET_NOTE),
      note: note(str, `At most ${MAX_NOTE} characters.`),
      again: note(
        bool,
        "True saves a second fill equal to one saved in the last 10 minutes.",
      ),
    },
    ["side", "units"],
  ),
  AddedFundTrade: object(
    {
      trade,
      trades: list(trade),
      total: object({
        amount: num,
        currency: str,
        includes_fees: bool,
      }),
      fund,
    },
    ["fund"],
  ),
  FundChange: object(
    {
      price: note(num, "Per unit, in the fund's currency."),
      date: note(
        str,
        "The day the price is for, the owner's today by default; a price for a day already priced replaces it.",
      ),
      market: note(nstr, `${MARKET_NOTE} Null takes it off.`),
    },
    [],
  ),
  UpdatedFund: object(
    {
      fund,
      price: object({ date: str, price: num }),
      replaced: note(
        { ...fundPrice, type: ["object", "null"] },
        "The price that day had before, null when none.",
      ),
    },
    ["fund"],
  ),
  Named: named,
  Broker: broker,
  OneBroker: object({ broker }),
  Brokers: object({ brokers: list(broker) }),
  Trade: trade,
  Trades: object({ trades: list(trade) }),
  TradeArgs: object(
    {
      portfolio: note(
        { type: ["string", "integer"] },
        "A name or an id; may be left out while there is one portfolio.",
      ),
      symbol: str,
      side: values(["buy", "sell"]),
      quantity: note(
        { type: ["number", "string"] },
        "Shares, or `all` on a sell: what is held, one sell per broker unless `broker` is given.",
      ),
      price: note(
        num,
        "Per share; the live price when neither it nor `total` is given.",
      ),
      total: note(num, "What left or reached the account, fees in it."),
      fees: num,
      date: note(str, "The trade date, today by default."),
      currency: note(str, "What it was paid in; the listing's by default."),
      broker: note(str, "A broker's name, as the list has it."),
      note: note(str, `At most ${MAX_NOTE} characters.`),
      again: note(
        bool,
        "True saves a second fill equal to one saved in the last 10 minutes; without it that add is refused as a retry.",
      ),
    },
    ["symbol", "side", "quantity"],
  ),
  AddedTrade: object(
    {
      trade,
      trades: list(trade),
      live_price: object({ price: num, at: nstr, rate: nnum }),
      total: object({
        amount: num,
        currency: str,
        includes_fees: bool,
      }),
    },
    [],
  ),
  OneTrade: object({ trade }),
  Position: position,
  OnePosition: object({ position }),
  Positions: object({ positions: list(position) }),
  PositionHistory: object({ history: list(position) }),
  PositionArgs: object(
    {
      kind: values(["cash", "bond"]),
      portfolio: { type: ["string", "integer"] },
      name: str,
      symbol: note(str, "A bond's listing."),
      currency: str,
      amount: note(num, "Cash's amount, or a bond's face."),
      cost: num,
      coupon: num,
      maturity: str,
      date: note(str, "As of; today by default."),
      dry_powder: note(bool, "Cash kept for buying."),
      market: note(str, `Cash's market. ${MARKET_NOTE}`),
      broker: str,
      note: str,
    },
    ["kind", "name"],
  ),
  AddedPosition: object({ position, replaced: { type: ["integer", "null"] } }),
  PositionChange: object(
    {
      amount: note(num, "A new amount, in `currency` or the position's own."),
      by: note(
        num,
        "Cash moved by this much, in `currency` or the position's own.",
      ),
      currency: str,
      cost: { type: ["number", "null"] },
      date: str,
      note: nstr,
      dry_powder: bool,
      market: note(nstr, "Cash's market; null takes it off."),
    },
    [],
  ),
  UpdatedPosition: object(
    {
      position,
      replaced: int,
      rate: object({ from: str, to: str, rate: num, at: nstr }),
    },
    ["position", "replaced"],
  ),
  Holdings: object({
    portfolio: nstr,
    broker: nstr,
    display_currency: nstr,
    currency: note(nstr, "The named currency, else the display currency."),
    totals: list(object(total)),
    converted: { ...object(total), type: ["object", "null"] },
    rates: note(
      list(
        object(
          {
            from: str,
            to: str,
            rate: nnum,
            pair: nstr,
            at: nstr,
            stale: list(str),
            reason: str,
          },
          ["from", "to", "rate", "pair", "at", "stale"],
        ),
      ),
      "The live rates the named currency was read at.",
    ),
    cost_rates: note(
      list(
        object(
          {
            from: str,
            to: str,
            pair: nstr,
            count: note(int, "How many days' closes."),
            first: str,
            last: str,
            reason: note(str, "Why these days had no close."),
          },
          ["from", "to", "pair", "count", "first", "last"],
        ),
      ),
      "The daily closes costs were converted at, one entry per pair, and one per pair with none.",
    ),
    exposure: list(
      object({
        currency: str,
        currency_weights: { type: ["array", "null"], items: share },
        market: list(share),
        type: list(share),
        portfolio: list(share),
        broker: list(share),
      }),
    ),
    holdings: list(holding),
  }),
  ImportArgs: object(
    {
      csv: note(str, `The file's text, at most ${MAX_CSV_BYTES / 1024} KiB.`),
      broker: note(str, "A broker for every trade in the file."),
      currency: note(str, "A cash file's currency when its header names none."),
      confirm: note(
        bool,
        "Save the good rows; false or left out only previews.",
      ),
      dry_powder: note(list(int), "The cash file's lines kept for buying."),
    },
    ["csv"],
  ),
  Import: object({
    kind: values(["trades", "cash", "bonds"]),
    portfolio: str,
    broker: nstr,
    saved: bool,
    counts: object({ ok: int, bad: int, skipped: int, saved: int }),
    rows: list(
      object(
        {
          line: int,
          status: values(["ok", "bad", "skipped", "saved"]),
          reason: str,
          warning: str,
          replaces: int,
          item: freeForm,
        },
        ["line", "status"],
      ),
    ),
  }),
  Settings: object({
    display_currency: note(
      nstr,
      "An ISO 4217 code in circulation. Null only while none is set; a save left without it keeps it, and a portfolio needs one set.",
    ),
    time_zone: note(
      nstr,
      "The owner's IANA time zone, such as America/New_York: a position with no date is dated today there. Null until set, the UTC day meanwhile; a save left without it keeps it.",
    ),
  }),
};

// a key with portfolio access, the admin key or the web UI's cookie
const READS = [{ portfolioRead: [] }, { admin: [] }, { session: [] }];
const WRITES = [{ portfolioWrite: [] }, { admin: [] }, { session: [] }];

const r = (name: string) => ({ $ref: `#/components/responses/${name}` });
const content = (schema: Schema) => ({ "application/json": { schema } });
const ok = (description: string, schema: Schema) => ({
  description,
  content: content(schema),
});
const err = (description: string) => ({
  description,
  content: { [PROBLEM_TYPE]: { schema: ref("Problem") } },
});
const bodyOf = (schema: Schema) => ({
  required: true,
  content: content(schema),
});
const lines = (...parts: string[]) => parts.join("\n");

const forbidden = err(
  "A key without portfolio access, or one that reads only on a write (`forbidden`).",
);
const missing = err(
  "No such portfolio, trade, position, broker or fund (`not_found`).",
);
const conflict = err("A name is taken, or the row is in use (`conflict`).");

const base = (extra: object = {}) => ({
  400: r("BadArguments"),
  401: r("Unauthorized"),
  403: forbidden,
  429: r("TooMany"),
  500: r("Internal"),
  ...extra,
});

const json415 = { 415: r("UnsupportedType") };

const idParam = (what: string) => ({
  name: "id",
  in: "path" as const,
  description: `The ${what}'s id.`,
  required: true,
  schema: int,
});

const q = (name: string, description: string, schema: Schema = str) => ({
  name,
  in: "query" as const,
  description,
  required: false,
  schema,
});

const CURRENCY = q(
  "currency",
  "Also convert into this currency at live rates; the owner's display currency when left out.",
);
const BROKER = q("broker", "Only this broker's parts.");

const HOLDINGS = lines(
  "One row per instrument with its parts per broker, a fund the owner prices among them (`kind` `fund`, valued at its latest price), then cash and bonds.",
  "",
  "- Values and profit or loss are in each instrument's own currency. Totals are per currency and never summed across currencies.",
  "- A named currency, or the display currency, adds `converted` on each row and in total, with every rate used and its time in `rates`. A pair with no price is null with its reason.",
  "- Weights are within one currency, or within the named one.",
  "- A trade before a split is counted in today's shares.",
  "- Money (values, costs, profit or loss, the day's change, totals) is rounded to its currency's minor units, 2 decimals for most, 0 for JPY, 3 for KWD and 8 for a code ISO 4217 lacks; prices, quantities and rates keep their digits.",
);

const tags = ["portfolios"];

export const portfolioPaths = {
  "/portfolios": {
    get: {
      tags,
      operationId: "listPortfolios",
      security: READS,
      summary: "Portfolios and brokers",
      description:
        "Every portfolio with its counts, the brokers and the display currency.",
      responses: base({ 200: ok("The portfolios.", ref("Portfolios")) }),
    },
    post: {
      tags,
      operationId: "createPortfolio",
      security: WRITES,
      summary: "Make a portfolio",
      description:
        "A portfolio is a name. It has no currency. Refused (409) until a display currency is set.",
      requestBody: bodyOf(ref("Named")),
      responses: base({
        201: {
          ...ok("The portfolio.", ref("OnePortfolio")),
          headers: { Location: { schema: str } },
        },
        409: conflict,
        ...json415,
      }),
    },
  },
  "/portfolios/{id}": {
    parameters: [idParam("portfolio")],
    get: {
      tags,
      operationId: "getPortfolio",
      security: READS,
      summary: "One portfolio",
      description: "The portfolio with its counts.",
      responses: base({
        200: ok("The portfolio.", ref("OnePortfolio")),
        404: missing,
      }),
    },
    patch: {
      tags,
      operationId: "renamePortfolio",
      security: WRITES,
      summary: "Rename a portfolio",
      description: "Renames it; its trades stay.",
      requestBody: bodyOf(ref("Named")),
      responses: base({
        200: ok("The portfolio.", ref("OnePortfolio")),
        404: missing,
        409: conflict,
        ...json415,
      }),
    },
    delete: {
      tags,
      operationId: "deletePortfolio",
      security: WRITES,
      summary: "Delete an empty portfolio",
      description:
        "Refused while it holds a trade or position that is not removed; removed ones are deleted with it.",
      responses: base({
        204: { description: "Deleted." },
        404: missing,
        409: conflict,
      }),
    },
  },
  "/portfolios/{id}/holdings": {
    parameters: [idParam("portfolio")],
    get: {
      tags,
      operationId: "portfolioHoldings",
      security: READS,
      summary: "A portfolio's holdings",
      description: HOLDINGS,
      parameters: [BROKER, CURRENCY],
      responses: base({
        200: ok("The holdings.", ref("Holdings")),
        404: missing,
      }),
    },
  },
  "/holdings": {
    get: {
      tags,
      operationId: "holdings",
      security: READS,
      summary: "Holdings across portfolios",
      description: HOLDINGS,
      parameters: [BROKER, CURRENCY],
      responses: base({
        200: ok("The holdings.", ref("Holdings")),
        404: missing,
      }),
    },
  },
  "/portfolios/{id}/export": {
    parameters: [idParam("portfolio")],
    get: {
      tags,
      operationId: "exportPortfolio",
      security: READS,
      summary: "Export trades as CSV",
      description:
        "The portfolio's trades as a portfolio CSV export (`Symbol`, `Trade Date`, `Purchase Price`, `Quantity`, `Commission`, `Comment`, `Transaction Type` and the market columns, left empty), oldest first, price and quantity in today's shares, with LF line ends and no BOM. A trade paid in another currency has `Purchase Price` in the listing's currency at the close its cost converts at, and `[paid <currency> <price paid>]` in `Comment`, which an import reads back as paid; with no close it is written as paid, tagged `[paid <currency>]`. `Comment` starts with `[broker <name>]`, the paid tag and `[as of <day>]`, the day the figures are stated as of, then the note.",
      responses: base({
        200: {
          description: "The CSV.",
          content: { "text/csv": { schema: str } },
        },
        404: missing,
      }),
    },
  },
  "/portfolios/{id}/import": {
    parameters: [idParam("portfolio")],
    post: {
      tags,
      operationId: "importPortfolio",
      security: WRITES,
      summary: "Import a CSV",
      description: lines(
        "Reads a portfolio CSV export of trades, or a cash or bonds list, and answers every row as `ok`, `bad` with why, or `skipped`. Nothing is saved unless `confirm` is true; then the good rows are saved.",
        "",
        "- Trades: `Symbol`, `Trade Date`, `Purchase Price`, `Quantity`, `Commission`, `Comment`, `Transaction Type`. A trade already saved is skipped. A fund's key (`fund:<isin>`, as an export writes it) names a fund kept; a fund is made by its first buy, never by a file.",
        "- Cash: `Item`, `Amount (<currency>)`, `As Of`, `Note`. Bonds: `Item`, `Symbol`, `Currency`, `Amount`, `Rate (%)`, `Purchase Date`, `Maturity`, `Note`. A list of fund totals is refused: a fund's buys are added one by one.",
        "- Cash replaces the kept one with its name and broker. A bond with the listing (or name), purchase date, face and broker of a kept one is skipped; with no purchase date, any date matches.",
        "- A date after today is bad; a month (`YYYY-MM`) is its last day, or today in the current month.",
      ),
      requestBody: bodyOf(ref("ImportArgs")),
      responses: base({
        200: ok("The rows, saved or previewed.", ref("Import")),
        404: missing,
        413: err(
          `A body over ${MAX_IMPORT_BODY / 1024} KiB, room for a ${MAX_CSV_BYTES / 1024} KiB file with its JSON escaping.`,
        ),
        ...json415,
      }),
    },
  },
  "/trades": {
    get: {
      tags,
      operationId: "listTrades",
      security: READS,
      summary: "Trades",
      description: "Trades newest first, with who entered each and when.",
      parameters: [
        q("portfolio", "A portfolio's name or id."),
        BROKER,
        q("symbol", "An instrument's id or symbol."),
        q("from", "From this trade date."),
        q("to", "To this trade date."),
        q("removed", "Include removed trades.", bool),
      ],
      responses: base({
        200: ok("The trades.", ref("Trades")),
        404: missing,
      }),
    },
    post: {
      tags,
      operationId: "addTrade",
      security: WRITES,
      summary: "Add a trade",
      description: lines(
        "Saves a buy or sell and answers it resolved to its instrument.",
        "",
        "- An unknown symbol is fetched within the call.",
        "- A sell of more than its broker holds is refused.",
        "- A broker is one the list has; an unknown one is refused with the list.",
        "- A retry with the same figures (instrument, side, date, quantity, price, fees, currency paid, broker) as a live trade entered in the last 10 minutes is refused (409) with that trade's id in `trade`, unless `again` is true. One with no price or total takes the live quote, so after the quote moves it is another trade.",
      ),
      requestBody: bodyOf(ref("TradeArgs")),
      responses: base({
        201: {
          ...ok(
            "The trade, or one per broker for a sell of all.",
            ref("AddedTrade"),
          ),
          headers: { Location: { schema: str } },
        },
        404: missing,
        409: conflict,
        ...json415,
        503: r("Unavailable"),
      }),
    },
  },
  "/trades/{id}": {
    parameters: [idParam("trade")],
    delete: {
      tags,
      operationId: "removeTrade",
      security: WRITES,
      summary: "Remove a trade",
      description:
        "Marks it removed, with who and when. It can be restored. Refused when a later sale at its broker would then sell more than it holds, naming that sale's id and date to remove first.",
      responses: base({
        200: ok("The trade.", ref("OneTrade")),
        404: missing,
        409: conflict,
      }),
    },
  },
  "/trades/{id}/restore": {
    parameters: [idParam("trade")],
    post: {
      tags,
      operationId: "restoreTrade",
      security: WRITES,
      summary: "Restore a trade",
      description:
        "Brings back a removed trade. Refused when it would sell more than its broker holds at any date.",
      responses: base({
        200: ok("The trade.", ref("OneTrade")),
        404: missing,
        409: conflict,
      }),
    },
  },
  "/positions": {
    get: {
      tags,
      operationId: "listPositions",
      security: READS,
      summary: "Positions",
      description: "Cash and bonds.",
      parameters: [
        q("portfolio", "A portfolio's name or id."),
        BROKER,
        q("removed", "Include removed and replaced rows.", bool),
      ],
      responses: base({
        200: ok("The positions.", ref("Positions")),
        404: missing,
      }),
    },
    post: {
      tags,
      operationId: "addPosition",
      security: WRITES,
      summary: "Add a position",
      description:
        "Saves cash or a bond; a fund is bought as a trade (`POST /funds/trades`). Cash with the same name and broker replaces the kept one, a bond the one with its listing (or name), purchase date, face and broker; the old row is kept as replaced. A date after today is refused.",
      requestBody: bodyOf(ref("PositionArgs")),
      responses: base({
        201: {
          ...ok("The position.", ref("AddedPosition")),
          headers: { Location: { schema: str } },
        },
        404: missing,
        ...json415,
        503: r("Unavailable"),
      }),
    },
  },
  "/positions/{id}": {
    parameters: [idParam("position")],
    patch: {
      tags,
      operationId: "updatePosition",
      security: WRITES,
      summary: "Update a position",
      description: lines(
        "Changes an amount, a cost, the date, the note or the market. The old row is kept as replaced, so a change can be set back by restoring it.",
        "",
        "- `by` moves a cash balance. An amount in another currency converts at the live rate, answered in `rate`.",
      ),
      requestBody: bodyOf(ref("PositionChange")),
      responses: base({
        200: ok("The new row.", ref("UpdatedPosition")),
        404: missing,
        409: conflict,
        ...json415,
      }),
    },
    delete: {
      tags,
      operationId: "removePosition",
      security: WRITES,
      summary: "Remove a position",
      description: "Marks it removed, with who and when. It can be restored.",
      responses: base({
        200: ok("The position.", ref("OnePosition")),
        404: missing,
      }),
    },
  },
  "/positions/{id}/restore": {
    parameters: [idParam("position")],
    post: {
      tags,
      operationId: "restorePosition",
      security: WRITES,
      summary: "Restore a position",
      description:
        "Brings back a removed or replaced row, replacing the one after it.",
      responses: base({
        200: ok("The position.", ref("OnePosition")),
        404: missing,
      }),
    },
  },
  "/positions/{id}/history": {
    parameters: [idParam("position")],
    get: {
      tags,
      operationId: "positionHistory",
      security: READS,
      summary: "A position's changes",
      description:
        "Every row of the position, newest first, with who made each and when.",
      responses: base({
        200: ok("The rows.", ref("PositionHistory")),
        404: missing,
      }),
    },
  },
  "/funds": {
    get: {
      tags,
      operationId: "listFunds",
      security: READS,
      summary: "Funds",
      description:
        "The funds the owner prices, each with its latest price and the day it is for.",
      responses: base({ 200: ok("The funds.", ref("Funds")) }),
    },
  },
  "/funds/trades": {
    post: {
      tags,
      operationId: "addFundTrade",
      security: WRITES,
      summary: "Buy or sell a fund",
      description: lines(
        "Saves a buy or sell of a fund the owner prices, one per confirmation, as a trade on the fund: average cost, parts per broker, removal and restore and the trades list work as a share's.",
        "",
        "- Its first buy makes the fund, with its `isin` (its check digit checked), `name` and `currency`; a later trade names it by `isin` or `name`.",
        "- A buy in the fund's currency also becomes that day's price when none is entered for it, so a fund added from one confirmation is valued at once.",
        "- A fund has no live price: `price` or `total` is needed. No source is ever asked for it.",
        "- A retry with the same figures as a live trade entered in the last 10 minutes is refused (409), unless `again` is true.",
      ),
      requestBody: bodyOf(ref("FundTradeArgs")),
      responses: base({
        201: {
          ...ok(
            "The trade, or one per broker for a sell of all, and the fund.",
            ref("AddedFundTrade"),
          ),
          headers: { Location: { schema: str } },
        },
        404: missing,
        409: conflict,
        ...json415,
      }),
    },
  },
  "/funds/{isin}": {
    parameters: [
      {
        name: "isin",
        in: "path" as const,
        description: "The fund's ISIN.",
        required: true,
        schema: str,
      },
    ],
    get: {
      tags,
      operationId: "getFund",
      security: READS,
      summary: "A fund, its prices and trades",
      description:
        "The fund with every price it was given, newest first, and its live trades.",
      responses: base({
        200: ok("The fund.", ref("FundDetail")),
        404: missing,
      }),
    },
    patch: {
      tags,
      operationId: "updateFund",
      security: WRITES,
      summary: "Set a fund's price",
      description:
        "Sets its price per unit for a day, the owner's today by default: a price for a day already priced replaces it, and earlier days are kept. The latest values the holding. Also sets the market its money is in.",
      requestBody: bodyOf(ref("FundChange")),
      responses: base({
        200: ok("The fund.", ref("UpdatedFund")),
        404: missing,
        ...json415,
      }),
    },
  },
  "/brokers": {
    get: {
      tags,
      operationId: "listBrokers",
      security: READS,
      summary: "Brokers",
      description: "The broker names the owner keeps.",
      responses: base({ 200: ok("The brokers.", ref("Brokers")) }),
    },
    post: {
      tags,
      operationId: "createBroker",
      security: WRITES,
      summary: "Add a broker",
      description: "A broker is a name, matched without case.",
      requestBody: bodyOf(ref("Named")),
      responses: base({
        201: {
          ...ok("The broker.", ref("OneBroker")),
          headers: { Location: { schema: str } },
        },
        409: conflict,
        ...json415,
      }),
    },
  },
  "/brokers/{id}": {
    parameters: [idParam("broker")],
    patch: {
      tags,
      operationId: "renameBroker",
      security: WRITES,
      summary: "Rename a broker",
      description: "Renames it everywhere it is named.",
      requestBody: bodyOf(ref("Named")),
      responses: base({
        200: ok("The broker.", ref("OneBroker")),
        404: missing,
        409: conflict,
        ...json415,
      }),
    },
    delete: {
      tags,
      operationId: "deleteBroker",
      security: WRITES,
      summary: "Delete a broker",
      description:
        "Refused while a trade or position that is not removed names it; removed ones that name it lose the name.",
      responses: base({
        204: { description: "Deleted." },
        404: missing,
        409: conflict,
      }),
    },
  },
  "/portfolio-settings": {
    get: {
      tags,
      operationId: "portfolioSettings",
      security: READS,
      summary: "Portfolio settings",
      description:
        "The display currency and the owner's time zone, each null until set.",
      responses: base({ 200: ok("The settings.", ref("Settings")) }),
    },
    put: {
      tags,
      operationId: "savePortfolioSettings",
      security: WRITES,
      summary: "Save portfolio settings",
      description:
        "Sets the display currency, the time zone or both: totals are also shown converted into the currency when a caller names none, and a position with no date is dated today in the zone. Either can be changed, never cleared; one left out is kept.",
      requestBody: bodyOf(ref("Settings")),
      responses: base({
        200: ok("The settings.", ref("Settings")),
        ...json415,
      }),
    },
  },
};
