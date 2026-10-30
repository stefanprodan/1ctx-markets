// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// The real router without a server or a port, each request with its key.

import type { SourceState } from "../../src/admin/http.ts";
import { alertsHandler } from "../../src/api/alerts.ts";
import { PREFIX } from "../../src/api/http.ts";
import { match, routes } from "../../src/api/routes.ts";
import type { Markets } from "../../src/operations/markets.ts";
import type { TrackState } from "../../src/operations/track.ts";
import { silent } from "../../src/runtime/log.ts";
import {
  type Access,
  access,
  bearerOf,
  tokenHash,
} from "../../src/server/access.ts";
import { router } from "../../src/server/http.ts";
import { sessions } from "../../src/server/session.ts";

// made up: no real key is ever read by a test; READ_KEY is an agent key
export const READ_KEY = "test-read-key-0123456789abcdef0123456789";
export const ADMIN_KEY = "test-admin-key-0123456789abcdef0123456789";

// READ_KEY as an agent key and the admin key, without a database
export function keyAccess(adminKey: string | null): Access {
  return {
    caller(req) {
      const sent = bearerOf(req);
      if (sent !== null && sent === adminKey) return { kind: "admin" };
      if (sent !== READ_KEY) return null;
      return {
        kind: "agent",
        key: {
          id: "testreadkey0",
          name: "test-read",
          createdAt: 0,
          expiresAt: null,
          lastUsedAt: null,
          portfolio: "none",
          rules: "none",
        },
      };
    },
  };
}

export function api(
  m: Markets,
  options: { sources?: SourceState[]; track?: () => TrackState[] } = {},
) {
  const list = routes({
    m,
    alerts: alertsHandler({ db: m.db, log: silent }),
    admin: {
      m,
      version: "v0.0.0-test",
      sources: options.sources ?? [],
    },
    track: options.track ?? (() => []),
    log: silent,
  });
  m.db
    .query(
      `insert or ignore into keys (id, name, token_hash, created_at)
       values ('testreadkey0', 'test-read', ?, ?)`,
    )
    .run(tokenHash(READ_KEY), m.clock.now());
  const handle = router({
    access: access({
      db: m.db,
      writer: m.writer,
      adminKey: ADMIN_KEY,
      now: () => m.clock.now(),
      log: silent,
    }),
    sessions: sessions(ADMIN_KEY),
    mcp: {
      fetch: async () => {
        throw new Error("no MCP in API tests");
      },
    } as never,
    api: list,
    clock: m.clock,
    log: silent,
  });
  return (req: Request): Promise<Response> => {
    // a request with the UI's cookie or its own key goes as it is
    if (req.headers.has("authorization") || req.headers.has("cookie")) {
      return handle(req);
    }
    // the narrowest key the route takes; the read key opens no portfolio
    const path = new URL(req.url).pathname.slice(PREFIX.length);
    const found = match(list, path);
    const admin = found?.routes.some(
      (r) => r.method === req.method && r.scope !== "read",
    );
    const headers = new Headers(req.headers);
    headers.set("authorization", `Bearer ${admin ? ADMIN_KEY : READ_KEY}`);
    return handle(new Request(req, { headers }));
  };
}
