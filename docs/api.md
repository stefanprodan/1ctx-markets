# The HTTP API

Governs the REST API under `/api/v1`: `src/api/` (`routes.ts`,
`http.ts`, `openapi.ts`, `schemas.ts`, `paths.ts`, `docs.ts`, `docs/`),
the router's part in `src/server/http.ts`, the alerts feed
(`src/api/alerts.ts`) and the instrument, watchlist and status
handlers (`src/admin/http.ts`), the portfolio routes
(`src/api/portfolios.ts`, `docs/portfolios.md`), and the dashboard's
(`src/admin/dashboard.ts`). What each route reads is its tool's,
in `docs/tools.md`, `docs/research.md` and `docs/rules.md`; what an
alert is in `docs/rules.md`; the admin key and what refetch and delete
do in `docs/admin.md`; the server, keys and flags in `docs/config.md`.

## Why

Scripts, scheduled jobs and other tools read the server over plain
HTTP. They get a fixed, versioned surface of resources with a
machine-readable description they can browse and try, instead of the
MCP tools copied onto paths.

## Routes

| Method and path | Scope | Calls | Answers |
|---|---|---|---|
| `GET /quotes?symbols=&extended=` | read | `quoteRows()` with `briefItem()` | `quotes[]`: every symbol asked, up to `MAX_SYMBOLS` (100); `extended=true` adds the quote tool's `extended` per item |
| `GET /research?symbols=&sections=&since=` | read | `researchList()` | `research[]`: up to `MAX_RESEARCH_SYMBOLS` (5) items of `input`, `id`, `company`, `news` and `filings` (below) |
| `GET /symbols?query=&upstream=` | read | `searchAll()` | the search tool's `candidates[]`, and `errors[]` for a source that failed; `upstream=false` answers only the stored instruments and the stored Bucharest listings, asking no source |
| `GET /earnings?from=&to=&symbols=` | read | `readEventsOf()` | `earnings[]`, with `no_event[]` and `unavailable[]` uncapped |
| `GET /movers?symbols=&min_move_pct=&direction=&average=&relation=` | read | `readMovers()`, `setAll()` | `movers[]`: every match, unavailable and error, with `counts` |
| `POST /screen` | read | `readScreen()`, `setAll()` | `matches[]`, the same; the body is the tool's arguments, since `filters` is a structure; 200, it creates nothing |
| `GET /instruments?query=&page_size=&page_token=` | admin | `instruments()` | a page of stored instruments and what tracks each (`docs/admin.md`) |
| `GET /instruments/{symbol}` | read | `instrument()` | the instrument, what tracks it and its full quote; a read (below) |
| `DELETE /instruments/{symbol}` | admin | `deleteOne()` | 204; 409 with `rules` (`docs/admin.md`) |
| `POST /instruments/{symbol}/refetch` | admin | `refetchOne()` | `input`, `id`, `parts[]` (`docs/admin.md`) |
| `GET /instruments/{symbol}/bars?interval=&from=&to=&benchmark=&extended=` | read | `readHistory()`, `readIntradayHistory()` | bars or 5-minute points (below) |
| `GET /watchlist` | read | `watchlist()` | `entries[]`, the `--track` values (below) |
| `GET /dashboard` | admin | `readDashboard()` | the web UI's home page: `revision`, `created`, `sections[]` of `items[]` (below) |
| `PUT /dashboard` | admin | `saveDashboard()` | `{revision, sections: [{name, view, symbols}]}` replaces the layout; the saved dashboard; 409 with `dashboard`, 422 with `errors` (below) |
| `GET /rules` | rules:read | `readRules()`, `ruleItem()` | `rules[]` |
| `POST /rules` | rules:write | `createRule()` | 201, `Location: /api/v1/rules/{id}`, the rule, its first evaluation and any alert it fired |
| `GET /rules/{id}` | rules:read | `readRule()`, `ruleItem()` | `{rule}` |
| `PATCH /rules/{id}` | rules:write | `pauseRule()` | `{"paused": bool}` sets or clears the manual pause; `{rule}` |
| `DELETE /rules/{id}` | rules:write | `deleteRuleById()` | 204; its alerts stay |
| `GET /alerts` | rules:read | `alertsHandler()` | the alerts feed (below) |
| `GET /portfolios` | portfolio:read | `listAll()` | `portfolios[]` with their counts, `brokers[]`, `display_currency`, `time_zone`, `markets[]`, `funds[]` |
| `POST /portfolios`, `PATCH`, `DELETE /portfolios/{id}` | portfolio:write | `createPortfolio()`, `updatePortfolio()`, `removePortfolio()` | `{name}`; 201 with `Location`; 409 while no display currency is set, for a taken name or a portfolio holding live rows (removed ones are deleted with it) |
| `GET /portfolios/{id}` | portfolio:read | `portfolioItem()` | `{portfolio}` |
| `GET /portfolios/{id}/holdings?broker=&currency=`, `GET /holdings?broker=&currency=` | portfolio:read | `readHoldings()` | one portfolio's or all holdings, totals per currency, `converted` and `rates` with a named or display currency, `exposure` (`docs/portfolios.md`) |
| `GET /portfolios/{id}/export` | portfolio:read | `exportCsv()` | `text/csv`, the trades in the portfolio CSV export format, LF line ends, no BOM |
| `POST /portfolios/{id}/import` | portfolio:write | `importCsv()` | `{csv, broker, currency, confirm, dry_powder}`; every row's status, saved only with `confirm` |
| `GET /trades?portfolio=&broker=&symbol=&from=&to=&removed=` | portfolio:read | `readTradeList()` | `trades[]`, newest first, whole |
| `POST /trades` | portfolio:write | `addTrade()` | the tool's `add` arguments; 201 with `trade`, or `trades` for a sell of all; 409 with the saved one's id in `trade` for a trade with the same figures entered in the last 10 minutes, unless `again` is true |
| `DELETE /trades/{id}`, `POST /trades/{id}/restore` | portfolio:write | `setTradeState()` | `{trade}`, removed or back; never a delete |
| `GET /positions?portfolio=&broker=&removed=` | portfolio:read | `readPositions()` | `positions[]` |
| `POST /positions` | portfolio:write | `addPosition()` | `{kind, ...}`, kind `cash` or `bond` (a fund is bought as a trade); 201 with `position` and `replaced` |
| `PATCH /positions/{id}` | portfolio:write | `updatePosition()` | the tool's `update` arguments; the new row, `replaced`, and `rate` for a converted amount; 409 on a removed row |
| `DELETE /positions/{id}`, `POST /positions/{id}/restore` | portfolio:write | `setPositionState()` | `{position}` |
| `GET /positions/{id}/history` | portfolio:read | `historyOf()` | `history[]`, every row of the position, newest first |
| `GET /funds` | portfolio:read | `listAll()` | `funds[]`: each fund the owner prices with its latest price and that price's day |
| `POST /funds/trades` | portfolio:write | `addFundTrade()` | the tool's `add` arguments of kind `fund`; 201 with `trade` (or `trades`) and `fund`; the first buy makes the fund; 409 for a retry, as `POST /trades` |
| `GET /funds/{isin}` | portfolio:read | `fundDetail()` | `{fund, prices, trades}`: every price, newest first, beside its live trades; 400 for an ISIN whose check digit fails, 404 for one not kept |
| `PATCH /funds/{isin}` | portfolio:write | `updateFund()` | `{price, date, market, name, currency}`: the price for a day (the owner's today by default), a day already priced replaced and answered in `replaced`; a new name no other fund has; a currency only while no live trade is on it |
| `GET /brokers`, `POST /brokers`, `PATCH`, `DELETE /brokers/{id}` | portfolio:read, write | `listAll()`, `createBroker()`, `updateBroker()`, `removeBroker()` | `{name}`; 409 for a taken name or a broker a live row names (removed rows lose the name) |
| `GET /portfolio-settings`, `PUT /portfolio-settings` | portfolio:read, write | `settingsItem()`, `saveSettings()` | `{display_currency, time_zone}`: an ISO 4217 code in circulation (`src/shared/currencies.ts`) and an IANA zone, each null only while none is set; a save takes either or both, keeps the one left out, and never clears one |
| `GET /keys` | admin | `listAnswer()` | `keys[]` (id, name, created, last used, expires; never a token) and `limit` (`docs/admin.md`) |
| `POST /keys` | admin | `createOne()` | `{name, expiresInDays, portfolio}` (days null, 30, 90 or 365; portfolio `none`, the default, `read` or `write`); 201 with `key` and its `token`, once; 409 for a taken name or past the cap of 5 |
| `DELETE /keys/{id}` | admin | `revokeOne()` | 204; 404 for an unknown id |
| `GET /status` | admin | `status()` | `docs/admin.md` |
| `GET /openapi.json` | none | `spec` | the OpenAPI document |
| `GET /docs`, `GET /docs/{file}` | none | `docs.ts` | the bundled Swagger UI page and its files |

- **A route calls the code its tool calls**, so resolution, tracking,
  the deadline, the limits and the error codes are the tool's, never
  copied (`docs/tools.md`, "One read, two surfaces").
- **Each route chooses its fields.** quotes and research answer a
  smaller projection (below), bars the one below; every other route
  answers its tool's fields. A projection grows only when a script
  needs a field.
- **Lists are named for what they hold**, never `items`; quotes and research
  keep request order and duplicates, movers and screen answer each
  instrument once in their own sort.
- **Query parameters for reads, a JSON body for a structure.** A list
  is one comma-separated value (`symbols=A,B`), as a shell script
  builds it; each parameter is given once; a boolean is `true` or
  `false`. `queryArgs()` turns them into the input the tool's own
  parser checks, so an error names the argument as the tool does.
- **No fixed word sits beside `{symbol}` under `/instruments/`**, since
  a ticker could share it: the list is the collection itself and
  search is `/symbols`. No colon verbs: ids hold colons.

## Symbols

- **A Yahoo symbol as written works on every route that takes one**
  (`AAPL`, `BRK-B`, `VVSM.DE`, `BTC-USD`, `^VIX`, `CL=F`, `EURUSD=X`),
  and so do a regional source's form (`BVB:R2809A`) and an id
  (`US:NVDA`, `CXI:^VIX`): a script's symbols come from Yahoo exports
  and are never mapped by the client. Every answer that reads a symbol
  gives `input`, the decoded value sent, beside the stored `id`.
- **`{symbol}` is one path segment, percent-decoded; a raw `^` works
  too** (Bun encodes it before the router, and `%5E` is decoded). A
  malformed escape is 400.
- **A bare symbol is Yahoo's on REST** (`yahooFirst`, `docs/bvb.md`):
  with the Bucharest feed on, a bare `TLV` stored from both answers
  `US:TLV`, never `candidates`, since a Yahoo export's bare symbol is
  never a Bucharest one; `BVB:TLV` or `TLV.RO` names that. MCP keeps
  `candidates`. A bare code only the Bucharest feed lists costs a Yahoo
  search on every call, so send `BVB:<code>`.
- **`/symbols?upstream=false` answers at once from the database**:
  the stored instruments that match, then the Bucharest exchange's
  listings stored from its list pages (below in `docs/bvb.md`), with
  no call to Yahoo, FRED or the exchange. A page that searches as the
  user types asks it first, then the full search for the rest.

## One instrument

- **`GET /instruments/{symbol}` is one read for both keys**: it
  resolves and fetches an unknown symbol as the tools do, tracks it as
  a read, and answers `input`, the stored row (`instrument`, as the
  list gives it, `tracked_by` included), `credit`, and its quote as the
  quote tool gives it, `returns` and `session` included, with
  `extended` asked so a page shows pre or post trading.
- **A stored instrument whose read fails answers 200** with its row,
  `quote` null and `error` (`{code, detail}`), so a page keeps the
  stored price; a symbol never stored has no row, so its failure is a
  problem (404 `not_found` or `candidates`, 503 for a source). The row
  is only the one this input names under the bare-symbol rule
  (`restStored()`): a bare code whose Yahoo lookup failed never answers
  a stored Bucharest listing of the same code.
- **`DELETE` and refetch never fetch.** They resolve against stored
  instruments only (`restStored()`): the stored Yahoo listing, a
  `.RO` symbol's stored `BVB:` row, else a code only the feed holds; one
  never stored is 404.

## Bars

- **The instrument's facts come with its bars** under `instrument`
  (`id`, `name`, `exchange`, `type`, `currency`, `unit`, `source`,
  `basis`), with `input`, `stale`, `session`, FRED's `attribution`,
  `from`, `to`, `interval` and `relative` beside it, so a chart is one
  call.
- **Daily and weekly bars always carry `open`, `high`, `low`, `close`,
  `volume`, `final`, `sma50` and `sma200`**, oldest first. A bar the
  live quote made with no open has `open` null.
- **A bar is live only while its market's `session` is open and it is
  not `final`**: an open market whose last bar is final has had no
  trade yet today, so that bar is a past close.
- **`interval=5m` answers points on the same path** (`Intraday`):
  `points[]` with `at`, `session`, `close`, `final`; `sessions[]` with
  each one's `fetched_at`; `previous_close`; and with `extended=true`
  `extended_points`, for the whole range, unpaged. Its `instrument`
  has no `basis`: the points are closes as stored. `benchmark` with
  `5m`, and `extended` with `1d` or `1wk`, are `bad_arguments`.
- **`from` and `to` are dates in the exchange's zone**, session dates
  for `5m`; defaults are the tool's.

## The watchlist

- **`GET /watchlist` is the `--track` values in flag order** and
  cannot be written: the flag is the source of truth, so a write would
  be lost at restart.
- **Each entry is `value` as written, `id` (null until resolved),
  `state`** (`pending`, `tracked`, or the read's error code), the
  stored row as `GET /instruments` gives it (`instrument`, null until
  resolved), its market's `session` and `intraday`, whether its source
  gives 5-minute closes (`readIntradayHistory()`'s rule; false until
  resolved), so a client picks `interval=5m` or daily bars without
  naming a source, with FRED's `attribution` once when an entry is a
  series.
- **It is no read and fetches nothing**: the flag already keeps each
  entry tracked and quoted, and a read stamp would keep a value
  dropped from the flag tracked 30 more days.

## The dashboard

- **`GET /dashboard` is the web UI's home page**: named sections, each
  shown as `cards` or a `table`, of instruments the admin chose. The
  server holds one dashboard.
- **Each item is `id`, `instrument`, `session`, `intraday` and
  `averages`.** `instrument` is the stored row as `GET /instruments`
  gives it; `session` its market's last regular session (null for a
  series); `intraday` whether its source gives 5-minute closes.
  `averages` holds the price's distance in percent from its daily
  50-day and 200-day and its weekly 200-week simple moving averages,
  read from the stored signal rows, never recomputed. A daily one
  carries `crossed_today`, by the `movers` tool's own rule (`crossing()`
  in `src/operations/movers.ts`): the last final close on or below the
  average and the price above it, or the reverse. The weekly one never
  carries it. A FRED series has no live quote to measure, so all three
  are null.
