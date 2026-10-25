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
import { historyAnswer, parseHistory } from "./history.ts";
import { MAX_SYMBOLS, parseQuote, quotePage } from "./quote.ts";
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
  `Live quotes and the latest signals for 1 to ${MAX_SYMBOLS} symbols. A symbol is a stored id (US:NVDA, XETRA:VVSM, CRYPTO:SOL-USD), a Yahoo symbol (NVDA, VVSM.DE, ^VIX, EURUSD=X), FRED:<series id> (FRED:DGS10) or a name; one with several listings answers candidates to pick an id from. A symbol never read is fetched inside the call, at most ${m.inlineFetch} a call within ${m.callMs / 1000} seconds; one not done answers timeout: call again for it. Each item: price, previous close, change, day range, volume, trade_time (null when the source gives none), fetched_at, the latest daily and weekly signal rows (live or final: SMA 50/200, EMA 20, RSI 14, MACD, ATR 14, 20-day volatility, Bollinger lower band, 52-week range, drawdown, volume ratio) and stale reasons. A FRED series answers its last observation and date, with a null price. Errors are items. When next is set, call again with the same symbols and next.`;

const HISTORY =
  "Daily (1d) or weekly (1wk) bars of one symbol, oldest first, each with its final flag and that date's signal row. from and to are YYYY-MM-DD; to defaults to the latest bar, from to 3 months before to for 1d and 2 years for 1wk. Prices are split-adjusted; averages and returns are on price, with dividends and FX conversion excluded. With a benchmark (any symbol, e.g. QQQ or ^GDAXI), it adds the 1- and 3-month return relative to it at to, in percentage points, naming both currencies. Symbols resolve and are fetched as in quote. When next is set, call again with the same arguments and next.";

const SEARCH =
  "Find instruments by name or symbol: stored ones and Yahoo's listings, each with its id, exchange, type and name, for quote or history. Fetches no prices. FRED series match only as FRED:<series id>.";

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
      name: "search",
      description: SEARCH,
      inputSchema: schema({ query: symbol, next }, ["query"]),
      run: async (input) => textResult(await searchPage(m, parseSearch(input))),
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
