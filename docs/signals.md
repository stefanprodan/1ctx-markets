# Signals

Governs the technical signals computed from stored bars and quotes:
`src/signals/common.ts`, `daily.ts` and `weekly.ts` (the maths),
`store.ts` (final and live rows), `read.ts` (what tools read, with
stale reasons) and `relative.ts` (relative return), and the `signals`
table (`src/db/migrations/0005-signals.ts`). Sessions, bar dates and
finality are in `docs/calendars.md`; the bar writes that call these in
`docs/yahoo.md` and `docs/fred.md`; stale reasons in
`docs/storage.md`.

## The daily signals

`i` is the bar's index from the instrument's first stored daily bar,
counted from 0; a value is null before its first bar. "Close" is the
bar's close, or the live price on the live row.

| Signal | Definition | First value |
| --- | --- | --- |
| `sma50`, `sma200` | mean of the last 50 or 200 closes | i 49, i 199 |
| `cross` | sign of `sma50 - sma200` | i 199 |
| `cross_edge` | 1 when that difference turns above 0 from at or below it, -1 the reverse, else 0 | i 200 |
| `ema20` | EMA 20, seeded with the SMA 20 at its first bar, then `prev + 2/(n+1) * (close - prev)` | i 19 |
| `macd` | EMA 12 minus EMA 26, each seeded the same way | i 25 |
| `macd_signal` | EMA 9 of `macd`, seeded with the mean of its first 9 values | i 33 |
| `macd_histogram` | `macd - macd_signal` | i 33 |
| `macd_turn` | 1 when the histogram rises after a fall or flat (`h > h1` and `h1 <= h2`), -1 the mirror, else 0 | i 35 |
| `rsi14` | Wilder RSI: gain and loss seeded with the mean of the first 14 changes, then `(13 * prev + x) / 14`; loss 0 gives 100, both 0 give 50 | i 14 |
| `atr14` | Wilder ATR of true range, seeded with the mean of 14 ranges; the first bar's range is high minus low | i 13 |
| `move_atr` | `(close - previous close) / previous row's atr14` | i 14 |
| `volatility20` | sample deviation (n - 1) of the last 20 log returns, in percent per day | i 20 |
| `bollinger_lower` | SMA 20 minus 2 population deviations of the 20 closes | i 19 |
| `high52w`, `low52w` | highest high and lowest low over the 52 calendar weeks (364 days) ending on the bar | when the first bar is at least 363 days earlier |
| `drawdown` | `100 * (close / high52w - 1)`, null when the high is not above 0 | as `high52w` |
| `from_low` | `100 * (close / low52w - 1)`, null when the low is not above 0 | as `low52w` |
| `days_since_high` | bars since the latest bar at the 52-week high | as `high52w` |
| `volume_ratio` | volume over the mean of the 20 bars before it | i 20 |

- **Final and live rows run the same step** (`dailyRow()` in
  `daily.ts`, `smaCross` and the EMA helpers in `common.ts`), so a seed
  recomputed from bars repeats the incremental path bit for bit. A new
  signal goes in that step.
- **Wilder's averages and the EMA seeds depend on where history
  starts**, so a value is reproducible only from the first stored bar.
- **A bar without high or low has no true range**: `atr14` is null on
  it and seeds again from the next 14 ranges, rather than stay null
  until a recompute.
