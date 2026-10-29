#!/usr/bin/env bash
# Each run starts from a fresh directory, so it migrates a new database.
set -euo pipefail

BIN=${1:-bin/1ctx-markets}
BIN=$(cd "$(dirname "$BIN")" && pwd)/$(basename "$BIN")
PORT=${SMOKE_PORT:-11239}
URL=http://127.0.0.1:$PORT
RUN=bin/smoke-$$
mkdir -p bin
mkdir "$RUN"
mkdir -p "$RUN/data/secrets"
trap 'kill "${PID:-}" 2>/dev/null || true; rm -rf "$RUN"' EXIT

fail() { echo "smoke: $1" >&2; cat "$RUN/log" >&2; exit 1; }

: >"$RUN/data/secrets/bearer.key"
"$BIN" --listen "127.0.0.1:$PORT" --data "$RUN/data" >"$RUN/log" 2>&1 &
PID=$!
for _ in $(seq 1 25); do
  kill -0 "$PID" 2>/dev/null || break
  sleep 0.2
done
kill -0 "$PID" 2>/dev/null && fail "started on an empty bearer file"
if wait "$PID"; then fail "exited 0 on an empty bearer file"; fi
unset PID
grep -q 'bearer.key' "$RUN/log" || fail "the refusal did not name bearer.key"

rm "$RUN/data/secrets/bearer.key"
"$BIN" --listen "127.0.0.1:$PORT" --data "$RUN/data" >"$RUN/log" 2>&1 &
PID=$!

status() { curl -s --max-time 5 -o /dev/null -w '%{http_code}' "$@" || true; }

for _ in $(seq 1 50); do
  [[ $(status "$URL/mcp") == 401 ]] && break
  kill -0 "$PID" 2>/dev/null || fail "the server exited"
  sleep 0.2
done
[[ $(status "$URL/mcp") == 401 ]] || fail "a request without the bearer was not refused"
[[ $(status "$URL/health") == 200 ]] || fail "/health did not answer 200 without the bearer"
for path in openapi.json docs docs/init.js docs/swagger-ui-bundle.js docs/swagger-ui.css; do
  [[ $(status "$URL/api/v1/$path") == 200 ]] || fail "/api/v1/$path was not served without the bearer"
done
# the page names each embedded file with its fingerprint, worked out at start
PAGE=$(curl -s --max-time 5 "$URL/api/v1/docs" || true)
for file in init.js swagger-ui-bundle.js swagger-ui.css; do
  ref=$(grep -o "/api/v1/docs/$file?h=[0-9a-f]\{12\}" <<<"$PAGE") ||
    fail "the docs page names no fingerprint for $file"
  [[ $(status "$URL$ref") == 200 ]] || fail "$ref was not served"
done
[[ $(status "$URL/api/v1/quotes") == 401 ]] || fail "/api/v1/quotes answered without the bearer"

BEARER=$(cat "$RUN/data/secrets/bearer.key")
[[ $BEARER == 1ctx-markets-* ]] || fail "the first start wrote no prefixed bearer"
# GNU first: on Linux stat -f reads the file system and still succeeds
[[ $(stat -c %a "$RUN/data/secrets/bearer.key" 2>/dev/null || stat -f %Lp "$RUN/data/secrets/bearer.key") == 600 ]] ||
  fail "the bearer file is readable by others"
grep -q 'bearer key created' "$RUN/log" || fail "the first start did not log the bearer file"

INIT='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke","version":"1"}}}'
answer=$(curl -sf --max-time 5 "$URL/mcp" \
  -H "authorization: Bearer $BEARER" \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d "$INIT") || fail "initialize failed"
grep -q '"name":"1ctx-markets"' <<<"$answer" || fail "initialize did not name the server"

ADMIN=$(cat "$RUN/data/secrets/admin.key")
[[ $ADMIN == 1ctx-markets-admin-* ]] || fail "the first start wrote no prefixed admin key"
[[ $(stat -c %a "$RUN/data/secrets/admin.key" 2>/dev/null || stat -f %Lp "$RUN/data/secrets/admin.key") == 600 ]] ||
  fail "the admin key file is readable by others"
