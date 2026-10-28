# The Bucharest feed

Governs the Bucharest Stock Exchange (BVB) source, read directly from
the exchange: `src/sources/bvb/client.ts` (calls), `parse.ts`
(parsing), `format.ts` (Romanian formats and HTML tables), `sync.ts`
(fetches), `history.ts` and `quotes.ts` (answers into rows), `jobs.ts`
(the schedule), `resolve.ts` (the exchange's search beside Yahoo's)
and `switch.ts` (moving the market between sources). The queue,
deadlines, retries, backfill, rescales, phrases and the lock every
source shares are in `docs/sources.md`; sessions in
`docs/calendars.md`; tables and staleness in `docs/storage.md`; the
tools in `docs/tools.md`. It is the pattern for a source of another
exchange: one client, its parsers, its session, the same tables.

## On and off

- **The feed is on only while the server starts with `--source bvb`**
  (`docs/config.md`). It needs no key. Off, `src/app.ts` builds no
  client and schedules no job, and the `BVB` market's shares come from
  Yahoo (`TLV.RO` as `BVB:TLV`).
- **One source per market for prices.** On, the `BVB` market takes
  its prices, bars and listings from the exchange; the key is the same
  whichever source serves it.
- **Indices and bonds exist only on the feed.** Yahoo carries no
  Bucharest index, so with the feed off `BVB:BET`, a bond, or a `BVB:`
  key Yahoo lacks answers `no_data` with `NO_DATA`, never an error.
- **AeRO, the junior market, is left out.** Its list needs an ASP.NET
  partial postback; a plain request answers the regulated market's. A
  share the regulated list lacks is `Refused` when fetched
  (`checkListed()`, `AERO`), since no quote pass could quote it, and
  the switch keeps it on Yahoo. A fund unit the fund units list lacks
  is refused the same way (`UNLISTED`).

## What it reads

| Call | Path | Gives |
| --- | --- | --- |
| `shares` | `bvb.ro/FinancialInstruments/Markets/Shares` | every regulated share: price, last trade time, the price currency in the header |
| `units` | `bvb.ro/FinancialInstruments/Markets/FundUnits` | fund units, exchange-traded funds among them, in the shares page's columns |
| `bonds` | `bvb.ro/FinancialInstruments/Markets/Bonds` | bonds: price in percent of par, last trade time, issue currency |
| `indices` | `bvb.ro/TradingAndStatistics/Trading/MarketsToday` | indices (`table#gvI`): value and exact change, no time |
| `detail` | `bvb.ro/FinancialInstruments/Details/FinancialInstrumentsDetails.aspx?s=` | the reference price (previous close), the last trade with seconds, day high and low, the page key |
| `schedule` | `bvb.ro/TradingAndStatistics/TradingSessionSchedule` | the regular market's continuous start and its close |
| `meta` | `wapi.bvb.ro/api/symbols?symbol=` | type, currency, the IANA zone, name |
| `history` | `wapi.bvb.ro/api/history?…&rs=1D&ajust=1&countback=N` | adjusted daily bars as column arrays |
| `search` | `POST bvb.ro/proxyshld.aspx/GetInstrumentsList` | up to 10 listings: symbol, ISIN, name, status |
| `types` | `wapi.bvb.ro/api/search?limit=30&query=` | up to 30 listings with their type (`Shares`, `Units`, `Structured`, ...), which the site's search lacks |

- **Every page carries the market status** (`#statusMarket`,
  `statusOf()`); `INCHISA` is closed, anything else open (`DESCHISA`
  while trading), none is a malformed page.
- **The chart feed wants the page key or the site's Referer.** Every
  feed call sends `Referer: https://bvb.ro/` and, once an instrument
  page was read, its `sk` key as `X-SK-API`. A 401 reads the
  instrument's page for a fresh key and asks once more, inside the
  same queued call, so the refresh never waits out a back-off; a
  second 401 is `key refused` and backs the queue off like any
  refusal.
- **`countback` is required and wins over `from`,** uncapped. It is
  set to the window's weekdays and a margin, and the feed answers bars
  outside the window too, so `parseHistory()` drops bars before `from`
  and after `to`. Daily bars are stamped 00:00 UTC of the trading
  date; any other stamp is malformed. An unknown symbol is
  `"s":"no_data"` (`not found`). Indices are asked with
  `currencyCode=-` and have no volume.
- **The feed's `session` field (`0700-1830`) is not the market's
  hours** and is never read.

## Parsing

- **Each page is read by its table id and its column labels**
  (`tableById()`, `column()`): `gv` with `Simbol`, `Pret (`, `Data`;
  the bonds' `Pret (%)` and `Moneda`; the schedule's `Tranzactionare
  Continua` and `Inchisa` on the `(REGS)` row. The index table's
  headers are blank, so its rows are read by position and must have
  five cells.
