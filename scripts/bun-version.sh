#!/usr/bin/env bash
# Fails rather than print nothing: setup-bun reads an empty version as latest.
set -euo pipefail
cd "$(dirname "$0")/.."

version=$(tr -d '[:space:]' <.bun-version)
if [[ ! $version =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "bun-version: expected one x.y.z version in .bun-version" >&2
  exit 1
fi
echo "$version"
