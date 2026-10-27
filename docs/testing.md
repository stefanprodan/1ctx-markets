# Testing

Governs the test suite and its recordings: `test/` (one
`*.test.ts` per area), `test/helpers/`, `test/fixtures/` and the
recorders under `scripts/probe/`. The clock contract is in
`docs/storage.md`; how each source's answers are checked is in
`docs/yahoo.md`, `docs/fred.md` and `docs/research.md`; key files in
`docs/config.md`.

## Running

- **`make test` after any code change, `make lint` too.** `make test`
  runs `bun test --concurrent --max-concurrency 4 --timeout 20000
  test/`; `make lint` runs `biome check --write` and then `bun check`
  (types), and CI fails when lint leaves the tree changed. While
  working, `bun test test/rules.test.ts` runs one file; the whole suite
  runs before finishing.
- **Read the whole output; never pipe it through `tail`, `head` or
  `grep`.** `bun test` prints only failures and the summary, so a
  filtered run hides the one line that says what broke and forces a
  second run.
- **`ARGS=--parallel` is for CI** (`.github/workflows/test.yml`): it
  runs the files in worker processes on every core. Local runs leave it
  off.

## No network

- **No test reaches a network.** Every source client takes a `fetch`
  (`Fetch` in `src/source.ts`) and falls back to the global one only
  when none is passed, so a test always passes its own. `withApp()` in
  `test/helpers/app.ts` defaults to a fetch that throws `no network in
  tests`; a test that wants answers passes one.
- **A fake fetch answers by URL and fails on anything it does not
  know.** `fakeFetch(route)` in `test/helpers/yahoo.ts` records every
  URL and header and throws `no fixture for <url>` when `route` gives
  nothing, so an unexpected call fails the test instead of passing
  unseen. Tests assert calls from `fakeFetch()`'s `urls` and
  `headers`, or from `Calls` (`urls`, `searches()`, `charts()`,
  `sparks()`) in `test/helpers/sources.ts`.
- **Source fakes live in helpers, one per source:**

| Helper | Answers |
|---|---|
| `yahoo.ts` | `recorded()`, `fakeFetch()`, `listed()` (a short chart read as a whole history), `backTo()` (made-up weekday rows before a recording), `added()` |
| `bvb.ts` | the Bucharest exchange's pages and chart feed by URL (`bvbFetch()`), `opened()` (a page read as open: every recording is of a closed market), `keyed()` (a made-up page key, which the recordings strip), `bothSources()` with Yahoo |
| `sources.ts` | Yahoo and FRED by URL from the recordings for reads that fetch inside a call; `gate()` holds a call until released |
| `sim.ts` | a made-up Yahoo for whole simulated days: `US`, `XETRA`, `BVB`, `CRYPTO` listings with sessions from their zone |
| `finnhub.ts` | Finnhub by path and symbol (`AS`): NVDA in full, a 403 refusal, an empty answer, TSM as recorded (its home listing answers); a calendar with no symbol as the whole-market two days or week |
| `massive.ts` | Massive's news, filtered, ordered and paged with an opaque `next_url` |
| `rules.ts` | reads with rules over the recorded sources, quotes edited from the recorded metas |
| `app.ts` | the whole server on loopback (`withApp()`) and an MCP SDK client on it (`mcpClient()`) |
| `api.ts` | `/api/v1` through the real router over a test's own `Markets`, with the right made-up key put on each request (`api()`) |
| `schema.ts` | the JSON Schema subset the API's spec uses: `schemaErrors()` refuses any other keyword, `validate()` checks an answer, `specSchemas()` and `answerSchema()` find them in the spec |
| `answers.ts` | every MCP tool called over the recordings, page by page, as the bytes a client gets (`mcpAnswers()`), pinned by `test/fixtures/mcp/answers.json` |
| `world.ts` | no source at all: instruments of a source no job syncs, with bars, signal rows and quotes written by hand (`world()`, `listing()`), for the readers' arithmetic |

- **The MCP answers are pinned byte for byte.**
  `test/fixtures/mcp/answers.json` is `mcpAnswers()` written as JSON;
  a change meant to alter an answer writes it again in the same commit
  (`bun -e` importing `mcpAnswers()` and `Bun.write`), and the review
  reads its diff. Any other change leaves it as it is.
- **Keys in tests are made up** (`FRED_KEY`, `FINNHUB_KEY`,
  `MASSIVE_KEY` in the helpers; `test/fixtures/secrets/` and
  `test/fixtures/short/` hold test-only bearers, a made-up admin
  key and a made-up Finnhub key file). No test reads a real key file.

## No elapsed time

- **No test asserts elapsed time or waits on a real timer.** Only
  `src/clock.ts` reads the wall clock; every component takes a `Clock`.
  A test passes `fakeClock()` from `test/helpers/clock.ts` and steps
  it: `advance(ms)` fires each due timer in time order and lets its
  promises settle before the next; `next()` is the earliest due timer.
  A real sleep or a margin on a measured duration is flaky on a busy
  machine and proves nothing about the code.
