// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// People signed in by an emailed link: the links and their codes, the
// caps, the SMTP settings, the users routes and the credential re-read
// inside a write. The SMTP sender is a fake that records each message;
// people, addresses and the password are made up.

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AdminError } from "../src/admin/cli.ts";
import { runKeys } from "../src/admin/keys-cli.ts";
import { runUsers } from "../src/admin/users-cli.ts";
import { PREFIX } from "../src/api/http.ts";
import type { Markets } from "../src/operations/markets.ts";
import { createPortfolio, saveSettings } from "../src/operations/portfolio.ts";
import { loginWho, OPERATOR, type Who } from "../src/operations/who.ts";
import { MINUTE_MS } from "../src/runtime/clock.ts";
import { configToArgs, parseCli } from "../src/runtime/config.ts";
import { keys } from "../src/runtime/keys.ts";
import { logger } from "../src/runtime/log.ts";
import { createKey } from "../src/server/access.ts";
import { asCaller, checkOf } from "../src/server/caller.ts";
import {
  type Failure,
  failureOf,
  type Outgoing,
  type SendResult,
  type SmtpServer,
  smtpSender,
} from "../src/server/email/smtp.ts";
import { clientIp, loggedPath } from "../src/server/http.ts";
import {
  ASKS_PER_CHALLENGE_HOUR,
  ASKS_PER_HOUR,
  ASKS_PER_USER_DAY,
  MAX_CODE_TRIES,
  SEND_DEADLINE_MS,
  SIGN_IN_MS,
} from "../src/server/links.ts";
import { COOKIE, openLogin, pruneLogins } from "../src/server/session.ts";
import { ASK_COOKIE, ASKS_PER_MINUTE } from "../src/server/ui.ts";
import { isIsin } from "../src/shared/isin.ts";
import { type Db, migrate } from "../src/storage/db/index.ts";
import { MIGRATIONS } from "../src/storage/db/migrations/index.ts";
import { ADMIN_KEY, api, cookieFor, READ_KEY } from "./helpers/api.ts";
import { SECRETS, withApp } from "./helpers/app.ts";
import { fakeClock } from "./helpers/clock.ts";
import { instrument, NOW, quote, world } from "./helpers/world.ts";

const HOST = "http://markets.test";
const PASSWORD = "made-up-smtp-password-0123456789";
const SMTP = {
  host: "smtp.example.com",
  port: 465,
  security: "tls",
  username: "markets@example.com",
  key_name: "email-test",
  from: "markets@example.com",
  public_url: "https://markets.example.com",
};
const ANA = "ana@example.com";

// a secrets directory of its own, the password in it unless left out
function secretsDir(password = true): string {
  const dir = join(mkdtempSync(join(tmpdir(), "markets-people-")), "secrets");
  mkdirSync(dir, { mode: 0o700 });
  if (password) writeFileSync(join(dir, "email-test.key"), PASSWORD);
  return dir;
}

type Sent = { server: SmtpServer; message: Outgoing };

function people(options: { password?: boolean; smtp?: boolean } = {}) {
  const w = world();
  const dir = secretsDir(options.password !== false);
  const store = keys(dir);
  const lines: string[] = [];
  const sent: Sent[] = [];
  let result: SendResult = { ok: true };
  // a send held until let go, as a slow mail server holds it
  let held: { arrived: () => void; release: Promise<void> } | null = null;
  const log = logger(w.clock, store.values, (line) => lines.push(line));
  const handle = api(
    { ...w.m, log: log("admin") },
    {
      secrets: store,
      sender: async (server, message) => {
        sent.push({ server, message });
        if (held !== null) {
          held.arrived();
          await held.release;
        }
        return result;
      },
      log: log("access"),
    },
  );
  const at = (path: string, init: RequestInit = {}, ip?: string) =>
    handle(new Request(`${HOST}${path}`, init), ip);
  const admin = { authorization: `Bearer ${ADMIN_KEY}` };
  const jsonBody = (method: string, body: unknown, headers = {}) => ({
    method,
    headers: {
      "content-type": "application/json",
      "sec-fetch-site": "same-origin",
      ...headers,
    },
    body: JSON.stringify(body),
  });
  const t = {
    ...w,
    dir,
    lines,
    sent,
    handle,
    at,
    admin,
    jsonBody,
    fail(r: SendResult) {
      result = r;
    },
    // the next sends wait for release(); arrived once one is waiting
    hold() {
      const arrived = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      held = { arrived: () => arrived.resolve(), release: release.promise };
      return {
        arrived: arrived.promise,
        release: () => {
          held = null;
          release.resolve();
        },
      };
    },
    // the server's answers are in; an ask's work after its answer too
    settled: () => handle.links.settled(),
    async smtp(body: unknown = SMTP) {
      return at(`${PREFIX}/smtp`, jsonBody("PUT", body, admin));
    },
    // a person added directly, with an address
    person(id: string, email: string, role = "member") {
      w.db
        .query(
          "insert into users (id, name, email, role, created_at) values (?, ?, ?, ?, 0)",
        )
        .run(id, `Person ${id}`, email, role);
    },
    // an ask as the sign-in page sends it; the challenge cookie it set
    async ask(email: string, challenge: string | null = null, ip?: string) {
      const res = await at(
        "/ui/link",
        jsonBody(
          "POST",
          { email },
          challenge === null ? {} : { cookie: `${ASK_COOKIE}=${challenge}` },
        ),
        ip,
      );
      await t.settled();
      const set = res.headers.get("set-cookie") ?? "";
      const m = new RegExp(`${ASK_COOKIE}=([^;]+)`).exec(set);
      return { res, challenge: m?.[1] ?? null };
    },
    // the link's token and the code of the newest email to an address
    mailTo(address: string) {
      const m = [...sent]
        .reverse()
        .find((s) => s.message.to.address === address);
      if (m === undefined) return null;
      const token = /\/ui\/link\/([A-Za-z0-9_-]{43})/.exec(m.message.text)![1]!;
      const code = /enter (\d{6})/.exec(m.message.text)?.[1] ?? "";
      return { token, code, message: m.message, server: m.server };
    },
    use(token: string, headers: Record<string, string> = {}) {
      return at(`/ui/link/${token}`, {
        method: "POST",
        headers: { "sec-fetch-site": "same-origin", ...headers },
      });
    },
    code(email: string, code: string, challenge: string | null, ip?: string) {
      return at(
        "/ui/code",
        jsonBody(
          "POST",
          { email, code },
          challenge === null ? {} : { cookie: `${ASK_COOKIE}=${challenge}` },
        ),
        ip,
      );
    },
  };
  if (options.smtp !== false) {
    w.db
      .query(
        `insert into smtp_settings (id, host, port, security, username,
           key_name, from_address, public_url, updated_at, updated_by)
         values (1, ?, ?, ?, ?, ?, ?, ?, 0, 'operator')`,
      )
      .run(
        SMTP.host,
        SMTP.port,
        SMTP.security,
        SMTP.username,
        SMTP.key_name,
        SMTP.from,
        SMTP.public_url,
      );
  }
  return t;
}

type People = ReturnType<typeof people>;

// a portfolio of the person's own, once they have a display currency
async function shares(m: Markets, owner: string) {
  await saveSettings(m, owner, { display_currency: "EUR" });
  return createPortfolio(m, owner, { name: "Shares" });
}

// the cookie a signed-in answer set
const loginOf = (res: Response): string => {
  const set = res.headers.get("set-cookie") ?? "";
  const m = new RegExp(`${COOKIE}=([^;]*)`).exec(set);
  return `${COOKIE}=${m?.[1] ?? ""}`;
};

const me = async (t: People, cookie: string) =>
  (await (await t.at("/ui/me", { headers: { cookie } })).json()) as {
    user: {
      id: string;
      name: string;
      role: string;
      email: string | null;
      operator: boolean;
    } | null;
    email_on: boolean;
  };

// every value in every table, so a secret in any row is caught
function dump(db: Db): string {
  const tables = db
    .query<{ name: string }, []>(
      "select name from sqlite_master where type = 'table'",
    )
    .all();
  return JSON.stringify(
    tables.map((t) => db.query(`select * from "${t.name}"`).all()),
  );
}

