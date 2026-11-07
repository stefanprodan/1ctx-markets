# Research, events and news

Governs Finnhub's research and earnings events
(`src/sources/finnhub/*`), Massive's news (`src/sources/massive/*`),
the `research` and `events` tools and the research route's contents
(`src/tools/research.ts`, `src/operations/research.ts`,
`src/operations/events.ts`), an ADR's `valuation`
(`src/sources/yahoo/valuation.ts`), a fund's `top_holdings`
(`src/sources/yahoo/top-holdings.ts`), `options`
(`src/sources/yahoo/options.ts`, `src/operations/options.ts`), and the
`research`, `events`, `news`, `news_walks`, `valuations` and fund
tables (`src/storage/db/migrations/0007-research.ts`, `0008-news.ts`,
`0012-listing.ts`, `0028-share-class-listing.ts`,
`0029-valuations.ts`, `0030-fund-top-holdings.ts`,
`0042-earnings-fiscal.ts`). Yahoo's quote
summary call, its session, what a fund's answer keeps and how a chain
is read are in `docs/yahoo.md`. EDGAR's filings,
their flags and events' `filed_at` are in `docs/edgar.md`; the
sections that answer them are here. The queue, deadlines, retries, phrases, scrubbing
and the lock every source shares are in `docs/sources.md`; resolution,
tracking and the answer contract in `docs/tools.md`; the research
route's transport in `docs/api.md`; alerts that wait on events in
`docs/alerts.md`; runs and retention in `docs/storage.md`.

## Keys

- **Each source is on only while its key file exists**
  (`secrets/source-finnhub.key`, `secrets/source-massive.key`); off is
  an answer, never an error: `NO_DATA`, `NO_EVENTS` ("no event
  source") or `NO_NEWS`.
- **Keys travel only in a header, never in a URL**: Finnhub's
  `X-Finnhub-Token`, Massive's `Authorization: Bearer`. A URL ends up
  in errors and logs; a header does not.
- **Every Massive text kept is scrubbed of the key** (`scrubbed` in
  `src/sources/massive/client.ts`: id, title, URL, publisher, tickers,
  reasoning), before a text is cut to its cap, so a key across the cap
  leaves no prefix. Finnhub keeps only numbers, checked dates and an
  hour label matching `^[a-z]{0,8}$`, so nothing of its answer can
  carry text.
- **A Massive `next_url` is followed only when it is Massive's own news
  path** (`checkCursor`): https, the same origin, `NEWS_PATH`, no user
  or password, no key-named parameter, and the key in no decoding of
  it. It is checked on receipt and before it is sent, and never
  rewritten, because it goes out with the key in its header.
- **A Massive page without `status: "OK"` is malformed** (`parseNews`),
  never an empty last page that would end a history walk.

## Eligibility

- **Finnhub is asked only for US shares** (`eligible`: market `US`,
  type `EQUITY`); its free key covers nothing else, and ETFs, indices,
  futures, FX, crypto and FRED answer nothing useful. Others get
  `NOT_COVERED`.
- **Massive is asked for US shares and ETFs** (market `US`, type
  `EQUITY` or `ETF`); others get `NEWS_NOT_COVERED`.
- **A class share is `BRK-B` on Yahoo, `BRK.B` on Finnhub and
  Massive** (`finnhubSymbol`, `massiveSymbol`).
- **Scheduled work covers tracked instruments only**
  (`trackedInstruments`: read within the tracking window or held by a
  rule).

## Limits and budgets

- **Each source is a limiter** (`docs/sources.md`) whose `SPACING_MS`
  fits its free key: 1.1 s for Finnhub (60 calls a minute) and 13 s
  for Massive (5 a minute, with no rate-limit headers to read).
- **Finnhub answers a 400 as "source error", which backs off;**
  Massive's 400 is "bad request", which does not.
- **A minute tick starts no new instrument after its budget**
  (`TICK_BUDGET_MS`: 45 s Finnhub, 30 s Massive), and Massive no new
  page; work already started finishes, so a tick can run past it. A
  tick that finds the last one still running is skipped
  (`src/runtime/scheduler.ts`); cut work goes on next tick.
- **A tool fetches inside its own deadline** (`researchTargets`,
  `m.callMs`) the sections it reads that have no good run (`unfetched`),
  so a pass cut short is finished by the next call that needs what it
  left: `events` and a rule's earnings gate the calendar only (one call
  per share), the `research` overview all five and the research route
  those its `sections` ask, a history section its own (`SECTIONS_OF`).
  For the `overview` and `news` sections only, a covered instrument
  never asked for news gets one page; for `overview` and `filings`, and
  the route's `filings`, a US share never fetched from EDGAR gets its
  filings, the ticker map first when none is stored. The rest come with
  the jobs. Events' `filed_at` reads stored filings only, so it fills
  once the share's filings were fetched, by the daily pass or a research
  call: `events` and the earnings route never call SEC, since one call
  can name 100 symbols. Concurrent calls naming one instrument and
  sections share one fetch (`shared`); the sections are checked again
  inside the instrument's lock, so a call that waited asks none another
  stored. A deadline that passes stores nothing.

