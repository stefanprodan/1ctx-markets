# Stock note template (stock-v1)

Fill it in order. Delete every `<!-- -->` comment when saving, and leave out a section marked "(if applicable)" when it doesn't apply. The whole note must be ≤ 10,000 bytes. `<CCY>` is the listing's currency as `quote` answers it; every price and per-share value carries it.

```markdown
# <SYMBOL> · <Company name>
- written: <YYYY-MM-DD> · kind: <initiation | update | post-earnings> · template: stock-v1
- data through: <YYYY-MM-DD close> (signals dated <YYYY-MM-DD>) · price at writing: <p> <CCY> (close <YYYY-MM-DD>, <exchange>)
- stance: <Constructive|Neutral|Cautious> · fundamentals: <improving|stable|deteriorating> · valuation: <below|in|above> band · uncertainty: <low|medium|high> · cycle: <n/a|early|mid|late|peak><, scoped to <segment> when only part of the business is cyclical>
- value band: <low>–<high> <CCY> (base <b>) · present value · method: <EPS × P/E | EV/EBITDA | EV/Sales | FCF yield | sum-of-parts (parts listed in Scenarios)>, <forward|trailing> multiple, on FY<yy> <metric>, value dated <start of FY<yy> for a forward multiple | end of FY<yy> for a trailing one>, <discounted | carried forward> <n> y at <r>% (<10% | 10% + <g> points: <CCY> 10y <y>% vs US 10y <u>%, <date>>) to the writing date<; + excess cash at peak <x> <CCY>/share><; + present value of dividends paid before the value date <d> <CCY>><; FX <pair rate, date> if the reporting currency differs from the listing's> · horizon: 2–3 years
- why: <one line: the evidence behind the fundamentals and valuation calls>
- review by: <YYYY-MM-DD> (<day after the next report | written + 45 days>, whichever is first)
- full review: <YYYY-MM-DD> (set at initiation and each full refresh; a light update keeps it)
- changed: <rN YYYY-MM-DD: what changed (old → new) and why | initiation>
<!--
Value band: base ±15%, or ±25% when uncertainty is high. Always present value, never value at the horizon.
Dating the value: a forward multiple (forward P/E, EV/forward sales) on FY<yy> figures is the price at the START of FY<yy>;
a trailing multiple on FY<yy> figures is the price at the END of FY<yy>. Discount a later date back to the writing date; carry an earlier one forward at the same rate.
Discount rate: 10% in the US dollar or a currency whose lowest-risk 10-year government yield is at or below the US 10-year;
a higher-yield currency adds the gap between that yield and the US one on the writing date.
Valuation zone: below = price < band low; in = within the band; above = price > band high.
Stance grid (the chart is NOT an input):
  improving:     below/in → Constructive; above → Neutral
  stable:        below → Constructive; in → Neutral; above → Cautious
  deteriorating: below → Neutral; in/above → Cautious
Cyclicals (memory, chip equipment, commodities, autos, any company whose margins swing with a cycle): set cycle.
  At late/peak, judge fundamentals against past peak margins: margins at or above the past peak count as "stable", never "improving".
  Base the value on mid-cycle (normalised) EPS or margin, not FY+2 peak EPS. State the normalisation used.
  At late cycle with margins already falling from the peak, fundamentals are "deteriorating".
  Partly cyclical businesses: normalise only the cyclical part (e.g. a segment), and say which. A margin dip from mix at mid-cycle is not a turn.
  Fill the Cycle evidence block below.
-->

## Thesis
<2–3 sentences of judgement: what the business must deliver for the shares to work over 2–3 years.>
- **Priced in:** <what the price implies, from observables: multiple vs growth, the reverse-DCF growth rate, the reaction to the last print>.
- **Where this differs:** <variant view and its primary-source basis | "none: consensus view">.

## Business
<!-- Facts from the annual report's business section and segment note (10-K or 20-F Item 1 for a US filer) and the latest results release. Refresh at each annual report. -->
| Segment / line | Share of revenue | Growth YoY | Margin | Period · source |
|---|---|---|---|---|
| <segment> | | | <% or n/d> | |
| … of which <sub-line> | | | | |
- **Model:** <how it makes money, one line> · **Customers:** <concentration, top-customer %> · **Reporting:** <currency; standard (US GAAP, IFRS, local); segments are geographic / single segment / categories changed YYYY-MM-DD, as applicable>.

## Cycle evidence (cyclicals only)
- **Margins vs past peaks:** <current vs past peak quarters and years, with dates and sources>.
- **Inventory:** <days, vs past cycle peaks and troughs | "not in the release; interim report due <date>">.
- **Capacity:** <adds by the company and its rivals, with dates>.
- **Prices:** <contract or commodity price trend, source | n/a for custom or contract products>.
- **Call:** <early|mid|late|peak> because <one line>.

## Other listings (if applicable)
- <depositary receipts or a second listing: venue, listing date, ratio, depositary> · **home line:** <symbol, currency> · **premium/discount:** <x% at writing (math shown, FX dated) vs y% at pricing or one year ago> · **reporting:** <currency, forms, home filings site>.

## Competitive standing
- **Advantage:** <switching costs | network | scale | IP | cost> · **trend:** <strengthening|stable|eroding> because <dated evidence>.
- **Rivals:** <names and where they compete>.

## Key drivers
| Driver | Last reading (period · source) | Thesis breaks if |
|---|---|---|
| <KPI> | <value · results release, interim report or IR, or "coverage: publisher, date"> | <threshold at the next report> |
<!-- 3–5 rows. Note discontinued or redefined KPIs ("bookings no longer reported after Q4-25; proxy: …"). -->

## Guidance record
| Quarter (report date) | Guided (revenue / EPS / key metric; when) | Actual (EPS ex one-offs) | Reaction (gap / close / filled?) |
|---|---|---|---|
<!-- The last 4 reports (new listings: "since listing, N reports"; half-yearly reporters: the last 4 half-years), including preliminary releases as their own rows. Qualitative, cost-only (e.g. opex) or call-only guidance is allowed, tagged "(call, coverage)". Flag 53-week quarters. Reactions from `history`. -->
- **Next report:** <date hour | "unknown (searched: …); likely <date> from past pattern"> · guide-implied EPS <…> · consensus at writing EPS <…>, revenue <…> (<source>, fetched <date>) <vs the latest company guide: in line | above the top | stale>.
- **Other dated events:** <split or stock-dividend dates, lock-ups, investor day, shareholder meetings, legal deadlines, regulatory dates> or none.

## Scenarios and value
| Case | Key assumptions (FY<yy>) | Shares (dilution) | Method and multiple | Present value (<CCY>) |
|---|---|---|---|---|
| Bull | | | | |
| Base | | | | |
| Bear | | | | |
<!-- Judgement, with inputs shown. ~25% odds of beating bull and of missing bear. Use the method that fits the debate (FCF yield or EV/EBITDA when FCF or credit is the issue; sum-of-parts with one row per part when segments differ in kind). Leave the table out rather than invent inputs. -->
- **Multiple over time:** <forward P/E range over 3–5 y with source | fallback: price ÷ realised next-FY EPS, from history and releases | "unknown (searched: …)"> · at writing <z> at <price at writing> <CCY>.

## Triggers
- **Stays <current stance> while:** <observable conditions>.
- **→ <other stance>:** <KPI, report line, filing, or weekly close vs a structural level>.
- **→ <third stance>:** <…>.
- **Between reports:** <credit rating, new issuance vs a stated cap, regulation, material customer contracts> or none.
- **Thesis broken:** <fundamental and observable, independent of price>.

## Capital and balance sheet
- <buybacks vs dilution (offerings, shelf takedowns, warrants, share-based pay), debt raised (amount, currency, coupons, maturities, dates), capex vs FCF, guarantees and off-balance-sheet commitments, dividend coverage; dated, from filings>.

## Price behaviour (weekly/monthly)
- **Structural levels:** <price: what it is (weekly shelf, unfilled gap edge, post-earnings low, prior cycle high), date set>; 3–5 levels.
- **Drawdowns:** <past peak-to-trough declines with dates>.
- **Extension at past peaks:** <price ÷ weekly SMA50 at prior tops, with dates; "n/a (history too short)" where needed>.
- **Typical earnings move:** <average absolute next-day move over the last 4–8 reports>.
- **Cycle lead/lag (if applicable):** <how the stock led or lagged its commodity or industry indicator at past turns>.
- **Setup at writing:** <one sentence in words, e.g. "below the SMA200 and testing the weekly SMA50", as of the data-through date>.
<!-- No values for MA, Bollinger, ATR, RSI, MACD, returns or 52w: readers take them from `quote`. -->

## Risks
- **<label>:** <risk>; shows up as <observable>. <!-- 3–5, ranked; name the macro factor it trades on -->

## Flows
- <Analysts: 3-month direction. Insiders: pattern. Filings: notable flags (equity vs debt offerings) or material announcements, dated. One or two lines.>

## Unverified coverage
- <claim — publisher, YYYY-MM-DD, link> <!-- ≤ 4; never restated as fact above -->

## Data caveats
- <figures that could not be found or checked, and where they were searched | none known>

---
Sources: 1ctx-markets quote, history, research, events (fetched <range UTC>) · <publisher · document · date · period · URL>.
```
