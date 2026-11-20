# Tradegate

Governs Tradegate Exchange's live quote for a Xetra listing, read from
the page refresh its own website makes:
`src/sources/tradegate/client.ts` (the call, the parser and the fixed
hours), with the read in `src/operations/extended.ts`.

## Why it is read

- **Yahoo's Xetra feed has no pre or post trading, is 15 minutes late
  and stops at 17:30 Berlin.** Tradegate trades the same ETFs and
  shares on weekdays from 07:30 to 22:00 Berlin, and some brokers
  execute there, so a German-listed ETF's price before the Xetra open,
  after its close and live during it is Tradegate's. For a broker that
  executes elsewhere it is a close proxy for the Xetra price.
- **Its own close (22:00) already holds the US session**, so it
  differs from Xetra's and is answered apart, as `tradegate_close`.

## On, always

- **Tradegate is always on, as Yahoo and the CFTC are**: keyless, with
  no flag or file to turn it off. The start log and Status say
  `tradegate=on (always)`.
- **It is read only inside `quote` with `extended: true`** (and the
  instrument page, which asks for it), for a Xetra listing (market
  `XETRA`, priced by Yahoo) with an ISIN. No job, no background poll,
  no call while no one asks.
- **Nothing is stored.** Signals, movers, screen, rules, alerts,
  `history` and portfolio values stay on Xetra's regular prices.

## The ISIN

- **The page is keyed by ISIN, which no source of this server gives
  for a Xetra listing**, so an instrument may carry one in
  `instruments.isin` (nullable, upper case, its check digit checked as
  `isinArg()` checks a fund's). None is seeded: no default instruments
  ship.
- **It is set two ways**: `portfolio_trade` add with `isin` beside a
  listing's `symbol` keeps it on the listing (refused when another is
  stored), and its `set` action sets, replaces or (with null) takes it
  off; an admin sets it on the instrument page (More, Set ISIN), which
  calls `PATCH /api/v1/instruments/{symbol}` (`docs/admin.md`). Two
  listings of one fund share an ISIN, so it is not unique.
- **A fund the owner prices keeps its own ISIN key** (`fund:<ISIN>`)
  and takes none here.

## The call

- **`GET https://www.tradegatebsx.com/refresh.php?isin=<ISIN>`**,
  undocumented; `www.tradegate.de` redirects there. It answers without
  a User-Agent, as compact or indented JSON.
- **One limiter at `SPACING_MS` (250 ms)**, its own, so its back-off
  never touches Yahoo's. A 10-second timeout; the call's deadline
  bounds it first.
- **Held `HELD_MS` (15 seconds) per ISIN** in `m.tradegateQuotes`, and
  readers of one ISIN share a call in flight (`shared()`), so a page
  refresh and an agent cost one call. A failure is never kept.
- **A 429 is "rate limited", a 404 "not found"**; any other failing
  status is "source error", and a body that is not JSON `Unreadable`,
  which backs the queue off.

## Parsing

| Field | Meaning | Answered as |
|---|---|---|
| `last` | the last trade | `price` |
| `bid`, `ask` | the live quote | `bid`, `ask` |
| `high`, `low` | the day's range | `day_high`, `day_low` |
| `close` | the previous Tradegate close, at 22:00 | `tradegate_close` |
| `stueck` | shares traded today | `volume` |

- **Any number can be text, with a decimal comma or point**
  (`"low":"125,30"`, `"12.50"`): `tradegateNumber()` reads both. No
  thousands marks are sent; text holding one reads as null.
- **An empty body is an unknown ISIN** (it answers 200): "not found",
  which never backs the source off, answered as `not on Tradegate`.
- **No `last` above zero is a malformed answer**; a side at zero is no
  price (null). `delta`, `avg`, `umsatz`, `executions`, the sizes and
  `refresh` (sometimes missing) are not read.
- **There is no time, symbol, ISIN or currency** in the answer: the
  fetch time is the quote's `time`, prices are EUR as the Xetra
  listing's are. Outside its hours the last values stay.

## Sessions

- **Tradegate's hours are one fixed window, 07:30 to 22:00 in
  `Europe/Berlin`** (`OPENS_AT`, `CLOSES_AT`): it publishes no hours a
  server can read. Xetra's open, close and trading days come from
  Yahoo: the stored session while Xetra trades, else the regular
  windows of the chart the extended read already makes for `opens`,
  which names the day's session from 07:00 Berlin.
- **`tradegateSession()`**: `closed` outside 07:30 to 22:00 or on a
  day no Xetra window falls on (a weekend, a holiday), `pre` before the
  Xetra open, `regular` during it (to the end's last minute, as
  `isQuoted()`), `post` after the close. A day Tradegate trades and
  Xetra does not reads `closed`.
- **Answered in the regular session too**, unlike a US listing's,
  since Yahoo's Xetra price is late; and while `closed`, with the last
  values, as a US listing keeps the evening's move through the night.
  `opens` is the chart's next Xetra open while Xetra is closed, null
  while it trades.
- **`time` is the fetch time while Tradegate trades, and its last close
  while `closed`**: 22:00 Berlin of the newest Xetra day held at or
  before now (`lastTradegateClose()`), so a weekend reads Friday's;
  null when no such day is held.
- **`change` is from the Xetra close Yahoo's late quote has reached**,
  read by its trade date against today in Berlin: until it trades
  today (about 09:15, 15 minutes late) its price, the last close, in
  every session; once it has, its previous close before and during the
  session and its price, today's close, after it. Null when that close
  is not stored.
- **`session` and a closed `time` are read at the answer**, never at the
  held quote's fetch, so a quote held 15 seconds never says `pre` after
  the open or `post` after 22:00.
- **A Xetra listing not priced in EUR is not Tradegate's**: its prices
  are EUR, so such a listing answers `not on Tradegate` and asks
  nothing.

## Failures

A timeout, an error status, a body that is not JSON or empty, or one
with no usable `last` answers `extended: null` with an
`extended_reason`: `not fetched in time`, `fetch failed` or `not on
Tradegate`; a Xetra listing with no ISIN answers `no ISIN for
Tradegate`, with the chart's `opens` kept. The regular quote is
untouched.

- **A slow chart never holds up Tradegate's answer**: once Tradegate
  answers, the chart still in flight gets `CHART_WAIT_MS` (1 s) more,
  cut to what is left before the call's deadline less `RETURN_MS`
  (50 ms), then the read goes on without it and the chart lands in the
  cache for the next.
- **A Xetra listing with no ISIN always answers `no ISIN for
  Tradegate`**, whatever its chart did, keeping any `opens` it named.
- **Without a fresh chart the days come from what is held**: the
  stored session and the last chart's windows, kept past its period.
  Before the open these name today only when the stored session or an
  earlier chart already did; otherwise the pre-market reads `closed`.
