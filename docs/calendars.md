# Calendars

Governs market hours, bar dates and weeks: `src/market/calendars.ts`,
`src/market/zone.ts` and the `markets` table. The jobs that act on a
session are in `docs/yahoo.md`; tables, times and staleness in
`docs/storage.md`.

## Sessions come from the source

- **A market's hours are the source's answers, never a table.** No
  code holds fixed UTC hours, opening times or holiday lists, so any
  exchange the source carries works. A holiday is a day the source
  shows no new session and no bar for; nothing announces it ahead.
- **A session is one regular trading period** (`Session`: IANA zone,
  `start` and `end` in UTC epoch ms), read from Yahoo's chart meta
  (`sessionFromChartMeta()`, `docs/yahoo.md`) or a source's own
  schedule (`docs/bvb.md`). `session()` refuses an end not after its
  start, or a period over 25 hours (`MAX_SESSION_MS`): that is no
  single day.
- **The zone is an IANA name, never an offset.** `checkZone()` rejects
  `+02:00`-style values and unknown zones and returns the canonical
  name: an offset cannot follow a clock change, and every local date
  and wall time is computed from the zone.
- **`markets` holds each market's latest session, one row per
  market**, the only stored calendar: quoting, checks, finality and
  staleness read it through `readSession()`.

## The stored session

- **A stored session only moves forward.** `recordSession()` replaces
  the row only when the answer was fetched no earlier than the stored
  one and its session starts no earlier. Before the open some listings
  of a market still show the previous day's session; an answer like
  that must not undo a newer one, or finality and checks would step
  back a day.
- **It may move back only while the stored session has not begun**
  (`markets.session_start > fetched_at` of the new answer). That undoes
  a bad answer that announced a session too early, before anything
  could have relied on it.
- **One answer records one session per market, its latest start
  across its listings, before any live row is written**
  (`storeQuotes()` in `src/sources/yahoo/quotes.ts`), so live rows never
  depend on the order of entries. Every answer's session is recorded,
  known instrument or not.

## Quoting and closes

- **A market is quoted from its start to one minute past its end**
  (`isQuoted()`). The end names the session's last minute, so a 23:59
  end runs to midnight. `CRYPTO` is always quoted; a market with no
  stored session is not.
- **One more quote pass runs 15 minutes after the end**
  (`closeQuoteAt()`): a closing auction can print after the end, and
  the day's last price must land. Crypto has none, since it never
  closes.
- **A closed market is checked, not quoted.** `nextCheck()` is the
  next time to ask the source with one instrument:
  - the stored session's start, if it is still ahead of `since`;
  - otherwise the session's local start time on each following day,
    then hourly until its local end time, because the source can keep
    showing a past session over a weekend or a holiday;
  - the first such time after `since`, which is the later of the stored
    answer's fetch and the last check started, so a source that is down
    is not asked on every tick, and a time already past means a check
    is due now.
- **The check slots are local wall times.** They come from the stored
  session's own local start and end; an end that a clock change puts
  before the start still gets its start slot. A check stale by months
  starts its search near `since`, not at the session.

## Bar dates and finality

- **A bar's date is the local date its session starts on, never the
  UTC date** (`barDate()`, `sessionDate()`): EURUSD=X's Friday bar is
  stamped Thursday 23:00 UTC.
- **A daily bar is final once an answer shows a later session**
  (`isBarFinal(date, latest)`): late prints after the end, such as a
  closing auction, land before that. Finality is never decided by the
  clock alone. `isBarFinal()` validates the date first, since a
  malformed string would compare and pass.
- **A stored final bar stays final** (`upsertBars()` in
  `src/market/bars.ts`), while its values still follow the source's
  corrections.

## Weeks

- **Weeks run Monday to Sunday by the exchange's date and are built
  from stored daily bars, never fetched** (`weekOf()`; `weeksOf()` in
  `src/market/bars.ts`). An open crypto week from Yahoo holds Monday
  to Saturday only. A week's date is its Monday.
- **A week is final once its Sunday has ended in the market's zone and
  every daily bar in it is final** (`weeksOf()`, `isWeekFinal()`).

## Wall time

- **A wall time is epoch ms read as if the zone were UTC** (`wallTime()`
  in `src/market/zone.ts`), so day and hour steps are plain arithmetic
  across clock changes. Never add `DAY_MS` to an instant to reach the
  next local day; step the wall time and convert back.
- **`fromWallTime()` maps a wall time back to an instant**: an hour
  that occurs twice takes its first instant; one a clock change skips
  moves past the gap.
- **Dates go through `wallOfDate()`,** which throws on anything not a
  real `YYYY-MM-DD` date.

## Crypto

- **`CRYPTO` is one market for every crypto pair** (Yahoo's `CCC`,
  through `ALIASES` in `src/sources/yahoo/resolve.ts`). It is always
  quoted, has no post-close quote and is never checked; its session is
  still recorded, and bar dates, finality and the bar pass follow it as
  for any market.
- **A crypto quote is due at every pass**, so one two periods old is
  `quote overdue` (`docs/storage.md`).
