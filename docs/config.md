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
| `--track <symbol>` | none | keeps an instrument tracked whether read or not, repeated for each; a value is what `quote` takes (`docs/storage.md`, Tracking) |
| `--no-ui` | the UI on | serves no web UI and refuses its sign-in (`docs/web.md`) |
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
  source. A `--track` value is only checked to be non-empty, and a
  repeat is dropped: it resolves in the running server, which may
  fetch it.

## The data directory

| Path | Holds |
|---|---|
| `markets.db` | the one SQLite database (`docs/storage.md`) |
| `markets.log` | the service's log, when run by `service install` (`docs/deploy.md`) |
| `secrets/user-admin.key` | the admin key: it opens `/mcp`, every `/api/v1` route and the web UI's sign-in (`docs/admin.md`, `docs/web.md`) |
| `secrets/source-<name>.key` | a source's API key: `source-fred.key`, `source-finnhub.key`, `source-massive.key` |

## Keys

- **Only `keys.ts` reads key files.** A file holds the bare value,
  trimmed; one absent, empty, not a regular file or over 4,096 bytes
  reads as no key. Keys are read once at start: a changed key needs a
  restart.
- **A first start writes only the admin key** (`startKeys()`):
  `user-admin.key`, `1ctx-markets-admin-` and 32 random bytes in
  base64url, mode 600, in a `secrets/` made mode 700. It writes only
  when no file is there, so an existing key, even an empty or bad one,
  is never replaced. No other name is read: an `admin.key` or
  `bearer.key` left from an older version is ignored.
- **The server will not start without an admin key** of at least 32
  printable ASCII characters (`requireAdmin()`); it exits 1 naming the
  file and how to get a new one, never its contents. It opens `/mcp`
  and holds every `/api/v1` scope.
- **Agents' keys are rows, not files** (`docs/api.md`, "Keys and
  caching"): the admin makes and revokes them on Connect agents
  (`docs/web.md`) or with `1ctx-markets keys` (`docs/admin.md`).
- **A source key turns its source on.** Yahoo needs none and is always
  on; FRED, Finnhub and Massive are on while their file holds a key,
  and every tool answers without them. A keyless optional source is on
  only with its `--source` flag.
- **A key value never reaches a row, a log line, an error or an
  answer.** The logger masks every value `keys.ts` has read (`[key]`)
  in the message and every field, percent-decoded first, since a key
  sent in a URL arrives encoded in the logged path. Pass a source its
  key through `store.source()`, so the mask knows it. An agent key made
  while running joins the mask through `store.mask()` before it is
  answered, and anything shaped like this server's keys
  (`1ctx-markets-`, `admin-` or not, and 43 base64url characters) is
  masked too, so a key made by an earlier run never reaches a line.
- **The server never writes or checks existing files' modes.** Keep
  `secrets/` readable by the service user only (`chmod 700` on the
  directory, `chmod 600` on its files).

## Start log

- **A first start logs `admin key created`** with the file's path,
  never the value.
- **One `startup` line, then one `sources` line**, on stderr in
  slog-text form. `startup` holds `version`, `listen`, `data` (`~` for
  the home directory), `migrations` (applied, or `current`),
  `quote_every`, `track_days` and `ui` (`on` or `off`). `sources` has one field per source:
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
- **One Bun server; a key is checked before an unknown path is
  answered** (`router()`), so it answers 401 without a key and 404
  with one; under `/api/v1` the route is matched first and the key
  held to its scope (`docs/api.md`). Only `GET /health`, the API's spec and its docs
  page, the web UI's page and its sign-in answer without it. The
  admin key's compare hashes both sides with SHA-256 and uses
  `timingSafeEqual`; an agent key is found by its SHA-256
  (`src/server/access.ts`).
  A refusal carries no `WWW-Authenticate`, so an MCP client never
  starts an OAuth sign-in. Each key makes at most 120 calls a minute,
  then 429 (`docs/api.md`, "Keys and caching").

| Path | Method | Serves |
|---|---|---|
| `/mcp` | POST | MCP over Streamable HTTP, stateless |
| `/api/v1/*` | GET, POST, PATCH, DELETE | the REST API, its spec and docs page (`docs/api.md`); each operation takes the read or the admin scope (`docs/admin.md`) |
| `/health` | GET | 200 with no body, for the service's start check |
| `/`, `/status`, `/connect`, `/instruments` | GET | the web UI's page, its assets at the paths it names (`docs/web.md`) |
| `/ui/session` | POST, DELETE | the web UI's sign-in and sign-out (`docs/web.md`) |

- **Any other method is 405 with `Allow`.** `/mcp` is stateless (one
  MCP server instance per request, `src/server/mcp.ts`), so there is
  no GET stream to resume and no session to DELETE.
- **A request body over 1 MiB is refused** with an empty 413 before
  any route runs (`MAX_BODY_BYTES` in `src/server/http.ts`); the API's
  routes hold bodies to their own smaller caps (`docs/api.md`).
- **`/health` needs no key and is never logged**: it holds no data,
  and a service manager polls it while the server starts.
- **Every other request logs one line** with method, path, status,
  duration and the key's id and name (`key=admin` for the admin key); an unhandled error answers 500 with no detail. An MCP SDK
  error is logged by its type and code only, since its message can
  quote the request.
- **The default bind is loopback.** The keys are the only access
  control and the server speaks plain HTTP, so a bind beyond loopback
  sends them in clear unless the network encrypts it (a private
  network such as Tailscale) or a TLS proxy fronts it.

## Shutdown

`SIGINT` and `SIGTERM` run `app.stop()`, then close the database and
exit 0, or exit 1 with the error logged; a second signal during
shutdown is ignored. The order in `stop()` holds:

1. Stop the `--track` tracker between values and the scheduler, so no
   new value or run starts.
2. Close every source queue, so a call waiting out a back-off fails at
   once; calls already sent finish.
3. Stop the HTTP server, so no new request starts.
4. Wait for the runs still going to settle, the source switch's and
   the tracker's too.
5. Wait for every shared fetch still in flight, a read's past its
   deadline included, so no answer lands after the database closes.
6. Close the MCP handler.
7. Close the writer, which refuses new writes and drains the queued
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
  admin key, writes only a prefixed one on a first start, answers
  `/health` without it and 401 to anything else, answers an MCP
  initialize with it and with an agent key `keys add` made, holds that
  key to its scopes, lists and revokes it, serves the web UI and its
  assets, signs in with the admin key into a cookie that holds no key,
  creates `markets.db`, keeps every key out of the log, and prints a
  `--version` starting with `v`.
- **Bun is the only runtime**, at the version in `.bun-version`; there
  is no Node. `make start` and `make dev` run from source.
