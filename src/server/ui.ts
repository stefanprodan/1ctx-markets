// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// The web UI's sign-in routes under /ui: the admin key, an emailed link and
// its code, passkeys, who is signed in, and sign-out. The page faces the
// internet: an ask answers the same whoever was named, and a failed
// sign-in never says which half was wrong.

import { failed, json, NO_STORE } from "../api/http.ts";
import { loginWho, OPERATOR } from "../operations/who.ts";
import { fromB64url, PUBLIC_KEY_BYTES, toB64url } from "../push/crypto.ts";
import { NO_PUSH, type Push } from "../push/send.ts";
import {
  loginEndpoints,
  removeSubscription,
  saveSubscription,
} from "../push/store.ts";
import { MINUTE_MS } from "../runtime/clock.ts";
import type { Log } from "../runtime/log.ts";
import { SPARKLE, WORD } from "../shared/marks.ts";
import type { Db } from "../storage/db/index.ts";
import type { Writer } from "../storage/writer.ts";
import { asCaller, CallerGone, checkOf, recheck } from "./caller.ts";
import { type Email, emailOf } from "./email/settings.ts";
import {
  LINK_PATH,
  type Links,
  landingOf,
  type Purpose,
  SIGN_IN_MS,
} from "./links.ts";
import {
  ALGS,
  assertionOf,
  checkAssertion,
  checkRegistration,
  type Reason,
  registrationOf,
} from "./passkeys/checks.ts";
import { providerOf } from "./passkeys/provider.ts";
import {
  CHALLENGE_MS,
  countPasskeys,
  findPasskey,
  insertPasskey,
  newChallenge,
  PASSKEYS_PER_USER,
  type Passkey,
  passkeyItem,
  removePasskey,
  takeChallenge,
  usePasskey,
  userPasskeys,
} from "./passkeys/store.ts";
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
  relyingParty,
  SESSION_PATH,
  sameOrigin,
} from "./session.ts";

export const ME_PATH = "/ui/me";
export const CODE_PATH = "/ui/code";
export const PUSH_PATH = "/ui/push";
export const PASSKEYS_PATH = "/ui/passkeys";
export const PASSKEY_OPTIONS_PATH = "/ui/passkeys/options";
export const PASSKEY_SIGN_IN_PATH = "/ui/passkeys/sign-in";
export const PASSKEY_SIGN_IN_OPTIONS_PATH = "/ui/passkeys/sign-in/options";
// the name the browser shows beside a passkey
const RP_NAME = "1ctx Markets";
// one browser holds one subscription; a few cover a reinstall
export const PUSH_PER_LOGIN = 5;
const MAX_ENDPOINT = 2048;
// the browsers' own push services, so a login never points the server's
// posts at another host
const PUSH_HOSTS = [
  "push.apple.com",
  "googleapis.com",
  "push.services.mozilla.com",
  "notify.windows.com",
];
// the asking browser's challenge, which a code is only tried beside
export const ASK_COOKIE = "markets_ask";
// asks, codes and links used, per client address
export const ASKS_PER_MINUTE = 10;
// the sign-in page fetches options on every view and keeps them fresh, so
// they have their own window and never spend the one codes share
export const OPTIONS_PER_MINUTE = 60;
const MAX_NAME = 80;
// a key is at most 4,096 bytes (keys.ts), so the body is too
const MAX_BODY_BYTES = 8 * 1024;
// a credential id may be 1,023 bytes, and an answer carries it four times
const PASSKEY_BODY_BYTES = 16 * 1024;
const PASSKEY_ID = /^[a-z0-9]{1,40}$/;
const CHALLENGE = /^[A-Za-z0-9_-]{43}$/;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

