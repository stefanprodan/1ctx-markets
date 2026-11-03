// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// The web UI's sign-ins: a login row behind a cookie that holds a random
// token, the row only its sha256. A key never signs in here and a login
// never opens /mcp; user-admin.key is the one exception, signing in as the
// operator.

import { createHash, timingSafeEqual } from "node:crypto";
import { DAY_MS, HOUR_MS } from "../runtime/clock.ts";
import { errorFields, type Log } from "../runtime/log.ts";
import type { Db } from "../storage/db/index.ts";
import type { Writer } from "../storage/writer.ts";

export const COOKIE = "markets_session";
export const SESSION_MS = 30 * DAY_MS;
// a login's expiry moves at most this often, so a busy tab costs no write
// per request
export const TOUCH_MS = HOUR_MS;
export const SESSION_PATH = "/ui/session";

export type Role = "admin" | "member";

export type Login = {
  id: string;
  user: string;
  name: string;
  role: Role;
  email: string | null;
  expiresAt: number;
};

export const sha256 = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

// 32 random bytes, so a plain hash cannot be reversed
export const newToken = (): string =>
  Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");

const ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
export function newId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  let out = "";
  for (const b of bytes) out += ID_ALPHABET[b % ID_ALPHABET.length];
  return out;
}

// what an operator login holds of user-admin.key, so a new key ends it
export const adminDigest = (adminKey: string): string =>
  sha256(`1ctx-markets admin login ${adminKey}`);

// inside a write: the login and the person's sign-in time
export function openLogin(
  db: Db,
  user: string,
  now: number,
  digest: string | null = null,
): { id: string; token: string } {
  const id = newId();
  const token = newToken();
  db.query(
    `insert into logins (id, user_id, admin_digest, token_hash, created_at,
       last_seen_at, expires_at) values (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, user, digest, sha256(token), now, now, now + SESSION_MS);
  db.query("update users set last_sign_in_at = ? where id = ?").run(now, user);
  return { id, token };
}

export const endLogin = (db: Db, id: string): boolean =>
  db.query("delete from logins where id = ?").run(id).changes > 0;

// expired logins, and links used or past their time; asks past a day
export function pruneLogins(db: Db, now: number): void {
  db.query("delete from logins where expires_at <= ?").run(now);
  db.query(
    "delete from links where used_at is not null or expires_at <= ?",
  ).run(now);
  db.query("delete from link_asks where asked_at <= ?").run(now - DAY_MS);
}

export function cookieOf(req: Request, name = COOKIE): string | null {
  for (const part of (req.headers.get("cookie") ?? "").split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0 && part.slice(0, eq).trim() === name) {
      return part.slice(eq + 1).trim();
    }
  }
  return null;
}

const isLoopback = (host: string): boolean =>
  host === "localhost" ||
  host.endsWith(".localhost") ||
  host === "[::1]" ||
  /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);

const originOf = (req: Request): URL | null => {
  try {
    return new URL(req.headers.get("origin") ?? "");
  } catch {
    return null;
  }
};

// the browser's Origin, never the Host a proxy may rewrite to loopback: a
// browser keeps a Secure cookie over plain HTTP only on loopback
export function cookieAttributes(req: Request, path = "/"): string {
  const origin = originOf(req);
  const plain =
    origin !== null &&
    origin.protocol === "http:" &&
    isLoopback(origin.hostname);
  return `Path=${path}; HttpOnly; SameSite=Strict${plain ? "" : "; Secure"}`;
}

export const loginCookie = (req: Request, token: string): string =>
  `${COOKIE}=${token}; ${cookieAttributes(req)}; Max-Age=${SESSION_MS / 1000}`;

export const clearedCookie = (req: Request, name = COOKIE, path = "/") =>
  `${name}=; ${cookieAttributes(req, path)}; Max-Age=0`;

// the browser says where a request came from in Sec-Fetch-Site; an older one
// sends only Origin, whose host is compared with Host, the scheme left out
// since a TLS proxy hands the request on as http
export function sameOrigin(req: Request): boolean {
  const site = req.headers.get("sec-fetch-site");
  if (site !== null) return site === "same-origin";
  const origin = originOf(req);
  return origin !== null && origin.host === new URL(req.url).host;
}

type Raw = {
  id: string;
  user_id: string;
  admin_digest: string | null;
  expires_at: number;
  last_seen_at: number;
  name: string;
  role: Role;
  email: string | null;
};

export type Logins = {
  // the request's login, read anew each time; touched: its expiry moved,
  // so the answer sends the cookie again with a full Max-Age
  resolve(req: Request): { login: Login; touched: boolean } | null;
  // user-admin.key, compared as both sides hashed
  isAdminKey(sent: string): boolean;
  adminDigest: string | null;
};

const digest = (value: string): Buffer =>
  createHash("sha256").update(value).digest();

export function logins(deps: {
  db: Db;
  writer: Writer;
  // without one, no operator login opens anything
  adminKey: string | null;
  now: () => number;
  log: Log;
}): Logins {
  const want = deps.adminKey === null ? null : digest(deps.adminKey);
  const operator = deps.adminKey === null ? null : adminDigest(deps.adminKey);
  // when each login's touch was queued, so a burst queues one write
  const queued = new Map<string, number>();
  const find = deps.db.query<Raw, [string]>(
    `select l.id, l.user_id, l.admin_digest, l.expires_at, l.last_seen_at,
       u.name, u.role, u.email
     from logins l join users u on u.id = l.user_id where l.token_hash = ?`,
  );
  return {
    adminDigest: operator,
    isAdminKey: (sent) => want !== null && timingSafeEqual(digest(sent), want),
    resolve(req) {
      const token = cookieOf(req);
      if (token === null || token === "" || token.length > 128) return null;
      const r = find.get(sha256(token));
      const now = deps.now();
      if (r === null || r.expires_at <= now) return null;
      if (r.admin_digest !== null && r.admin_digest !== operator) return null;
      const last = Math.max(r.last_seen_at, queued.get(r.id) ?? 0);
      const touched = now - last >= TOUCH_MS;
      if (touched) {
        queued.set(r.id, now);
        if (queued.size > 10_000) queued.clear();
        void deps.writer
          .write((db) =>
            db
              .query(
                `update logins set last_seen_at = ?1, expires_at = ?2
                 where id = ?3 and last_seen_at <= ?1 - ?4`,
              )
              .run(now, now + SESSION_MS, r.id, TOUCH_MS),
          )
          .catch((error: unknown) => {
            deps.log.error("login touch failed", {
              login: r.id,
              ...errorFields(error),
            });
          });
      }
      return {
        login: {
          id: r.id,
          user: r.user_id,
          name: r.name,
          role: r.role,
          email: r.email,
          expiresAt: touched ? now + SESSION_MS : r.expires_at,
        },
        touched,
      };
    },
  };
}
