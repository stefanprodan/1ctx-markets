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
  test("answers an SDK client's initialize and an empty tool list", () =>
    withApp(async ({ url, bearer }) => {
      const client = new Client({ name: "test", version: "1" });
      const transport = new StreamableHTTPClientTransport(
        new URL(`${url}/mcp`),
        { requestInit: { headers: { authorization: `Bearer ${bearer}` } } },
      );
      await client.connect(transport);
      expect(client.getServerVersion()?.name).toBe(SERVER_NAME);
      expect(client.getServerVersion()?.version).toBe("v0.0.0-test");
      expect((await client.listTools()).tools).toEqual([]);
      await client.close();
    }));
});
