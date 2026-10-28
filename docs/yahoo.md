# Yahoo

Governs the Yahoo source: `src/sources/yahoo/client.ts` (calls and
parsing), `resolve.ts` (symbols into keys), `sync.ts` (fetches),
`history.ts` and `quotes.ts` (answers into rows) and `jobs.ts` (the
schedule), all under `src/sources/yahoo/`. The queue, back-off,
deadlines, retries, backfill, rescales, phrases and the lock every
source shares are in `docs/sources.md`; sessions, bar dates and
finality in `docs/calendars.md`; tables, the writer and staleness in
`docs/storage.md`; the tools that resolve and fetch inside a call in
`docs/tools.md`; rule pauses in `docs/rules.md`.

## Endpoints

- **Four calls on `query1.finance.yahoo.com`, no cookie or crumb:**

| Call | Path | Used for |
| --- | --- | --- |
| `chart` | `/v8/finance/chart/<symbol>?period1&period2&interval=1d&events=div,split` | daily bars, splits, one listing's meta |
| `intraday` | `/v8/finance/chart/<symbol>?interval=1m&range=2d&includePrePost=true` | quote's `extended`: minute bars with pre and post trading, and each window |
| `spark` | `/v7/finance/spark?symbols=<list>&range=1d&interval=5m&_=<now>` | quotes and sessions, up to 20 symbols |
| `search` | `/v1/finance/search?q&quotesCount=10&newsCount=0&listsCount=0` | listings for a bare symbol or a name |

- **Never `/v7/finance/quote` or `/v8/finance/spark`.** v7 quote
  answers 401 without a cookie and crumb; v8 spark has no trade time
  and no session. Each v7 spark entry is a full chart meta. Every
  chart and spark answer carries the session
  (`exchangeTimezoneName`, `currentTradingPeriod.regular`), which is
  read for the stored session (`docs/calendars.md`).
- **Every spark URL ends with `_=<now>`.** Yahoo caches a v7 spark
  answer for minutes, which freezes the price.
- **A spark call takes 1 to `SPARK_MAX` (20) symbols;** more is a 400.
  `sparkAll()` splits a list into calls of 20, and a failed call keeps
  the others' answers.
- **The User-Agent is `Mozilla/5.0`;** Yahoo answers a full browser
  User-Agent with 429.
- **Bars come from `open`, `high`, `low`, `close`, `volume`,** which
  Yahoo split-adjusts. `adjclose` is also dividend-adjusted and is
  never read, since averages are on price.

## Parsing

- **An answer without the expected shape is an error, never empty
  rows** (`malformed answer`). Only a chart range without trading,
  which answers no timestamps and an empty quote object, is zero rows.
- **A spark entry is read on its own,** so one bad symbol skips only
  itself (`skipped` with its phrase); an entry with no response is
  `not found`.
- **A meta's day high or low of 0 is none:** an index's meta can read
  0 while its bars do not.
- **A `CURRENCY` meta with no currency takes it from its symbol**
  (`currencyOf()`): `AAABBB=X` and the USD-based `BBB=X` quote in
  `BBB`. No fetch of a stored instrument rewrites its currency.

Phrases from Yahoo (`docs/sources.md`, Refusals):

| Phrase | From Yahoo |
| --- | --- |
| `rate limited` | HTTP 429 |
| `bad request` | HTTP 400 |
| `not found` | HTTP 404, `chart.error.code` `Not Found`, or a spark entry with no response |
| `source error` | any other non-2xx, a chart or spark error body, no quote for a fetched symbol |
| `network error` | the fetch or body read threw |
| `timed out` | the call's timeout, or the caller's deadline |
| `malformed answer` | not JSON, an unexpected shape, an answer naming another key, a history refused |

## The queue

- **Yahoo's queue runs `YAHOO_CONCURRENCY` (2) calls at once**
  (`src/app.ts`), shared by jobs and tools, with no limiter; the rest
  is `docs/sources.md`.

## Resolution

