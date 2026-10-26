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
import type { Log, LogFields } from "./log.ts";
import { registerTools } from "./tools/index.ts";
import type { Markets } from "./tools/targets.ts";

export const SERVER_NAME = "1ctx-markets";

// the type and code only: an SDK message can quote the request
function sdkErrorFields(error: unknown): LogFields {
  const fields: LogFields = {
    error: "mcp sdk error",
    error_type: "exception",
  };
  if (error instanceof Error) {
    const name = error.name === "Error" ? error.constructor.name : error.name;
    if (/^[A-Za-z][A-Za-z0-9]{0,39}$/.test(name)) fields.error_type = name;
  }
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === "number" && Number.isSafeInteger(code)) {
    fields.error_code = code;
  }
  return fields;
}

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
        { capabilities: { tools: { listChanged: false } } },
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
