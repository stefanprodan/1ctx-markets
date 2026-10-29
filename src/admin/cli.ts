// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// Calls the running server with the admin key; opens no db and prints no key.

import { homedir } from "node:os";
import { join } from "node:path";
import { type Config, parseCli, secretsDir } from "../runtime/config.ts";
import { ADMIN_FILE, keys } from "../runtime/keys.ts";
import { serviceConfig, urlOf } from "../service/index.ts";
import { PARTS, RESEARCH_SECTIONS } from "./refetch.ts";

// over the server's own 30-second idle limit, which ends a stuck request
const TIMEOUT_MS = 40_000;

const USAGE = `usage: 1ctx-markets admin [--listen <host:port>] [--data <dir>] <command>
  status                          what the server and its sources are doing
  refetch [--fetch <parts>] [--sections <sections>] <id>...
                                  ask the sources again for stored instruments;
                                  parts: ${PARTS.join(",")} (default: all);
                                  sections: ${RESEARCH_SECTIONS.join(",")}
  delete <id>                     remove an instrument and all its rows`;

export class AdminError extends Error {}

export type AdminCliDeps = {
  home?: string;
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
  write?: (line: string) => void;
  // the installed service's options, null when none
  service?: () => Promise<Config | null>;
};

type Parsed = {
  listen: string | null;
  data: string | null;
  command: string;
  ids: string[];
  fetch: string[] | null;
  sections: string[] | null;
};

function parse(argv: string[]): Parsed {
  const out: Parsed = {
    listen: null,
    data: null,
    command: "",
    ids: [],
    fetch: null,
    sections: null,
  };
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith("-")) {
      positional.push(arg);
      continue;
    }
    const value = argv[++i];
    if (value === undefined) throw new AdminError(USAGE);
    const csv = value.split(",").filter((v) => v !== "");
    if (arg === "--listen") out.listen = value;
    else if (arg === "--data") out.data = value;
    else if (arg === "--fetch") out.fetch = csv;
    else if (arg === "--sections") out.sections = csv;
    else throw new AdminError(USAGE);
  }
  const [command, ...ids] = positional;
  if (command === undefined) throw new AdminError(USAGE);
  out.command = command;
  out.ids = ids;
  const refetch = command === "refetch";
  const valid =
    (command === "status" && ids.length === 0) ||
    (refetch && ids.length > 0) ||
    (command === "delete" && ids.length === 1);
  if (!valid || (!refetch && (out.fetch !== null || out.sections !== null))) {
    throw new AdminError(USAGE);
  }
  return out;
}

// the flags first, then the installed service's options, then the defaults
async function configOf(p: Parsed, deps: AdminCliDeps): Promise<Config> {
  const home = deps.home ?? homedir();
  const installed =
    p.listen === null || p.data === null
      ? await (deps.service ?? (() => serviceConfig({ home })))()
      : null;
  const args: string[] = [];
  const listen =
    p.listen ??
    (installed === null ? null : `${installed.hostname}:${installed.port}`);
  const data = p.data ?? installed?.dataDir ?? null;
  if (listen !== null) args.push("--listen", listen);
  if (data !== null) args.push("--data", data);
  const cli = parseCli(args, home);
  if (cli.kind === "error") throw new AdminError(cli.message);
  if (cli.kind !== "run") throw new AdminError(USAGE);
  return cli.config;
}

type Call = { path: string; init: RequestInit };

const at = (id: string) => `/api/v1/instruments/${encodeURIComponent(id)}`;

// refetch is one call per instrument, in the order given
function requests(p: Parsed): Call[] {
  if (p.command === "status") {
    return [{ path: "/api/v1/status", init: { method: "GET" } }];
  }
  if (p.command === "delete") {
    return [{ path: at(p.ids[0]!), init: { method: "DELETE" } }];
  }
  const body: Record<string, unknown> = { parts: p.fetch ?? [...PARTS] };
  if (p.sections !== null) body.sections = p.sections;
  return p.ids.map((id) => ({
    path: `${at(id)}/refetch`,
    init: {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  }));
}

// the answer's JSON, its text when it is none, null when empty
function answerOf(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text === "" ? null : text;
  }
}

export async function runAdmin(
  argv: string[],
  deps: AdminCliDeps = {},
): Promise<void> {
  const p = parse(argv);
  const config = await configOf(p, deps);
  const dir = secretsDir(config);
  const key = keys(dir).admin();
  if (key === null) {
    throw new AdminError(
      `${join(dir, ADMIN_FILE)} is missing or unreadable; the server writes it at its first start`,
    );
  }
  const url = urlOf(config);
  const doFetch = deps.fetch ?? ((u, i) => fetch(u, i));
  const write = deps.write ?? ((line: string) => console.log(line));
  const answers: unknown[] = [];
  const failed: string[] = [];
  // past a failed call the next still runs, so one bad id stops no other
  for (const [k, { path, init }] of requests(p).entries()) {
    let res: Response;
    let text: string;
    try {
      res = await doFetch(`${url}${path}`, {
        ...init,
        headers: {
          ...(init.headers as Record<string, string> | undefined),
          authorization: `Bearer ${key}`,
        },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      text = await res.text();
    } catch {
      const said = `no answer from ${url}`;
      if (p.command !== "refetch") throw new AdminError(said);
      answers.push({ input: p.ids[k], error: said });
      failed.push(said);
      continue;
    }
    answers.push(answerOf(text));
    if (!res.ok) failed.push(`the server answered ${res.status}`);
  }
  if (p.command === "delete" && failed.length === 0) {
    write(`deleted ${p.ids[0]}`);
  } else {
    const out = p.command === "refetch" ? answers : answers[0];
    if (typeof out === "string") write(out);
    else if (out !== null) write(JSON.stringify(out, null, 2));
  }
  if (failed.length > 0) {
    throw new AdminError(failed.join("; "));
  }
}
