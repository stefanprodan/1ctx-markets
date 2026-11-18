# Web UI

Governs the web UI: the client under `src/web/`, its sign-ins
(`src/server/session.ts`, the logins; `src/server/links.ts`, links by
email; `src/server/ui.ts`, the `/ui/*` routes), the paths that serve it
(`UI_PATHS` and `serve()` in `src/server/http.ts`) and `--no-ui`.

The views and their tests hold each page's words, column orders and
sizes; this doc holds the rules behind them and their reasons.

## Why

A family or a small group of investors shares one server, each person
with their own portfolios, profile, dashboard, alerts and keys, so each
person signs in as themself from a browser on the server's own host,
by a link emailed to an address an admin added: no passwords, no SSO,
and no link handed over. The operator also signs in with the admin
key alone, so status, refetch and delete need no `curl` or ssh.

## Serving

- **The binary serves the page.** `main.ts` imports
  `src/web/index.html`, which Bun bundles with its script, styles,
  fonts and icon into the binary; nothing is loaded from another host.
  `serve()` answers each of `UI_PATHS` with the page and Bun answers
  the assets at the hashed paths the page names. Every other path is
  the router's, so an unknown one keeps the keys' 401.
- **`development: false`**, so a run from source serves the bundle the
  binary does, never Bun's dev server. `MARKETS_PAGE_DEV=1` (a local
  preview's, never where the binary runs) serves `{ hmr: false }`: Bun
  rebuilds after an edit, so a UI change needs a browser reload, not a
  restart.
- **The fonts are files, never in a stylesheet**: Bun turns a CSS
  `url()` under 128 KiB into a `data:` URL, which holds the first paint
  until the whole stylesheet lands, so `app/fonts.ts` declares the
  faces from imports and `index.html` preloads them
  (`test/web-build.test.ts`).
- **The release build is minified** (`scripts/build.ts`), whitespace and
  syntax only, never identifiers: the log names an error by its class.
- **`index.html` draws a frame before the script**, the page colour and
  the mark, only while `#app` is empty and after half a second, so a
  fast load never flashes it; its colours are copied from `tokens.css`
  (`test/install.test.ts`).
- **The UI installs to a phone's Home Screen.** The bundler hashes what
  the page links but not the URLs inside `manifest.webmanifest`, so its
  icons and `sw.js` are fixed paths that `main.ts` embeds and `serve()`
  answers beside the page (`files`), public as the page is, off with
  `--no-ui`, and `Cache-Control: no-cache`, so a new worker is seen at
  once. The iOS status bar style is `default`, so an installed app
  paints its bar in the `theme-color` that `app/theme.ts` keeps in the
  page colour.
- **`sw.js` only shows pushes** (the notification, the app badge, and
  a click opening Fired, never another origin). It caches nothing and
  handles no `fetch`, so the app never shows an old price offline.
- **`UI_PATHS` and the client's `ROUTES` name the same paths**
  (`test/web.test.tsx`); a new page adds its path to both.
