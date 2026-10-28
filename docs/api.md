# The HTTP API

Governs the REST API under `/api/v1`: `src/api/` (`routes.ts`,
`http.ts`, `openapi.ts`, `schemas.ts`, `paths.ts`, `docs.ts`, `docs/`),
the router's part in `src/server/http.ts`, the alerts feed
(`src/api/alerts.ts`) and the operator's routes (`src/admin/http.ts`).
What each route reads is its tool's, in `docs/tools.md`,
`docs/research.md` and `docs/rules.md`; what an alert is in
`docs/rules.md`; the admin key and what refetch and delete do in
`docs/admin.md`; the server, bearer and flags in `docs/config.md`.

## Why

Scripts, scheduled jobs and other tools read the server over plain
HTTP. They get a fixed, versioned surface with a machine-readable
description they can browse and try, instead of routes shaped by one
consumer each.

## Routes

| Method and path | Key | Calls | Answers |
|---|---|---|---|
| `GET /api/v1/quotes?symbols=&extended=` | read | `quoteRows()` with `briefItem()` | every symbol asked, up to `MAX_SYMBOLS` (100); `extended=true` adds the quote tool's `extended` per item |
| `GET /api/v1/history?symbol=&interval=&from=&to=&benchmark=` | read | `readHistory()` | the instrument (`id`, `name`, `exchange`, `type`, `currency`, `unit`, `source`, `basis`, `stale`, FRED's `attribution`), `from`, `to`, the tool's `session`, `interval`, the tool's `relative` when a benchmark is named, and `bars` oldest first: `date`, `close`, `final`, `sma50`, `sma200` |
| `GET /api/v1/search?query=` | read | `searchAll()` | every candidate, the tool's fields |
| `GET /api/v1/research?symbols=&sections=&since=` | read | `researchList()` | up to `MAX_RESEARCH_SYMBOLS` (5) brief quotes with their research summary and news week (below) |
| `GET /api/v1/events?from=&to=&symbols=` | read | `readEventsOf()` | every event, `unavailable` and `no_event` uncapped |
| `GET /api/v1/movers?symbols=&min_move_pct=&direction=&average=&relation=` | read | `readMovers()`, `setAll()` | every match, unavailable and error, with `counts` |
| `POST /api/v1/screen` | read | `readScreen()`, `setAll()` | the same; the body is the tool's arguments, since `filters` is a structure |
| `GET /api/v1/rules` | read | `readRules()`, `ruleItem()` | every rule |
| `POST /api/v1/rules` | read | `createRule()` | 201 with the rule, its first evaluation and any alert it fired |
| `PATCH /api/v1/rules/{id}` | read | `pauseRule()` | `{"paused": bool}` sets or clears the manual pause |
| `DELETE /api/v1/rules/{id}` | read | `deleteRuleById()` | 204; its alerts stay |
| `GET /api/v1/alerts` | read | `alertsHandler()` | the alerts feed (below) |
| `GET /api/v1/admin/status` | admin | `adminStatus()` | `docs/admin.md` |
| `GET /api/v1/admin/instruments?query=&after=&limit=` | admin | `adminInstruments()` | a page of stored instruments and what tracks each (`docs/admin.md`) |
| `POST /api/v1/admin/refetch` | admin | `adminRefetch()` | `docs/admin.md` |
| `DELETE /api/v1/admin/instruments/{id}` | admin | `adminDelete()` | `docs/admin.md` |
| `GET /api/v1/openapi.json` | none | `spec` | the OpenAPI document |
| `GET /api/v1/docs`, `GET /api/v1/docs/{file}` | none | `docs.ts` | the bundled Swagger UI page and its files |

- **A route calls the code its tool calls**, so resolution, tracking,
  the deadline, the limits and the error codes are the tool's, never
  copied (`docs/tools.md`, "One read, two surfaces").
- **Each route chooses its fields.** quotes and research answer a
  smaller projection (below), history the one in the table; every
  other route answers its tool's fields. A projection grows only when
  a script needs a field.
- **Query parameters for reads, a JSON body for a structure.** A list
  is one comma-separated value (`symbols=A,B`), as a shell script
  builds it; each parameter is given once; a boolean is `true` or
  `false`. `queryArgs()` turns them into the input the tool's own
  parser checks, so an error names the argument as the tool does.

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

- **`symbols` takes up to `MAX_RESEARCH_SYMBOLS` (5), `sections` a
  list of `metric`, `analysts`, `earnings`, `insider`, `next_event`
  and `news` (all by default), and `since` a UTC date, with `news`
  asked.** Each share answers its brief quote (above), its research
  summary with each asked section's `history`, and its news week;
  what each holds and why is in `docs/research.md` ("The research
  route").

## No paging

- **Every route answers its whole result**, nothing cut to fit: a
  script that does not follow a cursor loses what is past it, and an
  HTTP client has no 32 KiB limit, which is an MCP client's
  (`docs/tools.md`). The operator's instrument list is the one paged
  route, by `after`, since the web UI draws it a screen at a time
  (`docs/admin.md`).
- **No `next` in an answer or an argument**: `next` is refused as any
  unknown argument is (400 `bad_arguments`), in a query or a body.
- **A symbol that did not resolve in time answers its error item**,
  never by being left out.
- **The alerts feed keeps its cursor**, since it is a feed polled on a
  schedule, not a list (below).

## Errors

- **One shape: `{"error": code, "message": text}`**, with extra fields
  where the tool gives them (`input`, `candidates`, `groups`, `rules`,
  `benchmark`). The codes are the tools' own; `statusOf()` in
  `src/api/http.ts` maps them:

| Status | Codes |
|---|---|
| 400 | `bad_arguments`, `mixed_units`, `no_event_source`, `no_event` |
| 401 | `unauthorized` |
| 403 | `forbidden`: a cookie request other than `GET` not sent from this server's own pages |
| 404 | `not_found` (route, rule, instrument or symbol), `candidates`, `no_data`, `refused` |
| 405 | `method_not_allowed`, with `Allow` |
| 409 | `conflict`, `split_paused` |
| 413 | `payload_too_large` |
| 415 | `unsupported_media_type` |
| 500 | `internal`, logged with the error's type and first line only |
| 503 | `timeout`, `rate_limited`, `source_error`: ask again later |

- **503 tells a source's failure from a server fault.** A source that
  failed, backs off or ran out of the deadline is the caller's to
  retry; a 500 is not.
- **A body is at most 64 KiB on the read routes** (`MAX_BODY_BYTES` in
  `src/api/http.ts`; 100 symbols and 8 filters are a few KiB) and 16
  KiB on the admin routes, answered as the JSON 413. **Bun refuses a body over 1 MiB before the router runs**:
  413 with an empty body and the connection closed, which no route can
  shape; the spec says so and `test/api.test.ts` checks both.

## Keys and caching

- **The read key is the bearer; the admin key takes
  `/api/v1/admin/*` alone.** Each is refused where the other is
  taken.
- **The web UI's session cookie opens `/api/v1/admin/*` and every
  `GET` under `/api/v1` and `POST /api/v1/screen`**, never a rules
  write or `/mcp`; a cookie request that is not a `GET` must come from
  this server's own pages (`docs/web.md`). The spec names
  it as the `session` security scheme beside `read` on the reads and
  `admin` on the admin routes. Rules writes take the read key, as the MCP rules tool does.
  Any other `/api/v1/` path, unknown ones included, answers 401
  without a key and 404 with one.
- **The spec and the docs page are served before the bearer check**,
  as `/health` is: they hold no data and no key, and a browser opening
  a page sends no bearer.
- **Reads answer `cache-control: no-store`**, since prices are live.
  A history range whose bars are all final, with `to` before today in
  the instrument's own zone (`localDate()`) and no benchmark, is
  `private, max-age=3600`: final bars change only by a split's rescale
  or a FRED revision, while a range reaching today takes the next live
  bar. The spec and the docs files are `public, max-age=3600`, the
  docs page `no-cache`.

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
| 401 | no or wrong bearer |
| 500 | `internal` |

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
  cookie.
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
  required, `Unavailable` where the tool has it, and `ItemError`, each
  closed to other fields, so an item with only `input` fails.
- **A free-form object is left open** (a rule's condition, a job row,
  an event): its fields are in the docs here, which a Swagger reader
  cannot open, so the spec names none of them.
- **`test/api.test.ts` holds the spec to the code**: every routed
  method and path is an operation and every operation is routed; every
  schema keeps to the subset; one call per operation for its success
  and for each documented status but 500 (checked once, since every
  route shares one wrapper) is validated against its schema, and the
  test fails when a documented status has no call. A new route, field
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
