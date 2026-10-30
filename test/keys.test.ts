// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { AdminError } from "../src/admin/cli.ts";
import { runKeys } from "../src/admin/keys-cli.ts";
import { PREFIX } from "../src/api/http.ts";
import { DAY_MS, MINUTE_MS } from "../src/runtime/clock.ts";
import { format, MASK, silent } from "../src/runtime/log.ts";
import { access, tokenHash } from "../src/server/access.ts";
import { router } from "../src/server/http.ts";
import {
  CALLS_PER_MINUTE,
  MAX_WINDOWS,
  RateLimit,
} from "../src/server/ratelimit.ts";
import { COOKIE, sessions } from "../src/server/session.ts";
import { open } from "../src/storage/db/index.ts";
import { ADMIN_KEY, api } from "./helpers/api.ts";
import { SECRETS, type TestApp, withApp } from "./helpers/app.ts";
import { fakeClock } from "./helpers/clock.ts";
import { world } from "./helpers/world.ts";

const initialize = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "test", version: "1" },
  },
});

const as = (key: string) => ({ authorization: `Bearer ${key}` });

const mcp = (t: TestApp, key: string) =>
  fetch(`${t.url}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...as(key),
    },
    body: initialize,
  });

async function make(
  t: TestApp,
  name: string,
  expiresInDays: number | null = null,
): Promise<Response> {
  return fetch(`${t.url}${PREFIX}/keys`, {
    method: "POST",
    headers: { "content-type": "application/json", ...as(t.admin) },
    body: JSON.stringify({ name, expiresInDays }),
  });
}

const tokenOf = async (res: Response): Promise<string> =>
  ((await res.json()) as { token: string }).token;

// /api/v1 through the real router over a fake clock, with a key made there
async function keyed(expiresInDays: number | null = null) {
  const w = world();
  const handle = api(w.m);
  const call = (path: string, init: RequestInit = {}) =>
    handle(new Request(`http://markets.test${PREFIX}${path}`, init));
  const made = await call("/keys", {
    method: "POST",
    headers: { "content-type": "application/json", ...as(ADMIN_KEY) },
    body: JSON.stringify({ name: "agent", expiresInDays }),
  });
  expect(made.status).toBe(201);
  const { token, key } = (await made.json()) as {
    token: string;
    key: { id: string };
  };
  const lastUsed = async () => {
    // the use is written through the writer queue
    await w.m.writer.write(() => {});
    return (
      w.db
        .query<{ at: number | null }, [string]>(
          "select last_used_at as at from keys where id = ?",
        )
        .get(key.id) as { at: number | null }
    ).at;
  };
  return { ...w, call, token, lastUsed };
}

