// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// The web UI's sign-in routes under /ui: the admin key, an emailed link and
// its code, who is signed in, and sign-out. The page faces the internet:
// an ask answers the same whoever was named, and a failed sign-in never
// says which half was wrong.

import { failed, json, NO_STORE } from "../api/http.ts";
import { loginWho, OPERATOR } from "../operations/who.ts";
import { MINUTE_MS } from "../runtime/clock.ts";
import type { Log } from "../runtime/log.ts";
import type { Db } from "../storage/db/index.ts";
import type { Writer } from "../storage/writer.ts";
import { asCaller, CallerGone, checkOf, recheck } from "./caller.ts";
import { type Email, emailOf } from "./email/settings.ts";
import { LINK_PATH, type Links, landingOf, SIGN_IN_MS } from "./links.ts";
import { RateLimit } from "./ratelimit.ts";
import {
  clearedCookie,
  cookieAttributes,
  cookieOf,
  type Login,
  type Logins,
  loginCookie,
  newToken,
  openLogin,
  SESSION_PATH,
  sameOrigin,
} from "./session.ts";

export const ME_PATH = "/ui/me";
export const CODE_PATH = "/ui/code";
// the asking browser's challenge, which a code is only tried beside
export const ASK_COOKIE = "markets_ask";
// asks, codes and links used, per client address
export const ASKS_PER_MINUTE = 10;
const MAX_NAME = 80;
// a key is at most 4,096 bytes (keys.ts), so the body is too
const MAX_BODY_BYTES = 8 * 1024;
const CHALLENGE = /^[A-Za-z0-9_-]{43}$/;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

export type UiDeps = {
  db: Db;
  writer: Writer;
  logins: Logins;
  links: Links;
  email: Email;
  now: () => number;
  log: Log;
};

const refused = () =>
  failed({ error: "unauthorized", message: "wrong admin key" }, NO_STORE);

const wrongCode = () =>
  failed({ error: "unauthorized", message: "wrong code" }, NO_STORE);

const notAllowed = (allow: string) =>
  failed(
    { error: "method_not_allowed", message: `use ${allow}` },
    { ...NO_STORE, allow },
  );

const foreign = () =>
  failed({
    error: "forbidden",
    message: "not sent from this server's pages",
  });

