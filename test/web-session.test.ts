// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { PREFIX } from "../src/api/http.ts";
import { silent } from "../src/runtime/log.ts";
import { router } from "../src/server/http.ts";
import {
  COOKIE,
  cookieOf,
  SESSION_MS,
  sameOrigin,
  sessions,
} from "../src/server/session.ts";
import { ADMIN_KEY, api, READ_KEY } from "./helpers/api.ts";
import { withApp } from "./helpers/app.ts";
import { fakeClock } from "./helpers/clock.ts";
import { NOW } from "./helpers/sources.ts";
import { world } from "./helpers/world.ts";

const OTHER_KEY = "test-other-admin-key-0123456789abcdef0123";

const signIn = (key: unknown, url = "http://127.0.0.1:1") =>
  new Request(`${url}/ui/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ key }),
  });

const tokenOf = (res: Response): string => {
  const set = res.headers.get("set-cookie") ?? "";
  return set.slice(COOKIE.length + 1, set.indexOf(";"));
};

function setup() {
  const w = world();
  const handle = api(w.m);
  const at = (path: string, init: RequestInit = {}) =>
    handle(new Request(`http://127.0.0.1:1${path}`, init));
  const cookie = async () => tokenOf(await handle(signIn(ADMIN_KEY))) as string;
  return { ...w, handle, at, cookie };
}

describe("the session token", () => {
  test("holds an expiry and its MAC, never the key", () => {
    const s = sessions(ADMIN_KEY);
    const token = s.issue(NOW);
    expect(token).toMatch(/^v1\.\d+\.[A-Za-z0-9_-]{43}$/);
    expect(token.split(".")[1]).toBe(String(NOW + SESSION_MS));
    for (const form of [
      ADMIN_KEY,
      Buffer.from(ADMIN_KEY).toString("base64url"),
      createHash("sha256").update(ADMIN_KEY).digest("base64url"),
    ]) {
      expect(token).not.toContain(form);
    }
    expect(s.valid(token, NOW)).toBe(true);
    expect(s.valid(token, NOW + SESSION_MS - 1)).toBe(true);
  });

  test("a forged, expired, malformed or other key's token is refused", () => {
    const s = sessions(ADMIN_KEY);
    const token = s.issue(NOW);
    const [, expiry, mac] = token.split(".");
    const later = `v1.${Number(expiry) + SESSION_MS}.${mac}`;
    const flipped = `v1.${expiry}.${mac!.slice(0, -1)}${mac!.endsWith("A") ? "B" : "A"}`;
    for (const bad of [later, flipped, `v2.${expiry}.${mac}`, "", "v1..x"]) {
      expect([bad, s.valid(bad, NOW)]).toEqual([bad, false]);
    }
    expect(s.valid(null, NOW)).toBe(false);
    expect(s.valid(token, NOW + SESSION_MS)).toBe(false);
    // a new admin.key signs every browser out
    expect(sessions(OTHER_KEY).valid(token, NOW)).toBe(false);
  });

  test("the cookie and the Origin are read from their headers", () => {
    const req = (headers: Record<string, string>, url = "http://a.test/x") =>
      new Request(url, { headers });
    expect(cookieOf(req({ cookie: `x=1; ${COOKIE}=v1.2.abc; y=2` }))).toBe(
      "v1.2.abc",
    );
    expect(cookieOf(req({ cookie: `other_${COOKIE}=v1` }))).toBeNull();
    expect(cookieOf(req({}))).toBeNull();
    expect(sameOrigin(req({ origin: "http://a.test" }))).toBe(true);
    // a TLS proxy hands the request on as http, so only the host counts
    expect(sameOrigin(req({ origin: "https://a.test" }))).toBe(true);
    for (const origin of ["http://b.test", "http://a.test:8080", "null", ""]) {
      expect([origin, sameOrigin(req({ origin }))]).toEqual([origin, false]);
    }
    expect(sameOrigin(req({}))).toBe(false);
  });
});

