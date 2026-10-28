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
  the router's, so an unknown one keeps the bearer's 401.
- **`development: false`**, so a run from source serves the bundle the
  binary does, never Bun's dev server and its reload script.
  `MARKETS_PAGE_DEV=1` (a local preview's, never set where the binary
  runs) serves `{ hmr: false }` instead: Bun rebuilds the bundle after
  an edit, with no reload script, so a UI change needs a browser
  reload, not a server restart.
- **`UI_PATHS` and the client's `ROUTES` (with `ALIASES`) name the same
  paths**; `test/web.test.tsx` holds them equal. A new page adds its
  path to both.
- **`--no-ui` turns the UI off**: no page, no `/ui/session` (it answers
  the bearer's 401 as any unknown path), and a cookie opens nothing.
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
  constant time. No table and no migration; replacing `admin.key` and
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

- **The admin routes, `/api/v1/admin/*`, every `GET` or `HEAD`
  under `/api/v1`, and `POST /api/v1/screen`**, a read whose filters
  are a body, held to the write check below. The bearer and the admin key keep their own paths
  first (`router()`); the cookie is tried only when the key a path
  takes is missing or wrong.
- **Never `/mcp`, and never a write outside the admin routes** (rules
  stay the bearer's).
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
  links in place, the API's own pages excepted.
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
  `style/base.css`, the fonts, the rail, strip and shell styles, the
  logo and icons, trimmed to what these pages use. The rail is the
  logo with **Markets** beside it, the pages, and the operator's menu
  (dark theme, sign out) at the foot; it folds to a strip on a wide
  window and is a drawer on a phone. The theme follows the system until
  flipped; a flip is kept in `localStorage`.
- **Copy is short:** sentence case, no "you", "please" or explanations.
  An error is the server's phrase as a sentence (`says()`, as 1ctx),
  so a wrong key reads "Wrong admin key."

## Pages

- **Status:** `GET /api/v1/admin/status` drawn as tiles (instruments,
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
  off. The `--track` values are a grid of value and resolved id.
- **Instruments:** every stored instrument from
  `GET /api/v1/admin/instruments`, all pages, in one card with a search
  over id and name, kept in the view so a refresh keeps it. Sorted by
  symbol, an index's `^` aside. A row is the symbol and name, then the
  kind in plain words (Stock, ETF, Index, Bond, Future, Crypto,
  Currency, Series) and the market, left out where it repeats the kind;
  "No longer updated" only when nothing tracks it. On the right, the
  stored price with its currency and the day's change. The list never
  quotes: a quote is a read and would keep every row tracked.
- **An instrument** (`/instruments/<id>`, the id encoded) reads
  `GET /api/v1/admin/instruments/{id}`, a read as any client's, so
  opening it keeps it tracked. The title is the symbol with the name
  beside it; a card holds the kind and market, the price and day's
  change, "Live · market open" or "Close · market closed" (a series:
  "Latest value" and its date) with when it was fetched, and the 1
  week, 1 month, 3 months and year-to-date returns from the quote, never
  recomputed, then how far the price is above or below the quote's
  200-week average (in points for a series in percent), the average's
  own value left out so the row stays one line. A read that failed shows the stored price as "Stored
  price" with its age, no returns, and one notice that a new price could
  not be had; the server's phrase is for agents, not this page.
- **Refetch is a button with a menu** in the page head (1ctx's More):
  Everything, then each part a source holds for it (research, earnings
  dates and news only for US shares, news for US ETFs too). A pick
  runs at once; the button reads Fetching, then "Updated" or "Not
  available" for `SAID_MS`, every label in one cell so it keeps its
  width. A failure names the part and its error in plain words in the
  page's notice.
- **Delete is 1ctx's delete card:** a red edge, what goes, and a foot
  whose Delete asks once beside Keep; a rule reading it is refused with
  that said in the foot. A delete returns to the list.
- **Pages with a parameter** (`/instruments/:id` in `ROUTES` and
  `UI_PATHS`) stay off the rail, which lights their parent.
- **The list re-reads every minute** (`REFRESH_MS`) while the tab is
  visible, and at once when it comes back; a load in flight answers a
  second ask, and a failed one keeps the rows and shows the error. An
  instrument's page re-reads the same way (`lib/refresh.ts`).

## The chart

- **TradingView Lightweight Charts 5.2.1** (`views/Chart.tsx`), run
  with the first chart (a dynamic import); the compiled binary does
  not split the page, so the library ships in its bundle either way. Its
  data comes from `GET /api/v1/history?ohlc=true`, a read; the bars
  are shaped in `Chart.model.ts`, which has no DOM and is tested.
- **Ranges** 1D, 5D, then 1M to Max (`RANGES`, 1D by default); 3Y
  and up read weekly bars (`intervalOf`), so the averages read
  "50-week" and "200-week". Max is the ten years the server keeps.
- **1D and 5D read `history?interval=5m`**: the newest stored session,
  or all five kept (asked from Max's start). A line of closes on a time
  axis at the points' real UTC times (`pointLine`), so a clock change
  never reorders or drops one; only the labels (axis ticks, crosshair,
  legend) are in the viewer's local time (`localTime`, `timeLabel`),
  the crosshair's day label for daily bars kept as the library writes
  it. No candles, averages or volume, so their toggles hide. The legend gives the day and time,
  the close and the change from the answer's `previous_close`, else the first close.
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
  line. Log is a toggle; a range change fits the content, and any other
  redraw (the minute refresh, a toggle, a theme flip) keeps the times in
  view, never the bar positions: 1D's three series would shift them.
- **Colours are read from the tokens on every draw**, and a theme flip
  draws again.
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
  instrument page only, with "1ctx Markets" (the repository) and the
  version on its left.

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
