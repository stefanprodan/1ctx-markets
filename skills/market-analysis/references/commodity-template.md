# Commodity note template (commodity-v1)

Fill it in order. Delete every `<!-- -->` comment when saving. At most 6,000 bytes, each part within its budget in SKILL.md (header 1,000, Decide 2,600, Check 1,300, Reference 700); shorter is fine, and over the limit each part over its budget is cut back to it. The note sits on the front-month future as `quote` answers it (GC=F for gold, CL=F for crude oil), priced in `<CCY>` per `<unit>` (USD/oz, USD/bbl). It is written for someone holding the commodity for 2–3 years, through any vehicle, never for trading the front contract. A fund or exchange-traded commodity on it gets a link note pointing here.

```markdown
# <SYMBOL> · <Commodity>, <exchange> front-month future
- written: <YYYY-MM-DD> · kind: <initiation | update> · template: commodity-v1
- price at writing: <p> <CCY>/<unit> (<live HH:MM UTC | close> <YYYY-MM-DD>, <exchange>, <contract month>)
- stance: <Constructive|Neutral|Cautious> · fundamentals: <improving|stable|deteriorating> · valuation: <below|in|above> band · uncertainty: <low|medium|high> · cycle: <phase, one clause>
- value band: <low>–<high> <CCY>/<unit> (base <b>) · <method in a few words> · horizon: 2–3 years
- curve: <contango | backwardation | flat>: <next contract> <x>% <over | under> <front contract> (<source>, <date>); rolling the futures <costs | earns> about <y> %/yr
- why: <one line: the evidence behind the fundamentals and valuation calls>
- review by: <YYYY-MM-DD> (<day after the next decision of the central bank whose rate drives it | the next supply-demand report it rests on | written + 45 days>, whichever is first)
- full review: <YYYY-MM-DD> (set at initiation and each full review; a light update keeps it)
- changed: <rN YYYY-MM-DD: what changed (old → new) and why | initiation>
<!--
Fundamentals are the supply and demand balance over the horizon: mine or well supply and its cost, inventories, industrial and investment demand, central-bank buying; for a precious metal also real rates and the dollar, each read as a direction over months, never as the latest print.
Value band: a stated method, base ±15%, or ±25% when uncertainty is high (most commodity notes):
  the price deflated by consumer prices against its own long-run range (FRED CPI series, years named);
  the cost curve: the producers' all-in sustaining or marginal cost as a floor (industry body or the largest producers' reports, dated);
  a ratio to a related commodity against its long-run range (gold to silver, crude to natural gas).
  Two methods that disagree widen the band rather than pick one.
Valuation zone: below = price < band low; in = within the band; above = price > band high.
Stance grid (the chart is NOT an input):
  improving:     below/in → Constructive; above → Neutral
  stable:        below → Constructive; in → Neutral; above → Cautious
  deteriorating: below → Neutral; in/above → Cautious
Curve: from the exchange's settlement prices for the front and next contracts, dated; the roll figure is what a fund holding the futures gains or loses a year to the curve, before fees.
-->

## Decide

### Thesis
<2–3 sentences of judgement: what must hold for the price to rise, hold or fall over 2–3 years, and which driver decides.>
- **Priced in:** <what the price and the curve imply: the consensus balance (deficit or surplus), the real rate it assumes, the reaction to the last shock>.
- **Where this differs:** <variant view and its primary-source basis | "none: consensus view">.

### Triggers
- **Stays <current stance> while:** <figure or level> <comparison> <value> (<where checked>).
- **→ <other stance> if:** <figure or level> <comparison> <value> (<where checked>).
- **→ <third stance> if:** <…>.
- **Thesis broken if:** <change in the balance or in why it is held> (<where checked>), true regardless of price.
<!-- Every trigger names a fixed level or a published figure, a comparison, where it is checked and the stance it moves to: "weekly close < 3,200 USD (`history` 1wk) → Cautious", "annual deficit turns to surplus (Silver Institute, April) → Neutral", "central banks' net buying < 500 t a year (World Gold Council) → Neutral". Never a moving average or another live reading: the tools serve those. -->

### Levels

| Level (<CCY>/<unit>) | What it is | Set |
|---|---|---|
| <price> | <record, drawdown low, breakdown or breakout point, roll gap edge> | <YYYY-MM-DD> |

<!-- 3–5 rows, from `history` 1wk and 1d. A level on the front-month series can sit on a roll gap: name the contract when it matters. Never where the price sits now: readers compare `quote` with these. -->

### Next 6 weeks

| Date | Event | Last reaction to this kind of event |
|---|---|---|
| <YYYY-MM-DD> | <central bank decision, inventory or demand report, OPEC+ meeting, contract expiry> | <date: next-session close move> |

<!-- Only dates a trigger or risk names, from the official calendars. -->

### Risks
- **<label>:** <risk>; first shows in <observable, where>. <!-- 3–5, ranked, one line each -->

## Check

### Key drivers

| Driver | Last reading (period · source) | Stance breaks if |
|---|---|---|
| <supply: mine or well output, cost> | | |
| <demand: industrial, investment, central banks> | | |
| <balance or inventories> | | |
| <real rate or the dollar, when it decides> | | |

<!-- 3–5 rows; every figure dated and sourced, a year or a quarter, never a daily print. -->

### Positioning
- <from `research` `positioning`: the managed-money net position at the last two turns in price, as a share of open interest, with dates; what a reading near those extremes meant then. Never the latest week alone.>

### Valuation
- **Method:** <deflated price against its <n>-year range | cost curve floor | ratio to <related commodity>>, <source, date>, giving <v> <CCY>/<unit>.
- **Forecasts (coverage):** <institution: level, horizon, published date>; at most four, the newest first.

## Reference

### What it is
- <contract: exchange, unit, contract months, roll; how the front-month series jumps at a roll; the main ways to hold it: physically backed exchange-traded commodities and funds (link notes to this one), futures funds and their roll>.

### Price history

| <year> | <year> | … | <year to date> |
|---|---|---|---|
| <change %> | | | |

- **Drawdowns (closes):** <peak → trough, dates, % for the largest two or three from `history` 1wk>. Close ÷ weekly SMA50 at past peaks: <ratio, date>.
- **Data caveats:** <roll gaps, bad ticks, and the source used for exact levels>.

### Unverified coverage
- <claim — publisher, YYYY-MM-DD, link> <!-- ≤ 4; never restated as fact above -->

### Gaps
- <what was searched for and not found, and where searched | none>
```
