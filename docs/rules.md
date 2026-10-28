# Rules and alerts

Governs price rules, their evaluation and the alerts they fire:
`src/rules/format.ts`, `evaluate.ts`, `hooks.ts` and `store.ts`, the
rules tool in `src/operations/rules.ts` and the alerts feed in
`src/api/alerts.ts`, served as `docs/api.md` says. The answer
contract, resolution and the inline fetch are in `docs/tools.md`;
earnings events in `docs/research.md`; splits, the refetch and the
bars a session waits on in `docs/yahoo.md`; alert retention and
tracking in `docs/storage.md`.

A rule belongs to one instrument, reads a few with a fixed condition,
and writes one alert each time the condition turns true. Rules hold
market conditions only, never holdings or orders.

## The condition

- **A condition is a fixed JSON tree, never an expression language.**
  A comparison is `{left, op, right}` with `op` one of `<` `<=` `>`
  `>=`; `{all: [...]}` and `{any: [...]}` combine conditions.
- **Parse rules only through `format.ts`; never read the stored JSON
  elsewhere**, so a rule means the same thing to evaluation, tracking
  and the tools.
- **An operand is a field name, or `{field, symbol}`.** A bare name is
  the rule's own symbol; `{"field": "price", "symbol": "^VIX"}` reads
  another instrument. `left` is always an operand; `right` is an
  operand or a number.
- **Relative return takes a benchmark, in the object form only:**
  `{"field": "relativeReturn3m", "benchmark": "QQQ"}`. No other field
  takes one.
- **`afterEarnings` sits on the root only** and names a US share.
- **The fields and their units are `FIELDS` in `format.ts`.** A price
  level (`PRICE_LEVEL`) is in the listing's own unit and currency.
  Field names are camelCase; a snake_case name taken from screen is
  refused with a hint (`hint()`). The `RULES` description in
  `src/tools/index.ts` lists every field by hand, so a new field goes
  there too.

| Limit | Value | Constant |
|---|---|---|
| comparisons in a condition, and conditions in one list | 8 | `MAX_COMPARISONS` |
| nesting levels | 3 | `MAX_DEPTH` |
| instruments read, own, benchmarks and gate included | 4 | `MAX_INSTRUMENTS` |
| condition as sent | 4,096 bytes | `MAX_CONDITION_BYTES` |
| note | 500 characters, also checked by migration `0009-rules`, so raising it needs an appended migration | `MAX_NOTE` |
| a number on the right | finite, at most 1e15 in size | `MAX_LITERAL` |

Examples, each created with `symbol` set to the rule's own share:

```json
{"all": [{"left": "rsi14", "op": "<", "right": 30},
         {"left": "price", "op": ">", "right": "sma200"}]}
{"left": {"field": "price", "symbol": "^VIX"}, "op": ">", "right": 30}
{"afterEarnings": "NVDA", "left": "changePct", "op": "<", "right": -5}
```

## Validation

- **Shape is checked before anything is resolved or fetched**
  (`parseCondition()`, `parseRules()`), the named symbols counted
  against `MAX_INSTRUMENTS` too.
- **What depends on the instruments is checked after they resolve**
  (`checkBound()`): no quote field of a FRED series, which has no
  quote; relative return only between two listings with quotes; every
  comparison reads at least one live value, since a rule on closed
  values alone would never change between quotes; both sides in the
  same unit, a price level's including its currency; and no
  cross-instrument price comparison when either unit is `unknown` or
  `index_points`, since one index's points are no other's.
- **A stored condition names every instrument by id** and binds its
  gate to one fiscal year and quarter (`bindCondition()`).
  `readCondition()` parses stored rows strictly; a row that no longer
  parses is the server's fault.

## Evaluation

- **Rules evaluate inside the write that moved their inputs**, so the
  quote, its live signals, the runs staleness is read from and the rule
  are read in one transaction. Every write that stores quotes, bars or
  signals, or ends a run, calls `RuleHooks.evaluate()` in that write.
  A FRED series stored inside a tool call (`src/sources/fred/sync.ts`)
  evaluates nothing; its rules run on the next series pass. Gated
  rules also run in `hooks.reported()` when Finnhub sees an event's
  results.
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
  `no_event` (`nextEvent(…, true)`, `docs/research.md`).
- **Only actuals open the gate.** Until Finnhub's EPS or revenue
  actuals are seen (`reportedSeenAt`), the rule is false with "waiting
  for the earnings results", so it stays armed. After, a value traded
  at or before the moment the results were seen makes it unknown, since
  that price says nothing of them; so does a live quote with no trade
  time (an index page's), which may be older, and a live signal row
  built from one, since it is dated by the quote's fetch. A deleted
  event makes it unknown. An unknown input wins over the gate: the
  rule is unknown, never waiting (`evaluateWith()`).
- **The gate stays bound to its quarter.** It is never moved to the
  next event; a later quarter is a new rule.
- **Waited events are kept.** `hooks.waited()` names every gated
  event so retention keeps it; its share is tracked, so the hourly
  whole-market calendar (`docs/research.md`) sees its actuals and
  `hooks.reported()` re-evaluates the gated rules.

## Splits and rescales

- **A split pauses the rules whose price levels it invalidates**
  (`rescaled()`, `splitSensitive()`): a comparison of the instrument's
  price level with a number, or with another listing's price level.
  Against its own average, high or other price level the comparison
  still holds and keeps running; non-price fields are never paused.
- **The pause comes before any evaluation on the new scale**: inside
  the write that applies a new split or rescales past prices, before
  it evaluates, and in a write of its own when a refetch window first
  shows one, before the whole history is asked (`refetchAnswer()` in
  `src/sources/yahoo/sync.ts` and `src/sources/bvb/sync.ts`;
  `docs/sources.md`, "Splits and rescales").
- **Until the new session's bars are in, split-sensitive comparisons
  are unknown** (`BARS_PENDING`), since the opening quote may already
  be on the new scale.
- **A split pause is final.** `paused` becomes `split` even on a rule
  paused by hand; resuming it answers `split_paused`. The levels are
  from before the split: delete the rule and create it with new ones.

## Dependencies

- **Every instrument a rule reads stays tracked while the rule exists**,
  paused or not: its own, other symbols, benchmarks and the gate's share
  (`ruleInstruments()`), so jobs keep syncing them without reads.

## The rules tool

- **Actions are `create`, `list`, `pause` and `delete`**, each taking
  only its own arguments (`ARGS`).
- **create leaves no rule on any failure.** Every symbol resolves and
  is stored inside the call (`readTargets()`, and `researchTargets()`
  for the gate, under one deadline); any error answers without a write.
  The rule is inserted and first evaluated in one write, and the answer
  holds the rule, its evaluation and any alert that fired at once. An
  answer too long keeps the result and the first 8 reasons.
- **list pages rules by id; pause sets or clears a manual pause;
  delete removes the rule and keeps its alerts.** Alerts have no
  foreign key, so a fired alert outlives its rule.
- **The rules routes call the same `createRule()`, `pauseRule()` and
  `deleteRuleById()`** (`docs/api.md`), so a rule made either way is
  the same.
