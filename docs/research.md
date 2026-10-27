# Research, events and news

Governs Finnhub's research and earnings events (`src/finnhub/*`),
Massive's news (`src/massive/*`), the `research` and `events` tools
(`src/tools/research.ts`, `src/tools/events.ts`), `GET /research`, and
the `research`, `events`, `news` and `news_walks` tables
(`src/db/migrations/0007-research.ts`, `0008-news.ts`,
`0012-listing.ts`). The shared
source queue is in `docs/yahoo.md`; resolution, tracking and the answer
contract in `docs/tools.md`; rules that wait on events in
`docs/rules.md`; runs and retention in `docs/storage.md`.

## Keys

- **Each source is on only while its key file exists**
  (`secrets/source-finnhub.key`, `secrets/source-massive.key`); off is an answer, never
  an error: `NO_DATA`, `NO_EVENTS` ("no event source") or `NO_NEWS`.
- **Keys travel only in a header, never in a URL**: Finnhub's
  `X-Finnhub-Token`, Massive's `Authorization: Bearer`. A URL ends up
  in errors and logs; a header does not.
- **Errors hold a fixed phrase from `PHRASES` (`src/source.ts`), never
  text the source or fetch sent.**
- **Every Massive text kept is scrubbed of the key** (`scrubbed` in
  `src/massive/client.ts`: id, title, URL, publisher, tickers,
  reasoning), since an answer can echo it. Finnhub keeps only numbers,
  checked dates and an hour label matching `^[a-z]{0,8}$`, so nothing
  of its answer can carry text.
- **A Massive `next_url` is followed only when it is Massive's own news
  path** (`checkCursor`): https, the same origin, `NEWS_PATH`, no user
  or password, no key-named parameter, and the key in no decoding of
  it. It is checked on receipt and before it is sent, and never
  rewritten, because it goes out with the key in its header.

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

- **Each source has one limiter shared by its jobs and tools**
  (`limiter` in `src/source.ts`): one call at a time, each start
  `SPACING_MS` after the last, 1.1 s for Finnhub (free key: 60 a
  minute) and 13 s for Massive (5 a minute, no rate-limit headers).
  A second client would break the source's limit.
- **After a failure the queue backs off** (30 s, 5 minutes after a
  429) and never retries the call. "Not found", "bad request", a
  malformed answer that parsed as JSON and a passed deadline leave it
  running (`backsOff` in `src/source.ts`): a 404, Massive's 400, one
  share's odd answer. A body that is not JSON (`Unreadable`) backs
  off. Finnhub answers a 400 as "source error", which backs off. A
  tool's call fails at once while paused (`Paused`), answered as the
  source backing off after that phrase, and records no run, which
  would hold off the job's retry; a job waits it out.
- **A minute tick starts no new instrument after its budget**
  (`TICK_BUDGET_MS`: 45 s Finnhub, 30 s Massive), and Massive no new
  page; work already started finishes, so a tick can run past it. A
  tick that finds the last one still running is skipped
  (`src/scheduler.ts`); cut work goes on next tick.
- **A tool fetches inside its own deadline** (`researchTargets`,
  `m.callMs`) the sections it reads that have no good run
  (`unfetched`), so a pass cut short is finished by the next call
  that needs what it left: `events` and a rule's earnings gate the
  calendar only (one call per share), the `research` overview and
  `GET /research` all five, a history section its own
  (`SECTIONS_OF`). For the `overview` and `news` sections only, a
  covered instrument never asked for news gets one page. The rest come
  with the jobs. Concurrent calls naming one instrument and sections
  share one fetch (`shared`); the sections are checked again inside
  the instrument's lock, so a call that waited asks none another
  stored. A deadline that passes stores nothing.

## Finnhub sections

| Section | Asked | Stored |
| --- | --- | --- |
| `metric` | `stock/metric` | one row per instrument, replaced, dated by its fetch |
| `analysts` | `stock/recommendation` | one row per period |
| `earnings` | `stock/earnings` | one row per period; actual and surprise once seen are kept |
| `insider` | `stock/insider-sentiment`, the last 12 months | one row per month |
| `calendar` | `calendar/earnings`, 120 days back to 90 ahead | `events` |

- **The daily refresh is due after 23:00 UTC** (`dueAt`, after the US
  close and after-market reports). A section failed within `RETRY_MS`
  (60 minutes) waits.
