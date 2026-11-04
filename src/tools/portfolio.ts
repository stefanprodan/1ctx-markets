// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// Thin over the operations REST shares, so REST's contract never moves with a tool.

import type { JsonSchemaType } from "@modelcontextprotocol/server";
import {
  ArgError,
  date,
  fields,
  quoted,
  text,
  textValues,
} from "../operations/args.ts";
import { MAX_HOLDING_ROWS } from "../operations/funds.ts";
import type { Markets } from "../operations/markets.ts";
import {
  brokerNames,
  isinArg,
  MAX_REMOVED,
  MAX_SETUP_BROKERS,
  NO_POSITION_MARKET,
  namedCurrency,
  nextOf,
  type PortfolioArgs,
  parseChange,
  parseFundChange,
  parseFundTrade,
  parsePosition,
  parseTrade,
  portfolioAnswer,
  RETRY_MS,
  ref,
  rowId,
  zoneArg,
} from "../operations/portfolio.ts";
import { type Access, NO_ACCESS } from "../operations/who.ts";
import { ASSET_KEYS, SECTOR_KEYS } from "../portfolios/fund-holdings.ts";
import { isFundKey } from "../portfolios/funds.ts";
import { MAX_NAME, MAX_NOTE, MAX_POSITION_NAME } from "../portfolios/store.ts";
import { day, next, schema, symbol, type Tool } from "./schema.ts";

const readDescription = (writes: boolean) =>
  `${writes ? "Writes go through portfolio_trade (shares, ETFs, crypto, funds), portfolio_cash, portfolio_bond, portfolio_fund (a fund's price) and portfolio_setup. " : ""}For "my stocks", "my ETF", "my portfolio" or a named one: holdings first, then its symbols to quote, history, research. list: portfolios, brokers, markets, funds, display currency, time zone. holdings: portfolio, broker; totals per currency, currency converts. A row's symbol is what quote takes (a fund's key), null for cash and an unlisted bond. position is a cash or bond row's id${writes ? " for portfolio_cash or portfolio_bond" : ""}, null for a share, ETF, crypto or fund${writes ? ", which change through their trades" : ""}, and on a merged bond, each purchase's in parts. Cash is dry_powder (ready to invest) or reserve. as_of: a bond's purchase date, a fund's price date. removed true adds the ${MAX_REMOVED} latest removed cash and bond rows. price: the listing's, see fetched_at. trades: portfolio, broker, symbol, from, to, removed${writes ? "; a trade's id is what portfolio_trade removes" : ""}. history: position. next pages.`;

const TRADE = `Records a buy or sell of a share, ETF, crypto or fund; remove or restore a trade by its id (from trades). add: symbol as quote takes it, or a fund by isin, its key as symbol (fund:<ISIN>) or name; side; quantity, or all: true to sell all held; price or total (what left or reached the account, fees in), neither: the live price; fees, date (default today), currency paid, broker (one listed), portfolio (needed when several), note. A fund: one trade per confirmation; its first buy makes it, with isin, name and currency; market: where its money is invested. The same trade within ${RETRY_MS / 60_000} minutes is refused as a repeat unless again: true, for two real equal fills. Removing all of a holding is removing its trades. Cash never moves with a trade: see portfolio_cash. Examples: {"action":"add","symbol":"AAPL","side":"buy","quantity":3,"price":190.5,"fees":1,"broker":"North"}; a first fund buy {"action":"add","isin":"ZZFUND000011","name":"Made Up Fund","side":"buy","quantity":12.5,"total":1000,"currency":"EUR"}.`;

const CASH = `Adds, updates, removes or restores the owner's cash; all cash lives in Cash. A row is picked by position from holdings (removed true lists removed ones), and an update gives it a new position. dry_powder true: ready to invest at a broker; else reserve. add: name, amount, currency, broker, date, note, dry_powder, maturity (a term deposit's last day: from it, matured); the same name, broker and currency replaces that row. update: position and one or more of amount (the new balance), by (+/- a move), currency (of amount or by, converted), date, note (null clears), dry_powder, name, broker (null takes it off), maturity (null takes it off; a deposit rolled over gets its new day). A date before its as_of with amount alone saves a past balance. remove, restore: position. A buy paid from dry powder: holdings, then update that row with by: -(the total paid). Examples: {"action":"update","position":12,"note":"made-up note"}; {"action":"add","name":"Savings","amount":2500,"currency":"EUR","broker":"South"}.`;