- **`--no-ui` turns the UI off**: no page, no `/ui/*` route (each
  answers the keys' 401 as any unknown path), and a cookie opens
  nothing.
## Logins

- **A login is a row behind the `markets_session` cookie** (`logins`,
  `docs/storage.md`): the cookie holds 32 random bytes as base64url,
  the row only their SHA-256. No token reaches a log line or an answer
  but the one `Set-Cookie`; a log line names the login's id and its
  person.
- **30 days, sliding at most once an hour** (`SESSION_MS`,
  `TOUCH_MS`): a request past an hour since the last touch moves the
  expiry through the writer and sends the cookie again with a full
  `Max-Age`, unless the route set its own.
- **Sign-out deletes that row** (`DELETE /ui/session`, 204, the cookie
  cleared), its push subscriptions with it (on delete cascade), so a
  device signed out gets no push. An admin signs a person out
  everywhere (`docs/admin.md`). Expired logins go with the startup and
  daily prunes (`pruneLogins()`); every check goes by `expires_at`, so
  none waits on a prune.
- **`HttpOnly; SameSite=Strict; Path=/`, and `Secure` unless the
  request's `Origin` is plain HTTP to a loopback host**
  (`cookieAttributes()`); no `Origin` is `Secure`. A browser keeps a
  `Secure` cookie over plain HTTP only on loopback, and the browser's
  `Origin` decides, never `Host`, which a proxy may rewrite. Plain HTTP
  to a LAN or tailnet address cannot sign in: use loopback or TLS.
- **A proxy in front needs nothing special for the cookie**: it and the
  write check read what the browser sends. The ask limit's client
  address is the socket's, so behind a proxy every browser would share
  one window: `--trust-proxy` takes the last `X-Forwarded-For` value,
  the one the proxy added (`clientIp()`, `docs/config.md`). Never set
  it without a proxy, since any client can send the header.
- **No log line holds a link's token**: the request log names
  `/ui/link/:token`, never the path (`loggedPath()`), and a code or a
  challenge is only ever in a body or a cookie.

## The admin key

- **`POST /ui/session` with `{"key": "<admin key>"}`** compares the
  trimmed key in constant time (both sides hashed, `timingSafeEqual`)
  and opens a login for the operator, 204 with the cookie. It is the
  operator's alone and always works, email or not, so no mail outage
  locks the server out.
- **Every failed sign-in answers the same 401** (`wrong admin key`),
  with no cookie: a wrong or empty key, a malformed body, a body over
  the route's 8 KiB cap or not JSON, and a server with no admin key.
  The page faces the internet, so no answer tells one failure from
  another.
- **No rate limit:** the admin key is 32 random bytes, so guessing it
  is no threat.
- **The login holds a SHA-256 of the admin key** (`admin_digest`), so
  replacing `user-admin.key` and restarting answers 401 to every login
  the old key opened, and the prunes delete them (`pruneLogins()` given
  the current digest), their devices with them; logins by link stay.

## Links by email

Only while email is on (`docs/admin.md`, "Email"); the sign-in page
learns it from `email_on` in `GET /ui/me`.

- **An ask never tells.** `POST /ui/link` with `{email}` answers 202
  with no body before any lookup, whatever the address; the lookup, the
  caps and the email run after the answer (`links.ask()`), and the
  shutdown waits for them before the writer closes. A body that is not
  an address is 400; while email is off the route is 404. A plain HTML
  form may post it too (`email=`).
- **Only an added address gets a link**: a 15-minute link and a
  six-digit code in one plain email. The digits are whole, never
  spaced, so the system's one-time-code offer finds them. A new ask
  leaves the earlier live links working, so nobody's ask kills
  another's.
- **Caps**, counted on `link_asks`, kept a day whatever became of their
  links: `ASKS_PER_USER_DAY` (3) per person a day from one browser,
  counted per challenge so a stranger's asks never use up the person's
  own; `ASKS_PER_INBOX_DAY` (10) per person a day across browsers,
  since a browser without the cookie gets a new challenge each ask, so
  cookieless asks flood no inbox and spend no server-wide quota on one
  person, except from a browser that already signed that person in
  (a link of theirs used to sign in holds its challenge; one killed by
  wrong codes never counts), held only to its own 3;
  `ASKS_PER_CHALLENGE_HOUR` (5) an hour from one browser
  whoever it names; `ASKS_PER_HOUR` (50) per server. Over any, nothing
  is sent and `link ask capped` is logged. Asks, codes and links used
  share `ASKS_PER_MINUTE` (10) per client address, past which the
  answer is 429 with `Retry-After`. Invites are not counted.
- **A link is `<public url>/ui/link/<token>`**, the public URL from the
  SMTP settings, never a request's `Host`. A `GET` never acts, since
  mail scanners open links: it draws a page in the sign-in's look that
  loads no script, font or stylesheet, with a button that posts back
  and `no-referrer` set twice (meta and header), so the token never
  leaves. A dead link reads as an unknown one, with a form that asks
  again.
- **Only `POST /ui/link/<token>` acts**, in one conditional update
  (unused, unexpired, its person still there) in the transaction that
  opens the login; it answers 303 to the landing, an invite's
  `/portfolios` (empty, with its setup) and a sign-in link's `/`, and
  ends the browser's older login. A dead one is the dead page, 404.
- **The code is for the installed app**, whose cookies on iOS are apart
  from Safari's, so a link from Mail signs in Safari, never the app.
  The ask sets `markets_ask`, a 15-minute cookie on `/ui` holding a
  random challenge (kept when the browser holds one), and the link row
  holds its SHA-256. `POST /ui/code` with `{email, code}` checks a code
  only beside that cookie, so a code guessed from another browser is
  never tried and burns nobody's tries; it answers 200 with `{landing}`
  and the cookie. A wrong code, another address, an unknown one and a
  missing challenge answer the same 401. The fifth wrong try kills the
  link (`MAX_CODE_TRIES`); using the link or the code uses both.
- **An invite, which no browser asked for, has no challenge**: its code
  is tried beside any `markets_ask` cookie, its misses counted on the
  link (`code_tries`) from every browser, since a new cookie is free.
  The fifth wrong try ends the invite's code, never its link: the
  emailed link still signs in, and the invitee can ask a fresh code.
- **The same-origin check holds `/ui/link`, `/ui/link/<token>` and
  `/ui/code`** (`sameOrigin()`, below), so no other site signs a
  browser in.

## Who is signed in

- **`GET /ui/me`** answers `{user, email_on}`: `user` is `{id, name,
  role, email, operator}` for a login, null for none, always 200 so the
  browser logs no failed request.
- **`PATCH /ui/me`** takes `{name}` or `{email}`, one at a time, from
  this server's pages. A person renames themself. The operator, who
  signs in by the admin key, may add an email to sign in by link too:
  a link without a code goes to that address, and using it only sets
  the address, only in a browser already signed in as that person; it
  never opens a login, so one sent to a mistyped address signs nobody
  in. A member's email is an admin's to change (403). It answers
  `{link: "sent"}` or `{link: "failed", reason}`; 409 while email is
  off or when another person has the address.

## Push

- **`/ui/push` is a login's own device**, never a key's: a request
  with `Authorization` is 403, one without a login 401. `GET` answers
  `{key, endpoints}`: the server's public key, null while push is off
  (`docs/alerts.md`, "Push"), and the endpoints this login saved.
  `POST` saves `{endpoint, keys: {p256dh, auth}}` as the browser's
  `toJSON()` gives it, an endpoint another login held moving to this
  one; `DELETE` takes `{endpoint}`; both answer 204, are held to this
  server's pages (`sameOrigin()`) and are 404 while push is off.
- **An endpoint is a push service's `https` URL**: a host under
  `push.apple.com`, `googleapis.com`, `push.services.mozilla.com` or
  `notify.windows.com`, no port or user, at most 2,048 characters, so
  a login never points the server's posts elsewhere. `p256dh` is a
  65-byte uncompressed P-256 key, `auth` 16 bytes. At most
  `PUSH_PER_LOGIN` (5) a login, then 409.
- **The switch is this device's** (`data/push.ts`): on when the
  browser's own subscription is among the login's `endpoints`. On asks
  the browser's permission inside the tap, as iOS requires, then
  subscribes with the server's key and posts it; off deletes it and
  ends the browser's subscription. The page registers `/sw.js` only to
  read or make a subscription; a failed registration is tried again on
  the next read or turn-on. The switch is absent while push is off on the server or
  the browser has no push, and off in iOS Safari outside the Home
  Screen app, the only place iOS pushes from.
- **The app icon counts the unseen alerts**: each push carries the
  rail's count, and the page sets the badge whenever its count changes,
  so marking Fired seen clears it; sign-out clears it too.

## What a login opens

- **A person's own rows and the market data**: every `/api/v1` route
  of scope `read`, `session` and the person's portfolio, profile and
  alerts, reads and writes, as `loginWho()` holds; an admin's login
  also the `admin` scope (`docs/api.md`, "Keys and caching"). A member
  on an admin route is 403. A key is tried first (`router()`); the
  cookie only when no key is valid.
- **Never `/mcp`.**
- **A write by cookie must come from this server's own pages**, or it
  is 403 `forbidden` (`sameOrigin()`), so a cross-site page holding the
  cookie writes nothing: `Sec-Fetch-Site` is `same-origin` when the
  browser sends it, which a proxy leaves alone; a browser without it is
  held to an `Origin` whose host is the request's `Host`, the scheme not
  compared since a TLS proxy hands the request on as `http`. A request
  with the admin key needs neither, as a script sends none.
  `POST /api/v1/screen`, a read whose filters are a body, is held to it
  too.

## What an anonymous visitor sees

- **The page, its assets, the sign-in's 401, `/ui/me`'s `email_on`,
  and the OpenAPI spec and its docs page, which describe the API of
  every install and nothing of this one**: no host path, key or key
  file name, data directory, version, source or flag name, instrument
  data, config in `index.html` or source map. The bundle holds view
  code only, with Bun's comments naming each module by its path in this
  repository; every value is read after sign-in.
  `test/web-session.test.ts` reads each anonymous answer and fails on
  any of them.
- **No help text on the page.** Where the key lives and how the UI
  works are for this doc. The SMTP drawer alone names `secrets/`, the
  directory every install keeps its key files in, so an admin knows
  where the password file goes.
- **The bundle names no source.** Names a page shows for a source or a
  job (a `label`, `about`, `credit`) come from the server's answers, and
  a wait never says which source it asks.

## The client

- **Preact and `@preact/signals`**, rendered once from `main.tsx`;
  `app/router.ts` keeps the path in a signal and opens same-origin
  links in place, the API's own pages excepted. In an installed app
  (`display-mode: standalone`) a page of the UI opens in place even
  from a link asking for a new tab, which would leave the app.
- **The tab's title is the page, then the brand** (`app/title.ts`); an
  instrument's is the symbol in its address, so it needs no answer.
- **Views never fetch.** `data/store.ts` owns every call and signal;
  `data/api.ts` makes the calls. Any 401 signs out.
- **The web UI starts from `GET /ui/me`** (`check` in the store), never
  from the status, which is an admin's: `user` null is the sign-in,
  `email_on` false shows it the admin key alone, and the person's
  `role` decides the pages (`isAdmin`). An admin's pages (`admin: true`
  in `ROUTES`) show to admins only; a member asking for one lands on
  Home and never sees Refetch, Delete or Retry, whose routes answer
  them 403.