- **Each section records its own run, scoped to the instrument**, so
  one failing section is stale alone. The sections fetched land in one
  write, failures as their own runs; a `Paused` refusal stores the
  sections fetched before it, and a passed deadline stores none.
- **A Finnhub 403 or an empty answer is no data, never an error**: the
  stored rows stay and the section reads "no data in the last answer";
  with no rows stored it carries `NO_DATA` ("no data from Finnhub")
  instead (`hasRows` in `sectionState`). A 401 is "key refused", a 404
  "not found", a 429 "rate limited", any other status "source error"
  (`src/finnhub/client.ts`); any other shape is "malformed answer".
- **An answer whose every part names one other symbol is that
  listing's** (`listingOf`): an ADR is answered as its home listing
  (TSM as `2330.TW`, its EPS in TWD per local share). Only what holds
  for any listing of the company is kept, with `listing` set to that
  symbol:

  | Section | Kept from another listing | Why the rest goes |
  | --- | --- | --- |
  | `analysts` | every count | |
  | `metric` | `COMPANY_METRICS`: growth, net margin, ROE, current ratio, debt to equity | P/E, PEG, P/S, P/B, yield and beta are on that listing's price |
  | `earnings` | nothing: no data | EPS in its currency per its share; its rows can disagree (TSM Q3 2026: actual 148.9 against an estimate of 29.2) |
  | `insider` | nothing: no data | share counts of its shares |
  | `calendar` | date, hour, fiscal year and quarter, and whether actuals came | estimates and actuals in its currency |

  A part naming no symbol is the asked one's. Parts naming two symbols
  are no data, as a 403 is, since neither can be trusted; a symbol not
  1 to 20 letters, digits, `.` or `-` is "malformed answer". A metric
  left with nothing is no data.
- **An answer naming a listing replaces the kind's rows of any other**
  (`storeSection`), its own included, even when it keeps nothing, so no
  figure of one listing is read as another's; an event a rule waits on
  stays, as retention keeps it. A 403 or an empty answer names none
  and replaces nothing.
- **A Massive 403 is "key refused", like its 401**
  (`src/massive/client.ts`): unlike Finnhub's, it is never no data.
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
- **Only actuals confirm an event.** `reported_seen_at` is set the
  first time an EPS or revenue actual appears and never moves, also for
  another listing, whose actuals are not stored; actuals once seen are
  kept when a later answer of the same listing omits them. `eventStatus` is
  "reported" only then, else "scheduled" when the date is after the
  exchange's today, else "awaiting results". A passed date or an
  after-close label never reports it: results can slip, and a rule
  waiting on the report would fire before the numbers exist.
- **The first sighting calls `hooks.reported` inside the same write**,
  so rules waiting on the event see it atomically.
- **A tracked share reporting yesterday or today is refreshed hourly
  from one whole-market call** (`market` and `reportingWindow` in
  `src/finnhub/jobs.ts`, `storeMarketCalendar`), rule or not: a reader
  needs the new quarter on the report date, and the 23:00 UTC refresh
  can come before Finnhub posts an after-close actual. While any
  tracked eligible share has an unreported stored event of its own
  listing dated its exchange's yesterday or today (`localDate`,
  `windowEvents`), the job asks
  `calendar/earnings` from yesterday to today with no symbol, at most
  once every `MARKET_EVERY_MS` (60 minutes), a failure waiting
  `RETRY_MS`. Yesterday too, since many reporters have no actuals a
  day later. Its run is `market-calendar` scoped to `US`
  (`MARKET_CALENDAR`), never an instrument.
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
  answer names the share's symbol, never the listing Finnhub answers it
  as (TSM as `2330.TW`), so it is not counted for the market call.
  These are few, US listings of foreign companies; spaced by the
  share's last `calendar` run (`MARKET_EVERY_MS`) and `RETRY_MS`.
- **A share whose event in the window was seen reported after its last
  good `earnings` run ended is asked its `earnings`** (`sightedEarnings`),
  so its surprises carry the new quarter the same hour. It is read from
  stored state, so shares a tick's budget cut are asked on the next
  tick; the run's end, not its start, since a pass asking both
  sections stores them in one write and must not ask again.
