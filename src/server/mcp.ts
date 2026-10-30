// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// Stateless as 1ctx serves its own, so no session outlives a request.

import {
  createMcpHandler,
  type McpHttpHandler,
  McpServer,
} from "@modelcontextprotocol/server";
import type { Markets } from "../operations/markets.ts";
import { type Access, NO_ACCESS, type Who } from "../operations/who.ts";
import { type Log, sdkErrorFields } from "../runtime/log.ts";
import { registerTools } from "../tools/index.ts";

const ACCESS = ["none", "read", "write"];

function scoped(scopes: string[], area: string): Access {
  const access = scopes
    .find((s) => s.startsWith(`${area}:`))
    ?.slice(area.length + 1);
  return access !== undefined && ACCESS.includes(access)
    ? (access as Access)
    : "none";
}

// the router's caller, handed on as authInfo; none without it
function whoFrom(
  info: { clientId: string; scopes: string[] } | undefined,
): Who {
  if (info === undefined) return NO_ACCESS;
  return {
    name: info.clientId,
    portfolio: scoped(info.scopes, "portfolio"),
    rules: scoped(info.scopes, "rules"),
  };
}

import { INSTRUCTIONS } from "./instructions.ts";

export const SERVER_NAME = "1ctx-markets";

export function mcpHandler(
  version: string,
  log: Log,
  markets: Markets | null = null,
): McpHttpHandler {
  const register = markets === null ? null : registerTools(markets);
  return createMcpHandler(
    (ctx) => {
      // declaring tools answers tools/list even with none registered
      const server = new McpServer(
        { name: SERVER_NAME, version },
        {
          capabilities: { tools: { listChanged: false } },
          instructions: INSTRUCTIONS,
        },
      );
      register?.(server, whoFrom(ctx.authInfo));
      return server;
    },
    {
      legacy: "stateless",
      responseMode: "auto",
      onerror: (error) => log.error("mcp error", sdkErrorFields(error)),
    },
  );
}
