// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// Parsing only, so `service install` refuses exactly what a start would.

import { homedir } from "node:os";
import { join } from "node:path";
import { MINUTE_MS } from "./clock.ts";

export const DEFAULT_LISTEN = "127.0.0.1:11238";
export const DEFAULT_QUOTE_EVERY = 5;
export const DEFAULT_TRACK_DAYS = 30;
// one key per client, so a person with a few agents and scripts never runs out
export const DEFAULT_MAX_KEYS = 20;
export const MAX_MAX_KEYS = 1000;
export const KNOWN_SOURCES = ["bvb"] as const;

export type Config = {
  hostname: string;
  port: number;
  dataDir: string;
  quoteEveryMs: number;
  // an instrument read within this many days stays tracked
  trackDays: number;
  // keys a person may hold, expired ones included
  maxKeys: number;
  sources: string[];
  // the web UI at / and its sign-in
  ui: boolean;
  // the source jobs; off, the server answers from the database as it is
  sync: boolean;
  // behind a proxy: a client's address is its last X-Forwarded-For value
  trustProxy: boolean;
};

export const dbPath = (config: Config): string =>
  join(config.dataDir, "markets.db");
export const secretsDir = (config: Config): string =>
  join(config.dataDir, "secrets");

export type Cli =
  | { kind: "run"; config: Config }
  | { kind: "service"; argv: string[] }
  | { kind: "admin"; argv: string[] }
  | { kind: "keys"; argv: string[] }
  | { kind: "users"; argv: string[] }
  | { kind: "help" }
  | { kind: "version" }
  | { kind: "error"; message: string };

export const HELP = `\x1b[1m1ctx-markets\x1b[0m - a self-hosted market data server for AI agents

\x1b[1mUsage:\x1b[0m
  1ctx-markets [options]
  1ctx-markets service install [options] [--restart]
  1ctx-markets service status|start|stop|restart
  1ctx-markets service uninstall [--purge]
  1ctx-markets admin [--listen <host:port>] [--data <dir>] status
  1ctx-markets admin ... refetch [--fetch <parts>] [--sections <list>] <id>...
  1ctx-markets admin ... delete <id>
  1ctx-markets keys [--listen <host:port>] [--data <dir>] list
  1ctx-markets keys ... add <name> [--expires 30|90|365] [--portfolio <access>]
                        [--alerts <access>] [--profile <access>]
  1ctx-markets keys ... set <name> [--portfolio <access>] [--alerts <access>]
                        [--profile <access>]
  1ctx-markets keys ... revoke <name>|<id>
  1ctx-markets users [--listen <host:port>] [--data <dir>] list
  1ctx-markets users ... add <email> <name> [--role admin|member]
  1ctx-markets users ... invite|sign-out <id>
  1ctx-markets users ... remove <id> [--dry-run]

\x1b[1mService:\x1b[0m
  install                run 1ctx-markets with these options as a service
                         of the signed-in user, started at login and kept
                         alive; --restart replaces one that is running
  uninstall              remove the service; --purge also removes the
                         database and the log, never secrets/

\x1b[1mAdmin:\x1b[0m
  status                 the sources, the last run of every job, the
                         tracked count and the database size
  refetch                ask the sources again for stored instruments;
                         parts: bars,quotes,research,calendar,news
  delete                 remove an instrument and all its rows
                         The running server is called on this machine with
                         user-admin.key; --listen and --data default to the
                         installed service's, else the defaults below

\x1b[1mKeys:\x1b[0m
  list                   every person's agent keys, never their tokens
  add                    make an agent key and print it once; it never
                         expires unless --expires gives days, and reaches
                         no portfolio, alerts or profile unless --portfolio,
                         --alerts or --profile says so; access: none, read
                         or write
  set                    change one of the operator's agent keys' access
                         by its name; its token stays
  revoke                 revoke one of the operator's agent keys by its
                         name, or anyone's by its id
                         The server is called as for admin

\x1b[1mUsers:\x1b[0m
  list                   the people, their role, email and last sign-in
  add                    add a person and email them a sign-in link,
                         valid 7 days; needs email set up in the web UI
  invite                 email the person's invite again
  sign-out               end the person's sign-ins and live links
  remove                 delete the person and every row of theirs;
                         --dry-run counts them only. Never the operator
                         The server is called as for admin

\x1b[1mOptions:\x1b[0m
  --listen <host:port>   bind address (default: ${DEFAULT_LISTEN})
  --data <dir>           holds markets.db and secrets/
                         (default: ~/.1ctx-markets)
  --quote-every <min>    minutes between quote syncs (default: ${DEFAULT_QUOTE_EVERY})
  --track-days <days>    an instrument read within this many days stays
                         tracked (default: ${DEFAULT_TRACK_DAYS})
  --max-keys <n>         keys a person may hold, expired ones included,
                         1 to ${MAX_MAX_KEYS} (default: ${DEFAULT_MAX_KEYS})
  --source <name>        turn on a keyless source, repeated for each;
                         bvb: the Bucharest Stock Exchange's own feed
  --no-ui                serve no web UI at / and refuse its sign-in
  --trust-proxy          behind a reverse proxy: take a client's address
                         from the last X-Forwarded-For value, for the
                         sign-in page's limit; never without a proxy
  --no-sync              run no sync job and serve the database as it is;
                         a read still fetches a symbol not stored
  -v, --version          show version
  -h, --help             show this help

\x1b[1mSecrets:\x1b[0m
  user-admin.key         the admin's key, which opens /mcp, every /api/v1
                         route and the web UI's sign-in; the first start
                         writes one. Agents get keys of their own from
                         the web UI or the keys command
  source-<name>.key      a source's API key, which turns it on:
                         source-fred.key, source-finnhub.key or
                         source-massive.key; source-edgar.key holds
                         a name and an email for SEC instead
  email-<name>.key       an SMTP password, put there by hand and picked
                         in the web UI's SMTP settings; read at each send`;

