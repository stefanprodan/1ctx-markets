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
import {
  alertsEdit,
  alertsRead,
  parseAlertsEdit,
  parseAlertsRead,
} from "../src/operations/alerts.ts";
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
    key: { id: string; alerts: Access; portfolio: Access };
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

// each alerts call over MCP, its error code or ok; unlisted when the key
// does not list its tool, as the SDK refuses an unknown tool
async function toolCodes(t: TestApp, token: string) {
  const c = await client(t, token);
  const names = (await c.listTools()).tools.map((x) => x.name);
  const out: Record<string, string> = {};
  for (const [key, name, args] of [
    ["list", "alerts", {}],
    ["history", "alerts", { history: true }],
    [
      "create",
      "alerts_edit",
      { action: "create", symbol: "US:AAA", when: "price > 1" },
    ],
    ["pause", "alerts_edit", { action: "pause", id: 999 }],
    ["delete", "alerts_edit", { action: "delete", id: 999 }],
  ] as const) {
    const r = await c
      .callTool({ name, arguments: args })
      .catch((error: Error) => error);
    if (r instanceof Error) {
      expect(names).not.toContain(name);
      expect(r.message).toContain("not found");
      out[key] = "unlisted";
      continue;
    }
    const text = (r.content as { text: string }[])[0]!.text;
    out[key] = r.isError ? JSON.parse(text).error : "ok";
  }
  await c.close();
  return out;
}

// each alerts route and the feed, its status
async function routeCodes(t: TestApp, token: string) {
  const at = (path: string, init: RequestInit = {}) =>
    fetch(`${t.url}${PREFIX}${path}`, {
      ...init,
      headers: { ...(init.headers as object), ...as(token) },
    }).then((r) => r.status);
  return {
    list: await at("/alerts"),
    one: await at("/alerts/999"),
    history: await at("/alerts/history"),
    feed: await at("/alerts/feed"),
    create: await at("/alerts", sent("POST", {}, token)),
    pause: await at("/alerts/999", sent("PATCH", { paused: true }, token)),
    delete: await at("/alerts/999", { method: "DELETE" }),
  };
}

