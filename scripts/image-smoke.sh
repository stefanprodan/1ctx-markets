#!/usr/bin/env bash
# Smoke test of the container image, run the way compose.yaml runs it: a
# fresh named volume, a read-only secrets mount holding the admin key, a
# read-only root and no capabilities, plus --no-sync so no source is
# called. It checks the version, that /mcp refuses a request without a key
# and answers one with it, that the key was read and nothing written into
# secrets/, stops the container with SIGTERM and requires a clean exit. It
# removes its container, volume and files.
set -euo pipefail
cd "$(dirname "$0")/.."

IMAGE=ghcr.io/stefanprodan/1ctx-markets:dev
PORT=${SMOKE_PORT:-11240}
URL=http://127.0.0.1:$PORT
NAME=1ctx-markets-image-smoke-$$
RUN=$(mktemp -d "${TMPDIR:-/tmp}/1ctx-markets-image-smoke.XXXXXX")
trap 'docker rm -f "$NAME" >/dev/null 2>&1 || true
  docker volume rm "$NAME" >/dev/null 2>&1 || true
  rm -rf "$RUN"' EXIT

PLATFORMS='' scripts/image.sh

fail() {
  echo "image-smoke: $1" >&2
  docker logs "$NAME" >&2 2>&1 || true
  exit 1
}

if [[ -n "${VERSION:-}" ]]; then
  [[ $(docker run --rm "$IMAGE" --version) == "$VERSION" ]] ||
    fail "--version does not answer $VERSION"
fi

# the server runs as 65532, which owns neither the dir nor the file
mkdir "$RUN/secrets"
ADMIN=image-smoke-admin-$(od -An -N24 -tx1 /dev/urandom | tr -d ' \n')
printf '%s' "$ADMIN" >"$RUN/secrets/user-admin.key"
chmod 755 "$RUN" "$RUN/secrets"
chmod 644 "$RUN/secrets/user-admin.key"
before=$(cksum <"$RUN/secrets/user-admin.key")

docker volume create "$NAME" >/dev/null
docker run -d --name "$NAME" --read-only --cap-drop ALL \
  --security-opt no-new-privileges:true \
  -v "$NAME:/data" -v "$RUN/secrets:/data/secrets:ro" \
  -p "127.0.0.1:$PORT:11238" "$IMAGE" \
  --listen 0.0.0.0:11238 --data /data --no-sync >/dev/null

status() { curl -s --max-time 5 -o /dev/null -w '%{http_code}' "$@" || true; }

for _ in $(seq 1 100); do
  [[ $(status "$URL/health") == 200 ]] && break
  [[ $(docker inspect -f '{{.State.Running}}' "$NAME") == true ]] ||
    fail "the container exited"
  sleep 0.2
done
[[ $(status "$URL/health") == 200 ]] || fail "/health did not answer 200"
[[ $(status -X POST "$URL/mcp") == 401 ]] ||
  fail "a request without a key was not refused"

INIT='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"image-smoke","version":"1"}}}'
# a body is read into a variable and grepped there: grep -q piped from
# curl can kill curl with a broken pipe, which pipefail reports
answer=$(curl -sf --max-time 5 "$URL/mcp" \
  -H "authorization: Bearer $ADMIN" \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d "$INIT") || fail "initialize with the admin key failed"
grep -q '"name":"1ctx-markets"' <<<"$answer" ||
  fail "initialize did not name the server"

log=$(docker logs "$NAME" 2>&1)
startup=$(grep "msg=startup " <<<"$log") || fail "no startup line"
if [[ -n "${VERSION:-}" ]]; then
  grep -qF " version=$VERSION " <<<"$startup" ||
    fail "startup does not report $VERSION"
fi
grep -q 'admin key created' <<<"$log" && fail "the server wrote an admin key"
grep -qF "$ADMIN" <<<"$log" && fail "the admin key reached the log"
[[ $(cksum <"$RUN/secrets/user-admin.key") == "$before" ]] ||
  fail "user-admin.key changed"
[[ $(ls -A "$RUN/secrets") == user-admin.key ]] ||
  fail "the server wrote into secrets/"

docker stop -t 45 "$NAME" >/dev/null
code=$(docker inspect -f '{{.State.ExitCode}}' "$NAME")
[[ "$code" == 0 ]] || fail "the container exited with $code"
grep -q 'msg=shutdown ' <<<"$(docker logs "$NAME" 2>&1)" ||
  fail "the stop did not drain"
echo "image smoke ok"
