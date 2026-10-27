# Storage

Governs the database and what every table shares: `src/db/`
(connection and migrations), `src/writer.ts`, `src/instruments.ts`,
`src/quotes.ts`, `src/runs.ts`, `src/stale.ts`, `src/tracking.ts`,
`src/clock.ts` and the retention turn in `src/app.ts`. Market sessions and bar dates are
in `docs/calendars.md`; how Yahoo's answers become rows is in
`docs/yahoo.md`; signal rows in `docs/signals.md`; key files and flags
in `docs/config.md`.

## The file

- **One SQLite file, `markets.db` in the data directory, opened once.**
  `open()` in `src/db/index.ts` sets `journal_mode = wal`,
  `foreign_keys = on` and `busy_timeout = 5000`, then migrates. The
  process holds this one connection for reads and writes; tools read it
  synchronously while the writer queue is the only path that changes
  it. Back it up with SQLite's own backup (`.backup`, `vacuum into`),
  or stop the server before copying `markets.db`.
- **Keys never enter the database.** Each key is a file in `secrets/`
  beside `markets.db` (`bearer.key`, `source-<name>.key`), read only by
  `src/keys.ts`. A key never goes in a row, a log line, an error or an
  answer; a run's error column holds a fixed phrase for this reason.

## Migrations

- **Every schema change is a new migration appended to `MIGRATIONS`**
  in `src/db/migrations/index.ts`, a rename or a retype included. A
  migration on `main` is never edited: a running server has already
  recorded its id and holds real data, so an edit never runs there.
- **`migrate()` runs each unrecorded migration in its own
  transaction** with its row in `migrations` (id, `applied_at`), in list
  order. `0001-init` creates that table itself, so a fresh database has
  nothing recorded.
- **Data tables are `strict`** (the `migrations` ledger is not), **and
  checks hold only what the code guarantees.** A check a source's odd answer can break would fail the
  whole write that carries it (see the comment on `0005-signals`).
- **A migration that moves data writes it in SQL, from the rows
  present.** `0004-scopes-units` fills `instruments.unit` from `type`;
  `0006-tracking` starts `last_read_at` at `updated_at`, so an
  instrument updated within the tracking window stays tracked at the
  upgrade and an older one does not.

## The writer

- **Every runtime write goes through `writer(db).write(fn)`.** `fn` is
  a short synchronous closure run in its own transaction, first in
  first out; a throw rolls back that closure and rejects only its
  caller. A second writer or a direct `db.query(...).run()` outside it
  breaks the ordering every staleness and lock rule relies on.
- **A closure never awaits.** A closure returning a promise is refused
  (`a write closure must not return a promise`): the transaction would
  commit before the awaited writes ran. Fetch first, then queue one
  write with everything it needs (`Answered` in `src/yahoo/sync.ts`).
- **A write that must not land late checks its deadline inside the
  closure.** A queued write can start after the caller gave up, so
  reads that fetch test `live()` again in the closure.
- **`close()` refuses new writes and waits for the queued ones.**
  `stop()` in `src/app.ts` closes it last, after jobs and requests
  settle, and before `main` closes the database.

## Instruments

- **An instrument's key is `market:symbol`, and the key is its
  identity.** `instruments.id` must equal `market || ':' || symbol`.
  The source's own symbol is a column (`source_symbol`, unique per
  source), so a source change keeps the key.
- **A market is the source's exchange code, through an alias table
  where several codes are one market.** `ALIASES` and `marketOf()` in
  `src/yahoo/resolve.ts` map NMS, NGM, NCM, NAS, NYQ, ASE, PCX, BTS and
  PNK to `US`, GER to `XETRA` and CCC to `CRYPTO`; any other code is a
  market of its own, so a new exchange needs no change. Adding an
  alias moves stored keys, so it ships with a migration that re-keys
  every table that names them.
- **`upsertInstrument()` refuses a source symbol stored under another
  key** (`malformed answer`): the source moved the listing, which only a
  re-keying migration fixes. Name and currency keep the stored value
  when an answer omits them.
- **Each instrument has a unit, and an unknown one stays `unknown`.**
  `instruments.unit` is one of `UNITS` in `src/instruments.ts`:
  `per_share`, `percent_of_par`, `index_points`, `percent`,
  `per_unit`, `unknown`. Yahoo's `INDEX` covers both ^VIX's points and
  ^TNX's percent, so its unit is never guessed from the type. Tools
  compare price levels only within one unit and currency.

## Times, dates and prices

- **Every instant is UTC epoch milliseconds in an `integer` column**
  (`*_at`, `time`, `session_start`, `session_end`, `quote_time`).
  Only `src/clock.ts` reads the wall clock; every component takes a
  `Clock`, and tests step a fake one.
- **Every date is `YYYY-MM-DD` in the exchange's zone, never UTC.**
  A bar's date is the local date its session starts on (`barDate()`);
  the zone is the instrument's IANA zone, never an offset
  (`checkZone()` rejects `+02:00`). Columns enforce the shape with
  `glob`.
