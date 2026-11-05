# Rules and alerts

Governs price rules, their evaluation and the alerts they fire:
`src/rules/format.ts`, `evaluate.ts`, `hooks.ts` and `store.ts`, the
rules tool in `src/operations/rules.ts` and the alerts feed in
`src/api/alerts.ts`, served as `docs/api.md` says. The answer
contract, resolution and the inline fetch are in `docs/tools.md`;
earnings events in `docs/research.md`; splits, rescales and the
refetch in `docs/sources.md` and each source's doc; alert retention
and tracking in `docs/storage.md`.

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
  `index_points`, since one index's points are no other's (^VIX's
  volatility, ^TNX's yield).
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
- **Armed rules fire at most once a trading session.** True on an
  armed rule inserts one alert with a snapshot (the rule, the gate,
  every compared value with its trade time), disarms it and stores the
  session in `fired_session`; false rearms it; unknown changes neither
  (`applyRule()`). True on an armed rule in the session it fired in
  writes nothing and leaves it armed, so a price hovering at the level
  fires once that session, not on every return to true. A rule still
  true at the next session with no false between does not fire again.
- **The session is the rule's own symbol's** (`rule.instrument`):
  `barDate()` of its quote's trade time in the exchange's zone, so a
  weekend or holiday keeps the last session and crypto's is the UTC day;
  an untimed quote takes its live row's date, or its last bar's when no
  session is stored or the next one has not opened, and a series with no
  quote its final row's. A session only moves forward: one dated before
  `fired_session` counts as fired (`>`), so it never goes back. Another
  symbol the rule reads (^VIX, a benchmark) never starts a new one. No
  date adds "no session date" to the reasons and makes the rule
  unknown, so it can never fire twice in one session.
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
  be on the new scale. The instrument's own failed bars run keeps them
  unknown too (`BARS_FAILED`), though the market's pass succeeded on
  other listings.
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
- **Access is the key's rules access** (`Who.rules`, `docs/admin.md`):
  `list` needs `read`, `create`, `pause` and `delete` need `write`;
  without it the tool answers `forbidden` before reading anything, in
  the portfolio tools' words ("this key has no rules access; the admin
  grants it", "this key reads rules only; its owner grants write"). A
  key with access `none` is not given the tool at all (`docs/tools.md`),
  and one that reads is given it whole: reads and writes stay one tool,
  as a rules reader is rare. The same access opens the rules routes and the alerts feed
  (`docs/api.md`); the admin key holds `write`, and so does a person's
  web UI login, its writes held to this server's own pages
  (`sameOrigin()`, `docs/web.md`). Rules and their alerts are each
  person's: a person's agents share them, and `GET /alerts` carries
  only the key's person's.
- **create leaves no rule on any failure.** Every symbol resolves and
  is stored inside the call (`readTargets()`, and `researchTargets()`
  for the gate, under one deadline); any error answers without a write.
  The rule is inserted and first evaluated in one write, which checks
  every operand is still stored (`not_found` if deleted meanwhile, since
  no job adds an instrument back), and the answer
  holds the rule, its evaluation and any alert that fired at once. An
  answer too long keeps the result and the first 8 reasons.
- **list pages rules by id; pause sets or clears a manual pause;
  delete removes the rule and keeps its alerts.** Alerts have no
  foreign key, so a fired alert outlives its rule.
- **Rules and alerts are one person's** (`rules.owner`, `alerts.owner`,
  migration `0036-owners`): the tool and the routes read and change only
  the caller's, another's id answering `not_found`, and an alert copies
  its rule's owner when it fires, so it stays theirs after the rule
  goes. The engine evaluates and pauses every person's rules
  (`allRules()`), since prices are shared.
- **The rules routes call the same `createRule()`, `pauseRule()` and
  `deleteRuleById()`** (`docs/api.md`), so a rule made either way is
  the same, by a key or by the web UI's Alerts page.

## The routes' reads

- **`GET /rules` and `GET /rules/{id}` answer each rule as the tool
  lists it plus `now`**, the engine's answer at the read
  (`evaluateRules()`, one reader for the whole list): it is stored
  nowhere, so it never fires an alert or changes `armed` or
  `last_result`, and agrees with what `applyRule()` would answer. Their
  `armed`, and the tool's, is whether the next true fires (`firesNext()`,
  one reader per answer): the stored flag and a session date later than
  `fired_session`; false with no session date. The
  tool's answers carry no `now`: an agent reads the evaluation in
  `create` and the alert in the feed.
- **They add `instruments`**, each listing a rule reads by id with its
  name, type, currency and unit (`ruleViews()`), so a page names and
  prices a rule without another call.
- **`GET /alerts/recent` reads back the caller's kept alerts, newest
  first**, `RECENT_ALERTS` a page, with `next` the `before` of the
  next older page and `instruments` as above (`readAlertsBefore()`,
  `alertViews()`). The feed (`GET /alerts`) stays the poll: oldest
  first behind its cursor.
- **`GET` and `PUT /alerts/seen` hold the web UI's mark of the newest
  alert shown** (`users.alerts_seen`, `readSeen()`, `markSeen()`) and
  how many of the person's alerts came after it. The mark moves forward
  only and never past the person's own newest alert, so an alert that
  fires later is never seen ahead of time. They are web UI routes: no
  agent key opens them.
