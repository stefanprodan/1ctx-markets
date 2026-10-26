// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// One Bun server; the bearer is checked before any route is looked up,
// so an unknown path answers 401 to a caller without it, as /mcp does.

import { createHash, timingSafeEqual } from "node:crypto";
import type { McpHttpHandler } from "@modelcontextprotocol/server";
import type { Clock } from "./clock.ts";
import { errorFields, type Log } from "./log.ts";

const MAX_BODY_BYTES = 1024 * 1024;

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
  // GET /alerts, the feed 1ctx's automation check reads
  alerts?: Handle;
  clock: Clock;
  log: Log;
};

export function router(deps: RouterDeps): Handle {
  const authorized = bearerCheck(deps.bearer);
  const route = async (req: Request, path: string): Promise<Response> => {
    if (!authorized(req)) {
      return json({ error: "unauthorized" }, 401, {
        "www-authenticate": "Bearer",
      });
    }
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
    let res: Response;
    try {
      res = await route(req, path);
    } catch (error) {
      deps.log.error("request failed", { path, ...errorFields(error) });
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
    fetch: options.handle,
  });
}
