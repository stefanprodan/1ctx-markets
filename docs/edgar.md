# SEC EDGAR

Governs the US Securities and Exchange Commission's EDGAR source:
`src/sources/edgar/client.ts` (calls and answer checks), `items.ts`
(the Form 8-K item names), `store.ts` (tickers, filings, flags,
staleness), `sync.ts` (one share's fetch) and `jobs.ts` (the daily
pass), and the `edgar_tickers`, `edgar_filers` and `filings` tables
(`src/storage/db/migrations/0019-edgar.ts`). The queue, deadlines,
phrases and the lock every source shares are in `docs/sources.md`; the
`research` sections, the research route and events in
`docs/research.md`; key files in `docs/config.md`.

## On and off

- **EDGAR is on only while `secrets/source-edgar.key` holds a contact
  line**: a name and an email, which SEC asks every client to declare
  in its User-Agent. It needs no key, but the line holds an email, so
  it is read, masked and never answered like a key, and one on/off
  mechanism serves every source. The start log says `edgar=on (key
  file)`.
- **Off is an answer, never an error**: `NO_DATA` ("no data from
  EDGAR") with every flag null.
- **The contact line goes only in the User-Agent header.** Nothing of
  an answer is kept but checked accession numbers, form names, dates,
  times and item codes (a code not shaped `d.dd` is dropped), so no
  answer text can carry it back. The recorder never stores request
  headers and scrubs the line from what it stores.

## Calls and limits

- **One limiter at `SPACING_MS` (200 ms), five calls a second**, half
  SEC's stated ten, so a burst of tool calls never earns a block.
- **A 403 or 429 is "rate limited" and backs the queue off** for five
  minutes: SEC answers 403 to a client over its limit or without a
  declared contact. A 404 is "not found", a 400 "bad request", neither
  backing off; any other status is "source error".
- **Two calls exist**: `www.sec.gov/files/company_tickers.json`, every
  listed ticker and its CIK (800 KB), and
  `data.sec.gov/submissions/CIK##########.json`, a company's filings
  of at least the last year (`recent`; older pages are never asked).

## Tickers

- **A share's CIK comes from SEC's ticker map**, stored whole in
  `edgar_tickers` and replaced each fetch. SEC writes a class share as
  Yahoo does (`BRK-B`), so the instrument's symbol is the lookup.
- **The map is fetched weekly** (`TICKERS_EVERY_MS`) by the job, and
  inside a call when none was ever stored. It runs as `tickers`, scope
  `US`. An answer with no valid entry is malformed and replaces
  nothing; a single odd entry is skipped.
- **A share the map lacks is stored without a CIK**, a good run with
  no rows, and answers `NO_DATA` with the reason `not in SEC's ticker
  list`. The weekly map picks up new listings.

## Filings

- **Kept forms** (`KEPT_FORMS`): 10-K, 10-Q, 8-K and their amendments,
  NT 10-K and NT 10-Q, and the offering forms S-1, S-1/A, S-3, S-3/A,
  S-3ASR, 424B1, 424B4 and 424B5. 424B2 and 424B3 are left out: a bank
  files thousands a year for notes, never shares, and they would bury
  every other filing and set the offering flag every day.
- **Stored per filing** (`filings`, keyed by instrument and accession):
  form, accepted time (UTC ms), filed date, period, 8-K item codes and
  the filing index URL. Two years are kept (`KEPT_MS`), pruned by
  retention.
- **`acceptanceDateTime` is UTC.** Checked against SEC's filing index
  page, which shows the same moment in Eastern time.
- **A kept filing that does not parse fails the whole answer**
  (malformed): skipping it could hide the very filing a flag is for.
  So does an answer for another CIK or columns of unequal length.
- **A foreign filer is out of scope.** The newest periodic report in
  the answer decides: 20-F, 40-F or 6-K is foreign, 10-K or 10-Q is
  not. A foreign filer keeps no filings and answers `NO_DATA` with the
  reason `foreign filer`: its figures arrive late or not at all.
- **A ticker that moved to another company keeps none of the old
  one's filings**: a store drops rows whose URL names another CIK.
- **8-K items carry names** from a fixed table of SEC's item list
  (`ITEM_NAMES`); a code SEC adds later has a null name, never a
  guessed one.

## Jobs

- **Each tracked US share is fetched once a day after the US close**
  (`dueAt`): due once the market's stored session has ended and
  `AFTER_CLOSE_MS` (two hours) passed, when after-close results are
  filed; until then the last fetch stands. The session comes from the
  calendar (`docs/calendars.md`), never a fixed hour; with none stored
  a fetch is due a day after the last.
- **Cost**: one call per tracked US share a day, plus the ticker map
  once a week; none while no US share is tracked. A failure waits
  `RETRY_MS` (60 minutes).
- **A share never fetched is fetched inside the call** that reads it
  (`docs/research.md`), the map first when none is stored. A passed
  deadline stores nothing.
- **Staleness** (`filerState`, `STALE_FILINGS`): "no filings yet",
  "filings sync failed", "filings sync pending" (no good run since the
  last close's due time).

## Flags

Read from stored filings by accepted time; null when EDGAR is off, the
share was never fetched, has no CIK or is a foreign filer, never false:

| Flag | True when | Why the window |
|---|---|---|
| `late_filing` | an NT 10-K or NT 10-Q in the last 90 days | one quarter, as a 10-Q is due within one |
| `restatement` | an 8-K or 8-K/A with item 4.02 in the last 365 days | a year of reports leans on the restated ones |
| `offering` | an S-1, S-3 or 424B1/4/5 in the last 90 days | a new share offering dilutes within the quarter |

## Events

- **An event's `filed_at`** is the acceptance time of the first 8-K
  with item 2.02 (results) whose date in the exchange's zone is within
  `FILED_WINDOW_DAYS` (three) of the event's date: when results went
  out. It is null without one or while EDGAR is off. It never changes
  `reported_seen_at` or the status, which stay Finnhub's actuals.
