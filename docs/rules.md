# Rules and alerts

Governs price rules, their evaluation and the alerts they fire:
`src/rules/format.ts`, `evaluate.ts`, `hooks.ts` and `store.ts`, the
rules tool in `src/tools/rules.ts` and `GET /alerts` in
`src/tools/alerts.ts`. The answer contract, resolution and the inline
fetch are in `docs/tools.md`; earnings events in `docs/research.md`;
splits, the refetch and the bars a session waits on in
`docs/yahoo.md`; alert retention and tracking in `docs/storage.md`.

A rule belongs to one instrument and reads up to four
(`MAX_INSTRUMENTS`, `checkBound()`) with a fixed condition, and
writes one alert each time the condition turns true. Rules hold market
conditions only, never holdings or orders.

## The condition

- **A condition is a fixed JSON tree, never an expression language.**
  A comparison is `{left, op, right}` with `op` one of `<` `<=` `>`
  `>=`; `{all: [...]}` and `{any: [...]}` combine conditions.
- **Parse rules only through `format.ts`; never read the stored JSON
  elsewhere.** Evaluation, tracking and the tools all read a rule
  through it, so a rule means the same thing everywhere.
- **The `RULES` description in `src/tools/index.ts` lists every field
  by hand**, so a new field in `format.ts` goes there too.
- **An operand is a field name, or `{field, symbol}`.** A bare name is
  the rule's own symbol; `{"field": "price", "symbol": "^VIX"}` reads
  another instrument. `left` is always an operand; `right` is an
  operand or a number.
- **Relative return takes a benchmark, in the object form only:**
  `{"field": "relativeReturn3m", "benchmark": "QQQ"}`. No other field
  takes one.
- **`afterEarnings` sits on the root only** and names a US share.

| Limit | Value | Constant |
|---|---|---|
| comparisons in a condition, and conditions in one list | 8 | `MAX_COMPARISONS` |
| nesting levels | 3 | `MAX_DEPTH` |
| instruments read, own, benchmarks and gate included | 4 | `MAX_INSTRUMENTS` |
| condition as sent | 4,096 bytes | `MAX_CONDITION_BYTES` |
| note | 500 characters, also checked by migration `0009-rules`, so raising it needs an appended migration | `MAX_NOTE` |
| a number on the right | finite, at most 1e15 in size | `MAX_LITERAL` |

| Fields | Unit |
|---|---|
| `price`, `dayHigh`, `dayLow`, `previousClose` (quote) | price level |
| `changePct` (quote) | percent |
| `sma50`, `sma200`, `ema20`, `macd`, `macdSignal`, `macdHistogram`, `atr14`, `bollingerLower`, `high52w`, `low52w`, `weeklySma50`, `weeklySma200` | price level |
| `cross`, `crossEdge`, `macdTurn`, `weeklyCross`, `weeklyCrossEdge` | state (-1, 0, 1) |
| `rsi14` | 0 to 100 |
| `moveAtr` | ATRs |
| `volatility20` | percent per day |
| `drawdown`, `fromLow` | percent |
| `daysSinceHigh` | trading days |
| `volumeRatio` | ratio |
| `relativeReturn1m`, `relativeReturn3m` | percentage points |

A price level is in the listing's own unit and currency
(`PRICE_LEVEL`). Field names are camelCase; a snake_case name taken
from screen is refused with a hint (`hint()`).

Examples, each created with `symbol` set to the rule's own share:

```json
{"left": "price", "op": "<", "right": 200}
{"all": [{"left": "rsi14", "op": "<", "right": 30},
         {"left": "price", "op": ">", "right": "sma200"}]}
{"left": "moveAtr", "op": "<", "right": -2}
{"left": "drawdown", "op": "<", "right": -20}
{"left": {"field": "price", "symbol": "^VIX"}, "op": ">", "right": 30}
{"afterEarnings": "NVDA", "left": "changePct", "op": "<", "right": -5}
```

## Validation