- **A caller's symbol becomes one listing, never a guess**
  (`resolve()` in `resolve.ts`):
  - a stored `market:symbol` key is that instrument; one not stored is
    searched: one listing with that key is it, several are
    `candidates`, none is a `ResolveError`;
  - a stored Yahoo symbol is that instrument;
  - an exact symbol (suffixed like `VVSM.DE`, or holding `^` or `=`
    like `^VIX`, `CL=F`, `EURUSD=X`) is asked with a 7-day chart,
    whose answer names the key; only a 404 falls back to search, since
    Yahoo writes share classes `BRK-B` and `BRK.B` must still resolve;
  - otherwise the search listing whose Yahoo symbol equals the input;
  - otherwise every listing is answered as `candidates` for the caller
    to pick one id from; none is a `ResolveError`.
- **The key drops Yahoo's suffix and maps the exchange code**
  (`symbolOf()`, `marketOf()`, `ALIASES`): `VVSM.DE` on `GER` is
  `XETRA:VVSM`. Index, futures and FX symbols keep their form.
- **Bucharest listings are Yahoo's only while the Bucharest feed is
  off** (`docs/bvb.md`); on, the same `BVB:` key is served by the feed,
  and a Yahoo symbol naming one (`TLV.RO`) resolves to it there.
- **Every stored answer must name the key it is stored under.**
  `checkAnswer()` (bars and extended hours), `refuseForeign()` (quotes)
  and the `expected` argument of `addInstrument()` and
  `fetchInstrument()` refuse an answer whose exchange and symbol make
  another key (`malformed answer`).

## Daily bars

- **The trailing row counts only on the session's date.** Yahoo ends
  some chart answers with a row off the bar grid at the last trade
  (`read()` in `history.ts`): a row whose local time of day differs
  from the previous row's. On the answer's session date it merges into
  that date's regular bar, a closing auction after the end included.
  With no grid row of that date it is the date's bar only for a
  `CURRENCY`, whose daily answer stamps today's row at the live minute;
  a future's Sunday evening trades share their Sunday session's date
  but are Monday's bar. Off that date it is dropped: an FX pair can
  trade on Sunday while its session is Friday's. A row with a null
  close is no bar.
- **Each write reconciles the answer's span.** Stored daily bars inside
  the span of the answer's regular rows that the answer no longer
  prices are deleted (`deleteDailyBars()`): a day the source has no
  bar for had no trading. Weeks are rebuilt from the span's first
  week, or all of them for a whole history.
- **The last finished session without its close is owed, not gone**
  (`unclosed()` in `history.ts`). A chart can leave that day's close
  empty, or its row out, for a while after the next session opens: an
  exchange that fills it late (Xetra at its open), or a market whose
  session starts at midnight (crypto). The newest day before the
  stored session's date, from the answer's rows or the stored bars, is
  owed when the answer has no close for it and no final bar is stored.
  A 30-day refetch keeps its stored bar, so averages still span the
  right days; a whole history does not, so no day keeps an old scale.
- **An owed day is asked for until it lands or the next session
  starts.** The refetch writes an `owed` run in the instrument's scope
  after its `bars` run; any later `bars` run settles it. `owedDue()` in
  `src/market/stale.ts` asks a market's owed instruments again,
  together, once the earliest mark is `OWED_RETRY_MS` (15 minutes) old,
  so the market gets at most one owed pass per period. Only marks from
  the current session count, and an instrument with no daily bars is
  never owed (backfill owns it). A day is owed until the session after
  the one it became newest in starts; that session's full pass decides
  again, and a day the source never closed is deleted as above once it
  is no longer newest.
- **The bars, their signals and the rule evaluation land in one
  transaction** (`store()`), so nothing reads bars without their
  signals.

## Backfill and refetch

- **A stored history older than ten years is fetched from its own
  first week** (`docs/sources.md`, Backfill).
- **A tool that names an unknown symbol fetches it inside the call**
  (`fetchInstrument()`): a 10-year chart, then a spark quote, written
  together with the instrument and signals while `live()` holds, or
  nothing is. A quote is required because a chart's previous close is
  the one before its range, ten years back. `addInstrument()` instead
  adds the instrument alone when its history is cut short, for the
  backfill job to retry.
- **The 30-day refetch applies a new split in the same pass** the new
  session's bars land in. An untracked instrument a read names is
  caught up the same way (`catchUp()`), then quoted.

## Splits and rescales

- **A split not stored, or stored with another ratio, refetches the
  whole history once.** Events are merged by date across the answers,
  a later answer's ratio winning (`unapplied()`). A split already
  applied inside the 30-day window does nothing more.