- **A page it cannot read is an error, never empty rows**
  (`malformed answer`): a missing table, column or status, an empty
  table, a short row, a number or time that does not match. The quote
  pass fails and the stored rows stay as they were.
- **A detail page must name the symbol asked for** (`detailQuote()`):
  another symbol's page is its price, never ours (`malformed answer`).
- **Romanian formats are read in one place** (`format.ts`): numbers
  with a thousands dot and a decimal comma (`34.678,23`), times
  `dd.mm.yyyy HH:mm[:ss]` as wall times. The site writes local time
  with no offset, so each becomes an instant through the instrument's
  zone (`fromWallTime()`). An empty cell is no value: a listing that
  has not traded.

## The queue

- **A limiter: one call at a time, starts `SPACING_MS` (2 seconds)
  apart,** the pace the recorders were taken at.
- **A page that does not read backs off whatever failed in it,**
  since a proxy or consent page is HTML too (`Unreadable`); a feed or
  search answer backs off only when it is not JSON.

## Instruments

- **The key is `BVB:<symbol>` uppercased; the source symbol is the
  exchange's own,** mixed case kept (`BETPlus`). The feed accepts a
  symbol in any case; resolution compares feed symbols case-blind
  (`readByFeedSymbol()`).
- **The type and unit come from the feed's symbol answer** (`KINDS`):
  `Shares` is `EQUITY` per share, `Units` is `ETF` per share, `Bonds`
  is `BOND` in percent of par, `index` is `INDEX` in index points. A
  fund unit trades on the regulated market as a share does, so it is
  quoted from its list and the instrument page and its bars come from
  the chart feed, as a share's; the list also holds fund units that are
  not exchange-traded funds, typed `ETF` too. Any other type is
  `Refused` (`ONLY`). An expired symbol is `not found`. The zone and
  currency are the answer's; an index has no currency.

## The session

- **The session is the trading schedule page's, on the day the page
  reads open** (`check()` in `jobs.ts`, `sessionOf()`): continuous
  trading's start to the close after the closing auction and trading
  at the last price, in the instrument's zone, since prices move until
  then. It is recorded through `recordSession()` and follows
  `docs/calendars.md` from there.
- **A closed status records no session, so no quote pass follows.**
  The market is checked again at the stored session's local start and
  hourly after (`nextCheck()`), as for Yahoo; with no stored session,
  at the last schedule read's local start, or hourly after a restart.
  No hours, holidays or UTC times are kept in code.

## Quotes

- **A quote pass reads only the list pages the tracked kinds need:**
  shares, fund units, bonds, indices, one call each per quote period
  while the market is quoted, and once after its close
  (`closeQuoteAt()`), since the share list is marked 15 minutes
  delayed. The period last passed is read from the runs on the first
  tick (`lastPassAt()`), so a restart never repeats a pass within it.
- **Every list page is read at least once an exchange day while the
  feed is on, tracked or not, and at start** (`readLists()`, `warm()`),
  so a new symbol need not wait on the exchange's search. The day is
  the stored session's or a stored listing's zone, or with neither 24
  hours; a quote pass's read counts, and a failed read waits
  `RETRY_MS`.
- **A quote's time is the time the exchange gives,** so a delayed
  price shows its age. The shares list is a snapshot 15 minutes behind
  and every row carries the snapshot's time, so a share's list quote
  is dated by the snapshot, not its own last trade. The list writes
  minutes and the instrument page seconds; a list row in the stored
  trade's minute is that trade.
- **The previous close is the instrument page's reference price,**
  never one worked back from the list's rounded change percent. The
  page is read once per listing and trading day: for the first trade
  of a day, its quote comes from the page; later list rows of that day
  keep its reference price (`listQuote()`).
- **The day range is the instrument page's, widened by each list price
  seen;** the lists carry no high, low or volume, so volume is null.
- **An index quote has no trade time,** stored null, never the fetch
  time. Its previous close is its value minus the page's exact change
  (`previous_close_field` `change`).
- **Bonds stay in percent of par,** as quoted.
- **The pass fails on a page it could not read, or when no listing it
  asked for is on its page;** one listing missing is stale on its own.

## Bars

- **Daily bars are adjusted (`ajust=1`),** so averages do not drop on a
  bonus issue; volumes stay as the feed gives them, raw. Weeks are
  built from them (`docs/calendars.md`).
- **The bar pass runs once a new session shows** (`barsDue()`); a
  failed instrument is its own run.
- **A stored final close that moved refetches the whole history**
  (`refetchAnswer()`, `MOVED` in `history.ts`): the feed announces no
  corporate action and rewrites past prices in place.
