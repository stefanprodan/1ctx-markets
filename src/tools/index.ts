// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import {
  fromJsonSchema,
  type JsonSchemaType,
  type jsonSchemaValidator,
  type McpServer,
} from "@modelcontextprotocol/server";
import { INTRADAY_SESSIONS } from "../market/intraday.ts";
import {
  errorResult,
  type ToolResult,
  textResult,
} from "../operations/answer.ts";
import { ArgError, MAX_SYMBOL } from "../operations/args.ts";
import {
  eventsAnswer,
  MAX_EVENT_SYMBOLS,
  parseEvents,
} from "../operations/events.ts";
import {
  DEFAULT_MONTHS,
  historyAnswer,
  parseHistory,
} from "../operations/history.ts";
import type { Markets } from "../operations/markets.ts";
import { AVERAGES, moversAnswer, parseMovers } from "../operations/movers.ts";
import {
  ADD_KINDS,
  PORTFOLIO_ACTIONS,
  parsePortfolio,
  portfolioAnswer,
} from "../operations/portfolio.ts";
import { MAX_SYMBOLS, parseQuote, quotePage } from "../operations/quote.ts";
import { SINCE_DAYS } from "../operations/research.ts";
import { parseRules, RULE_ACTIONS, rulesAnswer } from "../operations/rules.ts";
import {
  FIELD_NAMES,
  MAX_FIELDS,
  MAX_FILTERS,
  parseScreen,
  screenAnswer,
} from "../operations/screen.ts";
import { parseSearch, searchPage } from "../operations/search.ts";
import { NO_ACCESS, type Who } from "../operations/who.ts";
import {
  MAX_COMPARISONS,
  MAX_DEPTH,
  MAX_INSTRUMENTS,
  MAX_NOTE,
} from "../rules/format.ts";
import { errorFields } from "../runtime/log.ts";
import { CALENDAR_AHEAD_DAYS } from "../sources/finnhub/store.ts";
import {
  parseResearch,
  RESEARCH_SECTIONS,
  researchAnswer,
} from "./research.ts";

// the tools check their own arguments, with errors in their own words
const permissive = {
  getValidator: () => (input: unknown) => ({
    valid: true as const,
    data: input,
    errorMessage: undefined,
  }),
} as unknown as jsonSchemaValidator;

const schema = (
  properties: Record<string, JsonSchemaType>,
  required: string[],
) =>
  fromJsonSchema<Record<string, unknown>>(
    {
      type: "object",
      properties,
      required,
      additionalProperties: false,
    },
    permissive,
  );

const symbol: JsonSchemaType = {
  type: "string",
  minLength: 1,
  maxLength: MAX_SYMBOL,
};
const next: JsonSchemaType = {
  type: "string",
  description: "the next of an earlier answer, with the same arguments",
};
const day: JsonSchemaType = {
  type: "string",
  pattern: "^\\d{4}-\\d{2}-\\d{2}$",
};

const quoteDescription = (m: Markets) =>
  `Live quotes and signals for 1 to ${MAX_SYMBOLS} symbols: a stored id (US:NVDA), a Yahoo symbol (VVSM.DE, ^VIX), FRED:<series id> or a name; several listings answer candidates. One never read is fetched in ${m.callMs / 1000} seconds, else timeout: call again. Each item: price, previous close, change, day range, volume, trade_time, fetched_at, daily and weekly signal rows (live or final: SMA 50/200, EMA 20, RSI, MACD, ATR, volatility, Bollinger, 52w range, drawdown, volume ratio), stale. returns: 1w, 1m, 3m, ytd percent (points for a yield) to the live price or last final close (live says which), null if too few bars. session: open or closed (regular; closed briefly at an open), start, end. benchmark (one symbol) adds relative_return_1m, _3m in percentage points. extended true adds extended: the last pre- or post-market price (session, price, change, change_percent from the regular close, time), or null with why in stale. FRED: last observation, price null. Errors are items. When next is set, call again with the same arguments and next.`;

const HISTORY = `Daily (1d) or weekly (1wk) bars of one symbol, oldest first, each with its final flag and that date's signal row. from and to are YYYY-MM-DD; to defaults to the latest bar, from to ${DEFAULT_MONTHS["1d"]} months before to for 1d and ${DEFAULT_MONTHS["1wk"]} months for 1wk. Prices are split-adjusted; averages and returns are on price, with dividends and FX conversion excluded. With a benchmark (any symbol, e.g. QQQ or ^GDAXI), it adds the 1- and 3-month return relative to it at to, in percentage points (points for a yield or spread), naming both currencies. interval 5m: today's or the last ${INTRADAY_SESSIONS} sessions' 5-minute closes, regular hours, as fresh as the quote pass: points (at UTC, session date, close, final), each session's fetched_at, previous_close (a move's base); from and to are session dates, the newest stored by default; no signals or benchmark. extended true adds extended_points: pre- and post-market 5-minute closes while the session is closed. Symbols resolve and are fetched as in quote. When next is set, call again with the same arguments and next.`;