- **A window's rescale must be confirmed by the whole history**
  (`confirms()`): on its own oldest days and on every day the window
  showed it, or the history is refused.
- **A whole history is cut short** when it starts more than
  `SHORT_HISTORY_DAYS` (10) after both the start asked for and the
  stored first bar, stops more than 10 days before the stored last
  bar, or applies a split or rescale without covering every stored
  day. On a first history, a start more than 10 days past the later of
  the asked start and the listing's first trade is cut short
  (`startsShort()`). The splits then stay unapplied.
- **The bar pass ends with an evaluation of its market's rules** once
  its bars are in, so rules paused for a rescale read the new scale.

## Quotes

- **The day change is price minus previous close, never Yahoo's own
  change field,** which can disagree with both (`quoteOf()`).
  `previousClose` is preferred over `chartPreviousClose`, and the field
  used is stored.
- **A quote older than the stored one is kept out;** one with the same
  trade time replaces it only when fetched later (`storeQuotes()`).
- **`hasPrePostMarketData` decides whether a listing has extended
  trading,** never the windows: `currentTradingPeriod` names `pre` and
  `post` for Xetra too, whose flag is false. The client keeps the flag
  per Yahoo symbol in memory from every chart and spark answer
  (`prePost()`), so a listing whose quote pass said false is never
  charted for `extended`; one not seen yet is charted once, and its
  answer says. A restart empties it.
- **`intraday()` reads two days of minutes** (`INTRADAY_RANGE`): before
  the pre window a one-day answer can hold no bar inside its windows,
  while two keep the last post bars until the next open. It carries
  the pre, regular and post windows of `currentTradingPeriod` and of
  each day in `tradingPeriods`; a market without a window answers it
  empty. Extended bars' `volume` reads 0. Only quote's `extended` reads
  it, inside the call (`docs/tools.md`); no job polls the extended
  windows.

## The per-instrument lock

- **A new instrument's first chart (and spark) comes before the lock,**
  since its key is known only from the answer (`addInstrument()`,
  `fetchInstrument()`). Under the lock they re-read whether another
  holder stored its bars meanwhile (`dailyRange()`) and backfill or
  keep the stored history instead. Refetch, backfill and catch-up hold
  the lock across the call and its write (`docs/sources.md`, The
  source queue).

## Jobs

- **Three scheduled jobs tick every minute** (`TICK_MS`, `schedule()`
  in `jobs.ts`), each over tracked instruments only. A tick that finds
  the job's last run still going is skipped (`job skipped`,
  `src/runtime/scheduler.ts`), so a source is never asked twice at
  once by the same job. What is due is read from the stored sessions
  and runs, so a restart picks up where it was, except four marks held
  in memory that a restart clears: refused whole histories (`refused`
  in `sync.ts`), failed backfills (`backfillMissed`), each market's
  check turn (`checkTurn`) and the quote period last passed
  (`lastSlot`, all three in `jobs.ts`), so a restart can repeat a
  quote pass within the same period.

| Job | Does |
| --- | --- |
| `yahoo` (`quoteTick`) | quote pass for markets in session, once per quote period (`--quote-every`, default 5 minutes), one spark per 20 symbols across all markets |
| `yahoo` post-close | one quote pass at `closeQuoteAt()` if none started since |
| `yahoo` check | one instrument per closed market at `nextCheck()`, round-robin; a market with no session on each period; in the same spark calls |
| `yahoo-bars` (`barTick`) | 30-day refetch per market whose session moved on (`barsDue()`), plus one whole history per split or rescale; owed instruments again every `OWED_RETRY_MS` (`owedDue()`) |
| `yahoo-backfill` (`backfillTurn`) | one tracked instrument with no bars per turn, one 10-year chart; a failure or empty answer waits `RETRY_MS` |

- **The check instrument rotates per market** (`checkTurn`), so one
  that never answers cannot hide a new session from the rest.
- **A quote or check run is per market** (scope), failing when a call
  failed or none of its symbols came back; a missing symbol is logged
  and stale on its own. The rules are evaluated after the runs end, so
  a quote's staleness is this pass's.
- **Bars are their own job,** so a slow refetch never takes a quote
  turn; backfill takes its own turns too. All three share the queue
  and the writer, and tool calls spend from the same queue.