- **A rescale follows the shared rule** (`docs/sources.md`, Splits and
  rescales). Other moved days are corrections: refetched, no pause, no
  split. On a rescale, rules pause even before the action's first bar,
  and the action's day is kept in `splits` with its factor
  (`rescaleIn()`): the first day after the last stored day, final or
  not, on the old ratio; with no later bar yet, the stored session's
  day.
- **A whole history replaces every stored day** (`storeWhole()`) and is
  cut short (`checkCovers()`) when it ends more than
  `SHORT_HISTORY_DAYS` (10) days before the stored last day, or starts
  more than 10 days after both the asked start and the stored first
  day; one whose final closes moved must cover every stored day, first
  and last.
- **Volume ratios never span a split of a feed instrument**
  (`volumeBreaks()` in `src/signals/store.ts`), since raw volumes
  change scale there.
- **A bonus issue older than an instrument's first fetch is not
  detected:** its first history is already adjusted, so no stored close
  moves and no split is kept, and volume ratios may span it.
- **A rescale moving every stored day while the stored session is still
  today pauses rules but keeps no split,** having no day to date it by,
  so volume ratios may span that action too.

## Resolution

- **With the feed on, a bare symbol or name is resolved by both
  searches under Yahoo's rules** (`resolveBoth()`): a stored listing
  is it, one exact listing across both is it, several are
  `candidates`, none is a `ResolveError`. Only status `T` (tradable)
  counts. `BVB:TLV` and a `TLV` elsewhere stay apart: a bare `TLV`
  exact on both answers both as candidates.
- **Yahoo's exact match skips the exchange's search only when the
  exchange lacks the symbol:** the symbols on the list pages the client
  last read (`listed()`, kept by the jobs' reads) do not hold it and
  Yahoo's results name no Bucharest listing (`.RO`). The exchange is
  asked while any of the four lists is unread, or when the lists hold
  the symbol though Yahoo's top results lack its `.RO` listing, so a
  bare symbol on both answers both as candidates, never a guess.
- **On REST a bare symbol is Yahoo's** (`yahooFirst` on `Markets`,
  set by `routes()`; `docs/api.md`): a stored Yahoo listing is it,
  else Yahoo's exact listing, else the feed's rules above. A script's
  symbols come from Yahoo exports, so a bare `TLV` is `US:TLV` even
  with `BVB:TLV` stored, never `candidates`; `BVB:TLV` or `TLV.RO`
  names the Bucharest one. A Yahoo that fails is the call's error,
  never the feed's listing in its place. MCP keeps the rules above, since an agent
  learns the prefix from `candidates`. Delete and refetch, which ask
  no source, take the stored Yahoo listing first, else the feed's.
- **A `BVB:` key is the feed's while it is on,** asked by its symbol
  answer; a Yahoo symbol naming a Bucharest listing (`TLV.RO`) resolves
  to the same key and is fetched from the feed.
- **An instrument never seen is fetched inside the call**
  (`fetchInstrument()`): the symbol answer, for a share the shares
  list, a quote (the instrument page, or the index page), then ten
  years of bars, in one write while `live()` holds.

## Switching sources

- **A change of flags moves the market to the other source**
  (`sourceSwitch()`): each `BVB` instrument on the old source gets its
  whole history and a quote from the new one, under its lock, replacing
  its bars, signals and quote in one write. The new history is checked
  against the old source's stored days before any is cleared
  (`checkCovers()`); a listing whose new history is cut short keeps its
  old history and source, as one the new source lacks does, and the
  switch lands for the rest; a kept listing moves only at the next
  change of flags. Moving to Yahoo needs Yahoo's quote of the same
  listing, since the old source's quote is cleared with its bars, and
  finds the listing through Yahoo's search, never a guessed suffix;
  the stored splits are dropped and Yahoo's recorded from its answer.
  Moving to the feed keeps them, since they date where raw volumes
  change scale.
- **A listing the new source lacks stays where it is** (an index or
  bond on Yahoo answers `no_data`). With the feed off it is `source off`
  once the switch landed, so rules on it are unknown, never driven by
  its last quote; the switch's write re-evaluates the market's rules.
- **Only the switch moves an instrument between sources.** Work from
  the old source that began before it is refused under the lock
  (`checkSource()`, `docs/sources.md`), and an inline fetch of a key
  stored from Yahoo is refused, since flipping its source would keep
  Yahoo's bars under the feed's name.
- **The `sources` table is written only once the switch completed,**
  so a restart during one redoes it; a run left `running` or `failed`
  is redone too. Until it lands the market's instruments are
  `source switch pending`. A failed switch is retried after
  `RETRY_MS`; the same flags twice refetch nothing.
