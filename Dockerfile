# syntax=docker/dockerfile:1
# check=error=true

FROM --platform=$BUILDPLATFORM oven/bun:1.4.4@sha256:1d22548f177f4ff38e0c15baa3c2c46c6c2060ba2d1bc573bb4720b407548f1d AS build
WORKDIR /src
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --ignore-scripts
COPY tsconfig.json ./
COPY scripts/build.ts scripts/build.ts
# the binary embeds and serves these skills
COPY skills skills
COPY src src
ARG TARGETARCH
ARG VERSION
# Bun cross-compiles, so every platform builds natively on the build host.
RUN case "$TARGETARCH" in \
      amd64) TARGET=bun-linux-x64 ;; \
      arm64) TARGET=bun-linux-arm64 ;; \
      *) echo "unsupported architecture: $TARGETARCH" >&2; exit 1 ;; \
    esac \
 && TARGET=$TARGET VERSION=$VERSION bun run build \
 && mkdir /data

FROM gcr.io/distroless/cc-debian12:nonroot@sha256:9dac0a79194e45a7da0158a9c6da57b217585af0786db3845d1f0ec1a0dd182f
COPY --from=build /src/bin/1ctx-markets /usr/local/bin/1ctx-markets
COPY LICENSE THIRD_PARTY_LICENSES.md /usr/share/doc/1ctx-markets/
# A new named volume copies this directory with its owner.
COPY --from=build --chown=65532:65532 /data /data
USER 65532:65532
WORKDIR /data
EXPOSE 11238
ENTRYPOINT ["/usr/local/bin/1ctx-markets"]
CMD ["--listen", "0.0.0.0:11238", "--data", "/data"]
