// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// The one text a client keeps whole each turn; tool descriptions get cut.

// clients cut from the end, so the cap stops a new line pushing an old one out
export const INSTRUCTIONS_BYTES = 4096;

// Most important first, what the server lacks last: a cut drops the least.
export const INSTRUCTIONS = `Market data, price rules and portfolios. Which tool answers what:
- Prices now, and how a symbol did over a week, a month, three months or the year so far (ytd): \`quote\`, whose \`returns\` hold those periods and \`session\` whether its market is open; \`benchmark\` adds relative strength. The benchmark's own returns come from quoting it too, never from the relative figures.
- A US share's move before the open or after the close: \`quote\` with \`extended\`; a null \`extended\` gives its reason in \`stale\`, and it never drives a rule or signal.
- Bars, a chart's data, a full year or any other period: \`history\`; its last bar's \`final\` is false while its market is open. How a symbol moved today or over the last five sessions: \`history\` with \`interval\` 5m, regular-hours closes as fresh as the quote pass, a move measured from its \`previous_close\`; \`extended\` adds the pre- and post-market closes while the session is closed.
- Many symbols at once: \`movers\` for today's moves and average crossings, \`screen\` to filter and rank on signals and returns, with \`fields\` for columns beyond those filtered or sorted on.
- A US share's fundamentals, analysts, earnings, insiders and news, or a US ETF's news: \`research\`, for the few symbols that matter. For news, \`section\` news with \`since\` keeps to a recent window; read its \`counts\` by sentiment before the articles.
- A US share's SEC filings, late filings, restatements or new securities registered or offered: \`research\`, \`section\` filings; its overview carries the flags.
- What an ETF or fund holds: \`research\`, \`section\` top_holdings, its ten largest and sectors.
- Earnings dates: \`events\`. A named share under \`no_event\` had no earnings in the window: that is an answer, not missing data.
- A level to be told about later: \`rules\`, rather than asking again by hand.
- The owner's trades, holdings and cash, and any question on what they hold ("my stocks", "my ETF", "my portfolio", a portfolio they name): \`portfolio\` holdings first, then its symbols to \`quote\`, \`history\` and \`research\`; never guess a symbol. All cash is in Cash; across portfolios reserve counts only in net worth. Amounts stay in their own currency; never assume one, ask or say it. With no portfolio yet, \`portfolio\` setup makes one.
- An unknown or ambiguous name: \`search\`.
Answer from these tools, not the HTTP API, and never recompute an average or return a tool already gives.

Missing is not false: a \`stale\` reason, \`unavailable\`, "no data" or a null field means the value is missing, never that a condition failed or a figure is zero. Research covers US shares, news US ETFs too, top holdings any fund; a section answered from another listing names it in \`listing\`; a foreign one leaves out per-share figures, and \`valuation\` gives them per US share.

Symbols: Yahoo's forms (AAPL, VWCE.DE, BTC-USD, EURUSD=X), FRED:<series id>, a market:symbol id as answers give it, or a regional source's own codes while that source is on; \`search\` when unsure. An unknown symbol is fetched inside the call.

Live prices: a quote is the live price while its market is open, and the day's close after. Signals and \`returns\` already count today's price. Say whether a price is live or a close; never warn that a live price is not a close. \`session\` can read closed in a session's first minutes.

Freshness: answers carry \`fetched_at\`; read it before calling a figure current. Research refreshes daily after the US close, earnings around a share's report date, news through the day.

Units: prices are in the listing's own \`currency\`. A series whose \`unit\` is percent (a yield, a spread) moves in points, not percent; an index is in points, a yield index's (^TNX) being its yield in percent; unknown means not known.

Paging: never change the arguments to avoid a page.

What this server does not hold, so look elsewhere and never read its silence as none: macro dates (central banks, data releases, elections), a fund's holdings past its ten largest, prices of funds Yahoo does not list (but \`portfolio\` holds the owner's hand-priced ones), options, and analyst estimate revisions.`;