- **Before the first save `created` is false, `revision` 0, and the
  sections are the `--track` values grouped by kind** (Indices, Stocks,
  ETFs, Futures, Crypto and so on, any other kind by its own name), in
  the order its first value has in the flag, each shown as cards; a
  value not resolved is left out. Nothing is stored by a read, so a
  value that resolves later still joins it. Until then `track` lists
  each `--track` value with its state: `ready` (in the sections),
  `pending` (still resolving, as on a first start) or `failed` (left
  out). A client waits for none to be pending before it saves, since a
  save ends the seed. Once saved, `track` is absent and only a save or
  deleting an instrument on it changes it: an empty dashboard is a
  dashboard, never seeded again. The seed keeps to the save limits
  below, so its first edit can be saved.
- **It is no read and fetches nothing**, as the watchlist: the page
  asks every minute.
- **`PUT /dashboard` replaces the whole layout in one write**: a move,
  a rename, an add or a remove is one call. A stored instrument's id
  is taken as it is, asking no source, so a source that is off never
  refuses a rename. Any other symbol resolves as a read does, an
  unknown one fetched inside the call under its deadline, but no read
  is marked: an instrument on a saved dashboard is tracked while it is
  there (`tracked_by` says `dashboard`). An instrument named twice
  keeps its first place.
