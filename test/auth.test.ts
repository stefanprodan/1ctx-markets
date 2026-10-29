// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
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
import { CALL_MS } from "../src/operations/markets.ts";
import {
  ADMIN_FILE,
  ADMIN_PREFIX,
  createAdmin,
  KeyError,
  keys,
  requireAdmin,
  startKeys,
} from "../src/runtime/keys.ts";
import { errorFields, format, logger, MASK } from "../src/runtime/log.ts";
import { IDLE_TIMEOUT_S, router } from "../src/server/http.ts";
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

describe("a key", () => {
  test("refuses HTTP without a key or with a wrong one", () =>
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
        // a challenge would start an MCP client's OAuth sign-in
        expect(res.headers.get("www-authenticate")).toBeNull();
      }
      const known = await fetch(`${url}/anything`, {
        headers: { authorization: `Bearer ${bearer}` },
      });
      expect(known.status).toBe(404);
    }));

  test("health answers without a key and is never logged", () =>
    withApp(async ({ url, lines }) => {
      const health = await fetch(`${url}/health`);
      expect(health.status).toBe(200);
      expect(await health.text()).toBe("");
      const posted = await fetch(`${url}/health`, { method: "POST" });
      expect(posted.status).toBe(405);
      expect(posted.headers.get("allow")).toBe("GET");
      for (const path of [
        "/health/",
        "/healthz",
        "/api/v1/quotes",
        "/quotes",
      ]) {
        expect((await fetch(`${url}${path}`)).status).toBe(401);
      }
      expect(lines.filter((line) => /path=\/health(\s|$)/.test(line))).toEqual(
        [],
      );
      expect(lines.filter((line) => line.includes("msg=request"))).toHaveLength(
        4,
      );
    }));

  test("refuses MCP without a key or with a wrong one", () =>
    withApp(async ({ url, bearer, admin }) => {
      const none = await post(url, {});
      expect(none.status).toBe(401);
      expect(none.headers.get("www-authenticate")).toBeNull();
      expect(await none.json()).toEqual({
        error: "unauthorized",
        message: "no or wrong key",
      });
      const wrong = await post(url, { authorization: `Bearer ${WRONG}` });
      expect(wrong.status).toBe(401);
      for (const key of [bearer, admin]) {
        const right = await post(url, { authorization: `Bearer ${key}` });
        expect(right.status).toBe(200);
      }

      const client = new Client({ name: "test", version: "1" });
      const transport = new StreamableHTTPClientTransport(
        new URL(`${url}/mcp`),
        { requestInit: { headers: { authorization: `Bearer ${WRONG}` } } },
      );
      await expect(client.connect(transport)).rejects.toThrow();
      await client.close();
    }));

  test("no key reaches a log line", () =>
    withApp(async ({ url, bearer, admin, lines }) => {
      await fetch(url, { headers: { authorization: `Bearer ${WRONG}` } });
      await post(url, {});
      await post(url, { authorization: `Bearer ${bearer}` });
      await fetch(`${url}/mcp`, {
        headers: { authorization: `Bearer ${bearer}` },
      });
      await post(url, { authorization: `Bearer ${admin}` });
      // the requests' own lines, so the check below reads something
      const requests = lines.filter((line) => line.includes("msg=request"));
      expect(requests).toHaveLength(5);
      // a request names its key by id and name, never by its token
      expect(requests[2]).toContain("key=testagentkey key_name=test-agent");
      expect(requests[4]).toContain("key=admin");
      expect(requests[0]).not.toContain("key=");
      const finnhub = keys(SECRETS).source("finnhub")!;
      // no mask either: nothing tried to log a key
      for (const line of lines) {
        for (const secret of [bearer, admin, WRONG, finnhub, MASK]) {
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
      access: { caller: () => ({ kind: "admin" }) },
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
  test("a missing or short admin key stops the start without its value", () => {
    const missing = keys(join(SECRETS, "absent"));
    expect(() => requireAdmin(missing)).toThrow(KeyError);
    expect(() => requireAdmin(missing)).toThrow("user-admin.key");

    const short = keys(join(SECRETS, "..", "short"));
    expect(() => requireAdmin(short)).toThrow("shorter than 32 characters");
    expect(() => requireAdmin(short)).not.toThrow(short.admin()!);

    const spaced = `${"a".repeat(20)} ${"b".repeat(20)}`;
    const store = {
      dir: SECRETS,
      admin: () => spaced,
      source: () => null,
      mask: () => {},
      values: () => [spaced],
    };
    expect(() => requireAdmin(store)).toThrow("printable ASCII");
    expect(() => requireAdmin(store)).not.toThrow(spaced);
    const accented = "é".repeat(40);
    expect(() => requireAdmin({ ...store, admin: () => accented })).toThrow(
      "printable ASCII",
    );
  });

  test("a first start writes only a prefixed admin key the owner reads", () => {
    const dir = join(mkdtempSync(join(tmpdir(), "keys-")), "secrets");
    const first = startKeys(keys(dir));
    expect(first.created).toBe(true);
    expect(readdirSync(dir)).toEqual([ADMIN_FILE]);
    const path = join(dir, ADMIN_FILE);
    const value = readFileSync(path, "utf8");
    expect(first.admin).toBe(value);
    expect(value).toMatch(/^1ctx-markets-admin-[A-Za-z0-9_-]{43}$/);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);

    expect(startKeys(keys(dir))).toEqual({ admin: value, created: false });
    const other = join(mkdtempSync(join(tmpdir(), "keys-")), "secrets");
    createAdmin(other);
    expect(readFileSync(join(other, ADMIN_FILE), "utf8")).not.toBe(value);
    expect(value.startsWith(ADMIN_PREFIX)).toBe(true);
  });

  test("a key under the old admin file name is never read", () => {
    const dir = join(mkdtempSync(join(tmpdir(), "keys-")), "secrets");
    mkdirSync(dir, { recursive: true });
    const old = "an-old-admin-file-0123456789abcdef0123456789";
    writeFileSync(join(dir, "admin.key"), old);
    const started = startKeys(keys(dir));
    expect(started.created).toBe(true);
    expect(started.admin).not.toBe(old);
    expect(readdirSync(dir).sort()).toEqual(["admin.key", ADMIN_FILE]);
  });

  test("an existing admin key file is never replaced, even an empty one", () => {
    const dir = mkdtempSync(join(tmpdir(), "keys-"));
    writeFileSync(join(dir, ADMIN_FILE), "");
    expect(createAdmin(dir)).toBe(false);
    expect(readFileSync(join(dir, ADMIN_FILE), "utf8")).toBe("");
    expect(() => startKeys(keys(dir))).toThrow("remove it and start again");

    const kept = "an-older-admin-key-0123456789abcdef0123456789";
    writeFileSync(join(dir, ADMIN_FILE), kept);
    expect(startKeys(keys(dir))).toEqual({ admin: kept, created: false });
  });

  test("an admin key that cannot be written stops the start naming the file", () => {
    const root = mkdtempSync(join(tmpdir(), "keys-"));
    const dir = join(root, "secrets");
    mkdirSync(dir);
    chmodSync(dir, 0o500);
    try {
      expect(() => createAdmin(dir)).toThrow(KeyError);
      expect(() => createAdmin(dir)).toThrow(join(dir, ADMIN_FILE));
    } finally {
      chmodSync(dir, 0o700);
    }
  });

  test("a source key is read by name and a bad name is refused", () => {
    const store = keys(SECRETS);
    expect(store.source("finnhub")).toBe("test-finnhub-not-a-secret");
    expect(store.source("massive")).toBeNull();
    expect(() => store.source("../admin")).toThrow("bad source name");
  });
});
