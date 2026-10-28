# The HTTP API

Governs the REST API under `/api/v1`: `src/api/` (`routes.ts`,
`http.ts`, `openapi.ts`, `schemas.ts`, `paths.ts`, `docs.ts`, `docs/`),
the router's part in `src/server/http.ts`, the alerts feed
(`src/api/alerts.ts`) and the operator's routes (`src/admin/http.ts`).
What each route reads is its tool's, in `docs/tools.md`,
`docs/research.md` and `docs/rules.md`; the admin key and what refetch
and delete do in `docs/admin.md`; the server, bearer and flags in
`docs/config.md`.

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
| `GET /api/v1/research?symbols=&sections=&since=` | read | `researchList()` | up to `MAX_RESEARCH_SYMBOLS` (5) brief quotes with their research summary and news week |
| `GET /api/v1/events?from=&to=&symbols=` | read | `readEventsOf()` | every event, `unavailable` and `no_event` uncapped |
| `GET /api/v1/movers?symbols=&min_move_pct=&direction=&average=&relation=` | read | `readMovers()`, `setAll()` | every match, unavailable and error, with `counts` |
| `POST /api/v1/screen` | read | `readScreen()`, `setAll()` | the same; the body is the tool's arguments, since `filters` is a structure |
| `GET /api/v1/rules` | read | `readRules()`, `ruleItem()` | every rule |
| `POST /api/v1/rules` | read | `createRule()` | 201 with the rule, its first evaluation and any alert it fired |
| `PATCH /api/v1/rules/{id}` | read | `pauseRule()` | `{"paused": bool}` sets or clears the manual pause |
| `DELETE /api/v1/rules/{id}` | read | `deleteRuleById()` | 204; its alerts stay |
| `GET /api/v1/alerts` | read | `alertsHandler()` | the alerts feed (below) |
| `GET /api/v1/admin/status` | admin | `adminStatus()` | `docs/admin.md` |
| `POST /api/v1/admin/refetch` | admin | `adminRefetch()` | `docs/admin.md` |
| `DELETE /api/v1/admin/instruments/{id}` | admin | `adminDelete()` | `docs/admin.md` |
| `GET /api/v1/openapi.json` | none | `spec` | the OpenAPI document |
| `GET /api/v1/docs`, `GET /api/v1/docs/{file}` | none | `docs.ts` | the bundled Swagger UI page and its files |

- **A route calls the code its tool calls.** Resolution through
  `readTargets()`, tracking, the 15-second deadline, the limits and the
  error codes are the tool's, never copied: each tool is split into a
  read that both share and its MCP paging. The MCP answers stay byte
  for byte as they were (`test/fixtures/mcp/answers.json`).
- **Each route chooses its fields.** quotes answers `briefItem()`'s
  smaller projection and history the one in the table; every other
  route answers its tool's fields. A projection grows only when a
  script needs a field.
- **Query parameters for reads, a JSON body for a structure.** A list
  is one comma-separated value (`symbols=A,B`), as a shell script
  builds it; each parameter is given once; a boolean is `true` or
  `false`. `queryArgs()` turns them into the input the tool's own
  parser checks, so an error names the argument as the tool does.
- **The research route is for scripts.** `sections` picks the parts
  each share answers (`metric`, `analysts`, `earnings`, `insider`,
  `next_event`, `news`; all by default), and a Finnhub section left out
  is not fetched. `since` moves the news window's start, a UTC date at
  most `SINCE_DAYS` back, with `news` asked; the window is seven days
  otherwise.
- **Each share is its brief quote with a Finnhub summary and a news
  week**, under the same deadline and tracking as the tool.
- **Each Finnhub section but `metric` adds `history`**:
  its newest rows, the latest included, each as the section's page
  shows it, so a script reads a trend without paging the tool. The
  counts are fixed (`HTTP_HISTORY`), never arguments, to keep five
  summaries short: `analysts` two months, the least that shows a
  direction; `earnings` four quarters, one fiscal year of beats and
  misses; `insider` the three newest months with a row (Finnhub has
  none for a month without trades), a quarter of activity. Rows of
  another listing follow the section's rules, so `earnings` and
  `insider` hold none, and `listing` is on the section, not each row.
  The `research` overview carries no history.