describe("asking for a link", () => {
  test("an invited address is sent one link, an unknown one none, both answered alike", async () => {
    const t = people();
    t.person("ana", ANA);
    const known = await t.ask(ANA);
    const unknown = await t.ask("nobody@example.com");
    for (const r of [known, unknown]) {
      expect(r.res.status).toBe(202);
      expect(await r.res.text()).toBe("");
      expect(r.challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    }
    expect(known.res.headers.get("set-cookie")?.replace(/=[^;]+/, "")).toBe(
      unknown.res.headers.get("set-cookie")?.replace(/=[^;]+/, ""),
    );
    expect(t.sent.map((s) => s.message.to.address)).toEqual([ANA]);
    const mail = t.mailTo(ANA)!;
    expect(mail.message.subject).toBe(
      `Your markets sign-in code: ${mail.code}`,
    );
    expect(mail.message.text).toBe(
      `Sign in to markets: ${SMTP.public_url}/ui/link/${mail.token}, or enter ${mail.code}. Both work once, for 15 minutes.\n`,
    );
    expect(mail.message.from).toEqual({
      name: "1ctx Markets",
      address: SMTP.from,
    });
    // the token and code reach no row, log line or answer
    expect(dump(t.db)).not.toContain(mail.token);
    expect(dump(t.db)).not.toContain(mail.code);
    for (const line of t.lines) {
      expect(line).not.toContain(mail.token);
      expect(line).not.toContain(ANA);
    }
  });

  test("a body that is not an address is refused; another origin is refused", async () => {
    const t = people();
    const bad = await t.at("/ui/link", t.jsonBody("POST", { email: "x" }));
    expect(bad.status).toBe(400);
    for (const headers of [
      { "sec-fetch-site": "cross-site" },
      { "sec-fetch-site": "same-site" },
    ]) {
      const res = await t.at("/ui/link", {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify({ email: ANA }),
      });
      expect(res.status).toBe(403);
    }
    const bare = await t.at("/ui/link", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "http://evil.test",
      },
      body: JSON.stringify({ email: ANA }),
    });
    expect(bare.status).toBe(403);
  });

  test("while email is off the route is 404, adding a person refused, and the admin key still signs in", async () => {
    for (const t of [people({ smtp: false }), people({ password: false })]) {
      t.person("ana", ANA);
      expect((await t.ask(ANA)).res.status).toBe(404);
      expect(t.sent).toEqual([]);
      const add = await t.at(
        `${PREFIX}/users`,
        t.jsonBody("POST", { name: "Bo", email: "bo@example.com" }, t.admin),
      );
      expect(add.status).toBe(409);
      expect(await add.json()).toMatchObject({ detail: "email is not set up" });
      const signed = await t.at(
        "/ui/session",
        t.jsonBody("POST", { key: ADMIN_KEY }),
      );
      expect(signed.status).toBe(204);
      expect((await me(t, loginOf(signed))).user?.id).toBe(OPERATOR);
    }
  });

  test("a second ask leaves the first link working", async () => {
    const t = people();
    t.person("ana", ANA);
    const first = await t.ask(ANA);
    const one = t.mailTo(ANA)!;
    await t.ask(ANA, first.challenge);
    const two = t.mailTo(ANA)!;
    expect(two.token).not.toBe(one.token);
    expect((await t.use(one.token)).status).toBe(303);
    expect((await t.use(two.token)).status).toBe(303);
  });

  test(`capped at ${ASKS_PER_USER_DAY} a person a day from one browser, counted after their links are pruned`, async () => {
    const t = people();
    t.person("ana", ANA);
    const browser = "D".repeat(43);
    for (let n = 0; n < ASKS_PER_USER_DAY; n++)
      await t.ask(ANA, browser, `10.0.0.${n}`);
    expect(t.sent).toHaveLength(ASKS_PER_USER_DAY);
    // the links go with the prune; the asks stay counted
    await t.clock.advance(SIGN_IN_MS);
    await t.m.writer.write((db) => pruneLogins(db, t.clock.now()));
    expect(t.db.query("select * from links").all()).toEqual([]);
    const capped = await t.ask(ANA, browser);
    expect(capped.res.status).toBe(202);
    expect(t.sent).toHaveLength(ASKS_PER_USER_DAY);
    expect(t.lines.some((l) => l.includes("link ask capped"))).toBe(true);
    // a day after the first, one more goes
    await t.clock.advance(24 * 60 * MINUTE_MS);
    await t.ask(ANA, browser);
    expect(t.sent).toHaveLength(ASKS_PER_USER_DAY + 1);
  });

  test("a stranger's asks never use up a person's own", async () => {
    const t = people();
    t.person("ana", ANA);
    const stranger = "E".repeat(43);
    for (let n = 0; n < ASKS_PER_USER_DAY + 2; n++)
      await t.ask(ANA, stranger, `6.6.6.${n}`);
    expect(t.sent).toHaveLength(ASKS_PER_USER_DAY);
    // ana's own browser still gets her link
    const own = await t.ask(ANA, "F".repeat(43), "1.2.3.4");
    expect(own.res.status).toBe(202);
    expect(t.sent).toHaveLength(ASKS_PER_USER_DAY + 1);
  });

  test(`one browser is sent at most ${ASKS_PER_CHALLENGE_HOUR} links an hour, whoever it names`, async () => {
    const t = people();
    const browser = "G".repeat(43);
    for (let k = 0; k <= ASKS_PER_CHALLENGE_HOUR; k++) {
      t.person(`q${k}`, `q${k}@example.com`);
      await t.ask(`q${k}@example.com`, browser, `10.6.${k}.1`);
    }
    expect(t.sent).toHaveLength(ASKS_PER_CHALLENGE_HOUR);
    await t.clock.advance(60 * MINUTE_MS);
    await t.ask(`q${ASKS_PER_CHALLENGE_HOUR}@example.com`, browser, "10.7.0.1");
    expect(t.sent).toHaveLength(ASKS_PER_CHALLENGE_HOUR + 1);
  });

  test(`capped at ${ASKS_PER_HOUR} an hour across the server`, async () => {
    const t = people();
    const n = ASKS_PER_HOUR + 1;
    for (let k = 0; k < n; k++) t.person(`p${k}`, `p${k}@example.com`);
    for (let k = 0; k < n; k++) {
      const r = await t.ask(`p${k}@example.com`, null, `10.0.${k}.1`);
      expect(r.res.status).toBe(202);
    }
    expect(t.sent).toHaveLength(ASKS_PER_HOUR);
    expect(t.mailTo(`p${ASKS_PER_HOUR}@example.com`)).toBeNull();
  });

  test(`${ASKS_PER_MINUTE} asks a minute per client address, then 429`, async () => {
    const t = people();
    for (let k = 0; k < ASKS_PER_MINUTE; k++) {
      expect(
        (await t.ask(`x${k}@example.com`, null, "10.1.1.1")).res.status,
      ).toBe(202);
    }
    const over = await t.ask("y@example.com", null, "10.1.1.1");
    expect(over.res.status).toBe(429);
    expect(over.res.headers.get("retry-after")).toBe("60");
    expect((await t.ask("y@example.com", null, "10.1.1.2")).res.status).toBe(
      202,
    );
    await t.clock.advance(MINUTE_MS);
    expect((await t.ask("y@example.com", null, "10.1.1.1")).res.status).toBe(
      202,
    );
  });
});

