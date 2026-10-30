# Sources

Governs what every source shares: `src/sources/source.ts` (phrases,
errors, the queue and the limiter), `src/sources/ids.ts` (source and
market ids) and `src/sources/history.ts` (the backfill window, the retry
wait, rescales), with the per-instrument lock in `src/runtime/lock.ts`.
Each provider's own behaviour is in its doc: `docs/yahoo.md`,
`docs/bvb.md`, `docs/fred.md`, `docs/research.md` (Finnhub and Massive),
`docs/edgar.md`. The tool call's deadline and the inline fetch are in
`docs/tools.md`; runs and staleness in `docs/storage.md`; rule pauses in
`docs/rules.md`.

## The source queue

- **Every call to a source, from a job or a tool, goes through that
  source's one queue** (`queue()`), shared by all its callers. A
  second client or a direct `fetch` would escape the back-off and the
  source's rate limit.
- **A source with a per-minute limit uses a limiter** (`limiter()`):
  one call at a time, each start a fixed spacing after the last, so
  the limit holds across its jobs and tools. Each provider doc gives
  its spacing.
- **A failure backs the whole queue off.** A 429 pauses every call
  for `RATE_LIMIT_BACKOFF_MS` (5 minutes), any other failure for
  `FAILURE_BACKOFF_MS` (30 seconds).
- **Some failures never back off** (`backsOff`): `not found`, `bad
  request`, a malformed answer that parsed as JSON, a passed
  deadline, and a call refused for a back-off already in force. An
  unknown symbol, a wrong request or one odd answer is no
  sign the source is unwell, so one symbol never pauses the rest.
  Every answer parses inside its queued call, so a body that is not
  the source's format at all (`Unreadable`: a proxy or consent page)
  backs off like any failure.
- **Jobs wait a back-off out; tools fail at once.** `failFast()` and
  `within(live)` clients reject a call while the queue backs off
  (`Paused`), which never reached the source and so records no run; a
  run would hold off the job's own retry.
- **`close()` fails every waiting call,** a limiter's parked one
  included, so nothing goes out after shutdown begins
  (`QueueClosed`, `docs/config.md`); a queued task that makes several
  calls checks `isClosed()` before each.
- **One fetch-and-store per instrument at a time** (`exclusive()` in
  `src/runtime/lock.ts`), held across the call and its write, so an
  answer fetched before another write never lands after it. Every
  holder re-checks its deadline under the lock, since the wait may
  have outlasted it.
- **Work on a stored instrument re-reads it under the lock and in
  each write** (`checkSource()` in `src/market/instruments.ts`) and is
  refused (`Moved`) when its source or source symbol changed, so a
  pass or read begun before a source switch never mixes histories or
  relabels bars. A fetch never takes over a key another source holds
  (`checkOwner()`); only a source switch moves it (`docs/bvb.md`). A
  bar pass skips a moved instrument without a failed run.

## Deadlines

- **Each source call times out after 30 seconds** (`TIMEOUT_MS` in
  each client), answered `timed out`.
- **A tool's call carries the caller's deadline** through
  `within(live)`: a call still waiting for its slot once `live()` is
  false is rejected (`DeadlinePassed`) and never starts, and a limiter
  re-checks it after its spacing wait. A passed deadline is the
  read's own, never a sign the source is unwell, so it never backs
  off. The deadline itself is the tool call's (`docs/tools.md`).
- **A call with a deadline goes ahead of waiting job calls,** first in
  first out among its own, so a read never times out behind a pass; a
  limiter keeps its spacing.

## Retries

- **The queue never retries a failed call.** The caller's next turn
  asks again: a job's next due tick, or the next tool call that needs
  what is missing.
- **A failed pass, a failed backfill or a refused whole history waits
  `RETRY_MS` (60 minutes)** before it is asked again, rather than on
  every minute tick. `docs/yahoo.md` names the marks held in memory
  that a restart clears.

## Backfill

- **A new instrument gets ten years of daily bars from a Monday**
  (`backfillStart()`, `BACKFILL_YEARS`): the Monday on or before ten
  years back, so the first week is whole, a 29 February taken as the
  28th. Yahoo and the Bucharest feed fetch from the UTC day before it to
  cover any zone and drop bars before the Monday.
- **The bar pass refetches the last `REFETCH_DAYS` (30) days,** so it
  finalises the previous bar and fills gaps; after a longer gap it asks
  from the last final bar.
- **A whole history cut short is refused, and nothing is written.**
  Writing it would drop, or leave unscaled, the stored days it omits.
  Yahoo (`startsShort()` and its whole-history check) and the
  Bucharest feed (`checkCovers()`) check it against the stored range;
  FRED checks only that a history fits one page (`docs/fred.md`).

## Splits and rescales

- **Past prices moved by one ratio without a split are a rescale**
  (`rescaleOf()`): at least `RESCALE_DAYS` (3) of the oldest stored
  final days repriced by one shared ratio, ratios within `SAME_RATIO`
  counting as one, more than `RESCALE` (0.1%) from 1. An adjustment
  moves every day before its date, so the oldest days show it; fewer
  days moved are corrections and are written as such.
- **A rescale or new split refetches the whole history,** so no stored
  day keeps the old scale, and that history must cover every stored
  day.
- **Rules on old price levels pause before the whole history is
  asked** (`rules.rescaled`, `docs/rules.md`), since it may be refused.
- How a source detects a split or a moved close is in its doc.

## Refusals

- **Every source error carries a fixed phrase** (`SourceError`,
  `PHRASES`), which is all a run or an answer repeats, never text the
  source or `fetch` sent: that text can quote a key or a URL holding
  one. A run records `phraseOf()` of its error. Each provider doc maps
  its statuses onto the phrases.
- **A keyed source scrubs every text it keeps of its key**
  (`scrub()`): raw, percent-encoded and form-encoded, case-blind, since
  an answer can echo it.
- **`Refused` is an instrument the server will not keep** (a source
  turned off mid-call, a series not daily, a Bucharest share not on the
  regulated market's list or a fund unit not on the fund units list, a
  type the source does not serve). Its message is said to the caller as
  it is, as the item error `refused` (`itemError()` in
  `src/operations/targets.ts`).
- **`Paused` is answered as the source backing off after the phrase
  that paused it** (`rate_limited` after a 429), never as if this
  call's own answer had failed; `DeadlinePassed` as the call's
  timeout (`docs/tools.md`).

## Source ids

- **Source and market ids live in `src/sources/ids.ts`,** so code that
  names a source without calling it (staleness, signals, the reads,
  rules) imports no provider. A market id is an instrument key's
  prefix (`BVB:`, `FRED:`).
