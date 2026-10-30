# Testing

Governs the test suite and its recordings: `test/` (one
`*.test.ts` per area), `test/helpers/`, `test/fixtures/` and the
recorders under `scripts/probe/`. The clock contract is in
`docs/storage.md`; how each source's answers are checked is in its own
doc; key files in `docs/config.md`.

## Running

- **`make test` and `make lint` after any code change.** CI fails when
  lint leaves the tree changed. While working, `bun test
  test/rules.test.ts` runs one file; the whole suite runs before
  finishing.
- **Read the whole output; never pipe it through `tail`, `head` or
  `grep`.** `bun test` prints only failures and the summary, so a
  filtered run hides the line that says what broke and forces a second
  run.
- **`ARGS=--parallel` is for CI only** (`.github/workflows/test.yml`):
  it runs the files in worker processes on every core.

## No network

- **No test reaches a network.** Every source client takes a `fetch`
  (`Fetch` in `src/sources/source.ts`), so a test always passes its
  own; `withApp()` defaults to one that throws `no network in tests`.
- **A fake fetch answers by URL and fails on anything it does not
  know** (`fakeFetch()` in `test/helpers/yahoo.ts` throws `no fixture
  for <url>`), so an unexpected call fails the test instead of passing
  unseen. Tests assert the calls it recorded, or `Calls` in
  `test/helpers/sources.ts`.
- **Source fakes live in helpers, one per source:**

| Helper | Answers |
|---|---|
| `yahoo.ts` | `recorded()`, `fakeFetch()`, `listed()` (a short chart read as a whole history), `backTo()` (made-up weekday rows before a recording), `added()` |
| `bvb.ts` | the Bucharest exchange's pages and chart feed by URL (`bvbFetch()`), `opened()` (a page read as open: every recording is of a closed market), `keyed()` (a made-up page key, which the recordings strip), `bothSources()` with Yahoo |
| `sources.ts` | Yahoo and FRED by URL for reads that fetch inside a call; `gate()` holds a call until released |
| `sim.ts` | a made-up Yahoo for whole simulated days, sessions from each listing's zone |
| `finnhub.ts` | Finnhub by path and symbol, recorded and made-up answers |
| `massive.ts` | Massive's news, filtered, ordered and paged with an opaque `next_url` |
| `edgar.ts` | SEC's ticker map and submissions by URL, a made-up contact line, `share()` for a stored US share |
| `rules.ts` | reads with rules over the recorded sources |
| `app.ts` | the whole server on loopback (`withApp()`) and an MCP SDK client on it (`mcpClient()`) |
| `api.ts` | `/api/v1` through the real router over a test's own `Markets`, each request with the right made-up key (`api()`) |
| `schema.ts` | the JSON Schema subset the API's spec uses; `schemaErrors()` refuses any other keyword |
| `answers.ts` | every MCP tool and every `/api/v1` route over the recordings, as the bytes a client gets (`mcpAnswers()`, `restAnswers()`) |
| `world.ts` | no source at all: instruments, bars, signal rows and quotes written by hand, for the readers' arithmetic |

- **The MCP and REST answers are pinned byte for byte**:
  `test/fixtures/mcp/answers.json` is `mcpAnswers()` and
  `test/fixtures/api/answers.json` is `restAnswers()`, as JSON. A
  change meant to alter an answer writes them again in the same commit
  (`bun -e` importing the function and `Bun.write`) so the review
  reads the diff; any other change leaves them as they are. The
  Swagger UI package's files are pinned by their digest.
- **Keys in tests are made up** (the helpers' constants,
  `test/fixtures/secrets/`, `test/fixtures/short/`). No test reads a
  real key file.

## No elapsed time

- **No test asserts elapsed time or waits on a real timer**: on a busy
  machine a sleep or a margin is flaky and proves nothing about the
  code. A test passes `fakeClock()` (`test/helpers/clock.ts`) and steps
  it: `advance(ms)` fires each due timer in order and lets its promises
  settle before the next.
- **A test's clock starts where its recording was made** (`START`,
  `NOW` in `test/helpers/sources.ts`, or the answer's `recordedAt`):
  sessions, finality and staleness are judged against now, so a clock
  far from the recording changes what is due.
