// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { SERVER_NAME } from "../src/mcp.ts";
import { withApp } from "./helpers/app.ts";

describe("the MCP endpoint", () => {
  test("answers an SDK client's initialize and its tool list", () =>
    withApp(async ({ url, bearer }) => {
      const client = new Client({ name: "test", version: "1" });
      const transport = new StreamableHTTPClientTransport(
        new URL(`${url}/mcp`),
        { requestInit: { headers: { authorization: `Bearer ${bearer}` } } },
      );
      await client.connect(transport);
      expect(client.getServerVersion()?.name).toBe(SERVER_NAME);
      expect(client.getServerVersion()?.version).toBe("v0.0.0-test");
      expect(client.getServerCapabilities()?.tools).toBeDefined();
      const names = [
        "quote",
        "history",
        "movers",
        "search",
        "screen",
        "research",
        "events",
      ];
      expect((await client.listTools()).tools.map((t) => t.name)).toEqual(
        names,
      );
      await client.close();

      // the client answers an empty list itself when the capability is
      // missing, so the server is asked directly too
      const res = await fetch(`${url}/mcp`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${bearer}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "mcp-protocol-version": "2025-06-18",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
      });
      expect(res.status).toBe(200);
      const text = await res.text();
      const body = JSON.parse(text.match(/^data: (.*)$/m)?.[1] ?? text);
      expect(body.error).toBeUndefined();
      expect(body.result.tools.map((t: any) => t.name)).toEqual(names);
    }));
});
