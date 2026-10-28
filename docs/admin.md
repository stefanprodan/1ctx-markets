# Admin

Governs the operator's routes and command: `src/admin/http.ts`
(`/api/v1/admin/*`), `src/admin/refetch.ts` and `src/admin/cli.ts`
(`1ctx-markets admin`). The routes, their errors and the spec are in
`docs/api.md`; key files in `docs/config.md`; runs, tracking and
retention in `docs/storage.md`; the source queue and deadlines in
`docs/sources.md`; each source's fetch code in its own doc.

## Why

The one bearer goes to every agent, so it never forces a fetch or
deletes a row: an agent could spend the free sources' limits or break
another's reads. The operator's actions take their own key, and none
is offered over MCP.

## The key and the guard

- **`secrets/admin.key` is written at the first start beside the
  bearer, the same way** (`docs/config.md`, Keys), prefixed
  `1ctx-markets-admin-`. One that is unusable or equal to the bearer
  stops the start; the message names the file only.
- **`/api/v1/admin` and `/api/v1/admin/*` take the admin key alone**,
  checked as the bearer is (`router()` in `src/server/http.ts`): the
  bearer is refused there and the admin key on every other path,
  `/mcp` included. With no admin key they refuse every caller.
- **The web UI's session cookie opens them too**, made by signing in
  with the admin key (`docs/web.md`); a write by cookie needs this
  server's `Origin`, or it is 403.
- **The routes are on the server's own port, so treat them as
  internet-facing** wherever the server is reachable. Arguments are
  parsed strictly and refused whole, bodies are at most 16 KiB
  (`MAX_BODY_BYTES`), a request names at most 20 instruments
  (`MAX_SYMBOLS`), an id matches `KEY`, and every error is a fixed
  phrase that echoes nothing sent.

| Route | Does |
|---|---|
| `GET /api/v1/admin/instruments?query=&after=&limit=` | the stored instruments by id, a page at a time (below) |
| `GET /api/v1/admin/status` | sources on, off and why, and every job, with names for people (a source's `label`, `short` and `mark`, a job's `label` and `about`; a keyed source's `key`: its file, what it adds, where to get one), a back-off in force, every job's last run, its scopes (markets or instruments with a run kept) and failing scopes counted, the newest `MAX_FAILING` (5) failing named with their error (a run cut by shutdown, error `stopped`, never counts, since the next run settles it; one cut by a crash, `interrupted`, does, since a run that kills the server would otherwise never show; a failed Yahoo backfill is settled once the instrument has daily bars, since a read fetches a history without a backfill run; runs with no scope, from before backfill runs had one, are skipped; the page reads failure from these counts, never the last run), the instrument and tracked counts, each `--track` value with its id and state (`pending`, `tracked` or the read's error code), the database size, the version |
| `POST /api/v1/admin/refetch` | `{"symbols": [...], "fetch": [...], "sections": [...]}`, answered per symbol and part |
| `DELETE /api/v1/admin/instruments/{id}` | the instrument and every row of it |

## The instrument list

- **Paged by id, the one paged route:** `limit` 1 to `MAX_PAGE` (200,
  `DEFAULT_PAGE` 50 by default), `after` the last id of the page
  before, `more` true while ids are past the page. A page is a screen
  of rows, and the stored set grows with use; paging by id never skips
  a row when one is deleted between pages. `total` counts every match.
- **`query` keeps ids or names holding it**, ignoring ASCII case only
  (SQLite's `lower()`), at most 64 characters.
- **Each row says what tracks it** in `tracked_by`: `rule` (a rule
  reads it), `read` (read within the tracking window, with `read_at`
  and `read_until`), `track` (a `--track` value resolved to it);
  `tracked` is true when any holds.
- **A listing is no read**: it tracks nothing.

## Refetch

- **For after a parser fix:** a run recorded by old code holds a
  section or history off until it is next due; this asks again now.
- **Stored instruments only, by id**; an id not stored answers `not
  found`, and nothing is resolved or added.
- **Each part runs through its source's own fetch code, client and
  queue or limiter** (`within(live)`, so a back-off fails at once),
  every part at once under one call deadline (15 s). Its calls queue
  with the tools' own, first come first served, so a large refetch can
  hold an agent's call for up to that deadline: refetch few
  instruments at a time.

| Part | Source | Asks |
|---|---|---|
| `bars` | Yahoo, the Bucharest feed, FRED | the whole history from the first stored week, so every stored day is written again |
| `quotes` | Yahoo, the Bucharest feed | one quote; a FRED series has none |
| `research` | Finnhub | each of `sections` (`metric`, `analysts`, `earnings`, `insider`, default all) on its own call, a good run or not |
| `calendar` | Finnhub | the earnings calendar |
| `news` | Massive | one page, as a tool asks |

- **Each part answers `fetched` with its rows, `not covered`, `source
  off`, or `failed` with a fixed phrase** (a source phrase, `backing
  off after <phrase>`, `timed out`, `moved to another source`, `the
  server is stopping`, `failed`).
- **It records the runs the jobs record, never one by hand.** Bars end
  the instrument's own `bars` run, failed when the failure reached the
  source, as the bar pass does; research and news record their own; a
  quote records none, since a quote run is the market's pass. Nothing
  is marked due, no run is deleted, and a refetch is no read, so it
  tracks nothing. Bars evaluate the instrument's rules after the run
  ends, so a failure the refetch repaired no longer holds them unknown.

## Delete

- **One write removes the instrument, every row keyed to it
  (`INSTRUMENT_TABLES`) and its own runs**, so the key added again
  starts unfetched; nothing of another instrument goes. A research or
  news fetch still in flight finds the key gone and writes nothing
  (`checkStored()`). A new table
  referencing `instruments` goes into `INSTRUMENT_TABLES`; a test fails
  until it does.
- **Refused with 409 while a rule reads it**, its own or another's
  condition: delete the rule first. The check is in the same write.
- **Its alerts stay** until retention, since alerts have no foreign key
  and a hole would read as a retention gap on the alerts feed.
- **A `--track` value's instrument is fetched again** on the next track
  pass, since the flag still names it; to stop it, drop the flag and
  restart.
- **Not built:** deleting alerts, untracking (tracking ends by itself),
  key rotation (replace the file and restart).

## The command

- **`1ctx-markets admin status|refetch|delete` calls the running
  server on this machine** with `<data>/secrets/admin.key`, so it works
  over ssh without stopping the service. `--listen` and `--data`
  default to the installed service's, else the server's defaults; a
  wildcard bind is called on loopback (`urlOf()`).
- **It prints the server's JSON and never the key**, and exits 1 on a
  status other than 2xx or no answer.
