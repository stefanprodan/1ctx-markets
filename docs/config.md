# Running the server

Governs the process around the data: `src/main.ts`, `src/config.ts`,
`src/keys.ts`, `src/app.ts`, `src/http.ts`, `src/log.ts`, the build
and smoke scripts in `package.json`, `Makefile` and
`scripts/smoke.sh`. The tools and `GET /quotes` are in
`docs/tools.md`, `GET /alerts` in `docs/rules.md`, `GET /research` in
`docs/research.md`; the database, migrations and retention in
`docs/storage.md`.

## Flags

`config.ts` parses the command line without acting on it; `main.ts`
runs what `parseCli()` answers. `HELP` in `src/config.ts` is the
`--help` text; a flag changes there in the same commit.

| Flag | Default | Meaning |
|---|---|---|
| `--listen <host:port>` | `127.0.0.1:11237` | bind address; the port is after the last colon |
| `--data <dir>` | `~/.1ctx-markets` | holds `markets.db` and `secrets/` |
| `--quote-every <min>` | 5 | minutes between quote passes; a quote two periods behind is `quote overdue` |
| `--track-days <days>` | 30 | an instrument read within this many days stays tracked; news of an untracked one is pruned (`pruneNews`) |
| `--source <name>` | none | turns on a keyless source, repeated for each; `bvb` is the Bucharest feed (`docs/bvb.md`) |
| `-v`, `--version` | | prints the version |
| `-h`, `--help` | | prints the help |

- **There is no config file.** Everything is a flag or a file in the
  data directory. The one environment variable,
  `MARKETS_BUILD_VERSION`, only names the version when run from
  source; a compiled binary has it built in.
- **A bad flag exits 1 with the error and the help.** Counts are whole
  numbers above 0 of at most six digits (`count()`); an empty `--data`
  is refused, and `--listen` needs a host before its last colon; an
  unknown option is refused, never ignored.
- **An unknown `--source` name stops the start** with the list of
  known names (`KNOWN_SOURCES`), so a typo never runs without the
  source.
- **No default market, instrument, benchmark or currency exists.**
  The server runs for any country; what it syncs comes from use.

## The data directory

| Path | Holds |
|---|---|
| `markets.db` | the one SQLite database (`docs/storage.md`) |
| `secrets/bearer.key` | the bearer every request carries |
| `secrets/source-<name>.key` | a source's API key: `source-fred.key`, `source-finnhub.key`, `source-massive.key` |

- **Migrations, the startup write and retention are in
  `docs/storage.md`**; the start line lists the migrations applied or
  says `current`.

## Keys

- **Only `keys.ts` reads key files.** A file holds the bare value,
  trimmed; one absent, empty, not a regular file or over 4,096 bytes
  reads as no key. Keys are read once at start: a changed key needs a
  restart.
- **A first start writes the bearer** (`createBearer()`):
  `1ctx-markets-` and 32 random bytes in base64url, mode 600, in a
  `secrets/` made mode 700. It writes only when no file is there, so an
  existing key, even an empty or bad one, is never replaced.
- **The server will not start without a bearer** of at least 32
  printable ASCII characters (`requireBearer()`); it exits 1 with a
  message naming the file and how to get a new one, never its
  contents.
- **A source key turns its source on.** Yahoo needs none and is always
  on; FRED, Finnhub and Massive are on while their file holds a key,
  and every tool answers without them. A keyless optional source is on
  only with its `--source` flag.
- **A key value never reaches a row, a log line, an error or an
  answer.** The logger masks every value `keys.ts` has read (`MASK`,
  `[key]`) out of the message and every field, percent-decoded first,
  since a key sent in a URL arrives encoded in the logged path. Pass a
  source its key through `store.source()`, so the mask knows it.
- **The server never writes or checks the files' modes.** Create
  `secrets/` and its files readable by the service user only
  (`chmod 700` on the directory, `chmod 600` on its files); the server
  reads them as they are.