// the body's one object, from the page's fetch or a plain form; null for
// anything else
async function bodyOf(req: Request): Promise<Record<string, unknown> | null> {
  const length = Number(req.headers.get("content-length") ?? "0");
  if (!Number.isFinite(length) || length > MAX_BODY_BYTES) return null;
  const bytes = await req.arrayBuffer();
  if (bytes.byteLength > MAX_BODY_BYTES) return null;
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
  const type = req.headers.get("content-type") ?? "";
  if (/^application\/x-www-form-urlencoded(\s*;.*)?$/i.test(type)) {
    return Object.fromEntries(new URLSearchParams(text));
  }
  if (!/^application\/json(\s*;.*)?$/i.test(type)) return null;
  try {
    const b: unknown = JSON.parse(text);
    return typeof b === "object" && b !== null && !Array.isArray(b)
      ? (b as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

const isForm = (req: Request) =>
  /^application\/x-www-form-urlencoded/i.test(
    req.headers.get("content-type") ?? "",
  );

// plain, restyled later; the token in its address never leaves by a
// referrer, and the page runs no script
function page(status: number, body: string, headers = {}): Response {
  return new Response(
    `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>Sign in · 1ctx Markets</title>
</head>
<body>
<main>
<h1>1ctx Markets</h1>
${body}
</main>
</body>
</html>
`,
    {
      status,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
        "content-security-policy":
          "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
        ...headers,
      },
    },
  );
}

const livePage = () =>
  page(
    200,
    `<form method="post">
<button type="submit">Sign in</button>
</form>`,
  );

// a dead link reads as an unknown one
const deadPage = () =>
  page(
    404,
    `<p>This link no longer works.</p>
<form method="post" action="${LINK_PATH}">
<label>Email <input type="email" name="email" autocomplete="email" required></label>
<button type="submit">Email me a new link</button>
</form>`,
  );

const checkPage = (headers: Record<string, string>) =>
  page(
    202,
    `<p>Check your email.</p>
<p><a href="/">Enter the code</a></p>`,
    headers,
  );

export const meItem = (login: Login | null, emailOn: boolean) => ({
  user:
    login === null
      ? null
      : {
          id: login.user,
          name: login.name,
          role: login.role,
          email: login.email,
          operator: login.user === OPERATOR,
        },
  email_on: emailOn,
});

export type Ui = {
  // the answer for a /ui path, or null for any other path
  route(req: Request, path: string, ip: string): Promise<Response | null>;
};

export function ui(d: UiDeps): Ui {
  const rate = new RateLimit(ASKS_PER_MINUTE, MINUTE_MS);
  const limited = (ip: string): Response | null => {
    const now = d.now();
    if (rate.hit(ip, now)) return null;
    return failed(
      { error: "too_many_requests", message: "too many tries; wait a minute" },
      { ...NO_STORE, "retry-after": String(rate.retryAfter(ip, now)) },
    );
  };
  const current = (req: Request) => d.logins.resolve(req)?.login ?? null;
  const signedIn = (token: string, req: Request, location: string | null) =>
    new Response(null, {
      status: location === null ? 204 : 303,
      headers: {
        ...NO_STORE,
        ...(location === null ? {} : { location }),
        "set-cookie": loginCookie(req, token),
      },
    });
  const challengeOf = (req: Request): string | null => {
    const c = cookieOf(req, ASK_COOKIE);
    return c !== null && CHALLENGE.test(c) ? c : null;
  };
  // a browser that asked before keeps its challenge, so its earlier
  // link's code still works here
  const askCookie = (req: Request, challenge: string) =>
    `${ASK_COOKIE}=${challenge}; ${cookieAttributes(req, "/ui")}; Max-Age=${SIGN_IN_MS / 1000}`;

  async function session(req: Request): Promise<Response> {
    if (req.method === "DELETE") {
      const login = current(req);
      if (login !== null) {
        await d.writer.write((db) =>
          db.query("delete from logins where id = ?").run(login.id),
        );
        d.log.info("login ended", { user: login.user, login: login.id });
      }
      return new Response(null, {
        status: 204,
        headers: { ...NO_STORE, "set-cookie": clearedCookie(req) },
      });
    }
    if (req.method !== "POST") return notAllowed("POST, DELETE");
    const b = await bodyOf(req);
    const key =
      b !== null &&
      !isForm(req) &&
      Object.keys(b).length === 1 &&
      typeof b.key === "string"
        ? b.key.trim()
        : "";
    if (!d.logins.isAdminKey(key)) return refused();
    const old = current(req);
    const made = await d.writer.write((db) => {
      if (old !== null) {
        db.query("delete from logins where id = ?").run(old.id);
      }
      return openLogin(db, OPERATOR, d.now(), d.logins.adminDigest);
    });
    d.log.info("login made", { user: OPERATOR, login: made.id });
    return signedIn(made.token, req, null);
  }

  async function me(req: Request): Promise<Response> {
    if (req.method === "GET") {
      return json(meItem(current(req), d.email.on(d.db)));
    }
    if (req.method !== "PATCH") return notAllowed("GET, PATCH");
    const login = current(req);
    if (login === null) {
      return failed({ error: "unauthorized", message: "signed out" });
    }
    if (!sameOrigin(req)) return foreign();
    const b = await bodyOf(req);
    if (b === null || isForm(req)) {
      return failed({ error: "bad_arguments", message: "the body is JSON" });
    }
    const keys = Object.keys(b);
    const unknown = keys.find((k) => k !== "name" && k !== "email");
    if (unknown !== undefined || keys.length !== 1) {
      return failed({
        error: "bad_arguments",
        message: "give name or email, one at a time",
      });
    }
    const who = loginWho(login.user, login.id, login.name);
    const check = checkOf(who, {
      adminDigest: d.logins.adminDigest,
      now: d.now,
    });
    try {
      if (b.name !== undefined) {
        const name = typeof b.name === "string" ? b.name.trim() : "";
        if (name === "" || name.length > MAX_NAME || /[\p{Cc}]/u.test(name)) {
          return failed({
            error: "bad_arguments",
            message: `name is 1 to ${MAX_NAME} characters on one line`,
          });
        }
        await asCaller(check, () =>
          d.writer.write((db) => {
            recheck(db);
            db.query("update users set name = ? where id = ?").run(
              name,
              login.user,
            );
          }),
        );
        d.log.info("user changed", { user: login.user });
        return json(meItem({ ...login, name }, d.email.on(d.db)));
      }
      // the operator signs in by the admin key; an address lets them sign in
      // by link too, set only once a link to it is used
      if (login.user !== OPERATOR) {
        return failed({
          error: "forbidden",
          message: "an admin changes a person's email",
        });
      }
      const email = emailOf(b.email);
      if (email === null) {
        return failed({
          error: "bad_arguments",
          message: "email is an email address",
        });
      }
      const taken = d.db
        .query<{ id: string }, [string, string]>(
          "select id from users where email = ? and id <> ?",
        )
        .get(email, login.user);
      if (taken !== null) {
        return failed({
          error: "conflict",
          message: "another person has this email",
        });
      }
      const sent = await asCaller(check, () =>
        d.links.confirm(login.user, email),
      );
      if (sent === null) {
        return failed({ error: "conflict", message: "email is not set up" });
      }
      return json(
        sent.sent ? { link: "sent" } : { link: "failed", reason: sent.failure },
      );
    } catch (error) {
      if (error instanceof CallerGone) {
        return failed({
          error: error.status === 401 ? "unauthorized" : "forbidden",
          message: error.message,
        });
      }
      throw error;
    }
  }

  // 202 before any lookup, the same whoever was named; the work runs after
  async function ask(req: Request, ip: string): Promise<Response> {
    if (req.method !== "POST") return notAllowed("POST");
    if (!d.email.on(d.db)) {
      return failed({ error: "not_found", message: "no such route" });
    }
    if (!sameOrigin(req)) return foreign();
    const over = limited(ip);
    if (over !== null) return over;
    const b = await bodyOf(req);
    const email = b === null ? null : emailOf(b.email);
    if (email === null || Object.keys(b!).length !== 1) {
      return failed({
        error: "bad_arguments",
        message: "email is an email address",
      });
    }
    const challenge = challengeOf(req) ?? newToken();
    d.links.ask(email, challenge);
    const headers = { ...NO_STORE, "set-cookie": askCookie(req, challenge) };
    return isForm(req)
      ? checkPage(headers)
      : new Response(null, { status: 202, headers });
  }

  async function code(req: Request, ip: string): Promise<Response> {
    if (req.method !== "POST") return notAllowed("POST");
    if (!sameOrigin(req)) return foreign();
    const over = limited(ip);
    if (over !== null) return over;
    const b = await bodyOf(req);
    const email = b === null || isForm(req) ? null : emailOf(b.email);
    const typed = typeof b?.code === "string" ? b.code.trim() : "";
    if (email === null || Object.keys(b!).length !== 2) return wrongCode();
    const used = await d.links.useCode(
      email,
      typed,
      challengeOf(req),
      current(req)?.id ?? null,
    );
    if (used === null || used.token === null) return wrongCode();
    return json({ landing: landingOf(used.purpose) }, 200, {
      ...NO_STORE,
      "set-cookie": loginCookie(req, used.token),
    });
  }

  async function link(req: Request, token: string, ip: string) {
    const known = TOKEN.test(token);
    if (req.method === "GET" || req.method === "HEAD") {
      // a GET never acts: mail scanners open links
      return known && d.links.live(token) !== null ? livePage() : deadPage();
    }
    if (req.method !== "POST") return notAllowed("GET, POST");
    if (!sameOrigin(req)) return foreign();
    const over = limited(ip);
    if (over !== null) return over;
    const signed = current(req);
    const used = known
      ? await d.links.useLink(
          token,
          signed === null ? null : { id: signed.id, user: signed.user },
        )
      : null;
    if (used === null) return deadPage();
    // a link that set an address opened no login: the browser keeps its own
    if (used.token === null) {
      return new Response(null, {
        status: 303,
        headers: { ...NO_STORE, location: "/" },
      });
    }
    return signedIn(used.token, req, landingOf(used.purpose));
  }

  return {
    async route(req, path, ip) {
      if (path === SESSION_PATH) return session(req);
      if (path === ME_PATH) return me(req);
      if (path === LINK_PATH) return ask(req, ip);
      if (path === CODE_PATH) return code(req, ip);
      if (path.startsWith(`${LINK_PATH}/`)) {
        return link(req, path.slice(LINK_PATH.length + 1), ip);
      }
      return null;
    },
  };
}