- **A page's `load` in `app/routes.ts` runs on arrival**, and a
  sign-out clears the pages' data, so the next sign-in counts as one.
- **A later load supersedes one in flight**, the same id included, so a
  refresh tick never lands over the reload after a refetch. A sign-in
  or sign-out starts a session anew (`session` in the store): an answer
  from before it never lands, and its 401 never signs the new one out.
- **`useRefresh` reads the page again every `REFRESH_MS` (30 s)**, and
  at once when the tab comes back; it sets its timer once and calls the
  latest load, so a redraw never pushes the refresh back. Every page
  with data the server or an agent changes uses it; Connect agents
  changes only by its reader. A refresh never puts a placeholder over
  what is drawn; a failed one keeps it and shows the error. A re-read
  sweeps a hairline under the title (`reloading`), held `PULSE_MS`
  since a read lands in milliseconds.
- **A wait never looks like a broken page, and there are two.** An
  answer the server holds waits behind placeholders the size of what
  will land (`Placeholder`), never a full-page spinner, with words only
  after `SLOW_MS` (`slowFlag()`, its timer passed in so tests drive it
  with the fake clock). A symbol the server fetches for the first time
  says so at once. The read cannot tell the two apart, since it answers
  only once the fetch is done, so the instrument page asks
  `GET /api/v1/instruments/{symbol}/stored` beside it whenever it has
  nothing drawn. A failed read is `Page`'s `failed`, in a sentence by
  the problem's `code` (`unread()`; its `detail` is written for
  agents).
- **A fast switch shows no placeholders.** The page left stays on
  screen until the next one's load lands or `HOLD_MS` passes (`hold()`
  in `App`); placeholders that do show stay `SHOW_MS` (`paced()`), so a
  read landing just past the hold never flashes them. While held no
  page refreshes (`holding`), since the page left's refresh would
  supersede the next one's read, and the store keeps the page left's
  answer until the next lands (`detailId`).
- **An instrument's and a trade plan's page is drawn afresh for each
  symbol or plan** (`keyed` in `ROUTES`), so a drawer, a draft or
  Refetch's outcome never carries to the next; a refetch or delete
  answered after the reader moved on acts on nothing
  (`onSymbolPage()`). Portfolios is not keyed: its tabs move the address
  under one page.
- **Pages with a parameter** stay off the rail, which lights their
  parent: the page above in the path, or the route's `parent`
  (`/symbol/:id` names `/screener`). Views link a symbol with
  `symbolHref()`.
- **The page imports outside `src/web/` only from `src/shared/`**,
  plain files that import nothing but each other, so no server-only
  code reaches the browser bundle (`test/imports.test.ts`).
- **A deploy reloads an open tab.** Every answer carries
  `x-markets-build`, an id drawn at each start (never the version,
  which an anonymous visitor never reads); a later answer with another
  reloads the page (`buildWatch()`), so a tab never runs an old page
  against a new API.
- **Copy is short and plain**, for readers who are not technical: no
  "you", "please" or explanations, a server phrase in plain words
  (`plain()`), an error the server's phrase as a sentence (`says()`).
  The store branches on the error's `code`, never its words.