describe("agent keys", () => {
  test("a made key opens /mcp and the read routes, never an admin route", () =>
    withApp(async (t) => {
      const made = await make(t, "claude-code");
      expect(made.status).toBe(201);
      const token = await tokenOf(made);
      expect(token).toMatch(/^1ctx-markets-[A-Za-z0-9_-]{43}$/);
      expect((await mcp(t, token)).status).toBe(200);
      for (const path of ["/watchlist"]) {
        const res = await fetch(`${t.url}${PREFIX}${path}`, {
          headers: as(token),
        });
        expect([path, res.status < 300]).toEqual([path, true]);
      }
      // rules and the alerts feed are opened by the admin, as holdings are
      for (const path of [
        "/status",
        "/instruments",
        "/keys",
        "/rules",
        "/alerts",
      ]) {
        const res = await fetch(`${t.url}${PREFIX}${path}`, {
          headers: as(token),
        });
        expect([path, res.status]).toEqual([path, 403]);
      }
      const minted = await fetch(`${t.url}${PREFIX}/keys`, {
        method: "POST",
        headers: { "content-type": "application/json", ...as(token) },
        body: JSON.stringify({ name: "other" }),
      });
      expect(minted.status).toBe(403);
    }));

  test("a revoked key is refused on its next call", () =>
    withApp(async (t) => {
      const made = (await (await make(t, "codex")).json()) as {
        token: string;
        key: { id: string };
      };
      expect((await mcp(t, made.token)).status).toBe(200);
      const revoked = await fetch(`${t.url}${PREFIX}/keys/${made.key.id}`, {
        method: "DELETE",
        headers: as(t.admin),
      });
      expect(revoked.status).toBe(204);
      const refused = await mcp(t, made.token);
      expect(refused.status).toBe(401);
      expect(refused.headers.get("www-authenticate")).toBeNull();
      const read = await fetch(`${t.url}${PREFIX}/rules`, {
        headers: as(made.token),
      });
      expect(read.status).toBe(401);
      const again = await fetch(`${t.url}${PREFIX}/keys/${made.key.id}`, {
        method: "DELETE",
        headers: as(t.admin),
      });
      expect(again.status).toBe(404);
      expect(t.lines.some((l) => l.includes('msg="key revoked"'))).toBe(true);
    }));

  test("at most five keys, and each name once", () =>
    withApp(async (t) => {
      // the test's own agent key is the first
      for (const name of ["a1", "a2", "a3", "a4"]) {
        expect((await make(t, name)).status).toBe(201);
      }
      const taken = await make(t, "a1");
      expect(taken.status).toBe(409);
      expect(await taken.json()).toMatchObject({
        code: "conflict",
        detail: "name taken",
      });
      const full = await make(t, "a5");
      expect(full.status).toBe(409);
      expect(await full.json()).toMatchObject({
        code: "conflict",
        detail: "too many keys",
      });
      const listed = await fetch(`${t.url}${PREFIX}/keys`, {
        headers: as(t.admin),
      });
      const body = (await listed.json()) as {
        keys: { name: string }[];
        limit: number;
      };
      expect(body.limit).toBe(5);
      expect(body.keys.map((k) => k.name)).toEqual([
        "test-agent",
        "a1",
        "a2",
        "a3",
        "a4",
      ]);
      for (const bad of ["A", "x", "-x", "x y", "é".repeat(3), 1, null]) {
        const res = await make(t, bad as string);
        expect([bad, res.status]).toEqual([bad, 400]);
      }
      const days = await fetch(`${t.url}${PREFIX}/keys`, {
        method: "POST",
        headers: { "content-type": "application/json", ...as(t.admin) },
        body: JSON.stringify({ name: "a1", expiresInDays: 7 }),
      });
      expect(days.status).toBe(400);
    }));

  test("a made key is answered once and never reaches the log", () =>
    withApp(async (t) => {
      const made = await make(t, "opencode");
      const body = (await made.json()) as {
        token: string;
        key: { id: string };
      };
      const token = body.token;
      expect(made.headers.get("cache-control")).toBe("no-store");
      const listed = await (
        await fetch(`${t.url}${PREFIX}/keys`, { headers: as(t.admin) })
      ).text();
      expect(listed).not.toContain(token);
      expect(listed).not.toContain(tokenHash(token));
      expect(
        t.db.query("select token_hash from keys where name = 'opencode'").get(),
      ).toEqual({ token_hash: tokenHash(token) });
      // a key pasted into a path is masked in the request's line
      expect((await fetch(`${t.url}/${token}`)).status).toBe(401);
      expect((await mcp(t, token)).status).toBe(200);
      const created = t.lines.find((l) => l.includes('msg="key created"'));
      expect(created).toContain(`key=${body.key.id} key_name=opencode`);
      expect(t.lines.some((l) => l.includes(`path=/${MASK}`))).toBe(true);
      for (const line of t.lines) expect(line).not.toContain(token);
    }));

  test("a key made by an earlier run never reaches the log", async () => {
    const clock = fakeClock();
    const { db } = open(":memory:", clock);
    try {
      let token = "";
      await withApp(
        async (t) => {
          token = await tokenOf(await make(t, "earlier"));
        },
        { db },
      );
      await withApp(
        async (t) => {
          const res = await fetch(`${t.url}/mcp/${token}`, {
            headers: as(t.admin),
          });
          expect(res.status).toBe(404);
          expect(t.lines.some((l) => l.includes(`path=/mcp/${MASK}`))).toBe(
            true,
          );
          for (const line of t.lines) expect(line).not.toContain(token);
        },
        { db },
      );
    } finally {
      db.close();
    }
    for (const shape of [
      `1ctx-markets-${"a".repeat(43)}`,
      `1ctx-markets-admin-${"B_-".repeat(14)}x`,
      // a key cut short is still most of a secret
      `1ctx-markets-${"c".repeat(42)}`,
    ]) {
      const line = format(0, "test", "info", "request", { path: `/${shape}` });
      expect(line).not.toContain(shape.slice(-16));
      expect(line).toContain(MASK);
    }
    // names that merely start with the prefix stay readable
    for (const plain of ["1ctx-markets-darwin-arm64", "1ctx-markets-v1.2.3"]) {
      const line = format(0, "test", "info", "request", { path: `/${plain}` });
      expect(line).toContain(plain);
    }
  });

  test("a burst of calls queues one last-use write", async () => {
    const w = world();
    const token = "1ctx-markets-burst-test-key-0123456789abcdefABCDEF0";
    await w.m.writer.write((db) =>
      db
        .query(
          "insert into keys (id, name, token_hash, created_at) values ('burstkey0000', 'burst', ?, 0)",
        )
        .run(tokenHash(token)),
    );
    let writes = 0;
    const a = access({
      db: w.db,
      writer: {
        write: (fn) => {
          writes++;
          return w.m.writer.write(fn);
        },
        close: () => w.m.writer.close(),
      },
      adminKey: null,
      now: () => w.clock.now(),
      log: silent,
    });
    const req = new Request("http://markets.test/mcp", { headers: as(token) });
    for (let n = 0; n < 50; n++) expect(a.caller(req)).not.toBeNull();
    expect(writes).toBe(1);
    await w.clock.advance(MINUTE_MS - 1);
    a.caller(req);
    expect(writes).toBe(1);
    await w.clock.advance(1);
    a.caller(req);
    expect(writes).toBe(2);
  });

  test("last use is written at most once a minute", async () => {
    const k = await keyed();
    expect(await k.lastUsed()).toBeNull();
    const first = k.clock.now();
    expect((await k.call("/watchlist", { headers: as(k.token) })).status).toBe(
      200,
    );
    expect(await k.lastUsed()).toBe(first);
    await k.clock.advance(MINUTE_MS - 1);
    await k.call("/watchlist", { headers: as(k.token) });
    expect(await k.lastUsed()).toBe(first);
    await k.clock.advance(1);
    await k.call("/watchlist", { headers: as(k.token) });
    expect(await k.lastUsed()).toBe(first + MINUTE_MS);
  });

  test("an expired key is refused and stays listed", async () => {
    const k = await keyed(30);
    expect((await k.call("/watchlist", { headers: as(k.token) })).status).toBe(
      200,
    );
    await k.clock.advance(30 * DAY_MS - 1);
    expect((await k.call("/watchlist", { headers: as(k.token) })).status).toBe(
      200,
    );
    await k.clock.advance(1);
    const refused = await k.call("/watchlist", { headers: as(k.token) });
    expect(refused.status).toBe(401);
    const listed = (await (await k.call("/keys")).json()) as {
      keys: { name: string; expires_at: string }[];
    };
    expect(listed.keys.find((x) => x.name === "agent")?.expires_at).toBe(
      new Date(k.clock.now()).toISOString().replace(".000Z", "Z"),
    );
  });
});

