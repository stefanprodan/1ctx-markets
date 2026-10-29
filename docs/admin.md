# Admin

Governs the operator's routes and command: `src/admin/http.ts` (the
instrument, watchlist and status handlers), `src/admin/refetch.ts`,
`src/admin/keys.ts` (the agent keys' routes), `src/admin/cli.ts`
(`1ctx-markets admin`) and `src/admin/keys-cli.ts` (`1ctx-markets
keys`). The routes, their errors
and the spec are in `docs/api.md`; key files in `docs/config.md`;
runs, tracking and retention in `docs/storage.md`; the source queue
and deadlines in `docs/sources.md`; each source's fetch code in its
own doc.

## Why

An agent's key never forces a fetch, deletes a row or makes a key: an
agent could spend the free sources' limits or break another's reads.
The operator's actions take the admin key, and none is offered over
MCP. Each agent has a key of its own, so one can be told apart in the
log and cut off without touching the others.

## The key and the guard

- **`secrets/user-admin.key` is the one key file a first start
  writes** (`docs/config.md`, Keys), prefixed `1ctx-markets-admin-`.
  One that is unusable stops the start; the message names the file
  only. It is rotated by replacing the file and restarting.
- **The admin scope takes the admin key alone**, checked after the
  route is matched (`router()` in `src/server/http.ts`): an agent key
  there is 403. The admin key also holds the read scope and opens
  `/mcp`, so it opens everything. With no admin key the admin routes
  refuse every caller.
- **The web UI's session cookie opens them too**, made by signing in
  with the admin key (`docs/web.md`); a write by cookie needs this
  server's `Origin`, or it is 403.
- **The routes are on the server's own port, so treat them as
  internet-facing** wherever the server is reachable. Arguments are
  parsed strictly and refused whole, a refetch body is at most 16 KiB
  (`MAX_BODY_BYTES`), a path symbol matches `KEY`, and every error is a
  fixed phrase that echoes nothing a source said.

| Route | Does |
|---|---|
| `GET /api/v1/instruments?query=&page_size=&page_token=` | the stored instruments by id, a page at a time (below) |
| `GET /api/v1/status` | sources on, off and why, and every job, with names for people (a source's `label`, `short` and `mark`, a job's `label` and `about`; a keyed source's `key`: its file, what it adds, where to get one), a back-off in force, every job's last run, its scopes (markets or instruments with a run kept) and failing scopes counted, the newest `MAX_FAILING` (5) failing named with their error (a run cut by shutdown, error `stopped`, never counts, since the next run settles it; one cut by a crash, `interrupted`, does, since a run that kills the server would otherwise never show; a failed Yahoo backfill is settled once the instrument has daily bars, since a read fetches a history without a backfill run; runs with no scope, from before backfill runs had one, are skipped; the page reads failure from these counts, never the last run), the instrument and tracked counts, the database size, the version. The `--track` values are `GET /api/v1/watchlist`'s (`docs/api.md`) |
| `POST /api/v1/instruments/{symbol}/refetch` | `{"parts": [...], "sections": [...]}`, answered per part |
| `DELETE /api/v1/instruments/{symbol}` | the instrument and every row of it; 204 |
| `GET /api/v1/keys` | the agent keys (below) |
| `POST /api/v1/keys` | `{"name", "expiresInDays"}`: a new agent key, its token answered once |
| `DELETE /api/v1/keys/{id}` | revokes an agent key; 204 |

## Agent keys

- **An agent key opens what the read scope opens**: `/mcp`, the read
  routes, the rules writes and the alerts feed; never an admin route,
  so an agent never makes or lists keys.
- **A name follows 1ctx's agent name rule**: 2 to 80 lowercase
  letters, digits, dashes and underscores, starting with a letter or
  digit, unique (409 `conflict`, "name taken").
- **At most 5 keys** (`MAX_KEYS`), expired ones included, as 1ctx's
  default cap (409 `conflict`, "too many keys"). The name and the cap
  are checked in the same write as the insert.
- **Expiry is optional**: null (never, the default), 30, 90 or 365
  days. An expired key is 401 and stays listed until revoked.
- **The token is answered once** by `POST`, with `cache-control:
  no-store`, after it joins the log mask; the row holds only its
  SHA-256, and no list or log line names it. A made or revoked key is
  logged by id and name.
- **A revoke holds on the key's next call**: nothing caches a lookup,
  and `/mcp` is stateless, so there is no session to close; a call
  already in flight finishes.
## The instrument list

- **Paged by id, the one paged route:** `page_size` 1 to `MAX_PAGE`
  (200, `DEFAULT_PAGE` 50 by default), `page_token` the
  `next_page_token` of the page before (its last id), and
  `next_page_token` absent on the last page. A page is a screen of
  rows, and the stored set grows with use; paging by id never skips a
  row when one is deleted between pages. `total` counts every match.
- **`query` keeps ids or names holding it**, ignoring ASCII case only
  (SQLite's `lower()`), at most 64 characters.
- **Each row says what tracks it** in `tracked_by`: `rule` (a rule
  reads it), `read` (read within the tracking window, with `read_at`
  and `read_until`), `track` (a `--track` value resolved to it);
  `tracked` is true when any holds.
- **Each row carries its stored price**: `price`, `change`,
  `change_percent` and `fetched_at` from the stored quote, or a
  series' newest daily close with no change (FRED has no quote). The
  UI's list shows these rather than calling `/quotes`, which is a read.
- **A listing is no read**: it tracks nothing and fetches nothing.
- **FRED's `attribution`** comes with a page that holds a FRED series,
  and with one FRED instrument, as on the public routes. One instrument
  also has `credit`, its price source's short name and site (Yahoo,
  BVB, FRED), which the instrument page's footer links.
- **One instrument is a read, for an agent key too**:
  `GET /api/v1/instruments/{symbol}` (`docs/api.md`, "One instrument")
  reads it through `quoteRows()` as the quote tool does, so an unknown
  symbol is fetched, a stored one tracked and a due price fetched,
  with `extended` asked, so the page shows pre or post trading; that
  read is cached per quote period and skipped while the session is
  open. The public `/quotes` leaves returns and session out to stay
  cheap for many symbols; one instrument can afford them. A stored
  instrument whose read fails (a source down, the deadline) still
  answers 200 with the stored row, `quote` null and `error` the item's
  code and detail, so the page keeps the stored price.

## Refetch

- **For after a parser fix:** a run recorded by old code holds a
  section or history off until it is next due; this asks again now.
- **One stored instrument a call**, named by its id or a symbol as
  written (`restStored()`: the stored Yahoo listing first, then the feed's); one
  not stored is 404, and nothing is resolved, fetched or added.
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

- **The answer is `input`, `id` and `parts[]`; each part answers
  `fetched` with its rows, `not covered`, `source off`, or `failed`
  with a fixed phrase** (a source phrase, `backing
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

- **Stored only, never fetched**, named as refetch names it; 204 with
  no body.
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
  server on this machine** with `<data>/secrets/user-admin.key`, so it works
  over ssh without stopping the service. `--listen` and `--data`
  default to the installed service's, else the server's defaults; a
  wildcard bind is called on loopback (`urlOf()`).
- **`refetch` with several ids makes one call each, in turn**, since
  the route takes one instrument a call: it carries on past a failed
  one, no answer included (kept as `{input, error}`), prints one JSON
  array of the answers in the order given, and exits 1 if any call was
  not 2xx. `--fetch` names the parts.
- **`delete` prints `deleted <id>` for its 204**, else the problem.
- **It prints the server's JSON and never the key**, and exits 1 on a
  status other than 2xx or no answer.
- **`1ctx-markets keys list|add|revoke` calls the same way**, with the
  same `--listen` and `--data`. `list` prints `GET /api/v1/keys`'s
  JSON; `add <name> [--expires 30|90|365]` prints the new token alone
  on stdout, once, so `$(...)` can take it, and nothing else; `revoke
  <name>` finds the key's id by name and prints `revoked <name>`. A
  refusal exits 1 with the server's detail and status.