## Finnhub sections

| Section | Asked | Stored |
| --- | --- | --- |
| `metric` | `stock/metric` | one row per instrument, replaced, dated by its fetch |
| `analysts` | `stock/recommendation` | one row per period |
| `earnings` | `stock/earnings` | one row per period, with its fiscal year and quarter; actual and surprise once seen are kept |
| `insider` | `stock/insider-sentiment`, the last 12 months | one row per month |
| `calendar` | `calendar/earnings`, asked 120 days back (`CALENDAR_BACK_DAYS`, since asking further costs nothing), answered about a month back, to 90 ahead | `events` |

- **The calendar's past reaches about a month, whatever is asked**:
  Finnhub's free answer holds about a month of past reports (a server
  tracking 54 shares held none older than 30 days), so a quarter
  reported before that has no event.
- **The daily refresh is due after 23:00 UTC** (`dueAt`, after the US
  close and after-market reports). A section failed within `RETRY_MS`
  (Finnhub's own, in `jobs.ts`) waits.
- **Each section records its own run, scoped to the instrument**, so
  one failing section is stale alone. The sections fetched land in one
  write, failures as their own runs; a `Paused` refusal stores the
  sections fetched before it, and a passed deadline stores none.
- **An earnings row's `period` is not its quarter's end.** For a
  company whose fiscal quarters are offset, Finnhub labels a row with
  the calendar quarter after it: NVDA's 2026-09-30 row is fiscal 2027
  Q2, reported 2026-08-26. Each row's fiscal `year` and `quarter` are
  the key its calendar event has, and are kept with it. A period
  answered under two fiscal quarters, or a quarter under two periods
  in one answer (NVDA's 2026-06-30 comes as both 2027 Q1 and 2026 Q1),
  keeps none: either may be wrong.
- **An earnings row whose period ends after its fetch's UTC date is
  stored only when the share's event of the same fiscal quarter has
  reported** (actuals seen on or before that date); otherwise it is not
  stored nor counted in the run's rows, never an error or a stale mark.
  Finnhub once labelled a fresh report a later quarter for a night
  (MSFT's fiscal 2027 Q1 as 2027-03-31, then 2026-09-30), a row that
  would stay as the newest, since rows are kept per period. So a row
  stored with a fiscal quarter deletes the share's other earnings rows
  of that quarter under another period, first taking from them an
  actual or surprise it lacks, as actuals once seen are kept. Kept
  figures stay only within one fiscal quarter: a period stored again
  under another quarter, or first labelled, takes the answer's figures
  whole. Migration `0027-earnings-ahead` deleted the rows ahead stored
  before.
- **A Finnhub 403 or an empty answer is no data, never an error**: the
  stored rows stay and the section reads "no data in the last answer";
  with no rows stored it carries `NO_DATA` ("no data from Finnhub")
  instead (`hasRows` in `sectionState`). A 401 is "key refused", a 404
  "not found", a 429 "rate limited", any other status "source error"
  (`src/sources/finnhub/client.ts`); any other shape is "malformed
  answer".
- **An answer whose every part names one other symbol is that
  listing's** (`listingOf`): an ADR is answered as its home listing,
  its EPS in that listing's currency per local share. Only what holds
  for any listing of the company is kept, with `listing` set to that
  symbol:

  | Section | Kept from another listing | Why the rest goes |
  | --- | --- | --- |
  | `analysts` | every count | |
  | `metric` | `COMPANY_METRICS`: growth, net margin, ROE, current ratio, debt to equity | P/E, PEG, P/S, P/B, yield and beta are on that listing's price |
  | `earnings` | nothing: no data | EPS in its currency per its share; its actuals and estimates can disagree |
  | `insider` | nothing: no data | share counts of its shares |
  | `calendar` | date, hour, fiscal year (1900 to 2200, as stored) and quarter, and whether actuals came | estimates and actuals in its currency |

  A listing with no `.` is another US share class of the company
  (`shareClass`; GOOG answered as GOOGL): equal shares in the same
  currency, so every section keeps what the asked symbol's own answer
  would, but `insider` (share counts of the other class), with `listing`
  set and the note `SHARE_CLASS`. Finnhub dots foreign listings
  (`2330.TW`) and class letters (`BRK.B`), whose per-share figures can
  differ; both keep the table above. The tables' checks hold the same split (`0028`).

  A part naming no symbol is the asked one's. Parts naming two symbols
  are no data, as a 403 is, since neither can be trusted; a symbol not
  1 to 20 letters, digits, `.` or `-` is "malformed answer". A metric
  left with nothing is no data.
- **A share whose stored `metric` names a dotted listing gets its
  valuation from Yahoo** (`covered()`, `docs/yahoo.md`, "The quote
  summary"): `valuation`, its own object beside Finnhub's, whose
  `metric` keeps its listing-bound fields null, so two sources never
  fill one field. Yahoo's EPS is per US share in the share's currency.
  `valuation` holds `source` (`yahoo`), `fetched_at`, `stale`,
  `currency`, `pe_ttm`, `forward_pe`, `forward_peg`, `eps_ttm`,
  `eps_forward` and `note` (`PER_US_SHARE`). A share Finnhub answers as
  itself or as another US class has no `valuation`.
  - **P/E is worked out at answer time**: the stored quote's price
    (`readQuote()`, the overview quote's) over the stored EPS, so it
    follows the live price. An EPS of zero or below, a missing price or
    a row in another currency than the instrument's gives null, as an
    exchange leaves P/E blank for a loss. `forward_peg` is Yahoo's, as
    stored. A P/E on a price `quoteStale()` gives reasons for carries
    them in `stale`, prefixed `quote: `, since the route has no quote
    beside it.
  - **Fetched once a day after the research refresh**, and inside a
    `research` overview or a route call with `metric` for a share whose
    valuation never ran well, after its Finnhub sections, which say
    whether its listing is foreign (`researchTargets`). Whether it is
    due is read again inside the share's lock, so a call and the job
    that waited on it ask once. A failure keeps the stored row; the
    inline failure is the valuation's, carried as `error` and `message`
    in it, a `not_found` saying Yahoo has no valuation for the share
    (`NO_VALUATION`), since the share itself is quoted.
  - **Stale reasons are research's** (`valuationState`,
    `STALE_RESEARCH`), on the same 23:00 UTC schedule: "no research
    yet", "research sync failed", "research sync pending".
  - **Cost: one call a day per such share**, few (US listings of
    foreign companies Finnhub answers from home), plus two calls for
    the session on first use after a start and on each refusal.
- **An answer naming a listing replaces the kind's rows of any other**
  (`storeSection`), its own included, even when it keeps nothing, so no
  figure of one listing is read as another's; an event a rule waits on
  stays, as retention keeps it. A 403 or an empty answer names none
  and replaces nothing.
- **A Massive 403 is "key refused", like its 401**
  (`src/sources/massive/client.ts`): unlike Finnhub's, it is never no
  data.
- **A key answered twice with the same values is one row**; with
  different values the section is refused (`collapse`), since either
  could be wrong.
- **Stale reasons per section** (`sectionState`, `STALE_RESEARCH`): "no
  research yet", "research sync failed", "research sync pending" (no
  good run since the latest 23:00 UTC, `dueAt`), "no data in the last
  answer".

## Earnings events

- **An event is keyed by fiscal year and quarter, never by date**, so a
  moved date updates the event instead of adding one.
- **Only actuals confirm an event.** `reported_seen_at` is set the first
  time an EPS or revenue actual appears and never moves, also for
  a foreign listing, whose actuals are not stored; actuals once seen are
  kept when a later answer of the same listing omits them. `eventStatus`
  is "reported" only then, else "scheduled" when the date is after the
  exchange's today, else "awaiting results". A passed date or an
  after-close label never reports it: results can slip, and a rule
  waiting on the report would fire before the numbers exist.
- **The first sighting calls `hooks.reported` inside the same write**,
  so rules waiting on the event see it atomically.
- **A tracked share reporting yesterday or today is refreshed hourly
  from one whole-market call** (`market` and `reportingWindow` in
  `src/sources/finnhub/jobs.ts`, `storeMarketCalendar` in `sync.ts`),
  rule or not: a reader needs the new quarter on the report date, and
  the 23:00 UTC refresh can come before Finnhub posts an after-close
  actual. While any tracked eligible share has an unreported stored
  event of its own listing dated its exchange's yesterday or today
  (`localDate`, `windowEvents`), the job asks `calendar/earnings` from
  yesterday to today with no symbol, at most once every
  `MARKET_EVERY_MS` (60 minutes), a failure waiting `RETRY_MS`.
  Yesterday too, since many reporters have no actuals a day later. Its
  run is `market-calendar` scoped to `US` (`MARKET_CALENDAR`), never an
  instrument.
- **An event row keeps the newest answer** (`upsertEvents`): a share's
  research pass and the whole-market calendar fetch apart and write in
  either order, so an answer fetched before the stored one is skipped.
- **The whole-market answer only updates events already stored** of
  tracked shares' own listing, matched by `finnhubSymbol`, fiscal year
  and quarter, through the write a share's calendar uses, so a first
  sighting calls `hooks.reported` in it. A matched row writes its date
  and hour too, so a quarter moved within the range is moved. A row of
  another symbol or quarter is ignored and learns no instrument; a
  missing row deletes or moves nothing, since the list changes between
  calls; the daily per-symbol calendar stays the source for new events
  and listings. A symbol whose rows are malformed or conflict is left
  out alone (`parseMarketCalendar`).
- **An unreported event of another listing in the same window is asked
  by the share's own calendar hourly** (`otherListings`): the market
  pass updates only a share's own events (`storeMarketCalendar`), so
  another listing's is not counted for the market call.
  These are few: US listings of foreign companies, and share classes;
  spaced by the
  share's last `calendar` run (`MARKET_EVERY_MS`) and `RETRY_MS`.
- **A share whose event in the window was seen reported after its last
  good `earnings` run started is asked its `earnings`**
  (`sightedEarnings`), so its surprises carry the new quarter the same
  hour. It is read from stored state, so shares a tick's budget cut are
  asked on the next tick. A pass asks `calendar` before the other
  sections (`refreshResearch`), so earnings asked with it start after
  any report the calendar first sees and are not asked again.
- **Cost: one call an hour while any tracked share is in its window,
  plus one per report**, and one an hour per share whose event is of
  another listing, however many shares are tracked; asking each
  reporting share by symbol would be one call an hour per share.
  The answer is US listings only and uncut.
- **An earnings row carries its quarter's revenue from `events`**
  (`revenue_estimate`, `revenue_actual`, `revenue_surprise_percent`:
  (actual − estimate) / |estimate| × 100), read at answer time, nothing
  stored: Finnhub's earnings hold EPS only, and an EPS beat can be a
  revenue miss. The event is the share's own with actuals and the
  row's fiscal year and quarter (`reportOf`), never matched by date,
  which hands an offset quarter the next one's report; none, or a
  missing figure, is null, and so is a row without a fiscal quarter.
  Rows stored before the fiscal quarter was kept (`0042`) carry none
  until the share's next earnings refresh labels them. Only quarters whose report the calendar still holds carry
  revenue, in practice the newest reported one.
  A foreign listing has no earnings rows and its events no figures; a
  share class has both, so its rows carry revenue as the share's own.
- **The next event is the earliest dated from the exchange's today, or
  one up to `AWAITING_DAYS` (7) past still awaiting results**
  (`nextEvent`).
- **The `events` tool lists events between two dates** of the tracked
  US shares, or of the named symbols once resolved; of those, only a
  named covered share whose calendar has no good run is fetched
  inline; a section that fails there is the share's error, never an
  empty answer. A symbol not covered or not resolved is listed under
  `unavailable`, and so is every share whose calendar has no good run,
  with why (never fetched, its fetch failed, timed out), and every
  share whose last good calendar run was no data (`NO_DATA`), its
  kept events still shown, so an empty list means no earnings in the
  range. A failed fetch is listed there too, while its stored events
  still show. The list is capped at 8 KiB with the rest counted, and
  appears on the first page only (`src/operations/events.ts`).
- **A named share with a calendar and nothing in the range is listed
  under `no_event`**, so an empty answer for it is never read as
  missing data: `input`, `id`, `last` (the newest stored event before
  `from`) and `next` (the first after `to`), each `date`, `hour` and
  `status`, or null. Actuals stay out, one `research` call away, so 100
  shares stay small. A share under `unavailable` is not repeated, and
  without `symbols` the list is left out, since most tracked shares
  have nothing in a short range. It has its own byte share
  (`NO_EVENT_BYTES`, the size of `UNAVAILABLE_BYTES`, through
  `capNotes()`), the rest counted in `no_event_more`, first page only.
- **A null `next` means none within `CALENDAR_AHEAD_DAYS` (90) of the
  last calendar fetch, never no next event**: the calendar is asked
  only that far ahead. The description interpolates the number.
- **Events are company events only.** The description says macro
  dates (central bank meetings, data releases, elections) are not in
  it, so an agent looks them up elsewhere rather than reading an empty
  answer as none; the server keeps no macro calendar.

## News

- **Every 30 minutes each tracked ticker's news is walked newest first**
  (`EVERY_MS`, `refreshNews`), longest waiting first, at most
  `MAX_PAGES` (3) pages a run. One run is one write and one run row
  scoped to the instrument; a failed page fails the run with the pages
  before it kept.
- **An unfinished walk resumes from Massive's own cursor, stored in
  `news_walks`**, never from a timestamp, so articles tied at a page
  edge are never skipped. The `top` walk keeps its floor (`after`); the
  `history` walk runs down to 30 days back.
- **The first fetch walks 30 days back; what it leaves is the
  history.** A later run gives an unfinished history one page first,
  finishes a cut `top` walk, starts a new one from the newest stored
  article less `OVERLAP_MS` (2 hours, for articles published late with
  an earlier time) only when none was resumed, then gives the history
  the pages left.
- **A cursor Massive answers 404 or 400 for is expired**: the walk
  starts again from the newest article, never retries it.
- **An article is kept for a ticker only on an exact match** in its
  insights or ticker list (`rowFor`), so `JPMpC` is never `JPM`. Each
  row keeps that ticker's own sentiment and reasoning; a word outside
  positive, neutral, negative is no sentiment, never neutral, and drops
  the reasoning.
- **Text is bounded so an article always fits an answer**: title and
  publisher 300 characters, reasoning 1,000, cut with an ellipsis and
  `truncated` set; a URL must be http or https and at most 2,000
  characters, an id at most 200, else the answer is malformed.
- **Rows are one per article and instrument, deduplicated by id.**
- **Stale reasons** (`newsState`, `STALE_NEWS`): "no news yet", "news
  sync failed", "news sync pending" (no good run for two periods),
  "older news pending" (a walk not finished).
- **Counts are by the ticker's own sentiment** (`countNews`):
  `positive`, `neutral`, `negative`, and `unknown` for an article
  with none, over the same 30 days the reads keep.
- **A summary's items take a side first** (`topNews`): positive and
  negative newest first, then neutral, then no sentiment. A neutral
  article is most often a passing mention of the ticker in another
  company's story, so the ones that take a side say more per byte.

## Answers

- **The `research` tool's sections** are `overview` (quote, for a key
  with analysis access `analysis`, the symbol's note's revision and
  date (`docs/analysis.md`), `top_holdings` for a fund, signals, each Finnhub section's latest
  row, `valuation` for a share answered from a foreign listing,
  earnings with its revenue, the next event, five headlines,
  `filings`), `analysts`, `earnings`, `insiders`, `news` and `filings`,
  paged newest first, and `top_holdings` and `options`. The overview
  drops headlines first to fit one page; `overview`, `top_holdings` and
  `options` have no next page.
- **The overview's `filings`** is EDGAR's summary (`filingsSummary()`):
  `source`, `fetched_at`, `stale`, the three flags (`late_filing`,
  `restatement`, `offering`: new securities, shares or debt,
  registered or offered; `docs/edgar.md`) and `recent`, the
  `FILINGS_RECENT` (5) newest filings. A flag says which filing to
  read; the section holds the rest. Off, not covered, no CIK and a
  foreign filer answer `message` (and `reason` for the last two) with
  every flag null, never false.
- **The `filings` section pages filings newest first** by accepted
  time, at most `FILINGS_PAGE_ROWS` (50) a page, each with
  `accession`, `form`, `accepted_at`, `filed`, `period`, `items`
  (`code` and `name`) and `url`. Its first page carries the flags, as
  news carries counts; later pages carry none.
- **An event's `filed_at`** (the events tool, the overview's
  `next_event`, the earnings route) is when its results 8-K was
  accepted, from EDGAR (`docs/edgar.md`), null without one; status
  and `reported_seen_at` stay as above.
- **The currency of earnings figures** (`figuresCurrency()`) is the
  listing's only for a share known to report in it. It is an event's
  `currency` (the events tool, the overview's `next_event`, the
  earnings route), the `currency` of the `earnings` section in the
  overview and the research route, and the top-level `currency` of the
  tool's `earnings` section page, whose rows are figures only. It is
  null for another listing that is not a US share class, whose figures
  are left out, and for a foreign filer, whose estimates and actuals
  Finnhub gives in its reporting currency (BABA's in renminbi). With
  EDGAR on, a share is known to report in its listing's currency only
  once EDGAR has classified it a domestic filer (`foreignFiler()`, its
  stored flag and a kept 10-K or 10-Q, `docs/edgar.md`); never fetched
  there, with no CIK, or with no 10-K or 10-Q kept yet (a new foreign
  listing files an F-1 before its first 20-F), it is null. **With EDGAR off it is the listing's**, a known limit: a
  foreign filer's figures are then labelled in its listing's currency.
- **`news` takes `since`**, a UTC date as published times are, at
  most 30 days back (`SINCE_DAYS`, what is kept), else
  `bad_arguments`; without it the section answers all 30 days. Its
  first page carries `counts` for that window before the articles, so
  an agent reads the balance of a week before its text; later pages
  carry none. `since` with another section is refused.
- **A fund the owner prices answers `top_holdings` as entered**
  (`fund:<ISIN>`, `src/operations/funds.ts`, `docs/portfolios.md`):
  the same shape with `source` `owner`, `fetched_at` (when entered,
  also as `entered_at`), `as_of` and `sectors_as_of`, no `stale`, a
  row's `symbol` the listing's own and `id` its key; never fetched,
  and `not_found` for a caller who neither holds nor priced it. Every
  other section of its key answers as `quote` does (`OWNER_PRICED`).
- **`top_holdings` is a fund's from Yahoo**: for an ETF or mutual fund
  on any market (`isFund()`), whose Finnhub, news and filings parts
  answer as before; a share's overview has no `top_holdings` key, and
  the section asked for anything but a fund answers `NOT_A_FUND`
  ("Top holdings are for ETFs and mutual funds only."). It holds
  `source` (`yahoo`), `fetched_at`, `stale`, `top` (`rank`, `symbol`,
  `id`, `name`, `weight_percent`), `top_weight_percent` (their sum),
  `assets` (`stock_percent`, `bond_percent`, `cash_percent`,
  `other_percent`, `preferred_percent`, `convertible_percent`),
  `sectors` and `bond_ratings` (largest first),
  `government_bonds_percent` and the note `TOP_ONLY`: the ten largest
  as Yahoo lists them, never the full list, with no as-of date. Percent
  to two decimals, from the stored fractions.
  - **A holding's `id` is joined at answer time**: the stored
    instrument whose Yahoo symbol it is, else null. A holding is never
    resolved or fetched, which would be ten calls per fund.
  - **Yahoo having none is an answer**: an ok run that kept nothing,
    or a fund another source prices, answers `NO_TOP_HOLDINGS` ("Yahoo
    has no top holdings for this fund."), asked again the next day. A
    fund with rows stored keeps them when an answer lacks the module
    (`docs/yahoo.md`).
  - **Fetched inline, in `research` and the instrument route, only
    for a fund with no ok run and no failed one within `RETRY_MS`**
    (`inlineDue()`), under the call's deadline; past it the stored
    answer stands, its `stale` adding `research sync pending`. A fetch
    that reached Yahoo and fails after the deadline still records its
    failed run, with no data, so the gate holds for a slow failure; a
    late answer stores nothing. An inline failure is carried as `error`
    and `message`, and a failure keeps the stored rows.
  - **Stale reasons are research's** (`topHoldingsState`,
    `STALE_RESEARCH`), on the 23:00 UTC schedule; `fetched_at` is the
    stored row's, so it outlives the runs' pruning.
- **`options` is Yahoo's chains** (`readOptions()`), for any
  instrument Yahoo prices, on any market; another source's (FRED, the
  Bucharest feed) answers `NOT_OPTIONABLE` ("Options come from Yahoo;
  this symbol is priced by another source."), and a listing with none
  `NO_OPTIONS` ("Yahoo lists no options for this symbol."), as
  `NOT_A_FUND` and `NO_TOP_HOLDINGS` do. Never in the overview: a
  summary is several calls, and the overview stays one read.
  - **Fetched inside the call, never stored**, and kept in memory per
    instrument and expiry until the quote period ends (`m.options`), as
    quote's `extended` is, so a read repeated within it costs no call.
    Chains change through the day; nothing else reads them, and nothing
    of them reaches signals, movers, screen, alerts or bars.
  - **Without `expiry`, the summary**: `price` (the chain's own
    `regularMarketPrice`, which every figure is measured from),
    `price_at`, `currency`, `fetched_at`, `stale`, `expiries` (every
    listed date, read in UTC) and `summary`, one row for each of the
    nearest `SUMMARY_EXPIRIES` (4) expiries with `days` above 0
    (calendar days from the market's date), and for the earnings expiry
    when it is not among them. Each row: `expiry`, `days`, `earnings`,
    `atm_strike` (the strike nearest `price` listing both a call and a
    put, the lower on a tie), `call_iv` and `put_iv` there in percent a
    year, `straddle` (the call's mid plus the put's), `implied_move_pct`
    (`straddle` over `price`, times 100), `put_call_oi` and
    `put_call_volume` (the puts' sum over the calls', null when the
    calls' is 0), `top_call_oi` and `top_put_oi` (the `TOP_STRIKES` (3) strikes
    with the most open interest). The listing is the nearest chain, so
    a summary is one call per row past it; a row not answered within
    the call's deadline is its `error` (`timeout`), the rest standing.
  - **The earnings expiry is the first to price the report**: the first
    listed expiry strictly after the next earnings date for an `amc` or
    unlabelled hour, on or after it for `bmo` or `dmh` (an expiry settles
    at the day's close), since a contract expiring
    before the news prices none of it. Only a stored event not yet
    reported and not past (`upcomingEvent()`, Finnhub's calendar) counts,
    so a passed one awaiting results never hides the next;
    with Finnhub off there is no earnings row.
  - **With `expiry`, that expiry's chain near the money**, unpaged:
    every strike within `CHAIN_BAND` (10) percent of `price`, lowest
    first, each with `call` and `put` (`bid`, `ask`, `mid`, `last`,
    `last_trade_at`, `volume`, `open_interest`, `iv` in percent a year,
    `in_the_money`; null for a side with no contract), beside `expiry`,
    `days` and `band_pct`. A chain too long for a page drops its
    farthest strikes, both sides of a tie together, and `band_pct` says
    how far it reaches. An expiry not listed is `bad_arguments` naming
    the `NEAREST_LISTED` (3) nearest listed; `expiry` with another section, and
    `since` with this one, are refused.
  - **Wrong in silence, guarded**: `mid` is null unless bid and ask are
    both above 0 and ask is at or above bid, and a straddle with a null
    mid is null, never a last price stood in; `last` comes with
    `last_trade_at`, so an old trade reads as one. Open interest is the
    previous session's, as exchanges publish it once a day.
- **Every section carries its period, `fetched_at` and `stale`**; a
  section with no row says why. A section or event of another listing
  also carries `listing` and the note `OTHER_LISTING`, or `SHARE_CLASS`
  for a share class; a share's own carries neither.

## The research route

The HTTP route (`researchList()`, transport in `docs/api.md`) answers
up to five shares at once for scripts, unpaged, so every count here
is fixed, never an argument, to keep five summaries short.

- **Five symbols** (`MAX_RESEARCH_SYMBOLS`): a share never fetched
  costs five Finnhub calls, and the free key allows 60 a minute,
  shared with the jobs.
- **`sections` picks what each share answers; a Finnhub section left out
  is not fetched.** Each item is `input`, `id`, `company` (the Finnhub
  summary, with its `source`, `message` and partial-failure fields),
  `valuation` (the overview's, with `metric` asked, for a share answered
  from a foreign listing),
  `news` (the news week), `filings` (EDGAR's summary) and
  `top_holdings` (the tool's section) and `options` (the tool's summary,
  never a chain), under the tool's deadline and tracking. `top_holdings`
  and `options` are answered only when asked, never by default, so a
  call without `sections` answers as before. `options` takes one symbol
  (`bad_arguments` with more), since a summary is up to six calls (five
  rows, and the listing when its nearest expires that day). No quote: `/quotes` answers prices for
  many symbols in one call. The research tool keeps its own names.
- **Each Finnhub section but `metric` adds `history`**: its newest
  rows as the section's page shows them, so a script reads a trend
  without paging the tool (`HTTP_HISTORY`): `analysts` two months, the
  least that shows a direction; `earnings` four quarters, one fiscal
  year of beats and misses; `insider` the three newest months with a
  row (Finnhub has none for a month without trades). Rows of another
  listing follow the section's rules, so `earnings` and `insider` hold
  none, and `listing` is on the section, not each row. The tool's
  `overview` carries no history.
- **`filings` is the overview's filings summary**, the flags and the
  five newest, fetched as the tool fetches it; five shares stay short.
- **`news` is the stored summary of a window; it fetches no news**
  (`newsWeek()`). The window starts seven days before the call
  (`WEEK_MS`, the span a daily reader needs) or at `since`, at most
  `SINCE_DAYS` back, by published time; `counts` cover it and `items`
  hold the first `WEEK_ITEMS` (3) in the summary's order (`topNews`).
  A share never walked answers counts of 0 with `stale` saying why; off
  or not covered answers `NO_NEWS` or `NEWS_NOT_COVERED`.
- **Its items have caps of their own, a budget that keeps five shares
  short, not a display width**: title 160 characters (`WEEK_TITLE`),
  publisher 60, reasoning 280, cut with an ellipsis; a URL over 300
  answers `url: null`, since a cut link is broken. Any cut or left-out
  field sets `truncated`. The `news` section keeps the stored caps.