export type UiDeps = {
  db: Db;
  writer: Writer;
  logins: Logins;
  links: Links;
  email: Email;
  // none keeps push off
  push?: Push;
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

const noParty = () =>
  failed({
    error: "forbidden",
    message: "passkeys need an https origin or localhost",
  });

// every failed passkey sign-in, whatever failed
const passkeyRefused = () =>
  failed({ error: "unauthorized", message: "passkey not accepted" }, NO_STORE);

// a passkey with no row here: the code lets the page ask the browser to
// forget it; it says only whether a credential id is held, never whose
const unknownPasskey = () =>
  failed(
    {
      error: "unauthorized",
      code: "unknown_passkey",
      message: "passkey not accepted",
    },
    NO_STORE,
  );

const badPasskey = () =>
  failed(
    { error: "bad_arguments", message: "the passkey did not check out" },
    NO_STORE,
  );

const fullPasskeys = () =>
  failed({
    error: "conflict",
    message: `at most ${PASSKEYS_PER_USER} passkeys a person`,
  });

// an emailed sign-in lands with the flag that asks for a passkey
const offered = (purpose: Purpose) => `${landingOf(purpose)}?signed_in=1`;

// the body's one object, from the page's fetch or a plain form; null for
// anything else
async function bodyOf(
  req: Request,
  max = MAX_BODY_BYTES,
): Promise<Record<string, unknown> | null> {
  const length = Number(req.headers.get("content-length") ?? "0");
  if (!Number.isFinite(length) || length > max) return null;
  const bytes = await req.arrayBuffer();
  if (bytes.byteLength > max) return null;
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

// the sign-in page's look: its colours copied from the web UI's tokens,
// since this page loads nothing (no script, font or stylesheet), light
// or dark as the system is
const STYLE = `:root{color-scheme:dark;--page:#131314;--card:#1e1f20;--inset:#0f1216;--line:#2a2b2d;--line-strong:#35363a;--hover:#2a2b2d;--fg:#e7e7e9;--faint:#8b8b91;--sparkle:#f2c14e}
@media (prefers-color-scheme:light){:root{color-scheme:light;--page:#f4f2ec;--card:#fbfaf7;--inset:#eeece5;--line:#dfdcd3;--line-strong:#cfccc2;--hover:#e6e3da;--fg:#1a1a1c;--faint:#6f6e75;--sparkle:#d9a53a}}
html,body{height:100%}
body{margin:0;background:var(--page);color:var(--fg);font:13px/1.5 "IBM Plex Sans","Helvetica Neue",Arial,sans-serif;-webkit-font-smoothing:antialiased}
main{box-sizing:border-box;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:32px;min-height:100%;padding:16px}
.brand{display:flex;align-items:center;gap:16px}
.name{display:flex;flex-direction:column;gap:6px}
.name p{margin:0;font-size:28px;font-weight:500;line-height:1}
.card{box-sizing:border-box;width:340px;max-width:100%;padding:24px;border:1px solid var(--line);border-radius:10px;background:var(--card)}
.card p{margin:0 0 16px}
.card p:last-child{margin-bottom:0}
form{display:flex;flex-direction:column;gap:16px;margin:0}
label{display:flex;flex-direction:column;gap:6px;color:var(--faint);font-size:12px}
input{box-sizing:border-box;height:36px;padding:0 12px;border:1px solid var(--line);border-radius:6px;background:var(--inset);color:var(--fg);font:inherit;font-size:14px}
button{width:100%;height:36px;border:1px solid var(--line-strong);border-radius:6px;background:var(--hover);color:var(--fg);font:inherit;font-weight:500;cursor:pointer}
a{color:var(--fg)}`;

const MARK = `<svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" role="img" aria-label="Markets"><path d="M13.5 4H11C6.757 4 4.636 4 3.318 5.318S2 8.758 2 13s0 6.364 1.318 7.682S6.758 22 11 22s6.364 0 7.682-1.318S20 17.242 20 13v-2.5"/><path d="M5.5 17 9.25 12.75 12.25 14.75 16.5 9"/><path fill="var(--sparkle)" stroke="none" d="${SPARKLE}"/></svg>`;

const WORDMARK = `<svg width="78" height="26" viewBox="3.5 -35.2 107.5 35.7" role="img" aria-label="1ctx"><path fill="currentColor" d="${WORD}"/></svg>`;

// the sign-in page's look; the token in its address never leaves by a
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
<style>${STYLE}</style>
</head>
<body>
<main>
<div class="brand">${MARK}<div class="name">${WORDMARK}<p>Markets</p></div></div>
<div class="card">
${body}
</div>
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
<label>Email<input type="email" name="email" autocomplete="email" required></label>
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

// a push service's https URL, or null
export function pushEndpoint(value: unknown): string | null {
  if (typeof value !== "string" || value.length > MAX_ENDPOINT) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "")
    return null;
  if (url.port !== "") return null;
  const host = url.hostname;
  return PUSH_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))
    ? url.href
    : null;
}

