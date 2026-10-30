// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// `1ctx-markets keys`: the running server's agent keys, called with
// user-admin.key. A made key goes to stdout once, and nowhere else.

import { KEY_DAYS, PORTFOLIO_ACCESS, RULES_ACCESS } from "../server/access.ts";
import {
  type AdminCliDeps,
  AdminError,
  adminTarget,
  TIMEOUT_MS,
} from "./cli.ts";

const USAGE = `usage: 1ctx-markets keys [--listen <host:port>] [--data <dir>] <command>
  list                            the agent keys, never their tokens
  add <name> [--expires <days>] [--portfolio <access>] [--rules <access>]
                                  make a key and print it once; days:
                                  ${KEY_DAYS.join(", ")} (default: never);
                                  access: none, read or write (default: none)
  set <name> [--portfolio <access>] [--rules <access>]
                                  change a key's access; its token stays
  revoke <name>                   revoke a key; an agent using it is refused`;

type Parsed = {
  listen: string | null;
  data: string | null;
  command: "list" | "add" | "set" | "revoke";
  name: string | null;
  days: number | null;
  portfolio: string | null;
  rules: string | null;
};

function parse(argv: string[]): Parsed {
  let listen: string | null = null;
  let data: string | null = null;
  let days: number | null = null;
  let portfolio: string | null = null;
  let rules: string | null = null;
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
    } else if (arg === "--portfolio") {
      if (!(PORTFOLIO_ACCESS as readonly string[]).includes(value)) {
        throw new AdminError(`--portfolio is ${PORTFOLIO_ACCESS.join(", ")}`);
      }
      portfolio = value;
    } else if (arg === "--rules") {
      if (!(RULES_ACCESS as readonly string[]).includes(value)) {
        throw new AdminError(`--rules is ${RULES_ACCESS.join(", ")}`);
      }
      rules = value;
    } else throw new AdminError(USAGE);
  }
  const [command, ...rest] = positional;
  const named = command === "add" || command === "set" || command === "revoke";
  if (command === "list" ? rest.length !== 0 : !named || rest.length !== 1) {
    throw new AdminError(USAGE);
  }
  if (days !== null && command !== "add") throw new AdminError(USAGE);
  const access = portfolio !== null || rules !== null;
  if (access && command !== "add" && command !== "set") {
    throw new AdminError(USAGE);
  }
  if (command === "set" && !access) throw new AdminError(USAGE);
  return {
    listen,
    data,
    command: command as Parsed["command"],
    name: rest[0] ?? null,
    days,
    portfolio,
    rules,
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
      body: JSON.stringify({
        name: p.name,
        expiresInDays: p.days,
        ...(p.portfolio === null ? {} : { portfolio: p.portfolio }),
        ...(p.rules === null ? {} : { rules: p.rules }),
      }),
    })) as { token: string };
    write(made.token);
    return;
  }
  const listed = (await call("/keys")) as Listed;
  const found = listed.keys.find((k) => k.name === p.name);
  if (found === undefined) throw new AdminError(`no key named ${p.name}`);
  const path = `/keys/${encodeURIComponent(found.id)}`;
  if (p.command === "set") {
    await call(path, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...(p.portfolio === null ? {} : { portfolio: p.portfolio }),
        ...(p.rules === null ? {} : { rules: p.rules }),
      }),
    });
    write(`set ${p.name}`);
    return;
  }
  await call(path, { method: "DELETE" });
  write(`revoked ${p.name}`);
}