- **Any symbol that does not resolve answers 422 `unresolved`** with
  `errors[]`, each `{"input", "error": {"code", "detail"}}`, and
  nothing is saved.
- **`revision` must be the one stored** (0 before the first save), or
  409 `conflict` answers with the stored `dashboard`, so a second tab
  never overwrites a change it has not seen. A save moves it by one, as
  deleting an instrument on it does.
- **Limits** (`src/admin/dashboard.ts`): at most 20 sections, 100
  symbols in one and 200 in all; a name is 1 to 40 characters after
  trimming, unique ignoring case; `view` is `cards` or `table`. Past
  any, 400 `bad_arguments`, before anything is resolved.

## The quotes projection

- **`briefItem()` is what a script needs**: price or observation,
  change, unit, currency, times, `stale`, the daily and weekly SMA 50
  and 200, and `last_final`; never quote's `returns`, `session` or
  benchmark.
- **`last_final.daily` is the last final daily bar's `date` and
  `close` with its final row's `sma50` and `sma200`**, the values
  movers crosses from, so a script applies movers' crossing rule
  (`docs/tools.md`, "The tools") without calling movers: counted only
  when `stale` is empty and `sma.daily` is `live` and dated after
  `last_final.daily.date`, with `sma50` when `sma200` is null (under
  200 bars). `last_final` is null with no final bar, an average null
  with too few bars. Daily only: a crossing since the last close is a
  daily question.
