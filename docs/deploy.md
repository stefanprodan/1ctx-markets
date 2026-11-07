# Deploying the server

Governs running the binary as a service, the staging scripts, releases,
the container image and Docker Compose: `src/service/`,
`scripts/staging.sh`, `scripts/staging.env.example`,
`.github/workflows/release.yml`, `Dockerfile`, `.dockerignore`,
`deploy/docker/`, `scripts/archive.sh`, `scripts/image.sh`,
`scripts/image-smoke.sh`, `THIRD_PARTY_LICENSES.md` and their `Makefile`
and `package.json` targets. Flags, `GET /health` and
the shutdown order are in `docs/config.md`.

## The OS service (`1ctx-markets service`)

`1ctx-markets service install|start|stop|restart|status|uninstall`
runs the compiled binary as a service of the signed-in user, started
at login and restarted when it exits. Only macOS (launchd) is supported
today; any other platform answers `service is not supported on
<platform> yet`.

- **`src/service/` is CLI only**: it imports only
  `runtime/config.ts` and `runtime/clock.ts`, opens no database and
  reads no key, and `main.ts` runs it before the admin key and the
  database. `service.ts` knows no platform; a new service manager is a
  `ServiceBackend` picked in `backendFor()`.
- **The launchd label is `dev.1ctx.markets`**, a LaunchAgent in
  `~/Library/LaunchAgents/dev.1ctx.markets.plist`, with `HOME` set and
  the data directory as its working directory.
- **`install` parses its options with the server's `parseCli()`**, so
  it refuses what the server would before touching anything. It pins a
  relative `--data` to where it was typed and writes every option out,
  defaults included (`configToArgs()`), so a later default change
  never moves a running service. `start`, `restart` and `status` read
  the options back from the definition.
- **A definition that is not ours (another `Label`), lacks the
  binary's absolute path or `--data`, or holds options the server
  would refuse is `service
  definition is invalid`**: `start`, `restart` and `uninstall --purge`
  refuse it, `status` shows it, `stop` and a plain `uninstall` work.
- **`install` needs the compiled binary** and refuses to replace a
  running service without `--restart`, which is the switch anywhere
  but right after a flag that takes a value.
- **A start waits for `GET /health` and a pid**, once a second for up
  to 60 tries, at the listen address (loopback for a wildcard bind):
  another listener on the port would answer `/health` for a job that
  keeps crashing.
- **The kill timeout is 45 seconds** (`EXIT_TIMEOUT`, launchd's
  `ExitTimeOut`): a source call already sent ends within its 30-second
  timeout, then the writer drains its queue. That bounds the server's
  own work, not a client holding a request open; launchd's kill is the
  backstop and loses no committed data, since each SQLite write is
  atomic. It stays under the 60 seconds `service stop` waits
  (`WAIT_MS` in `launchd.ts`), so a stop never reports a timeout while
  launchd is still to kill.
- **A stop waits for the process, not only the label**: launchd forgets
  the job while the server still drains and holds the port, and a start
  into that window fails.
- **The plist is staged and read back before anything stops**, so a bad
  write never takes a running service down. It is mode 644 whatever
  the umask, since launchd refuses one others can write.
- **The log is `markets.log` in the data directory and rotates only on
  install**: launchd holds it open while the service runs, so past
  8 MiB it moves to `.1` between the stop and the start.
- **`uninstall --purge` removes the database and the log, never
  `secrets/`**: `markets.db` with its `-wal` and `-shm`, `markets.log`
  and `.1`, in the directory the definition names. A definition it
  cannot read is refused rather than guessed at. A file already gone is
  no error; any other failure stops the purge and is reported.
- **Tests fake the backend and launchctl** (`test/service.test.ts`,
  `test/service-launchd.test.ts`) on the fake clock; no test runs
  `launchctl`.

## Staging