# scopes per operation: the read key is forbidden the admin ones, the admin
# key opens every route but /mcp
[[ $(status "$URL/api/v1/status" -H "authorization: Bearer $BEARER") == 403 ]] ||
  fail "the bearer was taken on /api/v1/status"
[[ $(status "$URL/api/v1/status" -H "authorization: Bearer $ADMIN") == 200 ]] ||
  fail "the admin key did not open /api/v1/status"
for path in rules watchlist; do
  [[ $(status "$URL/api/v1/$path" -H "authorization: Bearer $BEARER") == 200 ]] ||
    fail "the bearer did not open /api/v1/$path"
  [[ $(status "$URL/api/v1/$path" -H "authorization: Bearer $ADMIN") == 200 ]] ||
    fail "the admin key did not open /api/v1/$path"
done
[[ $(status -X POST "$URL/mcp" -H "authorization: Bearer $ADMIN") == 401 ]] ||
  fail "the admin key opened /mcp"
[[ $(status "$URL/api/v1/admin/status" -H "authorization: Bearer $ADMIN") == 404 ]] ||
  fail "an old path still answers"
# a raw ^ reaches the route, whose unknown argument is refused before any fetch
[[ $(status "$URL/api/v1/instruments/^VIX/bars?x=1" -H "authorization: Bearer $BEARER") == 400 ]] ||
  fail "a raw ^ in a path did not reach its route"
problem=$(curl -s --max-time 5 -D - "$URL/api/v1/nothing" -H "authorization: Bearer $BEARER" || true)
grep -qi '^content-type: application/problem+json' <<<"$problem" ||
  fail "an error was not problem details"
"$BIN" admin --listen "127.0.0.1:$PORT" --data "$RUN/data" status >"$RUN/admin" ||
  fail "admin status failed"
grep -q '"version"' "$RUN/admin" || fail "admin status did not answer the version"
grep -q "$ADMIN" "$RUN/admin" && fail "admin status printed the key"

# the web UI: the page and every asset it names, from the binary's bundle
UI=$(curl -s --max-time 5 "$URL/" || true)
grep -q '<title>Markets</title>' <<<"$UI" || fail "/ did not answer the web UI"
assets=$(grep -o '\(src\|href\)="/[^"]*"' <<<"$UI" | sed -E 's/^(src|href)="//; s/"$//')
[[ -n $assets ]] || fail "the web UI names no assets"
for asset in $assets; do
  [[ $(status "$URL$asset") == 200 ]] || fail "$asset was not served"
done
grep -q '\.js$' <<<"$assets" || fail "the web UI names no script"
[[ $(status -X POST "$URL/ui/session" -H 'content-type: application/json' -d '{"key":"wrong"}') == 401 ]] ||
  fail "a wrong key signed the web UI in"
COOKIE=$(curl -s --max-time 5 -o /dev/null -D - -X POST "$URL/ui/session" \
  -H 'content-type: application/json' --data-binary @- <<<"{\"key\":\"$ADMIN\"}" |
  grep -i '^set-cookie:' | sed -E 's/^[^:]*: *([^;]*).*/\1/' | tr -d '\r')
[[ $COOKIE == markets_session=v1.* ]] || fail "the admin key did not sign the web UI in"
grep -q "$ADMIN" <<<"$COOKIE" && fail "the session cookie holds the admin key"
[[ $(status "$URL/api/v1/status" -H "cookie: $COOKIE") == 200 ]] ||
  fail "the session cookie did not open /api/v1/status"
[[ $(status -X POST "$URL/mcp" -H "cookie: $COOKIE") == 401 ]] ||
  fail "the session cookie opened /mcp"

[[ -f "$RUN/data/markets.db" ]] || fail "markets.db was not created"
grep -q "$BEARER" "$RUN/log" && fail "the bearer reached the log"
grep -q "$ADMIN" "$RUN/log" && fail "the admin key reached the log"
"$BIN" --version | grep -q '^v' || fail "version flag failed"
echo "smoke ok"