describe("sign-in", () => {
  test("the admin key sets a 30-day cookie; a wrong one is 401 with none", async () => {
    const t = setup();
    const ok = await t.handle(signIn(ADMIN_KEY));
    expect(ok.status).toBe(204);
    const set = ok.headers.get("set-cookie")!;
    expect(set).toContain("HttpOnly");
    expect(set).toContain("SameSite=Strict");
    expect(set).toContain("Path=/");
    expect(set).toContain(`Max-Age=${SESSION_MS / 1000}`);
    expect(set).not.toContain("Secure");
    expect(set).not.toContain(ADMIN_KEY);
    for (const key of [READ_KEY, OTHER_KEY, `${ADMIN_KEY}x`, ""]) {
      const res = await t.handle(signIn(key));
      expect([key, res.status]).toEqual([key, 401]);
      expect(res.headers.get("set-cookie")).toBeNull();
      expect(await res.text()).not.toContain(key || "\u0000");
    }
  });

  test("the cookie is Secure unless the request is loopback plain HTTP", async () => {
    const t = setup();
    const secure = async (url: string) =>
      (await t.handle(signIn(ADMIN_KEY, url))).headers
        .get("set-cookie")!
        .includes("Secure");
    for (const url of [
      "http://127.0.0.1:11238",
      "http://localhost:11238",
      "http://[::1]:11238",
    ]) {
      expect([url, await secure(url)]).toEqual([url, false]);
    }
    for (const url of ["http://markets.example", "http://192.168.1.2:11238"]) {
      expect([url, await secure(url)]).toEqual([url, true]);
    }
  });

  test("every failed sign-in answers the same 401, a server without a key too", async () => {
    const t = setup();
    const post = (
      handle: (req: Request) => Promise<Response>,
      body: string,
      type = "application/json",
    ) =>
      handle(
        new Request("http://127.0.0.1:1/ui/session", {
          method: "POST",
          headers: { "content-type": type },
          body,
        }),
      );
    const keyless = router({
      bearer: READ_KEY,
      adminKey: null,
      sessions: sessions(null),
      mcp: {} as never,
      clock: fakeClock(NOW),
      log: silent,
    });
    const answers: string[] = [];
    for (const [handle, body, type] of [
      [t.handle, JSON.stringify({ key: OTHER_KEY })],
      [t.handle, JSON.stringify({ key: "" })],
      [t.handle, "{}"],
      [t.handle, '{"key":1}'],
      [t.handle, "[]"],
      [t.handle, "x"],
      [t.handle, `{"key":"a","b":1}`],
      [t.handle, JSON.stringify({ key: ADMIN_KEY }), "text/plain"],
      [t.handle, JSON.stringify({ key: "x".repeat(20_000) })],
      [keyless, JSON.stringify({ key: ADMIN_KEY })],
      [keyless, JSON.stringify({ key: "" })],
    ] as const) {
      const res = await post(handle, body, type);
      expect([body.slice(0, 20), res.status]).toEqual([body.slice(0, 20), 401]);
      expect(res.headers.get("set-cookie")).toBeNull();
      answers.push(await res.text());
    }
    expect(new Set(answers).size).toBe(1);
    expect(JSON.parse(answers[0]!)).toEqual({
      error: "unauthorized",
      message: "wrong admin key",
    });
    const got = await t.at("/ui/session");
    expect(got.status).toBe(405);
    expect(got.headers.get("allow")).toBe("POST, DELETE");
  });

  test("sign out clears the cookie", async () => {
    const t = setup();
    const res = await t.at("/ui/session", { method: "DELETE" });
    expect(res.status).toBe(204);
    expect(res.headers.get("set-cookie")).toContain(`${COOKIE}=;`);
    expect(res.headers.get("set-cookie")).toContain("Max-Age=0");
  });
});

describe("what the cookie opens", () => {
  test("the admin routes and every read, never /mcp or a rules write", async () => {
    const t = setup();
    const c = { cookie: `${COOKIE}=${await t.cookie()}` };
    for (const path of [
      "/admin/status",
      "/admin/instruments",
      "/rules",
      "/alerts",
      "/openapi.json",
    ]) {
      const res = await t.at(`${PREFIX}${path}`, { headers: c });
      expect([path, res.status]).toEqual([
        path,
        path === "/alerts" ? 204 : 200,
      ]);
    }
    const mcp = await t.at("/mcp", { method: "POST", headers: c });
    expect(mcp.status).toBe(401);
    const rule = await t.at(`${PREFIX}/rules`, {
      method: "POST",
      headers: {
        ...c,
        origin: "http://127.0.0.1:1",
        "content-type": "application/json",
      },
      body: "{}",
    });
    expect(rule.status).toBe(401);
  });

  test("a forged, expired or other key's cookie opens nothing", async () => {
    const clock = fakeClock(NOW);
    const handle = router({
      bearer: READ_KEY,
      adminKey: ADMIN_KEY,
      sessions: sessions(ADMIN_KEY),
      mcp: {} as never,
      api: [],
      clock,
      log: silent,
    });
    const status = async (token: string) =>
      (
        await handle(
          new Request(`http://127.0.0.1:1${PREFIX}/admin/status`, {
            headers: { cookie: `${COOKIE}=${token}` },
          }),
        )
      ).status;
    const good = sessions(ADMIN_KEY).issue(NOW);
    expect(await status(good)).toBe(404);
    expect(await status(sessions(OTHER_KEY).issue(NOW))).toBe(401);
    expect(await status(`${good.slice(0, -2)}xx`)).toBe(401);
    await clock.advance(SESSION_MS);
    expect(await status(good)).toBe(401);
  });

  test("a write by cookie needs the server's own Origin", async () => {
    const t = setup();
    const cookie = `${COOKIE}=${await t.cookie()}`;
    const refetch = (headers: Record<string, string>) =>
      t.at(`${PREFIX}/admin/refetch`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json", ...headers },
        body: JSON.stringify({ symbols: ["US:NOPE"], fetch: ["quotes"] }),
      });
    for (const origin of [null, "http://evil.example", "null"]) {
      const res = await refetch(origin === null ? {} : { origin });
      expect([origin, res.status]).toEqual([origin, 403]);
      expect(((await res.json()) as any).error).toBe("forbidden");
    }
    expect((await refetch({ origin: "http://127.0.0.1:1" })).status).toBe(200);
    // the admin key alone needs no Origin, as a script sends none
    const keyed = await t.at(`${PREFIX}/admin/refetch`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${ADMIN_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ symbols: ["US:NOPE"], fetch: ["quotes"] }),
    });
    expect(keyed.status).toBe(200);
  });

  test("with the UI off there is no sign-in and the cookie opens nothing", () =>
    withApp(async ({ url, admin }) => {
      const res = await fetch(`${url}/ui/session`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key: admin }),
      });
      expect(res.status).toBe(401);
      expect(res.headers.get("set-cookie")).toBeNull();
      const token = sessions(admin).issue(NOW);
      const status = await fetch(`${url}${PREFIX}/admin/status`, {
        headers: { cookie: `${COOKIE}=${token}` },
      });
      expect(status.status).toBe(401);
      expect((await fetch(url)).status).toBe(401);
    }));
});
