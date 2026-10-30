// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { AdminError } from "../src/admin/cli.ts";
import { runKeys } from "../src/admin/keys-cli.ts";
import { PREFIX } from "../src/api/http.ts";
import { parseRules, rulesAnswer } from "../src/operations/rules.ts";
import type { Access } from "../src/operations/who.ts";
import { DAY_MS } from "../src/runtime/clock.ts";
import { ADMIN_KEY, api } from "./helpers/api.ts";
import { SECRETS, type TestApp, withApp } from "./helpers/app.ts";
import { world } from "./helpers/world.ts";

const as = (key: string) => ({ authorization: `Bearer ${key}` });
const sent = (method: string, body: unknown, key: string): RequestInit => ({
  method,
  headers: { "content-type": "application/json", ...as(key) },
  body: JSON.stringify(body),
});

async function make(t: TestApp, body: object) {
  const res = await fetch(
    `${t.url}${PREFIX}/keys`,
    sent("POST", body, t.admin),
  );
  expect(res.status).toBe(201);
  return (await res.json()) as {
    token: string;
    key: { id: string; rules: Access; portfolio: Access };
  };
}

async function client(t: TestApp, token: string): Promise<Client> {
  const c = new Client({ name: "test", version: "1" });
  await c.connect(
    new StreamableHTTPClientTransport(new URL(`${t.url}/mcp`), {
      requestInit: { headers: as(token) },
    }),
  );
  return c;
}

// each rules action over MCP, its error code or ok
async function toolCodes(t: TestApp, token: string) {
  const c = await client(t, token);
  const out: Record<string, string> = {};
  for (const args of [
    { action: "list" },
    {
      action: "create",
      symbol: "US:AAA",
      condition: { left: "price", op: ">", right: 1 },
    },
    { action: "pause", id: 999, paused: true },
    { action: "delete", id: 999 },
  ]) {
    const r = await c.callTool({ name: "rules", arguments: args });
    const text = (r.content as { text: string }[])[0]!.text;
    out[args.action] = r.isError ? JSON.parse(text).error : "ok";
  }
  await c.close();
  return out;
}

// each rules route and the alerts feed, its status
async function routeCodes(t: TestApp, token: string) {
  const at = (path: string, init: RequestInit = {}) =>
    fetch(`${t.url}${PREFIX}${path}`, {
      ...init,
      headers: { ...(init.headers as object), ...as(token) },
    }).then((r) => r.status);
  return {
    list: await at("/rules"),
    one: await at("/rules/999"),
    alerts: await at("/alerts"),
    create: await at("/rules", sent("POST", {}, token)),
    pause: await at("/rules/999", sent("PATCH", { paused: true }, token)),
    delete: await at("/rules/999", { method: "DELETE" }),
  };
}

describe("rules access", () => {
  test("none opens no rule, read opens the list and the feed, write all", () =>
    withApp(async (t) => {
      const none = await make(t, { name: "none-agent" });
      expect(none.key.rules).toBe("none");
      const reader = await make(t, { name: "reader", rules: "read" });
      const writer = await make(t, { name: "writer", rules: "write" });

      expect(await routeCodes(t, none.token)).toEqual({
        list: 403,
        one: 403,
        alerts: 403,
        create: 403,
        pause: 403,
        delete: 403,
      });
      expect(await toolCodes(t, none.token)).toEqual({
        list: "forbidden",
        create: "forbidden",
        pause: "forbidden",
        delete: "forbidden",
      });

      expect(await routeCodes(t, reader.token)).toEqual({
        list: 200,
        one: 404,
        alerts: 204,
        create: 403,
        pause: 403,
        delete: 403,
      });
      expect(await toolCodes(t, reader.token)).toEqual({
        list: "ok",
        create: "forbidden",
        pause: "forbidden",
        delete: "forbidden",
      });

      // past the gate each write meets its own checks
      const wrote = {
        list: 200,
        one: 404,
        alerts: 204,
        create: 400,
        pause: 404,
        delete: 404,
      };
      expect(await routeCodes(t, writer.token)).toEqual(wrote);
      expect(await routeCodes(t, t.admin)).toEqual(wrote);
      // no source answers here, so a create fails past the gate
      const { create, ...rest } = await toolCodes(t, writer.token);
      expect(create).not.toBe("forbidden");
      expect(rest).toEqual({
        list: "ok",
        pause: "not_found",
        delete: "not_found",
      });
    }));

  test("the tool refuses in the portfolio tool's words", async () => {
    const { m } = world();
    const ask = (rules: Access, args: object) =>
      rulesAnswer(
        m,
        { name: "x", portfolio: "write", rules },
        parseRules(args),
      );
    const none = await ask("none", { action: "list" });
    expect(JSON.parse(none.content[0]!.text)).toEqual({
      error: "forbidden",
      message: "this key has no rules access; the admin grants it",
    });
    const reader = await ask("read", { action: "delete", id: 1 });
    expect(JSON.parse(reader.content[0]!.text)).toEqual({
      error: "forbidden",
      message: "this key reads rules only; the admin grants write",
    });
  });
});