describe("alerts access", () => {
  test("none opens no alert, read opens them and the feed, write all", () =>
    withApp(async (t) => {
      const none = await make(t, { name: "none-agent" });
      expect(none.key.alerts).toBe("none");
      const reader = await make(t, { name: "reader", alerts: "read" });
      const writer = await make(t, { name: "writer", alerts: "write" });

      expect(await routeCodes(t, none.token)).toEqual({
        list: 403,
        one: 403,
        history: 403,
        feed: 403,
        create: 403,
        pause: 403,
        delete: 403,
      });
      expect(await toolCodes(t, none.token)).toEqual({
        list: "unlisted",
        history: "unlisted",
        create: "unlisted",
        pause: "unlisted",
        delete: "unlisted",
      });

      expect(await routeCodes(t, reader.token)).toEqual({
        list: 200,
        one: 404,
        history: 200,
        feed: 204,
        create: 403,
        pause: 403,
        delete: 403,
      });
      expect(await toolCodes(t, reader.token)).toEqual({
        list: "ok",
        history: "ok",
        create: "unlisted",
        pause: "unlisted",
        delete: "unlisted",
      });

      // past the gate each write meets its own checks
      const wrote = {
        list: 200,
        one: 404,
        history: 200,
        feed: 204,
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
        history: "ok",
        pause: "not_found",
        delete: "not_found",
      });
    }));

  test("the tools refuse in the portfolio tool's words", async () => {
    const { m } = world();
    const who = (alerts: Access) => ({
      name: "x",
      user: "operator",
      credential: { kind: "key" as const, id: "x" },
      portfolio: "write" as const,
      alerts,
      profile: "none" as const,
      analysis: "none" as const,
    });
    const none = await alertsRead(m, who("none"), parseAlertsRead({}));
    expect(JSON.parse(none.content[0]!.text)).toEqual({
      error: "forbidden",
      message: "this key has no alerts access; its owner grants it",
    });
    // a read key's agent that calls the edit tool anyway is refused
    const reader = await alertsEdit(
      m,
      who("read"),
      parseAlertsEdit({ action: "delete", id: 1 }),
    );
    expect(JSON.parse(reader.content[0]!.text)).toEqual({
      error: "forbidden",
      message: "this key reads alerts only; its owner grants write",
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
      const alerts = () =>
        fetch(`${t.url}${PREFIX}/alerts`, { headers: as(made.token) }).then(
          (r) => r.status,
        );
      expect(await alerts()).toBe(403);

      const read = await set({ alerts: "read" });
      expect(read.status).toBe(200);
      expect(((await read.json()) as any).key).toMatchObject({
        id: made.key.id,
        name: "agent",
        portfolio: "none",
        alerts: "read",
      });
      expect(await alerts()).toBe(200);
      expect((await toolCodes(t, made.token)).list).toBe("ok");

      // one alone leaves the other as it was
      const portfolio = await set({ portfolio: "write" });
      expect(((await portfolio.json()) as any).key).toMatchObject({
        portfolio: "write",
        alerts: "read",
      });
      const brokers = await fetch(`${t.url}${PREFIX}/brokers`, {
        headers: as(made.token),
      });
      expect(brokers.status).toBe(200);

      expect((await set({ alerts: "none" })).status).toBe(200);
      expect(await alerts()).toBe(403);
      expect((await toolCodes(t, made.token)).list).toBe("unlisted");

      for (const bad of [{}, { alerts: "all" }, { portfolio: null }, []]) {
        expect([bad, (await set(bad)).status]).toEqual([bad, 400]);
      }
      expect((await set({ alerts: "write" }, made.token)).status).toBe(403);
      expect((await set({ alerts: "write" }, t.bearer)).status).toBe(403);
      const unknown = await fetch(
        `${t.url}${PREFIX}/keys/zzzzzzzzzzzz`,
        sent("PATCH", { alerts: "read" }, t.admin),
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
      sent("PATCH", { alerts: "write" }, ADMIN_KEY),
    );
    expect(set.status).toBe(200);
    expect(((await set.json()) as any).key.alerts).toBe("write");
    expect((await call("/alerts", { headers: as(made.token) })).status).toBe(
      401,
    );
  });
});

describe("the keys command", () => {
  const data = join(SECRETS, "..");

  test("adds a key with alerts access and sets either access by name", () =>
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
            keys: { name: string; portfolio: string; alerts: string }[];
          }
        ).keys.find((k) => k.name === "codex");
      };
      await run("add", "codex", "--alerts", "read");
      const token = out[0]!;
      expect(await listed()).toMatchObject({
        portfolio: "none",
        alerts: "read",
      });
      out.length = 0;
      await run("set", "codex", "--alerts", "write", "--portfolio", "read");
      expect(out).toEqual(["set codex"]);
      expect(await listed()).toMatchObject({
        portfolio: "read",
        alerts: "write",
      });
      out.length = 0;
      await run("set", "codex", "--portfolio", "none");
      expect(await listed()).toMatchObject({
        portfolio: "none",
        alerts: "write",
      });
      // the token stays
      const res = await fetch(`${t.url}${PREFIX}/alerts`, {
        headers: as(token),
      });
      expect(res.status).toBe(200);
      await expect(run("set", "nobody", "--alerts", "read")).rejects.toThrow(
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
      ["set", "x", "--expires", "30", "--alerts", "read"],
      ["revoke", "x", "--alerts", "read"],
      ["list", "--portfolio", "read"],
    ]) {
      await expect(run(...argv)).rejects.toThrow(AdminError);
    }
    await expect(run("add", "x", "--alerts", "all")).rejects.toThrow(
      "--alerts is none, read, write",
    );
    expect(calls).toEqual([]);
  });
});
