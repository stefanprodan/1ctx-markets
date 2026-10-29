// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// The web UI's sign-in: a cookie that holds an expiry and its HMAC, never a key.

import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { failed, readBody } from "../api/http.ts";
import { DAY_MS } from "../runtime/clock.ts";

export const COOKIE = "markets_session";
export const SESSION_MS = 30 * DAY_MS;
export const SESSION_PATH = "/ui/session";
// a key is at most 4,096 bytes (keys.ts), so the body is too
const MAX_BODY_BYTES = 8 * 1024;
const TOKEN = /^v1\.(\d{1,15})\.([A-Za-z0-9_-]{43})$/;

export type Sessions = {
  issue(now: number): string;
  valid(token: string | null, now: number): boolean;
  isKey(sent: string): boolean;
};

const digest = (value: string): Buffer =>
  createHash("sha256").update(value).digest();

// derived, so a cookie's MAC never doubles as anything the admin key signs;
// a new user-admin.key refuses every cookie made under the old one. Without an
// admin key nothing signs in, and the route still answers as for a wrong one
export function sessions(adminKey: string | null): Sessions {
  if (adminKey === null) {
    return { issue: () => "", valid: () => false, isKey: () => false };
  }
  const mac = createHmac("sha256", adminKey)
    .update("1ctx-markets web session")
    .digest();
  const sign = (expiry: number) =>
    createHmac("sha256", mac).update(`v1.${expiry}`).digest("base64url");
  const want = digest(adminKey);
  return {
    issue: (now) => {
      const expiry = now + SESSION_MS;
      return `v1.${expiry}.${sign(expiry)}`;
    },
    valid: (token, now) => {
      const m = token === null ? null : TOKEN.exec(token);
      if (m === null) return false;
      const expiry = Number(m[1]);
      const ok = timingSafeEqual(Buffer.from(sign(expiry)), Buffer.from(m[2]!));
      return ok && expiry > now;
    },
    isKey: (sent) => timingSafeEqual(digest(sent), want),
  };
}

export function cookieOf(req: Request): string | null {
  for (const part of (req.headers.get("cookie") ?? "").split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0 && part.slice(0, eq).trim() === COOKIE) {
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
export function cookieAttributes(req: Request): string {
  const origin = originOf(req);
  const plain =
    origin !== null &&
    origin.protocol === "http:" &&
    isLoopback(origin.hostname);
  return `Path=/; HttpOnly; SameSite=Strict${plain ? "" : "; Secure"}`;
}

// the browser says where a request came from in Sec-Fetch-Site; an older one
// sends only Origin, whose host is compared with Host, the scheme left out
// since a TLS proxy hands the request on as http
export function sameOrigin(req: Request): boolean {
  const site = req.headers.get("sec-fetch-site");
  if (site !== null) return site === "same-origin";
  const origin = originOf(req);
  return origin !== null && origin.host === new URL(req.url).host;
}

const NO_STORE = { "cache-control": "no-store" };

// the page faces the internet: every failed sign-in reads the same, so none
// tells a malformed body, a wrong key or a server without one apart
const refused = () =>
  failed({ error: "unauthorized", message: "wrong admin key" }, NO_STORE);

export async function sessionRoute(
  s: Sessions,
  req: Request,
  now: number,
): Promise<Response> {
  const attrs = cookieAttributes(req);
  if (req.method === "DELETE") {
    return new Response(null, {
      status: 204,
      headers: {
        ...NO_STORE,
        "set-cookie": `${COOKIE}=; ${attrs}; Max-Age=0`,
      },
    });
  }
  if (req.method !== "POST") {
    return failed(
      { error: "method_not_allowed", message: "use POST, DELETE" },
      { ...NO_STORE, allow: "POST, DELETE" },
    );
  }
  const read = await readBody(req, MAX_BODY_BYTES);
  const b = read instanceof Response ? null : read.body;
  const key =
    typeof b === "object" &&
    b !== null &&
    !Array.isArray(b) &&
    Object.keys(b).length === 1 &&
    typeof (b as { key?: unknown }).key === "string"
      ? (b as { key: string }).key.trim()
      : "";
  if (!s.isKey(key)) return refused();
  return new Response(null, {
    status: 204,
    headers: {
      ...NO_STORE,
      "set-cookie": `${COOKIE}=${s.issue(now)}; ${attrs}; Max-Age=${SESSION_MS / 1000}`,
    },
  });
}
