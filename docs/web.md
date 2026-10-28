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
- **A page's `load` in `app/routes.ts` runs on arrival**, the first
  page's being that check.
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

- **Status:** `GET /api/v1/admin/status` drawn: the instrument and
  tracked counts, the sources on, the jobs and how many fail, the
  database size and version; each source on or off and why with its
  back-off; each job's last run with its outcome, scope, rows, error
  phrase and failing scopes; each `--track` value and what it resolved
  to.
- **Instruments:** a placeholder; the list and the instrument page
  come later.

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
  its bundle names Yahoo among web domains and carries a source map. `scripts/smoke.sh` checks the binary serves
  the page, its assets and the sign-in.
