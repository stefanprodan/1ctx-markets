// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { McpServer } from "@modelcontextprotocol/server";
import { INTRADAY_SESSIONS } from "../market/intraday.ts";
import {
  errorResult,
  type ToolResult,
  textResult,
} from "../operations/answer.ts";
import { ArgError } from "../operations/args.ts";
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
import { MAX_SYMBOLS, parseQuote, quotePage } from "../operations/quote.ts";
import { SINCE_DAYS } from "../operations/research.ts";
import {
  FIELD_NAMES,
  MAX_FIELDS,
  MAX_FILTERS,
  parseScreen,
  screenAnswer,
} from "../operations/screen.ts";
import { parseSearch, searchPage } from "../operations/search.ts";
import { type Access, NO_ACCESS, type Who } from "../operations/who.ts";
import { errorFields } from "../runtime/log.ts";
import { CallerGone } from "../server/caller.ts";
import {
  COT_WEEKS,
  HISTORY_WEEKS,
  POSITIONING_WEEKS,
} from "../sources/cftc/list.ts";
import { CALENDAR_AHEAD_DAYS } from "../sources/finnhub/store.ts";
import { CHAIN_BAND, SUMMARY_EXPIRIES } from "../sources/yahoo/options.ts";
import { alertsTools } from "./alerts.ts";
import { analysisTools } from "./analysis.ts";
import { portfolioTools } from "./portfolio.ts";
import { profileTools } from "./profile.ts";
import {
  parseResearch,
  RESEARCH_SECTIONS,
  researchAnswer,
} from "./research.ts";
import { day, next, schema, symbol, type Tool } from "./schema.ts";
import { tradePlansTools } from "./trade-plans.ts";

const quoteDescription = (m: Markets) =>
  `Live prices or FRED observations, returns and signals for 1 to ${MAX_SYMBOLS} symbols. Symbols: a stored id (US:NVDA), a Yahoo symbol (VVSM.DE, ^VIX), FRED:<series id> or a name; several listings answer candidates. A new one is fetched in ${m.callMs / 1000} s, else timeout: call again. Each item: price, previous close, change, day range, volume, trade_time, fetched_at, daily and weekly signals (live, close or final: averages, RSI, MACD, ATR, volatility, Bollinger, 52w range, drawdown, volume ratio), stale. returns: 1w, 1m, 3m, ytd, 1y percent (points for a yield) to the live price or last final close (live says which), null if too few bars. session: open or closed (regular; closed briefly at an open), start, end. benchmark (one symbol) adds relative_return_1m, _3m in percentage points. extended true adds extended: the last pre- or post-market price (change from the regular close), or null with extended_reason, and opens: the next regular start once known, while closed. FRED: last observation, price null. Errors are items.`;

const HISTORY = `Daily (1d) or weekly (1wk) bars of one symbol, oldest first, each with its final flag and that date's signal row. final stays false until the next session shows; a closed day's last bar holds the day's close, as quote's price does. to and from (YYYY-MM-DD) default to the latest bar and ${DEFAULT_MONTHS["1d"]} months before (1d) or ${DEFAULT_MONTHS["1wk"]} (1wk). Prices are split-adjusted; averages and returns exclude dividends and FX. A benchmark (any symbol, e.g. QQQ or ^GDAXI) adds the 1- and 3-month return relative to it at to, in percentage points (points for a yield or spread), naming both currencies. interval 5m: today's or the last ${INTRADAY_SESSIONS} sessions' 5-minute closes, regular hours, as fresh as the quote pass: points (at UTC, session date, close, final), each session's fetched_at, previous_close (a move's base); from and to are session dates, the newest stored by default; no signals or benchmark. extended true adds extended_points: pre- and post-market 5-minute closes while the session is closed, else none with extended_reason. Symbols as in quote.`;

const MOVERS = `The day's movers among 1 to ${MAX_SYMBOLS} symbols. min_move_pct (0 or more) is the live change from the previous close, in percent, with direction up, down or either (default). average (daily_sma50, daily_sma200, daily_ema20, weekly_sma50, weekly_sma200) with relation above or below compares the live price with it; crossed_up or crossed_down compares the last final close with the average then, and the live price with the average now. Give a move, an average or both; all given must hold. Matches come largest absolute change first. A symbol with a stale or missing quote or average is unavailable, never a match; a FRED series has no live quote and never moves. Symbols resolve and are fetched as in quote. Each page is a fresh view, so matches may shift.`;

