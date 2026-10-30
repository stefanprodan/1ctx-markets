# Portfolios

Governs portfolios, brokers, trades and positions: the tables of
migration `0020-portfolios`, `src/portfolios/` (`store.ts` rows,
`value.ts` the holdings arithmetic, `fx.ts` rates, `csv.ts`),
`src/operations/portfolio.ts` (the `portfolio` tool and every read and
write the routes share), `src/operations/portfolio-import.ts` (CSV
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
  ignoring case, 1 to 40 characters. A portfolio with a live row cannot
  be deleted (409); one whose rows are all removed can, its removed rows
  deleted in the same write, so a test or mistaken portfolio can go.
- **A broker is a name the owner keeps** (`brokers`), matched ignoring
  case. A trade or position names one or none; an unknown name is
  refused with the known ones, so a typo never makes a broker. Brokers
  are added only by `POST /brokers` (the web UI), renamed in place,
  and deleted only while no live row names them; removed rows that name
  one lose the name in the same write.
- **A trade** (`trades`): portfolio, instrument id, buy or sell, trade
  date, quantity, price, fees, the currency paid, broker, note, who
  entered it (`web`, `admin` or the agent key's name) and when. It
  keeps the instrument id it resolved to, so a later symbol change
  never moves it. Only instruments with a price a holding can be
  valued at take trades: units `per_share`, `per_unit` and
  `percent_of_par`; a FRED series or an index is refused.
- **A removal is a stamp** (`removed_at`, `removed_by`), never a
  delete: a mistake is seen and restored. An instrument any trade or
  position names, removed ones included, refuses its admin delete
  (409), so a restore never finds it gone.
- **Positions** (`positions`) hold what has no listing or no free
  price: `cash` (an amount), `fund` (units and a hand price, with its
  date) and `bond` (face amount, coupon, maturity, and its listing when
  the server has one). Each has its currency and `as_of` date. The
  table keeps a fund as `manual`, the word migration `0020-portfolios`
  checks; the store reads and writes it as `fund` (`stored()`), since a
  table rebuild to rename it would copy every owner's positions.
- **A position's identity** (`samePosition()`): cash and a hand-priced
  holding by kind, name and broker, so a snapshot read again updates
  them; a bond by its listing or name, purchase date, face and broker,
  since one name often covers several bonds and purchases. The name
  matches when either row has no listing, so a listing that resolves on
  a later import still finds the row saved unresolved; a bond imported
  with no purchase date matches a kept one of any date, so a file read
  again on another day adds nothing. Several purchases of one listed
  bond are one holding in the answer, their faces, values and costs
  summed, each purchase a part with its `position`, `as_of` and `amount`
  (its face); that row has no `position`, as each purchase is edited or
  removed alone (the web UI lists them).
- **Dry powder is cash marked for buying** (`dry_powder`, cash only).
  The owner or an agent told to sets its amount; a trade never moves
  it, since the server keeps no cash ledger.
- **An update is a new row** replacing the old (`replaces`), the old one
  removed by whoever updated it, so every change keeps who and when, and
  restoring an old row sets a wrong update back (restoring takes out of
  the way every other live row of its chain through `replaces`, up to
  the first row and down, whatever the updates changed, so a purchase is
  never live twice; cash and a hand price also a live row of their name
  and broker, while a bond keeps a live equal purchase, since two equal
  purchases are two bonds; so a restored bond can sit beside an equal
  purchase imported again after its removal, and the owner removes one).
  A position added with the identity of a kept one replaces it the same
  way. A bond's history follows that chain, since an update may change
  its face or date; cash's and a hand price's is every row of their name
  at their broker.
- **The display currency** (`portfolio_settings`, one row per owner,
  `admin` until people sign in) is required: a portfolio is refused
  (409, "Set a display currency first.") until the owner sets one, and
  a save without a code is refused, so it changes but never clears.
  It and a currency a caller names for a conversion must be an ISO
  4217 code in circulation (`src/shared/currencies.ts`).
- **Every currency a person or a file names is checked the same way**
  (`isCurrencyCode()`): a trade's currency paid, a position's, an
  update's, and an import's file-wide, paid and row currencies must be
  in circulation, or one of the hundredths a listing is priced in
  (`HUNDREDTHS`: GBp, GBX, ZAc, ILA), which a trade keeps as written.
  A conversion target takes no hundredth.
  Nothing in code, docs or tests defaults to a currency. An install
  with portfolios from before answers per currency until one is set.

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
  no move it never had. The quote's day is the listing's local date of
  the quote's time.
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
  change, and the value split into invested, cash and dry powder, each
  with its share. Weights and exposure (market, type, portfolio,
  broker) are within one currency. A total is rounded from the
  unrounded sum, so it can differ by a minor unit from the sum of the
  rounded rows shown.
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
- **Cash is worth its amount; a hand price its units × price**, shown
  with its date (`priced: hand`); a bond its listing's percent of par,
  with the listing's day change on its face,
  when the listing has a quote (`priced: listing`), else its face
  (`priced: face`), said so.

## The tool

One MCP tool, `portfolio`, its action named in `action`. Written as
functions, `?` marks an optional argument:

```ts
type Portfolio = string | number; // a name or an id
type Day = string; // YYYY-MM-DD
type Currency = string; // ISO 4217 (EUR), or a listing's own (GBp)

// a new owner's first steps, one or more at once: the currency totals
// are shown in (asked of the owner, never assumed; set only while none
// is), a portfolio and a broker to make; a name already there is kept,
// `made` says what was
setup(display_currency?: Currency, portfolio?: string, broker?: string):
  { portfolios; brokers; display_currency; made };

// the portfolios and brokers, and the display currency
list(): { portfolios; brokers; display_currency };

// one row per instrument or position, its parts per broker; totals per
// currency, converted into `currency`, else the display currency
holdings(portfolio?: Portfolio, broker?: string, currency?: Currency,
  next?: string): { holdings; totals; converted; exposure; rates; next };

// newest first; removed: true lists the removed ones too
trades(portfolio?: Portfolio, broker?: string, symbol?: string,
  from?: Day, to?: Day, removed?: boolean, next?: string): { trades; next };

// a trade (kind defaults to trade); portfolio is needed unless there is
// one; neither price nor total takes the live price; a broker must be
// on the list
add(kind: "trade", portfolio?: Portfolio, symbol: string,
  side: "buy" | "sell", quantity: number | "all", price?: number,
  total?: number, fees?: number, date?: Day, currency?: Currency,
  broker?: string, note?: string): { trade | trades; live_price?; total? };

// a position with no trades: cash, a fund priced by hand, a bond
add(kind: "cash", portfolio?: Portfolio, name: string, amount: number,
  currency: Currency, date?: Day, broker?: string, note?: string,
  dry_powder?: boolean): { position };
add(kind: "fund", portfolio?: Portfolio, name: string, units: number,
  price: number, currency: Currency, cost?: number, date?: Day,
  broker?: string, note?: string): { position };
// a bond's currency is its listing's when a symbol names one, else needed
add(kind: "bond", portfolio?: Portfolio, name: string, amount: number,
  symbol?: string, coupon?: number, maturity?: Day, currency?: Currency,
  cost?: number, date?: Day, broker?: string, note?: string): { position };

// a position changed: amount set outright or moved by `by`, in
// `currency` or its own; at least one change
update(position: number | "dry_powder", amount?: number, by?: number,
  currency?: Currency, units?: number, price?: number, cost?: number,
  date?: Day, note?: string, dry_powder?: boolean,
  portfolio?: Portfolio): { position; rate? };

// one of trade or position, by id
remove(trade?: number, position?: number, portfolio?: Portfolio);
restore(trade?: number, position?: number, portfolio?: Portfolio);
```

- **`setup` is how an agent starts a new owner**: a portfolio is
  refused until the display currency is set, with a message telling the
  agent to ask the owner, and a broker is made only here, so a typo in
  `add` is still refused with the list. It is one write, and a name
  already there is kept, so a retried call makes nothing twice. It sets
  the display currency only while none is set: agents pass one out of
  habit, and the same one is a no-op while another
  is refused, so an agent never changes the owner's setting; the web
  UI's settings change it. The
  server instructions route a new owner to it.
- **Actions `setup`, `list`, `holdings`, `trades`, `add`, `update`, `remove`
  and `restore`**, each taking only its own arguments (`ARGS`); `add`'s
  arguments are its kind's (`KIND_ARGS`). The description is within a
  few characters of 1,024; a word more needs another cut. `remove`,
  `restore` and `update` take an optional `portfolio`, since agents name
  one out of habit: ignored when it is the row's, refused with the
  row's portfolio named when not.
- **A sell of a number with no broker, of a share held at brokers**, is
  refused with what each part holds ("held at North 10 and South 5:
  name a broker or sell all"), so the agent picks one instead of
  guessing; the caller has write access, so it reads those figures
  anyway.
- **A second removal keeps who removed it first.**
- **A listed bond takes its listing's currency**: a position in another
  is refused, since its value would be relabelled, not converted.
- **Access is the key's** (`Who`): the router hands the MCP handler the
  caller as `authInfo` (`whoOf()`), and the tool refuses `forbidden`
  without read, and a write without write (`Who.portfolio`). The admin
  key holds write.
- **holdings and trades page** by offset with a cursor bound to their
  arguments; totals, rates and exposure ride on every page.
- **add answers the stored row resolved to its instrument**, so the
  agent shows the owner what was saved. With no `price` and no `total`
  the live quote's price is used (converted when paid in another
  currency) and answered in `live_price` with its time. A `total` is
  what left or reached the account, fees in it: the price is derived
  (`(total − fees) / quantity` for a buy, `(total + fees) / quantity`
  for a sell) and `total.includes_fees` says so.
- **A trade's date defaults to the exchange's today and is refused
  only past today anywhere on earth** (`latestDay()`, UTC+14), since an
  owner east of the exchange dates a trade a day ahead of it. A
  position's date (add, update, import) is refused past the same day.
- **A sell's `quantity: "all"`** sells what each broker part can sell
  on its date: the least it holds from that day on, the later trades
  replayed (`sellableOn()`, the running total floored at zero as
  `partsOf()` floors it), so it never sells what a later sell sold; the
  amount is the unrounded sellable amount, never more, so the part
  reaches zero (rounding a large fractional holding to fewer digits left
  a remainder); only noise far below what a part counts as nothing
  (`0.1 + 0.2`) is trimmed, never up (`trimDown()`), and a part sold to
  within a billionth of what it held is nothing;
  at the broker named, else one sell per broker part, fees split by
  quantity, all answered in `trades`.
- **An amount with no currency takes its target's**: a trade's price
  or total the listing's, an update's `amount` or `by` the position's.
  A named currency converts at the live rate, answered in `rate`.
- **update's `position` is an id or `dry_powder`**: the portfolio's one
  dry powder position, picked by the currency named when there are
  several; still ambiguous, it is refused with each one's id, name,
  currency and portfolio, never their amounts, so the agent asks.
- **One line of the server instructions routes to it**: a question on
  what the owner holds ("my stocks", "my ETF", "my portfolio", a
  portfolio they name) starts with `holdings`, whose symbols then go to
  `quote`, `history` and `research`, since agents asked about "my ETF"
  guessed symbols instead; it also says an amount's currency is never
  assumed. The tool description opens with the same routing.

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
  tags, `[broker North][paid EUR][as of 2026-04-17]`, then a space and
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
  kept as written, so a hundredth (`GBp`) never becomes its unit.
- **Position files**: cash `Item, Amount (<currency>), As Of, Note` (or
  `currency` in the body when the header names none); funds `Fund,
  Currency, Units, Value, Cost Basis, As Of, Note` (price = value /
  units, units 1 when blank); bonds `Item, Symbol, Currency, Amount,
  Rate (%), Purchase Date, Maturity, Note` (a symbol that does not
  resolve warns and the bond is valued at face; one listed in another
  currency is bad). A cash row is dry powder only when its line is in
  `dry_powder`, picked in the preview. Rows of one file never replace
  each other; a bond already kept (its identity above, each kept row
  matching one line, and a line saved in the same write matching none
  after it, so the preview and the save agree) is skipped, so a file
  read again adds nothing, unless the kept row has no listing and the
  line's symbol now resolves: then the line replaces it with the listing
  set (its purchase date kept when the line has none), so it is valued
  by the listing. Cash and hand-priced rows replace the kept ones of
  their name and broker. A cash or fund `As Of` given as a month
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
  same trades back exactly. Positions are
  not exported.

## Privacy

- **Holdings are private.** No log line, error message or admin status
  holds a quantity, price, value, name or note: tool calls log the tool
  and status only, refusals say what failed without figures but the
  held quantities a sell without a broker is refused with, and the
  instrument list counts a held instrument as tracked without saying
  why, since a key without portfolio access reads it.
- **Tests and docs use made-up data only.**
