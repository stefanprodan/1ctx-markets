# Storage

Governs the database and what every table shares: `src/storage/db/`
(connection and migrations), `src/storage/writer.ts`,
`src/market/instruments.ts`, `src/market/quotes.ts`,
`src/storage/runs.ts`, `src/market/stale.ts`, `src/market/tracking.ts`,
`src/runtime/clock.ts` and the retention turn in `src/app.ts`. Market
sessions and bar dates are in `docs/calendars.md`; how a source's
answers become rows is in its own doc and `docs/sources.md`; signal
rows in `docs/signals.md`; key files and flags in `docs/config.md`.

## The file

- **One SQLite file, `markets.db` in the data directory, opened once**
  in WAL mode with foreign keys on (`open()` in
  `src/storage/db/index.ts`). Tools read the one connection
  synchronously; only the writer queue changes it. Back it up with
  SQLite's own backup (`.backup`, `vacuum into`), or stop the server
  before copying `markets.db`.
- **Keys never enter the database** (`docs/config.md`, Keys): a run's
  error column holds a fixed phrase for this reason.

## Migrations

- **Every schema change is a new migration appended to `MIGRATIONS`**
  in `src/storage/db/migrations/index.ts`, a rename or a retype
  included. A migration on `main` is never edited: a running server
  has recorded its id and holds real data, so an edit never runs
  there.
- **`migrate()` runs each unrecorded migration in its own
  transaction** with its row in `migrations`, in list order.
- **Data tables are `strict`, and checks hold only what the code
  guarantees**: a check a source's odd answer can break fails the
  whole write that carries it.
- **A migration that moves data writes it in SQL from the rows
  present**, a value a changed rule derives included, since only a new
  listing's fetch would write it (`0006-tracking`, `0013-index-units`).

## The writer

- **Every runtime write goes through `writer(db).write(fn)`**: a short
  synchronous closure in its own transaction, first in first out; a
  throw rolls back that closure and rejects only its caller. A second
  writer or a direct write outside it breaks the ordering every
  staleness and lock rule relies on.
- **A closure never awaits.** One returning a promise is refused,
  since the transaction would commit before the awaited writes ran.
  Fetch first, then queue one write with everything it needs
  (`Answered` in `src/sources/yahoo/sync.ts`).
- **A write that must not land late checks its deadline inside the
  closure** (`live()`): a queued write can start after the caller gave
  up.
- **`close()` refuses new writes and waits for the queued ones**; it
  runs last in `stop()` (`docs/config.md`, Shutdown).

## Instruments

- **An instrument's key is `market:symbol`, and the key is its
  identity.** The source's own symbol is a column (`source_symbol`,
  unique per source), so a source change keeps the key.
- **A market is the source's exchange code, through `ALIASES`** in
  `src/sources/yahoo/resolve.ts` where several codes are one market;
  any other code is a market of its own, so a new exchange needs no
  change. Adding an alias moves stored keys, so it ships with a
  migration that re-keys every table that names them.
- **`upsertInstrument()` refuses a source symbol stored under another
  key** (`malformed answer`): the source moved the listing, which only
  a re-keying migration fixes. Name and currency keep the stored value
  when an answer omits them.
- **Each instrument has a unit (`UNITS`), and an unknown one stays
  `unknown`.** Yahoo's `INDEX` is `index_points`, ^VIX's and ^TNX's
  too. Price levels compare only within one unit and currency
  (`docs/rules.md`, "Validation"; screen's `mixed_units` in
  `docs/tools.md`).

## Times, dates and prices

- **Every instant is UTC epoch milliseconds in an `integer` column.**
  Only `src/runtime/clock.ts` reads the wall clock; every component
  takes a `Clock`, so tests step a fake one.
- **Every date is `YYYY-MM-DD` in the exchange's zone, never UTC**: a
  bar's date is the local date its session starts on (`barDate()`),
  in the instrument's IANA zone, never an offset (`checkZone()`).
- **Prices are `real` as the source gives them, never rounded or
  scaled**, since rescale checks and signals compare ratios of stored
  closes. Volumes are whole numbers.
- **A quote's `time` is the trade time, null when the source gives
  none, never the fetch time** (`src/market/quotes.ts`). A quote
  without a time replaces the stored one only when fetched later; a
  live signal row dates it by its fetch, at most its stored session's
  end, so the pass after the close keeps the session's row
  (`liveTarget()`).

## Price sources

- **`sources` holds the price sources on at the last start**, written
  only once a switch of the `BVB` market's source landed
  (`docs/bvb.md`), so a restart during one redoes it; with no rows,
  Yahoo was the only one.

## Runs and staleness

- **Every source job run is a `sync_runs` row** (`runJob()`, or
  `startRun`/`endRun`/`failRun`). Its `scope` is the market for a
  Yahoo quote, check or bar pass and Finnhub's whole-market calendar,
  the instrument key for FRED, Finnhub and Massive runs, null
  otherwise. At startup `failInterrupted()` fails runs a crash left
  `running`, in the first queued write, so no job's run is taken for
  one of those.