describe("changing a key's access", () => {
  test("the next request reads the new access, the token kept", () =>
    withApp(async (t) => {
      const made = await make(t, { name: "agent" });
      const set = (body: unknown, key = t.admin) =>
        fetch(
          `${t.url}${PREFIX}/keys/${made.key.id}`,
          sent("PATCH", body, key),
        );
      const rules = () =>
        fetch(`${t.url}${PREFIX}/rules`, { headers: as(made.token) }).then(
          (r) => r.status,
        );
      expect(await rules()).toBe(403);

      const read = await set({ rules: "read" });
      expect(read.status).toBe(200);
      expect(((await read.json()) as any).key).toMatchObject({
        id: made.key.id,
        name: "agent",
        portfolio: "none",
        rules: "read",
      });
      expect(await rules()).toBe(200);
      expect((await toolCodes(t, made.token)).list).toBe("ok");

      // one alone leaves the other as it was
      const portfolio = await set({ portfolio: "write" });
      expect(((await portfolio.json()) as any).key).toMatchObject({
        portfolio: "write",
        rules: "read",
      });
      const brokers = await fetch(`${t.url}${PREFIX}/brokers`, {
        headers: as(made.token),
      });
      expect(brokers.status).toBe(200);

      expect((await set({ rules: "none" })).status).toBe(200);
      expect(await rules()).toBe(403);
      expect((await toolCodes(t, made.token)).list).toBe("forbidden");

      for (const bad of [{}, { rules: "all" }, { portfolio: null }, []]) {
        expect([bad, (await set(bad)).status]).toEqual([bad, 400]);
      }
      expect((await set({ rules: "write" }, made.token)).status).toBe(403);
      expect((await set({ rules: "write" }, t.bearer)).status).toBe(403);
      const unknown = await fetch(
        `${t.url}${PREFIX}/keys/zzzzzzzzzzzz`,
        sent("PATCH", { rules: "read" }, t.admin),
      );
      expect(unknown.status).toBe(404);
      expect(t.lines.some((l) => l.includes('msg="key access set"'))).toBe(
        true,
      );
      for (const line of t.lines) expect(line).not.toContain(made.token);
    }));

  test("an expired key is changed too and stays expired", async () => {
    const w = world();
    const handle = api(w.m);
    const call = (path: string, init: RequestInit = {}) =>
      handle(new Request(`http://markets.test${PREFIX}${path}`, init));
    const made = (await (
      await call(
        "/keys",
        sent("POST", { name: "old", expiresInDays: 30 }, ADMIN_KEY),
      )
    ).json()) as { token: string; key: { id: string } };
    await w.clock.advance(30 * DAY_MS);
    const set = await call(
      `/keys/${made.key.id}`,
      sent("PATCH", { rules: "write" }, ADMIN_KEY),
    );
    expect(set.status).toBe(200);
    expect(((await set.json()) as any).key.rules).toBe("write");
    expect((await call("/rules", { headers: as(made.token) })).status).toBe(
      401,
    );
  });
});

describe("the keys command", () => {
  const data = join(SECRETS, "..");

  test("adds a key with rules access and sets either access by name", () =>
    withApp(async (t) => {
      const out: string[] = [];
      const run = (...argv: string[]) =>
        runKeys(["--data", data, "--listen", t.url.slice(7), ...argv], {
          write: (line) => out.push(line),
          service: async () => null,
        });
      const listed = async () => {
        out.length = 0;
        await run("list");
        return (
          JSON.parse(out[0]!) as {
            keys: { name: string; portfolio: string; rules: string }[];
          }
        ).keys.find((k) => k.name === "codex");
      };
      await run("add", "codex", "--rules", "read");
      const token = out[0]!;
      expect(await listed()).toMatchObject({
        portfolio: "none",
        rules: "read",
      });
      out.length = 0;
      await run("set", "codex", "--rules", "write", "--portfolio", "read");
      expect(out).toEqual(["set codex"]);
      expect(await listed()).toMatchObject({
        portfolio: "read",
        rules: "write",
      });
      out.length = 0;
      await run("set", "codex", "--portfolio", "none");
      expect(await listed()).toMatchObject({
        portfolio: "none",
        rules: "write",
      });
      // the token stays
      const res = await fetch(`${t.url}${PREFIX}/rules`, {
        headers: as(token),
      });
      expect(res.status).toBe(200);
      await expect(run("set", "nobody", "--rules", "read")).rejects.toThrow(
        "no key named nobody",
      );
    }));

  test("refuses a bad set before calling the server", async () => {
    const calls: string[] = [];
    const run = (...argv: string[]) =>
      runKeys(
        ["--data", join(SECRETS, ".."), "--listen", "127.0.0.1:9", ...argv],
        {
          fetch: async (url) => {
            calls.push(url);
            return new Response("{}");
          },
          write: () => {},
          service: async () => null,
        },
      );
    for (const argv of [
      ["set", "x"],
      ["set"],
      ["set", "x", "--expires", "30", "--rules", "read"],
      ["revoke", "x", "--rules", "read"],
      ["list", "--portfolio", "read"],
    ]) {
      await expect(run(...argv)).rejects.toThrow(AdminError);
    }
    await expect(run("add", "x", "--rules", "all")).rejects.toThrow(
      "--rules is none, read, write",
    );
    expect(calls).toEqual([]);
  });
});
