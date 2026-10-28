# Web UI

Governs the operator's web UI: its sign-in (`src/server/session.ts`),
the paths that serve it (`UI_PATHS` and `serve()` in
`src/server/http.ts`) and `--no-ui`. The admin key is
in `docs/admin.md`, the routes the UI reads in `docs/api.md`, flags in
`docs/config.md`.

## Why

Status, refetch and delete were reachable only through `curl` with the
admin key or `1ctx-markets admin` over ssh. The UI shows the operator
what the server holds from a browser, on the server's own public host,
signed in with the admin key alone.

## Sign-in

- **`POST /ui/session` with `{"key": "<admin key>"}`** compares the
  trimmed key in constant time (both sides hashed, `timingSafeEqual`)
  and answers 204 with the cookie. `DELETE /ui/session` answers 204
  and clears it.
- **Every failed sign-in answers the same 401**,
  `{"error":"unauthorized","message":"wrong admin key"}`, with no
  cookie: a wrong or empty key, a malformed or oversized body, a body
  that is not JSON, and a server with no admin key
  (`sessions(null)`). The page faces the internet, so no answer tells
  one failure from another.
- **No rate limit:** the admin key is 32 random bytes, so guessing it
  is no threat, and a limiter would be state for nothing.
- **The cookie holds no key.** `markets_session=v1.<expiry>.<mac>`:
  the expiry in epoch milliseconds and its HMAC-SHA256 under a key
  derived from the admin key (an HMAC of a fixed label), compared in
  constant time. No table and no migration; replacing `admin.key` and
  restarting refuses every cookie made before.
- **`HttpOnly; SameSite=Strict; Path=/`, 30 days (`SESSION_MS`), and
  `Secure` unless the request is plain HTTP to a loopback host**
  (`cookieAttributes()`). A browser keeps a `Secure` cookie over plain
  HTTP only on loopback, and a TLS proxy in front sends the public
  host, so the cookie is `Secure` there. Plain HTTP to a LAN or tailnet
  address therefore cannot sign in: use loopback or TLS.

## What the cookie opens

- **The admin routes, `/api/v1/admin/*`, and every `GET` or `HEAD`
  under `/api/v1`.** The bearer and the admin key keep their own paths
  first (`router()`); the cookie is tried only when the key a path
  takes is missing or wrong.
- **Never `/mcp`, and never a write outside the admin routes** (rules
  stay the bearer's).
- **A write by cookie needs an `Origin` whose host is the request's
  `Host`**, or it is 403 `forbidden` (`sameOrigin()`). The scheme is
  not compared, since a TLS proxy hands the request on as `http`. A
  request with the admin key needs no `Origin`, as a script sends
  none.

## Off

- **`--no-ui` turns the UI off**: no `/ui/session` (it answers the
  bearer's 401 as any unknown path), and a cookie opens nothing. The
  UI is on by default.