- **A run's error is a fixed phrase, never an error's text**
  (`phraseOf()` in `src/sources/source.ts`, `failed` otherwise,
  `interrupted` after a crash), since messages can echo a key or a
  URL.
- **Staleness is read from the instrument's own source, job and
  scope** (`lastRun()`): a failure newer than the last success marks
  only that scope's rows. A search succeeding never clears a failed
  quote pass, and one market's failure never marks another.
- **A quote pass that answered is judged per instrument**, so one
  symbol that never answers marks only itself.
- **A failed refetch is its instrument's own `bars` run** and marks
  only it; the market's run fails only when no instrument answered. A
  refetch that left a close owed adds an ok `owed` run in the same
  scope (`docs/yahoo.md`), since only a failed run may carry an error.
- **The reasons are fixed phrases in `STALE`** (`src/market/stale.ts`);
  a tool answers the phrase, never prose of its own.

| Phrase | Set by | When |
| --- | --- | --- |
| `quote sync failed` | `quoteStale` | the market's last quote pass failed |
| `no quote in the last pass` | `quoteStale` | last pass ok, this instrument (added before it) not in it |
| `no quote yet` | `quoteStale` | no quote stored |
| `quote overdue` | `quoteStale` with `due` | quote older than two quote periods before the last time one was due |
| `session check failed` | `quoteStale` | the market's last closed-market check failed |
| `bar sync failed` | `barsStale`, `seriesStale` | the market's last bar pass or the instrument's own refetch failed (FRED: the series' last run) |
| `bar sync pending` | `barsStale` | a session began after the last ok bar pass (`barsDue`), the instrument added before it |
| `bar sync pending` | `seriesStale` | FRED: no run ended well since the latest 23:00 UTC (`seriesDue`), the series added before it |
| `no history` | `barsStale`, `seriesStale` | no daily bars stored |
| `signals pending` | `readSignals` | final signals behind the final bars, or live rows behind the latest quote |
| `previous day not final` | `readSignals` | a live row stepped over a stored bar not final yet |
| `source switch pending` | `quoteStale`, `barsStale` | the market's latest source switch run is running or failed (`SWITCH`) |
| `source off` | `quoteStale`, `barsStale` | a feed instrument whose source the last landed switch turned off, so its prices are its last |
| `extended: no pre- or post-market trading` | `readExtended` | the source's flag says the listing has none, or it is crypto |
| `extended: not reported by its source` | `readExtended` | a listing not priced by Yahoo |
| `extended: no price since the regular close` | `readExtended` | no pre or post bar has a price since the last regular close |
| `extended: regular session open` | `readExtended` | the stored session or the chart's regular window holds now |
| `extended: not fetched in time` | `readExtended` | the chart missed the call's deadline |
| `extended: fetch failed` | `readExtended` | the chart call failed |

- **`quote overdue` follows when a quote was last due**
  (`lastQuoteDue`): now while the market trades (always for crypto),
  its post-close quote once closed, nothing before its stored session
  begins. It catches downtime and a missed close; a session left from
  Friday on Monday is what `session check failed` covers.

## Tracking by use

- **There is no ticker list.** An instrument is tracked while a read
  named it within `--track-days` (30) or any rule reads it, paused or
  not (`trackedIds()`). Every scheduled job syncs only tracked
  instruments, so all jobs follow the same set.
- **Only reads count.** `markRead()` runs in the writer after a tool's
  targets resolve (`readTargets()` in `src/operations/targets.ts`), and
  only before the call's deadline; it never moves `last_read_at` back.
  Searches and jobs never mark a read.
- **An untracked instrument is caught up inside the read that names
  it** (`catchUp()` in `src/sources/yahoo/sync.ts`), and an unknown
  symbol is fetched inside the call (`docs/tools.md`).

## Retention

- **One prune runs in the startup write and on the daily `retention`
  job** (`prune` in `src/app.ts`), since a server restarted daily never
  reaches the daily turn.

| Table | Kept |
| --- | --- |
| `sync_runs` | 30 days by `started_at` (`RUNS_KEPT_MS`) |
| `research` | 24 months by period; the one `metric` row per instrument stays |
| `events` | 24 months by date, unless a rule waits on the event |
| `news` | 30 days by `published_at`, which reads filter to whether or not retention ran; all of an untracked instrument |
| `news_walks` | all of an untracked instrument (`pruneNews`) |
| `alerts` | 90 days by `fired_at` (`ALERTS_KEPT_DAYS`) |

- **Instruments, bars, splits, quotes, signals and markets are never
  pruned.** An instrument that stops being tracked keeps its history,
  so a later read catches it up from its last final bar, not a
  backfill. Only the operator's delete removes one (`docs/admin.md`).
- **Alert ids are never reused** (`autoincrement`): the alerts feed
  reads the id as its cursor and reports a hole after it as a
  retention gap.
