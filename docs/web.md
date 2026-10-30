# Web UI

Governs the operator's web UI: the client under `src/web/`, its
sign-in (`src/server/session.ts`), the paths that serve it (`UI_PATHS`
and `serve()` in `src/server/http.ts`) and `--no-ui`. The admin key is
in `docs/admin.md`, the routes the UI reads in `docs/api.md`, flags in
`docs/config.md`.

## Why

Status, refetch and delete were reachable only through `curl` with the
admin key or `1ctx-markets admin` over ssh. The UI shows the operator
what the server holds from a browser, on the server's own public host,
signed in with the admin key alone.

## Serving

- **The binary serves the page.** `main.ts` imports
  `src/web/index.html`, which Bun bundles with its script, styles,
  fonts and icon into the binary; nothing is loaded from another host.
  `serve()` answers each of `UI_PATHS` with the page and Bun answers
  the assets at the hashed paths the page names. Every other path is
  the router's, so an unknown one keeps the keys' 401.
- **`development: false`**, so a run from source serves the bundle the
  binary does, never Bun's dev server and its reload script.
  `MARKETS_PAGE_DEV=1` (a local preview's, never set where the binary
  runs) serves `{ hmr: false }` instead: Bun rebuilds the bundle after
  an edit, with no reload script, so a UI change needs a browser
  reload, not a server restart.
- **The UI installs to a phone's Home Screen.** `manifest.webmanifest`
  and its icons sit beside `index.html`, drawn as 1ctx's tiles with
  the Markets mark. The bundler hashes what the page links but not the
  URLs inside the manifest, so the manifest names its icons by fixed
  paths that `main.ts` embeds and `serve()` answers beside the page
  (`files`), public as the page is and off with `--no-ui`. The iOS
  status bar style is `default`, so an installed app paints its bar in
  the `theme-color` that `app/theme.ts` keeps in the page colour.
- **`UI_PATHS` and the client's `ROUTES` name the same paths**; `test/web.test.tsx` holds them equal. A new page adds its
  path to both.
