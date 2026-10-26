// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { IDLE_TIMEOUT_S, router } from "../src/http.ts";
import {
  BEARER_FILE,
  BEARER_PREFIX,
  createBearer,
  KeyError,
  keys,
  requireBearer,
} from "../src/keys.ts";
import { errorFields, format, logger, MASK } from "../src/log.ts";
import { CALL_MS } from "../src/tools/targets.ts";
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

  test("health answers without the bearer and is never logged", () =>
    withApp(async ({ url, lines }) => {
      const health = await fetch(`${url}/health`);
      expect(health.status).toBe(200);
      expect(await health.text()).toBe("");
      const posted = await fetch(`${url}/health`, { method: "POST" });
      expect(posted.status).toBe(405);
      expect(posted.headers.get("allow")).toBe("GET");
      for (const path of ["/health/", "/healthz", "/quotes", "/alerts"]) {
        expect((await fetch(`${url}${path}`)).status).toBe(401);
      }
      expect(lines.filter((line) => /path=\/health(\s|$)/.test(line))).toEqual(
        [],
      );
      expect(lines.filter((line) => line.includes("msg=request"))).toHaveLength(
        4,
      );
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

  test("a request that throws logs its type, never its text", async () => {
    const lines: string[] = [];
    const clock = fakeClock();
    const log = logger(
      clock,
      () => [],
      (line) => lines.push(line),
    )("http");
    const handle = router({
      bearer: WRONG,
      mcp: {
        fetch: async () => {
          throw new TypeError('bad params {"symbol":"quoted-request"}');
        },
      } as never,
      clock,
      log,
    });
    const res = await handle(
      new Request("http://localhost/mcp", {
        method: "POST",
        headers: { authorization: `Bearer ${WRONG}` },
      }),
    );
    expect(res.status).toBe(500);
    const failed = lines.find((line) => line.includes("request failed"));
    expect(failed).toContain("TypeError");
    for (const line of lines) expect(line).not.toContain("quoted-request");
  });

  test("a key handed to the logger is masked", () => {
    const store = keys(SECRETS);
    const finnhub = store.source("finnhub")!;
    const lines: string[] = [];
    const log = logger(fakeClock(), store.values, (line) => lines.push(line));
    log("test").error(`failed with ${finnhub}`, { error: `key=${finnhub}` });
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain(finnhub);
    expect(lines[0]).toContain(MASK);
    const odd = "key with/odd+chars=0123456789abcdef";
    const sent: string[] = [];
    logger(
      fakeClock(),
      () => [odd],
      (line) => sent.push(line),
    )("test").info("request", { path: `/mcp/${encodeURIComponent(odd)}` });
    expect(sent[0]).not.toContain(encodeURIComponent(odd));
    expect(sent[0]).toContain(MASK);
    for (const path of [
      encodeURIComponent(odd).toLowerCase(),
      encodeURI(odd),
      `%zz/${encodeURI(odd)}`,
    ]) {
      const line = format(0, "test", "info", "request", { path }, [odd]);
      expect(line).not.toContain(path);
      expect(line).toContain(MASK);
    }
    expect(format(0, "test", "info", "plain")).toBe(
      "time=1970-01-01T00:00:00.000Z level=INFO msg=plain area=test",
    );
  });
});

describe("the server", () => {
  test("keeps a request open past a tool call's deadline", () => {
    // Bun's own default of 10 s cut a quote call that fetched new symbols
    expect(IDLE_TIMEOUT_S * 1000).toBeGreaterThan(CALL_MS + 10_000);
    expect(IDLE_TIMEOUT_S).toBeLessThanOrEqual(255);
  });
});

describe("error fields", () => {
  test("keep only the first line of a message", () => {
    const fields = errorFields(new TypeError("first line\nsecond line"));
    expect(fields).toEqual({ error_type: "TypeError", error: "first line" });
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

    const spaced = `${"a".repeat(20)} ${"b".repeat(20)}`;
    const store = {
      dir: SECRETS,
      bearer: () => spaced,
      admin: () => null,
      source: () => null,
      values: () => [spaced],
    };
    expect(() => requireBearer(store)).toThrow("printable ASCII");
    expect(() => requireBearer(store)).not.toThrow(spaced);
    const accented = "é".repeat(40);
    expect(() => requireBearer({ ...store, bearer: () => accented })).toThrow(
      "printable ASCII",
    );
  });

  test("a first start writes a prefixed bearer only the owner reads", () => {
    const dir = join(mkdtempSync(join(tmpdir(), "bearer-")), "secrets");
    expect(createBearer(dir)).toBe(true);
    const path = join(dir, BEARER_FILE);
    const value = readFileSync(path, "utf8");
    expect(value).toMatch(/^1ctx-markets-[A-Za-z0-9_-]{43}$/);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(requireBearer(keys(dir))).toBe(value);

    expect(createBearer(dir)).toBe(false);
    expect(readFileSync(path, "utf8")).toBe(value);
    const other = join(mkdtempSync(join(tmpdir(), "bearer-")), "secrets");
    createBearer(other);
    expect(readFileSync(join(other, BEARER_FILE), "utf8")).not.toBe(value);
    expect(value.startsWith(BEARER_PREFIX)).toBe(true);
  });

  test("an existing bearer file is never replaced, even an empty one", () => {
    const dir = mkdtempSync(join(tmpdir(), "bearer-"));
    writeFileSync(join(dir, BEARER_FILE), "");
    expect(createBearer(dir)).toBe(false);
    expect(readFileSync(join(dir, BEARER_FILE), "utf8")).toBe("");
    expect(() => requireBearer(keys(dir))).toThrow("remove it and start again");

    const kept = "an-older-bearer-0123456789abcdef0123456789";
    writeFileSync(join(dir, BEARER_FILE), kept);
    expect(createBearer(dir)).toBe(false);
    expect(requireBearer(keys(dir))).toBe(kept);
  });

  test("a bearer that cannot be written stops the start naming the file", () => {
    const root = mkdtempSync(join(tmpdir(), "bearer-"));
    const dir = join(root, "secrets");
    mkdirSync(dir);
    chmodSync(dir, 0o500);
    try {
      expect(() => createBearer(dir)).toThrow(KeyError);
      expect(() => createBearer(dir)).toThrow(join(dir, BEARER_FILE));
    } finally {
      chmodSync(dir, 0o700);
    }
  });

  test("a source key is read by name and a bad name is refused", () => {
    const store = keys(SECRETS);
    expect(store.source("finnhub")).toBe("test-finnhub-not-a-secret");
    expect(store.source("massive")).toBeNull();
    expect(() => store.source("../bearer")).toThrow("bad source name");
  });
});
