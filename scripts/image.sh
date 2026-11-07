#!/usr/bin/env bash
# Builds the container image for the native platform and loads it.
# PLATFORMS instead builds those into the build cache only, a check that
# each cross-compile works: the docker driver would load them otherwise.
set -euo pipefail
cd "$(dirname "$0")/.."

args=(--file Dockerfile --tag ghcr.io/stefanprodan/1ctx-markets:dev)
if [[ -n "${VERSION:-}" ]]; then
  args+=(--build-arg "VERSION=$VERSION")
fi
if [[ -n "${PLATFORMS:-}" ]]; then
  args+=(--platform "$PLATFORMS" --output type=cacheonly)
else
  args+=(--load)
fi
docker buildx build "${args[@]}" .
