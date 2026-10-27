// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The MCP endpoint on the SDK's Streamable HTTP handler, stateless as
// 1ctx serves its own, so no session outlives a request.

import {
  createMcpHandler,
  type McpHttpHandler,
  McpServer,
} from "@modelcontextprotocol/server";
import type { Markets } from "../operations/markets.ts";
import { type Log, sdkErrorFields } from "../runtime/log.ts";
import { registerTools } from "../tools/index.ts";
import { INSTRUCTIONS } from "./instructions.ts";

export const SERVER_NAME = "1ctx-markets";

// One server instance per request, each with the tools over the one set
// of application services.
export function mcpHandler(
  version: string,
  log: Log,
  markets: Markets | null = null,
): McpHttpHandler {
  const register = markets === null ? null : registerTools(markets);
  return createMcpHandler(
    () => {
      // declaring tools answers tools/list even with none registered
      const server = new McpServer(
        { name: SERVER_NAME, version },
        {
          capabilities: { tools: { listChanged: false } },
          instructions: INSTRUCTIONS,
        },
      );
      register?.(server);
      return server;
    },
    {
      legacy: "stateless",
      responseMode: "auto",
      onerror: (error) => log.error("mcp error", sdkErrorFields(error)),
    },
  );
}
