// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// The one text a client keeps whole each turn; tool descriptions get cut.

import type { Access } from "../operations/who.ts";

// clients cut from the end, so the cap stops a new line pushing an old one out
export const INSTRUCTIONS_BYTES = 4096;

const HOLDINGS_LINE = `
- What the owner holds or trades ("my stocks", "my ETF", "my portfolio"): \`portfolio\` holdings first, then its symbols to \`quote\`, \`history\`, \`research\`; never guess a symbol. All cash is in Cash; across portfolios reserve counts only in net worth. Amounts keep their currency; never assume one, ask or say it.`;

// the line per the key's portfolio access, cut to fit the cap
const PORTFOLIO_LINE: Record<Access, string> = {
  none: "",
  read: HOLDINGS_LINE,
  write: `${HOLDINGS_LINE} Writes: \`portfolio_trade\`, \`portfolio_cash\`, \`portfolio_bond\`, \`portfolio_fund\`; with no portfolio yet, \`portfolio_setup\` makes one.`,
};

const ALERTS_LINE = `
- A level to watch, how close an alert is, or what triggered: \`alerts\``;

// the line per the key's alerts access
const ALERTS: Record<Access, string> = {
  none: "",
  read: `${ALERTS_LINE}.`,
  write: `${ALERTS_LINE}; \`alerts_edit\` sets them.`,
};

// profile_edit is named by profile's own description, for want of room here
const PROFILE_LINE = `
- How the owner invests (goals, risk, trading style, rules): \`profile\`, read before any work on their portfolio.`;

// a key without analysis access never sees the tool
const ANALYSIS_LINE = `
- A view or take on a symbol, not a price or move: \`analysis\` read first (a dated note, not a document), then \`quote\` and \`research\` for what changed.`;

// Most important first, what the server lacks last: a cut drops the least.
// Only the tools the key lists are named.
export const instructions = (opens: {
  portfolio: Access;
  alerts: Access;
  profile: Access;
  analysis: Access;
}): string => `Market data, price alerts and portfolios. Which tool answers what:
- Prices now, and how a symbol did over 1w, 1m, 3m, ytd or 1y: \`quote\`, whose \`returns\` hold those periods and \`session\` whether its market is open; \`benchmark\` adds relative strength. The benchmark's own returns come from quoting it too, never from the relative figures.${opens.analysis === "none" ? "" : ANALYSIS_LINE}
- A US share's move before the open or after the close: \`quote\` with \`extended\` (null: see \`extended_reason\`); it never drives an alert or signal.
- Bars, a chart's data or any period: \`history\`; its last daily bar's \`final\` turns true only once the next session shows. How a symbol moved today or over the last five sessions: \`history\` with \`interval\` 5m, regular-hours closes as fresh as quotes, a move measured from its \`previous_close\`; \`extended\` adds pre- and post-market closes while closed.
- Many symbols at once: \`movers\` for today's moves and average crossings, \`screen\` to filter and rank on signals and returns, \`fields\` adding columns.
- A US share's fundamentals, analysts, earnings, insiders and news, or a US ETF's news: \`research\`, for the few symbols that matter. For news, \`section\` news with \`since\` keeps to a recent window; read its \`counts\` by sentiment before the articles.
- A US share's SEC filings, late or restated, or securities offered: \`research\`, \`section\` filings; its overview carries the flags.
- What an ETF or fund holds: \`research\`, \`section\` top_holdings.
- Earnings dates: \`events\`. A named share under \`no_event\` had no earnings in the window: that is an answer, not missing data.${ALERTS[opens.alerts]}${opens.profile === "none" ? "" : PROFILE_LINE}${PORTFOLIO_LINE[opens.portfolio]}
- An unknown or ambiguous name: \`search\`.
Answer from these tools, not the HTTP API, and never recompute an average or return a tool already gives.

Missing is not false: \`unavailable\`, "no data" or a null field means the value is missing, never that a condition failed or a figure is zero. A \`stale\` reason says why a figure is missing or old; give it with the figure. A section answered from another listing names it in \`listing\`; a foreign one leaves out per-share figures, and \`valuation\` gives them per US share.

Symbols: Yahoo's forms (AAPL, VWCE.DE, BTC-USD, EURUSD=X), FRED:<series id>, a market:symbol id as answers give it, or a regional source's own codes while that source is on. An unknown symbol is fetched inside the call.

Live prices: a quote is the live price while its market is open, and the day's close after. Signals and \`returns\` already count today's price. Say whether a price is live or a close; never warn that a live price is not a close.

Freshness: answers carry \`fetched_at\`; read it before calling a figure current. Research refreshes daily, earnings around a share's report date, news through the day.

Units: prices are in the listing's own \`currency\`. A series whose \`unit\` is percent (a yield, a spread) moves in points, not percent; an index is in points (^TNX: its yield in percent); unknown means not known.

Paging: never change the arguments to avoid a page.

What this server does not hold, so look elsewhere and never read its silence as none: macro dates (central banks, data releases, elections), a fund's holdings past its ten largest or its fees and replication, prices of funds Yahoo does not list${opens.portfolio === "none" ? "" : " (`portfolio` holds hand-priced ones)"}, options, and analyst estimate revisions.`;