- **Each share's `news` is the stored summary of a window; it fetches
  no news** (`newsWeek`). The window starts seven days before the call
  (`WEEK_MS`, the span a daily reader needs) or at `since`, by
  published time; `counts` cover that window and `items` hold at most three
  (`WEEK_ITEMS`) in the summary's order, each `published_at`,
  `publisher`, `sentiment`, `title`, `reasoning`, `url` and
  `truncated`. A share never walked answers counts of 0 with `stale`
  saying why; off or not covered answers `NO_NEWS` or
  `NEWS_NOT_COVERED`. The item count is a constant, not an argument:
  the route is for scripts and stays small.
- **Its items have caps of their own, a budget that keeps five shares
  with their history short, not a display width**: title 160 characters
  (`WEEK_TITLE`), publisher 60 (`WEEK_PUBLISHER`), reasoning 280
  (`WEEK_REASONING`), cut with an ellipsis; a URL over 300
  (`WEEK_URL`) answers `url: null`, since a cut link is broken. Any
  cut or left-out field sets `truncated`. The `news` section keeps the
  stored caps.
- **Nothing is cut to fit a page**: the route is unpaged, so every
  summary and item is answered.
- **Five research symbols** (`MAX_RESEARCH_SYMBOLS`): a share never
  fetched costs five Finnhub calls, and the free key allows 60 a minute
  shared with the server's jobs.

## The quotes projection

- **`briefItem()` is what a script needs**: price or observation,
  change, unit, currency, times, `stale`, the daily and weekly SMA 50
  and 200, and `last_final`, never quote's `returns`, `session` or
  benchmark: the projection adds a field only when a script needs it.
- **`last_final.daily` is the last final daily bar's `date` and
  `close` with its final row's `sma50` and `sma200`**, the values
  movers crosses from, so a script tells a crossing since the last
  close without movers. `last_final` is null with no final bar, an
  average null with too few bars. Daily only: a crossing since the
  last close is a daily question; `weekly` may be added beside it.
- **The crossing rule**, counted only when `stale` is empty and
  `sma.daily` is `live` and dated after `last_final.daily.date`, as
  movers counts it: `last_final.daily.close >= last_final.daily.sma200`
  and `price < sma.daily.sma200` is crossed below, `<=` and `>` back
  above. With `last_final.daily.sma200` null (under 200 bars) the
  same with `sma50`. Averages are rounded to six significant digits
  and movers compares unrounded ones, so a close or price that close
  to its average can count differently.

## No paging

- **Every route answers its whole result.** A script that does not
  follow a cursor loses what is past it, and an HTTP client has no
  32 KiB limit: that page is an MCP client's (`docs/tools.md`). 100
  quotes are about 51 KB, ten years of daily bars about 200 KB.
- **No `next` in an answer or an argument.** `next` is refused as any
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
  KiB on the admin routes, answered as the JSON 413. **Bun refuses a
  body over 1 MiB before the router runs**: status 413 with an empty
  body and the connection closed, which no route can shape; the spec
  says so and `test/api.test.ts` checks both.

## Keys and caching

- **The read key is the bearer; the admin key takes
  `/api/v1/admin/*` alone.** Each is refused where the other is
  taken. Rules writes take the read key, as the MCP rules tool does.
  Any other `/api/v1/` path, unknown ones included, answers 401
  without a key and 404 with one.
- **The spec and the docs page are served before the bearer check**,
  as `/health` is: they hold no data and no key, and a browser opening
  a page sends no bearer.
- **Reads answer `cache-control: no-store`**, since prices are live.
  Two exceptions: a history range whose bars are all final, with `to`
  given and before today in the instrument's own zone (`localDate()`)
  and no benchmark, is `private, max-age=3600`, since final bars change
  only by a split's rescale or a FRED revision; a range ending today or
  later takes the next live bar, so it is never kept. The spec and the
  docs files are `public, max-age=3600`, the docs page `no-cache`.

## The alerts feed

A client polling `GET /api/v1/alerts` on a schedule acts only on a new
answer; 1ctx (an agent workspace whose scheduled tasks poll it) is one.

