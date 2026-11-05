// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// A key is checked before a path is known missing, so an unknown path
// answers 401 without one; the skills are open source and need none.

import { readFileSync } from "node:fs";
import type { McpHttpHandler } from "@modelcontextprotocol/server";
import type { HTMLBundle } from "bun";
import { failed, notAllowed, notFound, PREFIX, problem } from "../api/http.ts";
import { match, type Route } from "../api/routes.ts";
import {
  ADMIN,
  loginWho,
  NO_ACCESS,
  opens,
  type Who,
} from "../operations/who.ts";
import { type Clock, MINUTE_MS } from "../runtime/clock.ts";
import { type Log, type LogFields, sdkErrorFields } from "../runtime/log.ts";
import type { Access, Caller } from "./access.ts";
import { asCaller, checkOf } from "./caller.ts";
import { CALLS_PER_MINUTE, RateLimit } from "./ratelimit.ts";
import {
  cookieOf,
  type Login,
  type Logins,
  loginCookie,
  sameOrigin,
} from "./session.ts";
import { buildSkills, SKILLS_PREFIX } from "./skills.ts";
import type { Ui } from "./ui.ts";

const MAX_BODY_BYTES = 1024 * 1024;
// Bun's 10 s idle default is under CALL_MS; 30 s adds room for a queued write
export const IDLE_TIMEOUT_S = 30;

// ip: the client's address, for the sign-in routes' limit
export type Handle = (req: Request, ip?: string) => Promise<Response>;

// the web UI's own paths, each answered with its page; src/web/app/routes.ts
// routes the same
export const UI_PATHS = [
  "/",
  "/connect",
  "/admin",
  "/admin/settings",
  "/admin/users",
  "/screener",
  "/symbol/:id",
  "/portfolios",
  "/portfolios/:id",
  "/portfolios/shared/:user",
  "/portfolios/shared/:user/:id",
  "/alerts",
  "/alerts/history",
  "/profile",
] as const;

export type RouterDeps = {
  // user-admin.key and the agent keys
  access: Access;
  mcp: McpHttpHandler;
  api?: readonly Route[];
  // the web UI's logins; with none the cookie opens nothing
  logins?: Logins | null;
  // the sign-in routes under /ui; none with the UI off
  ui?: Ui | null;
  clock: Clock;
  log: Log;
};

// no WWW-Authenticate, so an MCP client never starts an OAuth sign-in
const unauthorized = () =>
  failed({ error: "unauthorized", message: "no or wrong key" });

const apiUnauthorized = () => problem("unauthorized", "no or wrong key");

const forbidden = (detail: string) => problem("forbidden", detail);

const TOO_MANY = `over ${CALLS_PER_MINUTE} calls a minute`;

const READS = new Set(["GET", "HEAD"]);

const isApi = (path: string) =>
  path === PREFIX || path.startsWith(`${PREFIX}/`);

// user-admin.key is limited as a key of its own
const limitId = (c: Caller): string =>
  c.kind === "admin" ? "admin" : c.key.id;

// a batch is one request of many messages, each counted
async function messages(req: Request): Promise<number> {
  try {
    const body: unknown = await req.clone().json();
    return Array.isArray(body) ? Math.max(1, body.length) : 1;
  } catch {
    return 1;
  }
}

// a login acts as its person in the web UI; a key as the person who made it
export const whoOf = (c: Caller | null, login: Login | null = null): Who =>
  c === null
    ? login === null
      ? NO_ACCESS
      : loginWho(login.user, login.id, login.name)
    : c.kind === "admin"
      ? ADMIN
      : {
          name: c.key.name,
          user: c.key.user,
          credential: { kind: "key", id: c.key.id },
          portfolio: c.key.portfolio,
          alerts: c.key.alerts,
          profile: c.key.profile,
          analysis: c.key.analysis,
        };

const keyFields = (c: Caller | null, login: Login | null): LogFields =>
  c === null
    ? login === null
      ? {}
      : { user: login.user, login: login.id }
    : c.kind === "admin"
      ? { key: "admin" }
      : { key: c.key.id, key_name: c.key.name };

