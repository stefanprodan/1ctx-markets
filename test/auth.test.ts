// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { KeyError, keys, requireBearer } from "../src/keys.ts";
import { format, logger, MASK } from "../src/log.ts";
import { SECRETS, withApp } from "./helpers/app.ts";
import { fakeClock } from "./helpers/clock.ts";

const WRONG = "wrong-bearer-0123456789abcdef0123456789abcdef";

const initialize = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "test", version: "1" },
  },
};

const post = (url: string, headers: Record<string, string>) =>
  fetch(`${url}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...headers,
    },
    body: JSON.stringify(initialize),
  });

describe("the bearer", () => {
  test("refuses HTTP without the bearer or with a wrong one", () =>
    withApp(async ({ url, bearer }) => {
      const refused: Record<string, string>[] = [
        {},
        { authorization: `Bearer ${WRONG}` },
        { authorization: `Bearer ${bearer}x` },
        { authorization: bearer },
        { authorization: `Basic ${bearer}` },
      ];
      for (const headers of refused) {
        const res = await fetch(`${url}/anything`, { headers });
        expect(res.status).toBe(401);
        expect(res.headers.get("www-authenticate")).toBe("Bearer");
      }
      const known = await fetch(`${url}/anything`, {
        headers: { authorization: `Bearer ${bearer}` },
      });
      expect(known.status).toBe(404);
    }));

  test("refuses MCP without the bearer or with a wrong one", () =>
    withApp(async ({ url, bearer }) => {
      expect((await post(url, {})).status).toBe(401);
      const wrong = await post(url, { authorization: `Bearer ${WRONG}` });
      expect(wrong.status).toBe(401);
      const right = await post(url, { authorization: `Bearer ${bearer}` });
      expect(right.status).toBe(200);

      const client = new Client({ name: "test", version: "1" });
      const transport = new StreamableHTTPClientTransport(
        new URL(`${url}/mcp`),
        { requestInit: { headers: { authorization: `Bearer ${WRONG}` } } },
      );
      await expect(client.connect(transport)).rejects.toThrow();
      await client.close();
    }));

  test("no key reaches a log line", () =>
    withApp(async ({ url, bearer, lines }) => {
      await fetch(url, { headers: { authorization: `Bearer ${WRONG}` } });
      await post(url, {});
      await post(url, { authorization: `Bearer ${bearer}` });
      await fetch(`${url}/mcp`, {
        headers: { authorization: `Bearer ${bearer}` },
      });
      // the requests' own lines, so the check below reads something
      const requests = lines.filter((line) => line.includes("msg=request"));
      expect(requests).toHaveLength(4);
      const finnhub = keys(SECRETS).source("finnhub")!;
      // no mask either: nothing tried to log a key
      for (const line of lines) {
        for (const secret of [bearer, WRONG, finnhub, MASK]) {
          expect(line).not.toContain(secret);
        }
      }
    }));

  test("a key handed to the logger is masked", () => {
    const store = keys(SECRETS);
    const finnhub = store.source("finnhub")!;
    const lines: string[] = [];
    const log = logger(fakeClock(), store.values, (line) => lines.push(line));
    log("test").error(`failed with ${finnhub}`, { error: `key=${finnhub}` });
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain(finnhub);
    expect(lines[0]).toContain(MASK);
    expect(format(0, "test", "info", "plain")).toBe(
      "time=1970-01-01T00:00:00.000Z level=INFO msg=plain area=test",
    );
  });
});

describe("key files", () => {
  test("a missing or short bearer stops the start without its value", () => {
    const missing = keys(join(SECRETS, "absent"));
    expect(() => requireBearer(missing)).toThrow(KeyError);
    expect(() => requireBearer(missing)).toThrow("bearer.key");

    const short = keys(join(SECRETS, "..", "short"));
    expect(() => requireBearer(short)).toThrow("shorter than 32 characters");
    expect(() => requireBearer(short)).not.toThrow(short.bearer()!);
  });

  test("a source key is read by name and a bad name is refused", () => {
    const store = keys(SECRETS);
    expect(store.source("finnhub")).toBe("test-finnhub-not-a-secret");
    expect(store.source("massive")).toBeNull();
    expect(() => store.source("../bearer")).toThrow("bad source name");
  });
});