describe("using a link", () => {
  test("a GET never acts; a POST signs in once, landing on Home", async () => {
    const t = people();
    t.person("ana", ANA);
    await t.ask(ANA);
    const { token } = t.mailTo(ANA)!;
    const page = await t.at(`/ui/link/${token}`);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain('<meta name="referrer" content="no-referrer">');
    expect(html).toContain('<form method="post">');
    expect(html).toContain("Sign in");
    expect(page.headers.get("referrer-policy")).toBe("no-referrer");
    expect(page.headers.get("set-cookie")).toBeNull();
    expect(t.db.query("select * from logins").all()).toEqual([]);
    const used = await t.use(token);
    expect(used.status).toBe(303);
    expect(used.headers.get("location")).toBe("/");
    const cookie = loginOf(used);
    expect((await me(t, cookie)).user).toMatchObject({
      id: "ana",
      role: "member",
    });
    // used twice: dead, as an unknown one
    const again = await t.use(token);
    expect(again.status).toBe(404);
    expect(await again.text()).toContain("This link no longer works.");
    expect(again.headers.get("set-cookie")).toBeNull();
    expect((await t.at(`/ui/link/${token}`)).status).toBe(404);
  });

  test("an expired link, an unknown one and a removed person's read alike, offering a new one", async () => {
    const t = people();
    t.person("ana", ANA);
    t.person("bo", "bo@example.com");
    await t.ask(ANA);
    await t.ask("bo@example.com");
    const ana = t.mailTo(ANA)!.token;
    const bo = t.mailTo("bo@example.com")!.token;
    const gone = await t.at(
      `${PREFIX}/users/bo`,
      t.jsonBody("DELETE", {}, t.admin),
    );
    expect(gone.status).toBe(200);
    await t.clock.advance(SIGN_IN_MS);
    const pages: string[] = [];
    for (const token of [ana, bo, "A".repeat(43), "short"]) {
      const res = await t.use(token);
      expect([token, res.status]).toEqual([token, 404]);
      pages.push(await res.text());
      const got = await t.at(`/ui/link/${token}`);
      expect(got.status).toBe(404);
      pages.push(await got.text());
    }
    expect(new Set(pages).size).toBe(1);
    expect(pages[0]).toContain("This link no longer works.");
    expect(pages[0]).toContain("Email me a new link");
    expect(pages[0]).toContain('action="/ui/link"');
    expect(pages[0]).toContain('<meta name="referrer" content="no-referrer">');
  });

  test("the dead page's form asks for a new link like the sign-in page", async () => {
    const t = people();
    t.person("ana", ANA);
    const res = await t.at("/ui/link", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "sec-fetch-site": "same-origin",
      },
      body: `email=${encodeURIComponent(ANA)}`,
    });
    await t.settled();
    expect(res.status).toBe(202);
    expect(await res.text()).toContain("Check your email.");
    expect(t.mailTo(ANA)).not.toBeNull();
  });

  test("a POST from another origin is refused and the link stays live", async () => {
    const t = people();
    t.person("ana", ANA);
    await t.ask(ANA);
    const { token } = t.mailTo(ANA)!;
    const res = await t.at(`/ui/link/${token}`, {
      method: "POST",
      headers: { "sec-fetch-site": "cross-site" },
    });
    expect(res.status).toBe(403);
    expect((await t.use(token)).status).toBe(303);
  });

  test("a used link ends the tab's older login", async () => {
    const t = people();
    t.person("ana", ANA);
    const old = cookieFor(t.db, t.clock.now(), "ana");
    await t.ask(ANA);
    const used = await t.use(t.mailTo(ANA)!.token, { cookie: old });
    expect(used.status).toBe(303);
    expect((await me(t, old)).user).toBeNull();
    expect((await me(t, loginOf(used))).user?.id).toBe("ana");
  });
});

describe("the code", () => {
  test("signs in beside the asking browser, and using it uses the link", async () => {
    const t = people();
    t.person("ana", ANA);
    const { challenge } = await t.ask(ANA);
    const { token, code } = t.mailTo(ANA)!;
    const res = await t.code(ANA, code, challenge);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ landing: "/" });
    expect((await me(t, loginOf(res))).user?.id).toBe("ana");
    expect((await t.use(token)).status).toBe(404);
    expect((await t.code(ANA, code, challenge)).status).toBe(401);
  });

  test("is dead once its link is used", async () => {
    const t = people();
    t.person("ana", ANA);
    const { challenge } = await t.ask(ANA);
    const { token, code } = t.mailTo(ANA)!;
    expect((await t.use(token)).status).toBe(303);
    expect((await t.code(ANA, code, challenge)).status).toBe(401);
  });

  test("a wrong code, another address and an unknown address answer alike", async () => {
    const t = people();
    t.person("ana", ANA);
    t.person("bo", "bo@example.com");
    const { challenge } = await t.ask(ANA);
    const { code } = t.mailTo(ANA)!;
    const wrong = code === "000000" ? "000001" : "000000";
    const answers: string[] = [];
    for (const [email, c] of [
      [ANA, wrong],
      ["bo@example.com", code],
      ["nobody@example.com", code],
      [ANA, "12345"],
    ] as const) {
      const res = await t.code(email, c, challenge);
      expect([email, c, res.status]).toEqual([email, c, 401]);
      expect(res.headers.get("set-cookie")).toBeNull();
      answers.push(await res.text());
    }
    expect(new Set(answers).size).toBe(1);
    expect(JSON.parse(answers[0]!)).toEqual({
      error: "unauthorized",
      message: "wrong code",
    });
  });

  test(`wrong ${MAX_CODE_TRIES - 1} times then right signs in; the ${MAX_CODE_TRIES}th wrong try kills the link`, async () => {
    for (const tries of [MAX_CODE_TRIES - 1, MAX_CODE_TRIES]) {
      const t = people();
      t.person("ana", ANA);
      const { challenge } = await t.ask(ANA);
      const { token, code } = t.mailTo(ANA)!;
      const wrong = code === "000000" ? "000001" : "000000";
      for (let k = 0; k < tries; k++) {
        expect(
          (await t.code(ANA, wrong, challenge, `10.2.0.${k}`)).status,
        ).toBe(401);
      }
      const right = await t.code(ANA, code, challenge, "10.3.0.1");
      const live = tries < MAX_CODE_TRIES;
      expect([tries, right.status]).toEqual([tries, live ? 200 : 401]);
      if (!live) expect((await t.use(token)).status).toBe(404);
    }
  });

  test("a code without the asking browser's challenge is never tried, so it burns no try", async () => {
    const t = people();
    t.person("ana", ANA);
    const { challenge } = await t.ask(ANA);
    const { code } = t.mailTo(ANA)!;
    const wrong = code === "000000" ? "000001" : "000000";
    const other = "B".repeat(43);
    for (let k = 0; k < MAX_CODE_TRIES + 2; k++) {
      expect((await t.code(ANA, wrong, other, `10.4.0.${k}`)).status).toBe(401);
      expect((await t.code(ANA, wrong, null, `10.5.0.${k}`)).status).toBe(401);
    }
    // even the right code is refused away from the asking browser
    expect((await t.code(ANA, code, other)).status).toBe(401);
    expect(
      t.db.query("select code_tries from links").get() as {
        code_tries: number;
      },
    ).toEqual({ code_tries: 0 });
    expect((await t.code(ANA, code, challenge)).status).toBe(200);
  });

  test("the code route refuses another origin", async () => {
    const t = people();
    t.person("ana", ANA);
    const { challenge } = await t.ask(ANA);
    const { code } = t.mailTo(ANA)!;
    const res = await t.at("/ui/code", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "sec-fetch-site": "cross-site",
        cookie: `${ASK_COOKIE}=${challenge}`,
      },
      body: JSON.stringify({ email: ANA, code }),
    });
    expect(res.status).toBe(403);
    expect((await t.code(ANA, code, challenge)).status).toBe(200);
  });
});

