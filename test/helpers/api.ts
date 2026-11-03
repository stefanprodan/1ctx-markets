// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// The real router without a server or a port, each request with its key.

import type { SourceState } from "../../src/admin/http.ts";
import { alertsHandler } from "../../src/api/alerts.ts";
import { PREFIX } from "../../src/api/http.ts";
import { match, routes } from "../../src/api/routes.ts";
import type { Markets } from "../../src/operations/markets.ts";
import type { TrackState } from "../../src/operations/track.ts";
import { type Log, silent } from "../../src/runtime/log.ts";
import {
  type Access,
  access,
  bearerOf,
  tokenHash,
} from "../../src/server/access.ts";
import { email as emailOf } from "../../src/server/email/settings.ts";
import type { EmailSender } from "../../src/server/email/smtp.ts";
import { router } from "../../src/server/http.ts";
import { links as linksOf } from "../../src/server/links.ts";
import {
  adminDigest,
  COOKIE,
  logins,
  openLogin,
} from "../../src/server/session.ts";
import { ui } from "../../src/server/ui.ts";
import type { Db } from "../../src/storage/db/index.ts";

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
          user: "operator",
          name: "test-read",
          createdAt: 0,
          expiresAt: null,
          lastUsedAt: null,
          portfolio: "none",
          rules: "none",
          profile: "none",
        },
      };
    },
  };
}

// a signed-in browser's cookie header: a login opened as the web UI opens
// one; the operator's by the admin key unless a person is named
export function cookieFor(
  db: Db,
  now: number,
  user = "operator",
  adminKey: string | null = user === "operator" ? ADMIN_KEY : null,
): string {
  const made = openLogin(
    db,
    user,
    now,
    adminKey === null ? null : adminDigest(adminKey),
  );
  return `${COOKIE}=${made.token}`;
}

export function api(
  m: Markets,
  options: {
    sources?: SourceState[];
    track?: () => TrackState[];
    // email's key files and sender; email stays off without them
    secrets?: { email(name: string): string | null; emailNames(): string[] };
    sender?: EmailSender;
    log?: Log;
  } = {},
) {
  const log = options.log ?? silent;
  const email = emailOf({
    keys: options.secrets ?? { email: () => null, emailNames: () => [] },
    sender:
      options.sender ??
      (async () => ({ ok: false, failure: "connect", reply: null })),
  });
  const sent = linksOf({
    db: m.db,
    writer: m.writer,
    email,
    clock: m.clock,
    log,
  });
  const list = routes({
    m,
    alerts: alertsHandler({ db: m.db, log: silent }),
    admin: {
      m,
      version: "v0.0.0-test",
      sources: options.sources ?? [],
      sync: true,
    },
    track: options.track ?? (() => []),
    log,
    email,
    links: sent,
  });
  m.db
    .query(
      `insert or ignore into keys (id, user_id, name, token_hash, created_at)
       values ('testreadkey0', 'operator', 'test-read', ?, ?)`,
    )
    .run(tokenHash(READ_KEY), m.clock.now());
  const signIns = logins({
    db: m.db,
    writer: m.writer,
    adminKey: ADMIN_KEY,
    now: () => m.clock.now(),
    log: silent,
  });
  const handle = router({
    access: access({
      db: m.db,
      writer: m.writer,
      adminKey: ADMIN_KEY,
      now: () => m.clock.now(),
      log,
    }),
    logins: signIns,
    ui: ui({
      db: m.db,
      writer: m.writer,
      logins: signIns,
      links: sent,
      email,
      now: () => m.clock.now(),
      log,
    }),
    mcp: {
      fetch: async () => {
        throw new Error("no MCP in API tests");
      },
    } as never,
    api: list,
    clock: m.clock,
    log,
  });
  // ip: the client's address, for the sign-in routes' limit
  const call = (req: Request, ip?: string): Promise<Response> => {
    // a request with the UI's cookie or its own key goes as it is, and the
    // web UI's own routes
    if (
      req.headers.has("authorization") ||
      req.headers.has("cookie") ||
      new URL(req.url).pathname.startsWith("/ui/")
    ) {
      return handle(req, ip);
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
  // the sends an ask makes after its answer
  return Object.assign(call, { links: sent });
}