- **Averages are rounded to six significant digits and movers compares
  unrounded ones**, so a price that close to its average can count
  differently.

## The research route

- **`symbols` takes up to `MAX_RESEARCH_SYMBOLS` (5), `sections` a list
  of `metric`, `analysts`, `earnings`, `insider`, `next_event`, `news`
  and `filings` (all by default), and `since` a UTC date, with `news`
  asked.** Each item is `input`, `id`, `company` (the Finnhub summary
  with each asked section's `history`), `news` (the news week) and
  `filings` (EDGAR's summary, the tool overview's), or its error; no
  quote, since `/quotes` answers prices in one call. What each holds and
  why is in `docs/research.md` ("The research route").

## Paging

- **Every route answers its whole result but two**, nothing cut to
  fit: a script that does not follow a cursor loses what is past it,
  and an HTTP client has no 32 KiB limit, which is an MCP client's
  (`docs/tools.md`). `next` is refused as any unknown argument is (400
  `bad_arguments`), in a query or a body.
- **The stored list pages by AIP-158's names**: `page_size` 1 to 200,
  50 by default; `page_token` the `next_page_token` of the page before,
  its last id, opaque to the caller; `next_page_token` absent at the
  end. By id, so a row deleted between pages skips no other.
- **A symbol that did not resolve in time answers its error item**,
  never by being left out.
- **The alerts feed keeps its cursor**, since it is a feed polled on a
  schedule, not a list (below).

## Errors

- **A whole call's error is RFC 9457 problem details**,
  `application/problem+json` (`problem()` in `src/api/http.ts`):
  `title` (the status's phrase), `status` (the HTTP status), `detail`,
  and `code`, the one short string a script branches on. `input`,
  `candidates`, `groups`, `rules` and `benchmark` are extensions where
  the tool gives them, and `dashboard` and `errors` where a dashboard
  save is refused. No `type`: RFC 9457 reads a missing one as
  `about:blank`, and a self-hosted server has no fixed address to name.
- **An error about one symbol among several is that item's**, inside
  the 200: `{"input", "error": {"code", "detail", "candidates"?}}`
  (`itemOf()`), so one bad symbol never fails the rest. A script tests
  `.error != null`.
- **Problem details are `/api/v1`'s alone.** `/mcp`'s errors, the web
  UI sign-in's fixed 401 (`/ui/session`) and `/health` keep their
  `{"error", "message"}` bytes (`failed()`), and Bun's empty 413 past
  1 MiB is the one bare answer. The codes are the tools' own;
  `statusOf()` maps them:

| Status | Codes |
|---|---|
| 400 | `bad_arguments`, `mixed_units`, `no_event_source`, `no_event` |
| 401 | `unauthorized`: no key, or a wrong, revoked or expired one; no `WWW-Authenticate`, so an MCP client never starts an OAuth sign-in |
| 403 | `forbidden`: a key without the route's scope, or a cookie request other than `GET` not sent from this server's own pages |
| 404 | `not_found` (route, rule, key, instrument or symbol), `candidates`, `no_data`, `refused` |
| 405 | `method_not_allowed`, with `Allow` |
| 409 | `conflict`, `split_paused` |
| 422 | `unresolved`: a dashboard save naming a symbol that did not resolve |
| 413 | `payload_too_large` |
| 415 | `unsupported_media_type` |
| 429 | `too_many_requests`: past a key's calls a minute, with `Retry-After` in seconds |
| 500 | `internal`, logged with the error's type and first line only |
| 503 | `timeout`, `rate_limited`, `source_error`: ask again later |

- **503 tells a source's failure from a server fault.** A source that
  failed, backs off or ran out of the deadline is the caller's to
  retry; a 500 is not.
- **A body is at most 64 KiB** (`MAX_BODY_BYTES` in `src/api/http.ts`;
  100 symbols and 8 filters are a few KiB), 16 KiB on refetch, answered
  as the problem 413. **Bun refuses a body over 1 MiB before the router
  runs**: 413 with an empty body and the connection closed, which no
  route can shape; the spec says so and `test/api.test.ts` checks both.

## Keys and caching

- **Scopes are per operation, never a path prefix.** The router
  (`router()` in `src/server/http.ts`) matches the method and path
  first, then holds the key to that operation's `scope` (`Route` in
  `routes.ts`): `read` takes an agent key, `admin` the admin key alone,
  `none` no key. Matching first is what tells `GET` from `DELETE` on
  one path.
- **Agent keys are rows the admin makes** (`src/server/access.ts`,
  table `keys`): `1ctx-markets-` and 32 random bytes as base64url,
  stored only as its SHA-256. A bearer is hashed and looked up on every
  request, never cached, so a revoke holds on the next call; an expired
  key is refused as an unknown one and stays listed until revoked. Its
  last use is written through the writer at most once a minute.
- **The admin key holds every scope**, so it opens every read route,
  rules writes and the alerts feed included, as a wider scope holds a
  narrower one, and `/mcp`: a single-user install needs no other key.
- **A valid key without the scope is 403 `forbidden`**: an agent key
  on `GET /instruments`, `DELETE /instruments/{symbol}`, refetch,
  `/status` and `/keys`, and on a portfolio or rules route without
  that access.
- **Portfolio routes take the key's portfolio access** (`keys.portfolio`,
  `none` by default): `portfolio:read` opens with `read` or `write`,
  `portfolio:write` with `write`. Holdings are private, so the read
  scope never opens them. The handler gets the caller (`Who`), whose
  name a write records: `web` for the cookie, `admin`, or the key's
  name. The spec names `portfolioRead` and `portfolioWrite`.
