# Running the server

Governs the process around the data: `src/main.ts`,
`src/runtime/config.ts`, `src/runtime/keys.ts`, `src/app.ts`,
`src/server/http.ts`, `src/runtime/log.ts`, the build and smoke scripts
in `package.json`, `Makefile` and `scripts/smoke.sh`. The tools are in
`docs/tools.md`, the HTTP API under `/api/v1` in `docs/api.md`; the
database, migrations and retention in `docs/storage.md`; the `service`
command and staging in `docs/deploy.md`; the admin routes and the
`admin` command in `docs/admin.md`.

## Flags

`parseCli()` in `src/runtime/config.ts` parses the command line
without acting on it; `main.ts` runs what it answers. `HELP` there is
the `--help` text, and a flag changes there in the same commit.

| Flag | Default | Meaning |
|---|---|---|
| `--listen <host:port>` | `127.0.0.1:11238` | bind address; the port is after the last colon |
| `--data <dir>` | `~/.1ctx-markets` | holds `markets.db` and `secrets/` |
| `--quote-every <min>` | 5 | minutes between quote passes; a quote two periods behind is `quote overdue` |
| `--track-days <days>` | 30 | an instrument read within this many days stays tracked; news of an untracked one is pruned |
| `--source <name>` | none | turns on a keyless source, repeated for each; `bvb` is the Bucharest feed (`docs/bvb.md`) |
| `-v`, `--version` | | prints the version |
| `-h`, `--help` | | prints the help |

- **There is no config file.** Everything is a flag or a file in the
  data directory. The one environment variable,
  `MARKETS_BUILD_VERSION`, only names the version when run from
  source; a compiled binary has it built in.
- **A bad flag exits 1 with the error and the help**, never ignored:
  counts are whole numbers from 1 to 999999, `--data` is not empty,
  `--listen` has a host before its last colon, and an unknown option
  or `--source` name is refused, so a typo never runs without its
  source.

## The data directory

| Path | Holds |
|---|---|
| `markets.db` | the one SQLite database (`docs/storage.md`) |
| `markets.log` | the service's log, when run by `service install` (`docs/deploy.md`) |
| `secrets/bearer.key` | the bearer every request carries |
| `secrets/admin.key` | the key of `/api/v1/admin/*` alone (`docs/admin.md`) |
| `secrets/source-<name>.key` | a source's API key: `source-fred.key`, `source-finnhub.key`, `source-massive.key` |

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
  printable ASCII characters (`requireBearer()`); it exits 1 naming the
  file and how to get a new one, never its contents.
- **The admin key is written and checked the same way**
  (`createAdmin()`, `requireAdmin()`), prefixed `1ctx-markets-admin-`,
  and must differ from the bearer. It authorizes `/api/v1/admin/*`
  only.
- **A source key turns its source on.** Yahoo needs none and is always
  on; FRED, Finnhub and Massive are on while their file holds a key,
  and every tool answers without them. A keyless optional source is on
  only with its `--source` flag.
- **A key value never reaches a row, a log line, an error or an
  answer.** The logger masks every value `keys.ts` has read (`[key]`)
  in the message and every field, percent-decoded first, since a key
  sent in a URL arrives encoded in the logged path. Pass a source its
  key through `store.source()`, so the mask knows it.
- **The server never writes or checks existing files' modes.** Keep
  `secrets/` readable by the service user only (`chmod 700` on the
  directory, `chmod 600` on its files).

## Start log

- **A first start logs `bearer key created` and `admin key created`**
  with the file's path, never the value.
- **One `startup` line, then one `sources` line**, on stderr in
  slog-text form. `startup` holds `version`, `listen`, `data` (`~` for
  the home directory), `migrations` (applied, or `current`),
  `quote_every` and `track_days`. `sources` has one field per source:
  `yahoo=on`, the keyed ones `on (key file)` or `off (no key)`, `bvb`
  `on (flag)` or `off (no flag)`.
- **Log fields are fixed names and short values.** `errorFields()`
  keeps an error's type and first line only, so a stack stays out; a
  `SourceError` message is a fixed phrase, so a source's own text
  stays out.

## HTTP

- **A request stays open 30 s** (`IDLE_TIMEOUT_S`), over a tool call's
  15 s deadline, since Bun's 10 s default would cut a call that
  fetches a new symbol.
- **One Bun server; the bearer is checked before any route is looked
  up** (`router()`), so an unknown path answers 401 without the bearer
  and 404 with it. Only `GET /health`, the API's spec and its docs page
  answer without it. The compare hashes both sides with SHA-256 and
  uses `timingSafeEqual`, so its time does not depend on what was sent.
  A refusal carries `WWW-Authenticate: Bearer`.

| Path | Method | Serves |
|---|---|---|
| `/mcp` | POST | MCP over Streamable HTTP, stateless |
| `/api/v1/*` | GET, POST, PATCH, DELETE | the REST API, its spec and docs page (`docs/api.md`); `/api/v1/admin/*` behind the admin key instead of the bearer (`docs/admin.md`) |
| `/health` | GET | 200 with no body, for the service's start check |

- **Any other method is 405 with `Allow`.** `/mcp` is stateless (one
  MCP server instance per request, `src/server/mcp.ts`), so there is
  no GET stream to resume and no session to DELETE.
- **A request body over 1 MiB is refused** with an empty 413 before
  any route runs (`MAX_BODY_BYTES` in `src/server/http.ts`); the API's
  routes hold bodies to their own smaller caps (`docs/api.md`).
- **`/health` needs no bearer and is never logged**: it holds no data,
  and a service manager polls it while the server starts.
- **Every other request logs one line** with method, path, status and
  duration; an unhandled error answers 500 with no detail. An MCP SDK
  error is logged by its type and code only, since its message can
  quote the request.
- **The default bind is loopback.** The bearer is the only access
  control and the server speaks plain HTTP, so a bind beyond loopback
  sends the bearer in clear unless the network encrypts it (a private
  network such as Tailscale) or a TLS proxy fronts it.

## Shutdown

`SIGINT` and `SIGTERM` run `app.stop()`, then close the database and
exit 0, or exit 1 with the error logged; a second signal during
shutdown is ignored. The order in `stop()` holds:

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
  sets what `--version` prints; without it, `v` plus `package.json`'s
  version. `TARGET` cross-compiles.
- **The binary loads no `.env` or `bunfig.toml`** from where it runs,
  so a stray file beside it never configures it.
- **`make smoke` checks the compiled binary**: it refuses an empty
  bearer, writes a prefixed one on a first start, answers `/health`
  without it and 401 to anything else, answers an MCP initialize with
  it, creates `markets.db`, keeps the bearer out of the log, and
  prints a `--version` starting with `v`.
- **Bun is the only runtime**, at the version in `.bun-version`; there
  is no Node. `make start` and `make dev` run from source.