const MOVERS = `The day's movers among 1 to ${MAX_SYMBOLS} symbols. min_move_pct (0 or more) is the live change from the previous close, in percent, with direction up, down or either (default). average (daily_sma50, daily_sma200, daily_ema20, weekly_sma50, weekly_sma200) with relation above or below compares the live price with it; crossed_up or crossed_down compares the last final close with the average then, and the live price with the average now. Give a move, an average or both; all given must hold. Matches come largest absolute change first. A symbol with a stale or missing quote or average is unavailable, never a match; a FRED series has no live quote and never moves. Symbols resolve and are fetched as in quote. When next is set, call again with the same arguments and next; each page is a fresh view, so matches may shift.`;

const SCREEN = `Filter and rank 1 to ${MAX_SYMBOLS} symbols on their latest signals: the live row once the market traded today, else the last final. filters: at most ${MAX_FILTERS}, all must hold: {field, min, max} inclusive, either bound alone, or {field, eq: -1|0|1} for the cross, edge and turn states. field: one of the schema's list, the daily signals as quote names them, weekly_* ones, distance_* (percent from the price to an average), return_1w, _1m, _3m, _ytd (as quote's returns) and relative_return_1m, _3m (need benchmark). fields: at most ${MAX_FIELDS} more shown on every row, null when missing. Price-level fields need one unit and currency across the symbols. A missing, null or stale input makes a symbol unavailable, never a match. sort: a field, order asc or desc; by id otherwise. Fetched as in quote; next continues a fresh view, which may shift.`;

const SEARCH =
  "Find instruments by name or symbol: stored ones, Yahoo's listings and, with the Bucharest feed on, the exchange's own, each with its id, exchange, type and name, for quote or history. Fetches no prices. A FRED series not stored yet is found only as FRED:<series id>.";

const RESEARCH = `One US share's research (Finnhub), news (Massive) and SEC filings (EDGAR). section overview (default): the quote and signals as in quote, the latest metrics (forward_pe, forward_peg, pe_ttm, ps_ttm, pb, EPS and revenue growth TTM YoY, net margin TTM, ROE TTM, current ratio and debt to equity quarterly, dividend yield TTM, beta), analyst counts, earnings surprise, insider month (share change, MSPR), the next earnings event, five headlines, five filings and flags late_filing, restatement, offering, each with fetched_at and stale. analysts, earnings, insiders and filings page their history, newest first; news pages articles newest first from since (YYYY-MM-DD UTC, at most ${SINCE_DAYS} days back, the default), the first page counting by sentiment; each with published_at, title, publisher, url, its own sentiment (positive, neutral, negative, null), reasoning. Never fetched is fetched in the call as in quote; Finnhub and EDGAR cover US shares, news US ETFs too. When next is set, call again with the same arguments and next.`;

const EVENTS = `Earnings events dated from to to (YYYY-MM-DD, inclusive) of the tracked US shares, or of 1 to ${MAX_EVENT_SYMBOLS} symbols named, by date. Company events only: macro dates (central bank meetings, data releases, elections) are not here; look them up elsewhere. Each: fiscal_year, fiscal_quarter, date, hour (amc after close, bmo before open, or empty), status (scheduled; awaiting results once its date came without actuals; reported once EPS or revenue actuals are seen, with reported_seen_at), filed_at (the results 8-K's acceptance), EPS and revenue estimates and actuals (revenue in whole currency units), fetched_at, stale. Symbols resolve and are fetched as in quote; one Finnhub does not cover is listed as unavailable. A named share with nothing in the range is in no_event with the last stored event before from and the next after to (date, hour, status), so it is never read as missing data; a no_event next is null when none is within ${CALENDAR_AHEAD_DAYS} days of its last fetch. When next is set, call again with the same arguments and next.`;

