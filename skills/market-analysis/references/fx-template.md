# Currency pair note template (fx-v1)

Fill it in order. Delete every `<!-- -->` comment when saving. At most 6,000 bytes, Decide about 3,000; shorter is fine, and over the limit Reference is cut first, then Check. A pair `<BASE>/<QUOTE>` is priced in `<QUOTE>` per one `<BASE>`, as `quote` answers it (EURRON=X: lei per euro): the pair rising means `<BASE>` is stronger. Every rate and level says which way it reads.

```markdown
# <BASE>/<QUOTE> · <base currency name> / <quote currency name>
- written: <YYYY-MM-DD> · kind: <initiation | update> · template: fx-v1
- price at writing: <p> <QUOTE> per <BASE> (<live HH:MM UTC | close> <YYYY-MM-DD>)
- stance: <<BASE> stronger | range | <BASE> weaker> · fundamentals for <BASE>: <improving|stable|deteriorating> · valuation: <below|in|above> band · uncertainty: <low|medium|high> · regime: <free float | managed float | crawl | peg | band>
- value band: <low>–<high> <QUOTE> (base <b>) · fair value at the writing date · horizon: 2–3 years
- carry: <BASE> <r1>% vs <QUOTE> <r2>% (policy rates, <date>): holding <the higher-rate currency> earns about <gap> %/yr until the pair moves that much against it
- why: <one line: the evidence behind the fundamentals and valuation calls>
- review by: <YYYY-MM-DD> (<day after the next decision of either central bank | written + 45 days>, whichever is first)
- full review: <YYYY-MM-DD> (set at initiation and each full review; a light update keeps it)
- changed: <rN YYYY-MM-DD: what changed (old → new) and why | initiation>
<!--
Fundamentals are <BASE>'s against <QUOTE>'s: the rate gap and its expected path, the inflation gap, the current account, the budget and ratings, politics.
Value band: a fair value from at least one stated method (Method line in Valuation), base ±5%, or ±10% when uncertainty is high.
  A fair value dated earlier is carried to the writing date by the inflation gap: a currency with higher inflation loses that much a year.
  Under a peg or a formal band, the value band is the range the central bank holds. A managed float or a crawl takes a fair value like a free float: the range held since its last step is far too narrow for a band, so it goes in Levels and Regime.
Valuation zone: below = price < band low (<BASE> cheap); in = within the band; above = price > band high (<BASE> dear).
Stance grid (the chart is NOT an input):
  improving:     below/in → <BASE> stronger; above → range
  stable:        below → <BASE> stronger; in → range; above → <BASE> weaker
  deteriorating: below → range; in/above → <BASE> weaker
A regime overrides the grid where it binds: a credible peg is "range" whatever the grid says, and Triggers name what would break it.
-->

## Decide

### Thesis
<2–3 sentences of judgement: what must hold for the pair to move or stay over 2–3 years.>
- **Priced in:** <what the price and the forwards imply: the carry, the gap to consensus forecasts, the reaction to the last shock>.
- **Where this differs:** <variant view and its primary-source basis | "none: consensus view">.

### Triggers
- **Stays <current stance> while:** <figure or level> <comparison> <value> (<where checked>).
- **→ <other stance> if:** <figure or level> <comparison> <value> (<where checked>).
- **→ <third stance> if:** <…>.
- **Thesis broken if:** <fundamental or regime change> (<where checked>), true regardless of price.
<!-- Every trigger names a level or figure, a comparison, where it is checked and the stance it moves to: "weekly close > 5.45 <QUOTE> (`history` 1wk) → <BASE> stronger", "policy rate gap < 2 points (central banks' decisions) → range", "sovereign rating cut to sub-investment grade (agency release) → <BASE> stronger". A peg's trigger is the event that tests it: reserves falling, a widened band, a devaluation. -->

### Levels
| Level (<QUOTE>) | What it is | Set |
|---|---|---|
| <price> | <plateau edge, record official fixing, step-move high, band edge> | <YYYY-MM-DD> |

<!-- 3–5 rows, from `history` 1wk and 1d, checked against the official fixing where the bars disagree. Never where the price sits now: readers compare `quote` with these. -->

### Next 6 weeks
| Date | Event | Last reaction to this kind of event |
|---|---|---|
| <YYYY-MM-DD> | <BASE central bank> decision: <expected, source> | <date: pair's next-session close move> |
| <YYYY-MM-DD> | <QUOTE central bank> decision | <…> |
| <YYYY-MM-DD> | <CPI print, rating review, budget vote, election> | <…> |

<!-- Both central banks' decisions are the pair's own events and always listed; other dates only when a trigger or risk names them, from the official calendars. -->

### Risks
- **<label>:** <risk>; first shows in <observable, where>. <!-- 3–5, ranked, one line each -->

## Check

### Key drivers
| Driver | <BASE> (period · source) | <QUOTE> (period · source) | Stance breaks if |
|---|---|---|---|
| Policy rate | | | |
| Inflation vs target | | | |
| Current account, % of GDP | | | |
| Budget balance, % of GDP · rating | | | |

<!-- 3–6 rows; add 10-year yields, reserves, money-market rates or capital flows when they decide. Every figure dated and sourced. -->

### Regime
- <how the pair is run: free float, managed float (the central bank's stated and observed behaviour, intervention record), crawl, peg or band (the anchor, width and since when); reserves against months of imports or short-term debt; any convergence path, such as a euro adoption date, and whether it binds within the horizon>.

### Valuation
- **Method:** <PPP from relative price levels (source, year) | the real effective exchange rate against its <n>-year average (BIS via FRED, date) | the IMF's external sector assessment (Article IV, date) | the central bank's stated equilibrium>, fair value <v> <QUOTE> at <date>, carried to the writing date at the inflation gap <g> %/yr.
- **Forecasts (coverage):** <institution: level, horizon, published date>; at most four, the newest first, and how far they lag the price.

## Reference

### What it is
| Field | Value (source, date) |
|---|---|
| Central banks | <BASE>: <bank>; <QUOTE>: <bank> |
| Official fixing | <publisher, time of day; which fixing contracts and statistics use> |
| Trading clock | <main sessions, thin hours, holidays that empty the market> |
| Convertibility | <capital controls, onshore and offshore rates when they differ> |

### Price history
| <year> | <year> | … | <year to date> |
|---|---|---|---|
| <change %> | | | |

- **Step moves:** <the largest weekly moves with dates and causes, from `history` 1wk>.
- **Pattern:** <drift per year, how shocks behave (reversed or kept), the widest range of a calm year>.
- **Data caveats:** <bad ticks or flat stretches in `history`, and the source used for exact levels>.

### Unverified coverage
- <claim — publisher, YYYY-MM-DD, link> <!-- ≤ 4; never restated as fact above -->

### Gaps
- <what was searched for and not found, and where searched | none>
```
