// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { PREFIX } from "../src/api/http.ts";
import { OPERATOR } from "../src/operations/who.ts";
import { countRules, readRule } from "../src/rules/store.ts";
import { silent } from "../src/runtime/log.ts";
import { email } from "../src/server/email/settings.ts";
import { router } from "../src/server/http.ts";
import { links } from "../src/server/links.ts";
import {
  COOKIE,
  cookieOf,
  logins,
  SESSION_MS,
  sameOrigin,
  sha256,
} from "../src/server/session.ts";
import { ui } from "../src/server/ui.ts";
import page from "../src/web/index.html";
import {
  ADMIN_KEY,
  api,
  cookieFor,
  keyAccess,
  READ_KEY,
} from "./helpers/api.ts";
import { SECRETS, withApp } from "./helpers/app.ts";
import { fakeClock } from "./helpers/clock.ts";
import { NOW } from "./helpers/sources.ts";
import { listing, world } from "./helpers/world.ts";

const OTHER_KEY = "test-other-admin-key-0123456789abcdef0123";

const signIn = (
  key: unknown,
  url = "http://127.0.0.1:1",
  origin: string | null = url,
) =>
  new Request(`${url}/ui/session`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(origin === null ? {} : { origin }),
    },
    body: JSON.stringify({ key }),
  });

const tokenOf = (res: Response): string => {
  const set = res.headers.get("set-cookie") ?? "";
  return set.slice(COOKIE.length + 1, set.indexOf(";"));
};

