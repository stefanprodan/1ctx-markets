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
  address ("AAPL · 1ctx Markets"), so it needs no answer, a coin
  without its quote currency ("BTC", by a `CRYPTO:` id or once the
  answer names it a coin), and "Sign in · 1ctx Markets" while signed
  out. Home is the brand alone.
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
- **A wait never looks like a broken page, and there are two.** An
  answer travelling to the browser (data the server holds, read in
  milliseconds; a slow connection makes it seconds) shows the page's
  own shape: what has never been drawn waits behind placeholders the
  size of what will land, inside the parts it will fill (`Placeholder`),
  never a full-page spinner or one per card. Only after `SLOW_MS` (a
  second) still waiting do a few words show ("Loading prices",
  "Loading charts", "Loading the chart"; `slowFlag()` in
  `lib/slow.ts`, its timer passed into the store so tests drive it
  with the fake clock). The minute's refresh never puts a placeholder
  over what is drawn. A symbol the server fetches from its source for
  the first time (seconds, up to the call's deadline) says so at once:
  "Fetching TEL for the first time" with the spinner, in the chart's
  box. The page cannot tell the two apart from the read itself, which
  answers only once the fetch is done, so the instrument page asks
  `GET /api/v1/instruments/{symbol}/stored` (admin, from the database
  alone) beside the read whenever it has nothing drawn; the public
  routes stay as they are. The words never name a source, which the
  bundle does not know for a bare symbol. A read that failed is
  `Page`'s `failed`: a timeout reads "The source did not answer in
  time.", a source's failure a sentence by the problem's `code`
  (`unread()`; its `detail` is written for agents and names no source),
  and Try again reads, and so fetches, again.
- **The page imports outside `src/web/` only from `src/shared/`**,
  plain files that import nothing but each other, so no server-only
  code (a package, `bun:`, the database) reaches the browser bundle;
  `test/imports.test.ts` fails on any other import.
- **1ctx's look, copied, not shared:** `style/tokens.css`,
  `style/base.css`, the fonts, the rail, strip and shell styles and
  the icons, trimmed to what these pages use. **The mark is 1ctx's
  chip and sparkle with a rising price line in place of the 1**
  (`Mark` in `lib/icons.tsx`, `favicon.svg` and the manifest's icons).
  The rail is 1ctx's logo with **Markets** beside it, the pages,
  **Recent** (the last five instruments opened, each the ticker and
  its name on one line as `SymbolName` draws it, a coin without its
  quote currency), and
  the operator's menu (dark theme, sign out) at the foot; it folds to a
  strip on a wide window, which shows the mark, and is a drawer on a
  phone. Server status's icon, in the rail and the strip, turns red and
  pulses (steady under reduced motion) while that page shows a job failing
  or a source backing off (`troubled`), read once a minute while
  signed in. The sign-in is the mark beside 1ctx's wordmark over
  **Markets**. The theme follows the system until flipped; a flip is
  kept in `localStorage`.
- **Copy is short:** sentence case, no "you", "please" or explanations.
  An error is the server's phrase as a sentence (`says()`, as 1ctx),
  so a wrong key reads "Wrong admin key.": a problem's `detail`, the
  sign-in's `message`. The store branches on the error's `code`, never
  its words.

### Design

Every page is built from the shared parts in `src/web/ui/`, each a
component with its own CSS; a page's CSS holds only its layout. The
Portfolios page is the reference for each part.

- **Every value is a token** in `style/tokens.css`, with a light and a
  dark value: colours, sizes, radii, spaces, shadows and layers
  (`--z-*`). No hex, rgba, px font size, radius or z-index elsewhere,
  but a 1px line.
- **Colour has one meaning each:** `--up`/`--down` for a market move,
  `--done`/`--failed` for a job's state, the brand yellow for links,
  all else grey.
- **Two widths:** tablet `max-width: 1099px`, phone `max-width:
  719px`, plus `pointer: coarse` for 44px targets and reduced motion.
  `.hide-tablet`, `.hide-phone`, `.show-tablet`, `.show-phone` in
  `base.css` hide an element at or above them; a shown one keeps the
  display its owner gives it.
- **Page width 1200px, one head on every page** (`Page`): the title
  and its meta, the symbol search, then the page's actions, the ⋯ menu
  last. The head's buttons share one style, defined once in
  `ui/page.css`: an icon, an icon with words, the ⋯; 32px, 44px to a
  finger. The search shows by itself; `search={false}` leaves it out
  (a page mid-edit). On a phone it folds to an icon, the meta gives way
  first, and the head never wraps or scrolls sideways.
- **A card is only around a list, a table or a form.** Its title is
  the sans `Card` title, never a mono uppercase word; the mono label is
  for a group inside a list.
- **A list's search sits in its card's head** beside the title, folding
  to an icon on a phone; never a band across the card.
- **A row that opens something shows it by hover and pointer**, no ›
  chevron. Nothing opens as a strip under its row: forms and details
  open in the `Drawer`.
- **One large figure per hero**; more lines under it are in the text's
  size.
- **Every number is mono tabular** (`Num`), a change coloured
  (`Change`); a coin is named without its quote currency.

The parts:

- `Card.tsx`: `Card` (title, faint count, actions on the right, a head
  as tall as a control with or without them, `flush` for rows that pad
  themselves), `CardHead` and `SectionHead` (the same head without a
  card, over a section of tiles; `note` after the count, where a slow
  read's words go), `GroupLabel` (a group
  inside a list: mono label, fold caret, count, a trailing total),
  `PeriodLabel` (a month or a day in a list, sticking under the page's
  head), `CardLabel` (a part of a card under a small name in the
  text's face).
- `Tabs.tsx`: plain words underlined in the text's colour, a faint
  count; buttons as a tablist with arrow keys, or links when each tab
  is an address; scrolls and fades on a phone.
- `Segmented.tsx`: a mode inside a card (chart ranges, cards or table),
  drawn by base's `.seg`.
- `Table.tsx`: a table from column definitions (`width` per width,
  `align`, `headAlign`, `sortable` with `sortFirst` and a hover
  `sortTitle`, `hide` on tablet
  or phone, `show: false` when nothing fills it); `rows` or `groups`
  with labels; `sort` and `dir`, `onSort` given the column and the
  direction `nextSort` picks; `open` (a page's address or an action,
  over the whole row); `menu` for the row's ⋯; `empty`, said only when
  no row and no group label is left; `dense` for 52px rows; `head={false}`;
  `rowAttrs` for a row's class and drag while a list is edited;
  `waiting` for rows still on their way, that many rows of each
  column's `wait` (a six-character placeholder by default) under the
  real heads.
  Each row is its own grid, so a width never sizes to its content
  (`auto`, `max-content`): columns would stop lining up row to row.
  A control in a cell takes `.table-raise` to sit over the row's link.
- `Symbol.tsx`: `SymbolName`, the ticker over its name, or one line
  `compact`; `SymbolWaiting` its placeholder. `lib/names.ts`: how an
  instrument is named (`tickerOf`, `nameOf`, `symbolOf`, `kindOf`,
  `marketOf`, `stopped`, `about`).
- `lib/format.ts`: the numbers and words more than one page writes
  (`figure`, `price`, `priceParts`, `change`, `volumeText`, `money`,
  `signedMoney`, `amount`, `percent`, `quantity`, `briefQuantity`,
  `day`, `ago`, `plain`). A formatter two pages use lives here or in
  `lib/names.ts`, never in a page's model; a page may reuse another
  page's data helpers (the dashboard's sparks take `closes` and
  `sessionSlots` from `Chart.model.ts`).
- `Figures.tsx`: `Num`, `Change`, `Hero` (the value band: name, the
  figure with its currency or a menu, moves, `lines`; `compact` at a
  card title's size inside a card), `HeroWaiting` (its placeholder),
  `Stats` (a row of labelled figures, no boxes), `Facts` (a detail's
  label-over-value grid, two to a row, `four` for short figures, never
  broken, two by two in a narrow card; a faint `note` under a value).
- `Amounts.tsx`: Hide amounts, one setting for every page with the
  owner's amounts (`markets-portfolio-hide` in `localStorage`):
  `useHideAmounts()`, the eye (`HideAmounts`), and `hiddenClass()` on
  the element around figures of class `amount`, which it blurs; a
  percent stays readable.
- `Weights.tsx`: shares of a whole as rows, a label (a ticker linking
  its page in the ticker's style, never the link colour, its name on
  hover and for a screen reader), a grey bar against the largest
  (`barWidth()`), the weight; one grid, so the labels size to the
  longest, up to a name's width. Rows that link are 44px to a finger.
- `RangeBar.tsx`: where a price sits between a low and a high, the ends
  under it.
- `Placeholder.tsx`: `Placeholder`, a band in the line colour pulsing
  softly (still under reduced motion), as wide as `chars` of its
  parent's text and a line of it high, or a `band` across its box at
  half its height for a line or a chart; `WaitWords`, the words a wait
  shows once `show` (always rendered, as a status for a screen reader),
  with `spin` for a source being asked.
- `Spark.tsx`: `waiting` puts a band where a line's first read has not
  landed; green above its dotted base, red below; the base the
  period's start (its box at least 10% of it) or a given value such as
  the previous close; fixed or `fluid` width; `slots`, the points the
  width stands for, so a session still trading fills only its share.
- `SymbolSearch.tsx`: the head's symbol search, Home's moved to every
  page. `SymbolSearch.model.ts` asks `GET /api/v1/symbols` as Home's
  search does (stored matches at once, upstream from two characters
  after a 250 ms pause, a newer query aborting the older); a result is
  the ticker over its name with its kind and exchange, New when not
  stored, and opens its instrument page; Escape closes the section
  picker before the results. On a phone the icon opens a full-screen
  sheet with Cancel. Home passes its sections (`search` on `Page`) for
  each result's Add, and `seedSearch(q)` fills and opens it from an
  example.
- `Search.tsx`: the card-head search, its ✕ clearing and folding;
  `delay` for a list asked of the server, children for a results menu.
- `Menu.tsx`: `MenuButton` (a row's ⋯, `head` for a page head's, or
  `text` for a word and a caret, such as a currency picked, and with
  `field` a form's pick framed and as wide as an input) with `items` or
  a pane of its own; `MenuItems`, an item running an action, opening a
  link or `checked` as one choice of several; `MenuHead` and `MenuLine`
  for a heading and a figure inside a menu.
- `Drawer.tsx`: the one frame for forms and details: title, close,
  body, `foot` and `footStart`, `busy`; slides in 200ms and out 180ms;
  Escape, the close or the dimmed page closes it once (Escape in a
  search with words clears it first), and the focus returns where it
  was, or to the menu button that opened it.
- `Notice.tsx`: an empty list's line, a refusal (`error`), or a panel
  that starts a page from nothing; a page that did not load is `Page`'s
  `failed`.
- `base.css`: buttons, fields, `.tag` (`.tag-side` with `.tag-up` or
  `.tag-down` for a trade's side), `.chip`, `.seg`, `.menu`.

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
- **The top card has three tabs**, the shared `Tabs` in a `Card`
  (short words on a phone), the last chosen kept per browser
  (`markets-dashboard-tab` in `localStorage`); each list is a `Table`
  whose rows open the instrument page. Browser storage is a
  convenience: a browser that keeps nothing starts from the defaults.
- **Today's movers**: the four biggest gainers and losers among the
  favourites by the day's percent, in two columns (one on a phone),
  each row the ticker with the short name after it (a bond its ticker
  alone), a bar scaled to the biggest move, and the percent.
- **Trend**: shares, ETFs and coins only. An arrow for the side of the
  50-day average, the price, then the distance to the 50-day, 200-day
  and 200-week averages from the server's `averages`, two decimals
  under 1%. Each header sorts, the 50-day deepest below first by
  default, and a second click flips it (kept as
  `markets-dashboard-trend-sort`). Eight rows, then "Show all N".
  "Crossed today" comes from the server's `crossed_today`, a tag after
  the ticker, and is the tab's count, which hides at none. A phone
  drops the price.
- **Earnings this week**: the favourite shares reporting today and the
  six days after it in the viewer's own calendar, from
  `GET /api/v1/earnings`, 100 shares a call (the route's cap) merged by
  date, Today in the text's colour and later days faint. The tab's
  count shows even at 0. A phone drops the estimates. A call
  that fails keeps the list shown before, an answer older than the
  newest asked never lands, and a share a save removes leaves the list
  at once, even from an answer asked before it. The route lists a share
  with no calendar (a non-US share, for one) under `unavailable` as a
  note; only a source that is off, or no share answered at all, makes
  the tab say "Earnings are not available." with no count, never that
  none report.
- **The head's symbol search** is `Page`'s shared one, given the
  sections so each result has an Add (`search` with `sections`,
  `onAdd`, `refuse`): Add picks a section and saves at once, the save
  fetching a symbol never seen before its card lands; with no section
  yet, Add makes "Favourites"; an add the server would refuse says why
  in the results ("This section is full."). It is left out while
  editing and while the seed still loads.
- **No favourites**: the tabs hide and a panel says "Build your
  dashboard" with example chips (`^GSPC`, `AAPL`, `VWCE.DE`,
  `BTC-USD`, `GC=F`) that fill the search (`seedSearch`), on the shared
  `Notice`, as is the seed's loading panel. They are examples only:
  nothing is added, and the code names no default instrument or
  market.
- **A section** is a `SectionHead`: its name, count and a cards or
  table switch (`Segmented`). Its tiles are as many to a row as fit (4,
  3 on a tablet, 2 on a phone), one fewer or more (down to one) when
  that would leave a tile alone on the last row (`tileColumns()`). Its table is a
  `Table` in a flush `Card`: the ticker over the name, the day line,
  the price, the day's percent with the change in its unit under it,
  and Open or Closed; a phone keeps the name, price and percent. Open or Closed is the server's
  `session`, from the source's own answers, never hours kept here.
- **Edit is a draft** (desktop only, the pencil in the head): it copies
  the layout and its revision (`editOf()`), hides search, and shows
  Cancel and Save. Rename (a name that cannot be saved goes back and
  says why beside the field, such as "Another section has this
  name."), move a section up or down or delete it (its ⋯ menu), drag
  cards and rows
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
- **A card** is the ticker over its name (a coin without its quote
  currency), Open or Closed, a line, the stored price with its currency
  apart (a yield in percent) and the day's change in percent; it links
  the instrument. A favourite added but not answered yet keeps the
  card's shape, "Pending" and a dash where its figures will land. The page
  re-reads every minute while visible. A load is stale once the
  router's path changes, checked when its answer lands, and a save that
  lands after leaving starts no load, so leaving the page asks no line
  after it (an effect's cleanup runs too late).
- **Before the layout's first answer** the page shows its shape: the
  top card's tabs over rows of placeholders, and a section of four
  placeholder tiles, "Loading prices" after its head once slow.
- **The line is one bars call per card, in parallel**, each drawn as it
  lands, never held for the slowest (a band holds the place of a line
  not drawn yet, "Loading charts" after the section's count once
  slow), by the item's
  `intraday`: `interval=5m` (the newest session, split at its
  `previous_close`, green above and red below, the previous close a
  dotted line, across the whole session so a morning fills only the
  morning: `Spark`'s `slots` are the session's 5-minute slots when it
  brackets the closes), else a month of daily bars split the same way
  at its first close. The bundle names no source, so the
  server says which items have 5-minute closes. A Yahoo listing with no
  points yet draws no line; a line that fails keeps the one drawn
  before.
- **The line is the shared `Spark`**, inline SVG whose strokes are
  CSS tokens, so it wears the theme from the first frame; `sparkOf()`
  picks its closes, base and slots.
- **Before its first answer Server status shows** its figures row
  with the four labels over placeholders, and the Jobs card's rows.
- **Server status** (`/status`, last in the rail, after Home,
  Instruments, Portfolios and Connect agents): `GET /api/v1/status`
  drawn as a stat row (instruments and how many are tracked, the
  sources on and how many are paused, the jobs shown and how many
  fail, the database and the version), "Sync is off." under it while
  `sync` is false (`--no-sync`, `docs/config.md`), and one Jobs card:
  a table of every job, grouped as the holdings are, a folding label
  per source that is on with its name and job count ("No runs yet."
  when it has none), never one that is off: most servers never turn a
  regional source on, and an off source has nothing to fix. A row is
  a dot for the state, the job, what it covers (how many markets or
  instruments and how many fail; under the job on a phone) and its
  last run's time ("Never" before the first), which never repeats the
  outcome. A row opens the
  job's drawer: what it does, its source and last run, then its
  failing scopes with error and time ("AMD: the source failed" when a
  run names the symbols that failed it), or that all are ok. Failing
  jobs come first. Missing closes (`owed`) never shows: it only marks
  a day for the bars job to ask again, so it cannot fail.
- **Readers are not technical.** A server phrase shows in plain words
  (`plain()`: "rate limited" reads "too many requests"), and a pause
  shows only as a count under Sources, since the job that hit it
  shows the error.
- **Names come from the server** (a source's and a job's `label`, a
  job's `about`): the bundle is public, so it names no source
  (`docs/admin.md`).
- **The source switch shows only when it failed,** as one line above
  the jobs: it runs once per change of flags, not on a schedule.
- **Add a source** is a card listing the keyed sources that are off,
  each with what it adds, its key file and a link to get a key; it is
  absent when none is off. **Always tracked** is a card of the
  `--track` values beside their resolved ids, from
  `GET /api/v1/watchlist`, loaded with the status so both land
  together.
- **Connect agents** (`/connect`, before Server status in the rail), as
  1ctx's: a Keys card from `GET /api/v1/keys` ("N of 5", New key in
  its head), a table of each key's name, last use, expiry and access.
  The Access column says "Reads portfolios", "Writes portfolios",
  "Reads alert rules" or "Writes alert rules" only for what a key has,
  shows only when some key has any, and drops on a phone with the last
  use. A row opens the key's drawer: its last use and expiry, then
  Portfolios and Alert rules, each No access, Read, or Read and write,
  set to what it has; Revoke at the foot's start asks once beside
  Keep, and Cancel and Save (`PATCH /api/v1/keys/{id}`, waiting on a
  change) at its end. New key opens the same drawer: a name, shaped
  as typed to the server's rule, Expires (Never, 30, 90 or 365 days)
  and the two picks, no access by default. Then a Setup card with the
  agent picked in its head (Claude Code, Codex, OpenCode) and the line
  that adds this server as the MCP server `markets` at the page's
  origin plus `/mcp`. At the cap, New key goes and a line names the
  cap. A revoke that answers 404 drops the row and its drawer.
- **Copy uses `copyText()` (`src/web/lib/clipboard.ts`)**, as 1ctx:
  the clipboard exists only on loopback or HTTPS, so on plain HTTP the
  button stays as it is and never says Copied.
- **A made key's token lives in the Connect agents view alone**: the
  store keeps the key's row, never its token. It shows once, in the
  drawer that made it, with a copy button, the `export
  MARKETS_ACCESS_KEY=...` line and "Copy it now; it is not shown
  again.", and goes on Done, on any close of the drawer, or on leaving
  the page.
- **No setup line carries a token.** Each reads `MARKETS_ACCESS_KEY`
  (as 1ctx's read `ONECTX_ACCESS_KEY`): Claude Code's header in single
  quotes, so the shell never writes the key into its config, Codex's
  `bearer_token_env_var`, OpenCode's `{env:...}` with OAuth off.
- **Portfolios** (`/portfolios` and `/portfolios/{id}`, after
  Instruments in the rail) reads
  `GET /api/v1/portfolios`, the holdings (`/holdings` or
  `/portfolios/{id}/holdings`) and the trades with removed ones in one
  load (`data/portfolios.ts`), every minute while visible. The page is
  `Portfolios.tsx`, its forms `PortfolioForms.tsx`; its words, numbers
  and rules are `Portfolios.model.ts`, which has no DOM and is tested
  (`test/web-portfolios.test.tsx`). Top to bottom: the head (the eye
  that hides amounts, Add, the ⋯ menu), the portfolios as tabs, the
  value band, Holdings, Activity.
- **No currency is built in.** The value band (`Hero`) names the tab
  ("All portfolios" or the portfolio), the converted total large. With
  nothing converted (no display currency) and two or more currencies,
  the largest currency's total is the one large figure and each other's
  a line under it in the text's size; nothing in two currencies is
  summed, so the group labels then show no total or share (`mixed()`). Its currency is a menu (when two
  or more are offered, or the total left something out): the
  currencies the server converts into (`currencies()`, those held, the
  display one and the one picked, only those in circulation), then the
  total held in each currency with each rate and its time
  (`rateLine()`), then what the total left out by symbol or as "No EUR
  to JPY rate" (`missingWords()`). Under it one line (`heroOf()`):
  today, only when something in view moves within a day (a quoted or
  listed price; cash, a hand-priced fund and a face-value bond never
  do), and all time, only when a cost gives a gain. Then one bar
  (`barOf()`): Invested against Cash with money invested, Dry powder
  against Reserve with cash alone, shown only when both sides are
  above 0.
- **The view is the address** (`addressOf`, `viewOf`): the portfolio's
  id in the path, `currency` in the query, left out when it is the
  display currency. The tabs are links, so a
  portfolio picked is a new history entry and keeps the currency, and
  Back returns to the one before; a currency picked, or a fallback to
  all when the portfolio is gone, replaces the address in place.
  Anything else in the address reads as all; a broker in an old link
  is ignored (there is no broker filter).
- **Holdings** is a `Table` in a card with a search over the ticker,
  name, ISIN and the brokers a holding is held at (`holdingMatches`,
  every word typed must match some field). Grouped (`groupsOf()`) on
  All by portfolio, inside one by kind, the largest group first, each
  a folding `GroupLabel` with its count, value and share of the view;
  one group shows no label; a row the server could not convert (no
  rate) shows its own currency only and counts in no group total. Columns: Holding (`holdingTicker()` over
  `holdingName()`: a coin without its quote currency, cash as Dry
  powder or Reserve with its date, a fund with its ISIN, a bond with
  coupon and maturity; a stale reason as a tag in plain words,
  `staleWords()`), 3M (a `Spark` from each listed holding's daily bars,
  cached for the page's life), Change (price and today's percent; a
  hand price with its day, a bond's as a percent of face,
  `priceLine()`), Value (display currency, its own under it when
  different; a holding sold today the day's move, "Sold today" under
  its name), Gain (percent and money on one base, the display currency's
  with the rate's move in when converted, `shownGainPercent()`; the
  money not on a phone), Weight. Nothing in view
  fills a column: it goes (`columnsFor()`): 3M and the day's move with
  nothing listed (the head then reads Price), Change for cash alone,
  Gain where no row has one. 3M and Weight go on a tablet, Change on a
  phone. Sort by Change, Value or Gain from the heads, Value first; a
  row with nothing to sort by, or no rate in a converted view, goes last
  (`sortRows()`). A row opens its instrument page (`pageOf()`); with
  none it opens what edits it (`homeOf()`): cash and a position its
  Edit, a hand-priced fund (its `fund:` id has no page) its Set price, a
  merged bond its Purchases. Its ⋯ (`rowActions()`): Buy and Sell (Sell
  not on a holding sold today) open the add drawer on it, in its one
  portfolio and broker; Set price for a hand-priced fund; Edit for a
  position; Purchases for a bond bought several times; Instrument page
  when there is one. Amounts show whole from 1,000 up (`money()`),
  else in the currency's minor units (`minorUnits()`).
- **Drawers:** every form and detail opens in the one `Drawer`. Edit
  (amount, as of, and cash's market; Remove at the foot's start asks
  once), Set price (name, price per unit, the day it is for, starting
  on the owner's today, and the market; a day already priced takes the
  new price, and a changed name alone sends no price, `PATCH
  /api/v1/funds/{isin}`), Purchases (each purchase's date, face and
  broker with its own Edit and Remove, since a merged bond has no one
  position). An edit starts from the stored amount, never the value
  rounded for show.
- **Activity** is a dense `Table` under the holdings, hidden when the
  view holds no trades: by month (`monthsOf()`, "11 bought · 2 sold"),
  newest first, three months then "Show earlier months". Fills of one
  order (one day, portfolio, symbol, side and broker) read as one row with "· 2
  fills" and the average price (`foldFills()`, `orderOf()`); a buy at
  price 0 is a grey Reward. Its search matches the side too
  (`tradeMatches`). When trades were removed, a faint "Removed trades ·
  N" at the end shows them in the same table under "Removed trades",
  with "← All activity" back. A row opens the trade drawer: the tag, the
  ticker (a link to its instrument page when it has one) and name, the
  amount large, then date, quantity, price (the average across fills,
  a bond's as a percent), fees, broker, portfolio on All, who added it
  ("Web", "Admin" or the key's name) and when on the owner's calendar,
  when it was removed and by whom, the note and each fill; its foot
  has Remove (asks once; every fill
  together), Buy and Sell (a fund's open the Fund tab on it), and a
  removed trade's Restore. The counts are of orders, not fills.
- **Add** opens the drawer, the page staying where it was: Trade, Cash,
  Fund or Bond as tabs. Fund records a buy or
  sell of a fund bought from its manager, one per confirmation
  (`POST /api/v1/funds/trades`; a fund with a symbol, an ETF among
  them, is a trade): Buy or Sell, ISIN and name, units, price per unit
  or the total paid ("Use total", fees in), date, the currency on a
  new fund, market, portfolio, broker and note. An ISIN the server
  keeps (`funds` in `GET /api/v1/portfolios`) shows the fund's name and
  hides the name and currency, which a first buy gives; a sell offers
  All as a trade's does. A trade starts from a symbol search
  (`searcher()` from `ui/SymbolSearch.model.ts`, shares, ETFs, funds and crypto ranked
  before futures and the like (`ranked()`), each result naming its
  exchange (`listingWords()`)). A pick reads the listing
  (`GET /api/v1/instruments/{id}`) and shows its name, live price and
  where it is held now, from every portfolio whatever the page filters
  on; the price field takes the live price, so what is saved is what is
  shown. A price taken from the quote is in the listing's currency, so
  picking another Paid in clears it, and the server converts the live
  price itself ("at the live price" in the read-back). The portfolio is where the listing is already held, else the
  tab on, else "Pick a portfolio": never a silent first one. Then Buy or
  Sell (a sell offers All with the quantity held in that portfolio, at
  the broker picked or at every one, sent as `"all"` while left as is,
  so the server sells what is sellable on the trade's date), Quantity and
  Price or Total paid ("Use total", fees in, as the server's `total`),
  Date and Fees (its Paid in a small menu by the price), Portfolio and
  Broker (each "New…" names one), and a note. A buy may pay from dry
  powder: after the trade saves, the dry powder in its currency and
  portfolio (else the nearest, `dryPowderFor()`) is lowered by the
  trade's cost (`PATCH /positions/{id}` with `by` and the trade's
  currency, which the server converts); a failure there says the buy
  is saved and the dry powder was not changed, and the form then only
  closes, so a second press never records the buy twice. While a save
  is on its way the drawer stays open; Escape closes an open menu or the
  symbol's list first, the drawer only when none is open. A line above the buttons
  reads back the trade ("Buy 5 KO at 60.00 · 300.00 USD (≈ 270.00 EUR) ·
  Shares"). A position's currency is the currency
  picker. Cash and a fund pick a market, "None" first, from the
  markets the server lists, in the add form, cash's edit and a fund's
  Set price, so a fund holding one market's shares counts in it. Only the kind is remembered per browser
  (`markets-portfolio-add`). A
  refusal shows beside the buttons in plain words, its ids taken out
  (`plainError()` in `data/portfolios.ts`).
- **More** holds Import, Export trades (a link to the CSV of the
  portfolio picked, off on All) and Settings, each in the drawer. Import picks a portfolio,
  a broker for the file or "From the file", and a CSV; the preview
  lists every line as Ready, Not read with why, or Skipped, a cash
  file's lines each with a Dry powder box; "Import N" saves the ready
  ones. Changing the portfolio or broker clears the file and its
  preview, so a preview read for another is never saved. Settings lists portfolios and brokers with rename, delete
  (asking once; refused while a live row is in it or names it, removed
  rows going with it) and add, after the display currency (required):
  a picker over the ISO 4217 currencies in circulation
  (`src/shared/currencies.ts`, codes only, names from `Intl.DisplayNames`),
  found by code or name, saved on pick, then the owner's time zone: the
  app's own menu over every zone the browser knows
  (`Intl.supportedValuesOf("timeZone")`), found by city or area
  (`findZones()`), saved on pick. With no portfolio or no display
  currency the page shows only the first card, without Add or the menu,
  asking for a portfolio's name (with none yet), the currency (the most
  traded five one tap each, any other found by code or name) and the
  time zone, the zone filled with the browser's as a suggestion the
  owner sees before saving (`browserZone()`). With portfolios and
  nothing in any, a card under their names offers each way to add:
  a trade, cash, a fund or a bond, a CSV, or an agent (Connect). Date fields start on the owner's today in that zone,
  the UTC day until one is set (`today()`), as the server dates a
  position. A retried trade the server refuses reads "This trade was
  just saved." with a "Save again" button beside it, which sends the
  same trade with `again`, for a second fill that is the same.
- **The bundle names no source:** the import kinds read Trades, Cash
  and Bonds.
- **Instruments:** every stored instrument from
  `GET /api/v1/instruments`, every page by `next_page_token`, in one
  `Card` titled All with its count and a search over id and name in
  its head (the page's only search, so `Page` shows no symbol search),
  kept in the view with the sort so a refresh keeps both. The list is
  a `Table`: the instrument (`SymbolName`, a coin without its quote
  currency, "No longer updated" after the name only when nothing
  tracks it), the kind in plain words (Stock, ETF, Index, Bond,
  Future, Crypto, Currency, Series), the market (blank where it
  repeats the kind), the stored price with its currency, and the
  day's change. Sorted by symbol, an index's `^` aside; Instrument,
  Kind and Market sort A to Z first, Change high to low, a row with no
  change last and the symbol breaking ties (`sortRows`). A phone keeps
  the instrument and the price, the change under the price. A row
  opens the instrument page. The list never quotes: a quote is a read
  and would keep every row tracked. From two characters the search
  also asks `/symbols` and lists the sources' matches no row holds
  under a "Not stored yet" group label, tagged New; opening one
  fetches it.
- **Before its first answer an instrument page** shows the symbol from
  its address as the title, the value band's placeholder, the chart's
  box with its words (above) and two cards of placeholder facts.
  Connect agents draws its Setup card at once and placeholder rows in
  Keys; Portfolios the All tab, the value band's placeholder and rows
  in Holdings; Instruments rows in its card.
- **An instrument** (`/instruments/<id>`, the id encoded) reads
  `GET /api/v1/instruments/{id}`, a read as any client's, so
  opening it keeps it tracked and an id never stored is fetched. The
  title is the ticker with the name beside it. `Instrument.tsx` is the
  page; its head, cards, position, fund cards and menu are each their
  own `Instrument*.tsx`, their words and numbers `Instrument*.model.ts`,
  which have no DOM and are tested (`test/web-instrument.test.tsx`).
- **The head is the price alone**, the shared `Hero`, no card, then the
  chart: returns in the head pushed the chart below a phone's first
  screen. The name line is the kind and market, then the state, never
  "updated": "Closed" with no age (a close does not age; the move line
  says "at close"), "Open · 2 min ago", "Opening · last close" from the
  open until the first pass, "Open · no trade yet · 3 h ago" until the
  first trade, a series' "Latest value, 29 Oct · 1 d ago". The one
  large figure is the price with its currency small beside it; the
  moves line is the day's change in the price's unit and in percent,
  "today" once a trade lands after the open and "at close" otherwise
  (a series in percent shows the percent alone, and a series or a
  stored price no word). Outside regular hours the pre or post price is
  a line under it in the text's size ("After hours 205.25 +0.30% ·
  01:59"), never a second figure. A read that failed shows the stored
  price as "Stored price · 3 h ago" and one notice that a new price
  could not be had; the server's phrase is for agents, not this page.
- **Cards under the chart, two abreast with an odd last one across
  both, stacked on a phone**, each a `Card` whose rows are `Facts`.
  The model answers each card's data by name (`signalsOf()`,
  `positionOf()`, `fundOf()`), never a list the view searches by title.
  A card with nothing in it is left out, so a young listing or a series
  shows less. In order:
  - **Your position**, only when held: `GET /api/v1/holdings` (every
    portfolio, as Add's form reads it) matched on the instrument's id,
    re-read with the page; a read that fails keeps the one before. In
    the holding's own currency: the value (`Hero` `compact`), the all
    time and today's gain with their percents, Quantity and Average
    price; a bond Face value (its parts' amounts), Coupon, Matures and
    Bought, dates as the app writes them (`day()`, no year in this
    one). A line per portfolio and broker when there are several: a
    bond's face amount, else the quantity, and the value. Quantities
    to two decimals from 1, four digits under it (`briefQuantity()`).
    Its head: the Hide amounts eye, the Portfolios page's setting, and
    a briefcase to Portfolios ("Open Portfolios" on hover), no words.
  - **Performance**: the 1 week, 1 month, 3 months and year-to-date
    returns from the quote, never recomputed, four abreast, "—" where
    the server has none (points for a series in percent); then the
    52-week range under a `CardLabel`: a `RangeBar`, how far below the
    high and how many trading days ago, how far above the low.
  - **Today**, or **Last session** until today's first price: the
    day's range, volume against its 20-day average, "so far" while
    today trades, the typical daily move and the average daily range.
  - **Trend**: the price beside the 50-day, 200-day and 200-week
    averages, the 50 above or below the 200, the cross named only on
    its day, RSI 14 as neutral, overbought from 70 or oversold to 30,
    and momentum as the MACD histogram's sign, upward or downward, with
    a turn of its direction as the day's note, since a turn comes on
    either side. A yield's distances and range are in points.
  - **A fund's Top holdings, then Sectors or Bond ratings** (an ETF or
    mutual fund, from the answer's `top_holdings`): each a `Weights`
    list, one decimal. "Top 10: 82.6% of the fund · fetched 1 Nov"
    above the holdings, "· not current" when stale; each holding with
    a symbol links its page (by `id` when stored, else by symbol,
    fetched as the page opens). Sectors and grades in words ("Real
    estate", "AAA"), US government bonds as a line under the ratings. A
    fund with none: "No top holdings listed for this fund." alone; a
    failed fetch: "Could not get its top holdings."
- **The page head is a containing block for fixed elements**: its blur
  (`backdrop-filter`) holds a fixed descendant inside it, so a sheet or
  popover fixed to the window turns the blur off while open, as the
  phone search does.
- **One More button holds the page's actions** in the head (the shared
  `MenuButton`, after the symbol search `Page` shows), on a phone too. Refetch data runs at once and refetches every
  part a source holds for it (`POST /api/v1/instruments/{id}/refetch`
  with every part `choices()` lists, a fund's top holdings among
  them); the button spins while it runs, then shows a green check for `SAID_MS` once it fetched; "Not
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
- **1D and 5D only where the instrument route's `intraday` is true**
  (`rangesOf`): a source with no 5-minute closes has nothing to draw.
  There a kept 1D or 5D draws 1M (`drawnFor`) and stays kept; only a
  range clicked is saved.
- **A daily range's change is the server's return** for the same
  period (`periodStart` in `src/signals/relative.ts`): from the last
  close on or before its start, dated from the last bar, not today (the
  same day months back, `monthsBack`; 31 Dec for YTD, `yearStart`; both
  in `src/shared/periods.ts`), Max from the first bar. The bars are
  asked from two weeks before the range's first day (`askedFrom`), so
  that close is there across a weekend or holiday; a slow or stale
  series (monthly, quarterly, suspended) with none there is read again
  from Max's first day (`readRange`). The line starts at that close
  (`fromStart`), so the 1M, 3M and YTD readouts equal the page's
  returns. A range that starts before the listing's first bar (a bond
  listed in July, on YTD) is measured from that bar and named "since 16
  Jul" in place of the range (with its year when not the last
  bar's), so it never claims a return the server has none of.
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
  draws a day; the scale keeps the previous close in view. A scale
  number a price tag would cover is left blank (`clearOfTags`). 1D asks
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
  range's first close (points for a series in percent), named by the
  range or "since" its first day, then the
  averages. It follows the crosshair only once the pointer moves over
  the chart (`pointerAt()`): a pointer resting where a clicked link was
  is no bar picked, and a browser repeats a resting pointer's place
  after a redraw. At rest the latest bar, whose averages fall back to
  the last there are (an open week has none).
- **A range not drawn yet** (the first, or one picked) leaves the
  plot's box empty, its size kept, with "Loading the chart" once slow;
  the minute's refresh keeps the bars drawn. The first draw waits for
  mono face (`document.fonts.load`), which the canvas takes when it
  draws.
- **Prices on the axis** have separators, and no cents from five
  figures up (`axisPrice`), so a phone's axis stays narrow; each pane's
  scale keeps headroom so its top label is whole.
- **On a phone the head's row is the floating menu button's height**,
  centred, so the button, title and actions share one middle.
- **The chart is a flush `Card`** whose head holds its tools where a
  title would be: the ranges as the shared `Segmented` on the left,
  then Line or Candles (`Segmented`), the 50 and 200 toggles, and Log,
  each toggle a pressed `.seg` button; the head is the card's own
  (`card-head`). 1D keeps the previous close in the scale, so a day
  far from it leaves the room between them. Up and down are `--up` and
  `--down`, read from the tokens.
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
  both averages. 1D and 5D are kept like any range, though an
  instrument without them draws 1M.
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
