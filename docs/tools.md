# Tools

Governs the Model Context Protocol (MCP) tools: `src/mcp.ts`,
`src/instructions.ts`, `src/tools/index.ts`, `answer.ts`, `args.ts`,
`targets.ts`, `quote.ts`, `extended.ts`, `history.ts`, `search.ts`,
`movers.ts`, `screen.ts` and `sets.ts` under `src/tools/`. The HTTP
API that calls the same reads is in `docs/api.md`; the research and
events tools in `docs/research.md`; the rules tool in `docs/rules.md`;
signal rows in `docs/signals.md`; stale reasons and
the tracking table in `docs/storage.md`; the source queue in
`docs/yahoo.md`; the server, bearer and flags in `docs/config.md`.

## The MCP endpoint

- **The handler is stateless: a new `McpServer` per request**
  (`mcpHandler()` in `src/mcp.ts`), so no tool may keep per-session
  state. The tools are built once and registered on each instance by
  `registerTools()`; a new tool is added to `tools()` in
  `src/tools/index.ts`.
- **SDK errors are logged with type and code only**
  (`sdkErrorFields()`), since an SDK message can quote the request.

## Server instructions

- **One text sent on initialize** (`INSTRUCTIONS` in
  `src/instructions.ts`) says which tool answers what and what holds
  across tools: missing values, symbols, live prices, freshness, units,
  paging, and what the server does not hold. A description is cut at
  1,024 characters and a client may list tools by one line, so guidance
  across tools lives here; never repeat a description's argument list.
- **At most `INSTRUCTIONS_BYTES` (4 KB)**: clients cut long
  instructions from the end. A new line pushes an old one out, or the
  cap is raised as a choice in review. Every line changes what an agent
  does; nothing that dates (symbol lists, dates, prices).
- **Routing first, what the server does not hold last**, so a cut drops
  the least. No portfolio, holding, market, country or default symbol:
  the text goes to every user.
- **`test/instructions.test.ts` holds it to that**: sent on initialize,
  under the cap, the groups in order, every registered tool named, every
  backticked name a tool, an argument of a registered input schema, or
  one of the answer fields the test lists, and a short deny list.
  Whether those fields are still answered, and which tool an argument
  belongs to, is left to review.

## The answer contract