describe("the call limit", () => {
  test("the call past the minute's limit is refused until the window ends", async () => {
    const k = await keyed();
    const read = () => k.call("/watchlist", { headers: as(k.token) });
    for (let n = 0; n < CALLS_PER_MINUTE; n++) {
      expect((await read()).status).toBe(200);
    }
    const over = await read();
    expect(over.status).toBe(429);
    expect(over.headers.get("retry-after")).toBe("60");
    expect(await over.json()).toMatchObject({ code: "too_many_requests" });
    // the admin key has its own window, and the signed-in UI none
    expect(
      (await k.call("/watchlist", { headers: as(ADMIN_KEY) })).status,
    ).toBe(200);
    const cookie = `${COOKIE}=${sessions(ADMIN_KEY).issue(k.clock.now())}`;
    for (let n = 0; n <= CALLS_PER_MINUTE; n++) {
      expect((await k.call("/watchlist", { headers: { cookie } })).status).toBe(
        200,
      );
    }
    await k.clock.advance(MINUTE_MS - 1);
    expect((await read()).status).toBe(429);
    await k.clock.advance(1);
    expect((await read()).status).toBe(200);
  });

  test("on /mcp each message of a batch counts, refused before the body is read", async () => {
    const w = world();
    const key = (await w.m.writer.write((db) =>
      db
        .query(
          "insert into keys (id, name, token_hash, created_at) values ('mcpkey000000', 'mcp', ?, 0) returning id",
        )
        .get(tokenHash("1ctx-markets-mcp-limit-test-key-000000000000")),
    )) as { id: string };
    expect(key.id).toBe("mcpkey000000");
    let served = 0;
    const handle = router({
      access: access({
        db: w.db,
        writer: w.m.writer,
        adminKey: null,
        now: () => w.clock.now(),
        log: silent,
      }),
      mcp: {
        fetch: async () => {
          served++;
          return new Response("{}");
        },
      } as never,
      clock: w.clock,
      log: silent,
    });
    const headers = {
      "content-type": "application/json",
      ...as("1ctx-markets-mcp-limit-test-key-000000000000"),
    };
    const post = (body: BodyInit) =>
      handle(
        new Request("http://markets.test/mcp", {
          method: "POST",
          headers,
          body,
        }),
      );
    const batch = (n: number) =>
      JSON.stringify(
        Array.from({ length: n }, (_, id) => ({
          jsonrpc: "2.0",
          id,
          method: "ping",
        })),
      );
    expect((await post(batch(CALLS_PER_MINUTE))).status).toBe(200);
    expect(served).toBe(1);
    const over = await post(initialize);
    expect(over.status).toBe(429);
    expect(await over.json()).toEqual({
      error: "too_many_requests",
      message: `over ${CALLS_PER_MINUTE} calls a minute`,
    });
    // a body that fails when read: the refusal never reads it
    let pulled = false;
    const unread = new ReadableStream(
      {
        pull() {
          pulled = true;
          throw new Error("read");
        },
      },
      // pulled only when read
      { highWaterMark: 0 },
    );
    expect((await post(unread)).status).toBe(429);
    expect(pulled).toBe(false);
    await w.clock.advance(MINUTE_MS);
    expect((await post(batch(CALLS_PER_MINUTE + 1))).status).toBe(429);
    expect(served).toBe(1);
  });

  test("windows stay bounded however many keys are seen", () => {
    const rate = new RateLimit(1, MINUTE_MS);
    for (let n = 0; n < MAX_WINDOWS + 50; n++) rate.hit(`k${n}`, 0);
    expect(rate.size).toBeLessThanOrEqual(MAX_WINDOWS);
    expect(rate.hit("k", 0)).toBe(true);
    expect(rate.hit("k", 0)).toBe(false);
    expect(rate.hit("k", MINUTE_MS)).toBe(true);
  });

  test("only the admin key itself is the admin", () => {
    const clock = fakeClock();
    const a = access({
      db: world().db,
      writer: world().m.writer,
      adminKey: ADMIN_KEY,
      now: () => clock.now(),
      log: silent,
    });
    const req = (key: string) =>
      new Request("http://markets.test/mcp", { headers: as(key) });
    expect(a.caller(req(ADMIN_KEY))).toEqual({ kind: "admin" });
    expect(a.caller(req(`${ADMIN_KEY}x`))).toBeNull();
    expect(a.caller(new Request("http://markets.test/mcp"))).toBeNull();
  });
});