- **A final bar with neither high nor low ranges over its close**
  (FRED, or a source's null range) for the 52-week values. A live
  quote without a day high or low gives no 52-week values at all,
  since a price is not a bar's range yet. A bar in the window with
  only one of high or low nulls every 52-week value, final rows
  included (`range52w()`).
- **A close at or below 0 in the 20 returns makes `volatility20`
  null.** **`volume_ratio` is null when the bar or any of the 20 before
  has no volume, or their sum is 0** (an index or FX pair reports 0); a
  0 day of a share that trades is a ratio of 0. **It is null too when a
  split of a Bucharest feed instrument falls inside those 21 bars**
  (`volumeBreaks()`), since that feed adjusts prices but keeps volumes
  raw (`docs/bvb.md`).

## Weekly signals

- **Weekly rows hold only `sma50`, `sma200`, `cross` and `cross_edge`
  on weekly closes**, dated by the week's Monday (`weekly.ts`); the
  schema's checks keep every other column null on `1wk` rows.
- **A week's bar is final once its Sunday has ended in the market's
  zone and every daily bar in it is final** (`weeksOf` in `src/bars.ts`),
  and weekly rows follow the same final and live rules as daily ones.

## Final rows

- **Final rows come only from final bars** (`finalPrefix`: the bars up
  to the first not final, since a series never skips a day). A
  provisional bar never produces a final row.
- **Any change recomputes every final row from the first stored bar**
  (`recomputeSignals`): a past bar changed on or before the last final
  row, or a bar turned final or went away (`finalPending` compares
  counts and last dates). An incremental patch would drift from the
  seeds.
- **Signals are computed inside the bar write's transaction**
  (`signalsAfterBars`), final rows first, then the live rows, so at a
  session's rollover the previous day's final row exists before the new
  live row steps from it.

## The live row

- **At most one live row per instrument and interval**
  (`signals_one_live`), stepped from the last final row with one
  provisional bar from the stored quote (`liveDaily`, `liveWeekly`), so
  it is exactly what the final row will be if the close, day high, low
  and volume end as the quote shows them.
- **`replacesLast` says the quote's session is the last stored bar,
  not yet final**, which the provisional bar replaces; otherwise it is a
  new day after the last bar. A final bar on the quote's date means no
  live row.
- **The quote dates the row by its market's stored session**
  (`liveTarget`): a trade from the session's start until its local
  start time on the next day, or `LIVE_AFTER_END_MS` (15 minutes) after
  its end when that is later (`liveUntil()`). Nothing of the next
  session trades before it starts, a closing auction prints after the
  end, and Yahoo stamps an index's value up to 75 minutes after it
  (^NDX at 21:15:59 UTC for a 20:00 end). A trade outside that window
  belongs to another day and updates the quote only, never a row.
  Never date it by fixed UTC hours.
- **Crypto's day is the UTC day**: its trade's UTC date is the row's,
  with no allowance carrying it past midnight.
- **Live prices never wait on the bars.** When an earlier bar is not
  final or has no final row (a bar pass failed at a rollover),
  `liveBase` runs the series from the first bar over the bars as stored,
  the unfinished day included, and the read adds "previous day not
  final".
- **The live row reads the latest `LIVE_DAYS` + 1 daily bars or
  `LIVE_WEEKS` + 1 weeks** (`refreshLive()`), dropping the last only
  when the provisional row replaces it, so at least 400 daily bars or
  200 weeks come before the provisional one, enough for 52 weeks of a
  daily market and SMA 200; the rest is stepped from the running values the final row stores:
  `ema12`, `ema26`, `rsi_gain`, `rsi_loss` and `prev_histogram` (the
  previous histogram, for `macd_turn`). These are never shown to a
  caller (`RUNNING` in `src/tools/quote.ts`).
- **A quote that moved recomputes the live rows; for the rest of its
  market `pruneLive` drops or recomputes a row the session moved past.**
  A live row stores the quote's trade time (`quote_time`).

## Reading

- **A reader takes the live row when one exists, else the last final
  row** (`readLatest`, `src/tools/quote.ts`), each tagged `kind`.
- **Stale reasons are fixed phrases from `STALE` in `src/stale.ts`.**
  `readSignals` adds "signals pending" when final rows lag the final
  bars or the live rows lag the quote (another date or trade time), and
  "previous day not final" when a live row stepped over a stored day not
  yet final. FRED uses the final list only (`docs/fred.md`).
- **Values are rounded to six significant digits on output** (`round`
  in `src/tools/answer.ts`); stored rows keep full precision, and a
  reader that computes on them takes the unrounded rows (`Latest`).

## Relative return

- **Computed on read for the benchmark the caller names, never stored
  per pair** (`readRelativeReturn`), over 1 or 3 months, on final daily
  closes.
- **Every anchor is a date on the benchmark's days, never a row
  offset**, since the two trade on different calendars. The end is the
  benchmark's last row; its start is its row on or before the same
  calendar day 1 or 3 months back (clamped to the month's end,
  `monthsBack`); the instrument's start and end are its rows on or
  before those dates.
- **Null when either has no row on or before an anchor, the
  instrument's last row is before the benchmark's start (it stopped
  trading and would read as flat), the instrument's start and end are
  one row while the benchmark moved, a price starts at or below 0, or
  a level series is set against a price.**
- **It ends on live prices only when both have a live quote of the same
  session date after their final bars** (and on or before `to` when
  given); `live` says so.
- **A percent unit is a level series: it changes in points, not
  returns** (`LEVEL_NOTE`); prices change in percent in each listing's
  own currency, no FX conversion (`RETURN_NOTE`). `relative` is the
  instrument's change less the benchmark's.
- **Reads are bounded to the anchors** (`readCloses()`): closes from
  the last bar on or before the earliest start the end can need,
  widened when the last final close is earlier than the last bar. A
  benchmark side is read once and reused across instruments and
  periods (`benchmarkSide()`, `instrumentSide()`, `relativeOf()`).
- **When either unit is `unknown`, the note adds "units unknown,
  treated as prices"** (`UNKNOWN_UNITS_NOTE`), because an index such as
  a stock index is unit unknown and a valid benchmark.

## Trailing returns

- **`1w`, `1m`, `3m` and `ytd` from the last final close on or before
  each start** (`trailingReturns()`): 7 days, 1 and 3 calendar months
  back by `monthsBack()`, and the previous year's 31 December, counted
  from the end's date; a holiday on the 31st takes the close before.
- **The end is the live price only when its session date follows the
  last final bar** (`returnsOf()`), the rule relative return follows;
  otherwise the last final close. `to` and `live` say which.
- **A percent unit answers points, prices percent** in the listing's
  own currency; a period whose start the bars do not reach is null.
