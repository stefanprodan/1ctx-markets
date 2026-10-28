# 1ctx-markets

A self-hosted market data server for AI agents. It syncs free market
data (Yahoo, and optionally FRED, Finnhub, Massive and the Bucharest
Stock Exchange's own feed) into one SQLite
file, computes signals, evaluates price rules, and serves them over the
Model Context Protocol (MCP, Streamable HTTP) and a REST API under
`/api/v1` with an OpenAPI spec, both behind one bearer key. It holds
market data and price rules only, never holdings, orders or a
portfolio.

- **Runtime:** Bun only, TypeScript run directly, `bun:sqlite`, one
  standalone binary. No Node. The Bun version is pinned in
  `.bun-version`.
- **Packages** are devDependencies bundled at build time: exact pins,
  official npm only, `bun install --ignore-scripts`. A new package
  needs the owner's explicit go-ahead. In `src/`, only `server/mcp.ts`,
  `server/http.ts` and `tools/index.ts` import
  `@modelcontextprotocol/server` (`server/http.ts` a type only); the
  MCP client is for tests. `swagger-ui-dist` is the one package
  `src/api/` imports, and only its
  `swagger-ui-bundle.js` and `swagger-ui.css`, embedded as files
  (`docs/api.md`).

## The dev loop

Everything goes through the Makefile; each target but `help` runs the
`package.json` script of the same name.

```sh
make start ARGS="..."  # run the source in the foreground with the server's flags
make dev ARGS="..."    # the same, restarting on changes
make lint              # biome check --write, then bun check; run after any code change
make test              # bun test; run after any code change, before finishing
make build             # standalone binary in bin/ (VERSION=v1.2.3 for a release)
make smoke             # start the binary, check its bearer and MCP answer, stop it
make clean             # remove bin/ and Bun's build leftovers
make staging-deploy    # build main, back up staging's db, swap its binary, restart
make staging-status    # what the staging service says
make staging-secrets DIR=<dir>  # copy the source keys staging lacks
```

Read the whole output of `make test` and `make lint`; never pipe it
through `tail` or `grep` (`docs/testing.md`).

## Layout

```
src/main.ts                 the entry: flags, the bearer, the db, start()
src/app.ts                  the wiring: sources, queues, jobs, the server, stop()
src/server/                 HTTP and MCP
  http.ts                   the Bun server, the bearer check, the routes
  mcp.ts                    the stateless MCP endpoint
  instructions.ts           the server instructions every MCP client gets
src/runtime/                the process
  config.ts                 flags and the --help text
  keys.ts                   key files, the only reader of secrets/
  log.ts                    slog-text lines on stderr, keys masked
  clock.ts                  the only reader of the wall clock
  scheduler.ts              jobs on a fixed period, driven by the Clock
  lock.ts                   one fetch-and-store per instrument at a time
src/storage/                the database and its write path
  db/                       open(), migrate(), migrations/ (append-only)
  writer.ts                 the one writer queue
  runs.ts                   sync_runs rows
src/market/                 market rules no source owns
  instruments.ts            instruments keyed market:symbol, units
  bars.ts                   daily bars, weeks built from them
  quotes.ts                 the latest quote per instrument, whichever source
  calendars.ts              sessions from the source's answers; zone.ts wall times
  stale.ts                  the stale reasons
  tracking.ts               tracking by use, no ticker list
  format.ts                 the time and number forms every answer uses
src/sources/                what every source shares, each provider under it
  source.ts                 phrases, errors, queue, limiter
  history.ts                backfill window, retry wait, rescales
  ids.ts                    source and market ids
  yahoo/                    the always-on source
  bvb/                      the Bucharest exchange's own feed, on with --source bvb
  fred/                     FRED series as close-only daily bars
  finnhub/                  research sections and earnings events
  massive/                  news
src/signals/                daily, weekly, live and relative signals
src/rules/                  rule conditions, evaluation, alerts
src/operations/             the reads the MCP tools and the API share, with their MCP pages
src/tools/                  the MCP surface: the tool registry and research's page
src/api/                    /api/v1: routes, alerts, the spec, the docs page; never imports tools/
src/service/                `service install|start|stop|...`: launchd, CLI only
src/admin/                  /api/v1/admin/* behind its own key, and the `admin` command
test/                       one *.test.ts per area, helpers/ (fakes), fixtures/ (recordings)
scripts/probe/              the fixture recorders, run by hand
scripts/smoke.sh            the binary's smoke test
scripts/staging.sh          deploy, status and keys of the staging box (host in staging.env)
scripts/bun-version.sh      the Bun version CI installs (.github/workflows/test.yml)
docs/                       the rules of each area (see Docs)
```

## Docs

The files under `docs/` are rules with the same force as this file.
Read the one that covers a change before making it, and change it in
the same commit as the code that changes a rule.

| Doc | Governs |
|---|---|
| `docs/config.md` | flags, the data directory, key files, the start log, HTTP routes, shutdown order, the build and smoke test |
| `docs/admin.md` | the admin key, `/api/v1/admin/*` (status, refetch, delete) and the `admin` command |
| `docs/api.md` | the REST API under `/api/v1`: routes, no paging, errors, keys, caching, the alerts feed, the spec and its contract test, the docs page |
| `docs/deploy.md` | the `service` command, launchd, the kill timeout, the log, staging deploys, backups and keys |
| `docs/storage.md` | the database, migrations, the writer, instruments, times and prices, the clock, runs and staleness, tracking, retention |
| `docs/calendars.md` | market sessions from the source, quoting and checks, bar dates and finality, weeks, wall time, crypto |
| `docs/yahoo.md` | Yahoo's endpoints, parsing, the source queue and phrases, resolution, bars, splits and rescales, quotes, the lock, the jobs |
| `docs/fred.md` | FRED: its key, limits, answer checks, series as instruments, bars, the daily job, attribution |
| `docs/bvb.md` | the Bucharest feed: its pages and chart feed, parsing, the session, quotes, bars and rescales, resolution, switching sources |
| `docs/research.md` | Finnhub research and earnings events, Massive news, the `research` and `events` tools |
| `docs/signals.md` | the daily and weekly signals, final and live rows, reading, relative return |
| `docs/rules.md` | rule conditions, validation, evaluation, the earnings gate, split pauses, the `rules` tool |
| `docs/tools.md` | the answer contract, arguments, each tool, units and staleness, resolution and the inline fetch, the reads the API shares, tool descriptions |
| `docs/testing.md` | the test suite, fakes, the fake clock, fixtures and the recorders |

## Rules the code follows

- **A schema change is an appended migration** in
  `src/storage/db/migrations/`, renames and retypes included. A migration on
  `main` is never edited: running servers hold real data.
- **Every runtime write goes through the one writer queue**
  (`writer(db).write(fn)`), a synchronous closure that never awaits.
  Fetch first, then write.
- **Keys are files beside the database**, one bare value per
  `secrets/<name>.key`, read in `src/` only by `src/runtime/keys.ts` (the
  recorders use `readKey()`, `docs/testing.md`). A key is never
  printed, logged, stored in a row, put in an error or answered.
- **Market hours come from the sources' answers and the exchange's
  IANA zone**, never fixed UTC hours, opening times or holiday lists
  kept by hand.
- **No default markets, instruments, benchmarks or currencies.** The
  server runs for any country; what it syncs is learned from use.
  Every source but Yahoo is optional: off without its key file, or
  without its `--source` flag for a keyless one.
- **A change that adds or renames a tool, an argument or an answer
  field an agent chooses by updates the server instructions**
  (`src/server/instructions.ts`, `docs/tools.md`) in the same PR: they are
  the only guidance across tools a client keeps whole.
- **No SQL, expression or query tool, ever.** The tools are fixed;
  `screen` is the only open-ended read.
- **Live prices drive the answers.** Averages are on closed days plus
  today's price; never add a closed-only variant or a warning about
  intraday prices.
- **No test reaches a network or asserts elapsed time**
  (`docs/testing.md`).
- **Comments explain why, never what,** in one short line where one
  is needed. Style is Biome's: 2 spaces, double quotes, semicolons,
  trailing commas, 80 columns.
- **Commits are `type(scope): imperative summary`**, lowercase, no
  period, 72 characters at most; types `feat`, `fix`, `refactor`,
  `docs`, `test`, `chore`, `build`, `ci`. The body, when there is one,
  is plain sentences on what changed and why.
- `perl -i -pe` for global replaces, `uv run` for ad hoc Python, never
  pip.