const RULES = `Price rules on live quotes. Turning true writes one alert; again only after false. create: symbol, condition, note; answers its first evaluation. condition: {left, op, right} (op < <= > >=; right a number or operand) or {all: [...]}/{any: [...]}; ≤${MAX_COMPARISONS} comparisons, ${MAX_DEPTH} levels, ${MAX_INSTRUMENTS} instruments. Operand: a field of symbol, or {field, symbol} (^VIX). Fields: price changePct dayHigh dayLow previousClose sma50 sma200 ema20 rsi14 macd macdSignal macdHistogram macdTurn atr14 moveAtr volatility20 bollingerLower high52w low52w drawdown fromLow daysSinceHigh volumeRatio cross crossEdge weeklySma50 weeklySma200 weeklyCross weeklyCrossEdge, and {field: relativeReturn1m|relativeReturn3m, benchmark}. Each comparison reads a live value, in one unit. Example: {"all":[{"left":"rsi14","op":"<","right":30},{"left":"price","op":">","right":"sma200"}]}. "afterEarnings": "<US share>" on the root waits for its next results. A stale input changes nothing. A split pauses price-vs-number rules. list: next; pause: id, paused; delete: id.`;

const PORTFOLIO = `For "my stocks", "my ETF", "my portfolio" or a portfolio the owner names: holdings first, then its symbols to quote, history, research. Values and totals per currency, converted only into currency (else display_currency). No portfolio or broker yet: setup with display_currency (ask the owner, never assume), portfolio, broker. list: portfolios, brokers. holdings: portfolio, broker, currency, next. trades: portfolio, broker, symbol, from, to, removed, next. add (kind trade): symbol, side, quantity (all: what each broker can sell), price or total (fees in), fees, date, currency paid, broker (known), note; neither: live price, shown back. cash: name, amount, currency, dry_powder; fund: name, units, price, currency, cost; bond: name, amount (face), symbol, coupon, maturity, currency, cost. update position (id or dry_powder): amount or by (+/-), in currency or its own; units, price, cost, date, note. Into dry powder: add, then update it. Say amounts with currency. remove, restore: trade or position.`;

type Tool = {
  name: string;
  description: string;
  inputSchema: ReturnType<typeof schema>;
  run: (input: unknown, who?: Who) => Promise<ToolResult>;
  // read-only unless said otherwise
  writes?: true;
};

