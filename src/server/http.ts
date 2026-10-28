// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// One Bun server; the bearer is checked before any route is looked up,
// so an unknown path answers 401 to a caller without it, as /mcp does.
// GET /health, the API's spec and its docs page are the routes before
// it: they hold no data. /api/v1/admin/* takes the admin key alone,
// which no other path takes.

import { createHash, timingSafeEqual } from "node:crypto";
import type { McpHttpHandler } from "@modelcontextprotocol/server";
import { failed, notAllowed, notFound, PREFIX } from "../api/http.ts";
import { match, type Route } from "../api/routes.ts";
import type { Clock } from "../runtime/clock.ts";
import { type Log, sdkErrorFields } from "../runtime/log.ts";

const MAX_BODY_BYTES = 1024 * 1024;
// Bun drops a request idle for 10 s by default, under a tool call's 15 s
// deadline (CALL_MS); 30 s clears it with room for the queued write
export const IDLE_TIMEOUT_S = 30;

export type Handle = (req: Request) => Promise<Response>;

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
  // /api/v1, when the tools are served
  api?: readonly Route[];
  // the key of /api/v1/admin/* alone; with none those paths refuse all
  adminKey?: string | null;
  clock: Clock;
  log: Log;
};

const unauthorized = () =>
  failed(
    { error: "unauthorized", message: "no or wrong bearer key" },
    { "www-authenticate": "Bearer" },
  );

const isAdmin = (path: string) =>
  path === "/admin" || path.startsWith("/admin/");

export function router(deps: RouterDeps): Handle {
  const authorized = bearerCheck(deps.bearer);
  const admin =
    deps.adminKey == null ? () => false : bearerCheck(deps.adminKey);
  const api = deps.api ?? [];
  const apiRoute = async (req: Request, path: string): Promise<Response> => {
    const url = new URL(req.url);
    const found = match(api, path);
    const open = found?.routes.every((r) => r.key === "none") === true;
    if (!open && !(isAdmin(path) ? admin(req) : authorized(req))) {
      return unauthorized();
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
}): Bun.Server<undefined> {
  return Bun.serve({
    hostname: options.hostname,
    port: options.port,
    maxRequestBodySize: MAX_BODY_BYTES,
    idleTimeout: IDLE_TIMEOUT_S,
    fetch: options.handle,
  });
}