describe("the keys command", () => {
  const data = join(SECRETS, "..");

  test("adds, lists and revokes keys on a running server", () =>
    withApp(async (t) => {
      const out: string[] = [];
      const run = (...argv: string[]) =>
        runKeys(["--data", data, "--listen", t.url.slice(7), ...argv], {
          write: (line) => out.push(line),
          service: async () => null,
        });
      await run("add", "codex", "--expires", "90");
      expect(out).toHaveLength(1);
      const token = out[0]!;
      expect(token).toMatch(/^1ctx-markets-[A-Za-z0-9_-]{43}$/);
      expect((await mcp(t, token)).status).toBe(200);
      out.length = 0;
      await run("list");
      const listed = JSON.parse(out[0]!) as {
        keys: { name: string; expires_at: string | null }[];
      };
      expect(listed.keys.map((k) => k.name)).toEqual(["test-agent", "codex"]);
      expect(listed.keys[1]!.expires_at).not.toBeNull();
      expect(out[0]).not.toContain(token);
      await expect(run("add", "codex")).rejects.toThrow("name taken (409)");
      out.length = 0;
      await run("revoke", "codex");
      expect(out).toEqual(["revoked codex"]);
      expect((await mcp(t, token)).status).toBe(401);
      await expect(run("revoke", "codex")).rejects.toThrow(
        "no key named codex",
      );
      for (const line of t.lines) {
        expect(line).not.toContain(token);
        expect(line).not.toContain(t.admin);
      }
    }));

  test("refuses a bad command before calling the server", async () => {
    const calls: string[] = [];
    const run = (...argv: string[]) =>
      runKeys(["--data", data, "--listen", "127.0.0.1:9", ...argv], {
        fetch: async (url) => {
          calls.push(url);
          return new Response("{}");
        },
        write: () => {},
        service: async () => null,
      });
    for (const argv of [
      [],
      ["add"],
      ["add", "a", "b"],
      ["list", "x"],
      ["revoke"],
      ["list", "--expires", "30"],
      ["remove", "x"],
    ]) {
      await expect(run(...argv)).rejects.toThrow(AdminError);
    }
    await expect(run("add", "x", "--expires", "7")).rejects.toThrow(
      "--expires is 30, 90, 365",
    );
    expect(calls).toEqual([]);
  });
});

