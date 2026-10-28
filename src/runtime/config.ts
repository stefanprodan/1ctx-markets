// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Parsing only, so `service install` refuses exactly what a start would.

import { homedir } from "node:os";
import { join } from "node:path";
import { MINUTE_MS } from "./clock.ts";

export const DEFAULT_LISTEN = "127.0.0.1:11238";
export const DEFAULT_QUOTE_EVERY = 5;
export const DEFAULT_TRACK_DAYS = 30;
export const KNOWN_SOURCES = ["bvb"] as const;

export type Config = {
  hostname: string;
  port: number;
  dataDir: string;
  quoteEveryMs: number;
  // an instrument read within this many days stays tracked
  trackDays: number;
  sources: string[];
};

export const dbPath = (config: Config): string =>
  join(config.dataDir, "markets.db");
export const secretsDir = (config: Config): string =>
  join(config.dataDir, "secrets");

export type Cli =
  | { kind: "run"; config: Config }
  | { kind: "service"; argv: string[] }
  | { kind: "admin"; argv: string[] }
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
                         admin.key; --listen and --data default to the
                         installed service's, else the defaults below

\x1b[1mOptions:\x1b[0m
  --listen <host:port>   bind address (default: ${DEFAULT_LISTEN})
  --data <dir>           holds markets.db and secrets/
                         (default: ~/.1ctx-markets)
  --quote-every <min>    minutes between quote syncs (default: ${DEFAULT_QUOTE_EVERY})
  --track-days <days>    an instrument read within this many days stays
                         tracked (default: ${DEFAULT_TRACK_DAYS})
  --source <name>        turn on a keyless source, repeated for each;
                         bvb: the Bucharest Stock Exchange's own feed
  -v, --version          show version
  -h, --help             show this help

\x1b[1mSecrets:\x1b[0m
  bearer.key             the bearer every request carries, at least 32
                         characters; the first start writes one
  admin.key              the key of /api/v1/admin/* alone; the first
                         start writes one
  source-<name>.key      a source's API key, which turns it on:
                         source-fred.key, source-finnhub.key or
                         source-massive.key`;

export const VALUED_FLAGS = [
  "--listen",
  "--data",
  "--quote-every",
  "--track-days",
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
  let listen = DEFAULT_LISTEN;
  let dataDir = defaultDataDir(home);
  let quoteEvery = DEFAULT_QUOTE_EVERY;
  let trackDays = DEFAULT_TRACK_DAYS;
  const sources = new Set<string>();

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
      case "--source":
        if (!(KNOWN_SOURCES as readonly string[]).includes(value)) {
          return {
            kind: "error",
            message: `unknown source ${value}; known sources: ${KNOWN_SOURCES.join(", ")}`,
          };
        }
        sources.add(value);
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
      sources: [...sources].sort(),
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
  ];
  for (const name of config.sources) args.push("--source", name);
  return args;
}
