# Tools

Governs the Model Context Protocol (MCP) tools: `src/server/mcp.ts`,
`src/server/instructions.ts`, `src/tools/index.ts`, and `answer.ts`,
`args.ts`, `markets.ts`, `targets.ts`, `quote.ts`, `extended.ts`,
`history.ts`, `search.ts`, `movers.ts`, `screen.ts` and `sets.ts` under
`src/operations/`. The HTTP API that calls the same reads is in
`docs/api.md`; the research and events tools in `docs/research.md`;
the rules tool in `docs/rules.md`; signal rows and returns in
`docs/signals.md`; units, stale reasons and tracking in
`docs/storage.md`; the source queue and deadlines in
`docs/sources.md`; the server, bearer and flags in `docs/config.md`.

## The MCP endpoint

- **The handler is stateless: a new `McpServer` per request**
  (`mcpHandler()`), so no tool may keep per-session state. A new tool
  is added to `tools()` in `src/tools/index.ts`.
- **SDK errors are logged with type and code only**
  (`sdkErrorFields()`), since an SDK message can quote the request.

## Server instructions

- **One text sent on initialize** (`INSTRUCTIONS`) says which tool
  answers what and what holds across tools. A client may list a tool
  by one line and cuts its description (below), so guidance across
  tools lives here; never repeat a description's argument list.
- **At most `INSTRUCTIONS_BYTES` (4 KB)**: clients cut long
  instructions from the end. A new line pushes an old one out, or the
  cap is raised as a choice in review. Nothing that dates (symbol
  lists, dates, prices).
- **Routing first, what the server does not hold last**, so a cut drops
  the least. No portfolio, holding, market, country or default symbol:
  the text goes to every user.
- **`test/instructions.test.ts` holds it to that**: under the cap, the
  groups in order, every tool named, every backticked name a tool, an
  argument or a listed answer field, and a deny list. Whether those
  fields are still answered is left to review.

## The answer contract