export function router(deps: RouterDeps): Handle {
  const api = deps.api ?? [];
  const logins = deps.logins ?? null;
  const skills = buildSkills();
  const ui = deps.ui ?? null;
  const rate = new RateLimit(CALLS_PER_MINUTE, MINUTE_MS);
  const now = () => deps.clock.now();
  const checks = { adminDigest: logins?.adminDigest ?? null, now };
  // counted before a body is read, so a refused call costs no read
  const limited = (
    c: Caller,
    over: (retry: string) => Response,
    n = 1,
  ): Response | null => {
    const id = limitId(c);
    const now = deps.clock.now();
    let ok = true;
    for (let k = 0; k < n; k++) if (!rate.hit(id, now)) ok = false;
    return ok ? null : over(String(rate.retryAfter(id, now)));
  };
  const apiOver = (retry: string) =>
    problem(
      "too_many_requests",
      TOO_MANY,
      {},
      {
        "cache-control": "no-store",
        "retry-after": retry,
      },
    );
  const mcpOver = (retry: string) =>
    failed(
      { error: "too_many_requests", message: TOO_MANY },
      { "cache-control": "no-store", "retry-after": retry },
    );
  // one path holds operations of different scopes (GET and DELETE)
  const allowed = (
    req: Request,
    c: Caller | null,
    login: Login | null,
    r: Route | null,
  ): Response | null => {
    if (c !== null) {
      const over = limited(c, apiOver);
      if (over !== null) return over;
      if (c.kind === "admin" || r === null || r.scope === "read") return null;
      // a key never opens the web UI's own routes or an admin's
      if (r.scope === "admin" || r.scope === "session") {
        return forbidden("this key does not open this route");
      }
      const [area, level] = r.scope.split(":");
      const held =
        area === "portfolio"
          ? c.key.portfolio
          : area === "alerts"
            ? c.key.alerts
            : area === "profile"
              ? c.key.profile
              : area === "analysis"
                ? c.key.analysis
                : null;
      if (held !== null && opens(held, level === "write")) return null;
      return forbidden("this key does not open this route");
    }
    if (login === null) return apiUnauthorized();
    // a cookie's write must come from this server's own pages
    if (!READS.has(req.method) && !sameOrigin(req)) {
      return forbidden("not sent from this server's pages");
    }
    return r?.scope === "admin" && login.role !== "admin"
      ? forbidden("for admins only")
      : null;
  };
  const apiRoute = async (
    req: Request,
    path: string,
    c: Caller | null,
    login: Login | null,
  ): Promise<Response> => {
    const url = new URL(req.url);
    const found = match(api, path);
    if (found?.routes.every((r) => r.scope === "none") === true) {
      const r = found.routes.find((x) => x.method === req.method);
      if (r === undefined) return notAllowed(found.routes.map((x) => x.method));
      return r.handle(req, url, found.params, NO_ACCESS);
    }
    const r = found?.routes.find((x) => x.method === req.method) ?? null;
    const refused = allowed(req, c, login, r);
    if (refused !== null) return refused;
    if (found === null) return notFound();
    if (r === null) return notAllowed(found.routes.map((x) => x.method));
    const who = whoOf(c, login);
    // every write under it re-reads this very credential
    return asCaller(checkOf(who, checks), () =>
      r.handle(req, url, found.params, who),
    );
  };
  const route = async (
    req: Request,
    path: string,
    c: Caller | null,
    login: Login | null,
    ip: string,
  ): Promise<Response> => {
    if (path.startsWith(SKILLS_PREFIX)) {
      const file = skills.get(path.slice(SKILLS_PREFIX.length));
      if (file === undefined) {
        return failed({ error: "not_found", message: "no such skill" });
      }
      if (req.method !== "GET") return plainNotAllowed(["GET"]);
      return new Response(file.body, {
        headers: { "content-type": file.type, "cache-control": "no-cache" },
      });
    }
    if (isApi(path)) return apiRoute(req, path.slice(PREFIX.length), c, login);
    if (ui !== null && path.startsWith("/ui/")) {
      const res = await ui.route(req, path, ip);
      if (res !== null) return res;
    }
    if (c === null) return unauthorized();
    const over = limited(c, mcpOver);
    if (over !== null) return over;
    if (path !== "/mcp") {
      return failed({ error: "not_found", message: "no such route" });
    }
    // stateless: no stream to resume with GET, no session to end with DELETE
    if (req.method !== "POST") return plainNotAllowed(["POST"]);
    // the first message was counted above
    const more = (await messages(req)) - 1;
    if (more > 0) {
      const batch = limited(c, mcpOver, more);
      if (batch !== null) return batch;
    }
    const who = whoOf(c);
    return asCaller(checkOf(who, checks), () =>
      deps.mcp.fetch(req, {
        authInfo: {
          token: "",
          clientId: who.name,
          scopes: [
            `portfolio:${who.portfolio}`,
            `alerts:${who.alerts}`,
            `profile:${who.profile}`,
            `analysis:${who.analysis}`,
          ],
          // per request, never a global: each tool call reads its own person
          extra: { user: who.user, credential: who.credential },
        },
      }),
    );
  };
  return async (req, ip = "local") => {
    const started = deps.clock.now();
    const path = new URL(req.url).pathname;
    // polled while the service starts, so it stays out of the log
    if (path === "/health") {
      if (req.method !== "GET") return plainNotAllowed(["GET"]);
      return new Response(null, { status: 200 });
    }
    let res: Response;
    let c: Caller | null = null;
    let login: Login | null = null;
    try {
      c = deps.access.caller(req);
      // a valid key wins: a key never borrows a browser's login
      const resolved =
        c === null && logins !== null ? logins.resolve(req) : null;
      login = resolved?.login ?? null;
      res = await route(req, path, c, login, ip);
      // a moved expiry goes back to the browser, unless the answer set the
      // cookie itself
      if (resolved?.touched === true && !res.headers.has("set-cookie")) {
        res.headers.set("set-cookie", loginCookie(req, cookieOf(req)!));
      }
    } catch (error) {
      // a throw from the MCP handler can quote the request
      deps.log.error("request failed", {
        path: loggedPath(path),
        ...sdkErrorFields(error),
      });
      res = isApi(path)
        ? problem("internal", "internal error")
        : failed({ error: "internal", message: "internal error" });
    }
    deps.log.info("request", {
      method: req.method,
      path: loggedPath(path),
      status: res.status,
      duration: deps.clock.now() - started,
      ...keyFields(c, login),
    });
    return res;
  };
}

