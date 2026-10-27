// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The server's instructions: the one text a client keeps whole for every
// server on every turn, where a tool description is cut or listed short.

// Clients cut long instructions from the end, so the cap keeps a new
// line from pushing an old one out unseen.
export const INSTRUCTIONS_BYTES = 4096;

// Most important first, what the server lacks last: a cut drops the least.
export const INSTRUCTIONS = `Market data and price rules. Which tool answers what:
- Prices now, and how a symbol did over a week, a month, three months or the year: \`quote\`, whose \`returns\` hold those periods and \`session\` whether its market is open; \`benchmark\` adds relative strength. Not \`history\`.
- Bars, a chart's data or a custom date range: \`history\`.
- Many symbols at once: \`movers\` for today's moves and average crossings, \`screen\` to filter and rank on signals and returns, with \`fields\` for more columns than the ones filtered or sorted on.
- A US share's fundamentals, analysts, earnings, insiders and news: \`research\`, for the few symbols that matter. For news, \`section\` news with \`since\` keeps to a recent window; read its \`counts\` by sentiment before the articles.
- Earnings dates: \`events\`. A named share under \`no_event\` had no earnings in the window: that is an answer, not missing data.
- A level to be told about later: \`rules\`, rather than asking again by hand.
- An unknown or ambiguous name: \`search\`.
Answer from these tools, not the server's HTTP endpoints, and never recompute an average or return a tool already gives.

Missing is not false: a \`stale\` reason, \`unavailable\`, "no data" or a null field means the value is missing, never that a condition failed or a figure is zero. Research covers US shares; a section answered from another listing names it in \`listing\` and leaves out per-share figures.

Symbols: Yahoo's forms (AAPL, VWCE.DE, BTC-USD, EURUSD=X), FRED:<series id>, or a market:symbol id as answers give it; \`search\` when unsure. An unknown symbol is fetched inside the call.

Live prices: a quote is the live price while its market is open, and the day's close after. Signals and \`returns\` already count today's price. Say whether a price is live or a close; never warn that a live price is not a close. \`session\` can read closed for the first minutes of a session, until the source reports it.

Freshness: answers carry \`fetched_at\`; read it before calling a figure current. Research refreshes once a day after the US close, a share's results are looked for hourly on its report day and the day after, news every 30 minutes.

Units: prices are in the listing's own \`currency\`. A series in percent (a yield, a spread) moves in points, not percent; \`unit\` says which.

Paging: an answer with \`next\` continues with the same arguments and \`next\`; never change the arguments to avoid a page.

What this server does not hold, so look elsewhere and never read its silence as none: macro dates (central banks, data releases, elections), ETF constituents, prices of funds Yahoo does not list, options, and analyst estimate revisions.`;