- **Browser storage is a convenience** (a tab, a sort, a fold, the
  theme, Hide amounts, the chart's settings): every read and write may
  fail, and a browser that keeps nothing starts from the defaults.
## The shell

- **1ctx's look, copied, not shared:** `style/tokens.css`,
  `style/base.css`, the fonts, the rail, strip and shell styles and the
  icons, trimmed to what these pages use. The mark is 1ctx's chip and
  sparkle with a rising price line in place of the 1 (`Mark` in
  `lib/icons.tsx`, `favicon.svg` and the manifest's icons).
- **The rail lists the pages in `ROUTES` order** (`RAIL`; More holds the
  same order), then Shared with me (each person who lets the reader see
  their portfolios, from `GET /api/v1/sharing`, a failed read keeping
  the last), Recent (the last five instruments) and the person's menu.
  Sign-out clears Recent, the sharers and the status read. Only an
  admin's footer names the server's version, and only an admin's shell
  reads the status: Server admin's icon turns red while a job fails or
  a source backs off (`troubled`). The Alerts row counts the alerts not
  seen yet (`GET /api/v1/alerts/seen`). The rail folds to a strip on a
  wide window.
- **A phone navigates from a bar** (`app/Bar.tsx`) wherever the phone
  check holds (`onPhone`, `PHONE` in `app/shell.ts`: narrow, or a short
  touch screen, so a phone on its side too): one capsule over the
  view's foot, clear of the home indicator and Safari's own toolbar
  (`--bar-bottom`), each slot lit for its pages (`barLit()`). Search
  opens the page's own symbol search as a sheet, off while the page
  leaves it out. `.shell-main-bar` adds the bar to the page's bottom
  inset, so the last row ends above it.
- **The bar hides while a text field outside it has the focus**, so it
  never rides the iOS keyboard. It asks `document.activeElement` again
  on focusin, after focusout, on every address, on the visual
  viewport's resize and, while away, on any change to the page
  (`watchTyping()`): WebKit fires no focusout when the focused field
  leaves with a drawer, the sheet or a page. Every drawer and the
  search sheet sit above it (`--z-drawer`, `--z-sheet` over
  `--z-shell`).
- **More is the shared `Drawer`** with the rail's other pages, Shared
  with me, Recent and the user menu's items (`UserItems`). Any step to
  another address, Back included, closes it (`watchMore()`), so no page
  opens under it. It renders beside the bar, never inside: the bar's
  blur would hold a fixed drawer inside it.
- **The sign-in's code is six boxes** (`CodeBoxes`, rules in
  `SignIn.model.ts`): a paste or the system's one-time-code fill (the
  first box's `autocomplete`) fills every box from where it lands, and
  the sixth digit signs in, once (`oneAtATime`), with no button. A code
  taken whose person could not then be read offers a retry that reads
  `/ui/me` again, never posting the used code (`codeFlow`). The line
  under the boxes keeps one height for every state, so the boxes never
  move.
## Design

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
- **Two widths, tablet and phone**, plus `pointer: coarse` for finger
  targets and reduced motion; `.hide-*` and `.show-*` in `base.css`
  hide an element at or above them. What draws by the phone check (the
  bar, the search sheet, the chart) uses `onPhone`, never a width, so
  the drawing and the layout never disagree.
- **One head on every page** (`Page`): the title, the symbol search,
  the page's actions, the ⋯ menu last, its buttons one style in
  `ui/page.css`; a page's one way to add is `AddButton`. The head never
  wraps or scrolls sideways. `back` puts Back before the title on a
  phone only, stepping through the app's own history (`goBack()`), and
  from a page opened cold goes to `/screener`, since `history.back()`
  there would leave the app.
- **The page head is a containing block for fixed elements**: its blur
  (`backdrop-filter`) holds a fixed descendant inside it, so a sheet or
  popover fixed to the window turns the blur off while open.
- **A card is only around a list, a table or a form.** A row that opens
  something shows it by hover and pointer; nothing opens as a strip
  under its row: forms and details open in the `Drawer`. Escape closes
  it once (a search's words first) and the focus returns where it was;
  nothing closes it while `busy`, and a `swaps` drawer never trades
  itself for the row behind it.
- **One large figure per hero. Every number is mono tabular** (`Num`),
  a change coloured (`Change`); a coin is named without its quote
  currency.
- **A formatter two pages use lives in `lib/format.ts` or
  `lib/names.ts`**, never in a page's model; a page may reuse another
  page's data helpers.
- **`Table` rows are each their own grid**, so a column width never
  sizes to its content (`auto`, `max-content`): columns would stop
  lining up row to row. A control in a cell takes `.table-raise` to sit
  over the row's link.
- **Hide amounts is one setting for every page with the owner's
  amounts** (`Amounts.tsx`): it blurs figures of class `amount`, a
  percent staying readable.
- **`Spark` and the hero lines are inline SVG whose strokes are CSS
  tokens**, so they wear the theme from the first frame.
- **`SymbolSearch`** asks `GET /api/v1/symbols`, upstream from two
  characters after a pause, a newer query aborting the older. On a
  phone it is a full-screen sheet opened inside the tap
  (`openSearch()`), so iOS opens the keyboard; `searchShown` counts
  the searches on screen, so the bar's slot is off without one. Adding
  to a section stays a desktop edit.
## Pages

### Home

- **Home** (`/`) is each person's own dashboard, from one
  `GET /api/v1/dashboard` (`docs/api.md`, "The dashboard"): named
  sections the person creates and orders, each as cards or a table,
  under four tabs. `Dashboard.tsx` is the view; the rankings, rows and
  layout edits are `Dashboard.model.ts`, which has no DOM and is
  tested.
- **Seeded from World markets until the first save**, so a new
  person's Home shows the world's markets; the first edit saves that
  layout with the edit, and from then on only its own saves, or
  deleting an instrument on it, change it. Removing everything leaves
  an empty dashboard, never the seed again. Every World markets entry
  stays tracked either way. While an entry still resolves (the answer's
  `track`) the page re-reads every few seconds and offers no search,
  Edit or view switch: a save then would end the seed without the
  entries still on their way.
- **A flipped index shows its futures** (the item's `futures`): the card
  draws and links the futures, so their price never passes for the
  index level (`entryOf()`); the index's averages, movers and trends
  stay the index's.
- **A save sends the whole layout** with `PUT /api/v1/dashboard`
  (`saveLayout()`), shown before the answer; edits made while a save is
  in flight go in one more save on the revision it answered, so none is
  sent on an old one. A refused save puts the last saved layout back; a
  409 takes the layout another tab saved. A load asked before an edit,
  or answered with an older revision, never lands over it. A sign-out
  drops a save in flight.
- **Edit is a draft** (desktop only, `editOf()`): every change stays in
  the draft until Save sends it on the revision it was copied from, or
  sends nothing when it matches (`saveOf()`). A save from another tab
  since, even one a refresh already shows, is a 409 that ends the edit
  and shows that save, never overwritten; any other failure keeps the
  draft. Outside Edit, Add and the view switch save at once. A phone
  has no editing but keeps the view switch.
- **The tabs** show a count only above 0 (`glanceCount()`); the last
  one chosen is kept per browser. A person without a portfolio has no
  Wealth tab (`glanceTabs()`); until the portfolios are read the tabs
  follow the last answer kept per browser (`wealthShown()`), so a Home
  without Wealth never draws its loader first.
- **Wealth** (`NetWorth.tsx`, rules in `NetWorth.model.ts`) is the
  Portfolios hero for net worth, from `/portfolios`, `/holdings` and
  `/holdings/net-worth` in the display currency (`loadWorth()`, the
  person's own only), read again only while it is the tab shown. The
  series is kept through the owner's day (`keptSeries()`), its past days
  being stored rows, and ends on the band's figure. Its bar is Invested
  against Cash, its line the series' `total`. Nothing moves while it
  loads: the loader draws the band's lines at their heights and the
  legend at the widths last drawn, kept per browser, never an amount
  (`shapeOf()`).
- **Trend**'s distances and crosses are the server's `averages` and
  `crossed_today`, never worked out here; its count is the crosses.
- **Earnings** lists the favourite shares reporting today and the six
  days after it in the viewer's own calendar, from
  `GET /api/v1/earnings` at most the route's 100 shares a call. A
  failed call keeps the list, an answer older than the newest asked
  never lands, and a share a save removes leaves at once. Only a source
  that is off, or no share answered at all, says earnings are not
  available, never that none report.
- **The head's search** adds a result to a section at once, the save
  fetching a new symbol before its card lands; an add the server would
  refuse says why in the results. **No favourites** shows example chips
  that only fill the search: the code names no default instrument or
  market.
- **A section's tiles** are as many to a row as fit, one fewer or more
  when that would leave one alone on the last row (`tileColumns()`).
  Open or Closed is the server's `session`, never hours kept here.
- **A card's line is one bars call per card, in parallel**, each drawn
  as it lands, by the item's `intraday`: `interval=5m` (the newest
  session split at its `previous_close`, the whole session wide, so a
  morning fills only the morning: `Spark`'s `slots`), else a month of
  daily bars split at its first close; the bundle names no source, so
  the server says which items have 5-minute closes. A line that fails
  keeps the one drawn before (`sparkOf()`). A load is stale once the
  path changes, and a save that lands after leaving starts no load, so
  leaving asks no line after it (an effect's cleanup runs too late).
### Server admin

- **Server admin** (admins only) is one page of three tabs, each its
  own address and loading only its own answer: Status (`/admin`,
  `Status.tsx`), Settings and Users (`Admin.tsx`, calls in
  `data/admin.ts`, words in `Admin.model.ts`). The tabs are drawn
  above a tab that did not load too, so the others stay in reach.
- **Status** draws `GET /api/v1/status` (`docs/admin.md`, "Status"),
  the jobs grouped per source that is on, never one that is off: most
  servers never turn a regional source on, and an off source has
  nothing to fix. Failing jobs come first. Retry failed jobs is off
  unless an instrument is failing (`retryable`), since a market's job
  asks again on its own. Missing closes (`owed`) never shows: it only
  marks a day for the bars job to ask again, so it cannot fail. A pause
  shows only as a count, since the job that hit it shows the error.
  The source switch shows only when it failed: it runs once per change
  of flags, not on a schedule. Add a source lists the keyed sources
  that are off.
- **Users** (`GET /api/v1/users`) invites, edits, signs out and removes
  people, each removal asked once with the counts its dry run answers;
  the operator's and the reader's own role are locked, and nobody
  removes their own row. The reader's own name saves through
  `PATCH /ui/me`; the operator's own email is set by a confirming link
  and shown only once it is used. While email is off, the card opens
  the SMTP drawer on Settings (`emailAsked`, dropped by any step off
  Settings).
- **Settings** holds the SMTP drawer: the password file is a menu of
  `key_names`, never typed, and a saved file that is missing says where
  to put it. Only the operator saves, removes or tests: another admin
  sees the form read only. A save or a remove sets `email_on` for the
  sign-in page at once.
### Alerts

- **Alerts** (`/alerts`) is the person's price alerts
  (`docs/alerts.md`) in two tabs, Rules (`/alerts`) and Fired
  (`/alerts/history`). The page says "rule" and "fired" to its readers;
  the API says alert and trigger. `Alerts.tsx` is the view,
  `data/alerts.ts` its calls; an alert read as words and its order are
  `Alerts.model.ts`, which has no DOM and is tested. It parses each
  `when` with the server's own parser (`src/shared/when.ts`) and names
  every field in `WHEN_FIELDS`, so the server's names never reach the
  page.
- **The server says how close and in what state; the page never works
  it out.** Distance is the alert's `gap_percent`; the badge maps
  `state` (`stateOf()`): `watching` reads Met when every comparison
  `holds` (the next quote triggers it; a rounded `gap_percent` of 0 is
  not met; a met close alert triggers at its close instead), and
  `unknown` tells a price that did not come in from a check that cannot
  run. A close alert's condition line ends "on the close" or "on the
  weekly close"; the page's add form makes touch alerts only.
- **Rules** reads every page of `GET /api/v1/alerts` with each alert's
  `now` and `instruments`, filtered in the page, nearest first, a
  symbol's alerts together and paused last. A row's drawer ticks each
  comparison from `now[i].holds`, links the owner's active plans
  tagged with the symbol, and pauses, resumes or removes it (asked
  once). The page adds only a price above or below a level on
  one symbol (`POST /api/v1/alerts`), waiting on the symbol's price and
  saying when it did not load; agents make the richer ones.
- **Fired** reads `GET /api/v1/alerts/history`, newest first, a page
  at a time. The newest trigger leads, large, with what triggered: its
  words come from its `when` and `values`, a close alert's ending with
  the close it read, in the push's words ("at the 13 Nov close",
  `closeName()` in `src/shared/when-words.ts`). The rest split into
  those still met and those no longer met (`historyGroups()`). A
  trigger is still met when it is its alert's newest (an alert fires
  again only after its condition went false), the alert is kept with
  the same condition, has not been watching again since (a close
  alert re-arms on a false close), is neither paused, split-paused nor
  unknown, and every comparison holds as `when` joins them
  (`metOf()`); else it
  is no longer met. A no longer met trigger's tag is the first
  comparison's side and `gap_percent` ("Back above · 0.2%"), only
  between price levels; any other has none. Each figure is the
  symbol's price now, else the first comparison's reading by name
  ("RSI 34.5", "50-day average 165.00 EUR"). Each row's Plan opens the owner's active plans tagged with
  the symbol, from the plan list read when the tab opens and every 30
  seconds. Opening the tab marks the newest seen
  (`PUT /api/v1/alerts/seen`); the ones newer than the last visit keep
  a dot until the tab is left. A failed refresh says so over the rows
  still shown (`stale`).

### Profile

- **Profile** (`/profile`) is the owner's profile (`docs/profile.md`).
  `Profile.tsx` is the view, `data/profile.ts` its calls; the size, the
  outline and what each toolbar button types are `Profile.model.ts`,
  which has no DOM and is tested. The page shows the `html` of
  `GET /api/v1/profile`, drawn on the server so the bundle ships no
  Markdown parser and any HTML in the text comes back escaped.
- **An author reads "you"** for a save by the reader's own login, the
  admin key (`admin`) or an older login (`web`); another person's name
  or a key's reads as itself (`authorWords`), as Portfolios' does
  (`enteredBy`).
- **No profile yet** opens the editor on a generic outline for any
  investor; Save is on for the outline as it is, since a first profile
  has nothing to be unchanged from.
- **The editor** (`useEditor()`, shared with the analysis and trade
  plans) has Write and Preview. A toolbar button wraps the selection or
  marks each line it touches through `execCommand("insertText")`, so
  the browser's undo takes it back. Preview asks
  `POST /api/v1/profile/preview`, which draws the draft as a save would
  and keeps nothing, so the preview is the server's own drawing. The
  foot counts the UTF-8 size against the cap; Save waits on a change
  and sends the revision it opened. A stale save keeps the typed text
  and says to copy it and reload, so nothing typed is lost to a newer
  save. The page's refresh holds while the editor or History is open,
  and the editor keeps the revision it opened with, so neither a save
  nor a restore is checked against a revision it never showed.
- **History** lists the kept revisions; Restore saves a revision's text
  on the live revision, so a newer save refuses it instead of being
  overwritten, and the profile is read again before a second try.

### Trade plans

- **Trade plans** (`/trade-plans` and `/trade-plans/{id}`) are the
  reader's own plans (`docs/trade-plans.md`), never another person's,
  never an order. `TradePlans.tsx` is the view, its card on an
  instrument page `InstrumentTradePlans.tsx`, `data/trade-plans.ts` the
  calls; the filters, the card's list and the words are
  `TradePlans.model.ts`, which has no DOM and is tested
  (`test/web-trade-plans.test.tsx`). An address whose id is no plan's
  (`planIdOf()`) says so without asking the server.
- **The list** reads every page of `GET /api/v1/trade-plans?status=all`
  once and filters in the page: Active (the default), Archived, All and
  Deleted, which alone reads `status=removed`, only once picked, so a
  deleted plan can be found and restored. A symbol filter stays while
  its symbol is picked that no plan holds any more, so it can be
  cleared. The filters stay while the reader moves about the app and
  reset on sign-out. Review due is the answer's `review_due`, never
  worked out here. A failed refresh says so over the rows still shown.
- **New and Edit are one drawer** with the profile's editor. Edit sends
  the fields changed first (`PUT {revision, ...}`), so a taken name or a
  symbol that does not resolve stops it before the text is sent, then
  the text at the revision the first left: two revisions when both
  change, since the server's write takes one or the other. A stale
  save keeps the typed text as the profile's does, every later save in
  the same drawer is refused the same way until the plan is reloaded,
  and when only the text was stale it says the fields saved.
- **A plan's menu** archives, unarchives, deletes (asked once) and, on
  a deleted plan, restores; a deleted plan has no Edit. Every refusal
  shows in the server's words, and the plan and the list are read again
  either way. History is the profile's drawer on the plan's `versions`.
  The page's refresh holds while either is open.
- **Opened from an instrument** (`tradePlanHref()`), the read asks
  `?symbol=` and scrolls to its first section's `anchor`, the heading's
  `id` the renderer gave it, once per arrival.
- **The instrument page's card** reads
  `GET /api/v1/trade-plans?status=all&symbol=<id>`, the reader's own
  only, lists the active ones and offers the archived; no card when the
  reader has none for the symbol, archived ones included. A failed read
  keeps the last answer.

### Connect agents

- **Connect agents** (`/connect`) lists the person's keys from
  `GET /api/v1/keys`, counted against the answer's `limit` (`capLine`),
  and makes, changes and revokes them. An admin's list holds everyone's
  keys, each owner's name under the key's; another person's key opens
  with its picks off, Revoke only. A key's access shows only what it
  has, on one line grouped by level (`Writes everything`, `Writes
  portfolios, alerts · Reads the profile`). A new key's
  access is none by default (the profile and trade plans are personal,
  so a key reaches them only when picked). At the cap, New key goes. A
  revoke that answers 404 drops the row and its drawer.
- **A made key's token lives in the Connect agents view alone**: the
  store keeps the key's row, never its token. It shows once, in the
  drawer that made it, and goes on Done, on any close of the drawer, or
  on leaving the page.
- **No setup line carries a token.** Each reads `MARKETS_ACCESS_KEY`:
  Claude Code's header in single quotes, so the shell never writes the
  key into its config, Codex's `bearer_token_env_var`, OpenCode's
  `{env:...}` with OAuth off. The server's address is the page's origin
  plus `/mcp`.
- **Copy uses `copyText()` (`src/web/lib/clipboard.ts`)**: the
  clipboard exists only on loopback or HTTPS, so on plain HTTP the
  button stays as it is and never says Copied.

### Portfolios

- **Portfolios** (`/portfolios` and `/portfolios/{id}`) reads
  `GET /api/v1/portfolios`, the holdings and the trades with removed
  ones in one load (`data/portfolios.ts`). The page is `Portfolios.tsx`,
  its forms `PortfolioForms.tsx`; its words, numbers and rules are
  `Portfolios.model.ts`, which has no DOM and is tested
  (`test/web-portfolios.test.tsx`).
- **No currency is built in.** With nothing converted and two or more
  currencies, the largest currency's total is the one large figure and
  the others lines under it; nothing in two currencies is summed, so
  the group labels show no total or share (`mixed()`). The currency menu
  offers what the server converts into (`currencies()`), each held
  total with its rate (`rateLine()`), and what a total left out
  (`missingWords()`).
- **The hero's day change** shows only when something in view moves
  within a day (a quoted or listed price; cash, a hand-priced fund and a
  face-value bond never do), "—" when it is null, never hidden as no
  move (`heroOf()`, `signedOrMissing()`). **The bar** (`barOf()`), shown
  only when both sides are above 0, is on All Invested against Dry
  powder, the two parts of All's value, which leaves reserve out
  (`docs/portfolios.md`), and on Cash Dry powder against Reserve. All
  portfolios is not net worth, which Home's Wealth tab, the API and the
  tool answer.
- **A view of bonds alone reads as a broker's bonds page**
  (`bondsOnly()`), and no other view changes: the 3M column becomes the
  next payout (amount over day), the price is headed Price at full
  strength, the gain sits under the value with no Gain column, and the
  hero adds the totals' next payout on its own line (`heroPayout()`)
  and a bar split by currency from the rows' converted values, accrued
  interest in (`currencyBarOf()`). On a phone a bond's line is its next
  payout (`bondPhoneLine()`, `payoutWhen()`). A bond's drawer lists its
  accrued, coupons paid and next payout (`interestFacts()`); its edit
  reads the coupon schedule from the row's history, since the holdings
  leave it out (`scheduleEdits()`). A price problem's tag shows before
  a missing coupon schedule's (`staleTag()`).
- **The value band follows the view its figures were read for**
  (`shown`, set with the holdings): a tab picked moves `portfolio` at
  once, but the name, bar and line change only when its holdings land,
  in the same frame as the figures.
- **Growth** (`PortfolioGrowth.tsx`, rules in
  `PortfolioGrowth.model.ts`) is the holdings' gain (value less money
  put in, cash left out) per day over the past year, from
  `/holdings/growth` or `/portfolios/{id}/growth` in the view's
  currency, with no axis or figures, so Hide amounts leaves it as is.
  None on Cash, which draws all cash per day instead, on a view of cash
  alone, under two days held, or when its read failed.
- **One line for every hero** (`HeroLine`, `linePath()`): Home's net
  worth, the Cash tab's cash and the other tabs' growth share its slot,
  look and fade. Its scale spans at least 2% of the value it is drawn
  against (`MIN_SPAN`), so a flat stretch never fills the height.
- **The Cash tab's line** (`useCash`) is the person's own Cash only,
  never one shared with them (`hasCashLine()`, net worth being the
  caller's own): the `cash` of `/holdings/net-worth`, today's being the
  hero's figure (`cashPoints()`), read once per currency and never on
  refresh, Home's series standing in when it is in that currency. A
  save drops the kept series, as a balance dated in the past moves its
  past days; a read a save overtakes is asked again, since the page has
  no series left to ask on.
- **The line never flickers.** Each view's series is kept for the
  page's life by `growthKey()` (the view, the currency, the live trades'
  ids, a fund's hand price and a bond's face, cost and date) and read
  in the render, so a tab seen once draws at once and a new tab never
  shows the last one's line; a refresh reads nothing. A save keeps the
  view and currency (`growthScope()`), so the last line stays until the
  new series swaps in. Otherwise an empty slot holds the place and a
  first draw fades in.
- **The figure is never cut, wrapped or rounded unasked** (`heroFit()`):
  measured before the first paint, once the fonts land and on every
  resize, the line goes under it, then it shrinks, then it reads short
  (`shortMoney()`) with the full figure in its title. Back beside needs
  more room than going under, so a figure near the edge moving with
  each quote never flips the line.
- **The view is the address** (`addressOf`, `viewOf`): the portfolio's
  id in the path, `currency` in the query unless it is the display
  currency. A portfolio picked is a new history entry, so Back returns
  to the one before; a currency picked, or a fallback to all when the
  portfolio is gone, replaces the address. Anything else reads as all.
- **Holdings**: every word typed in its search must match some field
  (`holdingMatches`). Reserve rows are not listed on All
  (`isReserve()`), since All's value leaves them out. Rows group
  (`groupsOf()`) on All by portfolio in the server's order, inside one
  by kind and cash by what it is for (dry powder first, as the bar
  reads), else the largest first; a closed group is kept per view
  (`shutOf()`). A row the server could not convert counts in no group
  total. A column nothing in view fills goes (`columnsFor()`), and a
  row with nothing to sort by sorts last (`sortRows()`). A row opens its
  instrument page (`pageOf()`), else what edits it (`homeOf()`); a
  hand-priced fund's page is never opened for a viewer of shared
  portfolios, whom the server never shows it. Amounts show whole from
  1,000 up (`money()`), else in the currency's minor units
  (`minorUnits()`).
- **A cash row's drawer** (`CashSheet`) has one box: a figure sets the
  balance, a signed one moves it (`balanceChange()`, the tool's `amount`
  and `by`); the same balance saves nothing. It stays open as an update
  gives the row a new id (`onMoved`), the page keeping its last row
  until the new one lands. Its history (`historyLines()`) shows each
  change, none across currencies, a note's change named but never its
  text, removals and restores told apart as the tool's `history` does
  (`endOf()`), no author, dated on the owner's calendar (UTC's until
  they set a zone, `dayIn()`). Its step line is never tighter than a
  fifth of the balance, so a small change reads small. A past balance
  takes a day before the row's own (`pastBalance()`), so a statement's
  balance goes in without touching the row.
- **A typed number** (`typed()`, every form) reads commas as thousands
  only in groups of three after a leading 1 to 999 (`12,400`,
  `1,234,567.5`), else a lone comma as the decimal (`0,125`, `12,4`).
- **An edit starts from the stored amount**, never the value rounded
  for show, and sends only what changed (`cashEdits()`, `figureEdits()`;
  an emptied broker or note as null, which takes it off). A new cash
  amount moves an untouched date to today (`cashDate()`), as a new
  balance is true now, and back when the amount is set back, so a typo
  fixed on the old date keeps it. A merged bond edits each purchase,
  since it has no one position.
- **Activity** folds the fills of one order (one day, portfolio,
  symbol, side and broker) into one row at the average price
  (`foldFills()`), and counts orders; Remove takes every fill together.
  A trade's dates are on the owner's calendar (`dateIn()`).
- **Add** opens on the kind the portfolio holds most (`addKindOf()`).
  A share starts at its live price, a fund at its latest; a past date
  takes that day's close, a fund's price on or before it, until the
  owner types one. A pick reads the listing
  (`GET /api/v1/instruments/{id}`) and shows where it is held now in
  every portfolio, and the price field takes the live price, so what is
  saved is what is shown; that price is the listing's currency's, so
  picking another currency paid clears it and the server converts.
  The trade search (`searcher()`) ranks shares, ETFs, funds and crypto
  before futures and the like (`ranked()`).
- **The portfolio is where the listing is already held**, else the tab
  on, else the only one, else the owner picks: never a silent first
  one. The trade, fund and bond pickers leave Cash out, since it holds
  only cash; Add cash sends no portfolio, so the server puts it in
  Cash. A sell of all is sent as `"all"`, so the server sells what is
  sellable on the trade's date. A fund buy is one confirmation
  (`POST /api/v1/funds/trades`); a fund with a symbol is a trade.
- **A buy may pay from dry powder** (`dryPowderFor()`): the row at the
  trade's broker in its currency, else the one in its currency, else
  the owner picks. After the trade saves, that row is lowered by its
  cost (`PATCH /positions/{id}` with `by`, which the server converts);
  a failure there says the buy is saved and the dry powder was not,
  and the form then only closes, so a second press never records the
  buy twice.
- **A save waits in the drawer**, a line reading the trade back first.
  A refusal shows in plain words, its ids taken out (`plainError()`). A
  retried trade the server refuses offers to save again with `again`,
  for a second fill that is the same.
- **Import** previews every line before saving the ready ones.
  Changing the portfolio or broker clears the file and its preview, so a
  preview read for another is never saved; the pickers are off while
  it reads, and only the read asked last lands.
- **Settings** renames, deletes and orders the portfolios and brokers,
  saved at once; Cash is fixed, and the tabs and every pick read the
  server's order, never sorting again. The display currency is a
  picker over the ISO 4217 currencies in circulation
  (`src/shared/currencies.ts`, names from `Intl.DisplayNames`), the
  time zone the app's own menu over every zone the browser knows
  (`findZones()`). A first visit asks for a portfolio, the currency and
  the zone, the browser's zone a suggestion the owner sees before
  saving (`browserZone()`). Date fields start on the owner's today,
  the UTC day until a zone is set (`today()`), as the server dates a
  position. **Shared with** switches each other person's view of all
  the reader's portfolios, waiting off while its request runs.
- **Another person's portfolios** (`/portfolios/shared/<person id>`,
  `SharedPortfolios`) are the same page drawn from the owner's data,
  every read with `owner` (`markets.shared`, a store of its own), with
  no write anywhere. Added by names whoever the row names, never "You".
  Opening another person's page drops what the last one drew, so one
  person's figures never show under another's name. A 404 (the share
  ended, or the person went) drops the figures and reads the sharers
  again, so the rail's row goes. The route is `apart`: the rail's
  Portfolios stays unlit there.
