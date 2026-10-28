# FRED

Governs the Federal Reserve Economic Data (FRED) source of the
St. Louis Fed: `src/sources/fred/client.ts` (calls and answer checks),
`sync.ts` (series as instruments, observations as bars) and `jobs.ts`
(the daily refetch and staleness), all under `src/sources/fred/`. The
queue, deadlines, retries, backfill, phrases, scrubbing and the lock
every source shares are in `docs/sources.md`; how the bars become
signals in `docs/signals.md`; key files in `docs/config.md`; runs,
tracking and staleness in `docs/storage.md`; the answer pages in
`docs/tools.md`.

## On and off

- **FRED is on only while `secrets/source-fred.key` in the data
  directory holds a key.** `src/app.ts` builds no client and schedules
  no job without it, and every source but Yahoo is optional, so no
  code path may assume FRED exists.
- **Off is an answer, never an error.** `addSeries` returns
  `{ kind: "off" }` and a tool item carries `no_data` with `NO_DATA`
  ("no data from FRED"). That holds for a stored series too
  (`storedStep()` sends it to `fredStep()` in
  `src/operations/targets.ts`): its rows are never served while FRED
  is off.

## The key

- **FRED takes its key only in the URL, so no URL may leave the
  client.** The `api_key` query parameter is added inside `get`; a
  fetch failure becomes the fixed phrase "network error" or "timed
  out" because the thrown text can quote the URL.
- **FRED answers 400 for both a refused key and an unknown series;**
  `refusal` tells them apart by `error_message` and maps them to "key
  refused" or "not found" without repeating it; any other 400 is "bad
  request".
- **Every text field of a series' metadata is scrubbed** (`scrubbed`:
  the id, title, units, frequency and notes). Observations hold only
  checked dates and decimals, so they carry no text.
- **The logger masks every key the keys module read**
  (`src/runtime/log.ts`, `src/runtime/keys.ts`); that is a backstop,
  not a licence to log a URL.

## Calls and limits

- **One call at a time, at most `CALLS_PER_MINUTE` (60) starts in any
  minute**, half of FRED's 120, so a job and tools sharing the client
  never trip it. The minute window lives in `fred()`, in place of a
  spacing limiter; `close()` fails a call waiting for its slot.

## Answer validation

A short or doubled answer would rewrite stored history, so
`parseSeries` and `parseObservations` refuse anything not exactly as
expected, with "malformed answer":

| Check | Why |
| --- | --- |
| `seriess` holds exactly one series with id, title, units, short units, frequency | another shape is not the series asked |
| the answered id equals the id asked, case-blind (`addSeries`) | a different series would be stored under this key |
| `offset` is 0 and the rows equal `min(count, limit)` | a missing or surplus day would delete or add bars |
| a history asked by start date fits one page (`count` not above the rows) | a second page would be missed and old days dropped |
| each date a real calendar date, none twice | a duplicate has no single value |
| a value is `"."` (no observation, never 0) or matches `DECIMAL` | `Number()` reads `"0x10"` as 16 and `""` as 0 |

## Series and instruments

- **Only daily series are kept** (`frequency_short` "D", else
  `Refused` with `DAILY_ONLY`), because every signal assumes daily
  bars.
- **A series is the instrument `FRED:<ID>`** of market `FRED`, type
  `SERIES`, zone `UTC`, no currency. `seriesId` takes `DGS10` or
  `fred:dgs10`, uppercases it and allows only `[A-Z0-9_]{1,40}`; the
  lookup in `src/operations/targets.ts` sends any `FRED:` prefix here
  before Yahoo.
- **The unit comes from FRED's units, never a guess** (`unitOf`):
  "%" or "Percent" is `percent`, units starting "Index" are
  `index_points`, anything else is `unknown`.
- **A series whose notes forbid passing the values on is still kept**
  for the server's own callers; `parseSeries` flags it as
  `restricted`.

## Bars

- **An observation is a daily bar with only a close, dated by its
  observation date, and final once fetched** (`barsOf`): FRED
  publishes closed days only. Open, high, low and volume are null,
  which the signals read as close-only (`docs/signals.md`).
- **A revision replaces the stored value; a day the answer now leaves
  out goes.** `store` upserts, then `deleteDailyBars` removes stored
  days inside the answer's date span that it no longer holds (a `"."`
  or a missing row). The weeks are rebuilt from the span and
  `signalsAfterBars` recomputes from the earliest changed date in the
  same write. Weeks turn final once their Sunday has ended in UTC.
- **A new series is backfilled from the shared ten-year Monday**
  (FRED's own `backfillStart` in `sync.ts`; `docs/sources.md`,
  Backfill). Metadata and history are stored in one write under the
  instrument's lock, rechecked after the lock, and only while the
  caller's `live()` holds.
- **A refetch asks the last `REFETCH_OBSERVATIONS` (30) observations**
  so late and revised values land. When the oldest one answered is
  after the last stored day, it asks again from that day so a gap is
  never left. A series with no bars is backfilled instead.

## The daily job

- **One pass a day at 23:00 UTC on the server's clock** (`DAILY_AT_MS`,
  `dueAt`), never a market's hours: a FRED-only server may know no
  market. A minute tick decides what is due, so a pass missed while
  the server was down runs on start.
- **Each series records its own run, scoped to its instrument key
  `FRED:<ID>`** (`JOBS.bars`), so one dead series never marks another
  stale. A failed series waits `RETRY_MS` (60 minutes, FRED's own, in
  `jobs.ts`); a series added after the latest 23:00 is not due, since
  its backfill is newer.
- **Only tracked series are fetched** (`trackedInstruments`). A tool
  reading a stored series that is no longer tracked refetches it
  inside the call.
- **The run's end and the rule evaluation share one write**, so rules
  read the series once it is no longer due.
- **Stale reasons come from the series' own runs** (`seriesStale`):
  "no history", "bar sync failed" when its last run failed, "bar sync
  pending" when today's pass has not ended well.

## Answers

- **A FRED series has no live quote.** It has no quotes row, so no
  live signal row; the quote item is `kind: "observation"` with
  `price` null and the last observation and its date. `change` is the
  last two observations' difference; `change_percent` is null for a
  percent unit, since a yield moves in points. Movers and screen's
  distance filters skip it. Its stale list is the final rows' list
  alone.
- **Every answer carrying FRED values ends with `ATTRIBUTION`**, as
  FRED's terms ask. It appears once per page and only when that page
  holds a FRED value: quote pages and quotes answers with an
  observation, history of a series or against one as benchmark,
  screen with a FRED benchmark or a FRED match on the page. A new
  answer showing FRED values must add it the same way.
- **History states `FRED_BASIS`** (`src/operations/history.ts`):
  values as FRED publishes them, a revision replacing the earlier
  value.
