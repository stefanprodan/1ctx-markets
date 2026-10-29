# 1ctx-markets

[![test](https://github.com/stefanprodan/1ctx-markets/actions/workflows/test.yml/badge.svg)](https://github.com/stefanprodan/1ctx-markets/actions/workflows/test.yml)
[![built with Bun](https://img.shields.io/badge/built%20with-Bun-000?logo=bun)](https://bun.com)
[![license](https://img.shields.io/github/license/stefanprodan/1ctx-markets)](LICENSE)

1ctx-markets is a self-hosted market data server for AI agents. It
keeps quotes, daily history, technical signals, research and news in
one SQLite file, syncs them on its own schedule from free sources, and
serves them to agents over the [Model Context Protocol](https://modelcontextprotocol.io/)
(MCP) and a REST API with an OpenAPI description, both behind one
bearer key.

It works for any exchange Yahoo Finance carries: shares, ETFs,
indices, futures, currencies and crypto. Nothing is preset: no ticker
list and no default market, benchmark or currency. An instrument is
fetched the first time an agent names it and kept in sync while agents
read it or a rule watches it.

It holds market data and the price rules agents set, nothing else: no
holdings, orders or portfolio, and it makes no model calls.

## Highlights

- **Tools for agents.** `quote` for live prices with their signals,
  `history` for daily or weekly bars with relative return against a
  benchmark, `search` for listings, `movers` for the day's moves and
  average crossings, `screen` to filter and sort a list of symbols on a
  fixed set of fields, `research` and `events` for fundamentals,
  analysts, earnings and news, and `rules` for price alerts. There is
  no SQL or query tool.
- **Signals on live prices.** Moving averages (SMA 50 and 200, EMA 20),
  MACD, RSI 14, ATR 14, the lower Bollinger band, 52-week high, low
  and drawdown, volatility, volume ratio, and daily and weekly crossings,
  computed on closed days plus today's price.
- **Research and news.** With a Finnhub key: key metrics, analyst
  recommendations, earnings history and calendar, and insider sentiment
  for US shares. With a Massive key: 30 days of news with per-ticker
  sentiment for US shares and ETFs. With a FRED key: daily economic
  series such as Treasury yields, as instruments of their own.
- **Rules and alerts.** Agents set conditions on a symbol's price or
  signals, other symbols included: price below 200, RSI under 30 while
  above the 200-day average, the VIX above 30, a drop after the next
  earnings report. Each rule fires one alert each time its condition
  turns true. `GET /api/v1/alerts` is a feed a scheduled job can poll,
  answering 304 when nothing is new.
- **Units and staleness on every quote.** Each quote carries its unit,
  currency and times, and stale reasons when a source failed or a sync
  is behind. Market hours come from the source, so holidays and clock
  changes need no table.
- **Free sources, each optional.** Yahoo needs no key and is always on.
  FRED, Finnhub and Massive turn on when their free key file is present.
  The Bucharest Stock Exchange's own feed, with its shares, fund units,
  government bonds and indices, turns on with `--source bvb` and needs
  no key.
- **A web UI for the operator.** Sign in with the admin key to see the
  tracked markets with their day's move, the sources, every job's last
  run and the database at a glance, in the same look as 1ctx; `--no-ui`
  turns it off.
- **One binary, one file.** A standalone binary built with Bun, one
  SQLite database and a directory of key files. MCP answers stay under
  32 KiB pages, so MCP clients need no setting changed; the REST API
  answers whole results; only the stored instrument list and the
  alerts feed page (`docs/api.md`).

## Quick Start

You need [Bun](https://bun.sh) at the version in `.bun-version`.

Clone the repository and install the build dependencies:

```sh
git clone https://github.com/stefanprodan/1ctx-markets.git
cd 1ctx-markets
bun install --frozen-lockfile --ignore-scripts
```

Optionally, add free API keys to turn on more sources: sign up for
[FRED](https://fred.stlouisfed.org/docs/api/api_key.html),
[Finnhub](https://finnhub.io/register) or
[Massive](https://massive.com). Each file holds the bare key:

```sh
mkdir -p ~/.1ctx-markets/secrets
printf '%s' '<your FRED key>' > ~/.1ctx-markets/secrets/source-fred.key
printf '%s' '<your Finnhub key>' > ~/.1ctx-markets/secrets/source-finnhub.key
printf '%s' '<your Massive key>' > ~/.1ctx-markets/secrets/source-massive.key
chmod 600 ~/.1ctx-markets/secrets/*.key
```

Keys are read at start; restart the server after adding one.

Run it from source, or build the binary and run that:

```sh
make start
# or
make build
./bin/1ctx-markets
```

The first start writes the bearer key every request carries to
`~/.1ctx-markets/secrets/bearer.key`, readable only by you; it starts
with `1ctx-markets-`, and an existing key is kept.

The server listens on `127.0.0.1:11238`, serves MCP at `/mcp`, and
keeps `markets.db` in `~/.1ctx-markets`. `--listen`, `--data`,
`--quote-every` (minutes between quote syncs, 5 by default) and
`--track-days` (how long an instrument stays synced after its last
read, 30 by default) change that, and `--source bvb` turns on the
Bucharest Stock Exchange's feed; `--help` lists them. It speaks plain
HTTP, so keep it on loopback, on a private network such as Tailscale,
or behind a TLS proxy.

On macOS, the binary can run itself as a service of your user,
started at login and restarted if it exits, with any of the options
above, logging to `markets.log` beside the database; `service status`,
`stop`, `start` and `uninstall` manage it:

```sh
./bin/1ctx-markets service install --source bvb
```

An instrument is synced while something reads it. To keep some synced
whether read or not, such as an overview of the world's markets, name
each with `--track` as the `quote` tool takes it, and quote `^`, which
zsh's extended globbing reads as a pattern. This one holds the main
US, European and Asian indices, Bucharest's BET (feed only, so with
`--source bvb`), gold, silver and WTI oil:

```sh
./bin/1ctx-markets service install --source bvb \
  --track '^GSPC' --track '^DJI' --track '^NDX' --track '^SOX' \
  --track '^VIX' --track '^STOXX' --track '^GDAXI' --track '^FTSE' \
  --track '^FCHI' --track '^N225' --track '^HSI' --track '^KS11' \
  --track '^TWII' --track BVB:BET --track GC=F --track SI=F --track CL=F
```

Connect an MCP client over Streamable HTTP with the bearer in the
`Authorization` header. For Claude Code:

```sh
claude mcp add --transport http markets http://127.0.0.1:11238/mcp \
  --header "Authorization: Bearer $(cat ~/.1ctx-markets/secrets/bearer.key)"
```

Scripts read the same data over the REST API with the same key:

```sh
curl -H "Authorization: Bearer $(cat ~/.1ctx-markets/secrets/bearer.key)" \
  'http://127.0.0.1:11238/api/v1/quotes?symbols=NVDA,VVSM.DE,BTC-USD'
```

Every route, with its arguments, answers and errors, is browsable at
<http://127.0.0.1:11238/api/v1/docs>, a Swagger UI page bundled in the
binary; its OpenAPI description is `/api/v1/openapi.json`.

`make help` lists the other tasks (`test`, `lint`, `smoke`).

## License

1ctx-markets is licensed under the [Apache License 2.0](LICENSE).
