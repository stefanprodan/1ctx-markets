# Deploying the server

Governs running the binary as a service and the staging scripts:
`src/service/`, `scripts/staging.sh`, `scripts/staging.env.example` and
their `Makefile` and `package.json` targets. Flags, `GET /health` and
the shutdown order are in `docs/config.md`.

## The OS service (`1ctx-markets service`)

`1ctx-markets service install|start|stop|restart|status|uninstall`
runs the compiled binary as a service of the signed-in user, started
at login and restarted when it exits. Only macOS (launchd) is supported
today; any other platform answers `service is not supported on
<platform> yet`.

- **`src/service/` is CLI only.** It imports `runtime/config.ts`
  and `runtime/clock.ts`, opens no database and reads no key; `main.ts` runs it
  before the bearer and the database. `service.ts` knows no platform; a
  new service manager is a `ServiceBackend` picked in `backendFor()`.
- **The launchd label is `dev.1ctx.markets`**, a LaunchAgent in
  `~/Library/LaunchAgents/dev.1ctx.markets.plist`, with `HOME` set and
  the data directory as its working directory.
- **`install` parses its options with the server's `parseCli()`.** It
  refuses what the server would, before touching anything, pins a
  relative `--data` to where it was typed and writes every option out
  (`configToArgs()`), defaults included, so a later default change
  never moves a running service. `start`, `restart` and `status` read
  the options back from the definition. One that is not our plist
  (binary, empty or torn), lacks the binary's absolute path or `--data`,
  or holds options the server would refuse is `service definition is
  invalid`: `start`, `restart` and `uninstall --purge` refuse it,
  `status` shows it, `stop` and a plain `uninstall` work.
- **`install` needs the compiled binary** and refuses to replace a
  running service without `--restart`, which is the switch anywhere but
  right after a flag that takes a value.
- **A start waits for `GET /health` and a process**, once a second for
  up to 60 tries, at the listen address (loopback for a wildcard bind).
  The job must also show a pid, since another listener on the port
  would answer `/health` for a job that keeps crashing.
- **The kill timeout is 45 seconds** (`EXIT_TIMEOUT`, launchd's
  `ExitTimeOut`): a source call already sent ends within its 30-second
  timeout, then the writer drains its queue (`docs/config.md`,
  Shutdown). That bounds the server's own work, not a client that holds
  a request open; launchd's kill is the backstop, and it loses no
  committed data since each SQLite write is atomic. It stays under the
  60 seconds `service stop` waits for the process to exit (`WAIT_MS` in
  `launchd.ts`), so a stop never reports a timeout while launchd is
  still to kill.
- **A stop waits for the process, not only the label.** launchd forgets
  the job while the server still drains and holds the port, and a start
  into that window fails.
- **The plist is staged and read back before anything stops**, so a bad
  write never takes a running service down. It is written mode 644
  whatever the umask, since launchd refuses one others can write.
- **The log is `markets.log` in the data directory and rotates only on
  install.** launchd holds it open while the service runs, so past 8 MiB
  it moves to `.1` between the stop and the start.
- **`uninstall --purge` removes the database and the log, never
  `secrets/`**: `markets.db` with its `-wal` and `-shm`, `markets.log`
  and `.1`, in the directory the definition names. A definition it
  cannot read is refused rather than guessed at. A file already gone is
  no error; any other failure stops the purge and is reported, never a
  success.
- **Tests fake the backend and launchctl** (`test/service.test.ts`,
  `test/service-launchd.test.ts`); the waits run on the fake clock. No
  test runs `launchctl` or installs a service.

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
  Tailscale encrypts the plain HTTP, and the bearer still guards every
  route but `/health`. 1ctx on the same box uses `127.0.0.1:11238`.
- **Staging always runs `--source bvb` and `--data ~/.1ctx-markets`**
  (the box's home). `STAGING_FLAGS` holds extra server flags only; one
  holding `--data` is refused, since the backups and keys stay in
  `~/.1ctx-markets`.
- **The listen and flags are checked before any ssh** by the server's
  own `parseCli()` from the commit being built, since the binary is
  swapped before the install runs. They reach the box quoted one by one
  for an explicit `bash`, so its login shell (zsh globs `[::1]`) never
  reparses them.
- **ssh runs with `BatchMode=yes` and `ConnectTimeout=10`**, so a
  missing key or a down box fails at once instead of prompting.
- **`make staging-deploy` takes `main` only.** It refuses another
  branch or a dirty checkout unless `ALLOW_BRANCH=1`, before any ssh. A
  migration that ran on staging is never edited again, like one merged
  to `main`.
- **The binary is checked before it leaves.** It is built with
  `VERSION=v<package version>+<commit>` (`.dirty<hash>` on a bypassed
  dirty tree) and must print that version.
- **A deploy backs the database up before it swaps the binary.** A
  `sqlite3 .backup` into `~/.1ctx-markets/backups`, taken out of WAL
  (`journal_mode=delete`) so it is one file, integrity-checked (a copy
  that fails is removed and the deploy stops), the last three kept. The
  new binary is uploaded beside the live one and renamed over it, so an
  interrupted copy never leaves a truncated executable, then `service
  install --restart` runs with the env's listen and flags.
- **An install that fails after the swap needs a manual redeploy,** and
  the backup restored if the new binary's migration ran.
- **`make staging-secrets DIR=<dir>` copies only the `source-*.key`
  files the box lacks** into `~/.1ctx-markets/secrets` (700, files
  600). Each value goes over ssh stdin, never in an argument or the
  output, which names files only; a key the box holds is kept. The
  bearer and the admin key are never copied: the box's first start
  writes its own.
- **Admin actions run on the box over ssh** with `1ctx-markets admin
  status|refetch|delete` (`docs/admin.md`), which reads the installed
  service's listen address and data directory and calls it on
  loopback, so the service keeps running.
