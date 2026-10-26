# Research, events and news

Governs Finnhub's research and earnings events (`src/finnhub/*`),
Massive's news (`src/massive/*`), the `research` and `events` tools
(`src/tools/research.ts`, `src/tools/events.ts`), `GET /research`, and
the `research`, `events`, `news` and `news_walks` tables
(`src/db/migrations/0007-research.ts`, `0008-news.ts`). The shared
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
- **An answer, or any row in it, naming another symbol is no data**
  (`ownListing`), as a 403 is: an ADR is answered as its home listing
  (TSM as `2330.TW`, its EPS in TWD per local share), which is no
  number for the symbol asked.
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
  first time an EPS or revenue actual appears and never moves; actuals
  once seen are kept when a later answer omits them. `eventStatus` is
  "reported" only then, else "scheduled" when the date is after the
  exchange's today, else "awaiting results". A passed date or an
  after-close label never reports it: results can slip, and a rule
  waiting on the report would fire before the numbers exist.
- **The first sighting calls `hooks.reported` inside the same write**,
  so rules waiting on the event see it atomically.
- **An event a rule waits on is asked hourly on its date and the day
  after, by the exchange's local date (`localDate`), until reported**
  (`WAITED_EVERY_MS`, `waited` in `src/finnhub/jobs.ts`).
- **The next event is the earliest dated from the exchange's today, or
  one up to `AWAITING_DAYS` (7) past still awaiting results**
  (`nextEvent`).
- **The `events` tool lists events between two dates** of the tracked
  US shares, or of the named symbols once resolved; of those, only a
  named covered share whose calendar has no good run is fetched
  inline. A symbol not covered or not resolved is listed under
  `unavailable`, and so is every share whose calendar has no good run,
  with why (never fetched, its fetch failed, timed out), and every
  share whose last good calendar run was no data with no event kept
  (`NO_DATA`), so an empty list means no earnings in the range. A failed fetch is listed there
  too, while its stored events still show. The list is
  capped at 8 KiB with the rest counted, and appears on the first page
  only (`src/tools/events.ts`).

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

## Answers

- **The `research` tool's sections** are `overview` (quote, signals,
  each Finnhub section's latest row, the next event, five headlines),
  `analysts`, `earnings`, `insiders` and `news`, paged newest first.
  The overview drops headlines first to fit one page; `overview` has
  no next page.
- **Every section carries its period, `fetched_at` and `stale`**; a
  section with no row says why.
- **`GET /research?symbols=a,b` answers at most five Finnhub summaries**
  beside each quote's brief projection, under the same deadline and
  tracking as the tool. It carries no news and fetches none. A page
  that cannot hold every summary is a 500 `internal` (`PageOverflow`),
  never a dropped summary.

## Retention

- **Research rows past 24 months by period go; the metric row stays**
  (`pruneResearch`).
- **Events past 24 months go unless a rule waits on them.**
- **News past 30 days by published time goes, and every article and
  walk of an instrument no longer tracked** (`pruneNews`). Reads filter
  to 30 days whether or not retention ran.
- **Retention runs at start and once a day** (`prune` in `src/app.ts`).