const SCREEN = `Filter and rank 1 to ${MAX_SYMBOLS} symbols on their latest signals: the live row once the market traded today, else the last final. filters: at most ${MAX_FILTERS}, all must hold: {field, min, max} inclusive, either bound alone, or {field, eq: -1|0|1} for the cross, edge and turn states. field: one of the schema's list, the daily signals as quote names them, weekly_* ones, distance_* (percent from the price to an average), return_1w, _1m, _3m, _ytd, _1y (quote's returns) and relative_return_1m, _3m (need benchmark). fields: at most ${MAX_FIELDS} more shown on every row, null when missing. Price-level fields need one unit and currency across the symbols. A missing, null or stale input makes a symbol unavailable, never a match. sort: a field, order asc or desc; by id otherwise. Fetched as in quote; next continues a fresh view, which may shift.`;

const SEARCH =
  "Find instruments by name or symbol, each with its id, exchange, type and name, for quote or history. It searches stored ones, Yahoo's listings and, with the Bucharest feed on, the exchange's own. Fetches no prices. A FRED series not stored yet is found only as FRED:<series id>. CFTC futures markets (CFTC:<code>, name, latest_report) are for research's positioning only.";

const RESEARCH = `A symbol's research: a US share's fundamentals, filings and news, a fund's holdings, options, and a CFTC futures market's positioning. Sources: Finnhub, EDGAR (SEC), Massive (US ETFs' news too), Yahoo, CFTC. section overview: quote, signals as in quote, metrics (forward_pe, forward_peg, pe_ttm, ps_ttm, pb, beta; TTM: YoY EPS and revenue growth, net margin, ROE, dividend yield; quarterly: current ratio, debt/equity), ADR P/E, PEG, EPS per US share, analyst counts, earnings surprise, insider month (change, MSPR), next earnings, five headlines and filings, flags late_filing, restatement, offering, a fund's top_holdings, each with fetched_at, stale; a paired symbol's positioning pointer. analysts, earnings, insiders, filings, news: pages newest first. top_holdings: an ETF's or mutual fund's ten largest. options: the implied move, IV and open interest of the nearest expiries, or one expiry's chain near the money. positioning: futures positions by trader group; a CFTC id's overview is its latest week.`;

const RESEARCH_SECTION = `overview by default. analysts: monthly strong_buy, buy, hold, sell, strong_sell. earnings: eps_estimate, eps_actual, surprise, surprise_percent, revenue estimate, actual and surprise; a period is Finnhub's quarter label, not its report date, the first (newest) row the latest report, as in overview. insiders: monthly change (shares) and mspr. filings: SEC filings, late or restated, or securities offered: accession, form, accepted_at, filed, period, items (code, name), url; page one carries the flags. top_holdings (ETF, mutual fund): top (rank, symbol, id, name, weight_percent), assets split, sectors, bond_ratings. news: page one counts by sentiment; articles: published_at, title, publisher, url, sentiment (positive, neutral, negative, null), reasoning (attribute an article's figures to it). options: see expiry. positioning: see since.`;

const RESEARCH_SINCE = `news: the first day (YYYY-MM-DD UTC), up to ${SINCE_DAYS} days back; without it, all ${SINCE_DAYS} days kept. positioning: the first report date, ${POSITIONING_WEEKS} weeks back by default, at most ${HISTORY_WEEKS}, of CFTC:<code> (search finds one) or a symbol paired with one (its overview names it). Positions are as of each Tuesday, published days later, of the market named in cftc (id, name, exchange, report: disaggregated or financial), not the whole asset's. Page one has cot_index per group: the latest net in the range of its last ${HISTORY_WEEKS} weeks, 0 to 100, null under ${COT_WEEKS}; value null over a flat range. weeks, newest first: report_date, open_interest, per group (producer_merchant, swap_dealer, managed_money; dealer, asset_manager, leveraged_funds; other_reportable, non_reportable): long, short, spread, net, net_pct_oi, net_change, traders_long, traders_short. in_latest_report false: the market skipped latest_report. A consolidated market's figures are E-mini equivalents; its trader counts may count a trader in both contracts once.`;

