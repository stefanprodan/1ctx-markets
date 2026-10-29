// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// `1ctx-markets keys`: the running server's agent keys, called with
// user-admin.key. A made key goes to stdout once, and nowhere else.

import { KEY_DAYS } from "../server/access.ts";
import {
  type AdminCliDeps,
  AdminError,
  adminTarget,
  TIMEOUT_MS,
} from "./cli.ts";

const USAGE = `usage: 1ctx-markets keys [--listen <host:port>] [--data <dir>] <command>
  list                            the agent keys, never their tokens
  add <name> [--expires <days>]   make a key and print it once; days:
                                  ${KEY_DAYS.join(", ")} (default: never)
  revoke <name>                   revoke a key; an agent using it is refused`;

type Parsed = {
  listen: string | null;
  data: string | null;
  command: "list" | "add" | "revoke";
  name: string | null;
  days: number | null;
};

function parse(argv: string[]): Parsed {
  let listen: string | null = null;
  let data: string | null = null;
  let days: number | null = null;
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith("-")) {
      positional.push(arg);
      continue;
    }
    const value = argv[++i];
    if (value === undefined) throw new AdminError(USAGE);
    if (arg === "--listen") listen = value;
    else if (arg === "--data") data = value;
    else if (arg === "--expires") {
      days = Number(value);
      if (!(KEY_DAYS as readonly number[]).includes(days)) {
        throw new AdminError(`--expires is ${KEY_DAYS.join(", ")}`);
      }
    } else throw new AdminError(USAGE);
  }
  const [command, ...rest] = positional;
  const named = command === "add" || command === "revoke";
  if (command === "list" ? rest.length !== 0 : !named || rest.length !== 1) {
    throw new AdminError(USAGE);
  }
  if (days !== null && command !== "add") throw new AdminError(USAGE);
  return {
    listen,
    data,
    command: command as Parsed["command"],
    name: rest[0] ?? null,
    days,
  };
}

type Listed = { keys: { id: string; name: string }[] };

export async function runKeys(
  argv: string[],
  deps: AdminCliDeps = {},
): Promise<void> {
  const p = parse(argv);
  const { url, key } = await adminTarget(p, deps, USAGE);
  const doFetch = deps.fetch ?? ((u, i) => fetch(u, i));
  const write = deps.write ?? ((line: string) => console.log(line));
  const call = async (
    path: string,
    init: RequestInit = {},
  ): Promise<unknown> => {
    let res: Response;
    let text: string;
    try {
      res = await doFetch(`${url}/api/v1${path}`, {
        ...init,
        headers: {
          ...(init.headers as Record<string, string> | undefined),
          authorization: `Bearer ${key}`,
        },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      text = await res.text();
    } catch {
      throw new AdminError(`no answer from ${url}`);
    }
    let body: unknown = null;
    try {
      body = text === "" ? null : JSON.parse(text);
    } catch {}
    if (!res.ok) {
      const detail = (body as { detail?: unknown } | null)?.detail;
      throw new AdminError(
        typeof detail === "string"
          ? `${detail} (${res.status})`
          : `the server answered ${res.status}`,
      );
    }
    return body;
  };
  if (p.command === "list") {
    write(JSON.stringify(await call("/keys"), null, 2));
    return;
  }
  if (p.command === "add") {
    const made = (await call("/keys", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: p.name, expiresInDays: p.days }),
    })) as { token: string };
    write(made.token);
    return;
  }
  const listed = (await call("/keys")) as Listed;
  const found = listed.keys.find((k) => k.name === p.name);
  if (found === undefined) throw new AdminError(`no key named ${p.name}`);
  await call(`/keys/${encodeURIComponent(found.id)}`, { method: "DELETE" });
  write(`revoked ${p.name}`);
}
