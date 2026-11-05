# Price alerts

Governs price alerts, their evaluation and what they trigger: the
condition text in `src/shared/when.ts`, the stored tree, evaluation and
storage in `src/rules/format.ts`, `evaluate.ts`, `hooks.ts` and
`store.ts`, the answers and writes in `src/operations/alerts.ts`, the
`alerts` and `alerts_edit` tools in `src/tools/alerts.ts` and the feed
in `src/api/alerts.ts`, served as `docs/api.md` says. The answer
contract, resolution and the inline fetch are in `docs/tools.md`;
earnings events in `docs/research.md`; splits, rescales and the
refetch in `docs/sources.md` and each source's doc; retention and
tracking in `docs/storage.md`.

An alert belongs to one symbol, reads a few with a fixed condition, and
triggers once each time the condition turns true, at most once a
trading session. Alerts hold market conditions only, never holdings or
orders. In code and tables an alert is still a rule (`rules`, `RuleRow`)
and a trigger an alert (`alerts`, `Fired`): only the words callers see
changed, so no migration rewrote a row.

## The condition: `when`

- **`when` is text, never an expression language**: comparisons joined
  by `and` and `or`, with parentheses. No arithmetic, no other
  functions. Agents write it as the user said it:
  `price < 180`, `rsi14 < 30 and price > sma200`, `price(^VIX) > 25`.
- **A comparison is two sides and one of `<` `<=` `>` `>=`.** A side is
  a number or a field. A number on the left is flipped (`180 > price`
  is `price < 180`); two numbers are refused.
- **`and` binds before `or`**, as in SQL: `a or b and c` is
  `a or (b and c)`. Parentheses group.
- **Field names are `quote`'s and `screen`'s** (`WHEN_FIELDS`): `price`,
  `previous_close`, `change_percent`, `day_high`, `day_low`, `sma50`,
  `sma200`, `ema20`, `cross`, `cross_edge`, `rsi14`, `macd`,
  `macd_signal`, `macd_histogram`, `macd_turn`, `atr14`, `move_atr`,
  `volatility20`, `bollinger_lower`, `high52w`, `low52w`, `drawdown`,
  `from_low`, `days_since_high`, `volume_ratio`, `weekly_sma50`,
  `weekly_sma200`, `weekly_cross`, `weekly_cross_edge`,
  `relative_return_1m`, `relative_return_3m`. One vocabulary across the
  tools, so the tool texts list none; the `when` argument's description
  does. A new field goes in `WHEN_FIELDS`, `FIELDS` and the page's
  `FIELD_WORDS`; tests hold them equal.
- **`field(symbol)` reads another symbol** (`price(^VIX)`,
  `sma50(XETRA:VVSM)`): a symbol is read as written up to `,` or `)`, so
  a dot (`VWCE.DE`), a colon or `=` need no quotes. No argument is the
  alert's own symbol.
- **`relative_return_1m(benchmark)` and `_3m`** are the own symbol's
  return against the benchmark; `relative_return_1m(symbol, benchmark)`
  another symbol's. No other field takes two.
- **`after_earnings` is an argument of create, not part of `when`**,
  and names a US share (below).

| Limit | Value | Constant |
|---|---|---|
| comparisons | 8 | `MAX_COMPARISONS` |
| nesting levels, a lone comparison being 1 | 3 | `MAX_DEPTH` |
| symbols read, own, benchmarks and gate included | 4 | `MAX_INSTRUMENTS` |
| `when` as sent, and as stored with full ids (`storedWhen()`), so every answer's `when` goes back as is | 1,000 characters | `MAX_WHEN` |
| a symbol | 100 characters | `MAX_SYMBOL` |
| note | 500 characters, also checked by migration `0009-rules`, so raising it needs an appended migration | `MAX_NOTE` |
| a number | finite, at most 1e15 in size | `MAX_LITERAL` |

## Refusals