- **Shape is checked before anything is resolved or fetched**
  (`parseCondition()`, `parseRules()`), and the named symbols are
  counted against `MAX_INSTRUMENTS` there too.
- **What depends on the instruments is checked after they resolve**
  (`checkBound()`): no quote field of a FRED series, which has no
  quote; relative return only between two listings with quotes; every
  comparison reads at least one live value, since a rule on closed
  values alone would never change between quotes; both sides of a
  comparison in the same unit, a price level's unit including its
  currency; and no cross-instrument price comparison when either unit
  is `unknown`.
- **A stored condition names every instrument by id** and binds its
  gate to one fiscal year and quarter (`bindCondition()`,
  `writeCondition()`). `readCondition()` parses stored rows strictly;
  a row that no longer parses is the server's fault.

## Evaluation

- **Rules evaluate inside the write that moved their inputs**, so the
  quote, its live signals, the runs staleness is read from and the rule
  are read in one transaction. A write that stores quotes, bars or
  signals, or ends a run, calls `RuleHooks.evaluate()` in the same
  write: `storeQuotes()` and `store()` in `src/yahoo/sync.ts`, the
  quote and bar passes in `src/yahoo/jobs.ts` and `src/bvb/jobs.ts`,
  `storeBvbQuotes()`, `storeWindow()` and `storeWhole()` in
  `src/bvb/sync.ts`, the FRED series pass in `src/fred/jobs.ts`. A FRED series stored inside a tool call
  (`src/fred/sync.ts`) evaluates nothing; its rules run on the next
  series pass. Gated rules also run in `hooks.reported()` when Finnhub
  sees an event's results.
- **A rule is due when it reads any instrument that moved**; paused
  rules are skipped.
- **The result is true, false or unknown.** Any missing, null, stale or
  recomputing input makes it unknown, with every reason listed.
  Quotes are judged with `quoteStale()` against `--quote-every`;
  signals use the live row of a listing with quotes, the final row of a
  FRED series.
- **Armed rules fire once.** True on an armed rule inserts one alert
  with a snapshot (the rule, the gate, every compared value with its
  trade time) and disarms it; false rearms it; unknown changes neither
  (`applyRule()`). There is no damping, cooldown or hysteresis: a value
  that crosses back and forth fires on every return to true.
- **A failing rule never fails the write it rides on.** `ruleEngine()`
  logs it and the source write and the other rules go on.

## The earnings gate

- **`afterEarnings` waits for the next results of a US share.**
  Creating one needs Finnhub on and the share eligible (US, `EQUITY`),
  else `no_event_source`, and an upcoming unreported event, else
  `no_event` (`nextEvent(…, true)`, which also takes one up to 7 days
  past its date still awaiting results).
- **Only actuals open the gate.** Until Finnhub's EPS or revenue
  actuals are seen (`reportedSeenAt`), the rule is false with "waiting
  for the earnings results", so it stays armed. After, a value traded
  at or before the moment the results were seen makes it unknown, since
  that price says nothing of them. A deleted event makes it unknown.
  An unknown input wins over the gate: the rule is unknown, never
  waiting (`evaluateWith()`).
- **The gate stays bound to its quarter.** It is never moved to the
  next event; a later quarter is a new rule.
- **Waited events drive Finnhub's calendar.** `hooks.waited()` names
  every gated event so its calendar is asked hourly around its date and
  retention keeps it; `hooks.reported()` re-evaluates the gated rules
  when one reports.

## Splits and rescales

- **A split pauses the rules whose price levels it invalidates**
  (`rescaled()`, `splitSensitive()`): a comparison of the instrument's
  price level with a number, or with another listing's price level.
  Against its own average, high or other price level the comparison
  still holds and keeps running; non-price fields (RSI, percent, state)
  are never paused.
- **The pause comes before any evaluation on the new scale.** It runs
  inside the write that applies a new split or rescales past prices,
  before that write evaluates, and in a write of its own when a refetch
  window first shows one, before the whole history is asked
  (`refetchAnswer()` in `src/yahoo/sync.ts`). The Bucharest feed
  pauses the same way when its 30-day window shows past prices moved
  by one ratio (`refetchAnswer()` in `src/bvb/sync.ts`).