describe("portfolio access", () => {
  test("is none unless asked, read opens reads, write opens writes", async () => {
    const w = world();
    const handle = api(w.m);
    const call = (path: string, init: RequestInit = {}) =>
      handle(new Request(`http://markets.test${PREFIX}${path}`, init));
    const make = async (name: string, portfolio?: string) => {
      const res = await call("/keys", {
        method: "POST",
        headers: { "content-type": "application/json", ...as(ADMIN_KEY) },
        body: JSON.stringify({ name, ...(portfolio ? { portfolio } : {}) }),
      });
      return { status: res.status, body: (await res.json()) as any };
    };
    const none = await make("plain");
    expect(none.body.key.portfolio).toBe("none");
    const reader = await make("reader", "read");
    const writer = await make("writer", "write");
    expect((await make("odd", "admin")).status).toBe(400);
    const post = (token: string) =>
      call("/brokers", {
        method: "POST",
        headers: { "content-type": "application/json", ...as(token) },
        body: JSON.stringify({ name: "North" }),
      });
    const get = (token: string) => call("/brokers", { headers: as(token) });
    expect((await get(none.body.token)).status).toBe(403);
    expect((await get(reader.body.token)).status).toBe(200);
    expect((await post(reader.body.token)).status).toBe(403);
    expect((await post(writer.body.token)).status).toBe(201);
    // a market read never needed it
    expect(
      (await call("/watchlist", { headers: as(none.body.token) })).status,
    ).toBe(200);
  });

  test("the keys command passes --portfolio", async () => {
    const sent: unknown[] = [];
    const lines: string[] = [];
    await runKeys(
      [
        "--data",
        join(SECRETS, ".."),
        "--listen",
        "127.0.0.1:9",
        "add",
        "casey",
        "--portfolio",
        "write",
      ],
      {
        fetch: async (_url, init) => {
          sent.push(JSON.parse(String(init?.body)));
          return new Response(JSON.stringify({ token: "made-up" }), {
            status: 201,
          });
        },
        write: (l) => lines.push(l),
        service: async () => null,
      },
    );
    expect(sent).toEqual([
      { name: "casey", expiresInDays: null, portfolio: "write" },
    ]);
    await expect(
      runKeys(["add", "casey", "--portfolio", "all"], {
        service: async () => null,
      }),
    ).rejects.toThrow("--portfolio is none, read, write");
  });
});