const keyOf = (value: unknown, bytes: number): string | null => {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+=*$/.test(value)) {
    return null;
  }
  const raw = fromB64url(value);
  if (raw.length !== bytes) return null;
  if (bytes === PUBLIC_KEY_BYTES && raw[0] !== 4) return null;
  return value.replace(/=+$/, "");
};

export type Ui = {
  // the answer for a /ui path, or null for any other path
  route(req: Request, path: string, ip: string): Promise<Response | null>;
};

export function ui(d: UiDeps): Ui {
  const rate = new RateLimit(ASKS_PER_MINUTE, MINUTE_MS);
  const optionsRate = new RateLimit(OPTIONS_PER_MINUTE, MINUTE_MS);
  const limited = (ip: string, r = rate): Response | null => {
    const now = d.now();
    if (r.hit(ip, now)) return null;
    return failed(
      { error: "too_many_requests", message: "too many tries; wait a minute" },
      { ...NO_STORE, "retry-after": String(r.retryAfter(ip, now)) },
    );
  };
  const current = (req: Request) => d.logins.resolve(req)?.login ?? null;
  const pushes = d.push ?? NO_PUSH;
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

  // the routes a login holds for itself: never a key's
  const ownLogin = (req: Request): Login | Response => {
    if (req.headers.has("authorization")) {
      return failed({
        error: "forbidden",
        message: "this key does not open this route",
      });
    }
    return (
      current(req) ?? failed({ error: "unauthorized", message: "signed out" })
    );
  };

  const checkFor = (login: Login) =>
    checkOf(loginWho(login.user, login.id, login.name), {
      adminDigest: d.logins.adminDigest,
      now: d.now,
    });

  const gone = (error: unknown): Response => {
    if (error instanceof CallerGone) {
      return failed({
        error: error.status === 401 ? "unauthorized" : "forbidden",
        message: error.message,
      });
    }
    throw error;
  };

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
    const check = checkFor(login);
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
      return gone(error);
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
    return json({ landing: offered(used.purpose) }, 200, {
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
    return signedIn(used.token, req, offered(used.purpose));
  }

  // a device's subscription: the login's own, from this server's pages
  async function pushRoute(req: Request): Promise<Response> {
    if (
      req.method !== "GET" &&
      req.method !== "POST" &&
      req.method !== "DELETE"
    )
      return notAllowed("GET, POST, DELETE");
    const login = ownLogin(req);
    if (login instanceof Response) return login;
    const key = pushes.publicKey(d.db);
    if (req.method === "GET") {
      return json(
        { key, endpoints: key === null ? [] : loginEndpoints(d.db, login.id) },
        200,
        NO_STORE,
      );
    }
    if (!sameOrigin(req)) return foreign();
    if (key === null) {
      return failed({ error: "not_found", message: "push is off" });
    }
    const b = await bodyOf(req);
    if (b === null || isForm(req)) {
      return failed({ error: "bad_arguments", message: "the body is JSON" });
    }
    const endpoint = pushEndpoint(b.endpoint);
    if (endpoint === null) {
      return failed({
        error: "bad_arguments",
        message: "endpoint is a push service's https URL",
      });
    }
    if (req.method === "DELETE") {
      await d.writer.write((db) => removeSubscription(db, login.id, endpoint));
      return new Response(null, { status: 204, headers: NO_STORE });
    }
    const keys = b.keys as Record<string, unknown> | null | undefined;
    const p256dh = keyOf(keys?.p256dh, PUBLIC_KEY_BYTES);
    const auth = keyOf(keys?.auth, 16);
    if (p256dh === null || auth === null) {
      return failed({
        error: "bad_arguments",
        message: "keys holds p256dh and auth as the browser gives them",
      });
    }
    const saved = await d.writer.write((db) => {
      const held = loginEndpoints(db, login.id);
      if (!held.includes(endpoint) && held.length >= PUSH_PER_LOGIN) {
        return false;
      }
      saveSubscription(
        db,
        login.user,
        login.id,
        { endpoint, p256dh, auth },
        d.now(),
      );
      return true;
    });
    if (!saved) {
      return failed({
        error: "conflict",
        message: `at most ${PUSH_PER_LOGIN} devices a sign-in`,
      });
    }
    d.log.info("push subscribed", { user: login.user, login: login.id });
    return new Response(null, { status: 204, headers: NO_STORE });
  }

  const refusedPasskey = (reason: Reason) => {
    d.log.info("passkey refused", { reason });
  };

  // the person's passkeys at every origin, so none added elsewhere hides
  async function passkeysRoute(req: Request): Promise<Response> {
    if (req.method !== "GET") return notAllowed("GET, POST");
    const login = ownLogin(req);
    if (login instanceof Response) return login;
    return json(
      { passkeys: userPasskeys(d.db, login.user).map(passkeyItem) },
      200,
      NO_STORE,
    );
  }

  async function removePasskeyRoute(
    req: Request,
    id: string,
  ): Promise<Response> {
    if (req.method !== "DELETE") return notAllowed("DELETE");
    const login = ownLogin(req);
    if (login instanceof Response) return login;
    if (!sameOrigin(req)) return foreign();
    let removed = false;
    if (PASSKEY_ID.test(id)) {
      try {
        removed = await asCaller(checkFor(login), () =>
          d.writer.write((db) => {
            // a sign-out landing while the delete waits removes nothing
            recheck(db);
            return removePasskey(db, login.user, id);
          }),
        );
      } catch (error) {
        return gone(error);
      }
    }
    if (!removed) {
      return failed({ error: "not_found", message: "no such passkey" });
    }
    d.log.info("passkey removed", { user: login.user, passkey: id });
    return new Response(null, { status: 204, headers: NO_STORE });
  }

  // the browser's create() options, as PublicKeyCredentialCreationOptionsJSON
  async function addOptions(req: Request, ip: string): Promise<Response> {
    if (req.method !== "POST") return notAllowed("POST");
    const login = ownLogin(req);
    if (login instanceof Response) return login;
    if (!sameOrigin(req)) return foreign();
    const party = relyingParty(req);
    if (party === null) return noParty();
    const over = limited(ip, optionsRate);
    if (over !== null) return over;
    let made: { challenge: string; own: Passkey[] } | null;
    try {
      made = await asCaller(checkFor(login), () =>
        d.writer.write((db) => {
          recheck(db);
          const held = userPasskeys(db, login.user);
          if (held.length >= PASSKEYS_PER_USER) return null;
          const challenge = newChallenge(
            db,
            {
              purpose: "add",
              rpId: party.rpId,
              origin: party.origin,
              login: login.id,
            },
            d.now(),
          );
          // the keychain keys a passkey by host and user, so one of
          // another port of this host would be replaced
          return {
            challenge,
            own: held.filter((p) => p.rpId === party.rpId),
          };
        }),
      );
    } catch (error) {
      return gone(error);
    }
    if (made === null) return fullPasskeys();
    return json(
      {
        challenge: made.challenge,
        rp: { id: party.rpId, name: RP_NAME },
        user: {
          id: toB64url(new TextEncoder().encode(login.user)),
          name: login.email ?? login.name,
          displayName: login.name,
        },
        pubKeyCredParams: ALGS.map((alg) => ({ type: "public-key", alg })),
        timeout: CHALLENGE_MS,
        attestation: "none",
        authenticatorSelection: {
          residentKey: "required",
          requireResidentKey: true,
          userVerification: "required",
        },
        excludeCredentials: made.own.map((p) => ({
          type: "public-key",
          id: p.credentialId,
          transports: p.transports,
        })),
      },
      200,
      NO_STORE,
    );
  }

  async function addPasskey(req: Request, ip: string): Promise<Response> {
    const login = ownLogin(req);
    if (login instanceof Response) return login;
    if (!sameOrigin(req)) return foreign();
    const party = relyingParty(req);
    if (party === null) return noParty();
    const over = limited(ip);
    if (over !== null) return over;
    const b = await bodyOf(req, PASSKEY_BODY_BYTES);
    const sent = b === null || isForm(req) ? null : registrationOf(b);
    if (sent === null) {
      refusedPasskey("body");
      return badPasskey();
    }
    const checked = await checkRegistration(sent, {
      type: "webauthn.create",
      origin: party.origin,
      rpId: party.rpId,
    });
    if ("refused" in checked) {
      refusedPasskey(checked.refused);
      return badPasskey();
    }
    const device = providerOf(checked.aaguid);
    let added: ReturnType<typeof insertPasskey> | "challenge" | "full";
    try {
      added = await asCaller(checkFor(login), () =>
        d.writer.write((db) => {
          // an answer landing after a sign-out everywhere adds nothing
          recheck(db);
          // the clock of the write, so a queued answer expires on time
          const now = d.now();
          const scope = {
            purpose: "add" as const,
            rpId: party.rpId,
            origin: party.origin,
            login: login.id,
          };
          if (!takeChallenge(db, checked.challenge, scope, now)) {
            return "challenge";
          }
          if (countPasskeys(db, login.user) >= PASSKEYS_PER_USER) {
            return "full";
          }
          // the passkey keeps the trust of the login that added it
          const digest =
            db
              .query<{ admin_digest: string | null }, [string]>(
                "select admin_digest from logins where id = ?",
              )
              .get(login.id)?.admin_digest ?? null;
          return insertPasskey(
            db,
            {
              user: login.user,
              rpId: party.rpId,
              origin: party.origin,
              credentialId: checked.credentialId,
              publicKey: checked.publicKey,
              alg: checked.alg,
              signCount: checked.signCount,
              transports: checked.transports,
              device,
              adminDigest: digest,
            },
            now,
          );
        }),
      );
    } catch (error) {
      return gone(error);
    }
    if (added === "challenge") {
      refusedPasskey("challenge");
      return badPasskey();
    }
    if (added === "full") return fullPasskeys();
    if (added === null) {
      return failed({
        error: "conflict",
        message: "this passkey is already added",
      });
    }
    d.log.info("passkey added", {
      user: login.user,
      passkey: added.id,
      login: login.id,
    });
    d.links.passkeyAdded(login.user, device, added.createdAt);
    return json(passkeyItem(added), 201, NO_STORE);
  }

  // the browser's get() options, as PublicKeyCredentialRequestOptionsJSON;
  // discoverable, so no person is named before the tap
  async function signInOptions(req: Request, ip: string): Promise<Response> {
    if (req.method !== "POST") return notAllowed("POST");
    if (!sameOrigin(req)) return foreign();
    const party = relyingParty(req);
    if (party === null) return noParty();
    const over = limited(ip, optionsRate);
    if (over !== null) return over;
    const challenge = await d.writer.write((db) =>
      newChallenge(
        db,
        {
          purpose: "sign_in",
          rpId: party.rpId,
          origin: party.origin,
          login: null,
        },
        d.now(),
      ),
    );
    return json(
      {
        challenge,
        rpId: party.rpId,
        timeout: CHALLENGE_MS,
        userVerification: "required",
        allowCredentials: [],
      },
      200,
      NO_STORE,
    );
  }

  async function signInByPasskey(req: Request, ip: string): Promise<Response> {
    if (req.method !== "POST") return notAllowed("POST");
    if (!sameOrigin(req)) return foreign();
    const party = relyingParty(req);
    if (party === null) return noParty();
    const over = limited(ip);
    if (over !== null) return over;
    const b = await bodyOf(req, PASSKEY_BODY_BYTES);
    const sent = b === null || isForm(req) ? null : assertionOf(b);
    if (sent === null) {
      refusedPasskey("body");
      return passkeyRefused();
    }
    const passkey = findPasskey(d.db, sent.id);
    // bound to the origin it was added at, so another port of the host
    // never signs in with it
    if (passkey === null) {
      refusedPasskey("credential");
      return unknownPasskey();
    }
    // held, at another address: never one the browser should forget
    if (passkey.rpId !== party.rpId || passkey.origin !== party.origin) {
      refusedPasskey("credential");
      return passkeyRefused();
    }
    // a passkey added under an older user-admin.key, before the prune
    if (
      passkey.adminDigest !== null &&
      passkey.adminDigest !== d.logins.adminDigest
    ) {
      refusedPasskey("admin_key");
      return passkeyRefused();
    }
    const checked = await checkAssertion(
      sent,
      { type: "webauthn.get", origin: party.origin, rpId: party.rpId },
      passkey,
    );
    if ("refused" in checked) {
      refusedPasskey(checked.refused);
      return passkeyRefused();
    }
    const old = current(req);
    const made = await d.writer.write((db) => {
      const now = d.now();
      const scope = {
        purpose: "sign_in" as const,
        rpId: party.rpId,
        origin: party.origin,
        login: null,
      };
      if (!takeChallenge(db, checked.challenge, scope, now)) {
        return "challenge" as const;
      }
      // another answer of this passkey moved its count since the checks
      if (
        !usePasskey(db, passkey.id, passkey.signCount, checked.signCount, now)
      ) {
        return "count" as const;
      }
      if (old !== null) {
        db.query("delete from logins where id = ?").run(old.id);
      }
      return openLogin(db, passkey.user, now, passkey.adminDigest);
    });
    if (typeof made === "string") {
      refusedPasskey(made);
      return passkeyRefused();
    }
    d.log.info("passkey used", {
      user: passkey.user,
      passkey: passkey.id,
      login: made.id,
    });
    return json({ landing: "/" }, 200, {
      ...NO_STORE,
      "set-cookie": loginCookie(req, made.token),
    });
  }

  // the path is /ui/passkeys or under it
  async function passkeyRoute(
    req: Request,
    path: string,
    ip: string,
  ): Promise<Response> {
    if (path === PASSKEYS_PATH) {
      return req.method === "POST" ? addPasskey(req, ip) : passkeysRoute(req);
    }
    if (path === PASSKEY_OPTIONS_PATH) return addOptions(req, ip);
    if (path === PASSKEY_SIGN_IN_OPTIONS_PATH) return signInOptions(req, ip);
    if (path === PASSKEY_SIGN_IN_PATH) return signInByPasskey(req, ip);
    return removePasskeyRoute(req, path.slice(PASSKEYS_PATH.length + 1));
  }

  return {
    async route(req, path, ip) {
      if (path === PASSKEYS_PATH || path.startsWith(`${PASSKEYS_PATH}/`)) {
        return passkeyRoute(req, path, ip);
      }
      if (path === SESSION_PATH) return session(req);
      if (path === PUSH_PATH) return pushRoute(req);
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