// a sign-in link's path holds its token, which no log line may
export const loggedPath = (path: string): string =>
  path.startsWith("/ui/link/") ? "/ui/link/:token" : path;

// the client's address, for the sign-in routes' limit: behind a trusted
// proxy the last X-Forwarded-For value, the one that proxy added
export function clientIp(
  req: Request,
  socket: string | undefined,
  trustProxy: boolean,
): string {
  if (trustProxy) {
    const last = (req.headers.get("x-forwarded-for") ?? "")
      .split(",")
      .at(-1)
      ?.trim();
    if (last !== undefined && last !== "") return last;
  }
  return socket ?? "unknown";
}

// outside /api/v1 an error keeps the {error, message} shape
const plainNotAllowed = (allow: readonly string[]): Response =>
  failed(
    { error: "method_not_allowed", message: `use ${allow.join(", ")}` },
    { "cache-control": "no-store", allow: allow.join(", ") },
  );

export const BUILD_HEADER = "x-markets-build";

export function serve(options: {
  hostname: string;
  port: number;
  handle: Handle;
  // the web UI, bundled by Bun with its assets; none with --no-ui
  page?: HTMLBundle | null;
  // a fixed path to the file served there, public as the page is
  files?: Readonly<Record<string, string>>;
  // a local preview's: rebuilt after an edit, without the reload script
  pageDev?: boolean;
  // --trust-proxy: the client address is the proxy's last X-Forwarded-For
  trustProxy?: boolean;
}): Bun.Server<undefined> {
  const page = options.page ?? null;
  // stamped on every answer, so an open tab sees a deploy; random, as the
  // version is never told to an anonymous visitor
  const build = crypto.randomUUID();
  // static answers, read once: Bun answers HEAD and ETag for them
  const files = Object.fromEntries(
    Object.entries(options.files ?? {}).map(([path, file]) => [
      path,
      new Response(readFileSync(file), {
        headers: { "content-type": Bun.file(file).type },
      }),
    ]),
  );
  return Bun.serve({
    hostname: options.hostname,
    port: options.port,
    maxRequestBodySize: MAX_BODY_BYTES,
    idleTimeout: IDLE_TIMEOUT_S,
    // the bundle as the binary serves it, never Bun's dev server and its
    // reload, but for a local preview that rebuilds it after an edit
    development: options.pageDev === true ? { hmr: false } : false,
    routes:
      page === null
        ? {}
        : {
            ...files,
            ...Object.fromEntries(UI_PATHS.map((path) => [path, page])),
          },
    fetch: async (req, server) => {
      const res = await options.handle(
        req,
        clientIp(
          req,
          server.requestIP(req)?.address,
          options.trustProxy === true,
        ),
      );
      res.headers.set(BUILD_HEADER, build);
      return res;
    },
  });
}