export function tools(m: Markets): Tool[] {
  return [
    {
      name: "quote",
      description: quoteDescription(m),
      inputSchema: schema(
        {
          symbols: {
            type: "array",
            minItems: 1,
            maxItems: MAX_SYMBOLS,
            items: symbol,
          },
          benchmark: symbol,
          extended: { type: "boolean", default: false },
          next,
        },
        ["symbols"],
      ),
      run: async (input) => textResult(await quotePage(m, parseQuote(input))),
    },
    {
      name: "history",
      description: HISTORY,
      inputSchema: schema(
        {
          symbol,
          interval: {
            type: "string",
            enum: ["1d", "1wk", "5m"],
            default: "1d",
          },
          from: day,
          to: day,
          benchmark: symbol,
          extended: { type: "boolean", default: false },
          next,
        },
        ["symbol"],
      ),
      run: (input) => historyAnswer(m, parseHistory(input)),
    },
    {
      name: "movers",
      description: MOVERS,
      inputSchema: schema(
        {
          symbols: {
            type: "array",
            minItems: 1,
            maxItems: MAX_SYMBOLS,
            items: symbol,
          },
          min_move_pct: { type: "number", minimum: 0 },
          direction: {
            type: "string",
            enum: ["up", "down", "either"],
            default: "either",
          },
          average: { type: "string", enum: Object.keys(AVERAGES) },
          relation: {
            type: "string",
            enum: ["above", "below", "crossed_up", "crossed_down"],
          },
          next,
        },
        ["symbols"],
      ),
      run: (input) => moversAnswer(m, parseMovers(input)),
    },
    {
      name: "search",
      description: SEARCH,
      inputSchema: schema({ query: symbol, next }, ["query"]),
      run: async (input) => textResult(await searchPage(m, parseSearch(input))),
    },
    {
      name: "screen",
      description: SCREEN,
      inputSchema: schema(
        {
          symbols: {
            type: "array",
            minItems: 1,
            maxItems: MAX_SYMBOLS,
            items: symbol,
          },
          filters: {
            type: "array",
            maxItems: MAX_FILTERS,
            items: {
              type: "object",
              properties: {
                field: { type: "string", enum: FIELD_NAMES },
                min: { type: "number" },
                max: { type: "number" },
                eq: { type: "integer", enum: [-1, 0, 1] },
              },
              required: ["field"],
              additionalProperties: false,
            },
          },
          benchmark: symbol,
          sort: { type: "string", enum: FIELD_NAMES },
          order: { type: "string", enum: ["asc", "desc"] },
          fields: {
            type: "array",
            maxItems: MAX_FIELDS,
            items: { type: "string", enum: FIELD_NAMES },
          },
          next,
        },
        ["symbols"],
      ),
      run: (input) => screenAnswer(m, parseScreen(input)),
    },
    {
      name: "research",
      description: RESEARCH,
      inputSchema: schema(
        {
          symbol,
          section: {
            type: "string",
            enum: [...RESEARCH_SECTIONS],
            default: "overview",
          },
          since: day,
          next,
        },
        ["symbol"],
      ),
      run: (input) => researchAnswer(m, parseResearch(input)),
    },
    {
      name: "events",
      description: EVENTS,
      inputSchema: schema(
        {
          from: day,
          to: day,
          symbols: {
            type: "array",
            minItems: 1,
            maxItems: MAX_EVENT_SYMBOLS,
            items: symbol,
          },
          next,
        },
        ["from", "to"],
      ),
      run: (input) => eventsAnswer(m, parseEvents(input)),
    },
    {
      name: "rules",
      description: RULES,
      inputSchema: schema(
        {
          action: { type: "string", enum: [...RULE_ACTIONS] },
          symbol,
          condition: {
            type: "object",
            description: "the condition JSON, as in the description",
          },
          note: { type: "string", maxLength: MAX_NOTE },
          id: { type: "integer", minimum: 1 },
          paused: { type: "boolean" },
          next,
        },
        ["action"],
      ),
      run: (input, who) => rulesAnswer(m, who ?? NO_ACCESS, parseRules(input)),
      writes: true,
    },
    {
      name: "portfolio",
      description: PORTFOLIO,
      inputSchema: schema(
        {
          action: { type: "string", enum: [...PORTFOLIO_ACTIONS] },
          kind: { type: "string", enum: [...ADD_KINDS], default: "trade" },
          portfolio: { type: ["string", "integer"] },
          symbol,
          side: { type: "string", enum: ["buy", "sell"] },
          quantity: { type: ["number", "string"] },
          price: { type: "number", minimum: 0 },
          total: { type: "number", minimum: 0 },
          fees: { type: "number", minimum: 0 },
          date: day,
          currency: { type: "string" },
          display_currency: { type: "string" },
          broker: { type: "string" },
          note: { type: "string", maxLength: MAX_NOTE },
          name: { type: "string" },
          amount: { type: "number", minimum: 0 },
          units: { type: "number", exclusiveMinimum: 0 },
          cost: { type: "number", minimum: 0 },
          coupon: { type: "number" },
          maturity: day,
          dry_powder: { type: "boolean" },
          by: { type: "number" },
          trade: { type: "integer", minimum: 1 },
          position: { type: ["integer", "string"] },
          from: day,
          to: day,
          removed: { type: "boolean", default: false },
          next,
        },
        ["action"],
      ),
      run: (input, who) =>
        portfolioAnswer(m, who ?? NO_ACCESS, parsePortfolio(input)),
      writes: true,
    },
  ];
}

// other errors are logged and answered without text that can quote a source
export async function call(
  m: Markets,
  tool: Tool,
  input: unknown,
  who: Who = NO_ACCESS,
): Promise<ToolResult> {
  const started = m.clock.now();
  try {
    const result = await tool.run(input, who);
    m.log.info("tool call", {
      tool: tool.name,
      status: result.isError ? "error" : "ok",
      duration: m.clock.now() - started,
    });
    return result;
  } catch (error) {
    if (error instanceof ArgError) {
      m.log.info("tool call", { tool: tool.name, status: "bad arguments" });
      return errorResult({ error: "bad_arguments", message: error.message });
    }
    m.log.error("tool call", { tool: tool.name, ...errorFields(error) });
    return errorResult({ error: "internal", message: "internal error" });
  }
}

// built once, registered on each request's server instance
export function registerTools(
  m: Markets,
): (server: McpServer, who: Who) => void {
  const list = tools(m);
  return (server, who) => {
    for (const tool of list) {
      server.registerTool(
        tool.name,
        {
          description: tool.description,
          inputSchema: tool.inputSchema,
          annotations: tool.writes
            ? {
                readOnlyHint: false,
                destructiveHint: true,
                idempotentHint: false,
                openWorldHint: true,
              }
            : { readOnlyHint: true, openWorldHint: true },
        },
        (input: unknown) => call(m, tool, input, who),
      );
    }
  };
}