describe("invites", () => {
  test("adding a person sends a 7-day link and code, landing on Portfolios", async () => {
    const t = people();
    const res = await t.at(
      `${PREFIX}/users`,
      t.jsonBody("POST", { name: "Ana", email: "Ana@Example.com" }, t.admin),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { user: { id: string }; invite: string };
    expect(body).toMatchObject({
      invite: "sent",
      user: { name: "Ana", email: ANA, role: "member", operator: false },
    });
    const mail = t.mailTo(ANA)!;
    expect(mail.message.subject).toBe(
      `Your markets sign-in code: ${mail.code}`,
    );
    expect(mail.message.text).toBe(
      `You were added to markets. Sign in: ${SMTP.public_url}/ui/link/${mail.token}, or enter ${mail.code}. Both work once, for 7 days.\n`,
    );
    // past a sign-in link's time, an invite still works
    await t.clock.advance(SIGN_IN_MS * 4);
    const used = await t.use(mail.token);
    expect(used.status).toBe(303);
    expect(used.headers.get("location")).toBe("/portfolios");
  });

  test("sent again, it replaces the unused one; a failed send keeps the person", async () => {
    const t = people();
    t.fail({
      ok: false,
      failure: "auth",
      reply: "535 5.7.8 made-up refusal for ana@example.com",
    });
    const res = await t.at(
      `${PREFIX}/users`,
      t.jsonBody("POST", { name: "Ana", email: ANA }, t.admin),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { user: { id: string } };
    expect(body).toMatchObject({ invite: "failed", reason: "auth" });
    const first = t.mailTo(ANA)!;
    // the failure word is logged, never the reply
    expect(t.lines.some((l) => l.includes("failure=auth"))).toBe(true);
    for (const line of t.lines) expect(line).not.toContain("535");
    t.fail({ ok: true });
    const again = await t.at(`${PREFIX}/users/${body.user.id}/invite`, {
      method: "POST",
      headers: t.admin,
    });
    expect(await again.json()).toEqual({ invite: "sent" });
    const second = t.mailTo(ANA)!;
    expect(second.token).not.toBe(first.token);
    expect((await t.use(first.token)).status).toBe(404);
    expect((await t.use(second.token)).status).toBe(303);
  });

  test("an invite's code works from any browser that asked for one", async () => {
    const t = people();
    const res = await t.at(
      `${PREFIX}/users`,
      t.jsonBody("POST", { name: "Ana", email: ANA }, t.admin),
    );
    expect(res.status).toBe(201);
    const { code } = t.mailTo(ANA)!;
    // no browser asked for an invite, so none holds its challenge; without
    // any challenge cookie a code is never tried
    expect((await t.code(ANA, code, null)).status).toBe(401);
    const used = await t.code(ANA, code, "C".repeat(43));
    expect(used.status).toBe(200);
    expect(await used.json()).toEqual({ landing: "/portfolios" });
  });
});

describe("the SMTP settings", () => {
  test("a save needs every field, a username its key file, and an email- name", async () => {
    const t = people({ smtp: false });
    const { host: _, from: __, ...partial } = SMTP;
    const missing = await t.smtp(partial);
    expect(missing.status).toBe(400);
    expect((await missing.json()).detail).toBe("missing host, from");
    for (const [change, says] of [
      [{ key_name: null }, "key_name is required with a username"],
      [{ username: null }, "username is required with a key_name"],
      [{ key_name: "source-fred" }, "key_name must name an email- key file"],
      [{ key_name: "user-admin" }, "key_name must name an email- key file"],
      [{ key_name: "email-../x" }, "key_name must name an email- key file"],
      [{ public_url: "http://markets.example.com" }, "public_url must start"],
      [
        { public_url: "https://markets.example.com/x" },
        "public_url must be an origin",
      ],
      [{ port: 0 }, "port must be"],
      [{ security: "none" }, "security must be"],
      [{ from: "nobody" }, "from must be"],
      [{ extra: 1 }, "unknown argument extra"],
    ] as const) {
      const res = await t.smtp({ ...SMTP, ...change });
      expect([change, res.status]).toEqual([change, 400]);
      expect((await res.json()).detail).toStartWith(says);
    }
    expect(t.db.query("select * from smtp_settings").all()).toEqual([]);
    // no login at all is fine: a relay that takes none
    const open = await t.smtp({ ...SMTP, username: null, key_name: null });
    expect(open.status).toBe(200);
    expect(await open.json()).toMatchObject({
      email_on: true,
      key_missing: false,
    });
  });

  test("lists only email- key files by name; the password reaches no row, answer or log", async () => {
    const t = people({ smtp: false });
    writeFileSync(
      join(t.dir, "email-other.key"),
      "made-up-other-password-000000",
    );
    writeFileSync(
      join(t.dir, "source-fred.key"),
      "made-up-fred-key-0000000000000",
    );
    writeFileSync(
      join(t.dir, "user-admin.key"),
      "made-up-admin-key-000000000000",
    );
    writeFileSync(join(t.dir, "email-Bad.key"), "x");
    writeFileSync(join(t.dir, "email-test.txt"), "x");
    const saved = await t.smtp();
    const text = await saved.text();
    expect(JSON.parse(text)).toMatchObject({
      key_names: ["email-other", "email-test"],
      email_on: true,
      settings: { ...SMTP, updated_by: OPERATOR },
    });
    const ana = await t.at(
      `${PREFIX}/users`,
      t.jsonBody("POST", { name: "Ana", email: ANA }, t.admin),
    );
    expect(ana.status).toBe(201);
    expect(t.sent[0]!.server.password).toBe(PASSWORD);
    const tested = await t.at(
      `${PREFIX}/smtp/test`,
      t.jsonBody("POST", { to: ANA }, t.admin),
    );
    const answers = [
      text,
      await tested.text(),
      await (await t.at(`${PREFIX}/smtp`, { headers: t.admin })).text(),
    ];
    for (const a of answers) expect(a).not.toContain(PASSWORD);
    expect(dump(t.db)).not.toContain(PASSWORD);
    for (const line of t.lines) expect(line).not.toContain(PASSWORD);
  });

  test("email is off without the key file and on once it appears, with no restart", async () => {
    const t = people({ password: false });
    t.person("ana", ANA);
    const before = await (
      await t.at(`${PREFIX}/smtp`, { headers: t.admin })
    ).json();
    expect(before).toMatchObject({ email_on: false, key_missing: true });
    expect((await me(t, "")).email_on).toBe(false);
    expect((await t.ask(ANA)).res.status).toBe(404);
    writeFileSync(join(t.dir, "email-test.key"), PASSWORD);
    expect((await me(t, "")).email_on).toBe(true);
    expect((await t.ask(ANA)).res.status).toBe(202);
    expect(t.mailTo(ANA)!.server.password).toBe(PASSWORD);
  });

  test("a save sends nothing, and the next link goes through the new settings", async () => {
    const t = people();
    t.person("ana", ANA);
    const moved = { ...SMTP, host: "mail.example.org", port: 587 };
    // a new server with the old password file saves no login, so the
    // password never follows it unpicked
    const saved = await t.smtp({ ...moved, security: "starttls" });
    expect(saved.status).toBe(200);
    expect((await saved.json()).settings).toMatchObject({
      host: "mail.example.org",
      username: null,
      key_name: null,
    });
    expect(t.sent).toEqual([]);
    // picked again for the same server, it stays
    const picked = await t.smtp({ ...moved, security: "starttls" });
    expect((await picked.json()).settings).toMatchObject({
      username: SMTP.username,
      key_name: SMTP.key_name,
    });
    expect(t.sent).toEqual([]);
    await t.ask(ANA);
    expect(t.mailTo(ANA)!.server).toEqual({
      host: "mail.example.org",
      port: 587,
      security: "starttls",
      username: SMTP.username,
      password: PASSWORD,
    });
  });

  test("the test email answers sent, or failed with the reply, which no log holds", async () => {
    const t = people();
    const sent = await t.at(
      `${PREFIX}/smtp/test`,
      t.jsonBody("POST", { to: ANA }, t.admin),
    );
    expect(await sent.json()).toEqual({ result: "sent" });
    expect(t.sent.map((s) => s.message.to.address)).toEqual([ANA]);
    t.fail({
      ok: false,
      failure: "rejected",
      reply: "550 made-up no such user ana@example.com",
    });
    const failed = await t.at(
      `${PREFIX}/smtp/test`,
      t.jsonBody("POST", { to: ANA }, t.admin),
    );
    expect(await failed.json()).toEqual({
      result: "failed",
      reason: "rejected",
      reply: "550 made-up no such user ana@example.com",
    });
    expect(t.lines.some((l) => l.includes("failure=rejected"))).toBe(true);
    for (const line of t.lines) {
      expect(line).not.toContain("550");
      expect(line).not.toContain(ANA);
    }
    // an admin with an email of their own is its default address
    t.db
      .query("update users set email = 'op@example.com' where id = 'operator'")
      .run();
    t.fail({ ok: true });
    await t.at(`${PREFIX}/smtp/test`, t.jsonBody("POST", {}, t.admin));
    expect(t.sent.at(-1)!.message.to.address).toBe("op@example.com");
  });

  test("Remove turns email off and keeps the file, the people and their logins", async () => {
    const t = people();
    t.person("ana", ANA);
    const cookie = cookieFor(t.db, t.clock.now(), "ana");
    const gone = await t.at(`${PREFIX}/smtp`, {
      method: "DELETE",
      headers: t.admin,
    });
    expect(gone.status).toBe(204);
    expect(keys(t.dir).email("email-test")).toBe(PASSWORD);
    expect((await me(t, cookie)).user?.id).toBe("ana");
    expect((await me(t, cookie)).email_on).toBe(false);
    expect((await t.ask(ANA)).res.status).toBe(404);
  });

  test("the failure words, never the server's text", () => {
    const cases: [object, Failure][] = [
      [{ code: "EAUTH", response: "535 no" }, "auth"],
      [{ code: "ENOAUTH" }, "auth"],
      [{ code: "ETLS" }, "tls"],
      [{ code: "ESOCKET", library: "SSL routines" }, "tls"],
      [{ code: "ESOCKET", message: "self signed certificate" }, "tls"],
      [{ code: "ESOCKET", syscall: "connect" }, "connect"],
      [{ code: "ECONNECTION" }, "connect"],
      [{ code: "EDNS" }, "connect"],
      [{ code: "ETIMEDOUT" }, "timeout"],
      [{ code: "EENVELOPE" }, "rejected"],
      [{ responseCode: 550 }, "rejected"],
      [{ responseCode: 421 }, "other"],
      [{}, "other"],
    ];
    for (const [error, word] of cases) {
      expect([error, failureOf(error)]).toEqual([error, word]);
    }
  });
});

describe("routes by role", () => {
  test("a member is refused every admin route; an admin never reads a member's portfolio", async () => {
    const t = people();
    t.person("ana", ANA);
    const member = cookieFor(t.db, t.clock.now(), "ana");
    const site = { cookie: member, "sec-fetch-site": "same-origin" };
    for (const [method, path] of [
      ["GET", "/users"],
      ["POST", "/users"],
      ["PATCH", "/users/ana"],
      ["DELETE", "/users/ana"],
      ["POST", "/users/ana/invite"],
      ["POST", "/users/ana/sign-out"],
      ["GET", "/smtp"],
      ["PUT", "/smtp"],
      ["DELETE", "/smtp"],
      ["POST", "/smtp/test"],
      ["GET", "/status"],
      ["POST", "/status/retry"],
      ["GET", "/instruments"],
      ["DELETE", "/instruments/US:AAA"],
      ["POST", "/instruments/US:AAA/refetch"],
    ] as const) {
      const res = await t.at(`${PREFIX}${path}`, {
        method,
        headers: { ...site, "content-type": "application/json" },
        body: method === "GET" ? undefined : "{}",
      });
      expect([method, path, res.status]).toEqual([method, path, 403]);
    }
    const made = await shares(t.m, "ana");
    const id = (made as { portfolio: { id: number } }).portfolio.id;
    const admin = cookieFor(t.db, t.clock.now());
    for (const headers of [{ cookie: admin }, t.admin]) {
      const res = await t.at(`${PREFIX}/portfolios/${id}`, { headers });
      expect(res.status).toBe(404);
    }
    expect(
      (
        await t.at(`${PREFIX}/portfolios/${id}`, {
          headers: { cookie: member },
        })
      ).status,
    ).toBe(200);
  });

  test("a member reads Home, the screener and an instrument page; an agent key does not", async () => {
    const t = people();
    t.person("ana", ANA);
    instrument(t.db, "US:AAA", { currency: "USD", name: "Alpha Made Up" });
    quote(t.db, "US:AAA", 120, 118);
    const member = { cookie: cookieFor(t.db, t.clock.now(), "ana") };
    for (const path of [
      "/dashboard",
      "/screener",
      "/instruments/US:AAA/stored",
    ]) {
      expect([
        path,
        (await t.at(`${PREFIX}${path}`, { headers: member })).status,
      ]).toEqual([path, 200]);
      const key = await t.at(`${PREFIX}${path}`, {
        headers: { authorization: `Bearer ${READ_KEY}` },
      });
      expect([path, key.status]).toEqual([path, 403]);
    }
    const saved = await t.at(`${PREFIX}/dashboard`, {
      method: "PUT",
      headers: {
        ...member,
        "content-type": "application/json",
        "sec-fetch-site": "same-origin",
      },
      body: JSON.stringify({
        revision: 0,
        sections: [{ name: "Mine", view: "cards", symbols: ["US:AAA"] }],
      }),
    });
    expect(saved.status).toBe(200);
    expect(t.db.query("select owner from dashboards").all()).toEqual([
      { owner: "ana" },
    ]);
  });
});

describe("who is signed in", () => {
  test("/ui/me answers the operator, a member and no one", async () => {
    const t = people();
    t.person("ana", ANA);
    const op = loginOf(
      await t.at("/ui/session", t.jsonBody("POST", { key: ADMIN_KEY })),
    );
    expect(await me(t, op)).toEqual({
      user: {
        id: OPERATOR,
        name: "operator",
        role: "admin",
        email: null,
        operator: true,
      },
      email_on: true,
    });
    expect(await me(t, cookieFor(t.db, t.clock.now(), "ana"))).toEqual({
      user: {
        id: "ana",
        name: "Person ana",
        role: "member",
        email: ANA,
        operator: false,
      },
      email_on: true,
    });
    const nobody = await t.at("/ui/me");
    expect(nobody.status).toBe(200);
    expect(await nobody.json()).toEqual({ user: null, email_on: true });
  });

  test("a person renames themself; the operator's email is set only once its link is used", async () => {
    const t = people();
    const op = cookieFor(t.db, t.clock.now());
    const patch = (body: unknown, cookie = op) =>
      t.at("/ui/me", t.jsonBody("PATCH", body, { cookie }));
    const renamed = await patch({ name: "Owner" });
    expect(renamed.status).toBe(200);
    expect((await renamed.json()).user.name).toBe("Owner");
    const asked = await patch({ email: "Op@Example.com" });
    expect(await asked.json()).toEqual({ link: "sent" });
    expect(asked.headers.get("set-cookie")).toBeNull();
    expect((await me(t, op)).user?.email).toBeNull();
    const mail = t.mailTo("op@example.com")!;
    // it carries no code, since it opens no login
    expect(mail.message.subject).toBe("Confirm your markets email");
    expect(mail.code).toBe("");
    expect(mail.message.text).not.toMatch(/\d{6}/);
    // opened anywhere else, by nobody or by another person, it does nothing
    t.person("bo", "bo@example.com");
    const anywhere: Record<string, string>[] = [
      {},
      { cookie: cookieFor(t.db, t.clock.now(), "bo") },
    ];
    for (const headers of anywhere) {
      const res = await t.use(mail.token, headers);
      expect(res.status).toBe(404);
      expect(res.headers.get("set-cookie")).toBeNull();
    }
    expect((await me(t, op)).user?.email).toBeNull();
    // in the operator's own browser it sets the address and opens no login
    const used = await t.use(mail.token, { cookie: op });
    expect(used.status).toBe(303);
    expect(used.headers.get("set-cookie")).toBeNull();
    expect(t.db.query("select count(*) as n from logins").get()).toEqual({
      n: 2,
    });
    expect((await me(t, op)).user?.email).toBe("op@example.com");
    // now the operator signs in by link too
    await t.ask("op@example.com");
    expect(t.mailTo("op@example.com")!.token).not.toBe(mail.token);
    // a member's email is an admin's to change
    t.person("ana", ANA);
    const member = cookieFor(t.db, t.clock.now(), "ana");
    expect((await patch({ email: "x@example.com" }, member)).status).toBe(403);
    // another origin is refused
    const foreign = await t.at("/ui/me", {
      method: "PATCH",
      headers: {
        cookie: op,
        "content-type": "application/json",
        "sec-fetch-site": "cross-site",
      },
      body: JSON.stringify({ name: "X" }),
    });
    expect(foreign.status).toBe(403);
  });
});

describe("signing out", () => {
  test("sign-out ends that one login; sign-out everywhere ends all and keeps the data", async () => {
    const t = people();
    t.person("ana", ANA);
    const a = cookieFor(t.db, t.clock.now(), "ana");
    const b = cookieFor(t.db, t.clock.now(), "ana");
    const out = await t.at("/ui/session", {
      method: "DELETE",
      headers: { cookie: a },
    });
    expect(out.status).toBe(204);
    expect(out.headers.get("set-cookie")).toContain("Max-Age=0");
    expect((await me(t, a)).user).toBeNull();
    expect((await me(t, b)).user?.id).toBe("ana");
    await shares(t.m, "ana");
    await t.ask(ANA);
    const live = t.mailTo(ANA)!.token;
    const c = cookieFor(t.db, t.clock.now(), "ana");
    const res = await t.at(`${PREFIX}/users/ana/sign-out`, {
      method: "POST",
      headers: t.admin,
    });
    expect(res.status).toBe(204);
    for (const cookie of [b, c]) expect((await me(t, cookie)).user).toBeNull();
    expect((await t.use(live)).status).toBe(404);
    expect(
      t.db
        .query("select name from portfolios where owner = 'ana' and cash = 0")
        .all(),
    ).toEqual([{ name: "Shares" }]);
    expect(t.db.query("select id from users where id = 'ana'").get()).toEqual({
      id: "ana",
    });
  });

  test("a new user-admin.key ends only the operator's admin-key logins", async () => {
    const t = people();
    t.person("ana", ANA);
    const op = cookieFor(
      t.db,
      t.clock.now(),
      OPERATOR,
      "test-old-admin-key-0123456789abcdef01234567",
    );
    const opByLink = cookieFor(t.db, t.clock.now(), OPERATOR, null);
    const ana = cookieFor(t.db, t.clock.now(), "ana");
    expect((await me(t, op)).user).toBeNull();
    expect(
      (await t.at(`${PREFIX}/status`, { headers: { cookie: op } })).status,
    ).toBe(401);
    expect((await me(t, opByLink)).user?.id).toBe(OPERATOR);
    expect((await me(t, ana)).user?.id).toBe("ana");
  });
});

describe("keys per person", () => {
  test(`a member makes up to 5 keys of their own; nobody makes one for someone else`, async () => {
    const t = people();
    t.person("ana", ANA);
    const member = {
      cookie: cookieFor(t.db, t.clock.now(), "ana"),
      "sec-fetch-site": "same-origin",
    };
    const make = (name: string, extra = {}) =>
      t.at(`${PREFIX}/keys`, t.jsonBody("POST", { name, ...extra }, member));
    for (let k = 0; k < 5; k++)
      expect((await make(`agent-${k}`)).status).toBe(201);
    const over = await make("agent-5");
    expect(over.status).toBe(409);
    expect((await over.json()).detail).toBe("too many keys");
    // the operator may use the same names: names are per person
    const own = await t.at(
      `${PREFIX}/keys`,
      t.jsonBody("POST", { name: "agent-0" }, t.admin),
    );
    expect(own.status).toBe(201);
    const other = await t.at(
      `${PREFIX}/keys`,
      t.jsonBody("POST", { name: "for-ana", user: "ana" }, t.admin),
    );
    expect(other.status).toBe(400);
    expect(
      t.db.query("select count(*) as n from keys where user_id = 'ana'").get(),
    ).toEqual({ n: 5 });
  });

  test("an admin lists everyone's keys with their owner and revokes any; a member only their own", async () => {
    const t = people();
    t.person("ana", ANA);
    const ana = {
      cookie: cookieFor(t.db, t.clock.now(), "ana"),
      "sec-fetch-site": "same-origin",
    };
    const anaKey = await t.m.writer.write(
      (db) => createKey(db, "ana", { name: "phone", days: null }, 0).key.id,
    );
    const opKey = await t.m.writer.write(
      (db) => createKey(db, OPERATOR, { name: "phone", days: null }, 0).key.id,
    );
    const list = async (headers: Record<string, string>) =>
      (
        (await (await t.at(`${PREFIX}/keys`, { headers })).json()) as {
          keys: { id: string; owner: { id: string; name: string } }[];
        }
      ).keys.map((k) => [k.id, k.owner.id, k.owner.name]);
    expect(await list(ana)).toEqual([[anaKey, "ana", "Person ana"]]);
    expect(await list(t.admin)).toContainEqual([anaKey, "ana", "Person ana"]);
    expect(await list(t.admin)).toContainEqual([opKey, OPERATOR, "operator"]);
    expect(
      (
        await t.at(`${PREFIX}/keys/${opKey}`, {
          method: "DELETE",
          headers: ana,
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await t.at(`${PREFIX}/keys/${anaKey}`, {
          method: "DELETE",
          headers: t.admin,
        })
      ).status,
    ).toBe(204);
    expect(await list(ana)).toEqual([]);
  });
});

describe("a write re-reads its caller", () => {
  test("a key revoked, a login ended or a person removed mid-call writes nothing", async () => {
    const t = people();
    t.person("ana", ANA);
    const key = await t.m.writer.write(
      (db) => createKey(db, "ana", { name: "agent", days: null }, 0).key,
    );
    const viaKey: Who = {
      name: "agent",
      user: "ana",
      credential: { kind: "key", id: key.id },
      portfolio: "write",
      rules: "write",
      profile: "write",
    };
    const login = await t.m.writer.write((db) =>
      openLogin(db, "ana", t.clock.now()),
    );
    const viaLogin = loginWho("ana", login.id, "Ana");
    await saveSettings(t.m, "ana", { display_currency: "EUR" });
    const deps = { adminDigest: null, now: () => t.clock.now() };
    const write = (who: Who, name: string) =>
      asCaller(checkOf(who, deps), () => createPortfolio(t.m, "ana", { name }));
    // resolved before, gone by the write
    expect(await write(viaKey, "Before")).toMatchObject({
      portfolio: { name: "Before" },
    });
    await t.m.writer.write((db) =>
      db.query("delete from keys where id = ?").run(key.id),
    );
    await expect(write(viaKey, "Revoked")).rejects.toThrow(
      "the key was revoked or expired",
    );
    await t.m.writer.write((db) =>
      db.query("delete from logins where id = ?").run(login.id),
    );
    await expect(write(viaLogin, "Ended")).rejects.toThrow("signed out");
    const names = t.db
      .query<{ name: string }, []>(
        "select name from portfolios where owner = 'ana' and cash = 0",
      )
      .all()
      .map((r) => r.name);
    expect(names).toEqual(["Before"]);
  });

  test("an admin demoted mid-call adds nobody; a revoke through the router answers 401", async () => {
    const t = people();
    t.person("boss", "boss@example.com", "admin");
    const cookie = cookieFor(t.db, t.clock.now(), "boss");
    // demoted after the router let the call in, before its write
    const demote = t.db.query(
      "update users set role = 'member' where id = 'boss'",
    );
    const original = t.m.writer.write.bind(t.m.writer);
    let once = true;
    t.m.writer.write = ((fn: (db: Db) => unknown) => {
      if (once) {
        once = false;
        demote.run();
      }
      return original(fn);
    }) as typeof t.m.writer.write;
    const res = await t.at(
      `${PREFIX}/users`,
      t.jsonBody("POST", { name: "Ana", email: ANA }, { cookie }),
    );
    expect(res.status).toBe(403);
    expect(
      t.db.query("select id from users where email = ?").get(ANA),
    ).toBeNull();
    expect(t.sent).toEqual([]);
  });

  test("an admin demoted before the invite's own write makes no link", async () => {
    const t = people();
    t.person("boss", "boss@example.com", "admin");
    const cookie = cookieFor(t.db, t.clock.now(), "boss");
    const demote = t.db.query(
      "update users set role = 'member' where id = 'boss'",
    );
    const original = t.m.writer.write.bind(t.m.writer);
    // the person is added while still an admin; the demote lands before
    // the write that makes their invite
    let writes = 0;
    t.m.writer.write = ((fn: (db: Db) => unknown) => {
      if (++writes === 2) demote.run();
      return original(fn);
    }) as typeof t.m.writer.write;
    const res = await t.at(
      `${PREFIX}/users`,
      t.jsonBody("POST", { name: "Ana", email: ANA }, { cookie }),
    );
    expect(res.status).toBe(403);
    expect(t.db.query("select * from links").all()).toEqual([]);
    expect(t.sent).toEqual([]);
  });
});

describe("the CLI", () => {
  const data = join(SECRETS, "..");

  test("adds, lists, invites, signs out and removes people on a running server", () =>
    withApp(
      async (t) => {
        const out: string[] = [];
        const run = (...argv: string[]) =>
          runUsers(["--data", data, "--listen", t.url.slice(7), ...argv], {
            write: (line) => out.push(line),
            service: async () => null,
          });
        await t.app.writer.write((db) => {
          db.query(
            `insert into smtp_settings (id, host, port, security, username,
               key_name, from_address, public_url, updated_at, updated_by)
             values (1, 'smtp.example.com', 465, 'tls', 'm@example.com',
               'email-test', 'm@example.com', 'https://markets.example.com',
               0, 'operator')`,
          ).run();
        });
        await run("add", ANA, "Ana", "--role", "member");
        const added = JSON.parse(out[0]!) as {
          user: { id: string };
          invite: string;
        };
        expect(added.invite).toBe("sent");
        out.length = 0;
        await run("list");
        expect(
          JSON.parse(out[0]!).users.map(
            (u: { email: string | null }) => u.email,
          ),
        ).toEqual(expect.arrayContaining([null, ANA]));
        out.length = 0;
        await run("invite", added.user.id);
        expect(JSON.parse(out[0]!)).toEqual({ invite: "sent" });
        out.length = 0;
        await run("sign-out", added.user.id);
        expect(out).toEqual([`signed out ${added.user.id}`]);
        out.length = 0;
        await run("remove", added.user.id, "--dry-run");
        expect(JSON.parse(out[0]!).dry_run).toBe(true);
        await expect(run("remove", "operator")).rejects.toThrow(
          "the operator cannot be removed (409)",
        );
        await run("remove", added.user.id);
        await expect(run("invite", added.user.id)).rejects.toThrow(
          "no such user (404)",
        );
        await expect(run("add", "x")).rejects.toThrow(AdminError);
        for (const line of t.lines) expect(line).not.toContain(t.admin);
      },
      { secrets: secretsDir(), sender: async () => ({ ok: true }) },
    ));

  test("keys acts on the operator's own key by name, another person's only by id", () =>
    withApp(async (t) => {
      const out: string[] = [];
      const run = (...argv: string[]) =>
        runKeys(["--data", data, "--listen", t.url.slice(7), ...argv], {
          write: (line) => out.push(line),
          service: async () => null,
        });
      await t.app.writer.write((db) => {
        db.query(
          "insert into users (id, name, email, role, created_at) values ('ana', 'Ana', ?, 'member', 0)",
        ).run(ANA);
      });
      const theirs = await t.app.writer.write(
        (db) => createKey(db, "ana", { name: "shared", days: null }, 0).key.id,
      );
      await expect(run("revoke", "shared")).rejects.toThrow(
        "no key named shared",
      );
      await expect(run("set", theirs, "--rules", "read")).rejects.toThrow(
        `no key named ${theirs}`,
      );
      await run("add", "shared");
      const mine = (
        t.db
          .query(
            "select id from keys where user_id = 'operator' and name = 'shared'",
          )
          .get() as { id: string }
      ).id;
      out.length = 0;
      await run("revoke", "shared");
      expect(out).toEqual(["revoked shared"]);
      expect(
        t.db.query("select id from keys where id = ?").get(mine),
      ).toBeNull();
      expect(
        t.db.query("select id from keys where id = ?").get(theirs),
      ).toEqual({ id: theirs });
      await run("revoke", theirs);
      expect(
        t.db.query("select id from keys where id = ?").get(theirs),
      ).toBeNull();
    }));
});

describe("the migration for people", () => {
  test("keeps every key and makes key names unique per person", () => {
    const clock = fakeClock(NOW);
    const db = new Database(":memory:", { strict: true });
    db.exec("pragma foreign_keys = on");
    const at = MIGRATIONS.findIndex((m) => m.id === "0037-people");
    migrate(db, clock, MIGRATIONS.slice(0, at));
    db.query(
      `insert into keys (id, user_id, name, token_hash, created_at, rules)
       values ('madeupkey001', 'operator', 'agent', 'hash-1', 5, 'write')`,
    ).run();
    expect(migrate(db, clock)).toEqual(["0037-people"]);
    expect(db.query("select * from keys").all()).toEqual([
      {
        id: "madeupkey001",
        user_id: "operator",
        name: "agent",
        token_hash: "hash-1",
        created_at: 5,
        expires_at: null,
        last_used_at: null,
        portfolio: "none",
        rules: "write",
        profile: "none",
      },
    ]);
    db.query(
      "insert into users (id, name, role, created_at) values ('ana', 'Ana', 'member', 0)",
    ).run();
    // another person's key may share the name; the same person's may not
    db.query(
      `insert into keys (id, user_id, name, token_hash, created_at)
       values ('madeupkey002', 'ana', 'agent', 'hash-2', 6)`,
    ).run();
    expect(() =>
      db
        .query(
          `insert into keys (id, user_id, name, token_hash, created_at)
           values ('madeupkey003', 'ana', 'agent', 'hash-3', 7)`,
        )
        .run(),
    ).toThrow();
    for (const table of ["logins", "links", "link_asks", "smtp_settings"]) {
      expect(db.query(`select count(*) as n from ${table}`).get()).toEqual({
        n: 0,
      });
    }
    // a username goes with a key file
    expect(() =>
      db
        .query(
          `insert into smtp_settings (id, host, port, security, username,
             from_address, public_url, updated_at, updated_by)
           values (1, 'h', 25, 'tls', 'u', 'a@b.cd', 'https://x.test', 0, 'operator')`,
        )
        .run(),
    ).toThrow();
    expect(db.query("pragma foreign_key_check").all()).toEqual([]);
  });
});

describe("the SMTP module", () => {
  test("only it imports nodemailer", async () => {
    const glob = new Bun.Glob("src/**/*.{ts,tsx}");
    const importers: string[] = [];
    for await (const file of glob.scan(join(import.meta.dir, ".."))) {
      const text = await Bun.file(join(import.meta.dir, "..", file)).text();
      if (/from "nodemailer"/.test(text)) importers.push(file);
    }
    expect(importers).toEqual(["src/server/email/smtp.ts"]);
  });

  test("a header value with a line break or a control is refused before any connection", async () => {
    const send = smtpSender();
    const server: SmtpServer = {
      // a port nothing listens on: a connection would fail as connect
      host: "127.0.0.1",
      port: 9,
      security: "tls",
      username: null,
      password: null,
    };
    const message: Outgoing = {
      from: { name: "1ctx Markets", address: "m@example.com" },
      to: { name: "", address: ANA },
      subject: "Your markets sign-in code: 123456",
      text: "x",
    };
    for (const bad of [
      { subject: "a\r\nBcc: x@example.com" },
      { to: { name: "Ana\nBcc: x@example.com", address: ANA } },
      {
        from: {
          name: "x",
          address: `m@example.com${String.fromCharCode(0x2028)}`,
        },
      },
      { subject: "a\u0000" },
    ]) {
      expect(await send(server, { ...message, ...bad })).toEqual({
        ok: false,
        failure: "other",
        reply: null,
      });
    }
  });
});

describe("what a login writes", () => {
  test("names the signed-in person, an operator's and a member's alike", async () => {
    const t = people();
    t.person("ana", ANA);
    instrument(t.db, "US:AAA", { currency: "USD", name: "Alpha Made Up" });
    quote(t.db, "US:AAA", 120, 118);
    t.db.query("update users set name = 'Owner' where id = 'operator'").run();
    const isin = [..."0123456789"].map((d) => `ZZWRITERFND${d}`).find(isIsin)!;
    for (const [id, name, cookie] of [
      [OPERATOR, "Owner", cookieFor(t.db, t.clock.now())],
      ["ana", "Person ana", cookieFor(t.db, t.clock.now(), "ana")],
    ] as const) {
      const send = async (method: string, path: string, body?: unknown) => {
        const res = await t.at(
          `${PREFIX}${path}`,
          body === undefined
            ? { method, headers: { cookie, "sec-fetch-site": "same-origin" } }
            : t.jsonBody(method, body, { cookie }),
        );
        expect([id, method, path, res.status < 300]).toEqual([
          id,
          method,
          path,
          true,
        ]);
        return res.status === 204 ? null : ((await res.json()) as any);
      };
      await send("PUT", "/portfolio-settings", { display_currency: "EUR" });
      const portfolio = (await send("POST", "/portfolios", { name: "Shares" }))
        .portfolio.id as number;
      const trade = (
        await send("POST", "/trades", {
          portfolio,
          symbol: "US:AAA",
          side: "buy",
          quantity: 1,
          price: 100,
        })
      ).trade.id as number;
      await send("DELETE", `/trades/${trade}`);
      const cash = (
        await send("POST", "/positions", {
          kind: "cash",
          name: "Spare",
          amount: 100,
          currency: "EUR",
        })
      ).position.id as number;
      await send("DELETE", `/positions/${cash}`);
      await send("POST", "/funds/trades", {
        portfolio: "Shares",
        isin,
        name: "Made Up Writer Fund",
        side: "buy",
        units: 10,
        price: 5,
        currency: "EUR",
        date: id === OPERATOR ? "2026-01-05" : "2026-01-06",
      });
      await send("PUT", "/profile", { text: `# ${id}\n- Horizon: 5 years\n` });
      const row = (sql: string, ...args: (string | number)[]) =>
        t.db.query(sql).get(...args);
      expect([
        row(
          "select entered_by as e, removed_by as r from trades where id = ?",
          trade,
        ),
        row(
          "select entered_by as e, removed_by as r from positions where id = ?",
          cash,
        ),
        row(
          "select entered_by as e from fund_prices where user_id = ? and instrument = ?",
          id,
          `fund:${isin}`,
        ),
        row("select author as e from profile_versions where owner = ?", id),
      ]).toEqual([
        { e: name, r: name },
        { e: name, r: name },
        { e: name },
        { e: name },
      ]);
    }
    // the admin key and an agent key keep their own names
    const viaAdmin = await t.at(
      `${PREFIX}/profile`,
      t.jsonBody("PUT", { revision: 1, text: "# admin\n" }, t.admin),
    );
    expect(await viaAdmin.json()).toMatchObject({ author: "admin" });
  });
});

describe("what the review found", () => {
  test("no log line holds a link's token, a code or a challenge", async () => {
    const t = people();
    t.person("ana", ANA);
    const { challenge } = await t.ask(ANA);
    const first = t.mailTo(ANA)!;
    await t.at(`/ui/link/${first.token}`);
    expect((await t.use(first.token)).status).toBe(303);
    // used again, dead: logged too
    await t.use(first.token);
    await t.ask(ANA, challenge);
    const second = t.mailTo(ANA)!;
    expect((await t.code(ANA, second.code, challenge)).status).toBe(200);
    const requests = t.lines.filter((l) => l.includes("msg=request"));
    expect(requests.some((l) => l.includes("path=/ui/link/:token"))).toBe(true);
    for (const secret of [
      first.token,
      second.token,
      first.code,
      second.code,
      challenge!,
    ]) {
      for (const line of t.lines) {
        expect(line.includes(secret)).toBe(false);
      }
    }
    expect(loggedPath(`/ui/link/${first.token}`)).toBe("/ui/link/:token");
    expect(loggedPath("/ui/code")).toBe("/ui/code");
  });

  test("only the operator saves or removes email or sends a test; another admin reads it", async () => {
    const t = people();
    t.person("bo", "bo@example.com", "admin");
    const bo = cookieFor(t.db, t.clock.now(), "bo");
    const as = (method: string, path: string, body: unknown, cookie: string) =>
      t.at(`${PREFIX}${path}`, t.jsonBody(method, body, { cookie }));
    for (const [method, path, body] of [
      ["PUT", "/smtp", { ...SMTP, host: "smtp.attacker.example" }],
      ["POST", "/smtp/test", { to: "bo@example.com" }],
      ["DELETE", "/smtp", undefined],
    ] as const) {
      const res = await as(method, path, body ?? {}, bo);
      expect([method, path, res.status]).toEqual([method, path, 403]);
    }
    expect(
      (await t.at(`${PREFIX}/smtp`, { headers: { cookie: bo } })).status,
    ).toBe(200);
    expect(t.sent).toEqual([]);
    expect(t.db.query("select host from smtp_settings").get()).toEqual({
      host: SMTP.host,
    });
    // the operator, by login or by the admin key
    const op = cookieFor(t.db, t.clock.now());
    expect((await as("PUT", "/smtp", SMTP, op)).status).toBe(200);
    expect((await as("POST", "/smtp/test", { to: ANA }, op)).status).toBe(200);
    expect((await t.smtp()).status).toBe(200);
  });

  test("a stranger's wrong codes never kill a pending invite", async () => {
    const t = people();
    const res = await t.at(
      `${PREFIX}/users`,
      t.jsonBody("POST", { name: "Ana", email: ANA }, t.admin),
    );
    expect(res.status).toBe(201);
    const { code } = t.mailTo(ANA)!;
    const wrong = code === "000000" ? "111111" : "000000";
    const stranger = "H".repeat(43);
    for (let n = 0; n < MAX_CODE_TRIES + 1; n++) {
      expect((await t.code(ANA, wrong, stranger, `6.6.7.${n}`)).status).toBe(
        401,
      );
    }
    // that browser is done with this invite, the right code included
    expect((await t.code(ANA, code, stranger)).status).toBe(401);
    expect(t.db.query("select code_tries, used_at from links").get()).toEqual({
      code_tries: 0,
      used_at: null,
    });
    const right = await t.code(ANA, code, "I".repeat(43));
    expect(right.status).toBe(200);
  });

  test("behind a trusted proxy the client is the last X-Forwarded-For value", () => {
    const req = (xff?: string) =>
      new Request("http://127.0.0.1/ui/link", {
        headers: xff === undefined ? {} : { "x-forwarded-for": xff },
      });
    expect(clientIp(req("1.1.1.1, 203.0.113.9"), "127.0.0.1", true)).toBe(
      "203.0.113.9",
    );
    expect(clientIp(req(" 203.0.113.9 "), "127.0.0.1", true)).toBe(
      "203.0.113.9",
    );
    expect(clientIp(req(), "127.0.0.1", true)).toBe("127.0.0.1");
    expect(clientIp(req(""), "127.0.0.1", true)).toBe("127.0.0.1");
    // off by default: a header any client can send is never trusted
    expect(clientIp(req("203.0.113.9"), "127.0.0.1", false)).toBe("127.0.0.1");
    const on = parseCli(["--trust-proxy"], "/home/x");
    const off = parseCli([], "/home/x");
    if (on.kind !== "run" || off.kind !== "run") throw new Error("not run");
    expect([on.config.trustProxy, off.config.trustProxy]).toEqual([
      true,
      false,
    ]);
    expect(configToArgs(on.config)).toContain("--trust-proxy");
    expect(configToArgs(off.config)).not.toContain("--trust-proxy");
  });

  test("an invite and a test email answer timeout past the deadline while the send goes on", async () => {
    const t = people();
    const held = t.hold();
    const added = t.at(
      `${PREFIX}/users`,
      t.jsonBody("POST", { name: "Ana", email: ANA }, t.admin),
    );
    await held.arrived;
    await t.clock.advance(SEND_DEADLINE_MS);
    const res = await added;
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({
      invite: "failed",
      reason: "timeout",
    });
    held.release();
    await t.settled();
    expect(t.lines.some((l) => l.includes("link email sent"))).toBe(true);
    const again = t.hold();
    const tested = t.at(
      `${PREFIX}/smtp/test`,
      t.jsonBody("POST", { to: ANA }, t.admin),
    );
    await again.arrived;
    await t.clock.advance(SEND_DEADLINE_MS);
    expect(await (await tested).json()).toEqual({
      result: "failed",
      reason: "timeout",
      reply: null,
    });
    again.release();
  });
});
