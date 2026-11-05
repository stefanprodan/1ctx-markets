# ETF note template (etf-v1)

Fill it in order. Delete every `<!-- -->` comment when saving. At most 6,000 bytes, Decide about 3,000; shorter is fine, and over the limit Reference is cut first, then Check. `<CCY>` is the listing's currency as `quote` answers it.

```markdown
# <SYMBOL> · <Fund name>
- written: <YYYY-MM-DD> · kind: <initiation | update> · template: etf-v1
- price at writing: <p> <CCY> (<live HH:MM UTC | close> <YYYY-MM-DD>, <exchange>)
- exposure stance: <Constructive|Neutral|Cautious> · rests on: <drivers, and look-through symbols by id> · horizon: 2–3 years
- vehicle: <Good|Adequate|Weak> (<cost, tracking, structure in a few words>)
- valuation: <index or fund P/E fwd|TTM <x> (source, date) vs its <n>-year range <a–b> | "unknown (searched: …)">: <cheap|fair|rich>
- why: <one line: the evidence behind the exposure stance>
- review by: <YYYY-MM-DD> (<day after the largest holding's next report | written + 60 days>, whichever is first)
- full review: <YYYY-MM-DD> (set at initiation and each full review; a light update keeps it)
- changed: <rN YYYY-MM-DD: what changed (old → new) and why | initiation>
<!-- Exposure stance rule (the chart is NOT an input): take the weight-weighted stances of the look-through notes that exist (Constructive +1, Neutral 0, Cautious −1) over the covered weight. Average ≥ +0.33 → Constructive, ≤ −0.33 → Cautious, else Neutral. With no look-through note, start at Neutral and move one step by the valuation line (cheap up, rich down); with notes covering < 40% of weight, move one step by it too. Say the inputs in the why line.
The vehicle rating is about the fund: cost, tracking, structure, size, liquidity. -->

## Decide

### Thesis
<2 sentences: why this exposure works or doesn't over the horizon.>

### Triggers
- **Stays <current stance> while:** <figure or level> <comparison> <value> (<where checked>).
- **→ <other stance> if:** <figure or level> <comparison> <value> (<where checked>).
- **Exposure thesis broken if:** <observable> (<where checked>).
<!-- Every trigger names a level or figure, a comparison, where it is checked and the stance it moves to: "weekly close < 52 <CCY> (`history` 1wk) → Cautious", "look-through notes Cautious > 10% of weight (`analysis` read) → Neutral", "index P/E fwd > 30 (provider factsheet) → Cautious". -->

### Levels
| Level (<CCY>) | What it is | Set |
|---|---|---|
| <price> | <weekly shelf, gap edge, prior high or low> | <YYYY-MM-DD> |

<!-- 3–5 rows. Never where the price sits now: readers compare `quote` with these. -->

### Next 6 weeks
| Date | Event | Last reaction to this kind of event |
|---|---|---|
| <YYYY-MM-DD hour> | <holding> report (<weight %>) | <this listing's next session after its last report> |
| <YYYY-MM-DD> | <index rebalance or reconstitution, distribution, fund event> | <…> |

<!-- The top holdings' reports in the window with their weights (`events` for US shares, the issuers' calendars for others), and index and fund dates; other dates only when a trigger or risk names them. -->

### Risks
- **<label>:** <risk>; first shows in <observable, where>. <!-- concentration, cycle, FX, index rules, liquidity/spread, closure, withholding tax; one line each -->

## Check

### Key drivers
- <2–4 lines: the figures the exposure rests on (a sector's earnings growth, a commodity price, a rate), each with its last reading, period and source>.

### Exposure
- **Concentration:** top 10 <x%>, top 3 <names and %>, largest <%> (cap <c%>); holdings as of <date, or `research` top_holdings fetched <date> with no as-of date>.
- **Clusters:** <sub-groups with summed weights, e.g. designers / memory / equipment / foundry>.
- **Look-through:** single-stock notes to read: <market:symbol ids> (read them; take their stance as an input, do not copy their reasoning). Notable gaps: <large holdings without a note>.
- **Currency:** underlying in <currencies>, listing in <CCY>. Mechanism: a firmer listing currency subtracts one for one, all else equal. Check any gap against the twin against the FX move over the same period before attributing it. (Same currency: "holdings and listing in <CCY>; for a reader in another currency, that pair's move adds to or subtracts from the return".)

### Valuation
- <the index's or fund's multiple over 5–10 years, with source and date; what the valuation line's cheap, fair or rich rests on>.

### Cycle evidence (if the exposure is cyclical)
- <margins against past peaks, inventory, capacity, prices across the holdings; the call and why>.

## Reference

### What it is
| Field | Value (source, date) |
|---|---|
| Identifier · domicile · fund regime | <ISIN or local code; country; e.g. UCITS, US 1940 Act, a local regime> |
| Index and rules | <provider and name; weighting; caps; screens; number of constituents; reconstitution and rebalance dates> |
| Replication · securities lending | |
| Share class · distribution · currency hedge | |
| Expense ratio · fund size · tracking difference 1y/3y | |
| Withholding / tax drag | <dividend withholding the fund pays on its holdings, set by its domicile's treaties; synthetic vs physical> |
| Trading clock | <listing hours vs the underlying's; when moves in other time zones reach this price> |
| Proxy | <a twin on another listing and how its index differs; for comparison only> |

<!-- From the issuer's factsheet, key information document, prospectus or annual report, and the index provider's methodology. Write "unknown (searched: …)", never a guess. -->

### Price history
- **Drawdowns and extension:** <past declines with dates; price ÷ weekly SMA50 at past peaks>.
- **Home or overnight market (if applicable):** <the underlying market's index and how it leads this listing>.

### Unverified coverage
- <claim — publisher, YYYY-MM-DD, link> <!-- ≤ 4 -->

### Gaps
- <what was searched for and not found (holdings date, fees, tracking), and where searched | none>
```