// a flag reads as one wherever a word may start, in any string of a JSON
const FLAG = /(^|[\s(`])--[a-z][\w-]*/g;
const flagsIn = (value: unknown): string[] =>
  typeof value === "string"
    ? [...value.matchAll(FLAG)].map((m) => m[0].trim())
    : typeof value === "object" && value !== null
      ? Object.values(value).flatMap(flagsIn)
      : [];

function setup() {
  const w = world();
  const handle = api(w.m);
  const at = (path: string, init: RequestInit = {}) =>
    handle(new Request(`http://127.0.0.1:1${path}`, init));
  const cookie = async () => tokenOf(await handle(signIn(ADMIN_KEY))) as string;
  return { ...w, handle, at, cookie };
}

// a router over the same database whose server holds no admin key
function keylessRouter(t: ReturnType<typeof setup>) {
  const off = email({
    keys: { email: () => null, emailNames: () => [] },
    sender: async () => ({ ok: false, failure: "other", reply: null }),
  });
  const deps = {
    db: t.db,
    writer: t.m.writer,
    now: () => t.clock.now(),
    log: silent,
  };
  const signIns = logins({ ...deps, adminKey: null });
  return router({
    access: keyAccess(null),
    logins: signIns,
    ui: ui({
      ...deps,
      logins: signIns,
      email: off,
      links: links({ ...deps, email: off, clock: t.clock }),
    }),
    mcp: {} as never,
    clock: fakeClock(NOW),
    log: silent,
  });
}

describe("the login cookie", () => {
  test("holds a random token, the row only its hash, never the key", async () => {
    const t = setup();
    const token = tokenOf(await t.handle(signIn(ADMIN_KEY)));
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(token).not.toContain(ADMIN_KEY);
    const rows = t.db.query("select * from logins").all();
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain(token);
    expect(JSON.stringify(rows)).not.toContain(ADMIN_KEY);
    expect(rows[0]).toMatchObject({
      user_id: "operator",
      token_hash: sha256(token),
      expires_at: t.clock.now() + SESSION_MS,
    });
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
    // the browser's own word wins over Origin and Host
    const behind = "http://127.0.0.1:11238/x";
    expect(
      sameOrigin(
        req(
          {
            "sec-fetch-site": "same-origin",
            origin: "https://markets.example",
          },
          behind,
        ),
      ),
    ).toBe(true);
    for (const site of ["same-site", "cross-site", "none"]) {
      expect([
        site,
        sameOrigin(req({ "sec-fetch-site": site, origin: "http://a.test" })),
      ]).toEqual([site, false]);
    }
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

  test("the cookie is Secure unless the page is plain HTTP on loopback", async () => {
    const t = setup();
    const secure = async (origin: string | null, url = "http://127.0.0.1:1") =>
      (await t.handle(signIn(ADMIN_KEY, url, origin))).headers
        .get("set-cookie")!
        .includes("Secure");
    for (const origin of [
      "http://127.0.0.1:11238",
      "http://localhost:11238",
      "http://[::1]:11238",
    ]) {
      expect([origin, await secure(origin, origin)]).toEqual([origin, false]);
    }
    for (const origin of [
      "http://markets.example",
      "http://192.168.1.2:11238",
      "https://127.0.0.1:11238",
      "null",
      null,
    ]) {
      expect([origin, await secure(origin, "http://markets.example")]).toEqual([
        origin,
        true,
      ]);
    }
    // a proxy that rewrites Host to loopback still gets a Secure cookie
    expect(await secure("https://markets.example")).toBe(true);
    expect(await secure(null)).toBe(true);
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
    const keyless = keylessRouter(t);
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
  test("what the admin key opens, never /mcp", async () => {
    const t = setup();
    const c = { cookie: `${COOKIE}=${await t.cookie()}` };
    for (const path of [
      "/status",
      "/instruments",
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
  });

  test("a login creates, pauses and deletes a rule from this server's pages only", async () => {
    const t = setup();
    listing(t.db, "US:AAA", { price: 100 });
    const cookie = `${COOKIE}=${await t.cookie()}`;
    const send = (method: string, path: string, body: unknown, site: string) =>
      t.at(`${PREFIX}${path}`, {
        method,
        headers: {
          cookie,
          "content-type": "application/json",
          "sec-fetch-site": site,
        },
        body: body === null ? undefined : JSON.stringify(body),
      });
    const rule = {
      symbol: "US:AAA",
      condition: { left: "price", op: "<", right: 90 },
    };
    // a cross-site page holding the cookie changes nothing
    const writes = [
      ["POST", "/rules", rule],
      ["PATCH", "/rules/1", { paused: true }],
      ["DELETE", "/rules/1", null],
    ] as const;
    for (const [method, path, body] of writes) {
      const res = await send(method, path, body, "cross-site");
      expect([method, res.status]).toEqual([method, 403]);
    }
    expect(countRules(t.db)).toBe(0);
    const made = await send("POST", "/rules", rule, "same-origin");
    expect(made.status).toBe(201);
    const paused = await send(
      "PATCH",
      "/rules/1",
      { paused: true },
      "same-origin",
    );
    expect([paused.status, readRule(t.db, OPERATOR, 1)?.paused]).toEqual([
      200,
      "manual",
    ]);
    const gone = await send("DELETE", "/rules/1", null, "same-origin");
    expect([gone.status, countRules(t.db)]).toEqual([204, 0]);
  });

  test("screen's POST is a read, held to the write check", async () => {
    const t = setup();
    const cookie = `${COOKIE}=${await t.cookie()}`;
    const screen = (headers: Record<string, string>) =>
      t.at(`${PREFIX}/screen`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json", ...headers },
        body: JSON.stringify({ symbols: ["US:NOPE"], sort: "rsi14" }),
      });
    // past both checks, the route answers the unknown symbol as its item
    const passed = async (headers: Record<string, string>) => {
      const res = await screen(headers);
      const body = (await res.json()) as {
        matches: { input: string; error?: object }[];
      };
      const item = body.matches[0]!;
      return [res.status, item.input, typeof item.error];
    };
    const answered = [200, "US:NOPE", "object"];
    expect(await passed({ "sec-fetch-site": "same-origin" })).toEqual(answered);
    expect((await screen({ "sec-fetch-site": "cross-site" })).status).toBe(403);
    // without Sec-Fetch-Site the Origin decides
    expect((await screen({})).status).toBe(403);
    expect(await passed({ origin: "http://127.0.0.1:1" })).toEqual(answered);
    expect((await screen({ origin: "http://x.test" })).status).toBe(403);
    const bare = await t.at(`${PREFIX}/screen`, {
      method: "POST",
      headers: {
        authorization: "Bearer nope",
        "content-type": "application/json",
      },
      body: "{}",
    });
    expect(bare.status).toBe(401);
  });

  test("a forged, expired or other key's cookie opens nothing", async () => {
    const t = setup();
    const status = async (cookie: string) =>
      (
        await t.at(`${PREFIX}/status`, {
          headers: { cookie },
        })
      ).status;
    const good = cookieFor(t.db, NOW);
    expect(await status(good)).toBe(200);
    // made under another user-admin.key: a new key signs the browser out
    expect(await status(cookieFor(t.db, NOW, "operator", OTHER_KEY))).toBe(401);
    expect(await status(`${good.slice(0, -2)}xx`)).toBe(401);
    expect(await status(`${COOKIE}=`)).toBe(401);
    // slid at the hour's first use, so it lives 30 days from its last
    await t.clock.advance(SESSION_MS - 1);
    expect(await status(good)).toBe(200);
    await t.m.writer.write(() => {});
    await t.clock.advance(SESSION_MS - 1);
    expect(await status(good)).toBe(200);
    await t.m.writer.write(() => {});
    await t.clock.advance(SESSION_MS);
    expect(await status(good)).toBe(401);
  });

  test("a write by cookie needs the server's own Origin", async () => {
    const t = setup();
    const cookie = `${COOKIE}=${await t.cookie()}`;
    // past the check, the route answers the instrument it does not hold
    const refetch = (headers: Record<string, string>, method = "POST") =>
      t.at(
        `${PREFIX}/instruments/US:NOPE${method === "POST" ? "/refetch" : ""}`,
        {
          method,
          headers: { cookie, "content-type": "application/json", ...headers },
          body:
            method === "POST" ? JSON.stringify({ parts: ["quotes"] }) : null,
        },
      );
    for (const method of ["POST", "DELETE"]) {
      for (const origin of [null, "http://evil.example", "null"]) {
        const res = await refetch(origin === null ? {} : { origin }, method);
        expect([method, origin, res.status]).toEqual([method, origin, 403]);
        expect(await res.json()).toMatchObject({
          status: 403,
          code: "forbidden",
        });
      }
      const res = await refetch({ origin: "http://127.0.0.1:1" }, method);
      expect([method, res.status]).toEqual([method, 404]);
    }
    // behind a proxy that rewrote Host to loopback, the browser's word holds
    for (const [site, status] of [
      ["same-origin", 404],
      ["cross-site", 403],
      ["same-site", 403],
    ] as const) {
      const res = await refetch({
        "sec-fetch-site": site,
        origin: "https://markets.example",
      });
      expect([site, res.status]).toEqual([site, status]);
    }
    expect((await refetch({ origin: "https://markets.example" })).status).toBe(
      403,
    );
    // the admin key alone needs no Origin, as a script sends none
    const keyed = await t.at(`${PREFIX}/instruments/US:NOPE/refetch`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${ADMIN_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ parts: ["quotes"] }),
    });
    expect(keyed.status).toBe(404);
  });

  test("with the UI off there is no sign-in and the cookie opens nothing", () =>
    withApp(async ({ url, admin, db }) => {
      const res = await fetch(`${url}/ui/session`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key: admin }),
      });
      expect(res.status).toBe(401);
      expect(res.headers.get("set-cookie")).toBeNull();
      const status = await fetch(`${url}${PREFIX}/status`, {
        headers: { cookie: cookieFor(db, NOW, "operator", admin) },
      });
      expect(status.status).toBe(401);
      expect((await fetch(url)).status).toBe(401);
    }));
});

// main.ts's icons, by the paths the manifest names
const ICONS = Object.fromEntries(
  ["icon-192.png", "icon-512.png", "icon-maskable-512.png"].map((n) => [
    `/${n}`,
    join(import.meta.dir, "../src/web", n),
  ]),
);

describe("the served UI", () => {
  test("a flag is found in any string of a JSON answer", () => {
    const decoded = JSON.parse('{"a":"--db first","b":["line\\n--db"]}');
    expect(flagsIn(decoded)).toEqual(["--db", "--db"]);
    expect(flagsIn({ a: "a-b--c", b: "x --" })).toEqual([]);
  });

  test("answers its paths with the page and its assets, the key never logged", () =>
    withApp(
      async ({ url, admin, lines }) => {
        const home = await fetch(url);
        expect(home.status).toBe(200);
        expect(home.headers.get("content-type")).toContain("text/html");
        const html = await home.text();
        expect(html).toContain("<title>1ctx Markets</title>");
        expect(html).not.toMatch(/https?:\/\//);
        const linked = [...html.matchAll(/(?:src|href)="(\/[^"]+)"/g)].map(
          (m) => m[1]!,
        );
        expect(linked.some((l) => l.endsWith(".js"))).toBe(true);
        expect(linked.some((l) => l.endsWith(".css"))).toBe(true);
        for (const asset of linked) {
          const res = await fetch(`${url}${asset}`);
          expect([asset, res.status]).toEqual([asset, 200]);
        }
        for (const path of [
          "/admin",
          "/admin/settings",
          "/screener",
          "/symbol/US%3AAAPL",
        ]) {
          const res = await fetch(`${url}${path}`);
          expect([path, res.status]).toEqual([path, 200]);
          expect(await res.text()).toBe(html);
        }
        // the old addresses are no pages
        for (const path of ["/instruments", "/instruments/US%3AAAPL"]) {
          const res = await fetch(`${url}${path}`);
          expect(await res.text()).not.toBe(html);
        }
        // an unknown path is no page: it keeps the keys' 401
        expect((await fetch(`${url}/nothing`)).status).toBe(401);
        const signed = await fetch(`${url}/ui/session`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ key: admin }),
        });
        expect(signed.status).toBe(204);
        const status = await fetch(`${url}${PREFIX}/status`, {
          headers: { cookie: `${COOKIE}=${tokenOf(signed)}` },
        });
        expect(status.status).toBe(200);
        expect(await status.text()).not.toContain(admin);
        for (const line of lines) expect(line).not.toContain(admin);
        expect(lines.some((l) => l.includes("path=/ui/session"))).toBe(true);
      },
      { ui: true, page },
    ));

  test("serves the manifest's icons at the paths it names, with the UI only", async () => {
    const files = ICONS;
    await withApp(
      async ({ url }) => {
        const html = await (await fetch(url)).text();
        const link = /rel="manifest" href="(\/[^"]+)"/.exec(html);
        expect(link).not.toBeNull();
        const manifest = (await (await fetch(`${url}${link![1]}`)).json()) as {
          icons: { src: string }[];
        };
        expect(manifest.icons.map((i) => i.src).sort()).toEqual(
          Object.keys(files).sort(),
        );
        for (const [path, file] of Object.entries(files)) {
          const res = await fetch(`${url}${path}`);
          expect(res.status).toBe(200);
          expect(res.headers.get("content-type")).toBe("image/png");
          expect(new Uint8Array(await res.arrayBuffer())).toEqual(
            await Bun.file(file).bytes(),
          );
          const head = await fetch(`${url}${path}`, { method: "HEAD" });
          expect(head.status).toBe(200);
          expect(head.headers.get("etag")).toBeTruthy();
          await head.arrayBuffer();
        }
        // a path the manifest does not name stays the router's
        expect((await fetch(`${url}/icon-1024.png`)).status).toBe(401);
      },
      { ui: true, page, files },
    );
    await withApp(
      async ({ url }) => {
        expect((await fetch(`${url}/icon-192.png`)).status).toBe(401);
      },
      { ui: false, page, files },
    );
  });

  test("an anonymous visitor reads nothing about the server", () =>
    withApp(
      async ({ url }) => {
        const seen: string[] = [];
        const read = async (path: string, init?: RequestInit) => {
          const res = await fetch(`${url}${path}`, init);
          seen.push(
            JSON.stringify([...res.headers.entries()]),
            // fonts are inlined as base64, whose letters spell nothing
            (await res.text()).replace(/url\(data:[^)]*\)/g, ""),
          );
          return res;
        };
        await read("/");
        const page = seen[1]!;
        for (const asset of [...page.matchAll(/(?:src|href)="(\/[^"]+)"/g)]) {
          await read(asset[1]!);
        }
        await read("/admin");
        await read("/screener");
        for (const icon of Object.keys(ICONS)) {
          expect((await read(icon)).status).toBe(200);
        }
        await read("/ui/session");
        for (const body of ['{"key":"x"}', "{}", "x"]) {
          await read("/ui/session", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body,
          });
        }
        await read("/api/v1/status");
        await read("/api/v1/instruments");
        const ui = seen.length;
        await read("/api/v1/openapi.json");
        expect(flagsIn(JSON.parse(seen.at(-1)!))).toEqual([]);
        await read("/api/v1/docs");
        const docsPage = seen.at(-1)!;
        const files = [
          ...docsPage.matchAll(/(?:src|href)="(\/api\/v1\/docs\/[^"]+)"/g),
        ];
        expect(files.length).toBe(3);
        let ours = seen.join("\n");
        for (const file of files) {
          await read(file[1]!);
          // Swagger UI's own bodies are checked for secrets, not for words
          ours += `\n${seen.at(-2)}`;
          if (file[1]!.includes("/init.js")) ours += `\n${seen.at(-1)}`;
        }
        // the bundles read event.key, so a key file is looked for elsewhere
        const docs = ours.slice(seen.slice(0, ui).join("\n").length);
        expect(docs.includes(".key")).toBe(false);
        expect(seen.length).toBeGreaterThan(20);
        // the SMTP drawer names the directory every install keeps its key
        // files in, as the docs do, so an admin knows where the password
        // file goes; never a path of this one
        const all = seen
          .join("\n")
          .replaceAll("Files in secrets/ named email-*.key.", "")
          .replaceAll("Put the password in secrets/ as ", "");
        for (const secret of [
          SECRETS,
          "secrets",
          "user-admin.key",
          "bearer.key",
          "v0.0.0-test",
          "/Users/",
          "--source",
        ]) {
          expect([secret, all.includes(secret)]).toEqual([secret, false]);
        }
        // Swagger UI's stylesheet names its own map, never one of this server
        expect(ours.includes("sourceMappingURL")).toBe(false);
        // the spec names FRED only as symbol syntax
        // and the home page's help names Yahoo, always on, for its symbols
        const named = ours
          .replaceAll("`FRED:<series id>`", "")
          .replaceAll("as Yahoo Finance writes the symbol", "");
        for (const name of [
          "yahoo",
          "fred",
          "finnhub",
          "massive",
          "bucharest",
          "bvb",
        ]) {
          const said = new RegExp(`\\b${name}\\b`, "i").test(named);
          expect([name, said]).toEqual([name, false]);
        }
      },
      { ui: true, page, files: ICONS },
    ));
});