const BOND = `Adds, updates, removes or restores a bond the owner holds. add: name, amount (face), currency (the listing's when symbol names one), symbol (a listing, valued at its percent of par), coupon (percent), maturity, cost (paid), date (bought), broker, portfolio (needed when several), note. update: position (from holdings; on a merged bond each purchase's, in parts) and one or more of amount (face), currency (of amount, converted), cost, date, note (null clears), name, broker (null takes it off); an update gives it a new position. Coupon, maturity and listing never change: remove and add again. remove, restore: position. Example: {"action":"add","name":"Made Up 2030","amount":12000,"currency":"EUR","coupon":4.75,"maturity":"2030-06-30","cost":11650,"date":"2026-03-17"}.`;

const FUND = `Sets a fund the owner prices: its price per unit for a day, its market, name, currency or holdings. The fund is picked by isin or symbol (its key, fund:<ISIN>, as holdings answers it), else by name; with a pick, name renames it. price with date (default today): a day already priced is replaced. market: where its money is invested (list names them), null takes it off. currency: only while no trade is priced in it. holdings, from its reports, read as an ETF's in research: as_of (report day); top (up to ${MAX_HOLDING_ROWS} of symbol as quote takes it, name, weight %) with assets (% per kind), replaced together; sectors (% per sector key), replaced only when given; a later part is never replaced by an earlier one. Buys and sells go through portfolio_trade. Examples: {"isin":"ZZFUND000011","price":11.87,"date":"2026-10-14"}; {"isin":"ZZFUND000011","holdings":{"as_of":"2026-09-30","top":[{"symbol":"AAPL","weight":6.2}],"assets":{"stock":95,"cash":5}}}.`;

const SETUP = `First steps for an owner, and broker renames. setup: display_currency (totals are shown in it: ask the owner, never assume), time_zone (IANA, ask), a portfolio to make, broker (a name or up to ${MAX_SETUP_BROKERS}); a name already there is kept, so a retry makes nothing twice; the display currency and time zone are set only while none is, then the owner changes them in the web UI. rename_broker: broker (its name now), name (the new one). Example: {"action":"setup","display_currency":"EUR","time_zone":"America/New_York","portfolio":"Shares","broker":["North","South"]}.`;

const portfolioRef: JsonSchemaType = {
  type: ["string", "integer"],
  description: "a name or an id",
};
const id: JsonSchemaType = { type: "integer", minimum: 1 };
const amount: JsonSchemaType = { type: "number", minimum: 0 };
const pct: JsonSchemaType = { type: "number", minimum: 0, maximum: 100 };
const weights = (keys: readonly string[]): JsonSchemaType => ({
  type: "object",
  properties: Object.fromEntries(keys.map((k) => [k, pct])),
  additionalProperties: false,
});
const holdings: JsonSchemaType = {
  type: "object",
  properties: {
    as_of: day,
    top: {
      type: "array",
      minItems: 1,
      maxItems: MAX_HOLDING_ROWS,
      items: {
        type: "object",
        properties: {
          symbol,
          name: { type: "string" },
          weight: pct,
        },
        required: ["weight"],
        additionalProperties: false,
      },
    },
    assets: weights(ASSET_KEYS),
    sectors: weights(SECTOR_KEYS),
  },
  required: ["as_of"],
  additionalProperties: false,
};
const nullable = (type: string, extra: object = {}): JsonSchemaType => ({
  type: [type, "null"],
  ...extra,
});

const actionOf = <T extends string>(
  f: Record<string, unknown>,
  actions: readonly T[],
): T => {
  if (typeof f.action !== "string" || !actions.includes(f.action as T)) {
    throw new ArgError(`action must be one of ${actions.join(", ")}`);
  }
  return f.action as T;
};

// an argument of another action is refused, not ignored
function only(
  f: Record<string, unknown>,
  action: string,
  allowed: readonly string[],
): void {
  for (const name of Object.keys(f)) {
    if (name !== "action" && !allowed.includes(name)) {
      throw new ArgError(`${quoted(name)} is not an argument of ${action}`);
    }
  }
}

const READ_ARGS = {
  list: [],
  holdings: ["portfolio", "broker", "currency", "removed", "next"],
  trades: ["portfolio", "broker", "symbol", "from", "to", "removed", "next"],
  history: ["position"],
} as const;