- **Cost: one call an hour while any tracked share is in its window,
  plus one per report**, and one an hour per share whose event is of
  another listing, however many shares are tracked; asking each
  reporting share by symbol would be hundreds an hour on a busy day.
  The answer is US listings only and uncut: 285 rows for two days, 934
  for a week.
- **The next event is the earliest dated from the exchange's today, or
  one up to `AWAITING_DAYS` (7) past still awaiting results**
  (`nextEvent`).
- **The `events` tool lists events between two dates** of the tracked
  US shares, or of the named symbols once resolved; of those, only a
  named covered share whose calendar has no good run is fetched
  inline. A symbol not covered or not resolved is listed under
  `unavailable`, and so is every share whose calendar has no good run,
  with why (never fetched, its fetch failed, timed out), and every
  share whose last good calendar run was no data (`NO_DATA`), its
  kept events still shown, so an empty list means no earnings in the
  range. A failed fetch is listed there too, while its stored events
  still show. The list is capped at 8 KiB with the rest counted, and
  appears on the first page only (`src/tools/events.ts`).
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

- **The `research` tool's sections** are `overview` (quote, signals,
  each Finnhub section's latest row, the next event, five headlines),
  `analysts`, `earnings`, `insiders` and `news`, paged newest first.
  The overview drops headlines first to fit one page; `overview` has
  no next page.
- **`news` takes `since`**, a UTC date as published times are, at
  most 30 days back (`SINCE_DAYS`, what is kept), else
  `bad_arguments`; without it the section answers all 30 days. Its
  first page carries `counts` for that window before the articles, so
  an agent reads the balance of a week before its text; later pages
  carry none. `since` with another section is refused.
- **Every section carries its period, `fetched_at` and `stale`**; a
  section with no row says why. A section or event of another listing
  also carries `listing` and the note `OTHER_LISTING`; a share's own
  carries neither.
- **`GET /research?symbols=a,b` answers at most five Finnhub summaries**
  beside each quote's brief projection, under the same deadline and
  tracking as the tool. A page that cannot hold every summary is a 500
  `internal` (`PageOverflow`), never a dropped summary.
- **Each `GET /research` Finnhub section but `metric` adds `history`**:
  its newest rows, the latest included, each as the section's page
  shows it, so a script reads a trend without paging the tool. The
  counts are fixed (`HTTP_HISTORY`), never arguments, to keep five
  summaries in one page: `analysts` two months, the least that shows a
  direction; `earnings` four quarters, one fiscal year of beats and
  misses; `insider` the three newest months with a row (Finnhub has
  none for a month without trades), a quarter of activity. Rows of
  another listing follow the section's rules, so `earnings` and
  `insider` hold none, and `listing` is on the section, not each row.
  The `research` overview carries no history.
- **Each share's `news` is the stored summary of a week; it fetches
  no news** (`newsWeek`). `since` is seven days before the call
  (`WEEK_MS`, the span a daily reader needs), by published time;
  `counts` cover that window and `items` hold at most three
  (`WEEK_ITEMS`) in the summary's order, each `published_at`,
  `publisher`, `sentiment`, `title`, `reasoning`, `url` and
  `truncated`. A share never walked answers counts of 0 with `stale`
  saying why; off or not covered answers `NO_NEWS` or
  `NEWS_NOT_COVERED`. Window and count are constants, not arguments:
  the endpoint is for scripts and stays small.
- **Its items have caps of their own, a page budget for five shares
  with their history, not a display width**: title 160 characters
  (`WEEK_TITLE`), publisher 60 (`WEEK_PUBLISHER`), reasoning 280
  (`WEEK_REASONING`), cut with an ellipsis; a URL over 300
  (`WEEK_URL`) answers `url: null`, since a cut link is broken. Any
  cut or left-out field sets `truncated`. The `news` section keeps the
  stored caps.
- **A page that does not fit gives up news items first**: every share
  is held to two items, then one, then none, with `items_cut: true` on
  each share that lost some and `counts` kept, since text that escapes
  can outgrow the page at the caps; only a page that does not fit with
  none is `PageOverflow`.

## Retention

- **Research rows past 24 months by period go; the metric row stays**
  (`pruneResearch`).
- **Events past 24 months go unless a rule waits on them.**
- **News past 30 days by published time goes, and every article and
  walk of an instrument no longer tracked** (`pruneNews`). Reads filter
  to 30 days whether or not retention ran.
- **Retention runs at start and once a day** (`prune` in `src/app.ts`).