- **Every answer is one JSON text part.** `textResult()` and
  `errorResult()` in `answer.ts` build the only result shapes. MCP
  clients render a second part or a structured result differently, and
  1ctx (an agent workspace, this server's first MCP client) reads the
  first text part only.
- **A page fits 32 KiB twice: its text, and the result serialized
  plus 512 bytes for the JSON-RPC envelope and stream frame**
  (`PAGE_BYTES`, `ENVELOPE_BYTES`, `fits()`). Codex has the smallest
  byte limit of the clients 1ctx supports, and every client is used
  with its untouched defaults. Measure bytes, never characters: quoting
  inside the result's JSON grows escapes.
- **Pages hold whole items.** `fitPage()` adds items until the next
  would not fit, with the list as the last field of the object, and
  throws `PageOverflow` when one item cannot fit alone. Never cut text
  inside an item; shorten what an item holds instead.
- **A cursor is bound to the arguments it continues.** `cursor()`
  writes `<position>~<digest>`, the digest being the first 10 hex of
  SHA-256 over the arguments without `next`; `readCursor()` refuses one
  passed with other arguments, answered as `bad_arguments`. quote binds
  its `benchmark` with the symbols only when one is given, so a cursor
  made without one is the one quote always made. The
  position is the next offset (quote, search, movers, screen), the next
  bar's date (history) or the next rule id (rules list).
- **movers and screen page a fresh view.** Each call reads again and
  pages the sorted set from the cursor's offset, with `counts` covering
  every page; the set may shift between pages, which the descriptions
  say. An offset past a set that shrank is refused (`startOf()`,
  `setPage()`).
- **An error is a result with `isError`, in the same one-part form.**
  One too long keeps only `error` and a message cut to 1,024
  characters. An `ArgError` answers `bad_arguments` with its message;
  any other throw is logged and answered `internal` with the fixed
  message "internal error", since a thrown message can quote a source
  (`call()` in `index.ts`).
- **A symbol's failure is an item, not the call's.** quote, movers and
  screen answer per-symbol errors as items (`ERRORS` in `targets.ts`:
  `candidates`, `not_found`, `timeout`, `rate_limited`, `source_error`,
  `no_data`, `refused`), each with a fixed message from `itemError()`.
  history fails as a whole when its symbol fails; a failed benchmark is
  an error inside `relative`, and in screen fails the call.
- **Numbers are rounded on the way out.** `round()` keeps 6 significant
  digits for signals and changes; bar prices go through `price()`, 8
  digits (`history.ts`, `movers.ts`), which removes Yahoo's
  single-precision noise and keeps a crypto price's cents. Quote prices
  go out as Yahoo sent them. Times are UTC to the second (`iso()`).

## Arguments

- **Each tool checks its own arguments.** The MCP schemas are built
  with a permissive validator (`permissive` in `index.ts`), so an error
  names the argument and why in the tool's words. Every schema sets
  `additionalProperties: false` and `fields()` refuses an unknown
  argument rather than ignoring it.
- **Arguments are checked before anything is resolved or fetched.**
  A symbol is 1 to 100 characters (`MAX_SYMBOL`), a list 1 to 100
  symbols (`MAX_SYMBOLS`), a date `YYYY-MM-DD`. Text quoted back in an
  error is cut at 64 characters (`quoted()`).
- **Only rules carries write annotations.** Every other tool is
  `readOnlyHint: true`, `openWorldHint: true`; a read that fetches
  inline still only adds market data.

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

- **quote's `returns` answer "how did it do" without `history`.**
  `1w`, `1m`, `3m` and `ytd` run from the last final close on or
  before each start (7 days, 1 and 3 calendar months back by
  `monthsBack()`, the previous year's 31 December) to the end, which is
  the live price only when its session date follows the last final
  bar, else the last final close; `to` and `live` say which, so a
  closed day is told from an intraday reading (`trailingReturns()`,
  `returnsOf()`). Percent in the listing's own currency, points for a
  `percent` unit; a period is null when the bars do not reach its
  start.
- **quote's `benchmark` is one symbol for the call**, resolved and
  fetched as history's, adding `relative_return_1m` and `_3m` per item
  (`relativeOf()`) and the benchmark's id, `fetched_at` and own `stale`
  on the page as `benchmark`, its reasons prefixed `benchmark:` in the
  page's `stale` as history gives them; a benchmark that fails is that
  object's error and the relative fields are null.
- **quote's `session` is the last regular session the source
  reported**: `state` `open` or `closed` by `isQuoted()`, `start` and
  `end` in UTC. At an opening it reads `closed` until a check stores
  the day's session. Crypto is always `open` with null bounds; a FRED
  series answers null. No pre-market, after-hours or holiday state:
  only the regular session is stored (`docs/calendars.md`). Not named
  `market`, which an id's prefix already is.
- **quote's `extended` is asked, never default** (`extended.ts`), so
  a large quote at night makes no extra calls. A reader of a share
  that reports after the close wants the first price after the
  release, and before the open the pre-market one. It holds `session`
  (`pre` or `post`), `price`, `change` and `change_percent` from the
  regular close, and the bar's `time`: the latest priced bar in a pre
  or post window since the last regular close, kept until the next
  regular open. Null with an `extended:` reason in `stale` (no extended
  trading, not reported by its source, no priced bar since the close,
  regular session open, fetch failed or late; `docs/storage.md`),
  never meaning the price held. One chart per listing
  within the call's deadline (`docs/yahoo.md`), kept in memory for its
  quote period (`m.extended`), so the thin market is never fresher
  than the regular one. Never stored: signals, bars, movers, screen,
  history and rules read the regular session only; the API's quotes
  route reads it only with `extended=true`.
- **These are the quote tool's only.** `quoteRows()` computes them
  when no projection is given, and `extended` whenever it is asked;
  `quoteItem()`, which screen, movers and the API's quotes route
  share, never reads them. Bars are read from the
  earliest start a call needs (`readCloses()`), and the benchmark's
  closes once per call, never every stored bar per item.
- **history's latest session bar is its live quote's** (`withLive()`
  in `history.ts`): the quote's price as the close, its day range
  widening the stored one, beside the live row's signals, even when the
  source has no bar for the day yet. A stored bar of that session is
  the last bar pass's, taken near the open, so its close is hours old;
  the Bucharest feed often has none then. It is the bar the live row
  steps from (`docs/signals.md`), so the two never disagree.
- **A bar is final once its source shows a later session**
  (`docs/calendars.md`), so a day's bar after its close is still not
  final. history's `session` is quote's, the last regular session with
  `state` `open` or `closed`, so a reader tells an intraday bar from an
  unsettled close.
- **history defaults its range from the last bar.** `to` is the latest
  bar, `from` 3 months before it for `1d` and 24 months for `1wk`
  (`DEFAULT_MONTHS`). `basis` states split-adjusted prices with
  dividends and FX excluded, or FRED's revisions (`BASIS`,
  `FRED_BASIS`).
- **A Bucharest candidate's type is the chart feed's** (`types`,
  `docs/bvb.md`), since the site's search gives none: the type its
  instrument would take where the feed serves it (`EQUITY`, `ETF`,
  `BOND`, `INDEX`), else the feed's own (`Structured`). One more feed
  call per search with a tradable listing, within what is left of the
  search's own deadline, so the exchange's side answers within one
  call's time; failed or late, the type is null. Its `isin` is the site's, kept on a stored candidate too.
- **search fetches no prices and tracks nothing.** FRED is asked only
  for `FRED:<series id>`, with a note when the series is not daily; a
  stored series also matches by its symbol or name.
  A source that failed or timed out is in `errors`, beside what the
  other side found.
- **movers needs a move, an average or both.** `direction` needs
  `min_move_pct`; `average` and `relation` go together. `crossed_up`
  and `crossed_down` compare the last final close with the average
  then and the live price with the live average now; with no live row
  the symbol is unavailable.
- **screen filters and sorts on a fixed list of fields** (`FIELDS` in
  `screen.ts`), at most 8 filters (`MAX_FILTERS`), all of which must
  hold: `{field, min, max}` inclusive, or `{field, eq}` with -1, 0 or 1
  for the state fields. A call gives filters, a sort or both; `order`
  needs `sort`; a range filter needs `min` or `max`, with `min` not
  above `max`; a state field takes `eq` only. A `benchmark` is
  accepted only with a `relative_return_*` field and required by one.
  `return_1w`, `_1m`, `_3m` and `_ytd` follow quote's `returns`.
- **screen's `fields` shows up to `MAX_FIELDS` (8) more fields on every
  row**, beside the filter and sort fields, so one call answers the
  values a filter does not read. They never filter: one missing is
  `null` on a match, never a reason for `unavailable`, and they never
  make a mix of units refused.
- **A match is never made from a missing, null or stale input.** In
  movers and screen such a symbol is `unavailable` with what it lacked
  (`missing`, `stale`, `reason`), listed after the matches by id, then
  the errors (`sets.ts`). Only a match can be wrong in silence.
- **Price-level screen fields refuse a mix of units.** When a used
  field is in the listing's own unit and currency and the symbols span
  more than one, screen answers `mixed_units` with the groups, pointing
  at the percent fields such as `distance_sma50`.

## Values, units and staleness

- **A signal row is `live` or `final`.** The latest row is the live one
  when it is current, else the last final (`readLatest()` in
  `quote.ts`). Averages are on closed days plus today's price; live
  prices drive every answer, so never add a closed-only variant or a
  warning about intraday prices.
- **A FRED series is an `observation`, not a `market_quote`.** Its
  `price` is null and `observation` holds the last value and date; it
  has final rows only, never moves in movers, and has no price to
  measure a distance from in screen. A page holding FRED values carries
  FRED's `attribution` once.
- **Every quote item carries its unit and currency.** `unit` is one of
  `UNITS` in `src/instruments.ts`; `unknown` is answered rather than
  guessed, since Yahoo's future type covers prices per barrel and per
  bond. A
  FRED `percent` series' change is in points, so its `change_percent`
  is null (`quote.ts`). Relative return is in percentage points and
  names both currencies; between two level series it is in `points`
  (`src/signals/relative.ts`, `screen.ts`).
- **Staleness travels with the value.** `stale` holds fixed reasons
  (`STALE` in `src/stale.ts`), read from the instrument's own source
  and market's runs; a benchmark's reasons are prefixed `benchmark:`.
  An empty list means current. Add a reason to `STALE`, never free text.

## Resolution and the inline fetch

- **A symbol resolves to one stored instrument, never by a guess**
  (`step()` in `targets.ts`, `resolve()` in `src/yahoo/resolve.ts`).
  A stored `market:symbol` key is exact, and one not stored is
  searched and taken only on an exact key match; `FRED:<id>` is
  FRED's; a Yahoo symbol with a suffix or `^`/`=` is checked with a
  short chart; a bare symbol takes the listing whose Yahoo symbol
  equals it; anything else answers `candidates` for the caller to pick
  an id from. With the Bucharest feed on, `BVB:<symbol>` is the feed's
  and a bare symbol or name also goes through the exchange's search
  under the same rules (`resolveBoth()`, `docs/bvb.md`); with it off,
  a Bucharest index, bond or other `BVB:` key Yahoo lacks answers
  `no_data`.
- **What the server lacks is fetched inside the call.** An instrument
  with no bars gets ten years of history, its signals and a fresh quote
  in one write (`fetchInstrument()`); one stored but no longer tracked
  is caught up first (`catchUp()`, `refetchSeries()`).
- **The whole call has one 15-second deadline** (`CALL_MS`), under
  1ctx's untouched 20-second tool timeout. Each input resolves and
  fetches on its own, so a slow one holds no other; one not done
  answers `timeout` with "retry this symbol".
- **Nothing starts or lands after the deadline.** Source clients are
  wrapped with `within(live)`, so a call still waiting for a queue slot
  is rejected (`DeadlinePassed`), and every fetch checks `live()`
  before each source call, after any lock and inside its write. A late
  fetch stores nothing new. The tracking write is skipped past the
  deadline too.
- **Reads never wait out a back-off.** The tools use `failFast()`
  clients: while a source's queue is paused after a 429 or failure, a
  read answers at once, `rate_limited` after a 429, else
  `source_error` saying the source is backing off after the phrase
  that paused it, never as if its own answer had failed; jobs wait.
- **Concurrent calls share one fetch.** `m.inflight` holds one promise
  per key (`resolve:<TEXT>`, `fetch:<id>`); a caller that joins extends
  the deadline the fetch's write is held to (`shared()`). Within one
  call, a second input naming the same instrument reuses that call's
  fetch. No count caps fetches: the source queue paces them.

## Tracking by use

- **There is no ticker list.** An instrument is tracked while a read
  named it within `--track-days` (30 by default) or a rule reads it
  (`trackedIds()`), and only tracked instruments are synced.
- **Every instrument a read answers counts as read.** `readTargets()`
  marks them in one write after resolving (`markRead()`); search and
  jobs never count. A new read surface that resolves symbols goes
  through `readTargets()` so it tracks and keeps the deadline.

## No SQL or query tool

- **The tools are fixed; screen is the only open-ended read.** No SQL,
  expression or query tool is ever added: a fixed field is checked once
  in code, an agent's formula is not, and every answer must stay inside
  the page and cost limits. A new need is a new field or tool argument.

## One read, two surfaces

- **Each tool is a read and its paging.** `quoteRows()`,
  `readHistory()`, `searchAll()`, `readMovers()`, `readScreen()`,
  `readEventsOf()` and `createRule()`, `pauseRule()`,
  `deleteRuleById()` answer the whole result; the tool pages it with
  `fitPage()` and the API (`docs/api.md`) answers it at once. A change
  to what a tool reads goes in the read, so both surfaces stay the
  same.
- **The MCP answers are pinned.** `test/fixtures/mcp/answers.json`
  holds every tool's pages over the recordings (`mcpAnswers()` in
  `test/helpers/answers.ts`); `test/mcp.test.ts` compares them byte
  for byte. A change meant to alter an answer records the file again
  in the same commit, and the review reads its diff.

## Tool descriptions

- **A description is for an agent choosing a tool.** It names what the
  tool answers, every argument's form and limit, the fields and units
  an agent filters on, and how to continue with `next`. No history, no
  marketing, no repetition of the schema's types.
- **Stay at 1,024 characters or fewer**: 1ctx cuts a description
  there, and `test/tools-mcp.test.ts` asserts it. quote (1,023), rules
  (1,019) and research (1,019) are near the limit; shorten wording
  before adding a field. screen names its field groups and points at
  its schema's enum (`FIELD_NAMES`), which lists every field.
- **A limit in a description is the constant's value.** quote
  interpolates `MAX_SYMBOLS` and `callMs`, screen `MAX_FILTERS` and
  `MAX_FIELDS`, events `MAX_EVENT_SYMBOLS` and `CALENDAR_AHEAD_DAYS`,
  research `SINCE_DAYS`, rules `MAX_COMPARISONS`, `MAX_DEPTH` and
  `MAX_INSTRUMENTS`, movers and screen `MAX_SYMBOLS`,
  history `DEFAULT_MONTHS`. An argument's limit is interpolated, never
  written as text.
