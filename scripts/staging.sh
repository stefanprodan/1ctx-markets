#!/usr/bin/env bash
# The staging instance: a Mac reached over ssh that runs the binary as a
# service (`1ctx-markets service`), with its data under ~/.1ctx-markets.
#
#   staging.sh deploy           build, back the db up, swap the binary, restart
#   staging.sh status           what the service says
#   staging.sh secrets <dir>    copy the source-*.key files the box lacks
#
# The host is named in scripts/staging.env, never here.
set -euo pipefail

cd "$(dirname "$0")/.."
[ -f scripts/staging.env ] || {
  echo "scripts/staging.env missing; copy scripts/staging.env.example" >&2
  exit 2
}
# shellcheck source=/dev/null
. scripts/staging.env
HOST=${STAGING_SSH:?STAGING_SSH is not set in scripts/staging.env}
LISTEN=${STAGING_LISTEN:-127.0.0.1:11238}
# more server flags for the install, such as --source bvb
FLAGS=${STAGING_FLAGS:-}
KEEP_BACKUPS=3

# BatchMode fails fast instead of prompting
ssh_() { ssh -o BatchMode=yes -o ConnectTimeout=10 "$HOST" "$@"; }
fail() {
  echo "staging: $1" >&2
  exit 1
}

deploy() {
  # Staging holds real data and takes main only. A branch's migration is
  # frozen once it ran there, so deploying one is a deliberate bypass.
  local branch dirty sha
  branch=$(git rev-parse --abbrev-ref HEAD)
  dirty=$(git status --porcelain)
  if [ "${ALLOW_BRANCH:-}" != 1 ]; then
    [ "$branch" = main ] || fail "on $branch, not main; ALLOW_BRANCH=1 deploys it anyway"
    [ -z "$dirty" ] || fail "the checkout has uncommitted changes"
  fi
  sha=$(git rev-parse --short HEAD)
  # a dirty tree names its diff too, so two bypass deploys from one
  # commit are two versions
  [ -z "$dirty" ] || sha=$sha.dirty$(git diff HEAD | shasum | cut -c1-6)
  local version
  version=v$(bun -e 'console.log(require("./package.json").version)')+$sha

  VERSION=$version bun run build
  [ "$(bin/1ctx-markets -v)" = "$version" ] || fail "the binary does not report $version"

  # Before anything is swapped: .backup is safe on a live WAL database,
  # and the copy predates whatever migration the new binary brings.
  ssh_ KEEP="$KEEP_BACKUPS" bash -s <<'REMOTE'
set -euo pipefail
mkdir -p ~/.1ctx-markets/bin ~/.1ctx-markets/backups
db=~/.1ctx-markets/markets.db
[ -f "$db" ] || exit 0
old=$(~/.1ctx-markets/bin/1ctx-markets -v 2>/dev/null || echo unknown)
out=~/.1ctx-markets/backups/markets-$(date -u +%Y%m%dT%H%M%SZ)-$old.db
sqlite3 "$db" ".backup '$out'"
# The copy inherits WAL mode and would grow -shm and -wal files the
# moment it is opened. A backup is one file: take it out of WAL first.
sqlite3 "$out" 'pragma journal_mode=delete' >/dev/null
rm -f "$out-shm" "$out-wal"
[ "$(sqlite3 "$out" 'pragma integrity_check')" = ok ] || {
  echo "staging: the backup failed its integrity check: $out" >&2
  exit 1
}
echo "backup: $out"
ls -1t ~/.1ctx-markets/backups/markets-*.db | tail -n +$((KEEP + 1)) | while read -r f; do
  rm -f "$f" "$f-shm" "$f-wal"
done
REMOTE

  # Upload beside the live binary and rename: an interrupted copy must not
  # leave the service manager restarting a truncated executable.
  scp -q -o BatchMode=yes -o ConnectTimeout=10 bin/1ctx-markets "$HOST:~/.1ctx-markets/bin/1ctx-markets.new"
  # shellcheck disable=SC2029 # LISTEN and FLAGS are meant to expand here
  ssh_ "mv -f ~/.1ctx-markets/bin/1ctx-markets.new ~/.1ctx-markets/bin/1ctx-markets &&
    ~/.1ctx-markets/bin/1ctx-markets service install --restart --listen $LISTEN $FLAGS"
}

secrets() {
  local dir=${1:-}
  [ -n "$dir" ] || fail "secrets needs DIR=<dir>"
  [ -d "$dir" ] || fail "$dir is not a directory"
  # the bearer is never copied: the first start writes the box's own
  local keys=() file name
  for file in "$dir"/source-*.key; do
    [ -f "$file" ] || continue
    name=$(basename "$file")
    [[ $name =~ ^source-[a-z0-9-]+\.key$ ]] || fail "$name is not a source key name"
    keys+=("$file")
  done
  [ ${#keys[@]} -gt 0 ] || fail "no source-*.key files in $dir"

  # One ssh per key, its value on stdin, so it never reaches an argument,
  # a listing or the output; a key the box holds is left as it is.
  for file in "${keys[@]}"; do
    name=$(basename "$file")
    # shellcheck disable=SC2029 # the checked name is meant to expand here
    ssh_ "set -e; umask 077; d=~/.1ctx-markets/secrets; mkdir -p \$d; chmod 700 \$d
      f=\$d/$name
      if [ -e \$f ]; then cat >/dev/null; echo '$name: kept, the box has one'; exit 0; fi
      cat >\$f.tmp; chmod 600 \$f.tmp; mv -n \$f.tmp \$f; rm -f \$f.tmp
      echo '$name: copied'" <"$file"
  done
}

# shellcheck disable=SC2088 # the tilde expands on the box
status() { ssh_ "~/.1ctx-markets/bin/1ctx-markets service status"; }

case ${1:-} in
  deploy) deploy ;;
  status) status ;;
  secrets) secrets "${2:-}" ;;
  *) fail "usage: staging.sh deploy|status|secrets <dir>" ;;
esac
