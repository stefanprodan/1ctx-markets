# ETF note template (etf-v1)

Fill it in order. Delete every `<!-- -->` comment when saving. The whole note must be ≤ 8,000 bytes. `<CCY>` is the listing's currency as `quote` answers it.

```markdown
# <SYMBOL> · <Fund name>
- written: <YYYY-MM-DD> · kind: <initiation | update> · template: etf-v1
- data through: <YYYY-MM-DD close> · price at writing: <p> <CCY> (close <YYYY-MM-DD>, <exchange>)
- exposure stance: <Constructive|Neutral|Cautious> · rests on: <drivers, and look-through symbols by id> · horizon: 2–3 years
- vehicle: <Good|Adequate|Weak> (<cost, tracking, structure in a few words>)
- valuation: <index or fund P/E fwd|TTM <x> (source, date) vs its <n>-year range <a–b> | "unknown (searched: …)">: <cheap|fair|rich>
- why: <one line: the evidence behind the exposure stance>
- review by: <YYYY-MM-DD> (<day after the largest holding's next report | written + 60 days>, whichever is first)
- full review: <YYYY-MM-DD> (set at initiation and each full refresh; a light update keeps it)
- changed: <rN YYYY-MM-DD: what changed (old → new) and why | initiation>
<!-- Exposure stance rule (the chart is NOT an input): take the weight-weighted stances of the look-through notes that exist (Constructive +1, Neutral 0, Cautious −1) over the covered weight. Average ≥ +0.33 → Constructive, ≤ −0.33 → Cautious, else Neutral. With no look-through note, start at Neutral and move one step by the valuation line (cheap up, rich down); with notes covering < 40% of weight, move one step by it too. Say the inputs in the why line.
The vehicle rating is about the fund: cost, tracking, structure, size, liquidity. -->

## What it is
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

## Exposure
- **Concentration:** top 10 <x%>, top 3 <names and %>, largest <%> (cap <c%>); holdings as of <date, or `research` top_holdings fetched <date> with no as-of date>.
- **Clusters:** <sub-groups with summed weights, e.g. designers / memory / equipment / foundry>.
- **Look-through:** single-stock notes to read: <market:symbol ids> (read them; take their stance as an input, do not copy their reasoning). Notable gaps: <large holdings without a note>.
- **Currency:** underlying in <currencies>, listing in <CCY>. Mechanism: a firmer listing currency subtracts one for one, all else equal. Check any gap against the twin against the FX move over the same period before attributing it. (Same currency: "holdings and listing in <CCY>; for a reader in another currency, that pair's move adds to or subtracts from the return".)

## Thesis and triggers
<2 sentences: why this exposure works or doesn't over the horizon.>
- **Stays <current stance> while:** <…> · **→ <other stance>:** <…> · **Exposure thesis broken:** <observable>.

## Calendar
- **Holdings reporting in the next ~6 weeks (<x%> of weight):** <SYMBOL date hour (weight)>; current dates in `events` for US shares, the issuers' calendars for others.
- **Index and fund events:** <rebalance or reconstitution dates, distributions> or none known.
- **Pattern:** <how the fund moved on this listing's next session after its largest holdings' last reports, one line>.

## Price behaviour (weekly/monthly)
- **Structural levels:** <3–5, each with its reason and date>.
- **Drawdowns and extension:** <past declines with dates; price ÷ weekly SMA50 at past peaks>.
- **Home or overnight market (if applicable):** <the underlying market's index and how it leads this listing>.
- **Setup at writing:** <one sentence in words>.
<!-- No MA, Bollinger, ATR, RSI, MACD, returns or 52w values. -->

## Risks
- **<label>:** <risk>; shows up as <observable>. <!-- concentration, cycle, FX, index rules, liquidity/spread, closure, withholding tax -->

## Data caveats
- <figures that could not be found or checked (holdings date, fees, tracking), and where they were searched | none known>

---
Sources: 1ctx-markets quote, history, research (top_holdings), events (fetched <range>) · <issuer / index documents: publisher · document · date · URL>.
```