Staging is a Mac reached over ssh that runs the server for real use
beside other services; its database holds real data and is never
wiped. It runs the binary through `1ctx-markets service` with its data
under `~/.1ctx-markets` and the binary in `~/.1ctx-markets/bin`.
`scripts/staging.sh` drives it, behind `make staging-deploy`,
`make staging-status` and `make staging-secrets DIR=<dir>`.

- **The host is never in a tracked file.** It is `STAGING_SSH` in the
  gitignored `scripts/staging.env`, copied from `staging.env.example`
  with `STAGING_LISTEN` and `STAGING_FLAGS`.
- **Staging binds `0.0.0.0:11238`** so clients on the tailnet reach it;
  Tailscale encrypts the plain HTTP, and the keys still guard every
  route but `/health`. 1ctx on the same box uses `127.0.0.1:11238`.
- **Staging always runs `--source bvb` and `--data ~/.1ctx-markets`.**
  `STAGING_FLAGS` holds extra server flags only; one holding `--data`
  is refused, since the backups and keys stay in `~/.1ctx-markets`.
- **The listen and flags are checked before any ssh** by `parseCli()`
  from the commit being built, since the binary is swapped before the
  install runs. They reach the box quoted one by one for an explicit
  `bash`, so its login shell (zsh globs `[::1]`) never reparses them.
- **ssh runs with `BatchMode=yes` and `ConnectTimeout=10`**, so a
  missing key or a down box fails at once instead of prompting.
- **`make staging-deploy` takes `main` only**: it refuses another
  branch or a dirty checkout unless `ALLOW_BRANCH=1`, before any ssh.
  A migration that ran on staging is never edited again, like one
  merged to `main`.
- **The binary is checked before it leaves**: built with
  `VERSION=v<package version>+<commit>` (`.dirty<hash>` on a bypassed
  dirty tree), it must print that version.
- **A deploy backs the database up before it swaps the binary**: a
  `sqlite3 .backup` into `~/.1ctx-markets/backups`, out of WAL
  (`journal_mode=delete`) so it is one file, integrity-checked (a copy
  that fails is removed and the deploy stops), the last three kept.
  The new binary is uploaded beside the live one and renamed over it,
  so an interrupted copy never leaves a truncated executable; then
  `service install --restart` runs with the env's listen and flags.
- **An install that fails after the swap needs a manual redeploy,** and
  the backup restored if the new binary's migration ran.
- **`make staging-secrets DIR=<dir>` copies only the `source-*.key`
  files the box lacks** into `~/.1ctx-markets/secrets` (700, files
  600). Each value goes over ssh stdin, never in an argument or the
  output, which names files only. The admin key is never copied: the
  box's first start writes its own, and its agents' keys are made there.
- **Admin actions run on the box over ssh** with `1ctx-markets admin
  status|retry|refetch|delete` (`docs/admin.md`), which calls the
  installed service on loopback, so it keeps running.

## Releases

A release is a GitHub release with binaries, plus a container image on
the GitHub Container Registry (GHCR), both made by
`.github/workflows/release.yml` when a version tag is pushed.

- **A `v*` tag releases only a commit on `main`.** CI has already
  linted and tested it, so the release does not. The tag must be
  `vMAJOR.MINOR.PATCH[-PRERELEASE]`; a `-` makes a GitHub prerelease.
  The binaries and the image are built with `VERSION` set to the tag,
  and the Linux amd64 binary must print it for `--version`.
- **Every archive is built on one Linux amd64 runner.** Bun
  cross-compiles Linux arm64 and macOS arm64 (the macOS build ad-hoc
  signed), each checked with `file`; only the amd64 binary runs the
  smoke test there. `scripts/archive.sh <os>_<arch>` packs
  `dist/1ctx-markets_<os>_<arch>.tar.gz` with `LICENSE` and
  `THIRD_PARTY_LICENSES.md`; `1ctx-markets_checksums.txt` holds their
  SHA-256 sums and carries a build provenance attestation.