- **Until the new session's bars are in, split-sensitive comparisons
  are unknown** ("bars of the new session not refetched yet, so a
  split may be unseen", `BARS_PENDING`), since the opening quote may
  already be on the new scale.
- **A split pause is final.** `paused` becomes `split` even on a rule
  paused by hand; resuming it answers `split_paused`. The levels are
  from before the split: delete the rule and create it with new ones.

## Dependencies

- **Every instrument a rule reads stays tracked while the rule exists**,
  paused or not: its own, other symbols, benchmarks and the gate's share
  (`ruleInstruments()`), so jobs keep syncing them without reads.

## The rules tool

- **Actions are `create`, `list`, `pause` and `delete`**, each taking
  only its own arguments (`ARGS`). It is the only tool with write
  annotations.
- **create leaves no rule on any failure.** Every symbol resolves and
  is stored inside the call (`readTargets()`, and `researchTargets()`
  for the gate, under one deadline); any error answers without a write.
  The rule is inserted and first evaluated in one write, and the answer
  holds the rule, its evaluation and any alert that fired at once. An
  answer too long keeps the result and the first 8 reasons.
- **list pages rules by id; pause sets or clears a manual pause;
  delete removes the rule and keeps its alerts.** Alerts have no
  foreign key, so a fired alert outlives its rule.

## GET /alerts

The feed a client polling `GET /alerts` reads on a schedule, acting
only on a new answer; 1ctx (an agent workspace whose scheduled tasks
poll it) is one.

- **The alert id is the cursor, sent as the ETag.** `ETag:
  W/"alerts-<id>"` names the last alert in the page; the client sends it
  back in `If-None-Match`, which also takes `"alerts-<id>"` without
  `W/` (`TAG`). Ids autoincrement and are never reused
  (migration `0009-rules`), so alerts fired in the same second are
  never lost or repeated as a time cursor would be.
- **Statuses:**

| Status | When |
|---|---|
| 200 | alerts after the cursor, or from the start after a reset; or a retention gap alone, with `ETag` `lastAlertId()` |
| 204 | no cursor (or a reset one) and no alerts |
| 304 | a cursor and nothing after it; the ETag is repeated |
| 400 | any query argument, or an `If-None-Match` not of this form |
| 401 | no or wrong bearer, checked before the route |
| 405 | any method but GET, with `Allow: GET` |
| 500 | `internal`, logged with no detail in the body |

- **A page stays strictly under 16 KiB** (`ALERT_PAGE_BYTES`), since
  1ctx's poll refuses a larger body. It holds whole alerts oldest
  first with `more`, so a backlog drains over several polls.
  One alert too large alone keeps only `id`, `rule_id`, `fired_at`
  and `truncated: true` (`alertPage()`), so the feed never stalls on
  it.
- **The same alerts answer the same bytes.** A client may hash the
  last answer; never add a time, counter or other changing field to a page.
- **Items are rebuilt from each alert's stored `snapshot`**
  (`alertItem()` in `src/tools/rules.ts`). A change to `Snapshot` or
  `alertItem()` must still read 90 days of old snapshots, and it
  changes the bytes of pages already answered, which starts the
  check's run again.
- **A hole after the cursor is a retention gap.** Alerts are kept 90
  days (`ALERTS_KEPT_DAYS`, pruned at start and daily); a first id
  above cursor + 1, or none left while `lastAlertId()` is past the
  cursor, answers `retention_gap: true`. Only retention deletes alerts,
  which this relies on.
- **A cursor above any id this database issued starts over** with
  `cursor_reset: true`, as after a restore.
- **Delivery is at least once.** The cursor moves only when the client
  stores the new ETag, so a poll that fails after reading gets the
  same page again; a consumer deduplicates by alert id.
- **Answers are `cache-control: private, no-store`.**