### Screener

- **Screener** (`/screener`, `Screener.tsx`, model
  `Screener.model.ts`) screens the instruments kept up to date, from
  `GET /api/v1/screener` (`docs/api.md`, "The screener"): the server
  reads every stored figure in one query, so the page never asks a
  symbol at a time and stays cheap at thousands. The list has no search
  of its own, since the head's reaches every symbol.
- **The stored kinds are tabs**, two kinds said alike one tab
  (`typeTabs()`), and a type narrows the counts and the list. Five
  ready-made screens and no filters: the owner picks one question
  (`SCREEN_TEXT`), and a screen with no match says why.
- **Every column sorts on the server but Price**, since prices are in
  different currencies; each screen starts on its own order and a
  screen picked resets it. A yield's returns are in points. The list
  never quotes: a quote is a read and would keep every row tracked.
- **The ask (type, screen, sort) lives in the store** (`screenAsk`), so
  a refresh or coming back keeps it; the answer on screen stays until
  the next ask's lands. Show more reads the next page by its token; a
  refresh reads again as many rows as are shown, and a second load of
  the same ask joins the one in flight.

### An instrument

- **An instrument** (`/symbol/<id>`, the id encoded) reads
  `GET /api/v1/instruments/{id}`, a read as any client's, so opening it
  keeps it tracked and an id never stored is fetched. `Instrument.tsx`
  is the page, its parts each their own `Instrument*.tsx` with their
  words and numbers in `Instrument*.model.ts`, which have no DOM and
  are tested (`test/web-instrument.test.tsx`).