- **Rules routes and the alerts feed take the key's rules access**
  (`keys.rules`, `none` by default) the same way: `rules:read` (the
  list, one rule, the feed) opens with `read` or `write`,
  `rules:write` (create, pause, delete) with `write`. A rule acts for
  the owner, so the read scope never opens them. The spec names
  `rulesRead` and `rulesWrite`. A missing, wrong, revoked or expired key is
  401. Any other `/api/v1/` path, unknown ones included, answers 401
  without a key and 404 with one.
- **Each key makes at most 600 calls a minute** (`CALLS_PER_MINUTE`,
  `src/server/ratelimit.ts`), a fixed window per key id held in memory,
  no flag. Every `/api/v1` request counts, and on `/mcp` every JSON-RPC
  message, a batch's each. Past it the answer is 429 before the body is
  read; a `/mcp` batch's body is read to count its members, the first
  message already counted. The admin key is limited as a key of its
  own; the web UI's cookie is not limited. The windows are capped (`MAX_WINDOWS`), and
  only a valid key reaches them, so memory stays bounded. 600, not
  1ctx's 120: an agent adding a portfolio makes one call per lot, and a
  few hundred lots must fit in one window.
- **A request's log line names its key**: `key=<id> key_name=<name>`,
  or `key=admin`; never a token. A token made by `POST /keys` joins the
  log mask before it is answered (`mask()` in `src/runtime/keys.ts`).
