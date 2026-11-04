# Portfolios

Governs portfolios, brokers, trades, positions and the funds the owner
prices: the tables of migrations `0020-portfolios` and
`0026-fund-trades`, `src/portfolios/` (`store.ts` rows, `funds.ts` a
fund and its prices, `value.ts` the holdings arithmetic, `growth.ts`
the past year's growth, `fx.ts` rates, `csv.ts`), `src/shared/isin.ts` (the ISIN check),
`src/operations/portfolio.ts` (every read and write the tools and the
routes share), `src/tools/portfolio.ts` (the portfolio tools), `src/operations/portfolio-import.ts` (CSV
import and export) and `src/api/portfolios.ts` with its spec in
`src/api/portfolio-spec.ts`. The routes' conventions are `docs/api.md`;
keys and their portfolio access `docs/admin.md`; the web page
`docs/web.md`; tracking `docs/storage.md`.

## Why

An owner trades at several brokers with no usable export and kept every
trade by hand in a spreadsheet so agents could read it. Entered once
here, by the web UI or an agent, a trade is read by every agent at
once and valued on the live price the server already keeps.

## What is kept

- **A portfolio is a name, nothing more.** No currency: one portfolio
  mixes currencies, and every owner has their own. Names are unique
  per owner ignoring case, 1 to 40 characters. A portfolio with a live row cannot
  be deleted (409); one whose rows are all removed can, its removed rows
  deleted in the same write, so a test or mistaken portfolio can go.
- **One portfolio, Cash, holds all cash and only cash**, marked by
  `portfolios.cash` (migration `0032-cash-portfolio`, a partial unique
  index keeping it to one per owner since `0036-owners`). The code, `list`, `GET /portfolios` (each
  portfolio's `cash`) and the web UI find it by the mark, never the
  name. It is made with the display currency (`ensureCash()`, by the
  first `PUT /portfolio-settings` or `portfolio_setup`), so a new owner
  has a place for cash before anything else; it is never renamed or
  deleted (409), and no other portfolio takes the name, ignoring case
  (409), so `setup` naming it makes nothing more. The name is English,
  as the rest of the web UI is.
- **Strict both ways**, so every caller has one rule: cash added with no
  portfolio goes to Cash, and cash naming another portfolio is refused
  ("cash lives in Cash; leave portfolio out"); a trade, fund trade or
  bond naming Cash is refused ("Cash holds only cash; name another
  portfolio"). A trade, fund trade or bond with no portfolio goes to the
  only portfolio besides Cash, and is refused naming the others when
  there are two or more (`portfolioFor()`), so an owner with Cash and
  one other never names it. Every other portfolio is investments only,
  so its tab shows no Invested against Dry powder bar, and the reserve
  rule across portfolios never reaches it.
- **The migration** marks a portfolio named Cash in any case that holds
  only cash, its name set to `Cash`; one holding a trade or bond, removed
  rows included, is renamed `Cash (before)` and a new Cash is made. With
  none, Cash is made when the display currency is set or any cash is
  kept (it needs a place), else at the first currency save. Every cash
  row elsewhere moves into Cash, removed rows too, so a chain's history
  moves whole; a live row meeting a live one of its name and broker
  there takes its old portfolio's name ("Spare (Stocks)"), since add
  then treated the two as one.
- **The owner orders the portfolios** (`portfolios.position`, migration
  `0034-portfolio-order`, filled in the name order shown before). Every
  list reads Cash first, then by place; a new portfolio goes last.
  `PATCH /portfolios/{id}` with `position` moves one among the others,
  1 first, past the end last, and renumbers them 1..n in the same write;
  a delete closes its gap. Cash refuses a place (409, "Cash stays
  first"). The place is never answered: the list's order is the order.
- **A broker is a name the owner keeps** (`brokers`), unique per owner
  and matched ignoring case, since a name is matched against that
  person's trades. A trade or position names one or none; an unknown name is
  refused with the known ones, so a typo never makes a broker. Brokers
  are added only by `POST /brokers` (the web UI) or `portfolio_setup`,
  renamed in place (`PATCH /brokers/{id}`, `portfolio_setup`'s `rename_broker`),
  and deleted only while no live row names them; removed rows that name
  one lose the name in the same write.
- **A trade** (`trades`): portfolio, instrument id, buy or sell, trade
  date, quantity, price, fees, the currency paid, broker, note, who
  entered it (`web`, `admin` or the agent key's name) and when. It
  keeps the instrument id it resolved to, so a later symbol change
  never moves it. Only instruments with a price a holding can be
  valued at take trades: units `per_share`, `per_unit` and
  `percent_of_par`, and a fund the owner prices; a FRED series or an
  index is refused.
- **A fund the owner prices is an instrument with trades** (migration
  `0026-fund-trades`), so each purchase keeps its date, units and
  price, and a sale reduces the average cost as a share's does. It is
  keyed `fund:<ISIN>` (`fundKey()`): every source's market is upper
  case, so the lower-case `fund` is never a listing's and a fund never
  collides with one. Its instrument row has source `owner`, unit
  `per_share`, type `FUND`, the fund's name and currency; `funds` holds
  the market its money is in (the market rule below), separate from
  the key, so exposure counts it there. The ISIN is
  checked by its check digit (`isIsin()`, ISO 6166's Luhn sum, letters
  read as two digits), upper-cased, so a typo never makes a fund. The
  first buy makes it, with its ISIN, name and currency, in the trade's
  own write, so a refused trade makes none; a later trade names it by
  ISIN, by key or by name (ignoring case; a second fund's name may not
  be another's); a name beside a kept ISIN that is not the fund's is
  refused, never ignored, so a confirmation of another fund is never
  booked on this one. Its first trade must be a buy. A trade on it has no
  live price, so a price or a total is needed, and its date defaults to
  the owner's today, since it trades on no exchange.
- **A fund's prices are dated rows** (`fund_prices`, one per fund and
  day): the price per unit the owner enters from the manager's
  statement, the bank app or a confirmation, with the day it is for.
  An entry for a day already priced replaces it (`setFundPrice()`),
  answered as `replaced`; earlier days are kept, so a value on a past
  date can be read later. A buy paid in the fund's currency also
  becomes its day's price while the owner has entered none for that
  day (`buyPrice()`), so a fund added from one confirmation is valued at
  once. The row names that buy (`fund_prices.trade`): the day's latest
  live buy stands, a later one's replacing an earlier one's, and a price
  the owner entered (`trade` null) is never changed by a trade. A buy
  removed takes its price with it, the day's latest live buy left
  standing in when there is one (`dropBuyPrice()`), and a restored buy
  stands again while no later buy or owner's price holds the day, so a
  mistaken buy never leaves its price behind.
  A buy in another currency sets none, its price not being the fund's.
  An import's buy does the same.
- **A fund's name and currency can be set right** (`update` with its
  `isin`, `PATCH /funds/{isin}`): the name to one no other fund has,
  the currency only while no live trade is on it, since every cost and
  price was paid in the old one; a new currency drops the fund's prices,
  which were in the old one. A rename answers `renamed_from`, so an
  agent that sent a name beside the ISIN sees it renamed the fund.
- **A fund's holdings are entered by hand, read as an ETF's**
  (`holdings` on `portfolio_fund` and `PATCH /funds/{isin}`,
  `src/portfolios/fund-holdings.ts`): its reports give them, no source
  does. They go in the tables Yahoo's ETF holdings use, keyed by the
  fund's instrument, so `research` `top_holdings` and the instrument
  detail answer them in the same shape, with `source` `owner`. `top`
  (up to ten rows, ranked by weight) and `assets` come together and
  replace the stored ones whole, as of `as_of`; `sectors` (Yahoo's
  sector keys) replace the stored sectors only when sent, as of their
  own day (`sectors_as_of`, migration `0039-fund-holdings-as-of`),
  since a monthly bulletin gives the top rows and split and only a
  half-year report the whole list sectors are worked out from. A part
  as of a later day is never replaced by an earlier one (`conflict`),
  so a report entered after a newer bulletin keeps the bulletin's rows.
  Weights are percents above 0 to 100, summing to at most 100 with half
  a point for rounding. A row's symbol is resolved as any symbol
  argument is (`resolveTargets()`: fetched when new, never marked read)
  and kept as the instrument's id, answered as `id` beside the
  listing's own `symbol`, as an ETF row's, so its row links to its
  page; a row without one gives its name. A part older than the stored
  one is refused before any symbol is looked up.
- **No source ever fetches a fund the owner prices.** It is never
  tracked (`trackedIds()` and `portfolioInstruments()` leave out source
  `owner`), and Yahoo's top holdings job asks only Yahoo's ETFs and
  mutual funds (`asked()`), so no job asks for it or overwrites its
  holdings. `history` (and `GET /instruments/{symbol}/bars`) answers its
  entered prices as daily closes, one per priced day, a week's last for
  `1wk`, and no 5-minute closes; `research` `top_holdings` and `GET
  /instruments/{symbol}` answer what was entered
  (`src/operations/funds.ts`). Each answers only a person who holds or
  priced it, through a key that opens portfolios (`seenFund()`); anyone
  else gets the same `not_found` as for a fund that is not there.
  `quote` and every other read refuse its key without asking a source
  (`OWNER_PRICED` in `src/operations/targets.ts`), the same answer held
  or not; the admin instrument list, its count and `search` leave it
  out, since its existence says the owner holds it.
- **A removal is a stamp** (`removed_at`, `removed_by`), never a
  delete: a mistake is seen and restored. An instrument any trade or
  position names, removed ones included, refuses its admin delete
  (409), so a restore never finds it gone.
- **Positions** (`positions`) hold what has no trades: `cash` (an
  amount) and `bond` (face amount, coupon, maturity, and its listing
  when the server has one). Each has its currency and `as_of` date. A
  fund was a position (units, one hand price, total cost) until
  migration `0026-fund-trades`, which drops fund positions and the
  kind, moving nothing: the owner adds each fund again as its buys.
- **A fund may name a market** (`funds.market`), so a fund holding one
  market's shares counts in that market in the exposure and its row
  answers it; none is assumed. The name must be a market a fund's money
  can be in (`knownMarkets()`, `markets` in `list` and `GET
  /portfolios`): one where a stored share, ETF or bond is listed
  (`per_share`, `percent_of_par`), or crypto, a fund's own key aside;
  never currency pairs (`CCY`), FRED series, or a market of only
  indexes or futures. It is matched ignoring case and stored as the
  instruments spell it; another is refused (`not_found`) with the known
  ones. A fund's later trade that names none keeps the fund's.
- **A position has no market.** Cash's money is already counted by its
  currency, and a bond's market is its listing's, so add and update of
  either refuse `market` with that reason, and a cash row answers none,
  counted in no market in the exposure. Migration `0031-cash-no-market`
  cleared the markets cash had named (`0025-position-market` had let it,
  beside a fund's); the column is no longer read or written.
- **A position's identity** (`samePosition()`): cash by name, broker
  and currency, so a snapshot read again updates it and one bank keeps
  a row per currency; a bond by its listing or name, purchase date,
  face and broker, since one name often covers several bonds and
  purchases. The name matches when either row has no listing, so a
  listing that resolves on a later import still finds the row saved
  unresolved; a bond imported with no purchase date matches a kept one
  of any date, so a file read again on another day adds nothing.
  Several purchases of one listed bond are one holding in the answer,
  their faces, values and costs summed, each purchase a part with its
  `position`, `as_of` and `amount` (its face); that row has no
  `position`, as each purchase is edited or removed alone (the web UI
  lists them).
- **Dry powder is cash ready to invest** (`dry_powder`, cash only), at
  a broker for buying; **reserve is the rest of cash**, kept apart from
  the markets (bank money, one row per bank and currency, its products
  in the note). The owner or an agent told to sets each amount; a trade
  never moves it, since the server keeps no cash ledger.
- **An update is a new row** replacing the old (`replaces`), the old one
  removed by whoever updated it, so every change keeps who and when, and
  restoring an old row sets a wrong update back (restoring takes out of
  the way every other live row of its chain through `replaces`, up to
  the first row and down, whatever the updates changed, so a purchase is
  never live twice; cash also a live row of its name, broker and
  currency, while a bond keeps a live equal purchase, since two equal
  purchases are two bonds; so a restored bond can sit beside an equal
  purchase imported again after its removal, and the owner removes
  one).
  An update with no date that changes what cash is worth (amount,
  `by`) is dated the owner's today, as its figure is true now; a bond
  keeps its purchase date, and a note, dry powder, name, broker or cost
  alone keeps the date. A price is a fund's: a position refuses one.
  An update may rename a position (`name`) or move it to another broker
  (`broker`, null takes it off); one that would give a live cash row
  the name, broker and currency of another live cash row in its
  portfolio is refused (`conflict`) naming that row's id, since add
  treats the two as one. A position added with the identity of a kept
  one replaces it the same way. A position's history follows that chain
  (`chainOf()`), since an update may rename or move it, or change a
  bond's face or date.
- **The display currency** (`portfolio_settings`, one row per owner)
  is required: a portfolio is refused
  (409, "Set a display currency first.") until the owner sets one, and
  a save without a code is refused, so it changes but never clears.
  Its first save makes Cash.
  It and a currency a caller names for a conversion must be an ISO
  4217 code in circulation (`src/shared/currencies.ts`).
- **The owner's time zone** (`portfolio_settings.time_zone`, migration
  `0024-time-zone`) is an IANA zone the owner names, never assumed: the
  tool's `setup` and the web UI's first card ask for it (the card
  suggests the browser's zone, which the owner confirms), and the web
  UI's settings or `PUT /portfolio-settings` change it. An offset
  (`+02:00`) is refused, as it cannot follow a clock change; a zone is
  stored as Intl spells it. The owner's today (`ownerToday()`) is the
  date there, the UTC day until one is set: a position added, updated
  or imported with no date is dated on it, and the web UI's date fields
  start on it. A trade's default date stays the exchange's today.
- **Every currency a person or a file names is checked the same way**
  (`isCurrencyCode()`): a trade's currency paid, a position's, an
  update's, and an import's file-wide, paid and row currencies must be
  in circulation, or one of the hundredths a listing is priced in
  (`HUNDREDTHS`: GBp, GBX, ZAc, ILA), which a trade keeps as written.
  A conversion target takes no hundredth.
  Nothing in code, docs or tests defaults to a currency. An install
  with portfolios from before answers per currency until one is set.
- **A person lets chosen people see all their portfolios, read only**
  (`portfolio_viewers`, migration `0038-sharing`; `src/api/sharing.ts`).
  One switch per person, the whole thing, Cash included, and nothing
  else of theirs: no profile, dashboard or rules, no single portfolio
  and no editing. Only the owner adds or ends it, in the web UI
  (`PUT`, `DELETE /api/v1/sharing/{id}`); removing either person ends
  it with their row.
- **A viewer reads the owner's portfolios as the owner does.** The six
  reads the Portfolios page draws from (`GET /portfolios`, `/holdings`,
  `/portfolios/{id}/holdings`, `/holdings/growth`,
  `/portfolios/{id}/growth`, `/trades`) take `owner=<person id>` and
  answer exactly what the owner reads, in the owner's display currency
  and time zone (`readOwner()`). Allowed for the caller's own id or one
  who shares with them; anyone else, a person not there and an ended
  share all answer 404, never 403, so an id never tells whether its
  person exists. Every write ignores `owner` and acts on the caller's
  own rows.
- **The share is the web UI's alone.** A key, the admin key too, is
  refused `owner` (403) even for its own person, and the sharing routes,
  so an agent reads only its person's portfolios and the `portfolio`
  tool never changes. To let another person's agent read theirs, an
  owner makes a key with portfolio `read` (profile and rules `none`) on
  Connect agents and hands it over; revoking it ends that.

## The arithmetic

- **Average cost is the weighted cost of buys, reduced pro rata by
  sells**, per portfolio and broker (`partsOf()`): a buy adds its
  quantity and `quantity × price + fees`; a sell takes its share of the
  part's quantity and cost; a sell's fees and proceeds are not kept, as
  realised gains and tax are not. A holding is one row per instrument,
  its parts per portfolio and broker beside it.
- **A trade before a split counts in today's shares**: its quantity
  times every split ratio after the day it is stated as of, its price
  divided by it (`splitFactor()`, `statedOf()`, the `splits` table). A
  trade typed in is stated on its own date (`stated_on` null), so every
  split since applies; one imported from an export is stated on the
  export's `as of` tag, else the import's day (`stated_on`, migration
  `0021-stated-on`), since an
  export already restates old lots in post-split terms and counting the
  split again would multiply them. A trade on the split's date is
  already in the new shares. A trade answers `stated_on` and, when the
  figures differ, `split_adjusted`.
- **The day's change counts a trade on the quote's day from its own
  price** (`dayChangeOf()`): what is held now at the live price, less
  what was held at the open at the previous close, less what that day's
  buys cost, plus what its sells brought. A buy at the live price shows
  no move it never had. A buy at price 0 (a staking reward, an airdrop)
  counts as held at the open: it brings no money that day, so only the
  price moves it. The quote's day is the listing's local date of the
  quote's time.
- **A holding sold out on the quote's day stays** as a row at nothing,
  `sold_today` true, until the quote moves to the next day, so the
  sale's move stays in the day's total; it adds no weight to the
  exposure.
- **A bond priced in percent of par** values at `quantity × price ×
  0.01`, the quantity being its face amount, and its average cost is
  in percent too.
- **A part is judged by replaying all its trades** (`addsOversell()`):
  an add, a removal, a restore or an imported row is refused (409 for
  a removal or restore, `bad` in an import) only when it adds a sell
  past what the broker part holds at any date, so a back-dated sell, a
  removed buy or a restored sell never stores one, and a part that an
  old entry oversold never blocks later valid sells. A refused removal
  or restore names the sale to remove first, its id and date
  (`newlyOversold()`, "remove sale 12 (2026-04-17) first"), since an
  agent clearing a portfolio oldest first otherwise retries each buy.
- **A part is empty within a billionth of what it held**
  (`sellStep()`), one rule for the holdings, a sell of all and an
  import's check, so a sell of all never sells float noise the holdings
  call nothing.
- **A part sold to nothing starts clean**: its cost, paid amounts and
  missing-rate reasons reset, so a lot whose rate was unknown never
  poisons a later buy. An oversold holding that ends at nothing stays
  in the answer at quantity 0 with "sells more than bought" in `stale`.
- **What is given is stored as given**: an update's amount, a live
  price taken for a trade and a price derived from a total are never
  rounded before storage, so quantity × price gives a total back (100
  over 3 shares costs 100). The arithmetic sums unrounded values, and
  the holdings answer rounds money (value, cost, P/L, day change,
  totals, cash, dry powder, exposure) once, from the exact value
  straight to its currency's minor units (`minorUnits()`: Intl's digits
  for an ISO 4217 code, 0 for JPY, 3 for KWD; 8 for a code ISO lacks, a
  coin), so 0.024999999 USD answers 0.02, never 0.03 by way of 0.025.
  Prices, quantities and rates keep their digits (`exact()`: float
  noise off at 15 significant digits), average cost 8 decimals from a
  cent up (`money()`). A part's stored `amount` (cash's balance, a
  bond's face) is answered unrounded, so an edit starts from it. The web
  UI shows amounts in the same minor units and a percent-of-par price
  (`unit` on trades and holdings) as a percent of face.
- **Values are in the instrument's listing currency**: value is
  quantity × the stored quote, cost is in the same currency. A trade
  paid in another currency converts its cost at the trade date's
  final daily close of the pair (the last final close on or before it;
  a day still trading is no day's rate), and the holding keeps what was
  paid in `paid`, pro rata as cost. A trade older than the pair's first
  close, or a pair the server cannot quote, leaves cost null with the
  reason in `stale` (`no EUR to USD close on or before <date>`), never
  a later close.
- **Totals are per currency, never summed across currencies**
  (`totals`): the known values summed with `missing` naming the rows
  with none (one unquoted holding never blanks the total), cost and
  P/L over the rows with a cost (null when none has one), the day's
  change, and the value split into invested, reserve and dry powder,
  each with its share. Weights and exposure (market, type, portfolio,
  broker) are within one currency: a holding's `currency_weight` is its
  share of the value in its own currency, never of the total, which is
  `converted.weight`. A total is rounded from the
  unrounded sum, so it can differ by a minor unit from the sum of the
  rounded rows shown.
- **Across portfolios reserve stays out** (`isReserve()`): a read with
  no portfolio (`/holdings`, the `portfolio` tool's `holdings` without one, with or
  without a broker) counts invested and dry powder only in its value,
  every weight (`currency_weight`, `converted.weight`, the split's
  shares, null for reserve), and the exposure, since money kept apart
  from the markets would swell every share of what is invested.
  Reserve rows are still listed, with no weight, so an agent sees the
  money behind `reserve`; each such total, converted too, answers
  `net_worth`, its value plus reserve, and `reserve_weight` null; its
  `missing` never names a reserve row, as the value leaves reserve out,
  and a reserve row with no rate makes the converted `reserve` and
  `net_worth` null, never a sum of the rows known.
  Inside
  one portfolio everything in it counts in its value, as a portfolio's
  own balance, and no `net_worth` is answered. The web UI shows no net
  worth (`docs/web.md`).
- **A named currency converts**: the caller's `currency`, else the
  display currency. Each row gets `converted` (value at the live rate,
  cost at each trade day's close, so P/L includes the currency's move;
  cash's cost is its value), the whole gets `converted` with the same
  split, `missing` names what had no rate or value, and exposure adds
  `currency_weights`.
- **`rates` answers the live rates a named currency was read at**, each
  with its pair and time, or its reason. **`cost_rates` answers the
  daily closes costs were converted at, one entry per pair**: `count`
  the distinct days converted, `first` and `last` the earliest and
  latest of them, which are trade days (a position's as of), not the
  closes' own dates, each read at the pair's last final close on or
  before it; and one more per pair for the days that had none, with the
  earliest day's reason; never one per day, which a long history would
  fill the answer with. The pairs read are marked
  read (`markRead()`), so they stay synced past 30 days.
  A pair neither way stored (`AAABBB=X` or `BBBAAA=X`) is resolved and
  fetched inside the call, once; one that fails stays null with its
  reason, never a guess. Hundredths (`GBp`, `ZAc`, `ILA`) convert by
  their factor.
- **A row's `as_of`** is the day cash's figure is true on, or the day
  a fund's latest price is for; a bond's is the day it was bought,
  never its price's date: a listed bond's price is its listing's quote,
  dated by `fetched_at`. The tool description and the spec's field
  notes say so, so an agent never reads a bond's `as_of` as its price's
  date.
- **A fund the owner prices is a holding from its trades** (`kind`
  `fund`, its `isin` on the row, `market` the one its money is in):
  quantity, average cost, cost, parts per broker and a cost converted
  at each trade day's close, as a share's, valued at its latest price
  (`latestPrice()`, the latest day's) with that day in `as_of`
  (`priced: hand`). A buy before the first price entered is valued by
  its own price until one is. It has no day change, and with no price
  at all (a buy in another currency only) its value is null with "no
  price entered" in `stale`.
- **Cash is worth its amount**; a bond its listing's percent of par,
  with the listing's day change on its face,
  when the listing has a quote (`priced: listing`), else its face
  (`priced: face`), said so.

## Growth

- **The holdings' growth per day over the past year**
  (`src/portfolios/growth.ts`, `/portfolios/{id}/growth`,
  `/holdings/growth`): per calendar day, what the holdings were worth
  less the money put in, so a buy never lifts the line. Cash, reserve
  and dry powder never count, in any view. The web UI's Portfolios
  page draws `gain` beside the value; no MCP tool answers it.
- **Stored rows only, never a fetch**: trades, splits, daily bars, fund
  prices and positions, each read in one query (bars from the window's
  start, a pair's from the oldest trade day), plus the holdings answer's
  own per-instrument reads for today's point, so the page never waits
  on a source. A holding or pair priced for part of the window counts 0
  on a day with no row on or before it and is named in `missing`.
- **A holding never priced is left out whole** (no daily close and no
  fund price stored at all): neither value nor money in, today's point
  too, and named in `missing`, so its cost never draws as a loss.
- **The window**: `to` is the owner's today; `from` the first day in
  the past year (from the same day a year before, 29 Feb taking 28 Feb)
  that anything but cash is held, so a holding sold out long ago and
  bought again starts on the rebuy. A stretch held nothing after
  `from` keeps its days. Fewer than two days held answers `points: []` with
  `from` equal to `to` (Cash, an empty portfolio, one bought today).
- **A day's value**: quantity held that day in today's shares (the
  splits applied as the holdings apply them, since stored closes are
  split-adjusted) times its last daily close on or before the day,
  converted at the pair's last final close on or before the day, either
  way listed, hundredths by their factor. A fund the owner prices is
  eased in a straight line between its stored prices (the owner's and
  its buys'), flat before the first and after the last, and named in
  `eased`. A bond counts from the `as_of` of the first row of its chain
  of updates, since an edit dates the row, not the buy; a listed bond
  with closes moves with them, today's live value scaled by each day's
  close over the last one, else it is worth its face.
- **Money in** is buys less sells at their amounts (a buy's `quantity ×
  price + fees`, a sell's `quantity × price − fees`), each at its own
  trade day's close, and a bond's cost (its face with none) on its
  first day.
- **Today's point is the holdings' live value**: the converted
  `invested` of the holdings answer for the same view and currency
  (less a holding left out as never priced), so the line ends where
  the holdings stand. Its money in counts every
  trade, a trade dated past the owner's today too.

## The tools

Six MCP tools, listed per key (`portfolioTools()` in
`src/tools/portfolio.ts`): a key with portfolio access `none` lists
none of them, `read` only `portfolio`, `write` all six. A key told it
may only read never sees a write it would be refused, and an agent
sees which tool changes what. Each tool maps its arguments onto the
operations the routes share (`portfolioAnswer()`, `addTrade()`,
`addFundTrade()`, `addPosition()`, `updatePosition()`, `updateFund()`,
`setTradeState()`, `setPositionState()`), so the REST bodies and the
web UI keep their own words (a fund's `units`, a sell's
`quantity: "all"`). Written as functions, `?` marks an optional
argument:

```ts
type Portfolio = string | number; // a name or an id
type Day = string; // YYYY-MM-DD
type Currency = string; // ISO 4217 (EUR), or a listing's own (GBp)

// portfolio: reads only, marked read-only
// the portfolios and brokers, the display currency and time zone, the
// markets a fund can name, and the funds the owner prices, each with its
// latest price and its day
list(): { portfolios; brokers; display_currency; time_zone; markets;
  funds };
// one row per instrument or position, its parts per broker; totals per
// currency, converted into `currency`, else the display currency; with
// no portfolio, reserve is out of the value and in net_worth; removed:
// true adds `removed`, the cash and bond rows removed and not replaced
holdings(portfolio?: Portfolio, broker?: string, currency?: Currency,
  removed?: boolean, next?: string):
  { holdings; totals; converted; exposure; rates; removed?; next };
// newest first; removed: true lists the removed ones too
trades(portfolio?: Portfolio, broker?: string, symbol?: string,
  from?: Day, to?: Day, removed?: boolean, next?: string): { trades; next };

// portfolio_trade: a share, ETF, crypto or fund; never Cash; portfolio
// is needed unless there is one besides Cash; neither price nor total
// takes the live price (a fund has none); a broker must be on the list;
// again: a second fill equal to one just saved. A fund is named by
// isin, its key as symbol (fund:<ISIN>) or name; its first buy makes it
// with isin, name and currency; market is a fund's only
add(symbol?: string, isin?: string, name?: string,
  side: "buy" | "sell", quantity?: number, all?: true,
  price?: number, total?: number, fees?: number, date?: Day,
  currency?: Currency, broker?: string, portfolio?: Portfolio,
  note?: string, market?: string | null, again?: boolean):
  { trade | trades; live_price?; total?; fund? };
// portfolio, named out of habit, is checked to be the trade's
remove(trade: number, portfolio?: Portfolio): { trade };
restore(trade: number, portfolio?: Portfolio): { trade };

// portfolio_cash: cash lives in Cash, so it takes no portfolio; cash is
// reserve unless dry_powder (ready to invest)
add(name: string, amount: number, currency: Currency, date?: Day,
  broker?: string, note?: string, dry_powder?: boolean): { position };
// amount set outright or moved by `by`, in `currency` or its own; at
// least one change; broker null takes it off, note null clears it
update(position: number, amount?: number, by?: number,
  currency?: Currency, date?: Day, note?: string | null,
  dry_powder?: boolean, name?: string, broker?: string | null):
  { position; replaced; rate? };
remove(position: number): { position };
restore(position: number): { position };

// portfolio_bond: a bond's currency is its listing's when a symbol
// names one, else needed; placed as a trade is
add(name: string, amount: number, symbol?: string, coupon?: number,
  maturity?: Day, currency?: Currency, cost?: number, date?: Day,
  broker?: string, portfolio?: Portfolio, note?: string): { position };
update(position: number, amount?: number, currency?: Currency,
  cost?: number, date?: Day, note?: string | null, name?: string,
  broker?: string | null): { position; replaced };
remove(position: number): { position };
restore(position: number): { position };

// portfolio_fund, no action: a fund's price per unit for a day (the
// owner's today by default), a day already priced replaced; market null
// takes it off; picked by isin or symbol, else by name; with a pick,
// name renames it; currency only while no live trade is priced in it;
// holdings from its reports, answered as research top_holdings
(isin?: string, symbol?: string, name?: string, price?: number,
  date?: Day, market?: string | null, currency?: Currency,
  holdings?: { as_of: Day; top?: { symbol?: string; name?: string;
    weight: number }[]; assets?: { stock?, bond?, cash?, other?,
    preferred?, convertible?: number }; sectors?: { [key]: number } }):
  { fund; price?; replaced?; renamed_from?; holdings? };

// portfolio_setup: a new owner's first steps, one or more at once: the
// currency totals are shown in (asked of the owner, never assumed; set
// only while none is; Cash is made with it), the time zone (IANA,
// America/New_York), a portfolio and brokers to make; a name already
// there is kept, `made` says what was
setup(display_currency?: Currency, time_zone?: string, portfolio?: string,
  broker?: string | string[]):
  { portfolios; brokers; display_currency; time_zone; made };
// a broker renamed, by its current name
rename_broker(broker: string, name: string): { broker };
```

- **One handle per row.** A holdings row's instrument is `symbol` in
  the tool's answer: what `quote` takes, or a fund's key, null for
  cash and a bond with no listing; trades answer `symbol` too. The
  REST holdings and the web UI keep it as `id`, since a script reading
  `id` would read a renamed field as null in silence. `position` is a
  cash or bond row's id, what `portfolio_cash` and `portfolio_bond`
  take, and a write answer's row names its id `position` too (REST
  keeps `id`); a trade's `id` is what `portfolio_trade` removes. A
  share, ETF, crypto or fund row has `position` null and changes
  through its trades, so removing all of a holding is removing its
  trades; a merged bond row has `position` null and each purchase's in
  `parts[].position`.
- **Typed arguments, each meaning one thing.** An id is an integer;
  `portfolio` (a name or an id) is the one union. A sell of all is
  `all: true`, a fund's units are `quantity` as a share's are, and a
  cash or bond row is picked by `position` only: `name`, `broker`,
  `currency` and `dry_powder` only change it. Numbers, ids and
  true/false sent as text still read as their values (`textValues()`,
  `docs/tools.md`).
- **Each action takes only its own arguments**, refused by name
  otherwise ("coupon is not an argument of update"); cash and a bond
  refuse `market` with its reason (`NO_POSITION_MARKET`), and a bond's
  update refuses its coupon, maturity and listing, which a remove and
  add change.
- **A position is checked against its tool before the write**
  (`positionFor()`): another kind's row is refused naming the right
  tool ("position 7 is a bond; portfolio_bond changes it"); an unknown
  one lists the live rows of the kind, at most `NAMED_ROWS` (10), then
  how many more ("no cash row at position 1; Cash holds 2 (Spare,
  North, EUR, dry powder), 3 (Savings, South, RON)", the name, broker,
  currency and dry powder, never an amount); one an update replaced
  names the live row of its chain (`chainOf()`), so a retry uses the
  live id ("position 1 was updated; it is position 4 now"), for an
  update and a remove alike; a removed one says a restore brings it
  back. A restore takes any row of the kind, as setting a wrong update
  back restores an old row.
- **Removed rows can be found**: `holdings` with `removed: true` adds
  `removed`, the `MAX_REMOVED` (20) latest cash and bond rows removed
  and not replaced by an update (no row's `replaces` names them),
  scoped to the portfolio and broker asked, each with its `position`,
  kind, portfolio, name, broker, currency and `removed_at`; unvalued,
  and never in a total or weight.
- **`portfolio_setup` is how an agent starts a new owner**: a portfolio
  is refused until the display currency is set, with a message telling
  the agent to ask the owner, and a broker is made only here, so a typo
  in an add is still refused with the list. It is one write, and a
  name already there is kept, so a retried call makes nothing twice. It
  sets the display currency and the time zone only while none is set:
  agents pass one out of habit, and the same one is a no-op while
  another is refused, so an agent never changes the owner's setting;
  the web UI's settings change them. `broker` is a name or a list of up
  to 20 (`MAX_SETUP_BROKERS`), so a new owner's brokers are made in one
  call. The server instructions route a new owner to it.
- **The descriptions** each open with what the tool changes and carry
  an example call, within 1,024 characters: `portfolio_trade` has a
  share buy and a fund's first buy, since a schema cannot require name
  and currency on the first buy only, and says `again` in full;
  `portfolio_cash` says dry powder is ready to invest and the rest
  reserve; `portfolio` names the write tools only to a key that lists
  them. A fund's trades come one per confirmation, so an agent never
  sums a manager's statement into one buy.
- **Annotations are per tool**: `portfolio` is read-only, so a client
  that runs reads without asking never asks for holdings; every write
  tool is destructive, so an add asks as a remove does.
- **A sell of a number with no broker, of a share held at brokers**, is
  refused with what each part holds ("held at North 10 and South 5:
  name a broker or sell all"), so the agent picks one instead of
  guessing; the caller has write access, so it reads those figures
  anyway.
- **A second removal keeps who removed it first.**
- **A retried add is refused** (`recentSameTrade()`): an add equal to a
  live trade entered in the last 10 minutes (`RETRY_MS`, by the row's
  `entered_at` against the clock) in its portfolio, instrument, side,
  date, quantity, price, fees, currency paid and broker is refused
  (`conflict`, 409 over REST) naming that trade's id, in the message and
  in `trade`, so a retry with the same figures after a timeout never
  doubles a lot. An add with no price or total takes the live quote, so
  a retry after the quote moved has other figures and is saved.
  `again: true` saves it, for two real fills that are the same.
  `portfolio_trade` and `POST /trades` share it; the import has its own
  duplicate check.
- **`rename_broker`** renames a broker by its name, as `PATCH
  /brokers/{id}` does, with the same refusals (an unknown name with the
  list, a taken one `conflict`).
- **A listed bond takes its listing's currency**: a position in another
  is refused, since its value would be relabelled, not converted.
- **Access is the key's** (`Who`): the router hands the MCP handler the
  caller as `authInfo` (`whoOf()`), the tools listed follow it, and
  each call is checked again (`forbidden` without read, and a write
  without write, `Who.portfolio`), since a client may hold a list from
  before its person changed the key; a tool the key no longer lists
  answers the SDK's tool not found. The admin key holds write.
- **holdings and trades page** by offset with a cursor bound to their
  arguments; totals, rates, exposure and `removed` ride on every page.
- **An add answers the stored row resolved to its instrument**, so the
  agent shows the owner what was saved. With no `price` and no `total`
  the live quote's price is used (converted when paid in another
  currency) and answered in `live_price` with its time. A `total` is
  what left or reached the account, fees in it: the price is derived
  (`(total − fees) / quantity` for a buy, `(total + fees) / quantity`
  for a sell) and `total.includes_fees` says so.
- **A trade's date defaults to the exchange's today and is refused
  only past today anywhere on earth** (`latestDay()`, UTC+14), since an
  owner east of the exchange dates a trade a day ahead of it. A
  position's date (add, update, import) defaults to the owner's today
  and is refused past the same day.
- **A sell of all** (`all: true`, REST's `quantity: "all"`) sells what
  each broker part can sell on its date: the least it holds from that
  day on, the later trades replayed (`sellableOn()`, the running total
  floored at zero as `partsOf()` floors it), so it never sells what a
  later sell sold; the amount is the unrounded sellable amount, never
  more, so the part reaches zero (rounding a large fractional holding
  to fewer digits left a remainder); only noise far below what a part
  counts as nothing (`0.1 + 0.2`) is trimmed, never up (`trimDown()`),
  and a part sold to within a billionth of what it held is nothing;
  at the broker named, else one sell per broker part, fees split by
  quantity, all answered in `trades`.
- **An amount with no currency takes its target's**: a trade's price
  or total the listing's, an update's `amount` or `by` the position's.
  A named currency converts at the live rate, answered in `rate`.
- **One line of the server instructions routes to it**: a question on
  what the owner holds or trades ("my stocks", "my ETF", "my
  portfolio") starts with `holdings`, whose symbols then go to `quote`,
  `history` and `research`, since agents asked about "my ETF" guessed
  symbols instead; it also says an amount's currency is never assumed,
  that all cash is in the Cash portfolio, and that across portfolios
  reserve counts only in net worth. For a key that writes it names the
  write tools and that with no portfolio yet `portfolio_setup` makes
  one; a key without portfolio access has no such line. The read
  tool's description opens with the same routing.

## Import and export

- **`POST /portfolios/{id}/import` previews unless `confirm` is
  true**, reading the file again on confirm, so the preview and the
  save never disagree. Each row is `ok`, `bad` with why, or `skipped`;
  a confirm saves the `ok` rows in one write and answers them
  `saved`. The kind comes from the header (`kindOf()`).
- **A trades file is a portfolio CSV export** (`Symbol`, `Trade Date`
  as `YYYYMMDD`, `Purchase Price`, `Quantity`, `Commission`, `Comment`,
  `Transaction Type`). A row with no trade (a watched symbol) and a
  `$$` cash row are skipped; a trade already saved (same instrument,
  side, date, quantity and price in today's shares, fees, currency paid
  and broker) is skipped, each kept trade absorbing one file row, so a
  file imported twice adds nothing while a third identical fill beside
  two kept ones is saved. The
  check and the oversell check run in the preview and again inside the
  save's write (`judge()`), so two saves at once never insert a file
  twice: one read of the portfolio, the file's trades merged into each
  part's history, each file sell replayed over what follows it (5,000
  rows over 5,000 stored in one part take about a tenth of a second). A
  file sell is judged as a typed one is: replayed with
  every stored trade and the file's buys, it is bad when it adds an
  oversell anywhere after it, its own or a later stored sell's, so a
  back-dated file sell never leaves a stored sell oversold. Symbols
  resolve as a read, fetched in the call.
- **The body allows for JSON escaping**: a file up to
  `MAX_CSV_BYTES` (448 KiB) in a body up to `MAX_IMPORT_BODY`, twice
  that and room, under Bun's 1 MiB.
- **`Comment` carries what the format has no column for** as leading
  tags, `[broker North][paid EUR 9.5][as of 2026-04-17]`, then a space and
  the note as written, its own spaces kept, since the cell is read
  untrimmed (`commentOf()`, `readComment()`). `as of` is the day an
  export of ours restated the trade's figures (the export's day in the
  listing's zone, or the trade's date when that is later, since a trade
  may be dated ahead of the listing's today); an import states the trade
  on it, so a split between export and import applies once, and a file
  without it (a broker's) is stated on the import's day; a tag before
  the trade's own date is bad, and a comment of only spaces is no note.
  `]` and `\` inside a tag are escaped with `\`, and a note starting
  with `[` or `\` gets a `\` first, so any note reads back as it was; a
  `\` before anything else is the note's own. An untagged comment is all
  note. A tagged broker must be a known one, else the row is bad; a
  broker for the whole file (`broker`) wins over it. The paid code is
  kept as written, so a hundredth (`GBp`) never becomes its unit. A
  price after the paid code is the price paid, read in place of
  `Purchase Price`, which then holds the listing's; one that is not a
  number makes the row bad. `[paid EUR]` alone keeps `Purchase Price`
  as the price paid. A file with CRLF or LF line ends, and a BOM, reads
  the same.
- **A fund's trades import as a share's**: a trades file names one by
  its key (`fund:<ISIN>`, as the export writes it), which finds the
  fund kept without asking a source; an unknown one is bad, since a
  file never makes a fund (it has no name or currency column). So an
  exported fund trade imports back only where that fund is already
  kept: into another portfolio of the same server, or after its first
  buy is added by hand elsewhere. A list
  of fund totals (a `Fund` column) is refused whole: it holds no
  purchase dates or ISINs.
- **Position files**: cash `Item, Amount (<currency>), As Of, Note` (or
  `currency` in the body when the header names none); bonds `Item,
  Symbol, Currency, Amount, Rate (%), Purchase Date, Maturity, Note` (a
  symbol that does not resolve warns and the bond is valued at face;
  one listed in another currency, or a fund's key, is bad). A cash file
  goes to Cash whatever portfolio the import is for, and the answer
  names Cash; a trades or bonds file for Cash is refused. A cash row
  is dry powder only when its line is in
  `dry_powder`, picked in the preview. Rows of one file never replace
  each other; a bond already kept (its identity above, each kept row
  matching one line, and a line saved in the same write matching none
  after it, so the preview and the save agree) is skipped, so a file
  read again adds nothing, unless the kept row has no listing and the
  line's symbol now resolves: then the line replaces it with the listing
  set (its purchase date kept when the line has none), so it is valued
  by the listing. Cash rows replace the kept ones of their name and
  broker. A cash `As Of` given as a month
  (`YYYY-MM`) is that month's last day, as a month-end bulletin states
  it, but never past today (`latestDay()`), so the current month reads
  as today; a later month or day is bad, as a typed position date after
  today is refused.
- **Numbers and dates are read strictly**: plain numbers with thousands
  commas only before a dot decimal; dates `YYYY-MM-DD`, `YYYYMMDD` or
  day-first `D.M.YYYY`. A slash date is refused, since day-first and
  month-first both write it.
- **`GET /portfolios/{id}/export` writes the same trades format**,
  oldest first, the market columns empty, the symbol as Yahoo writes
  it (else the stored id), numbers as plain decimals (`plain()`, never
  `1e-7`), quantity and price in today's shares as the export's own
  format states them and never rounded, so export then import gives the
  same trades back exactly; a fund's trades are written under its key,
  its prices not at all. Lines end with LF and there is no BOM, as
  Yahoo writes its own export. A trade paid in another currency writes
  `Purchase Price` in the listing's currency, at the close its cost
  converts at (the trade date's pair close, as the holdings cost), since
  a Yahoo reader takes that column as the listing's price, and keeps the
  price paid in its tag (`[paid EUR 9.5]`), so the import restores the
  currency and price paid exactly; with no such close the lot is written
  as paid, tagged `[paid EUR]`, as before. Commission stays in the
  currency paid. Positions are not exported.

## Owners

- **Every row is one person's** (`users.id`, migration `0036-owners`):
  `portfolios.owner`, `brokers.owner` and `portfolio_settings.owner`;
  trades and positions are owned through their portfolio. Every
  function in `src/portfolios/store.ts` and `src/operations/portfolio.ts`
  takes the owner, and every read filters by it, the whole-table ones
  too (`bondsOf()`, holdings, rates, history chains, removed rows, name
  lookups), so no default owner exists to fall back on.
- **The owner is the caller's** (`Who.user`, `docs/api.md`): a route
  reads it from its `who`, a tool from the request's `authInfo`. Today
  the admin key, the web UI's cookie and every key made so far are the
  operator's, so a single-person server reads as before.
- **Another person's row is no row**: a portfolio, trade, position or
  broker of theirs, by id or by name, answers 404 or "no portfolio" as
  an unknown one does, never 403, so an id never tells that it exists.
- **A fund and its prices are shared, its trades never.** `funds` and
  `fund_prices` have no owner: a person sees a fund in `list` and
  `GET /funds` while a trade of theirs names it or they priced it
  (`seesFund()`), and only such a person may update it; any other reads
  it as unknown. A buy naming its ISIN finds it whoever holds it, the
  ISIN being the fund; a name another person's fund holds is refused
  without naming that fund. Its detail lists only the caller's trades,
  and a price shows its `trade` and `entered_by` only to the person who
  entered it (`fund_prices.user_id`), null to others. A currency change
  still counts every holder's live trades (`liveTradesOf()`). A price a
  buy set outlives that buy's deletion (`fund_prices.trade` on delete
  set null), so removing one person never changes another's valuation.

## Privacy

- **Holdings are private.** No log line, error message or admin status
  holds a quantity, price, value, name or note: tool calls log the tool
  and status only, refusals say what failed without figures but the
  held quantities a sell without a broker is refused with, and the
  instrument list counts a held instrument as tracked without saying
  why, since a key without portfolio access reads it.
- **Tests and docs use made-up data only.**