- **Work paced by a limiter settles with `drive()`**
  (`test/helpers/drive.ts`), which moves the clock only to a limiter's
  or queue's next due time (`due()`) and otherwise yields, so a fetch
  timeout or a call's deadline never fires under work still in flight.
  Never advance the clock by a guessed amount to get a limited call
  out.
- **A test that needs a call in flight holds it** (`gate()`, or the
  `hold` option of `sources()`) and awaits `arrived`; never race it
  against a timer.
- **The 20-second timeout is a ceiling, not a budget**: tests in a
  file run concurrently and count their neighbours' work.

## Concurrency

- **Each test builds its own state**, since tests in a file run
  concurrently: its own database (`open(":memory:", clock)`), clock,
  writer and fetch, never module state or `globalThis.fetch`. A test
  that must is `test.serial`.
- **A test of the whole server uses `withApp()`**, which binds port 0
  on loopback and stops the app and the database when the body ends,
  so concurrent tests never share a port.
- **Log lines are collected, never printed** (`lines` of `withApp()`),
  so `test/auth.test.ts` can check that no key reaches the log.

## Fixtures

- **A fixture is one recorded answer as JSON** (`recordedAt`,
  `request`, `status`, `headers`, `body`) under
  `test/fixtures/<source>/`. Tests derive variants in code (`clone()`,
  `listed()`, `backTo()`, `made()`), so a re-recording keeps the edits.
- **A fixture changes only by re-recording.** Never hand-edit a
  recorded body; build the odd case in the test, or a made-up answer
  with `recordedAt: ""` (`test/helpers/sim.ts`).
  `chart-429-chrome-ua.json` is the one fixture no recorder makes;
  re-record it by hand with curl.

## Recorders

Each recorder is run by hand with `bun scripts/probe/<source>.ts`,
reaches the real source and writes into `test/fixtures/<source>/`.
Never run one from a test or CI.

| Script | Records | Key |
|---|---|---|
| `yahoo.ts` | charts, searches, spark and quote batches; a case name records one | none |
| `fred.ts` | daily series' metadata and recent observations, an unknown series, a refused key | `FRED_KEY_FILE` or `~/.1ctx-markets/secrets/source-fred.key` |
| `finnhub.ts` | the research sections, the whole-market calendar, a price target | `FINNHUB_KEY_FILE` or `source-finnhub.key` |
| `massive.ts` | the latest news and its next page, older news | `MASSIVE_KEY_FILE` or `source-massive.key` |
| `edgar.ts` | the ticker map trimmed to the tests' symbols, two years of submissions per company (a bank's note prospectuses sampled), an unknown CIK | `EDGAR_KEY_FILE` or `source-edgar.key`, the contact line |
| `bvb.ts` | the Bucharest exchange's pages and chart feed, trimmed to the fragments that hold data; a case name records one | none; the page key is stripped |

- **Calls are spaced and few** (`GAP_MS`), under each source's limit,
  since a probe shares the user's quota.
- **Keys are read from files and never written.** `readKey()` in
  `scripts/probe/record.ts` reads the file the environment variable
  names or the data directory's. `record()` drops `set-cookie`,
  `authorization` and `x-finnhub-token`, sets a key-named query
  parameter to `REDACTED`, and replaces the key in every form, encoded
  too (`scrub()` in `src/sources/source.ts`), in every string before
  writing, since a cursor URL can echo it. Request headers are never
  stored, so EDGAR's contact line, sent as the User-Agent, stays out
  too. `bvb.ts` strips the page key
  and ASP.NET form state; `yahoo.ts` keeps only the headers a client
  acts on.
- **Restricted values are replaced before the first write.** A series
  whose terms forbid passing its values on is recorded with made-up
  numbers and a `note` saying so (`madeUpValues()` in `fred.ts`,
  through `record()`'s `edit`), so the real values never reach disk. A
  new restricted source does the same.
- **A recording is at most 1 MB;** use a smaller limit or range.

## Names

- **Test names and made-up data are generic.** A test says what holds
  ("a 401 is a refused key and a 429 pauses the source"), never a
  ticket, a date or a person. Examples use market symbols and made-up
  values, never a real person's name or a real key.
