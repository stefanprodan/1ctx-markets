// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// A key is checked before a path is known missing, so an unknown path
// answers 401 without one.

import type { McpHttpHandler } from "@modelcontextprotocol/server";
import type { HTMLBundle } from "bun";
import { failed, notAllowed, notFound, PREFIX, problem } from "../api/http.ts";
import { match, type Route } from "../api/routes.ts";
import { type Clock, MINUTE_MS } from "../runtime/clock.ts";
import { type Log, type LogFields, sdkErrorFields } from "../runtime/log.ts";
import type { Access, Caller } from "./access.ts";
import { CALLS_PER_MINUTE, RateLimit } from "./ratelimit.ts";
import {
  cookieOf,
  SESSION_PATH,
  type Sessions,
  sameOrigin,
  sessionRoute,
} from "./session.ts";

const MAX_BODY_BYTES = 1024 * 1024;
// Bun's 10 s idle default is under CALL_MS; 30 s adds room for a queued write
export const IDLE_TIMEOUT_S = 30;

export type Handle = (req: Request) => Promise<Response>;

// the web UI's own paths, each answered with its page; src/web/app/routes.ts
// routes the same
export const UI_PATHS = [
  "/",
  "/status",
  "/connect",
  "/instruments",
  "/instruments/:id",
] as const;

export type RouterDeps = {
  // user-admin.key and the agent keys
  access: Access;
  mcp: McpHttpHandler;
  api?: readonly Route[];
  // the web UI's sign-in; with none the cookie opens nothing
  sessions?: Sessions | null;
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

const keyFields = (c: Caller | null): LogFields =>
  c === null
    ? {}
    : c.kind === "admin"
      ? { key: "admin" }
      : { key: c.key.id, key_name: c.key.name };

export function router(deps: RouterDeps): Handle {
  const api = deps.api ?? [];
  const sessions = deps.sessions ?? null;
  const rate = new RateLimit(CALLS_PER_MINUTE, MINUTE_MS);
  const signedIn = (req: Request) =>
    sessions?.valid(cookieOf(req), deps.clock.now()) === true;
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
    r: Route | null,
  ): Response | null => {
    if (c !== null) {
      const over = limited(c, apiOver);
      if (over !== null) return over;
      if (c.kind === "admin" || r === null || r.scope === "read") return null;
      return forbidden("this key does not open this route");
    }
    if (!signedIn(req) || r?.cookie === false) return apiUnauthorized();
    // a cookie's write must come from this server's own pages
    return READS.has(req.method) || sameOrigin(req)
      ? null
      : forbidden("not sent from this server's pages");
  };
  const apiRoute = async (
    req: Request,
    path: string,
    c: Caller | null,
  ): Promise<Response> => {
    const url = new URL(req.url);
    const found = match(api, path);
    if (found?.routes.every((r) => r.scope === "none") === true) {
      const r = found.routes.find((x) => x.method === req.method);
      if (r === undefined) return notAllowed(found.routes.map((x) => x.method));
      return r.handle(req, url, found.params);
    }
    const r = found?.routes.find((x) => x.method === req.method) ?? null;
    const refused = allowed(req, c, r);
    if (refused !== null) return refused;
    if (found === null) return notFound();
    if (r === null) return notAllowed(found.routes.map((x) => x.method));
    return r.handle(req, url, found.params);
  };
  const route = async (
    req: Request,
    path: string,
    c: Caller | null,
  ): Promise<Response> => {
    if (isApi(path)) return apiRoute(req, path.slice(PREFIX.length), c);
    if (sessions !== null && path === SESSION_PATH) {
      return sessionRoute(sessions, req, deps.clock.now());
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
    return deps.mcp.fetch(req);
  };
  return async (req) => {
    const started = deps.clock.now();
    const path = new URL(req.url).pathname;
    // polled while the service starts, so it stays out of the log
    if (path === "/health") {
      if (req.method !== "GET") return plainNotAllowed(["GET"]);
      return new Response(null, { status: 200 });
    }
    let res: Response;
    let c: Caller | null = null;
    try {
      c = deps.access.caller(req);
      res = await route(req, path, c);
    } catch (error) {
      // a throw from the MCP handler can quote the request
      deps.log.error("request failed", { path, ...sdkErrorFields(error) });
      res = isApi(path)
        ? problem("internal", "internal error")
        : failed({ error: "internal", message: "internal error" });
    }
    deps.log.info("request", {
      method: req.method,
      path,
      status: res.status,
      duration: deps.clock.now() - started,
      ...keyFields(c),
    });
    return res;
  };
}

// outside /api/v1 an error keeps the {error, message} shape
const plainNotAllowed = (allow: readonly string[]): Response =>
  failed(
    { error: "method_not_allowed", message: `use ${allow.join(", ")}` },
    { "cache-control": "no-store", allow: allow.join(", ") },
  );

export function serve(options: {
  hostname: string;
  port: number;
  handle: Handle;
  // the web UI, bundled by Bun with its assets; none with --no-ui
  page?: HTMLBundle | null;
  // a local preview's: rebuilt after an edit, without the reload script
  pageDev?: boolean;
}): Bun.Server<undefined> {
  const page = options.page ?? null;
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
        : Object.fromEntries(UI_PATHS.map((path) => [path, page])),
    fetch: options.handle,
  });
}