- **Prices are `real` as the source gives them, never rounded or
  scaled.** The rescale check and the signals compare ratios of stored
  closes (`rescaleOf()` in `src/yahoo/sync.ts` treats ratios within
  0.0001 as one). Volumes are whole numbers (`Math.round`).
- **A quote's `time` is the trade time, null when the source gives
  none** (the Bucharest index page), never the fetch time
  (`src/quotes.ts`). A quote without a time replaces the stored one
  only when fetched later; a live signal row dates it by its fetch, at
  most its stored session's end, so the pass after the close keeps the
  session's row (`liveTarget()`).

## Price sources

- **`sources` holds the price sources on at the last start**, one row
  per name with when it was turned on (migration `0010-bvb`). It is
  written only once a switch of the `BVB` market's source landed
  (`docs/bvb.md`), so a restart during one redoes it; with no rows,
  Yahoo was the only one.

## Runs and staleness

- **Every source job run is a `sync_runs` row** (`startRun`, `endRun`,
  `failRun`, or `runJob()` around a function), with `scope` the market
  of a Yahoo quote, check or bar pass or of Finnhub's whole-market
  calendar, the instrument key for FRED series and for Finnhub and
  Massive runs (each source writes its own through its `recordRun`),
  null otherwise (Yahoo `backfill`).
  At startup `failInterrupted()` fails runs a crash left `running`, in
  the first queued write, so no job's run is taken for one of those.
- **A run's error is a fixed phrase, never an error's text.**
  `phraseOf()` in `src/source.ts` gives the source phrase, `failed`
  for anything else, `interrupted` for a run cut by a crash. Messages
  can echo a key or a URL.
- **Staleness is read from the instrument's own source, job and
  scope.** `lastRun(db, source, job, scope)` is the latest ended run
  in that scope; a failure newer than the last success marks only that
  scope's rows. A search succeeding never clears a failed quote pass,
  and one market's failure never marks another market.
- **A quote pass that answered is judged per instrument.** An
  instrument added before the last ok pass whose quote is older than
  that pass is `no quote in the last pass`, so one symbol that never
  answers marks only itself.
- **A failed refetch is its instrument's own `bars` run** and marks
  only it; the market's run fails only when no instrument answered.
  A refetch that left the last finished session's close owed adds an
  ok `owed` run in the same scope (`docs/yahoo.md`), since only a
  failed run may carry an error.
- **The reasons are fixed phrases in `STALE`** (`src/stale.ts`); a
  tool answers the phrase, never prose of its own. Add a reason there.

| Phrase | Set by | When |
| --- | --- | --- |
| `quote sync failed` | `quoteStale` | the market's last quote pass failed |
| `no quote in the last pass` | `quoteStale` | last pass ok, this instrument's quote did not come back |
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
| `source off` | `quoteStale`, `barsStale` | a feed instrument whose source the last landed switch turned off (the `sources` table lacks it), so its prices are its last |
| `extended: no pre- or post-market trading` | `readExtended` | quote's `extended` asked: the source's flag says the listing has none, or it is crypto |
| `extended: not reported by its source` | `readExtended` | quote's `extended` asked of a listing not priced by Yahoo (another price source, a FRED series) |
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
  named it within `TRACK_DAYS` (30, `--track-days`) or any rule reads
  it, paused or not (`trackedIds()` in `src/tracking.ts`). Every
  scheduled job syncs only tracked instruments, so all jobs follow the
  same set.
- **Only reads count.** `markRead()` runs in the writer after a tool's
  targets resolve (`readTargets()` in `src/tools/targets.ts`), and only
  before the call's deadline. Searches and jobs never mark a read.
  `markRead()` never moves `last_read_at` back.
- **An untracked instrument is caught up inside the read that names
  it** (`catchUp()` in `src/yahoo/sync.ts`); an unknown symbol is
  fetched inside the call (`fetchInstrument()`).

## Retention

- **One prune runs in the startup write and on the daily `retention`
  job** (`prune` in `src/app.ts`), since a server restarted daily never
  reaches the daily turn.

| Table | Kept |
| --- | --- |
| `sync_runs` | 30 days by `started_at` (`RUNS_KEPT_MS`) |
| `research` | 24 months by period; the one `metric` row per instrument stays |
| `events` | 24 months by date, unless a rule waits on the event |
| `news` | 30 days by `published_at`; all of an untracked instrument |
| `news_walks` | all of an untracked instrument (`pruneNews`) |
| `alerts` | 90 days by `fired_at` (`ALERTS_KEPT_DAYS`) |

- **Instruments, bars, splits, quotes, signals and markets are never
  pruned.** An instrument that stops being tracked keeps its history;
  a read later catches it up from its last final bar, not a backfill.
  Only the operator's delete removes one, with every row of it
  (`docs/admin.md`).
- **Alert ids are never reused** (`autoincrement`): the alerts feed
  reads the id as its cursor and reports a hole after it as a
  retention gap.