- **A test's clock starts where its recording was made.** `START` is a
  Monday morning; `NOW` in `test/helpers/sources.ts` is just after the
  recorded spark batch; tests built on one answer use its
  `recordedAt`. Sessions, finality and staleness are judged against
  now, so a clock far from the recording changes what is due.
- **Work paced by a limiter settles with `drive()`**
  (`test/helpers/drive.ts`). It moves the fake clock only to a
  limiter's or queue's next due time (`due()` on `Limiter` and `Queue`
  in `src/source.ts`), spacing or back-off end, and otherwise yields a
  turn, so a fetch's 30-second timeout or a call's deadline never fires
  under work still in flight. `pacedOf(m)` lists a read's limiters.
  Never advance the clock by a guessed amount to get a limited call
  out.
- **A test that needs a call in flight holds it**, with `gate()` or
  the `hold` option of `sources()`, and awaits `arrived` before acting;
  never race it against a timer.
- **The 20-second timeout is a ceiling, not a budget.** Tests in a file
  run concurrently and count their neighbours' work, so no test may
  rely on finishing inside a time.

## Concurrency

- **Each test builds its own state.** Tests in a file run
  concurrently, so a test takes its own database (`open(":memory:",
  clock)`), clock, writer and fetch, and never sets module state or
  `globalThis.fetch`. A test that must is `test.serial`.
- **A test of the whole server uses `withApp()`**, which binds port 0
  on loopback and stops the app and closes the database when the body
  ends, so concurrent tests never share a port.
- **Log lines are collected, never printed.** `withApp()` gathers every
  line in `lines`, which `test/auth.test.ts` reads to check that no key
  reaches the log.

## Fixtures

- **A fixture is one recorded answer as JSON:** `recordedAt`, the
  `request` (method and URL), `status`, `headers` and `body`, under
  `test/fixtures/<source>/`. Tests read them as recorded and derive
  variants in code (`clone()`, `listed()`, `backTo()`, `made()`), so a
  re-recording keeps the edits.
- **A fixture changes only by re-recording.** Never hand-edit a
  recorded body; build the odd case from a recording in the test, or
  build a made-up answer in code with `recordedAt: ""`
  (`test/helpers/sim.ts`). `chart-429-chrome-ua.json` is the one
  fixture no recorder makes; re-record it by hand with curl.

## Recorders

Each recorder is run by hand with `bun scripts/probe/<source>.ts`,
reaches the real source and writes into `test/fixtures/<source>/`.
Never run one from a test or CI.

| Script | Records | Key |
|---|---|---|
| `yahoo.ts` | charts (splits, weeks, sessions, indices, FX, futures), searches, v7 and v8 spark and v7 quote batches; a case name records one | none |
| `fred.ts` | four daily series' metadata and last 30 observations, an unknown series, a refused key | `FRED_KEY_FILE` or `~/.1ctx-markets/secrets/source-fred.key` |
| `finnhub.ts` | the five research sections for a US share, a Xetra ETF and a Bucharest share, the whole-market calendar for one day, two days and a week, a price target | `FINNHUB_KEY_FILE` or `source-finnhub.key` |
| `massive.ts` | the latest news and its next page, older and year-old NVDA news | `MASSIVE_KEY_FILE` or `source-massive.key` |
| `bvb.ts` | the Bucharest Stock Exchange's pages and chart feed, trimmed to the fragments that hold data; a case name records one | none; the page key is stripped |

- **Calls are spaced and few** (`GAP_MS`, `sleep()` between cases),
  under each source's limit, since a probe shares the user's quota.
- **Keys are read from files and never written.** `readKey()` in
  `scripts/probe/record.ts` reads the file the environment variable
  names or the data directory's. `record()` drops `set-cookie`,
  `authorization` and `x-finnhub-token`, replaces a key-named query
  parameter with `REDACTED`, and replaces the key in every form, encoded too
  (`scrub()` in `src/source.ts`), in every string of the output before
  writing (a cursor URL can echo it). `bvb.ts`
  strips the page key and ASP.NET form state (`scrub()`); `yahoo.ts`
  keeps only the headers a client acts on.
- **Restricted values are replaced before the first write.** A series
  whose terms forbid passing its values on is recorded with made-up
  numbers and a `note` saying so (`synthetic`, `madeUpValues()` in
  `fred.ts`), through `record()`'s `edit`, so the real values never
  reach disk. A new restricted source does the same.
- **A recording is at most 1 MB;** use a smaller limit or range.

## Names

- **Test names and made-up data are generic.** A test says what holds
  ("a 401 is a refused key and a 429 pauses the source"), never a
  ticket, a date of the fix or a person. Examples use market symbols
  and made-up values, never a real person's name or a real key.
