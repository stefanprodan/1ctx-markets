// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// Stateless, so no session outlives a request.

import {
  createMcpHandler,
  type McpHttpHandler,
  McpServer,
} from "@modelcontextprotocol/server";
import {
  memorySkillFiles,
  SkillCatalog,
} from "@modelcontextprotocol/server/ext/skills";
import type { Markets } from "../operations/markets.ts";
import {
  type Access,
  type Credential,
  NO_ACCESS,
  type Who,
} from "../operations/who.ts";
import { errorFields, type Log, sdkErrorFields } from "../runtime/log.ts";
import { registerTools } from "../tools/index.ts";
import { SKILL_FILES } from "./skills.ts";

const ACCESS = ["none", "read", "write"];

function scoped(scopes: string[], area: string): Access {
  const access = scopes
    .find((s) => s.startsWith(`${area}:`))
    ?.slice(area.length + 1);
  return access !== undefined && ACCESS.includes(access)
    ? (access as Access)
    : "none";
}

// the router's caller, handed on as authInfo; none without it or without
// its person, so no tool reads anyone's rows by default
function whoFrom(
  info:
    | { clientId: string; scopes: string[]; extra?: Record<string, unknown> }
    | undefined,
): Who {
  const user = info?.extra?.user;
  const credential = info?.extra?.credential as Credential | undefined;
  if (info === undefined || typeof user !== "string" || !credential) {
    return NO_ACCESS;
  }
  return {
    name: info.clientId,
    user,
    credential,
    portfolio: scoped(info.scopes, "portfolio"),
    alerts: scoped(info.scopes, "alerts"),
    profile: scoped(info.scopes, "profile"),
    analysis: scoped(info.scopes, "analysis"),
    tradePlans: scoped(info.scopes, "trade_plans"),
  };
}

import { instructions } from "./instructions.ts";

export const SERVER_NAME = "1ctx-markets";

export function mcpHandler(
  version: string,
  log: Log,
  markets: Markets | null = null,
): McpHttpHandler {
  const register = markets === null ? null : registerTools(markets);
  // strict: a SKILL.md the SDK would only warn about fails instead
  const skills = SkillCatalog.load(memorySkillFiles(SKILL_FILES), {
    strict: true,
    // the phrase only: a warning's text quotes the skill's files
    onWarning: () => log.warn("mcp skill warning"),
  });
  // a failed load fails each request; this keeps it from going unhandled
  skills.catch((error) => log.error("mcp skills failed", errorFields(error)));
  return createMcpHandler(
    async (ctx) => {
      const who = whoFrom(ctx.authInfo);
      // declaring tools answers tools/list even with none registered
      // listChanged false: a stateless server never sends a change
      const server = new McpServer(
        { name: SERVER_NAME, version },
        {
          capabilities: {
            tools: { listChanged: false },
            resources: { listChanged: false },
          },
          // names only the tools this key lists
          instructions: instructions(who),
        },
      );
      register?.(server, who);
      (await skills).attach(server);
      return server;
    },
    {
      legacy: "stateless",
      responseMode: "auto",
      onerror: (error) => log.error("mcp error", sdkErrorFields(error)),
    },
  );
}