- **The image is `ghcr.io/stefanprodan/1ctx-markets:<tag>`, never
  `latest`,** for linux/amd64 and linux/arm64, its description taken
  from `package.json`, with a provenance attestation. `make image-smoke`
  runs before it is pushed.
- **One Bun version.** `.bun-version` is what every workflow installs;
  `scripts/bun-version.sh` fails when the Dockerfile's
  `oven/bun:<version>@sha256:<digest>` pin differs, so the archives and
  the image come from the same Bun.
- **`THIRD_PARTY_LICENSES.md` holds the license of every package the
  release bundles,** with lightweight-charts' NOTICE and the web UI's
  fonts. `test/third-party-licenses.test.ts` bundles with the release
  options and fails on a bundled package the file has no `## <name>`
  section for, so a new dependency cannot ship without its license.

## The container image

- **The build cross-compiles on `$BUILDPLATFORM`.** Bun builds every
  platform natively, so nothing runs under emulation. The binary's
  `.env` and `bunfig.toml` autoload is off, since its working directory
  is the data volume.
- **`.dockerignore` is an allowlist.** The tree holds key files
  (`.preview/`, `workspace/`); only what the build reads enters the
  context: `package.json`, `bun.lock`, `tsconfig.json`,
  `scripts/build.ts`, `src/`, `skills/` (embedded in the binary) and the
  two license files.
- **The container runs as user 65532 on a read-only root, with no Linux
  capabilities.** The server writes only under `/data`; keep it so.
  The licenses are in `/usr/share/doc/1ctx-markets/`.
- **`CMD` holds the server flags (`--listen 0.0.0.0:11238 --data
  /data`); arguments replace it whole,** so a Docker Compose `command:`
  or `docker run` arguments repeat every flag they keep.
- **`/data` is a named volume, never a bind mount on Docker Desktop or
  OrbStack.** Their file sharing breaks the POSIX locks SQLite's WAL
  needs. A new named volume takes the image's `/data` with its owner
  65532. On a Linux host a bind mount works once it is
  `chown 65532:65532`.
- **`/data/secrets` is mounted read-only.** The owner writes
  `user-admin.key` (32 or more printable ASCII characters) and any
  `source-<name>.key` before the first start, each readable by 65532
  (mode 644). The server keeps an existing admin key and writes nothing
  else there; on a read-only mount it cannot write one, so a missing
  admin key fails the start.
- **`make image-smoke` runs the image as Docker Compose does**: a fresh
  named volume, read-only secrets holding an admin key, a read-only
  root, no capabilities, and `--no-sync` so no source is called. It
  checks `--version` and the startup line's version, a refused `/mcp`
  without a key and an MCP `initialize` with it, that the key file is
  unchanged and nothing else was written beside it, then stops the
  container with SIGTERM and requires exit 0. `make image` builds and
  loads the image for the host; `PLATFORMS=linux/amd64,linux/arm64
  make image` only builds both into the cache.
- **CI runs `make image-smoke` and `docker compose config` on both
  Compose files** in `build-test`, on every pull request, after the
  binary's smoke test.

## Docker Compose

- **`deploy/docker/compose.yaml` runs a release by `MARKETS_VERSION`,
  the tag,** which it requires. It publishes port 11238 on loopback only, mounts the
  named volume `data` at `/data` and `./secrets` read-only at
  `/data/secrets`, with a read-only root, no capabilities and
  `no-new-privileges`. `deploy/docker/secrets/` is gitignored.
- **`compose.dev.yaml`, layered over it with `MARKETS_VERSION=dev`,
  builds from the checkout and never pulls.**
- **The stop grace is 45 seconds,** the service's kill timeout: a source
  call already sent ends within its 30-second timeout, then the writer
  drains its queue. Docker's 10-second default would cut the drain; a
  plain `docker run` passes `--stop-timeout 45`.