const RESEARCH_EXPIRY = `options only: one listed expiry (YYYY-MM-DD), else its nearest are named. Both answer price (every figure is measured from it), price_at, currency. Without it: expiries, and summary rows of the nearest ${SUMMARY_EXPIRIES} and the earnings expiry (earnings true): expiry, days, atm_strike, call_iv, put_iv (percent a year), straddle (call plus put mid), implied_move_pct, put_call_oi, put_call_volume, top_call_oi, top_put_oi; a row not fetched in time has error. With it: strikes within band_pct (${CHAIN_BAND}, less when that many do not fit) of price, each a call and a put (null without one): bid, ask, mid (null for a crossed or empty quote), last, last_trade_at, volume, open_interest, iv (percent a year, Yahoo's, null when not usable), in_the_money. Open interest is the previous session's. Another source's symbol has none.`;

const EVENTS = `Earnings events dated from to to (YYYY-MM-DD, inclusive) of the tracked US shares, or of 1 to ${MAX_EVENT_SYMBOLS} symbols named, by date. Company events only: macro dates (central bank meetings, data releases, elections) are not here; look them up elsewhere. Each: fiscal_year, fiscal_quarter, date, hour (amc after close, bmo before open, or empty), status (scheduled; awaiting results once its date came without actuals; reported once EPS or revenue actuals are seen, with reported_seen_at), filed_at (the results 8-K's acceptance), EPS and revenue estimates and actuals (revenue in whole currency units), fetched_at, stale. Symbols resolve and are fetched as in quote; one Finnhub does not cover is listed as unavailable. A named share with nothing in the range is in no_event with the last stored event before from and the next after to (date, hour, status), so it is never read as missing data; a no_event next is null when none is within ${CALENDAR_AHEAD_DAYS} days of its last fetch.`;

// what a key's access opens; the tools it does not open are not listed
export type Opens = {
  portfolio: Access;
  alerts: Access;
  profile: Access;
  analysis: Access;
  tradePlans: Access;
};

const ALL: Opens = {
  portfolio: "write",
  alerts: "write",
  profile: "write",
  analysis: "write",
  tradePlans: "write",
};

export function tools(m: Markets, opens: Opens = ALL): Tool[] {
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
      run: async (input, who) =>
        textResult(
          await quotePage(m, parseQuote(input), undefined, who ?? NO_ACCESS),
        ),
    },
    {
      name: "history",
      description: HISTORY,
      inputSchema: schema(
        {
          symbol: {
            ...symbol,
            description:
              "a fund's key (fund:<ISIN>) answers its entered prices as closes, one per priced day, a week's last for 1wk; no 5m",
          },
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
      run: (input, who) =>
        historyAnswer(m, parseHistory(input), who ?? NO_ACCESS),
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
          symbol: {
            ...symbol,
            description:
              "a fund's key (fund:<ISIN>) answers top_holdings only, as entered, with as_of and sectors_as_of; CFTC:<code>, a futures market, overview and positioning",
          },
          section: {
            type: "string",
            enum: [...RESEARCH_SECTIONS],
            default: "overview",
            description: RESEARCH_SECTION,
          },
          since: { ...day, description: RESEARCH_SINCE },
          expiry: { ...day, description: RESEARCH_EXPIRY },
          next,
        },
        ["symbol"],
      ),
      run: (input, who) =>
        researchAnswer(m, parseResearch(input), who ?? NO_ACCESS),
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
    ...alertsTools(m, opens.alerts),
    ...portfolioTools(m, opens.portfolio),
    ...profileTools(m, opens.profile),
    ...analysisTools(m, opens.analysis),
    ...tradePlansTools(m, opens.tradePlans),
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
    // the key went mid-call, so the write wrote nothing
    if (error instanceof CallerGone) {
      m.log.info("tool call", { tool: tool.name, status: "refused" });
      return errorResult({
        error: error.status === 401 ? "unauthorized" : "forbidden",
        message: error.message,
      });
    }
    m.log.error("tool call", { tool: tool.name, ...errorFields(error) });
    return errorResult({ error: "internal", message: "internal error" });
  }
}

// built once per access, registered on each request's server instance
export function registerTools(
  m: Markets,
): (server: McpServer, who: Who) => void {
  const lists = new Map<string, Tool[]>();
  return (server, who) => {
    const key = `${who.portfolio}/${who.alerts}/${who.profile}/${who.analysis}/${who.tradePlans}`;
    let list = lists.get(key);
    if (list === undefined) {
      list = tools(m, {
        portfolio: who.portfolio,
        alerts: who.alerts,
        profile: who.profile,
        analysis: who.analysis,
        tradePlans: who.tradePlans,
      });
      lists.set(key, list);
    }
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