- **The web UI's session cookie opens what the admin key opens but
  the rules writes**, portfolio writes included, (`cookie: false` on `POST /rules`, `PATCH` and
  `DELETE /rules/{id}`); a cookie request that is not a `GET` must come
  from this server's own pages, or it is 403 (`docs/web.md`). A key is
  tried first, the cookie only when no key is valid. The spec names
  `read`, `admin` and `session` per operation.
- **The spec and the docs page are served before any key check**, as
  `/health` is: they hold no data and no key, and a browser opening a
  page sends no key.
- **Every answer carries `x-markets-build`**, an id drawn at each
  start, so the web UI reloads an open tab after a deploy
  (`docs/web.md`).
- **Reads answer `cache-control: no-store`**, since prices are live.
  A bars range whose bars are all final, with `to` before today in the
  instrument's own zone (`localDate()`) and no benchmark, is `private,
  max-age=3600`: final bars change only by a split's rescale or a FRED
  revision, while a range reaching today takes the next live bar. The
  spec and the docs files are `public, max-age=3600`, the docs page
  `no-cache`.

## The alerts feed

A client polling `GET /api/v1/alerts` on a schedule acts only on a new
answer; 1ctx (an agent workspace whose scheduled tasks poll it) is one.

- **The alert id is the cursor, sent as the ETag.** `ETag:
  W/"alerts-<id>"` names the last alert in the page; the client sends it
  back in `If-None-Match`, which also takes it without `W/` (`TAG`).
  Ids autoincrement and are never reused (migration `0009-rules`), so
  alerts fired in the same second are never lost or repeated as a time
  cursor would be.

| Status | When |
|---|---|
| 200 | alerts after the cursor, or from the start after a reset; or a retention gap alone, with `ETag` `lastAlertId()` |
| 204 | no cursor (or a reset one) and no alerts |
| 304 | a cursor and nothing after it; the ETag is repeated |
| 400 | any query argument, or an `If-None-Match` not of this form |
| 401 | no or wrong key |
| 500 | `internal` |

- **Its errors are problem details too**; its pages and empty answers
  keep their bytes.

- **A page stays strictly under 16 KiB** (`ALERT_PAGE_BYTES`), since
  1ctx's poll refuses a larger body. It holds whole alerts oldest first
  with `more`, so a backlog drains over several polls. One alert too
  large alone keeps only `id`, `rule_id`, `fired_at` and `truncated:
  true` (`alertPage()`), so the feed never stalls on it.
- **The same alerts answer the same bytes.** A client may hash the
  last answer; never add a time, counter or other changing field to a
  page.
- **Items are rebuilt from each alert's stored `snapshot`**
  (`alertItem()` in `src/operations/rules.ts`). A change to `Snapshot`
  or `alertItem()` must still read every kept snapshot
  (`docs/storage.md`, "Retention"), and it changes the bytes of pages
  already answered, which starts a polling client's run again.
- **A hole after the cursor is a retention gap**: a first id above
  cursor + 1, or none left while `lastAlertId()` is past the cursor,
  answers `retention_gap: true`. A cursor above any id this database
  issued starts over with `cursor_reset: true`, as after a restore.
- **Delivery is at least once.** The cursor moves only when the client
  stores the new ETag, so a consumer deduplicates by alert id. Answers
  are `cache-control: private, no-store`.

## The spec

- **`src/api/openapi.ts` is OpenAPI 3.1, written by hand as a typed
  object** and served at `/api/v1/openapi.json`. Every route,
  parameter, body, answer and documented error is in it, with two
  bearer security schemes, `read` and `admin`, and the `session`
  cookie, named per operation. Errors are `application/problem+json`
  with the `Problem` schema.
- **Descriptions are for a person reading the docs page**: what a
  route returns, then the limits, defaults and units a caller needs,
  never the reasons behind them or the MCP descriptions copied. They
  name no user, market, holding, key file, flag or data source beyond
  symbol syntax.
- **Schemas use a small subset of JSON Schema**: `type` (an array of
  types for null), `properties`, `required`, `additionalProperties`,
  `items`, `enum`, `oneOf`, `$ref`, and `description`, which checks
  nothing. The `Schema` type allows nothing else and the checker in
  `test/helpers/schema.ts` refuses any other keyword, so no schema
  claims what the test does not hold true. `oneOf` holds when exactly
  one branch matches. A `$ref` stands alone; a value that may be null
  is spelled out inline.
- **An item is a whole result or a whole error.** Quote, research,
  movers and screen items are `oneOf` a result with its fields
  required, `Unavailable` where the tool has it, and `ItemError`
  (`input` and `error`), each closed to other fields, so an item with
  only `input` fails.
- **A free-form object is left open** (a rule's condition, a job row,
  an event): its fields are in the docs here, which a Swagger reader
  cannot open, so the spec names none of them.
- **`test/api.test.ts` holds the spec to the code**: every routed
  method and path is an operation and every operation is routed; every
  schema keeps to the subset; one call per operation for its success
  and for each documented status but 500 (checked once, since every
  route shares one wrapper) is validated against its schema, read
  under the answer's media type, every error's `status` equal to the
  HTTP status, and the test fails when a documented status has no
  call. A new route, field
  or error changes the spec in the same commit.

## The docs page

- **`/api/v1/docs` is Swagger UI, bundled.** `swagger-ui-bundle.js`
  and `swagger-ui.css` from `swagger-ui-dist` (installed with
  `--ignore-scripts`, so its install-time telemetry never runs) are
  embedded in the binary with Bun's `with { type: "file" }` beside
  `src/api/docs/index.html` and `init.js`. Nothing is fetched from
  another host, so the page works on a box with no internet.
- **A strict content security policy** (`POLICY` in `docs.ts`): self
  only, plus `data:` images for Swagger UI's icons. Widen it only from
  a browser run of the page (Authorize and Try it out included) that
  needs it, never by guess.
- **The start-up script is a file, never inline**, so `script-src` is
  `'self'` alone. `validatorUrl` is null, since the validator would
  send the spec to another host; `persistAuthorization` is off, so the
  key typed into Authorize is kept for the page only.
- **Each file is named with its fingerprint** (`fingerprinted()`):
  `<file>?h=<hash>` of its embedded bytes, computed once at start. A CDN
  keeps `.js` and `.css` by extension for hours whatever the server
  says, so a changed file needs a new URL, while an unchanged one stays
  cached. Any `h`, stale or none, answers the file as this build has it.
  The page is `no-cache`, so a new build's names are seen at once; a
  page naming a file other than once fails at start.
- **The page follows the system's light or dark scheme.** Swagger UI's
  CSS carries a dark theme under `html.dark-mode` that its bundle never
  sets, so `init.js` sets it from `prefers-color-scheme` and follows a
  change.
- **The smoke test** (`scripts/smoke.sh`) asks the binary for the page,
  its files and the spec without a key.