- **Every parse refusal names what it found and its 1-based position**,
  so one retry fixes it: "unknown field rsi at 1; did you mean
  rsi14?", "unknown operator = at 7; use < <= > or >=", "( at 1 is not
  closed", "expected a field or a number at 14, found the end".
- **An unknown field offers the nearest one** (`nearestField()`): a
  stored camelCase key (`changePct` → `change_percent`), the name
  without underscores (`sma_50` → `sma50`), the shortest name it
  prefixes (`rsi` → `rsi14`), or one within a typo or two.
- **The text is checked before anything is resolved or fetched**
  (`parseWhen()`, `parseWhenCondition()`, `parseAlertsEdit()`), the
  named symbols counted against `MAX_INSTRUMENTS` too.
- **What depends on the symbols is checked after they resolve**
  (`checkBound()`), each refusal naming the comparison and its text
  ("comparison 2 (price > price(CXI:^VIX)): ..."): no quote field of a
  FRED series, which has no quote; relative return only between two
  listings with quotes; every comparison reads at least one live value,
  since an alert on closed values alone would never change between
  quotes; both sides in the same unit, a price level's including its
  currency; and no cross-symbol price comparison when either unit is
  `unknown` or `index_points`, since one index's points are no other's
  (^VIX's volatility, ^TNX's yield).
- **A symbol that does not resolve is named** in the refusal, with the
  resolver's own error (`not_found`, `candidates`).

## Stored as a tree, answered as text

- **The stored condition keeps its JSON tree and internal keys**
  (`{left, op, right}`, `{all}`, `{any}`, camelCase fields, every
  symbol an instrument id, the gate bound to one fiscal year and
  quarter; `bindCondition()`, `writeCondition()`). Only `format.ts`
  reads it (`readCondition()`, strict: a row that no longer parses is
  the server's fault).
- **Every answer renders one canonical `when` from the tree**
  (`whenText()`, `renderWhen()`): single spaces, every nested group in
  parentheses (`(a and b) or c`), numbers as JavaScript writes them,
  the alert's own symbol left out and any other as its stored id
  (`price(CXI:^VIX) > 25`), which resolves when sent back. Parsing the
  rendered text gives the same tree.

## Evaluation

- **Alerts evaluate inside the write that moved their inputs**, so the
  quote, its live signals, the runs staleness is read from and the
  alert are read in one transaction. Every write that stores quotes,
  bars or signals, or ends a run, calls `RuleHooks.evaluate()` in that
  write. A FRED series stored inside a tool call
  (`src/sources/fred/sync.ts`) evaluates nothing; its alerts run on the
  next series pass. Gated alerts also run in `hooks.reported()` when
  Finnhub sees an event's results.
- **An alert is due when it reads any symbol that moved**; paused ones
  are skipped.
- **The result is true, false or unknown.** Any missing, null, stale or
  recomputing input makes it unknown, with every reason listed, fields
  named as `when` names them. Quotes are judged with `quoteStale()`
  against `--quote-every`; signals use the live row of a listing with
  quotes, the final row of a FRED series.
- **An alert triggers at most once a trading session, and again only
  after false.** True on an armed alert inserts one trigger with a
  snapshot (the stored condition, the gate, every compared value with
  its trade time), disarms it and stores the session in
  `fired_session`; false rearms it; unknown changes neither
  (`applyRule()`). True in the session it triggered in writes nothing
  and leaves it armed, so a price hovering at the level triggers once
  that session. True at the next session with no false between does
  not trigger again.
- **The session is the alert's own symbol's**: `barDate()` of its
  quote's trade time in the exchange's zone, so a weekend or holiday
  keeps the last session and crypto's is the UTC day; an untimed quote
  takes its live row's date, or its last bar's when no session is
  stored or the next one has not opened, and a series with no quote its
  final row's. A session only moves forward: one dated before
  `fired_session` counts as triggered (`>`). Another symbol the alert
  reads (^VIX, a benchmark) never starts a new one. No date adds "no
  session date" to the reasons and makes it unknown, so it can never
  trigger twice in one session.
- **A failing alert never fails the write it rides on.** `ruleEngine()`
  logs it and the source write and the other alerts go on.

## State and how close

Every read evaluates each alert now on one reader (`evaluateRules()`),
stored nowhere: a read never triggers or changes anything.

- **`state` is one word** (`stateOf()` in `src/operations/alerts.ts`),
  first match wins:
  - `split_paused`: a split paused it; update it with new levels.
  - `paused`: paused by hand.
  - `unknown`: an input is missing or stale; `reasons` say why. It
    never triggers or rearms while unknown.
  - `waiting_for_earnings`: the gate waits for results; `reasons` say
    so.
  - `watching`: the next true triggers (`firesNext()`: armed and its
    session later than `fired_session`).
  - `triggered`: it triggered and waits for a false, in this session
    or an earlier one; then it triggers again, at most once a trading
    session.
- **`reasons` appear only with `unknown` and `waiting_for_earnings`.**
- **`now` holds each comparison in `when`'s order** (depth first, left
  to right): `field` as `when` names it, `symbol` only for another
  symbol, `benchmark` for a relative return, `value` (the left side),
  `level` (the number or the right side's value), `gap` (level minus
  value, signed, in the field's unit: the move left to the level),
  `gap_percent` between price levels only (gap over the value), and
  `holds`, null while a side is unknown. "How close?" and "why didn't it
  trigger?" are one read, never a `quote` and a sum.
- **The alert's `gap_percent` is how far from triggering**, unsigned:
  0 when the whole condition is true; a comparison's distance only
  between price levels (price, previous close, day high and low, the
  averages, the lower Bollinger band, the 52-week high and low), 0
  when it holds; an `and` takes its farthest and is null when any
  comparison has none; an `or` its nearest known. MACD and ATR share the
  price's unit but sit near zero, so they have none. The web UI shows
  this figure; it never works one out.
- **`last_triggered_at` is the newest kept trigger's time**, null
  when none is kept.

## Writes

- **create leaves no alert on any failure.** Every symbol resolves and
  is stored inside the call (`readTargets()`, and `researchTargets()`
  for the gate, under one deadline); any error answers without a write.
  The alert is inserted and first evaluated in one write, which checks
  every operand is still stored (`not_found` if deleted meanwhile,
  since no job adds an instrument back). True at once triggers in the
  answer: `{alert, triggered}`, `triggered` the trigger or null. An
  answer too long keeps the first 8 reasons.
- **update changes `when`, `note` or both, keeping the id and its
  history.** A new `when` is a new question: resolved and checked as on
  create, stored with the alert rearmed, `fired_session` cleared and a
  split pause lifted, and evaluated in the same write, so true
  triggers in the answer even in a session the old one triggered. A
  manually paused alert stays paused and is not evaluated. The earnings
  gate stays bound as it was. `note` null clears it; a note alone
  evaluates nothing. The symbol never changes: another symbol is another
  alert. Answers `{alert, triggered}`.
- **pause and resume set or clear the manual pause**, answering
  `{alert}`. A split-paused alert stays paused by pause; resume answers
  `split_paused`, since only a new `when` lifts it.
- **delete removes the alert and keeps its history**, answering
  `{deleted: id}`. Triggers have no foreign key, so they outlive it.

## Triggers and history

- **A trigger is `{id, alert_id, symbol, when, note, triggered_at,
  values}`**, plus `after_earnings` when gated (`triggerItem()`):
  `when` rendered from its snapshot, as the alert read then; `values`
  a flat map of each side read, keyed as `when` writes it
  (`{"price": 79.95, "price(CXI:^VIX)": 26.1}`). Snapshots stored before
  the text form (a JSON tree with each side's value) render the same
  way, since the snapshot itself never changed shape.
- **History is kept `ALERTS_KEPT_DAYS` (90) days** (`pruneAlerts()`,
  `docs/storage.md`), also after the alert is deleted, and read newest
  first (`readHistory()`): all, one alert's by id (a deleted one's too),
  one symbol's (by the snapshot's symbol), or from a UTC day (`since`).
- **The feed reads the same triggers oldest first behind its cursor**
  (`docs/api.md`).

## The earnings gate

- **`after_earnings` waits for the next results of a US share.**
  Creating one needs Finnhub on and the share eligible (US, `EQUITY`),
  else `no_event_source`, and an upcoming unreported event, else
  `no_event` (`nextEvent(…, true)`, `docs/research.md`).
- **Only actuals open the gate.** Until Finnhub's EPS or revenue
  actuals are seen (`reportedSeenAt`), the alert is false with "waiting
  for the earnings results" (`waiting_for_earnings`), so it stays armed.
  After, a value traded at or before the moment the results were seen
  makes it unknown, since that price says nothing of them; so does a
  live quote with no trade time (an index page's), which may be older,
  and a live signal row built from one, since it is dated by the
  quote's fetch. A deleted event makes it unknown. An unknown input wins
  over the gate (`evaluateWith()`).
- **The gate stays bound to its quarter**, also across updates. A later
  quarter is a new alert.
- **Waited events are kept.** `hooks.waited()` names every gated event
  so retention keeps it; its share is tracked, so the hourly
  whole-market calendar (`docs/research.md`) sees its actuals and
  `hooks.reported()` re-evaluates the gated alerts.

## Splits and rescales

- **A split pauses the alerts whose price levels it invalidates**
  (`rescaled()`, `splitSensitive()`): a comparison of the symbol's
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
  be on the new scale. The symbol's own failed bars run keeps them
  unknown too (`BARS_FAILED`), though the market's pass succeeded on
  other listings.
- **A split pause holds until a new `when`.** `paused` becomes `split`
  even on an alert paused by hand; resume answers `split_paused`. The
  levels are from before the split: update it with new ones.

## Dependencies

- **Every symbol an alert reads stays tracked while the alert exists**,
  paused or not: its own, other symbols, benchmarks and the gate's
  share (`ruleInstruments()`), so jobs keep syncing them without reads.

## The tools

- **`alerts` reads, `alerts_edit` writes**, as `profile` and
  `profile_edit` are split, so a read key lists only `alerts`, marked
  `readOnlyHint`, and `alerts_edit` carries the destructive hint.
- **Access is the key's alerts access** (`Who.alerts`, `docs/admin.md`):
  `none` lists neither, `read` lists `alerts`, `write` both
  (`alertsTools()`, `docs/tools.md`). Each call checks again and answers
  `forbidden` before reading anything ("this key has no alerts access;
  its owner grants it", "this key reads alerts only; its owner grants
  write"). The admin key holds `write`, and so does a person's web UI
  login, its writes held to this server's own pages (`sameOrigin()`,
  `docs/web.md`).
- **`alerts` takes `id`, `symbol`, `history`, `since` and `next`.**
  Without `history`: the alerts by id (`alertList()`, `ALERTS_PAGE` (50)
  read, then `fitPage()`), or with `id` one alert and its last
  `LAST_TRIGGERS` (5) triggers (`oneAlert()`). With `history`: triggers
  newest first, filtered by `id`, `symbol` and `since`
  (`historyList()`). Each list adds `instruments` (name, type,
  currency, unit of every listing the page's items name, never those
  cut by `fitPage()`) and an opaque `next` bound to the arguments.
  `since` goes with `history` only; `id` without `history` takes no
  `symbol` or `next`. A `symbol` filter reads stored listings only and
  fetches nothing; with `history` an unstored `market:symbol` id is
  taken as given, as a deleted listing's triggers keep it.
- **A stored trigger this server cannot read** (`storedTrigger()`) goes
  out with `id`, `alert_id`, `triggered_at` and `truncated: true`,
  in the feed and in history, logged once at warn; the rows around it
  read as usual.
- **`alerts_edit` takes `action`** (`create`, `update`, `pause`,
  `resume`, `delete`) **and only that action's arguments** (`EDIT_ARGS`):
  create `symbol`, `when`, `note`, `after_earnings`; update `id`, `when`,
  `note`; the rest `id`.
- **Alerts and triggers are one person's** (`rules.owner`,
  `alerts.owner`, migration `0036-owners`): the tools and the routes read
  and change only the caller's, another's id answering `not_found`, and
  a trigger copies its alert's owner, so it stays theirs after the
  alert goes. The engine evaluates and pauses every person's alerts
  (`allRules()`), since prices are shared.
- **The routes call the same functions** (`createAlert()`,
  `updateAlert()`, `pauseAlert()`, `deleteAlert()`, `alertList()`,
  `oneAlert()`, `historyList()`; `docs/api.md`), so an alert made by a
  key or by the web UI's Alerts page is the same.

## Seen

- **`GET` and `PUT /alerts/seen` hold the web UI's mark of the newest
  trigger shown** (`users.alerts_seen`, `readSeen()`, `markSeen()`) and
  how many of the person's triggers came after it. The mark moves
  forward only and never past the person's own newest trigger, so one
  that comes later is never seen ahead of time. They are web UI routes:
  no agent key opens them.
