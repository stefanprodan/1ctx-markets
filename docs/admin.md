# Admin

Governs the operator's routes and command: `src/admin/http.ts` (the
instrument and status handlers), `src/admin/refetch.ts`,
`src/admin/retry.ts` (the failed jobs' retry), `src/admin/screener.ts`
(the Screener page),
`src/admin/keys.ts` (the agent keys' routes), `src/admin/users.ts`
(the people), `src/admin/smtp.ts` and `src/server/email/` (email),
`src/server/caller.ts` (a write's credential re-read),
`src/admin/cli.ts` (`1ctx-markets admin`), `src/admin/keys-cli.ts`
(`1ctx-markets keys`) and `src/admin/users-cli.ts` (`1ctx-markets
users`). Sign-ins and links are in `docs/web.md`. The routes, their errors
and the spec are in `docs/api.md`; key files in `docs/config.md`;
runs, tracking and retention in `docs/storage.md`; the source queue
and deadlines in `docs/sources.md`; each source's fetch code in its
own doc.

## Why

An agent's key never forces a fetch, deletes a row or makes a key: an
agent could spend the free sources' limits or break another's reads.
The operator's actions take the admin key or an admin's sign-in, and
none is offered over MCP. Each agent has a key of its own, made by its
person, so one can be told apart in the log and cut off without
touching the others. People and agents are apart, as in 1ctx: a person
signs in to the web UI, an agent holds a key its person made; a key
never signs in and a sign-in never opens `/mcp`.

## The key and the guard

- **`secrets/user-admin.key` is the one key file a first start
  writes** (`docs/config.md`, Keys), prefixed `1ctx-markets-admin-`.
  One that is unusable stops the start; the message names the file
  only. It is rotated by replacing the file and restarting.
- **The admin scope takes the admin key or an admin's login**, checked
  after the route is matched (`router()` in `src/server/http.ts`): an
  agent key or a member's login there is 403. The admin key also holds
  the read scope and opens `/mcp`, so it opens everything, as the
  operator. The `session` scope (the dashboard, the screener, an
  instrument's stored check, the keys) takes the admin key or anyone's
  login, never an agent key. A write by cookie needs this server's
  `Origin`, or it is 403 (`docs/web.md`).
- **An admin never reads another person's portfolios, profile,
  dashboard or alerts**: those routes act as the caller's own person
  (`docs/api.md`). An admin lists and revokes anyone's keys, signs a
  person out everywhere and removes a person.
- **Writes re-read their caller** (`recheck()` in `src/server/caller.ts`,
  as 1ctx's `checkKey()`): the router runs each request under a check
  of its credential (`asCaller()`), and every write of a person's rows
  calls `recheck(db)` first inside its transaction, an admin's write
  `recheck(db, "admin")`. A key revoked or expired, a login ended, a
  person removed mid-call is 401 and a demoted admin 403, and nothing
  is written. Shared work never calls it (a fetch two callers wait on,
  a job, tracking stamps), so one caller's revoke fails no other's
  read; a write outside a request passes.
- **The routes are on the server's own port, so treat them as
  internet-facing** wherever the server is reachable. Arguments are
  parsed strictly and refused whole, a refetch body is at most 16 KiB
  (`MAX_BODY_BYTES`), a path symbol matches `KEY`, and every error is a
  fixed phrase that echoes nothing a source said.

| Route | Does |
|---|---|
| `GET /api/v1/instruments?query=&page_size=&page_token=` | the stored instruments by id, a page at a time (below) |
| `GET /api/v1/screener?type=&screen=&sort=&order=&page_size=&page_token=` | the instruments kept up to date through one ready-made screen, read from stored figures in one query, a page at a time (`docs/api.md`, "The screener") |
| `GET /api/v1/status` | `sync`, false with `--no-sync` (`docs/config.md`), so the jobs' last runs read as from before; sources on, off and why, and every job, with names for people (a source's `label`, `short` and `mark`, a job's `label` and `about`; a keyed source's `key`: its file, what it adds, where to get one), a back-off in force, every job's last run, its scopes (markets or instruments with a run kept) and failing scopes counted, the newest `MAX_FAILING` (5) failing named with their error, a phrase that may name the symbols behind it (`docs/storage.md`; a run cut by shutdown, error `stopped`, never counts, since the next run settles it; one cut by a crash, `interrupted`, does, since a run that kills the server would otherwise never show; a failed Yahoo backfill is settled once the instrument has daily bars, since a read fetches a history without a backfill run; runs with no scope, from before backfill runs had one, are skipped; the page reads failure from these counts, never the last run), the instrument and tracked counts, the database size, the version |
| `POST /api/v1/status/retry` | no body: every failing instrument scope status lists asks its failed part again (below); `{asked, fetched, failed, left_out}` |
| `POST /api/v1/instruments/{symbol}/refetch` | `{"parts": [...], "sections": [...]}`, answered per part |
| `DELETE /api/v1/instruments/{symbol}` | the instrument and every row of it; 204 |
| `GET /api/v1/instruments/{symbol}/stored` | `{input, stored}`: true when the read's bare-symbol rule (`restStored()`) finds a stored row with daily bars, so a read answers without a first fetch; asks no source and marks no read. The web UI asks it beside an instrument's first read to say which wait it is in (`docs/web.md`) |
| `GET /api/v1/keys` | session: the caller's agent keys, an admin's everyone's, each with its `owner` `{id, name}` (below) |
| `POST /api/v1/keys` | session: `{"name", "expiresInDays", "portfolio", "alerts", "profile", "analysis"}`: a new agent key of the caller's, its token answered once; `portfolio`, `alerts`, `profile` and `analysis` are `none` (the default), `read` or `write` |
| `PATCH /api/v1/keys/{id}` | session: `{"portfolio", "alerts", "profile", "analysis"}`, at least one: changes one of the caller's keys' access, the token, name and expiry kept; the key as listed; 400 for none or a bad value, 404 for an unknown id or another's |
| `DELETE /api/v1/keys/{id}` | session: revokes one of the caller's keys, an admin anyone's; 204 |
| `GET /api/v1/users` | `users[]` (`id`, `name`, `email`, `role`, `operator`, `created_at`, `last_sign_in_at`, `keys`) and `email_on` (below) |
| `POST /api/v1/users` | `{"name", "email", "role"}`: adds a person and emails the invite; 201 `{user, invite: "sent"}` or `{user, invite: "failed", reason}`; 409 while email is off or the address is taken |
| `PATCH /api/v1/users/{id}` | `{"name", "role"}`, at least one; `{user}`; 409 making the operator a member |
| `POST /api/v1/users/{id}/invite` | no body: a new 7-day invite, replacing an unused one; `{invite, reason?}`; 409 while email is off or for a person with no email |
| `POST /api/v1/users/{id}/sign-out` | no body: ends their logins and live links; 204 |
| `DELETE /api/v1/users/{id}?dry_run=` | removes the person and every row of theirs; `{dry_run, deleted}` with each kind's count; `dry_run=true` deletes nothing; 409 for the operator |
| `GET /api/v1/smtp` | `{settings, key_names, email_on, key_missing}` (below) |
| `PUT /api/v1/smtp` | every field of the settings; the same answer as `GET` |
| `DELETE /api/v1/smtp` | email off; 204, 404 with none saved |
| `POST /api/v1/smtp/test` | `{"to"}`, the caller's own email by default: one email at once; `{result: "sent"}` or `{result: "failed", reason, reply}` |

## Agent keys

- **An agent key opens what the read scope opens**: `/mcp` and the
  market data routes; never an admin or a `session` route, so an agent
  never makes or lists keys, removes a person or changes email.
- **Each person makes their own keys** on Connect agents, as in 1ctx,
  the operator by the admin key or `1ctx-markets keys` too. A key opens
  its person's own rows at the access it was made with. Nobody makes a
  key for someone else: `POST /keys` takes no person.
- **Portfolio access is the key's maker's to give** (`portfolio`: `none`,
  `read` or `write`, on `POST /keys` and `keys add --portfolio`),
  `none` by default, since holdings are private; a key's access is
  answered in the list. It opens the portfolio routes and the
  portfolio tools: `read` lists the `portfolio` read tool, `write` the
  write tools too, and `none` lists none (`docs/portfolios.md`).
- **Alerts access is given the same way** (`alerts`, `keys
  add --alerts`), `none` by default, since an alert acts for the owner.
  `read` lists the `alerts` tool and opens the alerts, their history and
  the feed; `write` lists `alerts_edit` too and opens creating,
  updating, pausing and deleting alerts (`docs/alerts.md`). A feed
  reader is an alerts reader: triggers have no access of their own.
  Keys made before this access existed were given `write` (migration
  0023), what they had; the column was named `rules` until migration
  `0046-key-alerts` renamed it, the values kept.
- **Profile access is given the same way** (`profile`,
  `keys add --profile`), `none` by default, since the owner's profile is
  personal and a script's key never needs it. `read` lists the `profile`
  tool and opens the profile reads, `write` also lists `profile_edit`
  and opens `PUT /profile` (`docs/profile.md`). Keys made before profile
  access existed start at `none` too (migration 0033): the admin opts
  each in.
- **Analysis access is given the same way** (`analysis`,
  `keys add --analysis`), `none` by default. The analysis is shared by
  everyone on the server, so a write key's text reaches every person's
  agents and sign-ins; a script's key never needs it. `read` lists the
  `analysis` tool, opens the analysis reads and adds the `analysis`
  pointer to the `research` overview; `write` also lists
  `analysis_edit` and opens its `PUT` (`docs/analysis.md`). Keys made
  before analysis access existed start at `none` too (migration 0041).
  A web UI sign-in and the admin key write it.
- **Access changes on a kept key** (`PATCH /keys/{id}`, `keys set`):
  the token, name and expiry stay, an expired key changes too, and the
  key's next request reads the new access, as a revoke holds on the
  next request, since the row is read on every request.
- **A name follows 1ctx's agent name rule**: 2 to 80 lowercase
  letters, digits, dashes and underscores, starting with a letter or
  digit, unique among the person's keys (409 `conflict`, "name
  taken"), so two people may name keys alike. `web` and `admin` are
  reserved (409 `conflict`, "name reserved"): the server records the
  web UI and the admin key by those names.
- **At most 20 keys per person** by default (`--max-keys`, 1 to
  1000), expired ones included, the operator included (409
  `conflict`, "too many keys"); `GET /api/v1/keys` answers the cap as
  `limit`. Lowering it revokes no key. The name and the cap are
  checked in the same write as the insert.
- **A key is its maker's** (`keys.user_id`): the routes list, change and
  revoke the caller's own, another's id answering 404, and the key's
  agent reads and writes that person's rows. An admin's list holds
  every person's keys, each with its `owner`, and an admin revokes any,
  re-checked as an admin in the write; a key's access is changed only
  by its maker. The admin key makes the operator's.
- **Expiry is optional**: null (never, the default), 30, 90 or 365
  days. An expired key is 401 and stays listed until revoked.
- **The token is answered once** by `POST`, with `cache-control:
  no-store`, after it joins the log mask; the row holds only its
  SHA-256, and no list or log line names it. A made or revoked key is
  logged by id, name and person.
- **A revoke holds on the key's next call**: nothing caches a lookup,
  and `/mcp` is stateless, so there is no session to close; a call
  already in flight writes nothing past the revoke (above).

## People

- **`users`**: `id`, `name`, `email` (lowercased, unique), `role`
  (`admin` or `member`), `created_at`, `last_sign_in_at`. A `member`
  has their own data in full (portfolios, profile, dashboard, alerts,
  keys), the market pages and Connect agents; an `admin` also Server
  admin's status, refetch, delete, retry, and the people and email routes.
- **The operator** (`OPERATOR`) always exists, is an admin, signs in
  with `user-admin.key`, and cannot be removed or made a member (409),
  so no admin locks everyone out and a mail outage never does. Their
  email is null until they add one (`PATCH /ui/me`, `docs/web.md`).
- **No admin demotes or removes themself** (409): another admin does,
  so an admin's slip never takes Server admin from them.
- **Invite only, by email.** Adding a person needs email on (409
  otherwise: nobody could sign in), takes a name, an address and a role
  (`member` by default), and sends a 7-day link and code at once: "You
  were added to markets. Sign in: <link>, or enter 482913. Both work
  once, for 7 days." The person is added whether or not it went;
  `invite` says which, with the failure word, `timeout` past 25 s
  (`SEND_DEADLINE_MS`, under Bun's 30 s idle limit) while the send goes
  on. Invite again replaces any unused invite. The write that makes an
  invite re-checks the caller is still an admin. Invites skip the ask
  caps.
- **Sign out everywhere** (`signOutEverywhere()`) deletes the person's
  logins and live links; their data and keys stay.
- **Removing a person is one transaction** (`removeUserRows()`): their
  trades, positions, portfolios, brokers, settings, profile revisions,
  dashboard, rules, alerts, keys, logins and links, then the row. The
  answer counts each kind (`ownedCounts()`); `?dry_run=true` counts
  without deleting, for the confirmation. Fund prices they entered and
  analysis revisions they wrote stay, being shared, their author's id
  set null and the author's name kept; their asks stay
  counted. Shares to and from them go with their row
  (`portfolio_viewers`, on delete cascade), so a viewer's next read is
  404.
- **An admin never sees another's portfolios but as anyone does:** the
  owner shares them in the web UI, read only (`docs/portfolios.md`).
- **A person, a login or a link made, used or removed logs its id**,
  with who did it; never a token, a code or an address.

## Email

Follows 1ctx's (its `docs/email.md`), without an outbox: a link's email
is sent directly, after the answer for an ask, before it for an admin.

- **The operator's alone to change** (the admin key or the operator's
  login): whoever sets the SMTP server reads every link it carries, and
  the next send logs in to it with the password file, so another admin
  gets 403 on `PUT` and `DELETE /smtp` and `POST /smtp/test`, and reads
  `GET /smtp` only.
- **Set in the web UI, no flag and no restart**: one `smtp_settings` row
  (`host`, `port`, `security` `tls` or `starttls`, `username`,
  `key_name`, `from`, `public_url`, `updated_at`, `updated_by`). A save
  takes every field and names the missing ones (400); the username and
  the key file are both set or both null. `public_url` is an `https://`
  origin, or `http://` on a loopback host, with no path: the links'
  address, never a request's `Host`. A save sends nothing; the next
  email goes through it. A new host or port with the saved password
  file clears the username and the file, so a password never follows a
  new server unpicked: they are picked again for it.
- **The password is a key file put there by hand**,
  `secrets/email-<name>.key` (`docs/config.md`), named in `key_name`
  without `.key`; `GET /smtp` lists the `email-` names, never a value,
  and a `source-` or `user-admin` name is refused. The server reads it
  at each send (`keys.email()`), so the log mask knows it, and never
  writes it.
- **Email is on while the row is saved and the file it names is
  there** (`email().on()`); a file that cannot be read is a missing
  one. `key_missing` says the named file is not there.
- **Removing the settings** deletes the row: email goes off, new links
  stop; the file, the people and their logins stay.
- **Only `src/server/email/smtp.ts` imports `nodemailer`**, at 1ctx's
  pin. Addresses go to it as `{name, address}` objects, a header value
  with a control character or a line break is refused before it is
  handed over, certificates are always verified (TLS 1.2 or later),
  and the timeouts are 10 s to connect, 10 s for the greeting and 30 s
  on the socket. Nothing is sent at start.
- **A failure is one closed word** (`failureOf()`): `auth`, `tls`,
  `connect`, `rejected`, `timeout` or `other`. A log line holds the
  word, the person's and the link's ids, never the SMTP reply, which
  can carry addresses. The test email answers the reply to the
  operator alone, and `timeout` past 25 s as an invite does.

## The instrument list

- **Paged by id, the one paged route:** `page_size` 1 to `MAX_PAGE`
  (200, `DEFAULT_PAGE` 50 by default), `page_token` the
  `next_page_token` of the page before (its last id), and
  `next_page_token` absent on the last page. A page is a screen of
  rows, and the stored set grows with use; paging by id never skips a
  row when one is deleted between pages. `total` counts every match.
  A fund the owner prices (source `owner`) is never listed or counted,
  in the list or the status: its existence says the owner holds it,
  and a key without portfolio access reads both.
- **`query` keeps ids or names holding it**, ignoring ASCII case only
  (SQLite's `lower()`), at most 64 characters.
- **Each row says what tracks it** in `tracked_by`: `rule` (a rule of
  the caller's reads it), `dashboard` (it is on the caller's saved
  dashboard), `read` (read within the tracking window, with `read_at`
  and `read_until`), `world_markets` (a World markets symbol resolved
  to it, `docs/storage.md`);
  `tracked` is true when any holds, or when another person's rule,
  dashboard or holding tracks it, which is never named, since every
  read-scope key reads the row (`listRow()`).
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
| `top_holdings` | Yahoo | a fund's top holdings, for an ETF or mutual fund Yahoo prices; anything else is `not covered` |

- **The answer is `input`, `id` and `parts[]`; each part answers
  `fetched` with its rows, `not covered`, `source off`, or `failed`
  with a fixed phrase** (a source phrase, `backing
  off after <phrase>`, `timed out`, `moved to another source`, `the
  server is stopping`, `failed`).
- **It records the runs the jobs record, never one by hand.** Bars end
  the instrument's own `bars` run, failed when the failure reached the
  source, as the bar pass does; research, news and top holdings record their own; a
  quote records none, since a quote run is the market's pass. Nothing
  is marked due, no run is deleted, and a refetch is no read, so it
  tracks nothing. Bars evaluate the instrument's rules after the run
  ends, so a failure the refetch repaired no longer holds them unknown.

## Retry failed jobs

- **Every failing scope `GET /status` counts, not the `MAX_FAILING`
  it names** (`failingScopes()`, the same reading as `jobs()`), each
  asked again through the refetch code (`fetchAll()`), one fetch per
  instrument and part, all under one call deadline.
- **Only an instrument's failed part is asked:**

| Job | Asked as |
|---|---|
| Massive `news` | `news` |
| Finnhub `metric`, `analysts`, `earnings`, `insider` | `research`, that section only |
| Finnhub `calendar` | `calendar` |
| Yahoo `top_holdings` | `top_holdings` |
| Yahoo `valuation` | `refreshValuation()`, a part only the retry uses |
| EDGAR `filings` | `refreshFilings()`, a part only the retry uses |
| Yahoo, Bucharest feed, FRED `bars` in an instrument's scope | `bars`, only while the instrument is still that source's |
| Yahoo `backfill` | `bars`: stored bars settle a failed backfill |

- **Left out:** a market's scope (live prices, market hours, a
  market's daily prices, the feed's lists, SEC tickers, the earnings
  calendar, the source switch), whose jobs ask again within the hour;
  `owed`, whose runs never fail; an instrument no longer stored; a
  source that is off; an instrument a part does not cover.
- **Runs as the refetch records them**: a success ends the run its job
  records, so the scope leaves the failing list; a failure that reached
  the source records a failed run with its phrase; the deadline, a
  back-off or a stopping server records nothing (`reached()`). A bars
  fetch that fails again fails only the jobs whose rows asked it, so a
  failed backfill stays one row.
- **The answer is counts only**: `asked` (`fetched` plus `failed`) and
  `left_out` add up to the failing scopes; status names which.

## Delete

- **Stored only, never fetched**, named as refetch names it; 204 with
  no body.
- **One write removes the instrument, every row keyed to it
  (`INSTRUMENT_TABLES`) and its own runs**, so the key added again
  starts unfetched; nothing of another instrument goes. A research or
  news fetch still in flight finds the key gone and writes nothing
  (`checkStored()`). A new table referencing `instruments` either goes
  into `INSTRUMENT_TABLES` or cascades, as the dashboard's items do; a
  test lists every such table, so one added to neither fails it.
  `funds` is the one exception: no id an admin route takes finds a
  fund the owner prices, its key being lower case, so none deletes it.
- **Its dashboard card goes by the cascade**, never in
  `INSTRUMENT_TABLES`: a favourite never blocks a delete. The same
  write moves the dashboard's revision, so a tab still holding the card
  reloads at its next save instead of fetching it back.
- **Refused with 409 while a rule reads it**, its own or another's
  condition: delete the rule first. The check is in the same write and
  counts every person's rules, but `rules` names only the caller's;
  another person's alone answer "another person's alerts read this
  instrument" with `rules` empty.
- **Refused with 409 while a trade or position names it**, removed
  ones included, so a restore never finds it gone (`portfolioHolds()`,
  `docs/portfolios.md`); `rules` is empty then and the detail names
  no figure.
- **Its alerts stay** until retention, since alerts have no foreign key
  and a hole would read as a retention gap on the alerts feed.
- **A World markets instrument is fetched again** on the next track
  pass, since the built-in list still names it.
- **Not built:** deleting alerts, untracking (tracking ends by itself),
  key rotation (replace the file and restart).

## The command

- **`1ctx-markets admin status|retry|refetch|delete` calls the running
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
- **`1ctx-markets keys list|add|set|revoke` calls the same way**, with
  the same `--listen` and `--data`, as the operator. `list` prints `GET
  /api/v1/keys`'s JSON, every person's; `add <name> [--expires 30|90|365] [--portfolio
  none|read|write] [--alerts none|read|write] [--profile
  none|read|write] [--analysis none|read|write]` (each access `none` by
  default) prints the new
  token alone on stdout, once, so `$(...)` can take it, and nothing
  else; `set <name> [--portfolio ...] [--alerts ...] [--profile ...]
  [--analysis ...]`,
  one at least, finds the operator's own key's id by name and prints
  `set <name>`; `revoke <name>` finds it the same way and prints
  `revoked <name>`. Another person's key is revoked only by its id
  (`revoke <id>`), since two people may name keys alike. A refusal
  exits 1 with the server's detail and status.
- **`1ctx-markets users list|add|invite|sign-out|remove` calls the same
  way.** `add <email> <name> [--role admin|member]`, `invite <id>` and
  `remove <id> [--dry-run]` print the server's JSON; `sign-out <id>`
  prints `signed out <id>`.
