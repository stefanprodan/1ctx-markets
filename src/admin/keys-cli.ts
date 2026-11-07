// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// `1ctx-markets keys`: the running server's agent keys, called with
// user-admin.key, the operator's. A made key goes to stdout once, and
// nowhere else. A name is the operator's own key; another person's is
// named by its id alone, since two people may name keys alike.

import {
  ALERTS_ACCESS,
  ANALYSIS_ACCESS,
  KEY_DAYS,
  PORTFOLIO_ACCESS,
  PROFILE_ACCESS,
  TRADE_PLANS_ACCESS,
} from "../server/access.ts";
import {
  type AdminCliDeps,
  AdminError,
  adminTarget,
  TIMEOUT_MS,
} from "./cli.ts";

const USAGE = `usage: 1ctx-markets keys [--listen <host:port>] [--data <dir>] <command>
  list                            every person's agent keys, never tokens
  add <name> [--expires <days>] [--portfolio <access>] [--alerts <access>]
      [--profile <access>] [--analysis <access>]
      [--trade-plans <access>]
                                  make a key and print it once; days:
                                  ${KEY_DAYS.join(", ")} (default: never);
                                  access: none, read or write (default: none)
  set <name> [--portfolio <access>] [--alerts <access>] [--profile <access>]
      [--analysis <access>] [--trade-plans <access>]
                                  change an operator's key's access; its
                                  token stays
  revoke <name>|<id>              revoke an operator's key by name, or
                                  anyone's by id; an agent using it is
                                  refused`;

type Parsed = {
  listen: string | null;
  data: string | null;
  command: "list" | "add" | "set" | "revoke";
  name: string | null;
  days: number | null;
  portfolio: string | null;
  alerts: string | null;
  profile: string | null;
  analysis: string | null;
  tradePlans: string | null;
};

function parse(argv: string[]): Parsed {
  let listen: string | null = null;
  let data: string | null = null;
  let days: number | null = null;
  let portfolio: string | null = null;
  let alerts: string | null = null;
  let profile: string | null = null;
  let analysis: string | null = null;
  let tradePlans: string | null = null;
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
    } else if (arg === "--alerts") {
      if (!(ALERTS_ACCESS as readonly string[]).includes(value)) {
        throw new AdminError(`--alerts is ${ALERTS_ACCESS.join(", ")}`);
      }
      alerts = value;
    } else if (arg === "--profile") {
      if (!(PROFILE_ACCESS as readonly string[]).includes(value)) {
        throw new AdminError(`--profile is ${PROFILE_ACCESS.join(", ")}`);
      }
      profile = value;
    } else if (arg === "--analysis") {
      if (!(ANALYSIS_ACCESS as readonly string[]).includes(value)) {
        throw new AdminError(`--analysis is ${ANALYSIS_ACCESS.join(", ")}`);
      }
      analysis = value;
    } else if (arg === "--trade-plans") {
      if (!(TRADE_PLANS_ACCESS as readonly string[]).includes(value)) {
        throw new AdminError(
          `--trade-plans is ${TRADE_PLANS_ACCESS.join(", ")}`,
        );
      }
      tradePlans = value;
    } else throw new AdminError(USAGE);
  }
  const [command, ...rest] = positional;
  const named = command === "add" || command === "set" || command === "revoke";
  if (command === "list" ? rest.length !== 0 : !named || rest.length !== 1) {
    throw new AdminError(USAGE);
  }
  if (days !== null && command !== "add") throw new AdminError(USAGE);
  const access =
    portfolio !== null ||
    alerts !== null ||
    profile !== null ||
    analysis !== null ||
    tradePlans !== null;
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
    alerts,
    profile,
    analysis,
    tradePlans,
  };
}

type Listed = { keys: { id: string; name: string; owner: { id: string } }[] };

const OPERATOR = "operator";

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
        ...(p.alerts === null ? {} : { alerts: p.alerts }),
        ...(p.profile === null ? {} : { profile: p.profile }),
        ...(p.analysis === null ? {} : { analysis: p.analysis }),
        ...(p.tradePlans === null ? {} : { trade_plans: p.tradePlans }),
      }),
    })) as { token: string };
    write(made.token);
    return;
  }
  const listed = (await call("/keys")) as Listed;
  const found =
    listed.keys.find((k) => k.owner.id === OPERATOR && k.name === p.name) ??
    (p.command === "revoke"
      ? listed.keys.find((k) => k.id === p.name)
      : undefined);
  if (found === undefined) throw new AdminError(`no key named ${p.name}`);
  const path = `/keys/${encodeURIComponent(found.id)}`;
  if (p.command === "set") {
    await call(path, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...(p.portfolio === null ? {} : { portfolio: p.portfolio }),
        ...(p.alerts === null ? {} : { alerts: p.alerts }),
        ...(p.profile === null ? {} : { profile: p.profile }),
        ...(p.analysis === null ? {} : { analysis: p.analysis }),
        ...(p.tradePlans === null ? {} : { trade_plans: p.tradePlans }),
      }),
    });
    write(`set ${p.name}`);
    return;
  }
  await call(path, { method: "DELETE" });
  write(`revoked ${p.name}`);
}
