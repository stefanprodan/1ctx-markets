# Where the facts come from

The MCP tools give prices, ten years of history, signals, and for US shares
fundamentals, analysts, earnings dates, SEC filings and news, each only when
the server has that source on. A fund's ten largest holdings, asset split and
sectors come from `research` `top_holdings` on any exchange.

The server does not hold these by design, so go to the web and never read its
silence as none: guidance history, segment data, a fund's holdings past its
ten largest, its fees, replication and tracking, macro dates (central banks,
data releases, elections), analyst estimate revisions, and most fundamentals
of a share listed outside the US.

Primary sources come first. Aggregators (stock screeners, fund comparison
sites, investing blogs, brokers' research pages) are leads, and their figures
count as coverage until checked.

| Section | A US SEC filer | Any other issuer |
|---|---|---|
| Business, segments, customers | 10-K or 20-F Item 1, the segment note, the latest results release; segment changes in 8-Ks | the annual report (business review, segment note), the latest results release and presentation |
| Guidance record | 8-K item 2.02 and its Exhibit 99.1, one per report; call-only guidance from a transcript, tagged coverage | results releases and presentations on the IR site; the home exchange's announcements; call-only guidance tagged coverage |
| Report dates | `events`; past dates from the 8-K item 2.02 filings in `research` `filings` | the IR financial calendar; the home exchange's issuer calendar |
| Capital | 10-Q and 10-K (debt, commitments, guarantees, leases not yet started); 424B2, 424B5 and FWP for every equity and debt raise; S-3ASR shelves; buyback 8-Ks | annual and interim reports; prospectuses and bond offering documents; the home exchange's and regulator's announcements of issues and buybacks |
| Dated events | DEF 14A/14C (meetings, charter changes, stock dividends); 424B4 (IPO lock-ups); IR calendars | meeting notices and resolutions on the IR site or the home exchange; IPO prospectus (lock-ups) |
| Depositary receipts | 20-F and 6-K on EDGAR; F-1 or 424B4 for the terms | the home filings above, for the underlying share |
| ETFs and funds | issuer factsheet and prospectus; annual report (tracking difference); the index provider's methodology | the same, by domicile: key information document, prospectus, annual and semi-annual reports; the index provider's methodology (caps, rebalance and reconstitution dates) |
| A regional exchange | | the exchange's own site: index weights, issuer calendars, filings and fund reports it publishes |
| Events and context | Reuters, Bloomberg, FT, WSJ, AP and the main business press of the issuer's country | the same |

Filings come from the issuer's market: a US filer's from SEC EDGAR (the
server's `research` `filings`, then sec.gov for the documents and the forms
it leaves out), any other issuer's from its annual report, its home exchange
or securities regulator, and its investor-relations site. A foreign issuer
that also files with the SEC has both.

Cite inline, beside the figure: publisher, document, its date and the period
it covers. A URL only for a page a search would not find again (canonical, no
tracking query strings), never for a filing `research` `filings` links.
