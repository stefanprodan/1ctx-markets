// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// /api/v1 through the real router over a test's own Markets, with the
// right key put on each request, so a route is called as a client
// calls it without a server or a port.

import type { SourceState } from "../../src/admin/http.ts";
import { alertsHandler } from "../../src/api/alerts.ts";
import { PREFIX } from "../../src/api/http.ts";
import { routes } from "../../src/api/routes.ts";
import type { Markets } from "../../src/operations/markets.ts";
import { silent } from "../../src/runtime/log.ts";
import { router } from "../../src/server/http.ts";

// made up: no real key is ever read by a test
export const READ_KEY = "test-read-key-0123456789abcdef0123456789";
export const ADMIN_KEY = "test-admin-key-0123456789abcdef0123456789";

export function api(m: Markets, options: { sources?: SourceState[] } = {}) {
  const handle = router({
    bearer: READ_KEY,
    adminKey: ADMIN_KEY,
    mcp: {
      fetch: async () => {
        throw new Error("no MCP in API tests");
      },
    } as never,
    api: routes({
      m,
      alerts: alertsHandler({ db: m.db, log: silent }),
      admin: { m, version: "v0.0.0-test", sources: options.sources ?? [] },
      log: silent,
    }),
    clock: m.clock,
    log: silent,
  });
  return (req: Request): Promise<Response> => {
    if (req.headers.has("authorization")) return handle(req);
    const path = new URL(req.url).pathname;
    const key = path.startsWith(`${PREFIX}/admin`) ? ADMIN_KEY : READ_KEY;
    const headers = new Headers(req.headers);
    headers.set("authorization", `Bearer ${key}`);
    return handle(new Request(req, { headers }));
  };
}