## Start log

- **One `startup` line, then one `sources` line**, on stderr in
  slog-text form. `startup` holds `version`, `listen`, `data` (with
  `~` for the home directory), `migrations`, `quote_every` and
  `track_days`. `sources` has one field per source: `yahoo=on`, and
  for the keyed ones `on (key file)` or `off (no key)`, for `bvb`
  `on (flag)` or `off (no flag)`, quoted since they hold a space
  (`fred="on (key file)"`, `src/log.ts`).
- **Log fields are fixed names and short values.** `errorFields()`
  keeps an error's type and first line only, so a stack stays out. A
  source's own text stays out because a `SourceError` message is a
  fixed phrase and a detail the code writes (`src/source.ts`).

## HTTP

- **One Bun server; the bearer is checked before any route is looked
  up** (`router()`), so an unknown path answers 401 without the bearer
  and 404 with it. `GET /health` is the one route checked before it. The compare hashes both sides with SHA-256 and uses
  `timingSafeEqual`, so its time does not depend on what was sent. A
  refusal carries `WWW-Authenticate: Bearer`.

| Path | Method | Serves |
|---|---|---|
| `/mcp` | POST | MCP over Streamable HTTP, stateless |
| `/quotes` | GET | the quote reader for scripts |
| `/research` | GET | research summaries for scripts |
| `/alerts` | GET | the alerts feed |
| `/health` | GET | 200 with no body and no bearer, for the service's start check |

- **Any other method is 405 with `Allow`.** `/mcp` is stateless (one
  MCP server instance per request, `legacy: "stateless"` in
  `src/mcp.ts`), so there is no GET stream to resume and no session to
  DELETE.
- **A request body is at most 1 MiB** (`MAX_BODY_BYTES`).
- **`/health` answers 200 without the bearer and is never logged.**
  It holds no data, so it needs no key, and a service manager polls it
  while the server starts. Every other path still answers 401 without
  the bearer.
- **Every request but `/health` logs one line** with method, path,
  status and duration; an unhandled error answers 500 with no detail. An MCP SDK
  error is logged by its type and code only, since its message can
  quote the request.
- **The default bind is loopback.** The bearer is the only access
  control and the server speaks plain HTTP, so a bind beyond loopback
  sends the bearer in clear unless a TLS proxy fronts it.

## Shutdown

`SIGINT` and `SIGTERM` run `app.stop()`, then close the database and
exit 0, or exit 1 with the error logged; a second signal during
shutdown is ignored (`stopping` in `src/main.ts`). The order in
`stop()` holds:

1. Stop the scheduler, so no new run starts.
2. Close every source queue, so a call waiting out a back-off fails at
   once; calls already sent finish.
3. Stop the HTTP server, so no new request starts.
4. Wait for the runs still going to settle, the source switch's too.
5. Close the MCP handler.
6. Close the writer, which refuses new writes and drains the queued
   ones.

The database closes only after the writer drained, so no write is lost
or runs against a closed connection.

## Build

- **`make build` compiles one standalone binary** to
  `bin/1ctx-markets` with `bun build --compile`. `VERSION=v1.2.3`
  sets what `--version` prints (`MARKETS_BUILD_VERSION`); without it,
  `v` plus `package.json`'s version. `TARGET` cross-compiles.
- **The binary loads no `.env` or `bunfig.toml`** from where it runs
  (`--no-compile-autoload-dotenv`, `--no-compile-autoload-bunfig`), so
  a stray file beside it never configures it.
- **`make smoke` checks the compiled binary**: it refuses to start with
  an empty bearer, writes a prefixed one on a first start, answers
  `/health` without it and 401 to anything else, answers an MCP
  initialize with it, creates `markets.db`, keeps the bearer out of the
  log, and checks `--version` prints a line starting with `v`.
- **Bun is the only runtime**, at the version in `.bun-version`; there
  is no Node. `make start` and `make dev` run from source.
