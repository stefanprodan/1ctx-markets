// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// `1ctx-markets users`: the running server's people, called with
// user-admin.key. A person is added by invite email, never a link handed
// over.

import {
  type AdminCliDeps,
  AdminError,
  adminTarget,
  TIMEOUT_MS,
} from "./cli.ts";
import { ROLES } from "./users.ts";

const USAGE = `usage: 1ctx-markets users [--listen <host:port>] [--data <dir>] <command>
  list                            the people, their role and last sign-in
  add <email> <name> [--role <role>]
                                  add a person and email them an invite;
                                  role: ${ROLES.join(" or ")} (default: member)
  invite <id>                     email the invite again
  sign-out <id>                   end their sign-ins and live links
  remove <id> [--dry-run]         delete the person and every row of theirs;
                                  --dry-run counts them only`;

type Parsed = {
  listen: string | null;
  data: string | null;
  command: "list" | "add" | "invite" | "sign-out" | "remove";
  args: string[];
  role: string | null;
  dryRun: boolean;
};

function parse(argv: string[]): Parsed {
  let listen: string | null = null;
  let data: string | null = null;
  let role: string | null = null;
  let dryRun = false;
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (!arg.startsWith("-")) {
      positional.push(arg);
      continue;
    }
    const value = argv[++i];
    if (value === undefined) throw new AdminError(USAGE);
    if (arg === "--listen") listen = value;
    else if (arg === "--data") data = value;
    else if (arg === "--role") {
      if (!(ROLES as readonly string[]).includes(value)) {
        throw new AdminError(`--role is ${ROLES.join(" or ")}`);
      }
      role = value;
    } else throw new AdminError(USAGE);
  }
  const [command, ...args] = positional;
  const want: Record<string, number> = {
    list: 0,
    add: 2,
    invite: 1,
    "sign-out": 1,
    remove: 1,
  };
  if (command === undefined || want[command] !== args.length) {
    throw new AdminError(USAGE);
  }
  if (role !== null && command !== "add") throw new AdminError(USAGE);
  if (dryRun && command !== "remove") throw new AdminError(USAGE);
  return {
    listen,
    data,
    command: command as Parsed["command"],
    args,
    role,
    dryRun,
  };
}

export async function runUsers(
  argv: string[],
  deps: AdminCliDeps = {},
): Promise<void> {
  const p = parse(argv);
  const { url, key } = await adminTarget(p, deps, USAGE);
  const doFetch = deps.fetch ?? ((u, i) => fetch(u, i));
  const write = deps.write ?? ((line: string) => console.log(line));
  const call = async (path: string, init: RequestInit = {}) => {
    let res: Response;
    let text: string;
    try {
      res = await doFetch(`${url}/api/v1${path}`, {
        ...init,
        headers: {
          ...(init.body === undefined
            ? {}
            : { "content-type": "application/json" }),
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
  const at = (id: string) => `/users/${encodeURIComponent(id)}`;
  const print = (body: unknown) => write(JSON.stringify(body, null, 2));
  switch (p.command) {
    case "list":
      print(await call("/users"));
      return;
    case "add":
      print(
        await call("/users", {
          method: "POST",
          body: JSON.stringify({
            email: p.args[0],
            name: p.args[1],
            role: p.role ?? "member",
          }),
        }),
      );
      return;
    case "invite":
      print(await call(`${at(p.args[0]!)}/invite`, { method: "POST" }));
      return;
    case "sign-out":
      await call(`${at(p.args[0]!)}/sign-out`, { method: "POST" });
      write(`signed out ${p.args[0]}`);
      return;
    case "remove":
      print(
        await call(`${at(p.args[0]!)}${p.dryRun ? "?dry_run=true" : ""}`, {
          method: "DELETE",
        }),
      );
      return;
  }
}
