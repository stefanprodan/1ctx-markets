// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The command line, parsed without acting on it; main.ts runs what it
// answers.

import { homedir } from "node:os";
import { join } from "node:path";
import { MINUTE_MS } from "./clock.ts";

export const DEFAULT_LISTEN = "127.0.0.1:11237";
export const DEFAULT_QUOTE_EVERY = 5;
export const DEFAULT_TRACK_DAYS = 30;
export const DEFAULT_INLINE_FETCH = 5;

export type Config = {
  hostname: string;
  port: number;
  // holds markets.db and secrets/
  dataDir: string;
  quoteEveryMs: number;
  // an instrument read within this many days stays tracked
  trackDays: number;
  // the most unknown instruments one read fetches inside the call
  inlineFetch: number;
};

export const dbPath = (config: Config): string =>
  join(config.dataDir, "markets.db");
export const secretsDir = (config: Config): string =>
  join(config.dataDir, "secrets");

export type Cli =
  | { kind: "run"; config: Config }
  | { kind: "help" }
  | { kind: "version" }
  | { kind: "error"; message: string };

export const HELP = `\x1b[1m1ctx-markets\x1b[0m - a self-hosted market data server for AI agents

\x1b[1mUsage:\x1b[0m
  1ctx-markets [options]

\x1b[1mOptions:\x1b[0m
  --listen <host:port>   bind address (default: ${DEFAULT_LISTEN})
  --data <dir>           holds markets.db and secrets/
                         (default: ~/.1ctx-markets)
  --quote-every <min>    minutes between quote syncs (default: ${DEFAULT_QUOTE_EVERY})
  --track-days <days>    an instrument read within this many days stays
                         tracked (default: ${DEFAULT_TRACK_DAYS})
  --inline-fetch <n>     the most unknown instruments one read fetches
                         (default: ${DEFAULT_INLINE_FETCH})
  -v, --version          show version
  -h, --help             show this help

\x1b[1mSecrets:\x1b[0m
  bearer.key             the bearer every request carries, at least 32
                         characters; the server will not start without it
  source-<name>.key      a source's API key, which turns it on, e.g.
                         source-fred.key`;

const VALUED_FLAGS = [
  "--listen",
  "--data",
  "--quote-every",
  "--track-days",
  "--inline-fetch",
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
  let listen = DEFAULT_LISTEN;
  let dataDir = defaultDataDir(home);
  let quoteEvery = DEFAULT_QUOTE_EVERY;
  let trackDays = DEFAULT_TRACK_DAYS;
  let inlineFetch = DEFAULT_INLINE_FETCH;

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
      case "--inline-fetch": {
        const n = positive();
        if (typeof n === "string") return { kind: "error", message: n };
        inlineFetch = n;
        break;
      }
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
      inlineFetch,
    },
  };
}
