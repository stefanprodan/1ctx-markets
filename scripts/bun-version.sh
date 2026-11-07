#!/usr/bin/env bash
# Fails rather than print nothing: setup-bun reads an empty version as latest.
set -euo pipefail
cd "$(dirname "$0")/.."

version=$(tr -d '[:space:]' <.bun-version)
if [[ ! $version =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "bun-version: expected one x.y.z version in .bun-version" >&2
  exit 1
fi
# the image's binary must come from the Bun that builds the archives
image=$(sed -nE 's|^FROM .*oven/bun:([0-9]+\.[0-9]+\.[0-9]+)@sha256:[0-9a-f]{64}.*|\1|p' Dockerfile)
if [[ $image != "$version" ]]; then
  echo "bun-version: the Dockerfile's oven/bun pin is not $version from .bun-version" >&2
  exit 1
fi
echo "$version"
