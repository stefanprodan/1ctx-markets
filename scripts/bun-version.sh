#!/usr/bin/env bash
# Prints the Bun version .bun-version pins, so CI and the release binaries
# are built by the same Bun. It fails rather than print nothing, since
# setup-bun takes an empty version as the latest.
set -euo pipefail
cd "$(dirname "$0")/.."

version=$(tr -d '[:space:]' <.bun-version)
if [[ ! $version =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "bun-version: expected one x.y.z version in .bun-version" >&2
  exit 1
fi
echo "$version"
