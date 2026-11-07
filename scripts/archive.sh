#!/usr/bin/env bash
# Packs bin/1ctx-markets with the licenses into
# dist/1ctx-markets_<os>_<arch>.tar.gz for a release
# (scripts/archive.sh linux_amd64).
set -euo pipefail
cd "$(dirname "$0")/.."

name=${1:?usage: scripts/archive.sh <os>_<arch>}
mkdir -p dist
stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT
cp bin/1ctx-markets LICENSE THIRD_PARTY_LICENSES.md "$stage/"
tar -C "$stage" -czf "dist/1ctx-markets_$name.tar.gz" 1ctx-markets LICENSE THIRD_PARTY_LICENSES.md
tar -tzf "dist/1ctx-markets_$name.tar.gz" | grep -Fxq THIRD_PARTY_LICENSES.md