- **Every answer is one JSON text part** (`textResult()`,
  `errorResult()` in `answer.ts`). Clients render a second part or a
  structured result differently, and 1ctx (an agent workspace, this
  server's first MCP client) reads the first text part only.
- **A page fits 32 KiB twice: its text, and the result serialized
  plus the JSON-RPC envelope** (`PAGE_BYTES`, `fits()`). Codex has the
  smallest limit of the clients 1ctx supports, used with untouched
  defaults. Measure bytes, never characters: escapes grow inside the
  result's JSON.
- **Pages hold whole items** (`fitPage()`), the list as the object's
  last field; one item too large alone throws `PageOverflow`. Never
  cut text inside an item; shorten what an item holds instead.
- **A cursor is bound to the arguments it continues**: `cursor()`
  appends a digest of the arguments without `next`, and `readCursor()`
  refuses it with other arguments (`bad_arguments`). quote binds its
  `benchmark` only when one is given, so a cursor without one stays
  valid. The position is the next offset, the next bar's date
  (history) or the next rule id (rules list).
- **movers and screen page a fresh view**: each call reads again and
  pages the sorted set from the offset, `counts` covering every page;
  the set may shift between pages, as the descriptions say. An offset
  past a set that shrank is refused (`startOf()`).
- **An error is a result with `isError`, in the same one-part form**,
  cut to `error` and a 1,024-character message when too long. An
  `ArgError` answers `bad_arguments`; any other throw is logged and
  answered `internal` "internal error", since a thrown message can
  quote a source (`call()` in `src/tools/index.ts`).
- **A symbol's failure is an item, not the call's.** quote, movers and
  screen answer per-symbol errors as items with fixed messages
  (`ERRORS`, `itemError()` in `targets.ts`). history fails as a whole
  when its symbol fails; a failed benchmark is an error inside
  `relative`, and fails a screen call.
- **Numbers are rounded on the way out**: `round()` (6 significant
  digits) for signals and changes, `price()` (8) for bar prices, which
  drops Yahoo's single-precision noise and keeps a crypto price's
  cents (`src/market/format.ts`). Quote prices go out as the source
  sent them. Times are UTC to the second (`iso()`).

## Arguments

- **Each tool checks its own arguments**: the MCP schemas use a
  permissive validator (`permissive`), so an error names the argument
  in the tool's words. Schemas set `additionalProperties: false` and
  `fields()` refuses an unknown argument rather than ignoring it.
- **Arguments are checked before anything is resolved or fetched.**
  A symbol is 1 to 100 characters (`MAX_SYMBOL`), a list 1 to 100
  symbols (`MAX_SYMBOLS`), a date `YYYY-MM-DD`. Text quoted back in an
  error is cut at 64 characters (`quoted()`).
- **Only rules carries write annotations.** Every other tool is
  `readOnlyHint: true`, `openWorldHint: true`: an inline fetch only
  adds market data.

## The tools

| Tool | Takes | Answers |
|---|---|---|
| `quote` | `symbols`, `benchmark`, `extended`, `next` | per symbol a `QuoteItem` (`quote.ts`) with `returns`, `session`, with a benchmark `relative_return_1m` and `_3m`, with `extended` true `extended` |
| `history` | `symbol`, `interval`, `from`, `to`, `benchmark`, `next` | bars oldest first with `final` and signals; `session`; `relative` |
| `search` | `query`, `next` | up to 20 stored matches, then the Bucharest feed's tradable listings while it is on, then Yahoo's, each with id, exchange, type, name, `source`, `stored`; a Bucharest listing adds its `isin` |
| `movers` | `symbols`, `min_move_pct`, `direction`, `average`, `relation`, `next` | matches by absolute change, largest first; `counts` |
| `screen` | `symbols`, `filters`, `benchmark`, `sort`, `order`, `fields`, `next` | matches with each used and asked field's value, unit, kind and date; `counts` |
| `research`, `events` | see `docs/research.md` | |
| `rules` | see `docs/rules.md` | |

- **quote's `returns` answer "how did it do" without `history`**
  (`docs/signals.md`, "Trailing returns").
- **quote's `benchmark` is one symbol for the call**, resolved and
  fetched as history's, adding `relative_return_1m` and `_3m` per item
  and the benchmark's id, `fetched_at` and `stale` on the page, its
  reasons prefixed `benchmark:` in the page's `stale`; a benchmark that
  fails is that object's error and the relative fields are null.
- **quote's `session` is the last regular session the source
  reported**: `state` `open` or `closed` by `isQuoted()`, `start` and
  `end` in UTC. At an opening it reads `closed` until a check stores
  the day's session. Crypto is always `open` with null bounds; a FRED
  series answers null. Only the regular session is stored
  (`docs/calendars.md`), so there is no pre-market or holiday state.
  Not named `market`, which an id's prefix already is.
- **quote's `extended` is asked, never default** (`extended.ts`), so a
  large quote at night makes no extra calls. A reader of a share that
  reports after the close wants the first price after the release, and
  before the open the pre-market one. It is the latest priced bar in a
  pre or post window since the last regular close, kept until the next
  regular open, with `change` from the regular close. Null comes with
  an `extended:` reason in `stale` (`docs/storage.md`), never meaning
  the price held. One chart per listing within the call's deadline
  (`docs/yahoo.md`), kept in memory for a quote period
  (`m.extended`), so the thin market is never fresher than the regular
  one. Never stored: signals, bars, movers, screen, history and rules
  read the regular session only.
- **`returns`, `session` and `extended` are the quote tool's only**:
  `quoteItem()`, which screen, movers and the API's quotes route share,
  never computes them. Bars are read from the earliest start a call
  needs (`readCloses()`), the benchmark's once per call.
- **history's latest session bar is its live quote's** (`withLive()`
  in `history.ts`): the quote's price as the close, its day range
  widening the stored one, beside the live row's signals, even before
  the source has a bar for the day. A stored bar of that session is
  from the bar pass near the open, hours old, and the Bucharest feed
  often has none. It is the bar the live row steps from
  (`docs/signals.md`), so the two never disagree.
- **history's `session` is quote's**, so a reader tells an intraday
  bar from an unsettled close: a day's bar stays not final after its
  close until the source shows a later session (`docs/calendars.md`).
- **history defaults its range from the last bar**: `to` the latest
  bar, `from` 3 months back for `1d`, 24 for `1wk` (`DEFAULT_MONTHS`).
  `basis` states the price basis (`BASIS`, `FRED_BASIS`).
- **A Bucharest search candidate's type is the chart feed's**
  (`types`, `docs/bvb.md`), since the site's search gives none: the
  type its instrument would take, else the feed's own. That is one
  more feed call per search with a tradable listing, within what is
  left of the search's own deadline, so search answers within one
  call's time; failed or late, the type is null. Its `isin`
  is the site's, kept on a stored candidate too.
- **search fetches no prices and tracks nothing.** FRED is asked only
  for `FRED:<series id>`, with a note when the series is not daily; a
  stored series also matches by symbol or name. A source that failed
  or timed out is in `errors`, beside what the other side found.
- **movers needs a move, an average or both.** `direction` needs
  `min_move_pct`; `average` and `relation` go together. A cross needs
  the live row dated after the last final row: `crossed_up` holds when
  the last final close is at or below the final row's average and the
  live price above the live average, `crossed_down` at or above and
  below (`relate()`). With no live row the symbol is unavailable.
- **screen filters and sorts on a fixed list of fields** (`FIELDS` in
  `screen.ts`), at most 8 filters (`MAX_FILTERS`), all of which must
  hold: `{field, min, max}` inclusive, or `{field, eq}` with -1, 0 or 1
  for the state fields. A call gives filters, a sort or both; `order`
  needs `sort`; a range filter needs `min` or `max`, `min` not above
  `max`; a state field takes `eq` only. A `benchmark` is accepted only
  with a `relative_return_*` field and required by one. `return_*`
  follow quote's `returns`.
- **screen's `fields` shows up to `MAX_FIELDS` (8) more fields on every
  row**, so one call answers values no filter reads. They never
  filter: one missing is `null` on a match, never `unavailable`, and
  never makes a mix of units refused.
- **A match is never made from a missing, null or stale input.** In
  movers and screen such a symbol is `unavailable` with what it lacked,
  listed after the matches, then the errors (`sets.ts`). Only a match
  can be wrong in silence.
- **Price-level screen fields refuse a mix of units**: a used field in
  the listing's own unit and currency over symbols spanning more than
  one answers `mixed_units` with the groups, pointing at the percent
  fields such as `distance_sma50`.

## Values, units and staleness

- **A signal row is answered `live` or `final`** (`docs/signals.md`,
  "Reading"). Live prices drive every answer: never add a closed-only
  variant or a warning about intraday prices.
- **A FRED series is an `observation`, not a `market_quote`**: `price`
  null, `observation` the last value and date. It has final rows only,
  never moves in movers, and has no price for a screen distance. A
  page holding FRED values carries FRED's `attribution` once.
- **Every quote item carries its unit and currency**, `unknown`
  answered rather than guessed (`docs/storage.md`, "Instruments"). A
  FRED `percent` series changes in points, so its `change_percent` is
  null; relative return's units are in `docs/signals.md`.
- **Staleness travels with the value**: `stale` holds fixed reasons
  (`docs/storage.md`), a benchmark's prefixed `benchmark:`; an empty
  list means current.

## Resolution and the inline fetch

- **A symbol resolves to one stored instrument, never by a guess**
  (`step()` in `targets.ts`); what is not exact answers `candidates`
  for the caller to pick an id from. Each source's rules are in
  `docs/yahoo.md` and `docs/bvb.md` ("Resolution") and
  `docs/fred.md`; with the Bucharest feed off, a `BVB:` key Yahoo
  lacks answers `no_data`.
- **What the server lacks is fetched inside the call**: an instrument
  with no bars gets ten years of history, its signals and a fresh
  quote in one write (`fetchInstrument()`); one no longer tracked is
  caught up first (`catchUp()`, `refetchSeries()`).
- **The whole call has one 15-second deadline** (`CALL_MS`), under
  1ctx's untouched 20-second tool timeout. Each input resolves and
  fetches on its own, so a slow one holds no other; one not done
  answers `timeout` with "retry this symbol".
- **Nothing starts or lands after the deadline**: source clients are
  wrapped with `within(live)` (`docs/sources.md`, "Deadlines"), and
  every fetch checks `live()` after any lock and inside its write, so
  a late fetch stores nothing. The tracking write is skipped too.
- **Reads never wait out a back-off** (`failFast()`): while a source's
  queue is paused, a read answers at once, `rate_limited` after a 429,
  else `source_error` naming the phrase that paused it, never as if
  its own answer failed; jobs wait.
- **Concurrent calls share one fetch** (`m.inflight`, `shared()`): a
  caller that joins extends the deadline the fetch's write is held
  to, and a second input naming the same instrument reuses the call's
  fetch. No count caps fetches: the source queue paces them.
- **A read surface that resolves symbols goes through `readTargets()`**,
  so it marks what it answered as read (`docs/storage.md`, "Tracking
  by use") and keeps the deadline.

## No SQL or query tool

- **The tools are fixed; screen is the only open-ended read.** A fixed
  field is checked once in code, an agent's formula is not, and every
  answer must stay inside the page and cost limits. A new need is a
  new field or argument.

## One read, two surfaces

- **Each tool is a read and its paging.** `quoteRows()`,
  `readHistory()`, `searchAll()`, `readMovers()`, `readScreen()`,
  `readEventsOf()`, `createRule()`, `pauseRule()` and
  `deleteRuleById()` answer the whole result; the tool pages it and
  the API (`docs/api.md`) answers it at once. A change to what a tool
  reads goes in the read, so both surfaces stay the same.
- **The MCP answers are pinned**: `test/mcp.test.ts` compares every
  tool's pages over the recordings with
  `test/fixtures/mcp/answers.json` byte for byte. A change meant to
  alter an answer records the file again in the same commit, and the
  review reads its diff.

## Tool descriptions

- **A description is for an agent choosing a tool**: what it answers,
  every argument's form and limit, the fields and units an agent
  filters on, and how to continue with `next`. No history, marketing
  or repetition of the schema's types.
- **At most 1,024 characters**: 1ctx cuts a description there, and
  `test/tools-mcp.test.ts` asserts it. Shorten wording before adding a
  field. screen names its field groups and points at its schema's enum
  (`FIELD_NAMES`).
- **A limit in a description is the constant interpolated**, never
  written as text.