export function parsePortfolioRead(input: unknown): PortfolioArgs {
  const f = textValues(
    fields(input, ["action", ...new Set(Object.values(READ_ARGS).flat())]),
    { flags: ["removed"], ids: ["position"] },
  );
  const action = actionOf(f, [
    "list",
    "holdings",
    "trades",
    "history",
  ] as const);
  only(f, action, READ_ARGS[action]);
  if (f.removed !== undefined && typeof f.removed !== "boolean") {
    throw new ArgError("removed must be true or false");
  }
  const broker =
    f.broker === undefined || f.broker === null
      ? null
      : text(f.broker, "broker", MAX_NAME);
  switch (action) {
    case "list":
      return { action };
    case "history":
      return { action, position: rowId(f.position, "position") };
    case "holdings":
      return {
        action,
        portfolio: ref(f.portfolio),
        broker,
        currency: namedCurrency(f.currency),
        removed: f.removed === true,
        next: nextOf(f.next),
      };
    case "trades":
      return {
        action,
        portfolio: ref(f.portfolio),
        broker,
        symbol:
          f.symbol === undefined || f.symbol === null
            ? null
            : text(f.symbol, "symbol"),
        from: date(f.from, "from"),
        to: date(f.to, "to"),
        removed: f.removed === true,
        next: nextOf(f.next),
      };
  }
}

const TRADE_ADD = [
  "portfolio",
  "symbol",
  "isin",
  "name",
  "market",
  "side",
  "quantity",
  "all",
  "price",
  "total",
  "fees",
  "date",
  "currency",
  "broker",
  "note",
  "again",
];

// a fund's key as symbol names the fund by its ISIN
const keyIsin = (symbol: unknown): string | null =>
  typeof symbol === "string" && isFundKey(symbol)
    ? isinArg(symbol.trim().slice(symbol.trim().indexOf(":") + 1), "symbol")
    : null;

export function parseTradeTool(input: unknown): PortfolioArgs {
  const f = textValues(fields(input, ["action", ...TRADE_ADD, "trade"]), {
    numbers: ["quantity", "price", "total", "fees"],
    ids: ["trade"],
    flags: ["again", "all"],
  });
  const action = actionOf(f, ["add", "remove", "restore"] as const);
  if (action !== "add") {
    // agents name the portfolio out of habit: checked, never needed
    only(f, action, ["trade", "portfolio"]);
    return {
      action,
      trade: rowId(f.trade, "trade"),
      portfolio: ref(f.portfolio),
    };
  }
  only(f, action, TRADE_ADD);
  if (f.all !== undefined && typeof f.all !== "boolean") {
    throw new ArgError("all must be true or false");
  }
  if (f.quantity === "all") {
    throw new ArgError("quantity must be a number; a sell of all is all: true");
  }
  const { all, ...g } = f;
  if (all === true) {
    if (g.quantity !== undefined) {
      throw new ArgError("a trade takes quantity or all, not both");
    }
    if (g.side === "buy") throw new ArgError("all sells what is held");
    g.quantity = "all";
  }
  const key = keyIsin(g.symbol);
  if (key === null && g.symbol !== undefined) {
    if (g.isin !== undefined || g.name !== undefined) {
      throw new ArgError(
        "a trade names symbol, or a fund by isin or name, not both",
      );
    }
    if (g.market !== undefined) {
      throw new ArgError(
        "market is a fund's, where its money is invested; a share's is its listing's",
      );
    }
    return { action, kind: "trade", trade: parseTrade(g) };
  }
  if (key !== null && g.isin !== undefined) {
    throw new ArgError("a fund is named by isin or symbol, not both");
  }
  if (g.symbol === undefined && g.isin === undefined && g.name === undefined) {
    throw new ArgError("add names symbol, or a fund by isin or name");
  }
  const { symbol: _, ...h } = g;
  return {
    action,
    kind: "fund",
    fund: parseFundTrade(key === null ? h : { ...h, isin: key }, "quantity"),
  };
}

const CASH_ADD = [
  "name",
  "amount",
  "currency",
  "date",
  "broker",
  "note",
  "dry_powder",
  "maturity",
];
const CASH_UPDATE = [
  "position",
  "amount",
  "by",
  "currency",
  "date",
  "note",
  "dry_powder",
  "name",
  "broker",
  "maturity",
];

const rowAction = (
  f: Record<string, unknown>,
  action: "remove" | "restore",
  kind: "cash" | "bond",
): PortfolioArgs => {
  only(f, action, ["position"]);
  return { action, position: rowId(f.position, "position"), kind };
};