- **The alert id is the cursor, sent as the ETag.** `ETag:
  W/"alerts-<id>"` names the last alert in the page; the client sends it
  back in `If-None-Match`, which also takes `"alerts-<id>"` without
  `W/` (`TAG`). Ids autoincrement and are never reused (migration
  `0009-rules`), so alerts fired in the same second are never lost or
  repeated as a time cursor would be.

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
  (`alertItem()` in `src/operations/rules.ts`). A change to `Snapshot` or
  `alertItem()` must still read 90 days of old snapshots, and it
  changes the bytes of pages already answered, which starts the
  check's run again.
- **A hole after the cursor is a retention gap.** Alerts are kept 90
  days; a first id above cursor + 1, or none left while
  `lastAlertId()` is past the cursor, answers `retention_gap: true`.
  A cursor above any id this database issued starts over with
  `cursor_reset: true`, as after a restore.
- **Delivery is at least once.** The cursor moves only when the client
  stores the new ETag, so a consumer deduplicates by alert id. Answers
  are `cache-control: private, no-store`.

## The spec

- **`src/api/openapi.ts` is OpenAPI 3.1, written by hand as a typed
  object** and served as JSON at `/api/v1/openapi.json`. Every route,
  parameter, body, answer and documented error is in it. Two HTTP
  bearer security schemes, `read` and `admin`.
- **Descriptions give each limit's general reason** (why 100 symbols,
  why five research symbols, the deadline, staleness), never the MCP
  descriptions copied, and name no user, market or holding.
- **Schemas use a small subset of JSON Schema**: `type` (an array of
  types for null), `properties`, `required`, `additionalProperties`,
  `items`, `enum`, `oneOf`, `$ref`, and `description`, which annotates
  and checks nothing. The `Schema` type allows nothing else, and the
  checker in `test/helpers/schema.ts` refuses any other keyword, so no
  schema claims what the test does not hold true. `oneOf` holds when
  exactly one branch matches. A `$ref` stands alone; a value that may
  be null is spelled out inline.
- **An item is a whole result or a whole error.** Quote, research,
  movers and screen items are `oneOf` a result with its fields
  required, `Unavailable` where the tool has it, and `ItemError`, each
  closed to other fields, so an item with only `input` fails.
- **A free-form object says where its fields are.** A rule's
  condition, a job row, an event and the like stay `type: object` with
  a `description` naming the doc that gives their fields, rather than
  a second copy of them here.
- **`test/api.test.ts` holds the spec to the code**: every routed
  method and path is an operation and every operation is routed; every
  schema keeps to the subset; one call per operation for its success
  and for each documented status but 500 (checked once, since every
  route shares one wrapper) is validated against its schema, and the
  test fails when a documented status has no call. A new route, field
  or error changes the spec in the same commit.

## The docs page

- **`/api/v1/docs` is Swagger UI, bundled.** `swagger-ui-dist`
  (exact pin, installed with `--ignore-scripts`, so its install-time
  telemetry never runs) gives `swagger-ui-bundle.js` and
  `swagger-ui.css`, embedded in the binary with Bun's `with { type:
  "file" }` beside our own `src/api/docs/index.html` and `init.js`.
  Nothing is fetched from another host, so the page works on a box
  with no internet.
- **A strict content security policy** (`POLICY` in `docs.ts`): self
  only, plus `data:` images for Swagger UI's icons. A browser run of
  the page, Authorize and Try it out included, needed nothing more;
  widen it only from such a run, never by guess.
- **The start-up script is a file, never inline**, so `script-src` is
  `'self'` alone. `validatorUrl` is null, since the validator would
  send the spec to another host; `persistAuthorization` is off, so the
  key typed into Authorize is kept for the page only.
- **Each file is named with its fingerprint** (`fingerprint()`,
  `fingerprinted()` in `docs.ts`): the first 12 hex digits of its
  bytes' SHA-256, computed once at start from the files embedded in the
  binary, as `<file>?h=<hash>`. A CDN keeps `.js` and `.css` by their
  extension for hours whatever the server says, so a changed file
  needs a new URL, while an unchanged one keeps its URL and stays
  cached. Any `h`, stale or none, answers the file as this build has
  it. The page is `no-cache`, so a new build's names are seen at once;
  a page naming a file other than once fails at start.
- **The page follows the system's light or dark scheme.** Swagger UI's
  CSS carries a dark theme under `html.dark-mode` that its bundle never
  sets, so `init.js` sets it from `prefers-color-scheme` and follows a
  change.
- **The smoke test** (`scripts/smoke.sh`) asks the binary for the page,
  its files and the spec without a key.
