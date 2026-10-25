#!/usr/bin/env bash
# Smoke test of the compiled binary: it refuses to start without a
# bearer, starts with one, refuses a request without it, and answers an
# MCP initialize with it. Each run starts from a fresh directory, so it
# migrates a new database, and removes the directory on exit.
set -euo pipefail

BIN=${1:-bin/1ctx-markets}
BIN=$(cd "$(dirname "$BIN")" && pwd)/$(basename "$BIN")
PORT=${SMOKE_PORT:-11238}
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
kill -0 "$PID" 2>/dev/null && fail "started without a bearer"
if wait "$PID"; then fail "exited 0 without a bearer"; fi
unset PID
grep -q 'bearer.key' "$RUN/log" || fail "the refusal did not name bearer.key"

BEARER=smoke-bearer-$$-0123456789abcdef0123456789abcdef
printf '%s' "$BEARER" >"$RUN/data/secrets/bearer.key"
"$BIN" --listen "127.0.0.1:$PORT" --data "$RUN/data" >"$RUN/log" 2>&1 &
PID=$!

status() { curl -s --max-time 5 -o /dev/null -w '%{http_code}' "$@" || true; }

for _ in $(seq 1 50); do
  [[ $(status "$URL/mcp") == 401 ]] && break
  kill -0 "$PID" 2>/dev/null || fail "the server exited"
  sleep 0.2
done
[[ $(status "$URL/mcp") == 401 ]] || fail "a request without the bearer was not refused"

INIT='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke","version":"1"}}}'
answer=$(curl -sf --max-time 5 "$URL/mcp" \
  -H "authorization: Bearer $BEARER" \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d "$INIT") || fail "initialize failed"
grep -q '"name":"1ctx-markets"' <<<"$answer" || fail "initialize did not name the server"

[[ -f "$RUN/data/markets.db" ]] || fail "markets.db was not created"
grep -q "$BEARER" "$RUN/log" && fail "the bearer reached the log"
"$BIN" --version | grep -q '^v' || fail "version flag failed"
echo "smoke ok"