- **`--no-ui` turns the UI off**: no page, no `/ui/session` (it answers
  the keys' 401 as any unknown path), and a cookie opens nothing.
  The UI is on by default.

## Sign-in

- **`POST /ui/session` with `{"key": "<admin key>"}`** compares the
  trimmed key in constant time (both sides hashed, `timingSafeEqual`)
  and answers 204 with the cookie. `DELETE /ui/session` answers 204
  and clears it; any other method is 405 with `Allow`.
- **Every failed sign-in answers the same 401**,
  `{"error":"unauthorized","message":"wrong admin key"}`, with no
  cookie: a wrong or empty key, a malformed body, a body over the
  route's 8 KiB cap, a body that is not JSON, and a server with no
  admin key (`sessions(null)`). The page faces the internet, so no
  answer tells one failure from another. A body over the server's
  1 MiB limit gets Bun's empty 413 before any route runs.
- **No rate limit:** the admin key is 32 random bytes, so guessing it
  is no threat, and a limiter would be state for nothing.
- **The cookie holds no key.** `markets_session=v1.<expiry>.<mac>`:
  the expiry in epoch milliseconds and its HMAC-SHA256 under a key
  derived from the admin key (an HMAC of a fixed label), compared in
  constant time. No table and no migration; replacing `user-admin.key` and
  restarting refuses every cookie made before.
- **`HttpOnly; SameSite=Strict; Path=/`, 30 days (`SESSION_MS`), and
  `Secure` unless the sign-in's `Origin` is plain HTTP to a loopback
  host** (`cookieAttributes()`); no `Origin` is `Secure`. A browser
  keeps a `Secure` cookie over plain HTTP only on loopback. The
  browser's `Origin` decides, never `Host`, which a proxy may rewrite
  to loopback. Plain HTTP to a LAN or tailnet address cannot sign in:
  use loopback or TLS.
- **A proxy in front needs nothing special:** the cookie and the write
  check read what the browser sends, `Host` only as the fallback below,
  and no forwarded header.

## What the cookie opens

- **What the admin key opens but the rules writes**: every route
  under `/api/v1`, the admin scope's included (`docs/api.md`, "Keys
  and caching"), with `POST /api/v1/screen`, a read whose filters are
  a body, and refetch and delete held to the write check below. A key
  is tried first (`router()`); the cookie only when no key is valid.
- **Never `/mcp`, and never a rules write** (`POST /rules`, `PATCH`
  and `DELETE /rules/{id}`, marked `cookie: false`): rules stay the
  keys'.
- **A write by cookie must come from this server's own pages**, or it
  is 403 `forbidden` (`sameOrigin()`): `Sec-Fetch-Site` is
  `same-origin` when the browser sends it, which a proxy leaves alone;
  a browser without it is held to an `Origin` whose host is the
  request's `Host`, the scheme not compared since a TLS proxy hands
  the request on as `http`. A request with the admin key needs neither,
  as a script sends none.

## What an anonymous visitor sees

- **The page, its assets, the sign-in's 401, and the OpenAPI spec and
  its docs page, which describe the API of every install and nothing
  of this one**: no host path, key or key file name, no data directory, no
  version, no source or flag name, no instrument data, no config in
  `index.html`, no source map. The bundle holds view code only, with
  Bun's comments naming each module by its path in this repository, as
  1ctx's bundle does; every value is read after sign-in. `test/web-session.test.ts` reads each anonymous answer
  and fails on any of them.
- **No help text on the page.** Where the key lives and how the UI
  works are for this doc, never the page.

## The client

- **Preact and `@preact/signals`**, rendered once from `main.tsx`;
  `app/router.ts` keeps the path in a signal and opens same-origin
  links in place, the API's own pages excepted. In an installed app
  (`display-mode: standalone`) a page of the UI opens in place even
  from a link asking for a new tab, which would leave the app.
- **The tab's title is the page, then the brand** (`app/title.ts`):
  "Instruments · 1ctx Markets", an instrument by the symbol in its
  address ("AAPL · 1ctx Markets"), so it needs no answer, and "Sign in
  · 1ctx Markets" while signed out. Home is the brand alone.
- **Views never fetch.** `data/store.ts` owns every call and signal;
  `data/api.ts` makes the calls. Any 401 signs out (the shell gives way
  to the sign-in), and a later status load supersedes one in flight.
  The first status answer is also the check of the cookie.
- **A page's `load` in `app/routes.ts` runs on arrival**, the status
  page's on first arrival being that check. A sign-out clears the
  pages' data, so the next sign-in counts as an arrival.
- **A later load supersedes one in flight**, the same id included, so
  a refresh tick never lands over the reload after a refetch.
- **A sign-in or sign-out starts a session anew** (`session` in the
  store): an answer from before it never lands, and its 401 never signs
  the new one out. A delete makes a list in flight stale, and a refetch
  reloads its instrument only while that page is still open.
- **`useRefresh` sets its timer once** and calls the latest load, so a
  redraw (a crosshair moving) never pushes the refresh back.
- **1ctx's look, copied, not shared:** `style/tokens.css`,
  `style/base.css`, the fonts, the rail, strip and shell styles and
  the icons, trimmed to what these pages use. **The mark is 1ctx's
  chip and sparkle with a rising price line in place of the 1**
  (`Mark` in `lib/icons.tsx`, `favicon.svg` and the manifest's icons).
  The rail is 1ctx's logo with **Markets** beside it, the pages,
  **Recent** (the last five instruments opened, symbol and name), and
  the operator's menu (dark theme, sign out) at the foot; it folds to a
  strip on a wide window, which shows the mark, and is a drawer on a
  phone. The sign-in is the mark beside 1ctx's wordmark over
  **Markets**. The theme follows the system until flipped; a flip is
  kept in `localStorage`.
- **Copy is short:** sentence case, no "you", "please" or explanations.
  An error is the server's phrase as a sentence (`says()`, as 1ctx),
  so a wrong key reads "Wrong admin key.": a problem's `detail`, the
  sign-in's `message`. The store branches on the error's `code`, never
  its words.

## Pages

- **Home** (`/`, the landing page) is the admin's dashboard, from one
  `GET /api/v1/dashboard` (`docs/api.md`, The dashboard): named
  sections the admin creates and orders, each shown as cards or as a
  table, with a top card of three tabs above them. `Dashboard.tsx` is
  the view; the rankings, rows and layout edits are
  `Dashboard.model.ts`, which has no DOM and is tested.
- **Seeded from `--track` until the first save.** Before it, the
  server answers the flag's values grouped by kind in flag order, so
  a new server's Home is what the flag names; the first edit saves
  that layout with the edit, and from then on only its own saves, or
  deleting an instrument on it, change it. Removing everything leaves
  an empty dashboard, never the seed again. The flag still keeps its
  values tracked.
- **A first start waits for the seed.** While any `--track` value is
  still resolving (the answer's `track`), the page shows a loading
  panel (Getting prices, the count ready, a chip per value, green when
  ready and red when it failed) above the cards already there, re-reads
  every 3 seconds while visible, and offers no search, Edit or view
  switch: a save then would end the seed without the values still on
  their way. A value that failed is left out, as the seed leaves it.
- **A save sends the whole layout** with
  `PUT /api/v1/dashboard` (`saveLayout()` in the store): the page shows
  the edit before the answer, and edits made while a save is in flight
  go in one more save on the revision it answered, so none is sent on
  an old one. A refused save puts the last saved layout back and says
  why over the page ("Could not add ZZZZ." for a symbol that did not
  resolve); a 409 takes the stored dashboard another tab saved and says
  "Changed in another tab. Reloaded." A load asked before an edit, or
  answered with an older revision than the one held, never lands its
  layout over it. A sign-out drops a save in flight, so the next
  session's edits start a save of their own.
- **The top card has three tabs**, the last chosen kept per browser
  (`markets-dashboard-tab` in `localStorage`). Browser storage is a
  convenience: a browser that keeps nothing starts from the defaults.
- **Today's movers**: the four biggest gainers and losers among the
  favourites by the day's percent, each bar scaled to the biggest move,
  a company by its short name and a bond by its symbol.
- **Trend**: shares, ETFs and coins only. An arrow for the side of the
  50-day average, the price, then the distance to the 50-day, 200-day
  and 200-week averages from the server's `averages`, two decimals
  under 1%. Each header sorts, the 50-day deepest below first by
  default, and a second click flips it (kept as
  `markets-dashboard-trend-sort`). Eight rows, then "Show all N".
  "Crossed today" comes from the server's `crossed_today` and is
  counted on the tab's badge, which hides at none.
- **Earnings this week**: the favourite shares reporting today and the
  six days after it in the viewer's own calendar, from
  `GET /api/v1/earnings`, 100 shares a call (the route's cap) merged by
  date, with Today in amber. The badge is the count, grey at 0. A call
  that fails keeps the list shown before, an answer older than the
  newest asked never lands, and a share a save removes leaves the list
  at once, even from an answer asked before it. The route lists a share
  with no calendar (a non-US share, for one) under `unavailable` as a
  note; only a source that is off, or no share answered at all, makes
  the tab say "Earnings are not available." with no count, never that
  none report.
- **Search in the head** asks `GET /api/v1/symbols` twice per query
  (`searcher()` in `Dashboard.model.ts`): with `upstream=false` at
  once, so the stored matches draw without waiting on any source, and
  from two characters, after a 250 ms pause, the full search, whose
  further matches join under the stored ones (no duplicates). One
  character asks the database only. A newer query aborts both calls
  of the older (`AbortController`), so its answer never waits behind
  them; the spinner shows only while the full search is pending. An
  upstream match is marked New. A result opens its
  instrument page, which fetches it; Add picks a section from a list
  under the result and saves at once, and the save fetches a symbol
  never seen before its card lands. With no section yet, Add makes
  "Favourites". An add the server would refuse says why in the results
  ("This section is full.", "Your dashboard is full."), and Escape
  closes the section picker before the results. On a phone the head is
  a search icon that opens a full-screen search.
- **No favourites**: the tabs hide and a panel says "Build your
  dashboard" with example chips (`^GSPC`, `AAPL`, `VWCE.DE`,
  `BTC-USD`, `GC=F`) that fill the search. They are examples only:
  nothing is added, and the code names no default instrument or
  market.
- **A section** is its name, count and a cards or table switch. A card
  shows the price and the day's percent; a table row the name and
  symbol, the day line, the price, the day's percent with the change in
  its unit under it, and Open or Closed. Open or Closed is the server's
  `session`, from the source's own answers, never hours kept here.
- **Edit is a draft** (desktop only, the pencil in the head): it copies
  the layout and its revision (`editOf()`), hides search, and shows
  Cancel and Save. Rename (a name that cannot be saved goes back and
  says why beside the field, such as "Another section has this
  name."), move a section up or down, delete one, drag cards and rows
  within and between sections, remove one, switch a view and Add
  section all change the draft only. Save sends it in one save on the
  revision it was copied from, or nothing when it matches that copy
  (`saveOf()`): a save from another tab since, even one a minute
  refresh already shows, is a 409 that ends the edit and shows that
  save, never overwritten. Save and Cancel wait for the answer; any
  other failure keeps the draft and says why, to try again or Cancel.
  Cancel drops it. Outside Edit, Add from search and the view switch
  save at once. A phone has no editing: Edit, the view
  switch and Add hide, and a section keeps its view.
- **On a phone a list leads with the ticker**, the name under it small
  and dim, as phone market apps do: the cards, the table rows and
  search results (CSS by width; the Instruments list leads with it
  everywhere). The top panel's tabs (movers, Trend, Earnings) name a
  row by its ticker alone. A wider window leads with the name.
- **A card** is the name, symbol, Open or Closed, the stored price in
  its currency (a yield in percent), the day's change in percent, and a
  line; it links the instrument. A favourite added but not answered yet
  is the card's shape with bars where its figures will land. The page
  re-reads every minute while visible. A load is stale once the
  router's path changes, checked when its answer lands, and a save that
  lands after leaving starts no load, so leaving the page asks no line
  after it (an effect's cleanup runs too late).
- **The line is one bars call per card, in parallel**, by the item's
  `intraday`: `interval=5m` (the newest session, split at its
  `previous_close`, green above and red below as the 1D chart, the
  previous close a faint dashed line, across the whole session so a
  morning fills only the morning), else a month of daily bars coloured
  by its move from the first close. The bundle names no source, so the
  server says which items have 5-minute closes. A Yahoo listing with no
  points yet draws no line; a line that fails keeps the one drawn
  before.
- **The line is inline SVG**, not a chart: its strokes are CSS tokens,
  so it wears the theme from the first frame, and a redraw replaces it
  whole. The split is the line drawn twice, each copy clipped to its
  side of the previous close. The clip ids come from the section and
  the instrument id, escaped for XML (`clipOf`), so a move never hands
  a card another's.
- **Server status** (`/status`, last in the rail, after Home,
  Instruments, Portfolios and Connect agents): `GET /api/v1/status` drawn as tiles (instruments,
  the sources on and how many are paused, the jobs shown and how many
  fail, the database) and a card per source that is on, headed by its
  name and job count alone, never one that is off:
  most servers never turn a regional source on, and an off source has
  nothing to fix. A job is a two-line row (its label, then how many
  markets or instruments it covers and how many fail) with its last
  run's time, which never repeats the outcome; opened, it says what the
  job does, then its failing scopes with error and time, or that all
  are ok. Failing jobs come first. Missing closes (`owed`) never shows: it only marks a day for the bars job to ask again, so it cannot fail.
- **Readers are not technical.** A server phrase shows in plain words
  (`plain()`: "rate limited" reads "too many requests"), and a pause
  shows only as a count in the Sources tile, since the job that hit it
  shows the error.
- **Names come from the server** (`label`, `short`, `mark`, `about`):
  the bundle is public, so it names no source (`docs/admin.md`).
- **The source switch shows only when it failed,** as one line above
  the cards: it runs once per change of flags, not on a schedule.
- **Add a source** lists the keyed sources that are off, with what each
  adds, its key file and where to get a key; it is absent when none is
  off. The `--track` values are a grid of value and resolved id, from
  `GET /api/v1/watchlist`, loaded with the status so both land
  together.
- **Connect agents** (`/connect`, before Server status in the rail), as
  1ctx's: a Keys card from `GET /api/v1/keys` (each key's name, last
  use and expiry, with Revoke, which asks once beside Keep, and "N of
  5"), New key (a name, shaped as typed to the server's rule, and
  Expires: Never, 30, 90 or 365 days, and Portfolios: No access,
  Read, or Read and write, no access by default; a key's row says
  "Reads portfolios" or "Writes portfolios" only when it has any), then a Setup card with a tab per
  agent (Claude Code, Codex, OpenCode) and the line that adds this
  server as the MCP server `markets` at the page's origin plus `/mcp`.
  At the cap, New key goes and a line names the cap. A revoke that
  answers 404 drops the row.
- **Copy uses `copyText()` (`src/web/lib/clipboard.ts`)**, as 1ctx:
  the clipboard exists only on loopback or HTTPS, so on plain HTTP the
  button stays as it is and never says Copied.
- **A made key's token lives in the Connect agents view alone**: the
  store keeps the key's row, never its token. It shows once, with a
  copy button, the `export MARKETS_ACCESS_KEY=...` line and "Copy it
  now; it is not shown again.", and goes on Done or on leaving the
  page.
- **No setup line carries a token.** Each reads `MARKETS_ACCESS_KEY`
  (as 1ctx's read `ONECTX_ACCESS_KEY`): Claude Code's header in single
  quotes, so the shell never writes the key into its config, Codex's
  `bearer_token_env_var`, OpenCode's `{env:...}` with OAuth off.
- **Portfolios** (`/portfolios`, after Instruments in the rail) reads
  `GET /api/v1/portfolios`, the holdings (`/holdings` or
  `/portfolios/{id}/holdings`) and the trades with removed ones in one
  load (`data/portfolios.ts`), every minute while visible. The words
  and numbers are `Portfolios.model.ts`, which has no DOM and is
  tested (`test/web-portfolios.test.tsx`).
- **No currency is built in.** A card per currency with its value,
  gain, today's change and a bar of invested, cash and dry powder, each
  with its share; never a sum across currencies. The "Show in" picker
  lists only the currencies held and the display currency; picking one,
  or a display currency set in Settings, adds an "All in" card first
  with each rate and its time under it.
- **Filters:** All or one portfolio (tabs that scroll sideways), a
  broker, and the currency picker; a portfolio or broker gone elsewhere
  falls back to all.
- **Holdings** are rows that open: an instrument by its symbol with
  quantity × average cost under it, a position by its name (cash, "Dry
  powder", "Priced by hand" with its date, a bond with its coupon,
  maturity and "at face" when no listing prices it). Opened: price,
  cost, gain, what was paid in another currency, weight, and a table of
  the parts per broker; a position has Edit (amount, or units and
  price, and as of; saved as an update the server keeps) and Remove,
  which asks once. A bond bought several times is one row listing each
  purchase (date, face, broker) with its own Edit and Remove, since the
  merged row has no one position. Amounts show in their currency's
  minor units (`minorUnits()`: 0 for JPY, 3 for KWD), a bond's price as a
  percent of face, and an edit starts from the stored amount, never the
  value rounded for show. A row with a stale reason is tagged in a few plain
  words (`staleWords()`): "Sold more than bought", "No EUR rate", else
  "Not current"; what a converted total left out reads by symbol or as
  "No EUR to JPY rate" (`missingWords()`), never an id.
- **Exposure** is bars by market, kind, portfolio and broker within one
  currency (a picker when there are several), and by currency with a
  named one.
- **Trades** newest first, twenty then "Show all", each with its side,
  symbol, quantity × price and fees, date, portfolio, broker and who
  entered it ("Web", "Admin" or the key's name); Remove asks once, and
  the Removed switch shows removed ones with Restore.
- **Add** opens a form at the top, short enough for a phone: Trade,
  Cash, Fund or Bond; a trade is a symbol search (the head search's
  `searcher()`; each result names its exchange in the source's words, or
  its market, and a stored one's currency (`listingWords()`), since one
  fund lists on several exchanges under one symbol; a pick shows its
  symbol, keeps its exchange under it and sends its id, and typing over
  it drops the picked listing and its currency), Buy or Sell,
  Quantity and Price ("Live price" when left empty), Fees and Date
  (the viewer's today), Paid in (the listing's currency by default,
  read from the instrument when a symbol is picked, else one held or
  the display currency), Price and Fees labelled with it, Portfolio and
  Broker, two fields abreast even on a phone. The kind, side, portfolio
  and broker are remembered per browser (`markets-portfolio-add`). A
  refusal shows beside the buttons in plain words, its ids taken out
  (`plainError()` in `data/portfolios.ts`).
- **More** holds Import, Export trades (a link to the CSV of the
  portfolio picked, off on All) and Settings. Import picks a portfolio,
  a broker for the file or "From the file", and a CSV; the preview
  lists every line as Ready, Not read with why, or Skipped, a cash
  file's lines each with a Dry powder box; "Import N" saves the ready
  ones. Changing the portfolio or broker clears the file and its
  preview, so a preview read for another is never saved. Settings lists portfolios and brokers with rename, delete
  (asking once; refused while a live row is in it or names it, removed
  rows going with it) and add, and the display currency (three letters, empty
  for none). With no portfolio yet the page opens on Settings.
- **The bundle names no source:** the import kinds read Trades, Cash,
  Funds and Bonds.
- **Instruments:** every stored instrument from
  `GET /api/v1/instruments`, every page by `next_page_token`, in one
  card with a search over id and name, kept in the view so a refresh keeps it. Sorted by
  symbol, an index's `^` aside. A row is the symbol and name, then the
  kind in plain words (Stock, ETF, Index, Bond, Future, Crypto,
  Currency, Series) and the market, left out where it repeats the kind;
  "No longer updated" only when nothing tracks it. On the right, the
  stored price with its currency and the day's change. The list never
  quotes: a quote is a read and would keep every row tracked. From two
  characters the search also asks `/symbols` and lists the sources'
  matches no row holds under "Not stored yet", marked New; opening one
  fetches it. It is the page's only search, so the head has none.
- **An instrument** (`/instruments/<id>`, the id encoded) reads
  `GET /api/v1/instruments/{id}`, a read as any client's, so
  opening it keeps it tracked and an id never stored is fetched. The
  title is the symbol with the name beside it; a card holds the kind
  and market, the price and day's change, "Open" or "Closed" as the
  home table says it ("Open · previous close" at the open, until the
  first live price; a series: "Latest value" and its date) with when it
  was fetched, and the 1 week, 1 month, 3 months and year-to-date
  returns from the quote, never recomputed, then how far the price is
  above or below the quote's 200-week average (in points for a series
  in percent), the average's own value left out so the row stays one
  line. On a phone the returns are one line of four, named 1W, 1M, 3M
  and YTD as the chart's ranges, and the 200-week average moves to the
  Trend card, under the 200-day. A read that
  failed shows the stored price as "Stored price" with its age, no returns, and one notice that a new price could
  not be had; the server's phrase is for agents, not this page.
- **Cards under the chart say the quote's daily signals in plain words**
  (`stats()`), three abreast, stacked on a phone: the 52-week range (a
  bar with the price's dot, how far below the high and how many trading
  days ago, how far above the low), Today, or Last session until today's
  first price (the day's range, volume against its 20-day average, "so
  far" while today trades, the typical daily move and the average daily
  range), and Trend (the price beside the 50- and 200-day averages, the
  50 above or below the 200, the cross named only on its day, RSI 14 as
  neutral, overbought from 70 or oversold to 30, and momentum as the
  MACD histogram's sign, upward or downward, with a turn of its
  direction as the day's note, since a turn comes on either side). A
  yield's distances and range are in points, as the head's are. A row
  with no signal, and a card with no row or bar, is left out, so a young
  listing or a series shows less.
- **The page head is a containing block for fixed elements**: its blur
  (`backdrop-filter`) holds a fixed descendant inside it, so a sheet or
  popover fixed to the window turns the blur off while open, as the
  phone search does.
- **One More button holds the page's actions** in the head (1ctx's
  More), on a phone too. Refetch data runs at once and refetches every
  part a source holds for it (`POST /api/v1/instruments/{id}/refetch`
  with every part `choices()` lists); the button spins while it runs,
  then shows a green check for `SAID_MS` once it fetched; "Not
  available" shows in the page's notice as long. A failure names the
  part and its error in plain words in the page's notice; a 404
  `not_found` reads as no longer stored. Delete asks once inside the
  menu, what goes beside Keep; a rule reading it (409 `conflict` with
  `rules`) is refused in the page's notice. A delete returns to the
  list.
- **Pages with a parameter** (`/instruments/:id` in `ROUTES` and
  `UI_PATHS`) stay off the rail, which lights their parent.
- **The list re-reads every minute** (`REFRESH_MS`) while the tab is
  visible, and at once when it comes back; a load in flight answers a
  second ask, and a failed one keeps the rows and shows the error. An
  instrument's page re-reads the same way (`lib/refresh.ts`).
- **A deploy reloads an open tab.** Every answer carries
  `x-markets-build`, an id the server draws at each start (never the
  version, which an anonymous visitor never reads); the client keeps
  the first it sees and reloads the page once a later answer carries
  another (`buildWatch()`),
  so a tab never runs an old page against a new API. The minute's
  re-read finds it, or the read when a hidden tab comes back.

## The chart

- **A phone draws the chart as a phone chart app does.** What the
  chart offers and draws is one `Look` (`Chart.model.ts`), picked from
  the shell's phone check (`railDrawer`: narrow, or a phone on its
  side); the card's `chart-phone` class carries it to the stylesheet,
  which has no width rule of its own, so the drawing and the layout
  never disagree. A phone: the price alone, as a line, edge to edge on
  the page with no card, axis column or grid; the ranges in one row
  under the plot (1D 5D 1M 6M YTD 1Y 5Y Max, a kept 3M or 3Y drawn as
  6M or 5Y); no toolbar, so no candles, averages, volume pane or Log
  (a choice kept from a wider window is drawn as off, not lost); a
  legend of one row, the date, close and range's change, as 1D's; and
  the plot names its own levels (`levelsOf`, `placeMarks`): what the
  range's change is measured from (the previous close on 1D, dashed,
  and 5D; the first close otherwise, dotted) at the left, its high and
  low at the right, placed a frame after each fit so a redraw or resize
  moves them. A kept range a phone does not offer stays kept: the phone
  draws its neighbour.
- **TradingView Lightweight Charts 5.2.1** (`views/Chart.tsx`), run
  with the first chart (a dynamic import); the compiled binary does
  not split the page, so the library ships in its bundle either way. Its
  data comes from `GET /api/v1/instruments/{id}/bars`, a read; the bars
  are shaped in `Chart.model.ts`, which has no DOM and is tested.
- **Ranges** 1D, 5D, then 1M to Max (`RANGES`, 1D by default); 3Y
  and up read weekly bars (`intervalOf`), so the averages read
  "50-week" and "200-week". Max is the ten years the server keeps.
- **1D and 5D read `bars?interval=5m`**: the newest stored session,
  or all five kept (asked from Max's start). A line of closes on a time
  axis at the points' real UTC times (`pointLine`), so a clock change
  never reorders or drops one; only the labels (axis ticks, crosshair,
  legend) are in the viewer's local time (`localTime`, `timeLabel`),
  the crosshair's day label for daily bars kept as the library writes
  it. No candles, averages or volume, so their toggles hide. The
  legend gives the day and time, the price and the change from the
  answer's `previous_close`, else the first close. At rest the price
  is the newest, an after-hours one once there is one; a price outside
  the regular session is named Post or Pre, short as the C it stands
  in for, which is the regular session's alone.
- **1D is a baseline at the previous close**, green above and red
  below, with the previous close dashed and labelled, as a chart site
  draws a day; the scale keeps the previous close in view. 1D asks
  `extended=true`: pre and post trading are drawn faded, joined to the
  session's first and last close (`extendedLines`, which drops a bar
  sharing the closing trade's time), and the latest price label is the
  newest post bar's. 5D is one area in the colour of its move, with no
  reference line, as the daily ranges are.
- **A line is a filled area in the colour of its move**: green when the
  range ends at or above where it starts, red below.
- **Line or candles**, the toggle only where the bars have an open;
  a series (FRED) is a line. A bar the live quote made with no open
  takes the last close. **Volume** is its own pane (price 4 : volume
  1, by stretch, which a redraw keeps), by the bar's direction; none
  where the source gives none.
- **SMA 50 and 200 from `history`**, never recomputed, each a toggle,
  coloured `--chart-sma50` and `--chart-sma200`: tokens per theme,
  checked for colour blindness against `--card` with the dataviz
  validator. A toggle and a legend entry wear a stroke of the colour,
  so identity is never colour alone.
- **The legend is its own rows above the plot**, never over it, held
  at the tallest it has been since the averages shown or the bars' kind
  last changed (a guess before the first answer), so the plot never
  moves and a short legend leaves no gap; it names the range its bars were read for, not one
  still loading, and a failed read shows over the bars kept: date, Live while the market is
  open and the bar not final, O H L C, volume, the change from the
  range's first close (points for a series in percent), then the
  averages. It follows the crosshair; at rest the latest bar, whose
  averages fall back to the last there are (an open week has none).
- **Prices on the axis** have separators, and no cents from five
  figures up (`axisPrice`), so a phone's axis stays narrow; each pane's
  scale keeps headroom so its top label is whole.
- **On a phone the head's row is the floating menu button's height**,
  centred, so the button, title and actions share one middle.
- **The bar still trading is drawn faded**; the last price has its
  line. Log is a toggle (not on a phone, above). **The chart neither pans nor zooms**: the
  range buttons choose what shows, and every draw (a range change, the
  minute refresh, a toggle, a theme flip) and every resize fits it. **1D spans its whole
  session**, ending in empty 5-minute slots up to the close
  (`sessionSlots()`), as the home cards draw a day, so the first minutes
  are a short line at the left, not the whole width.
- **Colours are read from the tokens on every draw**, and a theme flip
  draws again. The page's colours (`paintOptions`) are set when the
  chart is made and on every draw, bars or none, and the canvas box
  wears `--card`: the library's default is white, so a dark page would
  flash white for the whole data call, or stay white on a range with no
  data.
- **Settings are kept in `localStorage`** (`chart`): the range, line,
  log and both averages, one set for every instrument; a blocked or
  broken value starts from the defaults, field by field: 1D, a line,
  both averages. 1D and 5D are kept like any range.
- **After hours beside the close**: the instrument route asks the quote
  with `extended`, so outside regular hours a listing with pre or post
  trading shows that price, its change from the close and its time
  (`afterHours`), "After hours" or "Pre-market".
- **The credits are the page's footer**: "Data by <source> · Charts
  by TradingView", each name linking its site. The source (Yahoo, BVB,
  FRED) and its site come from the server's `credit`, since the public
  bundle names no source; TradingView's link is what its licence
  accepts in place of the logo, which sat on the volume. The NOTICE text is
  in `Chart.tsx`, the package shipping none. The footer shows on the
  instrument page, and on Home with FRED's notice when the dashboard
  carries its `attribution`, with "1ctx Markets" (the repository) and
  the version on its left.

## Tests

- **No DOM and no network:** views render with
  `preact-render-to-string` from fixed answers, and the data layer
  takes a fake fetch (`test/web.test.tsx`).
- **The server side** (`test/web-session.test.ts`): the token, the
  cookie's attributes, the identical refusals, what the cookie opens,
  the `Origin` check, the page and its assets served, and what an
  anonymous visitor reads, the API spec and docs page included: no
  key file, flag, build version or source name, but FRED in symbol
  syntax. Swagger UI's own files are checked for secrets only, since
  its bundle names Yahoo among web domains and its stylesheet names a
  source map. `scripts/smoke.sh` checks the binary serves the page,
  its assets and the sign-in.
