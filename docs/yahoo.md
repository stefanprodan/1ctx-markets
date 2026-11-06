# Yahoo

Governs the Yahoo source: `src/sources/yahoo/client.ts` (calls and
parsing), `resolve.ts` (symbols into keys), `sync.ts` (fetches),
`history.ts` and `quotes.ts` (answers into rows), `jobs.ts` (the
schedule), `valuation.ts` (an ADR's quote summary) and
`top-holdings.ts` (a fund's), all under `src/sources/yahoo/`. The queue, back-off,
deadlines, retries, backfill, rescales, phrases and the lock every
source shares are in `docs/sources.md`; sessions, bar dates and
finality in `docs/calendars.md`; tables, the writer and staleness in
`docs/storage.md`; the tools that resolve and fetch inside a call in
`docs/tools.md`; rule pauses in `docs/alerts.md`.

## Endpoints

- **Six calls on `query1.finance.yahoo.com`, no cookie or crumb:**

| Call | Path | Used for |
| --- | --- | --- |
| `chart` | `/v8/finance/chart/<symbol>?period1&period2&interval=1d&events=div,split` | daily bars, splits, one listing's meta |
| `intraday` | `/v8/finance/chart/<symbol>?interval=1m&range=2d&includePrePost=true` | quote's `extended`: minute bars with pre and post trading, and each window |
| `points` | `/v8/finance/chart/<symbol>?range=5d&interval=5m&includePrePost=false` | up to five sessions of regular-hours 5-minute closes, for the fill |
| `spark` | `/v7/finance/spark?symbols=<list>&range=1d&interval=5m&_=<now>` | quotes, sessions and 5-minute closes, up to 20 symbols |
| quote chart | `/v8/finance/chart/<symbol>?range=1d&interval=5m` | one spark entry, for a symbol spark failed on alone |
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
- **A spark call one symbol may have broken is split in halves**
  (`sparkSplit()`): Yahoo has answered a 500 for every batch holding
  one symbol while its chart answered. Only `source error`, `bad
  request` and a JSON `malformed answer` split; a rate limit, timeout,
  network error, page that is not JSON, closed queue or back-off in
  force fails the batch at once. Both halves of a split failing with
  errors that would split is the source: that batch fails whole, so an
  outage costs two more calls. A spark error body for one lone symbol
  is about that symbol, never an outage; for a bigger half it counts. Otherwise the failed half is
  split again down to one symbol, about 2·log2(20) calls, which is
  asked once as a quote chart and fails alone if that fails too. The
  split is one queued task, so only a batch failing whole backs off.
- **Accepted limits of the split:** a one-symbol batch whose spark and
  chart both fail backs the queue off as before; a rate limit, timeout
  or network error mid-split fails the batch whole, dropping halves
  already answered; two bad symbols in different halves fail it as an
  outage.
- **The User-Agent is `Mozilla/5.0`;** Yahoo answers a full browser
  User-Agent with 429.
- **Bars come from `open`, `high`, `low`, `close`, `volume`,** which
  Yahoo split-adjusts. `adjclose` is also dividend-adjusted and is
  never read, since averages are on price.

## The quote summary

- **One more call, behind a session**, read two ways (`summary()`,
  one task for both): `valuation()` asks
  `query2.finance.yahoo.com/v10/finance/quoteSummary/<symbol>?modules=defaultKeyStatistics,price&crumb=<crumb>`
  and `topHoldings()` the same with `modules=topHoldings,price`, each
  with the session's cookie. Without them Yahoo answers 401
  `Unauthorized` ("Invalid Crumb"); the six calls above need neither.
- **The session is a cookie and a crumb, held in memory only**
  (`newSession()`): `https://fc.yahoo.com/` sets the cookie whatever
  its status (often 404), and `/v1/test/getcrumb` on query1, sent that
  cookie, answers the crumb as plain text. It is fetched on first use
  and shared by every call; a restart starts a new one. Neither value
  is stored, logged, put in an error, a run or a fixture.
- **A refused session is fetched again once.** A 401 or an
  `Unauthorized` body drops it, and the call fetches a new one and asks
  again; a second refusal is `source error`, the share's failed run.
  The session, the call and its retry are one queued task; before each
  of its requests it checks shutdown, the caller's deadline and a
  back-off another call set (`ready()`), which it meets as `Paused`.
- **A failed quote summary never backs the queue off**: the task hands
  its failure back as a value, so the queue prices share sees none, and
  the instrument waits `RETRY_MS` on its own failed run. Prices never
  use the session and never wait on it.
- **Read: `defaultKeyStatistics` `trailingEps`, `forwardEps` and
  `pegRatio`, and `price` `currency` and `symbol`.** Each figure is
  `{raw, fmt}`, `{}` or missing; anything but a finite `raw` is null,
  never 0. An answer naming another symbol is `malformed answer`.
  `priceToBook` and the yields are never read: Yahoo divides the US
  price by a book value in the reporting currency.
- **Asked only for a US share Finnhub answers from a foreign listing**
  (`covered()` in `valuation.ts`: its stored `metric` names a listing
  with a `.`), the one share whose P/E Finnhub cannot give
  (`docs/research.md`): Yahoo's EPS is per US share in its currency,
  depositary ratio and exchange rate included, which no free source
  gives to work out by hand. A share Finnhub answers as itself or as
  another US class is never asked.
- **An answer is kept only in the instrument's currency**
  (`refreshValuation()`): another currency, or no figure at all, deletes
  the stored row and keeps nothing; a failure keeps it. One row per
  instrument (`valuations`, `docs/storage.md`), replaced, no history.

## A fund's top holdings

- **Asked for a stored instrument with source `yahoo` and type `ETF`
  or `MUTUALFUND`** (`asked()` in `top-holdings.ts`), on any market: a
  UCITS ETF answers as a US one does. An owner-priced fund (type
  `FUND`) and a fund another source prices are never asked; the second
  answers `NO_TOP_HOLDINGS` (`docs/research.md`).
- **Read: `topHoldings` `holdings` (`symbol`, `holdingName`,
  `holdingPercent`), `sectorWeightings`, `bondRatings` and the six
  `*Position` fields, and `price` `symbol`.** Weights are fractions
  (0.0837 is 8.37 percent). An answer naming another symbol is
  `malformed answer`; a `topHoldings` that is not an object too, and a
  `holdings`, `sectorWeightings` or `bondRatings` present but not a
  list, never read as an empty one. An empty list is an answer.
  `equityHoldings`, `bondHoldings` and `fundProfile` are never read:
  their ratios are wrong (a P/E of 0.09) and duration and maturity
  were never checked against an issuer.
- **No holdings is an answer, not a failure**: with `price` asked
  Yahoo answers a share or a fund it describes no holdings of with
  `price` alone (a 404 only when `topHoldings` is asked alone), and
  either is an ok run that deletes the stored rows. But a fund with
  rows stored whose answer lacks `topHoldings`, or holds it with no
  holding, sector, rating or position (`{maxAge: 1}`), is a failed run
  (`malformed answer`) that keeps them, stale and asked again after
  `RETRY_MS`: Yahoo dropping the module never wipes a good list as a
  fresh none. Any other failure keeps them too.
- **What is kept** (`parseTopHoldings()`): the first ten holdings in
  Yahoo's order, each sector and rating above 0, each key once, and
  `us_government` on its own, since it overlaps the ratings that sum
  to 1; null when 0. A holding, sector or rating weight that is not a
  finite number from 0 to 1.05 drops its row; a position outside −0.5
  to 1.5 is null (cash can be short), never 0.
- **Texts are cleaned**: a name loses control characters and runs of
  spaces, then is cut to `HOLDING_NAME_MAX` (120) with `cut()`; a
  sector or rating key must match `^[a-z_]{1,32}$`. A holding's
  symbol that is digits alone (`00939`) is null, the name kept, since
  it names no exchange and would quote another listing. American
  receipts answer as their US tickers, whatever listing the fund
  holds.
- **Cost: one call a day per tracked fund**, plus the session's two
  on first use and on each refusal; `research` and the instrument
  route ask inline only a fund never fetched well and not failed
  within `RETRY_MS`, since the instrument page re-reads every 30
  seconds.

## Parsing

- **An answer without the expected shape is an error, never empty
  rows** (`malformed answer`). Only a chart range without trading,
  which answers no timestamps and an empty quote object, is zero rows.
- **A spark entry is read on its own,** so one bad symbol skips only
  itself (`skipped` with its phrase); an entry with no response is
  `not found`.
- **A spark entry's `points` are its 5-minute closes** (`SparkQuote`),
  null closes dropped. `indicators.quote[0]` holds `close` only, regular
  hours only, from the regular open of the latest session so far: while
  open the last stamp is the trade, off the grid; closed it may end on
  the grid before the meta's trade (VWCE.DE 16:30, its trade 16:36).
  Out of session it is the last session, not today's. An entry with no
  `timestamp`, columns that do not parse, or a stamp outside 1970 to
  2200, has no points and keeps its quote: a bad series never costs the
  price, nor rolls back the quote's write.
- **A `points` answer is read as a chart:** its closes, nulls dropped,
  dated like a spark entry's; a series that does not parse fails the
  call, since the answer holds nothing else.
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
| `source error` | any other non-2xx, a chart or spark error body, no quote for a fetched symbol, no session cookie or crumb, a quote summary refused twice |
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
  `CURRENCY`, whose daily answer stamps today's row at the live minute
  (that row's date counts as covered when a whole history is checked);
  a future's Sunday evening trades share their Sunday session's date
  but are Monday's bar. Off that date it is dropped: an FX pair can
  trade on Sunday while its session is Friday's. A row with a null
  close is no bar.
- **Each write reconciles the answer's span.** Stored daily bars inside
  the span of the answer's regular rows that the answer no longer
  prices are deleted (`deleteDailyBars()`): a day the source has no
  bar for had no trading. A 30-day refetch keeps an owed day and a day
  closed from a quote (below); a whole history keeps only the latter,
  and not when it rescales. Weeks are rebuilt from the span's first
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
- **An owed day with a stored live bar closes at the next session's
  previous close** (`closeOwed()` in `history.ts`), since Yahoo can
  leave a finished row empty for hours or for good (seen on Xetra)
  while its quote already names that close. Only a Yahoo quote whose
  trade is in the stored session after the owed day counts, so a quote
  from before the open never names the day before; crypto, currency
  pairs and futures are left owed, their quote's previous close not
  being the day's close (a future's can be a later settlement). The
  bar turns final with that close, its high and low widened by the
  close and the session's stored 5-minute closes, its open and volume
  kept as stored (no source holds the full day's volume). It is marked
  (`bars.quote_close`): an empty row never deletes it, unless a whole
  history rescales, and the next answer with Yahoo's own row for that
  day replaces it and clears the mark, since Yahoo's close includes the
  closing auction.
- **A currency pair's final day closes at its session's end, not
  Yahoo's close** (`settle()` in `history.ts`), since Yahoo's daily
  close for a `CURRENCY` is about the day's open. The close is the
  session's last stored 5-minute close when the server holds that
  session's points, else the next day's open (equal within a pip on
  weekdays; a Friday carries the weekend gap), else Yahoo's close until
  the next day arrives. Open, high, low and volume stay Yahoo's, and
  the live day keeps the quote's price. A refetch settles the stored day
  just before its window too, since its first open is that day's close.
  A close taken from points is
  marked (`bars.point_close`) and kept by every later write, so a
  refetch or the five-session prune never replaces it; a rescale drops
  it with the points. The refetch's rescale check compares settled
  closes, so an unchanged answer changes no row. At start
  `settleStored()` applies the same rule to stored pairs, rebuilding
  weeks and signals from the first day it changed, so a deploy needs no
  manual step.
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
- **The points are stored with the quote, only when the quote is**
  (`storeIntraday()` in `storeQuotes()`), in the same write, so every
  spark answer stores them: the quote pass, the check, a first fetch,
  a catch-up, a refetch and a source switch. No call is made for them
  (`docs/storage.md`, "Intraday closes").
- **`hasPrePostMarketData` decides whether a listing has extended
  trading,** never the windows: `currentTradingPeriod` names `pre` and
  `post` for Xetra too, whose flag is false. The client keeps the flag
  per Yahoo symbol in memory from every chart and spark answer
  (`prePost()`), so a listing whose quote pass said false answers
  `extended` none even when its chart fails; it is still charted, only
  for quote's `opens`. A restart empties it.
- **`intraday()` reads two days of minutes** (`INTRADAY_RANGE`): before
  the pre window a one-day answer can hold no bar inside its windows,
  while two keep the last post bars until the next open. It carries
  the pre, regular and post windows of `currentTradingPeriod` and of
  each day in `tradingPeriods`; a market without a window answers it
  empty. Extended bars' `volume` reads 0. `currentTradingPeriod` names
  the next regular session from its pre window's start, for an index
  too, so a closed listing learns when it opens (`nextOpen()`); an
  answer without pre or post trading is held until that start, or past
  its close until the next pre start, and an empty pre window (named
  only at the open) always to the next pre start (`heldUntil()`): about
  one call a night on a trading day, at most hourly over a weekend or
  holiday. Only quote's `extended` reads it, inside the call
  (`docs/tools.md`); no job polls the extended windows.

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
  in `jobs.ts`), each over tracked instruments only, a fourth,
  `yahoo-valuation` (`valuationJobs()` in `valuation.ts`), while
  Finnhub is on, and a fifth, `yahoo-top-holdings`
  (`topHoldingsJobs()` in `top-holdings.ts`), always. A tick that finds
  the job's last run still going is skipped (`job skipped`,
  `src/runtime/scheduler.ts`), so a source is never asked twice at
  once by the same job. What is due is read from the stored sessions
  and runs, so a restart picks up where it was, except three marks held
  in memory that a restart clears: refused whole histories (`refused`
  in `sync.ts`), failed backfills (`backfillMissed`), each market's
  check turn (`checkTurn`) and the sessions fills asked (`fillAsked`,
  all in `jobs.ts`). The quote period last
  passed is checked per market on the first tick (`lastPassAt()`: that
  market's pass, never an instrument's read, nor one cut by shutdown),
  so a restart or a deploy never repeats a market's quote pass within
  its period, while a market whose pass shutdown cut, a first run, or a
  stop past the period passes at once.

| Job | Does |
| --- | --- |
| `yahoo` (`quoteTick`) | quote pass for markets in session, once per quote period (`--quote-every`, default 5 minutes), one spark per 20 symbols across all markets |
| `yahoo` post-close | one quote pass at `closeQuoteAt()` if none started since |
| `yahoo` check | one instrument per closed market at `nextCheck()`, round-robin; a market with no session on each period; in the same spark calls; one that sees the session open quotes its whole market in the same tick |
| `yahoo-bars` (`barTick`) | 30-day refetch per market whose session moved on (`barsDue()`), plus one whole history per split or rescale; owed instruments again every `OWED_RETRY_MS` (`owedDue()`) |
| `yahoo-backfill` (`backfillTurn`) | one tracked instrument with no bars per turn, one 10-year chart; a failure or empty answer waits `RETRY_MS` |
| `yahoo-backfill` (`fillTurn`) | in a turn with no 10-year chart due, up to `FILLS_PER_TURN` (5) tracked instruments holding fewer than `INTRADAY_SESSIONS` sessions, one `points` call each, one at a time |
| `yahoo-valuation` | one quote summary a day per tracked share Finnhub answers from a foreign listing, once its `metric` ran well since the latest 23:00 UTC (`valuationDue()`), so after the research refresh; a failure waits `RETRY_MS` |
| `yahoo-top-holdings` | one quote summary a day per tracked fund Yahoo prices, once past the latest 23:00 UTC (`topHoldingsDue()`), the first on the next tick; a failure waits `RETRY_MS` |

- **The fill adds only sessions not stored** (`fillSessions()` in
  `sync.ts`, `addIntraday()`): a session the quote passes stored is
  never replaced, and the split rule and the five-session prune hold
  as for any answer. It holds the instrument's lock like a refetch, so
  a rescale's clear never meets an older answer. A currency pair whose
  sessions it filled settles its stored days again (`settleBars()`),
  weeks and signals following, so its filled final days close at the
  session's last point. Each instrument is asked once a process,
  answered or not, so a listing with fewer than five sessions, or none
  at 5 minutes, is not asked each turn; a restart asks it once more.
  Five a turn, one call at a time, keep the queue's other slot for
  quote passes and reads, and fill a hundred instruments in twenty
  minutes; storing began with the deploy, so without it 5D shows one
  day until five sessions pass.
- **The check instrument rotates per market** (`checkTurn`), so one
  that never answers cannot hide a new session from the rest.
- **A market closed before the process started gets one check of every
  instrument without its last session's 5-minute closes** (`filled` in
  `plan()`), in the same spark batches, once a process: its quote
  passes ran before the start, so a deploy never leaves 1D empty until
  the next open. A market this process quotes needs none.
- **A quote or check run is per market** (scope), failing when a call
  failed or none of its symbols came back; a missing symbol is logged
  and stale on its own, and a failed run marks only the quotes it did
  not store (`docs/storage.md`). The rules are evaluated after the runs end, so
  a quote's staleness is this pass's.
- **Bars are their own job,** so a slow refetch never takes a quote
  turn; backfill takes its own turns too. All three share the queue
  and the writer, and tool calls spend from the same queue.