- **The head is the price alone**, then the chart: returns in the head
  pushed the chart below a phone's first screen. The state never says
  "updated", since a close does not age: a closed market counts down to
  the quote's `opens` (the viewer's clock time from 12 hours, plain
  Closed once it passes), an open one says when it last traded, and a
  fund the owner prices names its price's day (`kind` `hand_price`).
  Pre or post trading is a line under the figure, never a second
  figure. A failed read shows the stored price and its age with one
  notice; the server's phrase is for agents.
- **The cards under the chart** are answered by name from the model
  (`signalsOf()`, `positionOf()`, `fundOf()`), never a list the view
  searches by title, and a card with nothing in it is left out, so a
  young listing or a series shows less. Your position matches
  `GET /api/v1/holdings` (every portfolio) on the instrument's id, in
  the holding's own currency. Returns are the quote's, never
  recomputed. Trend names a cross only on its day and a turn of the MACD
  histogram as the day's note, since a turn comes on either side; a
  yield's distances are in points, and any other distance to an
  average at or below 0 is left out, as the server's, since a percent
  of it says nothing. A fund's top holdings link their page by `id`
  when stored, else by symbol, fetched as the page opens.
- **A fund the owner prices** (`fund:<ISIN>`) draws a line through the
  entered prices only, opening on 1Y with its range never saved as a
  share's, each of the caller's trades an arrow on its bar
  (`tradeMarks()`). Its drawers render in the page body, and the page
  reloads only when a save changed the holdings.
