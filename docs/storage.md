# Storage

Governs the database and what every table shares: `src/storage/db/`
(connection and migrations), `src/storage/writer.ts`,
`src/market/instruments.ts`, `src/market/quotes.ts`,
`src/market/intraday.ts`, `src/storage/runs.ts`, `src/market/stale.ts`, `src/market/tracking.ts`,
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
- **Key values never enter the database** (`docs/config.md`, Keys): a
  run's error column holds a fixed phrase, and at most the stored
  symbols it names, for this reason. Agent keys
  are rows in `keys` holding only a SHA-256 of the token, never the
  token (`docs/api.md`, "Keys and caching").

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
- **A check is changed by rebuilding the table in the migration**, as
  SQLite alters none in place: a `_next` table with every column, check
  and index, the rows copied by id, the old table dropped and the new
  renamed (`0014-run-ids`, `0026-fund-trades`). A table that points at
  itself (`positions.replaces`) points the new one at itself, so the
  old one drops with nothing pointing at it under `foreign_keys`, and
  its `sqlite_sequence` row is carried over, so an id is never given
  twice.
- **A table other tables point at is rebuilt with foreign keys off**
  (`foreignKeys: false` on the migration, `0036-owners`): a plain drop
  would fail or cascade into its children. `migrate()` turns the pragma
  off around the transaction, since it is a no-op inside one, and
  refuses to commit unless `pragma foreign_key_check` is empty. The
  children name the parent by name, so the renamed copy keeps them.
