# 1ctx-markets

A self-hosted market data server for AI agents. It syncs free market
data into one SQLite file on its own schedule, computes signals,
evaluates price rules, and serves them to agents over the Model Context
Protocol (MCP, Streamable HTTP) and a small read-only HTTP API, both
behind one bearer key. It makes no model calls and holds no portfolio:
only market data and the price rules agents set.

Today it serves only the bearer-protected MCP endpoint, with no tools yet.

## Run it

You need [Bun](https://bun.sh) at the version in `.bun-version`.

```sh
bun install --frozen-lockfile --ignore-scripts
mkdir -p ~/.1ctx-markets/secrets
openssl rand -hex 32 > ~/.1ctx-markets/secrets/bearer.key
chmod 600 ~/.1ctx-markets/secrets/bearer.key
make start
```

The server listens on `127.0.0.1:11237` and serves MCP at `/mcp`.
Every request carries `Authorization: Bearer <the contents of bearer.key>`;
any other is refused with 401. `make start ARGS="--help"` lists the
options.

To build one standalone binary into `bin/`:

```sh
make build
./bin/1ctx-markets --help
```

`make help` lists the other tasks (`test`, `lint`, `smoke`).

## Files

Everything lives in the data directory, `~/.1ctx-markets` unless
`--data` names another:

| Path | Holds |
|---|---|
| `markets.db` | the SQLite database, in WAL mode; its schema is migrated at every start |
| `secrets/bearer.key` | the bearer key every request carries, at least 32 characters; the server will not start without it |
| `secrets/source-<name>.key` | a data source's API key, e.g. `source-finnhub.key` |

A key file holds the bare value. The server only reads key files, never
writes them, and keeps their values out of the database, its log and
its answers.

## License

Apache-2.0, see [LICENSE](LICENSE).