- **The head's + only where a trade buys** (`buyable()`): a share, an
  ETF, a mutual fund, a coin, a fund the owner prices; never an index,
  a future, a currency pair, a series or a listed bond.
- **One More menu holds the page's actions**: Write analysis while the
  symbol has none (once its read has landed), and for an admin Refetch
  data and Delete. Refetch asks every part `choices()` lists
  (`POST /api/v1/instruments/{id}/refetch`); a failure names the part
  in plain words, and a 404 reads as no longer stored. A delete a rule
  blocks (409 with `rules`) is refused, and a delete returns to the
  list.
- **The analysis** (`docs/analysis.md`) is one card once one is
  written, and nothing before: a symbol mostly has none, and an empty
  card on every page is noise. `InstrumentAnalysis.tsx` is the view,
  `data/analysis.ts` its calls on `data/document.ts`. The card shows
  the move since its save and earnings reported since. Edit opens the
  profile's editor, a first note saying everyone on the server can read
  it; a save closes the drawer once its busy ends, and closing the
  drawer reads the analysis again. An author reads as you only for the
  reader's own saves, the admin key's as the admin, since it is no one
  admin's.
## The chart

- **TradingView Lightweight Charts** (`views/Chart.tsx`), loaded with
  the first chart; the compiled binary does not split the page, so the
  library ships in its bundle either way. Its data is
  `GET /api/v1/instruments/{id}/bars`, a read, shaped in
  `Chart.model.ts`, which has no DOM and is tested.
