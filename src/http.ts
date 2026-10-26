// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// One Bun server; the bearer is checked before any route is looked up,
// so an unknown path answers 401 to a caller without it, as /mcp does.
// GET /health is the one route before it, for a service manager's probe.
// /admin/* takes the admin key alone, which no other path takes.

import { createHash, timingSafeEqual } from "node:crypto";
import type { McpHttpHandler } from "@modelcontextprotocol/server";
import type { Clock } from "./clock.ts";
import { type Log, sdkErrorFields } from "./log.ts";

const MAX_BODY_BYTES = 1024 * 1024;
// Bun drops a request idle for 10 s by default, under a tool call's 15 s
// deadline (CALL_MS); 30 s clears it with room for the queued write
export const IDLE_TIMEOUT_S = 30;

export type Handle = (req: Request) => Promise<Response>;

const json = (
  body: unknown,
  status: number,
  headers: Record<string, string> = {},
): Response => Response.json(body, { status, headers });

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
  // GET /quotes, when the tools are served
  quotes?: Handle;
  // GET /research, when the tools are served
  research?: Handle;
  // GET /alerts, the feed a polling client reads
  alerts?: Handle;
  // /admin/*, behind its own key
  admin?: { key: string; handle: Handle };
  clock: Clock;
  log: Log;
};

const unauthorized = () =>
  json({ error: "unauthorized" }, 401, { "www-authenticate": "Bearer" });

const isAdmin = (path: string) =>
  path === "/admin" || path.startsWith("/admin/");

export function router(deps: RouterDeps): Handle {
  const authorized = bearerCheck(deps.bearer);
  const admin =
    deps.admin === undefined
      ? null
      : { handle: deps.admin.handle, authorized: bearerCheck(deps.admin.key) };
  const route = async (req: Request, path: string): Promise<Response> => {
    if (admin !== null && isAdmin(path)) {
      if (!admin.authorized(req)) return unauthorized();
      return admin.handle(req);
    }
    if (!authorized(req)) return unauthorized();
    const read =
      path === "/quotes"
        ? deps.quotes
        : path === "/research"
          ? deps.research
          : path === "/alerts"
            ? deps.alerts
            : undefined;
    if (read !== undefined) {
      if (req.method !== "GET") {
        return json({ error: "method not allowed" }, 405, { allow: "GET" });
      }
      return read(req);
    }
    if (path !== "/mcp") return json({ error: "not found" }, 404);
    // stateless: no stream to resume with GET, no session to end with DELETE
    if (req.method !== "POST") {
      return json({ error: "method not allowed" }, 405, { allow: "POST" });
    }
    return deps.mcp.fetch(req);
  };
  return async (req) => {
    const started = deps.clock.now();
    const path = new URL(req.url).pathname;
    // polled while the service starts, so it stays out of the log
    if (path === "/health") {
      if (req.method !== "GET") {
        return json({ error: "method not allowed" }, 405, { allow: "GET" });
      }
      return new Response(null, { status: 200 });
    }
    let res: Response;
    try {
      res = await route(req, path);
    } catch (error) {
      // a throw from the MCP handler can quote the request
      deps.log.error("request failed", { path, ...sdkErrorFields(error) });
      res = json({ error: "internal error" }, 500);
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