export const VALUED_FLAGS = [
  "--listen",
  "--data",
  "--quote-every",
  "--track-days",
  "--max-keys",
  "--source",
];

export function defaultDataDir(home: string): string {
  return join(home, ".1ctx-markets");
}

function parseListen(
  listen: string,
): { hostname: string; port: number } | string {
  const colon = listen.lastIndexOf(":");
  if (colon < 1) return "--listen must be host:port";
  const port = Number(listen.slice(colon + 1));
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return "--listen port must be 1 to 65535";
  }
  return { hostname: listen.slice(0, colon), port };
}

const count = (value: string): number | null =>
  /^[1-9]\d{0,5}$/.test(value) ? Number(value) : null;

export function parseCli(argv: string[], home: string = homedir()): Cli {
  if (argv[0] === "service") return { kind: "service", argv: argv.slice(1) };
  if (argv[0] === "admin") return { kind: "admin", argv: argv.slice(1) };
  if (argv[0] === "keys") return { kind: "keys", argv: argv.slice(1) };
  if (argv[0] === "users") return { kind: "users", argv: argv.slice(1) };
  let listen = DEFAULT_LISTEN;
  let dataDir = defaultDataDir(home);
  let quoteEvery = DEFAULT_QUOTE_EVERY;
  let trackDays = DEFAULT_TRACK_DAYS;
  let maxKeys = DEFAULT_MAX_KEYS;
  const sources = new Set<string>();
  let ui = true;
  let sync = true;
  let trustProxy = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    let value = "";
    if (VALUED_FLAGS.includes(arg)) {
      const next = argv[++i];
      if (next === undefined) {
        return { kind: "error", message: `${arg} needs a value` };
      }
      value = next;
    }
    const positive = () =>
      count(value) ?? `${arg} must be a whole number above 0`;
    switch (arg) {
      case "--listen":
        listen = value;
        break;
      case "--data":
        if (value === "") return { kind: "error", message: "--data is empty" };
        dataDir = value;
        break;
      case "--quote-every": {
        const n = positive();
        if (typeof n === "string") return { kind: "error", message: n };
        quoteEvery = n;
        break;
      }
      case "--track-days": {
        const n = positive();
        if (typeof n === "string") return { kind: "error", message: n };
        trackDays = n;
        break;
      }
      case "--max-keys": {
        const n = count(value);
        if (n === null || n > MAX_MAX_KEYS) {
          return {
            kind: "error",
            message: `--max-keys must be a whole number from 1 to ${MAX_MAX_KEYS}`,
          };
        }
        maxKeys = n;
        break;
      }
      case "--source":
        if (!(KNOWN_SOURCES as readonly string[]).includes(value)) {
          return {
            kind: "error",
            message: `unknown source ${value}; known sources: ${KNOWN_SOURCES.join(", ")}`,
          };
        }
        sources.add(value);
        break;
      case "--no-ui":
        ui = false;
        break;
      case "--no-sync":
        sync = false;
        break;
      case "--trust-proxy":
        trustProxy = true;
        break;
      case "-v":
      case "--version":
        return { kind: "version" };
      case "-h":
      case "--help":
        return { kind: "help" };
      default:
        return { kind: "error", message: `unknown option ${arg}` };
    }
  }

  const address = parseListen(listen);
  if (typeof address === "string") return { kind: "error", message: address };
  return {
    kind: "run",
    config: {
      ...address,
      dataDir,
      quoteEveryMs: quoteEvery * MINUTE_MS,
      trackDays,
      maxKeys,
      sources: [...sources].sort(),
      ui,
      sync,
      trustProxy,
    },
  };
}

// every flag spelled out, so a service definition parses back unchanged
export function configToArgs(config: Config): string[] {
  const args = [
    "--listen",
    `${config.hostname}:${config.port}`,
    "--data",
    config.dataDir,
    "--quote-every",
    String(config.quoteEveryMs / MINUTE_MS),
    "--track-days",
    String(config.trackDays),
    "--max-keys",
    String(config.maxKeys),
  ];
  for (const name of config.sources) args.push("--source", name);
  if (!config.ui) args.push("--no-ui");
  if (!config.sync) args.push("--no-sync");
  if (config.trustProxy) args.push("--trust-proxy");
  return args;
}
