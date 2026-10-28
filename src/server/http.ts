// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// The bearer is checked before route lookup, so an unknown path answers 401.

import { createHash, timingSafeEqual } from "node:crypto";
import type { McpHttpHandler } from "@modelcontextprotocol/server";
import type { HTMLBundle } from "bun";
import { failed, notAllowed, notFound, PREFIX } from "../api/http.ts";
import { match, type Route } from "../api/routes.ts";
import type { Clock } from "../runtime/clock.ts";
import { type Log, sdkErrorFields } from "../runtime/log.ts";
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
export const UI_PATHS = ["/", "/status", "/instruments"] as const;

// both sides hashed, so the compare takes the same time whatever was sent
const digest = (value: string): Buffer =>
  createHash("sha256").update(value).digest();

export function bearerCheck(bearer: string): (req: Request) => boolean {
  const want = digest(bearer);
  return (req) => {
    const sent = /^Bearer +(\S+)$/i.exec(
      req.headers.get("authorization") ?? "",
    );
    return sent !== null && timingSafeEqual(digest(sent[1]!), want);
  };
}

export type RouterDeps = {
  bearer: string;
  mcp: McpHttpHandler;
  api?: readonly Route[];
  // the key of /api/v1/admin/* alone; with none those paths refuse all
  adminKey?: string | null;
  // the web UI's sign-in; with none the cookie opens nothing
  sessions?: Sessions | null;
  clock: Clock;
  log: Log;
};

const unauthorized = () =>
  failed(
    { error: "unauthorized", message: "no or wrong bearer key" },
    { "www-authenticate": "Bearer" },
  );

const forbidden = () =>
  failed({
    error: "forbidden",
    message: "a write signed in by cookie needs this server's Origin",
  });

const isAdmin = (path: string) =>
  path === "/admin" || path.startsWith("/admin/");

const READS = new Set(["GET", "HEAD"]);

export function router(deps: RouterDeps): Handle {
  const authorized = bearerCheck(deps.bearer);
  const admin =
    deps.adminKey == null ? () => false : bearerCheck(deps.adminKey);
  const api = deps.api ?? [];
  const sessions = deps.sessions ?? null;
  const signedIn = (req: Request) =>
    sessions?.valid(cookieOf(req), deps.clock.now()) === true;
  // the bearer and the admin key keep their own paths; the cookie opens the
  // admin routes and every read, and a write by it needs the server's Origin
  const allowed = (req: Request, path: string): Response | null => {
    if (isAdmin(path) ? admin(req) : authorized(req)) return null;
    const read = READS.has(req.method);
    if (!signedIn(req) || (!read && !isAdmin(path))) return unauthorized();
    return read || sameOrigin(req) ? null : forbidden();
  };
  const apiRoute = async (req: Request, path: string): Promise<Response> => {
    const url = new URL(req.url);
    const found = match(api, path);
    const open = found?.routes.every((r) => r.key === "none") === true;
    if (!open) {
      const refused = allowed(req, path);
      if (refused !== null) return refused;
    }
    if (found === null) return notFound();
    const r = found.routes.find((x) => x.method === req.method);
    if (r === undefined) return notAllowed(found.routes.map((x) => x.method));
    return r.handle(req, url, found.params);
  };
  const route = async (req: Request, path: string): Promise<Response> => {
    if (path.startsWith(`${PREFIX}/`)) {
      return apiRoute(req, path.slice(PREFIX.length));
    }
    if (sessions !== null && path === SESSION_PATH) {
      return sessionRoute(sessions, req, deps.clock.now());
    }
    if (!authorized(req)) return unauthorized();
    if (path !== "/mcp") return notFound();
    // stateless: no stream to resume with GET, no session to end with DELETE
    if (req.method !== "POST") return notAllowed(["POST"]);
    return deps.mcp.fetch(req);
  };
  return async (req) => {
    const started = deps.clock.now();
    const path = new URL(req.url).pathname;
    // polled while the service starts, so it stays out of the log
    if (path === "/health") {
      if (req.method !== "GET") return notAllowed(["GET"]);
      return new Response(null, { status: 200 });
    }
    let res: Response;
    try {
      res = await route(req, path);
    } catch (error) {
      // a throw from the MCP handler can quote the request
      deps.log.error("request failed", { path, ...sdkErrorFields(error) });
      res = failed({ error: "internal", message: "internal error" });
    }
    deps.log.info("request", {
      method: req.method,
      path,
      status: res.status,
      duration: deps.clock.now() - started,
    });
    return res;
  };
}

export function serve(options: {
  hostname: string;
  port: number;
  handle: Handle;
  // the web UI, bundled by Bun with its assets; none with --no-ui
  page?: HTMLBundle | null;
}): Bun.Server<undefined> {
  const page = options.page ?? null;
  return Bun.serve({
    hostname: options.hostname,
    port: options.port,
    maxRequestBodySize: MAX_BODY_BYTES,
    idleTimeout: IDLE_TIMEOUT_S,
    // the bundle as the binary serves it, never Bun's dev server and its reload
    development: false,
    routes:
      page === null
        ? {}
        : Object.fromEntries(UI_PATHS.map((path) => [path, page])),
    fetch: options.handle,
  });
}