- **An owner column has no default**, so a write that names none fails
  instead of landing on the operator.

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
- **A fund the owner prices is keyed `fund:<ISIN>`** with source
  `owner` (`FUND_MARKET`, `FUND_SOURCE` in `src/sources/ids.ts`): every
  source's market is upper case (`marketOf()` upper-cases the code), so
  the lower-case `fund` is never a listing's, and every read that
  upper-cases a key (`readTargets()`, `restStored()`) never finds it.
  No source fetches it and no job tracks it (`docs/portfolios.md`).
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
  `unknown`.** Yahoo's `INDEX` is `index_points`, ^VIX's and ^TNX's too,
  a yield index's points being its yield in percent; its `FUTURE` holds
  per-barrel and per-bond prices alike, so stays `unknown`. Price levels
  compare only within one unit and currency (`docs/alerts.md`,
  "Validation"; screen's `mixed_units` in `docs/tools.md`).

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
- **`rules.fired_session` is the session date a rule last fired in**
  (`0045-rules-fired-session`, `YYYY-MM-DD` in its symbol's exchange
  zone, null before its first alert), set in the write that inserts the
  alert, so a restart keeps the once-a-session limit (`docs/alerts.md`).
  Rules from before it start null: one may fire once more that day.
- **Alerts keep their tables' old names**: an alert is a `rules` row
  and a trigger an `alerts` row, the condition stored as its JSON tree
  with internal camelCase keys and instrument ids, never as the `when`
  text callers send and read (`docs/alerts.md`), so the text form needed
  no migration. A trigger's `snapshot` keeps that tree and every value
  read, and is rendered as text on each read.
- **A key's alerts access is `keys.alerts`** (`none`, `read`, `write`),
  the column `0023-key-rules` added as `rules` and `0046-key-alerts`
  renamed, its check and values kept.

## Price sources

- **`sources` holds the price sources on at the last start**, written
  only once a switch of the `BVB` market's source landed
  (`docs/bvb.md`), so a restart during one redoes it; with no rows,
  Yahoo was the only one.

## Runs and staleness

- **Every source job run is a `sync_runs` row** (`runJob()`, or
  `startRun`/`endRun`/`failRun`). Its `scope` is the market for a Yahoo
  quote, check or bar pass, Finnhub's whole-market calendar and EDGAR's
  ticker map, the instrument key for FRED, Finnhub, Massive, EDGAR
  filings, Yahoo valuation and Yahoo top holdings runs, null otherwise. Ids are `autoincrement`, never reused:
  an admin delete removes an instrument's runs while a job may still
  hold one's id. At startup `failInterrupted()` fails runs a crash left
  `running`, in the first queued write, so no job's run is taken for one
  of those.
- **A run's error is a fixed phrase, never an error's text**
  (`phraseOf()` in `src/sources/source.ts`, `failed` otherwise,
  `interrupted` after a crash, `stopped` for a run cut by shutdown, which no stale reason, retry wait or status count reads as a failure), since messages can echo a key or a
  URL. A Yahoo quote or check run that failed by its own symbols, ones
  a split narrowed to or a pass left out while others answered, names
  them after the phrase, at most `MAX_NAMED` (3) then `+N more`
  (`runError()`, `source error: AMD`); a call that failed whole keeps
  the bare phrase. Readers match the phrase by its start.
- **Staleness is read from the instrument's own source, job and
  scope** (`lastRun()`): a failure newer than the last success marks
  only that scope's rows. A search succeeding never clears a failed
  quote pass, and one market's failure never marks another.
- **A quote pass that answered is judged per instrument**, so one
  symbol that never answers marks only itself. A failed pass marks
  only the quotes fetched before it started: one it stored is fresh,
  though the run stays failed on Server admin's Status and in the log.
- **A failed refetch is its instrument's own `bars` run** and marks
  only it; the market's run fails only when no instrument answered. A
  refetch that left a close owed adds an ok `owed` run in the same
  scope (`docs/yahoo.md`), since only a failed run may carry an error.
- **The reasons are fixed phrases in `STALE`** (`src/market/stale.ts`);
  a tool answers the phrase, never prose of its own.

| Phrase | Set by | When |
| --- | --- | --- |
| `quote sync failed` | `quoteStale` | the market's last quote pass failed, and the quote predates its start |
| `no quote in the last pass` | `quoteStale` | last pass ok, this instrument (added before it) not in it |
| `no quote yet` | `quoteStale` | no quote stored |
| `quote overdue` | `quoteStale` with `due` | quote older than two quote periods before the last time one was due |
| `session check failed` | `quoteStale` | the market's last closed-market check failed, and the quote predates its start |
| `bar sync failed` | `barsStale`, `seriesStale` | the market's last bar pass or the instrument's own refetch failed (FRED: the series' last run) |
| `bar sync pending` | `barsStale` | a session began after the last ok bar pass (`barsDue`), the instrument added before it |
| `bar sync pending` | `seriesStale` | FRED: no run ended well since the latest 23:00 UTC (`seriesDue`), the series added before it |
| `no history` | `barsStale`, `seriesStale` | no daily bars stored |
| `signals pending` | `readSignals` | final signals behind the final bars, live rows behind the latest quote, or a newest bar not final that no live row reaches while a newer quote exists |
| `previous day not final` | `readSignals` | a live row stepped over a stored bar not final yet |
| `source switch pending` | `quoteStale`, `barsStale` | the market's latest source switch run is running or failed (`SWITCH`) |
| `source off` | `quoteStale`, `barsStale` | a feed instrument whose source the last landed switch turned off, so its prices are its last |

- **Why an asked extended price is missing is not staleness**: it goes
  in `extended_reason` beside quote's `extended` and history's
  `extended_points`, fixed phrases in `EXTENDED`, so `stale` stays about
  the regular quote:

| Phrase | Set by | When |
| --- | --- | --- |
| `no pre- or post-market trading` | `readExtended` | the source's flag says the listing has none, or it is crypto |
| `not reported by its source` | `readExtended` | a listing not priced by Yahoo |
| `no price since the regular close` | `readExtended` | no pre or post bar has a price since the last regular close |
| `regular session open` | `readExtended` | the stored session or the chart's regular window holds now |
| `not fetched in time` | `readExtended` | the chart missed the call's deadline |
| `fetch failed` | `readExtended` | the chart call failed |
| `none in the sessions answered` | `extendedOut` | history's `5m`: the read held points of other sessions only |

- **`quote overdue` follows when a quote was last due**
  (`lastQuoteDue`): now while the market trades (always for crypto),
  its post-close quote once closed, nothing before its stored session
  begins. It catches downtime and a missed close; a session left from
  Friday on Monday is what `session check failed` covers.

## Tracking by use

- **There is no ticker list but World markets.** An instrument is
  tracked while a read named it within `--track-days` (30), any rule
  reads it, paused or not, it is on the saved dashboard, a trade or
  position not removed names it (`portfolioInstruments()`), a fund the
  owner prices aside, or it is in World markets (`trackedIds()`).
- **World markets is the one built-in list** (`src/market/world.ts`):
  indices, commodities, currencies and crypto in six groups, five US
  indices and the Nikkei with their index futures, the BET and EUR/RON
  only while the Bucharest source is on. It holds no zone or hours:
  each instrument's come from its source's answer, as for any symbol.
  It changes by PR, never at run time. The instrument list counts a held one as
  tracked without naming why, since holdings are private. Every
  scheduled job syncs only tracked instruments, so all jobs follow the
  same set.
- **World markets' ids live in memory only** (`Tracking.world`, filled
  by `tracker()` in `src/operations/track.ts`): no column, so the build
  is the one source of truth and a symbol dropped from the list is
  untracked at the next start, its history kept (Retention).
- **`main.ts` passes the list; `start()` defaults to none**, so a test
  app never resolves it against a fetch that throws. Tests pass a small
  list.
- **A stored symbol whose source is on is marked at start, before the
  startup prune** (`seed()`), so its news stays. One that may have
  missed a session (no bar changed since its market's latest known
  session began, or the quote job's next check for a newer one is
  already due, `nextCheck()`; a FRED series while `seriesStale()` has
  a reason) is also owed a catch-up (`Tracking.owed`): a read takes it
  as untracked and catches it up, as does the tracker's first pass, and
  whichever fetch lands first clears it.
- **The tracker resolves the rest through `resolveTargets()`**, the
  read path without `markRead()`, on start and on the `track` job each
  quote period, so an unknown symbol is fetched with its backfill as in
  a call. It asks one symbol at a time in the reads' lane, every entry
  before any futures pair so a new Home fills first, so a read waits
  behind one of its calls at most, and a symbol is tracked as soon as
  it resolves. Each has twice a call's deadline.
- **A value that does not resolve never stops the server:** it is
  logged once per reason and retried, except `candidates` and
  `refused`, which only a new build, a flag or a key can change. `no_data` is final
  only for a value not stored: a stored one asks no source to answer it,
  and a source switch can end it.
- **Only reads count.** `markRead()` runs in the writer after a tool's
  targets resolve (`readTargets()` in `src/operations/targets.ts`), and
  only before the call's deadline; it never moves `last_read_at` back.
  Searches and jobs never mark a read.
- **An untracked instrument is caught up inside the read that names
  it** (`catchUp()` in `src/sources/yahoo/sync.ts`), and an unknown
  symbol is fetched inside the call (`docs/tools.md`).

## Portfolios

- **Five tables and a key column** (`0020-portfolios`): `portfolios`
  and `brokers` (names), `trades` and `positions` (each with who
  entered it and when, and a removal stamp), `portfolio_settings` (the
  owner's display currency) and `keys.portfolio` (`none`, `read`,
  `write`); `0021-stated-on` adds `trades.stated_on`, the day a trade's
  figures are stated as of; `0022-trade-indexes` indexes live trades by
  date and trades by broker, so holdings never scan the table (an
  owner's trades are read by their portfolios, and only those sorted);
  `0024-time-zone` adds `portfolio_settings.time_zone`, the owner's IANA
  zone, null until named; `0025-position-market` adds
  `positions.market`, the market cash named, null unless named;
  `0026-fund-trades` adds `funds` (a fund the owner prices: its
  instrument and the market its money is in) and `fund_prices` (a price
  per unit per fund and day, the buy it came from or null for the
  owner's, and who entered it and when), drops fund positions and
  rebuilds `positions` with kinds `cash` and `bond` and without
  `units` and `price`, which only funds used, its other rows, columns,
  indexes and ids as they were; `0031-cash-no-market` clears
  `positions.market`, since cash counts by its currency and a bond by
  its listing: no code reads or writes the column, kept so an older
  binary still opens the database; `0032-cash-portfolio` adds
  `portfolios.cash`, the mark on the one portfolio that holds all cash
  (a partial unique index keeps it to one), marks a portfolio named
  Cash holding only cash or renames one holding more to "Cash
  (before)", makes Cash when the display currency is set or cash is
  kept, and moves every cash row, removed ones too, into it.
  Rows are never deleted but a portfolio with no live row, its removed
  rows with it, and a broker no live row names; what they mean is
  `docs/portfolios.md`.

## The profile

- **One table and a key column** (`0033-profile`): `profile_versions`
  (each revision of the owner's profile: its number, full text, bytes,
  author and time; the highest is the live one) and `keys.profile`
  (`none`, `read`, `write`), `none` for every key, the ones made
  before too. A save inserts a revision and deletes those past the
  last 100 in the same write; what they mean is `docs/profile.md`.
  `0036-owners` keys it `(owner, revision)`.

## The analysis

- **One table and a key column** (`0041-analysis`): `analysis_versions`
  (each revision of a symbol's analysis, keyed `(symbol, revision)`:
  its full text, bytes, author, `user_id` of the person who wrote it,
  set null when they go, the stored quote's `price`, `currency` and
  `priced_at` at the save, null with none, and `created_at`; a symbol's
  highest revision is the live one) and `keys.analysis` (`none`,
  `read`, `write`), `none` for every key, the ones made before too.
  `analysis_by_symbol` on `(symbol, revision, created_at, bytes,
  author)` lets the list, a pointer and the revisions read no text.
  `symbol` references no instrument, so deleting an instrument leaves
  its analysis. A save inserts a revision and deletes the symbol's
  revisions past the last 100 in the same write, as the profile's;
  what they mean is `docs/analysis.md`. About 4 KiB a note rewritten
  daily keeps 400 KiB a symbol at the cap.

## Trade plans

- **Three tables and a key column** (`0047-trade-plans`), all strict:
  `trade_plans` (one row a plan: `id`, `owner` referencing `users`, the
  live `revision`, `removed_at` and `removed_by`, both null or both
  set, `created_at`, `updated_at`, the live revision's time),
  `trade_plan_versions` (each revision keyed `(plan, revision)`, the
  whole state: `name`, `text`, `bytes`, `status` `active` or
  `archived`, `review_by`, `symbols` as a JSON array of instrument
  ids for history only, `author`, `created_at`) and
  `trade_plan_symbols` (`(plan, symbol)`, the live revision's tags,
  rewritten by each save, with `trade_plan_symbols_by_symbol` on
  `(symbol, plan)` for quote and the instrument page), and
  `keys.trade_plans` (`none`, `read`, `write`), `none` for every key,
  the ones made before too. Revisions and tags go with their plan (on
  delete cascade).
- **`symbol` references no instrument**, as `analysis_versions.symbol`:
  a reference would block the admin's delete of an instrument or reach
  into a plan's history, and the id stays in the tag, matched again if
  the instrument comes back.
- **A save is one write**: it rechecks the caller, the live revision,
  the active-name rule and the 100 active plans, inserts the revision,
  rewrites the tags and deletes the plan's revisions past the last 100,
  the live one never among them. A delete or restore sets or clears
  `removed_at` and makes no revision. What they mean is
  `docs/trade-plans.md`.

## People and owners

- **`users` holds the people** (`0036-owners`): `id`, `name`, `email`
  (lower case, unique, null until people sign in by email), `role`
  (`admin` or `member`), `created_at`, `last_sign_in_at`, and
  `alerts_pruned` (the newest of their alert ids retention deleted, for
  the alerts feed), and `alerts_seen` (`0044-alerts-seen`, 0 until
  set: the newest of their alert ids the web UI showed, so the rail
  counts the newer ones; `docs/alerts.md`). The migration made
  `operator`, an admin, the owner of every row before it;
  `user-admin.key` is the operator.
- **A person's rows name them**: `portfolios.owner`, `brokers.owner`,
  `portfolio_settings.owner` (was `admin`), `dashboards.owner` (was
  `operator` already), `rules.owner`, `alerts.owner` (copied from the
  rule, as an alert outlives it), `keys.user_id`,
  `profile_versions.owner` and `trade_plans.owner`, each referencing
  `users`; a plan's revisions and tags are owned through it. Trades and
  positions are owned through their portfolio. Portfolio and broker
  names are unique per owner, and Cash is one per owner
  (`portfolios_one_cash` on `(owner) where cash`).
- **Funds and their prices have no owner**: `fund_prices.user_id` is
  who entered a price, by hand or by their buy, set null when they go,
  and `fund_prices.trade` is set null when its buy is deleted, so a
  shared price outlives one person's rows (`docs/portfolios.md`).
- **Market data and tracking stay shared**: anyone's read, rule,
  dashboard card or holding tracks an instrument for all.
- **Sign-ins are rows holding only a SHA-256** (`0037-people`), as
  1ctx's: `logins` (`user_id` on delete cascade, `admin_digest` on the
  operator's admin-key logins, `token_hash`, `created_at`,
  `last_seen_at`, `expires_at`), `links` (`user_id` on delete cascade,
  `purpose` `invite` or `sign_in`, `token_hash`, `code_hash`,
  `challenge_hash`, `code_tries`, `email` for an address it sets,
  `created_at`, `expires_at`, `used_at`), `link_asks` (`user_id`, set
  null when the person goes, the asking browser's `challenge_hash` and
  `asked_at`, kept a day so the caps count asks whatever became of
  their links) and `link_misses` (wrong codes at an invite per trying
  browser, going with the link). Expired logins, used or expired links
  and asks past a day go with the startup and daily prunes
  (`pruneLogins()`).
- **`smtp_settings` is one row or none** (`0037-people`): the email
  settings, never the password, which is a key file
  (`docs/admin.md`, "Email").
- **A key's name is unique per person** (`unique (user_id, name)`,
  `0037-people`, a rebuild of `keys` nothing points at).
- **`portfolio_viewers` holds who sees whose portfolios**
  (`0038-sharing`): `owner` and `viewer`, both `users.id` on delete
  cascade, `created_at`, primary key `(owner, viewer)`, indexed by
  `viewer` for the rail's list; removing either person deletes the row
  (`docs/portfolios.md`).

## The dashboard

- **Three tables hold the web UI's home page** (`0017-dashboard`):
  `dashboards` (one row per owner with its `revision`),
  `dashboard_sections` (`name` and `view` by `position`) and
  `dashboard_items` (each section's instruments by `position`), one
  layout per person, the owner a `users.id`.
- **An item references `instruments(id)` on delete cascade**, so
  deleting an instrument drops its card and a favourite never blocks
  the delete (a rule still does); a section's items go with it the same
  way.
- **A save replaces the whole layout in one write** and moves the
  revision by one (`saveDashboard()` in `src/admin/dashboard.ts`).

## Bucharest listings

- **`bvb_listings` holds the Bucharest exchange's list pages as last
  read** (`0018-bvb-listings`): `kind` (`shares`, `units`, `bonds`,
  `indices`), `symbol`, `isin`, `name`, `type` and `listed_at`, keyed
  by kind and symbol. A page read again replaces its kind's rows in
  one write. It refers to no instrument: a listing is not stored as one
  until fetched.
- **Search matches it by substring, so a full scan is the plan:** a
  few hundred rows, well under a millisecond; no index would serve a
  match inside a name.

## Intraday closes

- **`intraday` holds the 5-minute closes of the spark answers**
  (`src/market/intraday.ts`, `docs/yahoo.md`): `session` the point's
  local date in the instrument's zone (`localDate()`), never the
  answer's current period, `at` UTC, `close`, `fetched_at` the
  answer's. The key `(instrument, session, at)` serves replacing and
  pruning a session.
- **An answer replaces each session it holds; one with no points
  deletes nothing.** Each answer holds its session so far, so a missed
  pass or a restart leaves no hole once the next pass runs; a
  session's last minutes are lost only when no pass ran between its
  last trade and the next session's start (crypto at 00:00 UTC).
- **`INTRADAY_SESSIONS` (5) per instrument:** a write drops sessions
  older than the newest five. An instrument holding fewer is filled
  once a process from a five-day chart, which adds only sessions not
  stored (`addIntraday()`, `docs/yahoo.md`, Jobs); a day missing
  inside five stored sessions stays missing.
- **Cleared with the prices:** a source switch's `clear()`, a confirmed
  rescale (`store()` in `src/sources/yahoo/history.ts`; the next quote
  pass refills the session, no ratio is guessed), and the operator's
  delete (`INSTRUMENT_TABLES`).
- **No session before the instrument's newest split is stored**
  (`splits`): a quote pass holds no per-instrument lock, so an answer
  fetched before a rescale and written after it would bring old-scale
  points back. A rescale with no split still clears every session.
- **Only history's `5m`, the chart's 1D and 5D, and a currency pair's
  daily close read it** (`docs/yahoo.md`, Daily bars); signals, rules,
  movers and screen never do, and the live price stays the quote's. A
  pair's close taken from a session's points is marked in
  `bars.point_close`, so it outlives their prune.

## Valuations

- **`valuations` holds Yahoo's EPS and PEG per US share**
  (`0029-valuations`, `src/sources/yahoo/valuation.ts`): `eps_ttm`,
  `eps_forward`, `peg`, `currency` and `fetched_at`, one row per
  instrument, for a share Finnhub answers from a foreign listing
  (`docs/research.md`). A new answer replaces the row, one in another
  currency or with no figure deletes it, and a failed one keeps it;
  staleness is read from its runs. No history: P/E is worked out from
  it at answer time.

## Fund top holdings

- **Three tables hold Yahoo's top ten of a listed fund**
  (`0030-fund-top-holdings`, `src/sources/yahoo/top-holdings.ts`):
  `fund_top_holdings`, one row per instrument with `fetched_at`, the
  six positions and `government` (nullable); `fund_top_holding_rows`,
  `rank` 1 to 10, `symbol` (null for a bare exchange code), `name`
  and `weight`; and `fund_weights`, `kind` `sector` or `rating`, `key`
  and `weight`. Weights are Yahoo's fractions. All reference
  `instruments` and are in `INSTRUMENT_TABLES`.
- **One write replaces the three for an instrument**; an answer with
  none deletes them, a failed one keeps them. No history. The names
  keep clear of the owner-priced `funds` tables, which are private
  holdings (`docs/portfolios.md`).
- **A fund the owner prices keeps its hand-entered holdings in the same
  three tables** (`src/portfolios/fund-holdings.ts`), so they read as
  an ETF's. `0039-fund-holdings-as-of` adds `as_of` (the day the rows
  and the six positions are as of) and `sectors_as_of` to
  `fund_top_holdings`, both null for Yahoo's; `fetched_at` is when they
  were last entered and a row's `symbol` column holds a stored
  instrument's id.
  Yahoo's job never asks for or replaces them (`asked()`).

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
| `filings` | two years by `accepted_at` (`pruneFilings`), the restatement flag's year and the one before it |
| `alerts` | 90 days by `fired_at` (`ALERTS_KEPT_DAYS`) |
| `intraday` | the newest `INTRADAY_SESSIONS` sessions per instrument, on each write (above) |
| `valuations` | the one row per instrument, replaced by each answer |
| `fund_top_holdings`, `fund_top_holding_rows`, `fund_weights` | the fund's rows, replaced by each answer, deleted with the instrument |

- **Instruments, bars, splits, quotes, signals and markets are never
  pruned.** An instrument that stops being tracked keeps its history,
  so a later read catches it up from its last final bar, not a
  backfill. Only the operator's delete removes one (`docs/admin.md`).
- **Alert ids are never reused** (`autoincrement`): the alerts feed
  reads the id as its cursor and reports a hole after it as a
  retention gap.
