# 1ctx-markets

[![test](https://github.com/stefanprodan/1ctx-markets/actions/workflows/test.yml/badge.svg)](https://github.com/stefanprodan/1ctx-markets/actions/workflows/test.yml)
[![built with Bun](https://img.shields.io/badge/built%20with-Bun-000?logo=bun)](https://bun.com)
[![license](https://img.shields.io/github/license/stefanprodan/1ctx-markets)](LICENSE)

A self-hosted market data server for AI agents.

It syncs quotes, price history, research and news from free sources
into a single SQLite file, computes technical signals, and serves it all
to agents over [MCP](https://modelcontextprotocol.io/) and to scripts
over a REST API. It also keeps your price alerts and portfolios, so an
agent can see what you hold.

It works with anything Yahoo Finance lists: shares, ETFs, indices,
futures, currencies and crypto, on any exchange. There is no ticker
list to maintain; a symbol is fetched the first time an agent asks for
it.

## Features

- **Quotes and signals:** live prices, daily and weekly history,
  moving averages, RSI, MACD, ATR, drawdown and crossings.
- **Research:** fundamentals, analysts, earnings, insider activity,
  SEC filings, news sentiment, ETF holdings, economic series and
  futures positioning.
- **Price alerts:** conditions like `rsi14 < 30 and price > sma200`,
  with a feed a scheduled job can poll.
- **Portfolios:** trades, cash, bonds and funds by broker, valued live
  in any currency.
- **Notes for agents:** your investor profile, trade plans and dated
  analyses per symbol, written in Markdown.
- **A web UI** to browse all of the above and manage agent keys.
- **One binary, one database file.** No cloud, no model calls, no
  broker connections.

## Data sources

All free. The keyed ones turn on when their key file is present:

| Source | Adds |
|---|---|
| Yahoo Finance | quotes, history, ETF holdings (always on) |
| CFTC | futures positioning (always on) |
| [Finnhub](https://finnhub.io/register) | US shares: fundamentals, analysts, earnings, insiders |
| [Massive](https://massive.com) | US shares and ETFs: news with sentiment |
| [FRED](https://fred.stlouisfed.org/docs/api/api_key.html) | economic series such as Treasury yields |
| SEC EDGAR | US filings (the key file holds a name and email, not a key) |
| Bucharest Stock Exchange | local shares, funds and bonds (`--source bvb`) |

## Quick start

Download a binary for Linux (amd64, arm64) or macOS (Apple silicon)
from [Releases](https://github.com/stefanprodan/1ctx-markets/releases),
or build it with [Bun](https://bun.com) at the version in
`.bun-version`:

```sh
git clone https://github.com/stefanprodan/1ctx-markets.git
cd 1ctx-markets
bun install --frozen-lockfile --ignore-scripts
make build
./bin/1ctx-markets
```

The server listens on `127.0.0.1:11238` and keeps its data in
`~/.1ctx-markets`. The first start writes an admin key to
`~/.1ctx-markets/secrets/user-admin.key`; use it to sign in to the web
UI and to connect agents. `--help` lists the options.

To add a source, put its key in a file and restart:

```sh
printf '%s' '<key>' > ~/.1ctx-markets/secrets/source-finnhub.key   # or source-massive, source-fred
printf '%s' 'Your Name you@example.com' > ~/.1ctx-markets/secrets/source-edgar.key
chmod 600 ~/.1ctx-markets/secrets/*.key
```

On macOS, `./bin/1ctx-markets service install` runs it as a login
service.

The server speaks plain HTTP: keep it on loopback, a private network
such as Tailscale, or behind a TLS proxy.

### With Docker

From a clone of this repository, write the admin key, and the key of
any source you want, before the first start:

```sh
cd deploy/docker
mkdir -p secrets
openssl rand -hex 32 > secrets/user-admin.key
printf '%s' '<key>' > secrets/source-finnhub.key   # optional, as above
chmod 644 secrets/*.key
```

The container reads `secrets/` read-only, so it cannot write a key of
its own; the admin key must be 32 or more characters. Start a release
from [Releases](https://github.com/stefanprodan/1ctx-markets/releases):

```sh
MARKETS_VERSION=v0.0.1 docker compose up -d
```

Or build the image from the checkout:

```sh
MARKETS_VERSION=dev docker compose -f compose.yaml -f compose.dev.yaml up -d --build
```

The server listens on `127.0.0.1:11238` and keeps its database in the
Docker volume `1ctx-markets_data`. To connect an agent, use the commands
below with `deploy/docker/secrets/user-admin.key` in place of
`~/.1ctx-markets/secrets/user-admin.key`.

## Connect an agent

Add it as an MCP server. For Claude Code:

```sh
claude mcp add --transport http markets http://127.0.0.1:11238/mcp \
  --header "Authorization: Bearer $(cat ~/.1ctx-markets/secrets/user-admin.key)"
```

Give each agent its own key from the web UI's Connect agents page, or
with `1ctx-markets keys add <name>`. You choose what each key may read
or write; market data is always readable.

Scripts use the REST API with the same keys:

```sh
curl -H "Authorization: Bearer $(cat ~/.1ctx-markets/secrets/user-admin.key)" \
  'http://127.0.0.1:11238/api/v1/quotes?symbols=NVDA,BTC-USD'
```

The API reference is served at `/api/v1/docs`.

## Analysis skill

[`skills/market-analysis`](skills/market-analysis) is an
[Agent Skill](https://agentskills.io) that teaches an agent to write
and refresh analysis notes for stocks, ETFs and currency pairs. The
server publishes it at `/.well-known/agent-skills/`. For Claude Code:

```sh
mkdir -p ~/.claude/skills
curl -fsSL http://127.0.0.1:11238/.well-known/agent-skills/market-analysis.tgz \
  | tar -xz -C ~/.claude/skills/
```

## Development

`make help` lists the tasks (`start`, `test`, `lint`, `smoke`). The
[`docs/`](docs) folder covers each part of the server in depth.

## License

[Apache License 2.0](LICENSE).