- **A phone draws the chart as a phone chart app does.** What the chart
  offers and draws is one `Look` picked from `onPhone` and carried to
  the stylesheet by `chart-phone`, which has no width rule of its own,
  so the drawing and the layout never disagree: the price alone as a
  line, no toolbar (a choice kept from a wider window is drawn as off,
  not lost), the plot naming its own levels (`levelsOf`, `placeMarks`)
  a frame after each fit. A kept range a phone does not offer stays
  kept; the phone draws its neighbour.
- **Ranges** (`RANGES`, 1D by default): 3Y and up read weekly bars
  (`intervalOf`); Max is the ten years the server keeps. 1D and 5D only
  where the route's `intraday` is true (`rangesOf`); there a kept 1D or
  5D draws 1M (`drawnFor`) and stays kept. Only a range clicked is
  saved.
- **A daily range's change is the server's return** for the same period
  (`periodStart` in `src/signals/relative.ts`, `src/shared/periods.ts`):
  from the last close on or before its start, dated from the last bar,
  so the readouts equal the page's returns. The bars are asked from two
  weeks before the range (`askedFrom`), so that close is there across a
  weekend or holiday, and a slow series with none there is read again
  from Max (`readRange`). A range that starts before the listing's first
  bar is named "since" it, never claiming a return the server has none
  of.
- **1D and 5D read `bars?interval=5m`** on a time axis at the points'
  real UTC times (`pointLine`), so a clock change never reorders or
  drops one; only labels are in local time (`localTime`, `timeLabel`).
  The change is from `previous_close`, else the first close. A price
  outside the session is named Pre or Post, since the close is the
  regular session's alone.
- **1D is a baseline at the previous close**, kept in the scale, with
  pre and post trading drawn faded and joined to the session
  (`extendedLines`, which drops a bar sharing the closing trade's time),
  and spans its whole session to the close (`sessionSlots()`), so the
  first minutes are a short line, not the whole width. A scale number a
  price tag would cover is left blank (`clearOfTags`). Every other line
  is an area in the colour of its move.
- **Candles only where the bars have an open**, a bar the live quote
  made with no open taking the last close; volume only where the source
  gives it. The averages are `history`'s, never recomputed, in tokens
  checked for colour blindness against `--card`; a toggle and its
  legend entry wear the stroke too, so identity is never colour alone.
- **The legend is its own rows above the plot**, held at its tallest
  since the averages or the bars' kind last changed, so the plot never
  moves. It names the range its bars were read for, not one loading. It
  follows the crosshair only once the pointer moves over the chart
  (`pointerAt()`): a browser repeats a resting pointer's place after a
  redraw, which is no bar picked. At rest the latest bar, whose averages
  fall back to the last there are (an open week has none).
- **A range not drawn yet** leaves the plot's box empty at its size; a
  refresh keeps the bars drawn. The first draw waits for the mono face
  (`document.fonts.load`), which the canvas takes when it draws. The
  axis drops cents from five figures up (`axisPrice`), so a phone's
  axis stays narrow.
- **The chart neither pans nor zooms**: the ranges choose what shows,
  and every draw and resize fits it.
- **Colours are read from the tokens on every draw**, and a theme flip
  draws again; the page's colours (`paintOptions`) are set on every
  draw, bars or none, and the canvas box wears `--card`, since the
  library's white default would flash on a dark page for the whole data
  call.
- **Settings are kept per browser** (`chart`), one set for every
  instrument; a broken value starts from the defaults field by field.
- **The credits are the page's footer**: the price source from the
  server's `credit`, since the bundle names no source, and TradingView's
  link, which its licence accepts in place of the logo; the NOTICE text
  is in `Chart.tsx`, the package shipping none. It shows on the
  instrument page, and on Home with FRED's notice when the dashboard
  carries its `attribution`.
## Tests

- **No DOM and no network:** views render with
  `preact-render-to-string` from fixed answers, and the data layer takes
  a fake fetch (`test/web.test.tsx` and a `test/web-*` file per page or
  part).
- **`test/web-session.test.ts`** holds the server side: the token, the
  cookie's attributes, the identical refusals, what the cookie opens,
  the `Origin` check, the page served, and what an anonymous visitor
  reads, the API spec and docs page included. Swagger UI's own files
  are checked for secrets only, since its bundle names Yahoo among web
  domains and its stylesheet names a source map. `scripts/smoke.sh`
  checks the binary serves the page and the sign-in.
- **Push** is `test/web-push.test.tsx` with a fake device and
  `test/push.test.ts` for the server's side.