const updateOf = (
  f: Record<string, unknown>,
  kind: "cash" | "bond",
  allowed: readonly string[],
): PortfolioArgs => {
  only(f, "update", allowed);
  const { action: _, position, ...change } = f;
  return {
    action: "update",
    position: rowId(position, "position"),
    kind,
    change: parseChange(
      change,
      allowed.filter((x) => x !== "position" && x !== "currency"),
    ),
  };
};

// cash and bonds take no market, said with the reason
const positionFields = (input: unknown, allowed: string[]) => {
  const f = fields(input, [...allowed, "market"]);
  if (f.market !== undefined) throw new ArgError(NO_POSITION_MARKET);
  return f;
};

export function parseCashTool(input: unknown): PortfolioArgs {
  const f = textValues(positionFields(input, ["action", ...CASH_UPDATE]), {
    numbers: ["amount", "by"],
    ids: ["position"],
    flags: ["dry_powder"],
  });
  const action = actionOf(f, ["add", "update", "remove", "restore"] as const);
  switch (action) {
    case "add": {
      only(f, action, CASH_ADD);
      const { action: _, ...g } = f;
      return { action, kind: "cash", position: parsePosition("cash", g) };
    }
    case "update":
      return updateOf(f, "cash", CASH_UPDATE);
    default:
      return rowAction(f, action, "cash");
  }
}

const BOND_ADD = [
  "portfolio",
  "name",
  "symbol",
  "amount",
  "coupon",
  "maturity",
  "currency",
  "cost",
  "date",
  "broker",
  "note",
];
const BOND_UPDATE = [
  "position",
  "amount",
  "currency",
  "cost",
  "date",
  "note",
  "name",
  "broker",
];

export function parseBondTool(input: unknown): PortfolioArgs {
  const f = textValues(
    positionFields(input, ["action", ...BOND_ADD, "position"]),
    {
      numbers: ["amount", "cost", "coupon"],
      ids: ["position"],
    },
  );
  const action = actionOf(f, ["add", "update", "remove", "restore"] as const);
  switch (action) {
    case "add": {
      only(f, action, BOND_ADD);
      const { action: _, ...g } = f;
      return { action, kind: "bond", position: parsePosition("bond", g) };
    }
    case "update":
      return updateOf(f, "bond", BOND_UPDATE);
    default:
      return rowAction(f, action, "bond");
  }
}

const FUND_ARGS = [
  "isin",
  "symbol",
  "name",
  "price",
  "date",
  "market",
  "currency",
  "holdings",
];

export function parseFundTool(input: unknown): PortfolioArgs {
  const f = textValues(fields(input, FUND_ARGS), { numbers: ["price"] });
  if (f.symbol !== undefined && keyIsin(f.symbol) === null) {
    throw new ArgError(
      "symbol is a fund's key, fund:<ISIN>, as holdings answers it",
    );
  }
  const key = keyIsin(f.symbol);
  if (key !== null && f.isin !== undefined) {
    throw new ArgError("a fund is named by isin or symbol, not both");
  }
  const isin = key ?? isinArg(f.isin);
  if (isin === null && f.name === undefined) {
    throw new ArgError("name the fund by isin, symbol or name");
  }
  const { isin: _, symbol: __, ...change } = f;
  return {
    action: "update",
    fund: isin ?? text(f.name, "name", MAX_POSITION_NAME),
    change: parseFundChange(change, isin !== null),
  };
}

export function parseSetupTool(input: unknown): PortfolioArgs {
  const f = fields(input, [
    "action",
    "display_currency",
    "time_zone",
    "portfolio",
    "broker",
    "name",
  ]);
  const action = actionOf(f, ["setup", "rename_broker"] as const);
  if (action === "rename_broker") {
    only(f, action, ["broker", "name"]);
    return {
      action,
      broker: text(f.broker, "broker", MAX_NAME),
      name: text(f.name, "name", MAX_NAME),
    };
  }
  only(f, action, ["display_currency", "time_zone", "portfolio", "broker"]);
  const made = {
    action,
    currency: namedCurrency(f.display_currency, "display_currency"),
    zone: zoneArg(f.time_zone),
    portfolio:
      f.portfolio === undefined || f.portfolio === null
        ? null
        : text(f.portfolio, "portfolio", MAX_NAME),
    brokers: brokerNames(f.broker),
  };
  if (
    made.currency === null &&
    made.zone === null &&
    made.portfolio === null &&
    made.brokers.length === 0
  ) {
    throw new ArgError(
      "setup takes one or more of display_currency, time_zone, portfolio, broker",
    );
  }
  return made;
}

