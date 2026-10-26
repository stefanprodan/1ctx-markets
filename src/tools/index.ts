// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The read tools on an MCP server instance, and GET /quotes. Schemas
// tell a client the shape; the tools check arguments themselves, so an
// error says which argument and why.

import {
  fromJsonSchema,
  type JsonSchemaType,
  type jsonSchemaValidator,
  type McpServer,
} from "@modelcontextprotocol/server";
import { errorFields } from "../log.ts";
import { errorResult, type ToolResult, textResult } from "./answer.ts";
import { ArgError, MAX_SYMBOL } from "./args.ts";
import { eventsAnswer, MAX_EVENT_SYMBOLS, parseEvents } from "./events.ts";
import { historyAnswer, parseHistory } from "./history.ts";
import { AVERAGES, moversAnswer, parseMovers } from "./movers.ts";
import { MAX_SYMBOLS, parseQuote, quotePage } from "./quote.ts";
import {
  parseResearch,
  RESEARCH_SECTIONS,
  researchAnswer,
} from "./research.ts";
import {
  FIELD_NAMES,
  MAX_FILTERS,
  parseScreen,
  screenAnswer,
} from "./screen.ts";
import { parseSearch, searchPage } from "./search.ts";
import type { Markets } from "./targets.ts";

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
  `Live quotes and the latest signals for 1 to ${MAX_SYMBOLS} symbols. A symbol is a stored id (US:NVDA, XETRA:VVSM, CRYPTO:SOL-USD), a Yahoo symbol (NVDA, VVSM.DE, ^VIX, EURUSD=X), FRED:<series id> (FRED:DGS10) or a name; one with several listings answers candidates to pick an id from. A symbol never read is fetched inside the call within ${m.callMs / 1000} seconds; one not done answers timeout: call again for it. Each item: price, previous close, change, day range, volume, trade_time (null when the source gives none), fetched_at, the latest daily and weekly signal rows (live or final: SMA 50/200, EMA 20, RSI 14, MACD, ATR 14, 20-day volatility, Bollinger lower band, 52-week range, drawdown, volume ratio) and stale reasons. A FRED series answers its last observation and date, with a null price. Errors are items. When next is set, call again with the same symbols and next.`;

const HISTORY =
  "Daily (1d) or weekly (1wk) bars of one symbol, oldest first, each with its final flag and that date's signal row. from and to are YYYY-MM-DD; to defaults to the latest bar, from to 3 months before to for 1d and 2 years for 1wk. Prices are split-adjusted; averages and returns are on price, with dividends and FX conversion excluded. With a benchmark (any symbol, e.g. QQQ or ^GDAXI), it adds the 1- and 3-month return relative to it at to, in percentage points, naming both currencies. Symbols resolve and are fetched as in quote. When next is set, call again with the same arguments and next.";

const MOVERS =
  "The day's movers among 1 to 100 symbols. min_move_pct (0 or more) is the live change from the previous close, in percent, with direction up, down or either (default). average (daily_sma50, daily_sma200, daily_ema20, weekly_sma50, weekly_sma200) with relation above or below compares the live price with it; crossed_up or crossed_down compares the last final close with the average then, and the live price with the average now. Give a move, an average or both; all given must hold. Matches come largest absolute change first. A symbol with a stale or missing quote or average is unavailable, never a match; a FRED series has no live quote and never moves. Symbols resolve and are fetched as in quote. When next is set, call again with the same arguments and next; each page is a fresh view, so matches may shift.";

const SCREEN = `Filter and rank 1 to 100 symbols on their latest signals: the live row once the market traded today, else the last final. filters: at most ${MAX_FILTERS}, all must hold: {field, min, max} inclusive, either bound alone, or {field, eq: -1|0|1} for the cross, edge and turn states. Fields: sma50, sma200, ema20, rsi14, macd, macd_signal, macd_histogram, macd_turn, atr14, move_atr, volatility20, bollinger_lower, high52w, low52w, drawdown, from_low, days_since_high, volume_ratio, cross, cross_edge, weekly_sma50, weekly_sma200, weekly_cross, weekly_cross_edge; percent from the price to an average: distance_sma50, distance_sma200, distance_ema20, distance_weekly_sma50, distance_weekly_sma200, distance_bollinger_lower; relative_return_1m, relative_return_3m (need benchmark). Price-level fields need one unit and currency across the symbols. A missing, null or stale input makes a symbol unavailable, never a match. sort: a field, order asc or desc; by id otherwise. Fetched as in quote; next continues a fresh view, which may shift.`;

const SEARCH =
  "Find instruments by name or symbol: stored ones and Yahoo's listings, each with its id, exchange, type and name, for quote or history. Fetches no prices. FRED series match only as FRED:<series id>.";

const RESEARCH =
  "One US-listed share's research from Finnhub and news from Massive. section overview (default): the quote and latest signals as in quote, the latest metrics (forward_pe, forward_peg, pe_ttm, ps_ttm, pb, EPS and revenue growth TTM YoY, net margin TTM, ROE TTM, current ratio and debt to equity quarterly, dividend yield TTM, beta), analyst counts, earnings surprise, insider month (share change, MSPR), the next earnings event and five recent headlines, each with fetched_at and stale reasons. analysts, earnings and insiders page their history, newest first; news pages 30 days of articles for this ticker, newest first, each with published_at, title, publisher, url, and the ticker's own sentiment (positive, neutral, negative, or null) with reasoning. A share never researched or never asked for news is fetched inside the call as in quote; ETFs, indices and non-US listings answer no data from Finnhub, and news covers US shares and ETFs. When next is set, call again with the same arguments and next.";

const EVENTS = `Earnings events dated from to to (YYYY-MM-DD, inclusive) of the tracked US shares, or of 1 to ${MAX_EVENT_SYMBOLS} symbols named, by date. Each: fiscal_year, fiscal_quarter, date, hour (amc after close, bmo before open, or empty), status (scheduled; awaiting results once its date came without actuals; reported once EPS or revenue actuals are seen, with reported_seen_at), EPS and revenue estimates and actuals (revenue in whole currency units), fetched_at, stale. Symbols resolve and are fetched as in quote; one Finnhub does not cover is listed as unavailable. When next is set, call again with the same arguments and next.`;

type Tool = {
  name: string;
  description: string;
  inputSchema: ReturnType<typeof schema>;
  run: (input: unknown) => Promise<ToolResult>;
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
          interval: { type: "string", enum: ["1d", "1wk"], default: "1d" },
          from: day,
          to: day,
          benchmark: symbol,
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
  ];
}

// A bad argument is the caller's to fix; anything else is logged and
// answered without its text, which can quote a source.
export async function call(
  m: Markets,
  tool: Tool,
  input: unknown,
): Promise<ToolResult> {
  const started = m.clock.now();
  try {
    const result = await tool.run(input);
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

// The tools built once, registered on each request's server instance.
export function registerTools(m: Markets): (server: McpServer) => void {
  const list = tools(m);
  return (server) => {
    for (const tool of list) {
      server.registerTool(
        tool.name,
        {
          description: tool.description,
          inputSchema: tool.inputSchema,
          annotations: { readOnlyHint: true, openWorldHint: true },
        },
        (input: unknown) => call(m, tool, input),
      );
    }
  };
}
