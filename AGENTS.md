# 1ctx-markets

A self-hosted market data server for AI agents. It syncs free market
data (Yahoo, and optionally FRED, Finnhub and Massive) into one SQLite
file, computes signals, evaluates price rules, and serves them over the
Model Context Protocol (MCP, Streamable HTTP) and a small read-only
HTTP API, both behind one bearer key. It holds market data and price
rules only, never holdings, orders or a portfolio.

- **Runtime:** Bun only, TypeScript run directly, `bun:sqlite`, one
  standalone binary. No Node. The Bun version is pinned in
  `.bun-version`.
- **Packages** are devDependencies bundled at build time: exact pins,
  official npm only, `bun install --ignore-scripts`. A new package
  needs the owner's explicit go-ahead. In `src/`, only `mcp.ts`,
  `http.ts` and `tools/index.ts` import `@modelcontextprotocol/server`
  (`http.ts` a type only); the MCP client is for tests.

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
```

Read the whole output of `make test` and `make lint`; never pipe it
through `tail` or `grep` (`docs/testing.md`).

## Layout

```
src/main.ts         the entry: flags, the bearer, the db, start()
src/app.ts          the wiring: sources, queues, jobs, the server, stop()
src/config.ts       flags and the --help text
src/keys.ts         key files, the only reader of secrets/
src/log.ts          slog-text lines on stderr, keys masked
src/http.ts         the Bun server, the bearer check, the routes
src/mcp.ts          the stateless MCP endpoint
src/clock.ts        the only reader of the wall clock
src/writer.ts       the one writer queue
src/db/             open(), migrate(), migrations/ (append-only)
src/source.ts       what every source shares: phrases, queue, limiter
src/lock.ts         one fetch-and-store per instrument at a time
src/scheduler.ts    jobs on a fixed period, driven by the Clock
src/calendars.ts    sessions from the source's answers; src/zone.ts wall times
src/bars.ts         daily bars, weeks built from them
src/instruments.ts  instruments keyed market:symbol, units
src/runs.ts         sync_runs rows; src/stale.ts the stale reasons
src/tracking.ts     tracking by use, no ticker list
src/yahoo/          client, resolve, sync, jobs: the always-on source
src/fred/           FRED series as close-only daily bars
src/finnhub/        research sections and earnings events
src/massive/        news
src/signals/        daily, weekly, live and relative signals
src/rules/          rule conditions, evaluation, alerts
src/tools/          the MCP tools, GET /quotes, /research, /alerts
test/               one *.test.ts per area, helpers/ (fakes), fixtures/ (recordings)
scripts/probe/      the fixture recorders, run by hand
scripts/smoke.sh    the binary's smoke test
scripts/bun-version.sh  the Bun version CI installs (.github/workflows/test.yml)
docs/               the rules of each area (see Docs)
```

## Docs

The files under `docs/` are rules with the same force as this file.
Read the one that covers a change before making it, and change it in
the same commit as the code that changes a rule.

| Doc | Governs |
|---|---|
| `docs/config.md` | flags, the data directory, key files, the start log, HTTP routes, shutdown order, the build and smoke test |
| `docs/storage.md` | the database, migrations, the writer, instruments, times and prices, the clock, runs and staleness, tracking, retention |
| `docs/calendars.md` | market sessions from the source, quoting and checks, bar dates and finality, weeks, wall time, crypto |
| `docs/yahoo.md` | Yahoo's endpoints, parsing, the source queue and phrases, resolution, bars, splits and rescales, quotes, the lock, the jobs |
| `docs/fred.md` | FRED: its key, limits, answer checks, series as instruments, bars, the daily job, attribution |
| `docs/research.md` | Finnhub research and earnings events, Massive news, the `research` and `events` tools, `GET /research` |
| `docs/signals.md` | the daily and weekly signals, final and live rows, reading, relative return |
| `docs/rules.md` | rule conditions, validation, evaluation, the earnings gate, split pauses, the `rules` tool, `GET /alerts` |
| `docs/tools.md` | the answer contract, arguments, each tool, units and staleness, resolution and the inline fetch, `GET /quotes`, tool descriptions |
| `docs/testing.md` | the test suite, fakes, the fake clock, fixtures and the recorders |

## Rules the code follows

- **A schema change is an appended migration** in
  `src/db/migrations/`, renames and retypes included. A migration on
  `main` is never edited: running servers hold real data.
- **Every runtime write goes through the one writer queue**
  (`writer(db).write(fn)`), a synchronous closure that never awaits.
  Fetch first, then write.
- **Keys are files beside the database**, one bare value per
  `secrets/<name>.key`, read in `src/` only by `src/keys.ts` (the
  recorders use `readKey()`, `docs/testing.md`). A key is never
  printed, logged, stored in a row, put in an error or answered.
- **Market hours come from the sources' answers and the exchange's
  IANA zone**, never fixed UTC hours, opening times or holiday lists
  kept by hand.
- **No default markets, instruments, benchmarks or currencies.** The
  server runs for any country; what it syncs is learned from use.
  Every source but Yahoo is optional and off without its key file.
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
