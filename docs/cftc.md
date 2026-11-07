# CFTC

Governs the US Commodity Futures Trading Commission's Commitments of
Traders reports, read from its public reporting API (Socrata):
`src/sources/cftc/client.ts` (calls, the field map and answer checks)
and `list.ts` (the market list held in memory and its job), with the
read in `src/operations/positioning.ts`. The queue, deadlines, phrases
and retries every source shares are in `docs/sources.md`; the
`research` section and route in `docs/research.md`; the tool's
arguments in `docs/tools.md`.

## On, always

- **The CFTC is on whatever the start options, as Yahoo is.** It needs
  no key and no contact line, unlike FRED and EDGAR, whose key files
  are their switch because they need the file anyway, and its markets
  (gold, oil, the euro, Treasuries, equity indices, Bitcoin) are
  traded worldwide, so a regional `--source` flag does not fit. No
  flag, key file or setting turns it off; the start log says
  `cftc=on (always)` and Server admin's Status the same.
- **It costs two calls a day for the market list**, made at start and
  whether anyone reads or not, and one call per market a read asks
  for, at most once per `POSITIONING_MS`.
- **Nothing is stored.** Positioning is weekly, read by few agents,
  revised now and then, and its markets come and go, so the list and
  each market's weeks live in memory only: no table, no migration, a
  restart asks again. Nothing of it reaches signals, movers, screen,
  alerts or bars. The list's job records its runs like any job
  (`docs/storage.md`), so Status shows it.

## Calls and limits

- **One limiter at `SPACING_MS` (500 ms)** on the fixed host
  `publicreporting.cftc.gov`. No limit is published for calls without
  an app token and the server makes a few a day, so the spacing only
  keeps a burst polite; it sits on a read's path (the list, then the
  weeks), where two seconds would have doubled a first read.
- **Two datasets, futures only**: disaggregated (`72hh-3qpy`, commodity
  markets) and Traders in Financial Futures (`gpe5-46if`). Every market
  is in exactly one of them, so a market reads from one report. The
  combined futures-and-options reports are left out, since the
  futures-only numbers are the ones commonly quoted, and so is legacy,
  whose groups blur the traders the detailed reports name (managed
  money, leveraged funds).
- **A 429 is "rate limited", a 404 "not found", a 400 "bad request"**;
  any other failing status is "source error", and a body that is not
  JSON `Unreadable`, which backs the queue off.
- **Queries select only the field map's columns** (`columns()`): a
  market's 157 weeks are 135 KB that way, 1.07 MB whole.

## The field map

The datasets' names are irregular (`swap__positions_short_all`, a
missing `_all`), so `FIELDS` maps them once per report and group:

| Report | Groups |
| --- | --- |
| disaggregated | `producer_merchant`, `swap_dealer`, `managed_money`, `other_reportable`, `non_reportable` |
| financial | `dealer`, `asset_manager`, `leveraged_funds`, `other_reportable`, `non_reportable` |

Each group has `long`, `short`, `spread` and the trader counts long and
short. A field the map has none of answers null (producers' and
non-reportables' spread, non-reportables' traders); a field it names
that a row lacks is a malformed answer.

## Answer validation

`parseMarkets` and `parseWeeks` refuse anything else with "malformed
answer":

| Check | Why |
| --- | --- |
| every row's code is the code asked | another market's weeks would be answered as this one's |
| dates are Socrata's midnight stamps of real dates, none twice | a doubled week has no single value |
| positions and counts are whole numbers of digits, 0 or more | `Number()` reads `""` as 0 |
| a list that fills its `$limit` (`LIST_LIMIT`) is refused | it may be cut short, losing markets |
| a list names each code once, with a name | a market listed twice is two markets |

A weeks call asks one row above `HISTORY_WEEKS`, so filling it is
expected: the extra row gives the oldest week its change.

## Ids

- **A market is `CFTC:<code>`**, the code six characters of digits,
  capitals and `+` (`CODE`) after upper-casing, as `FRED:` ids are
  (`cftcCode()`); anything else after the prefix is `bad_arguments`.
  Codes are the CFTC's (`13874+`), not Yahoo symbols. REST writes the
  `+` as `%2B`, since a bare `+` decodes to a space (`docs/api.md`).
- **A CFTC id is no instrument**: nothing resolves, stores or tracks it.
  quote, history, movers, screen and alerts answer it `not_found` with
  `NO_PRICE` before any lookup (`step()` in
  `src/operations/targets.ts`), and research answers it its own way
  (`docs/research.md`).

## The market list

- **One grouped call per report** for every market with a report in
  the last `LIST_WEEKS` (52) weeks: its code, name and latest report
  date, held in memory (`marketList()`), so a market missing from one
  week's report stays findable for a year. A report's `latest` is its
  newest date for any market.
- **The `cftc-markets` job keeps it** (`cftcJobs()`): at start, then on
  the minute tick once `LIST_MS` (24 hours) passed since the report's
  last good fetch. A failure keeps the held list and waits `RETRY_MS`
  (60 minutes) before it asks again. Each report is its own run of job
  `markets`, scope the report. A search or read never waits on it.
- **A read that finds a report not held fetches it inline**, under the
  call's deadline, joining a fetch in flight; it stops at the report
  that holds the code. search never fetches it.
- **A list older than `LIST_STALE_MS` (two days)**, or none two days
  after start, means the job keeps failing: search names the CFTC in
  `errors` beside what it still found.

## World markets pairs

- **A World markets entry carries `cftc`** where a CFTC market tracks
  it directly (`src/market/world.ts`), its futures symbol too
  (`cftcPair()`), so positioning answers an index, its future, a metal,
  oil, gas, a currency or a coin by its Yahoo symbol. Any other symbol
  finds its market through search; a pair is never guessed from a name.
- **No pair is quoted the other way round**: USD/JPY and USD/CHF are
  quoted against the yen and franc futures, where net long is a bet the
  Yahoo symbol falls, so they carry none and search finds the yen.
- **A pair names the market it read**: some leave out micro contracts
  or are one venue, so the answer is that market's positioning, never
  the whole asset's.
- **A code no longer listed answers `RETIRED`**, never old rows, and the
  read logs `cftc market retired` once a day per code.
- **A test checks every code against the recorded list.**

## Weeks and their figures

- **One call per read once the list is held**: the market's newest
  `HISTORY_WEEKS` (156) weeks and one more, kept in memory per market
  for `POSITIONING_MS` (6 hours, `m.positioning`), so a Friday report
  lands within hours and a repeated read or a next page costs nothing.
- **Each week** has `report_date` (the Tuesday the positions are as
  of, published days later), `open_interest`, and per group `long`,
  `short`, `spread`, `net` (long less short), `net_pct_oi`, `net_change`
  (from the week before) and the trader counts.
- **`cot_index` per group** places the latest net in the range of the
  last `HISTORY_WEEKS` nets, 0 to 100, with the weeks read; null under
  `COT_WEEKS` (52), never a figure from a short range, and its value
  null for a flat range. It reads every fetched week whatever `since`
  is.
- **`latest_report` is the report's newest date**, the weeks' newest
  when a report landed after the list was fetched; `in_latest_report`
  false means the market skipped it, a plain answer, never `stale`.
- **A consolidated market's figures are E-mini equivalents** (micro
  contracts scaled in) and its trader counts may count a trader holding
  both contracts once.