const note: JsonSchemaType = nullable("string", {
  maxLength: MAX_NOTE,
  description: "null clears it on update",
});
const broker: JsonSchemaType = nullable("string", {
  description: "a listed broker; null takes it off on update",
});

// the read tool for read access, all of them for write
export function portfolioTools(m: Markets, access: Access): Tool[] {
  if (access === "none") return [];
  const run =
    (parse: (input: unknown) => PortfolioArgs): Tool["run"] =>
    (input, who) =>
      portfolioAnswer(m, who ?? NO_ACCESS, parse(input));
  const read: Tool = {
    name: "portfolio",
    description: readDescription(access === "write"),
    inputSchema: schema(
      {
        action: {
          type: "string",
          enum: ["list", "holdings", "trades", "history"],
        },
        position: {
          ...id,
          description:
            "history: a cash or bond row's, from holdings; answers its updates oldest first, each with its date, amount, note, removed (taken off by hand), undone (set aside by a restore) and past (a past balance)",
        },
        portfolio: portfolioRef,
        broker: { type: "string" },
        currency: { type: "string" },
        symbol,
        from: day,
        to: day,
        removed: {
          type: "boolean",
          default: false,
          description:
            "trades: include removed ones; holdings: list removed cash and bonds",
        },
        next,
      },
      ["action"],
    ),
    run: run(parsePortfolioRead),
  };
  if (access === "read") return [read];
  return [
    read,
    {
      name: "portfolio_trade",
      description: TRADE,
      inputSchema: schema(
        {
          action: { type: "string", enum: ["add", "remove", "restore"] },
          symbol,
          isin: { type: "string" },
          name: { type: "string" },
          side: { type: "string", enum: ["buy", "sell"] },
          quantity: { type: "number", exclusiveMinimum: 0 },
          all: { type: "boolean", description: "a sell of all held" },
          price: amount,
          total: amount,
          fees: amount,
          date: day,
          currency: { type: "string" },
          broker: { type: "string" },
          portfolio: portfolioRef,
          market: { type: ["string", "null"] },
          note: { type: "string", maxLength: MAX_NOTE },
          again: { type: "boolean", default: false },
          trade: { ...id, description: "remove, restore: the trade's id" },
        },
        ["action"],
      ),
      run: run(parseTradeTool),
      writes: true,
    },
    {
      name: "portfolio_cash",
      description: CASH,
      inputSchema: schema(
        {
          action: {
            type: "string",
            enum: ["add", "update", "remove", "restore"],
          },
          position: { ...id, description: "update, remove, restore" },
          name: { type: "string" },
          amount,
          by: { type: "number" },
          currency: { type: "string" },
          date: day,
          broker,
          note,
          dry_powder: { type: "boolean" },
          maturity: nullable("string", {
            pattern: day.pattern,
            description: "a term deposit's last day; null takes it off",
          }),
        },
        ["action"],
      ),
      run: run(parseCashTool),
      writes: true,
    },
    {
      name: "portfolio_bond",
      description: BOND,
      inputSchema: schema(
        {
          action: {
            type: "string",
            enum: ["add", "update", "remove", "restore"],
          },
          position: { ...id, description: "update, remove, restore" },
          name: { type: "string" },
          amount,
          symbol,
          coupon: { type: "number" },
          maturity: day,
          currency: { type: "string" },
          cost: amount,
          date: day,
          broker,
          portfolio: portfolioRef,
          note,
        },
        ["action"],
      ),
      run: run(parseBondTool),
      writes: true,
    },
    {
      name: "portfolio_fund",
      description: FUND,
      inputSchema: schema(
        {
          isin: { type: "string" },
          symbol,
          name: { type: "string" },
          price: amount,
          date: day,
          market: nullable("string"),
          currency: { type: "string" },
          holdings,
        },
        [],
      ),
      run: run(parseFundTool),
      writes: true,
    },
    {
      name: "portfolio_setup",
      description: SETUP,
      inputSchema: schema(
        {
          action: { type: "string", enum: ["setup", "rename_broker"] },
          display_currency: { type: "string" },
          time_zone: { type: "string" },
          portfolio: { type: "string" },
          broker: {
            type: ["string", "array"],
            items: { type: "string" },
            maxItems: MAX_SETUP_BROKERS,
          },
          name: { type: "string" },
        },
        ["action"],
      ),
      run: run(parseSetupTool),
      writes: true,
    },
  ];
}
