// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { render } from "preact-render-to-string";
import { UI_PATHS } from "../src/server/http.ts";
import { App } from "../src/web/app/App.tsx";
import { Rail } from "../src/web/app/Rail.tsx";
import { forgetRecent, recent } from "../src/web/app/recent.ts";
import { path } from "../src/web/app/router.ts";
import { ROUTES } from "../src/web/app/routes.ts";
import type { Person, SmtpAnswer } from "../src/web/data/admin.ts";
import type { Fetch } from "../src/web/data/api.ts";
import {
  type AgentKey,
  CODE_PATH,
  KEYS_PATH,
  LINK_PATH,
  ME_PATH,
  type Me,
  markets,
  store,
} from "../src/web/data/store.ts";
import { Page } from "../src/web/ui/Page.tsx";
import {
  failureWords,
  formOf,
  inviteFailed,
  plainError,
  removeLine,
  seenWords,
  settingsOf,
  testLine,
} from "../src/web/views/Admin.model.ts";
import {
  AdminPage,
  PersonDetails,
  peopleColumns,
  personItems,
  SmtpTab,
} from "../src/web/views/Admin.tsx";
import { Keys, keyColumns, ownKey } from "../src/web/views/Connect.tsx";
import { enteredBy } from "../src/web/views/Portfolios.model.ts";
import { authorWords } from "../src/web/views/Profile.model.ts";
import {
  codeFlow,
  DIGITS,
  erase,
  holdLine,
  oneAtATime,
  put,
  sayLine,
  typedIn,
  UNREAD,
} from "../src/web/views/SignIn.model.ts";
import { CodeBoxes, SignIn } from "../src/web/views/SignIn.tsx";

const NOW = Date.parse("2026-11-03T12:00:00Z");

const OPERATOR: Me = {
  id: "operator",
  name: "Casey",
  role: "admin",
  email: null,
  operator: true,
};
const ADMIN: Me = {
  id: "jo",
  name: "Jo",
  role: "admin",
  email: "jo@example.com",
  operator: false,
};
const MEMBER: Me = {
  id: "ana",
  name: "Ana",
  role: "member",
  email: "ana@example.com",
  operator: false,
};

// answers by method and path, recording what was asked
function fake(answers: Record<string, () => Response>) {
  const asked: { path: string; init?: RequestInit }[] = [];
  const fetch: Fetch = async (to, init) => {
    asked.push({ path: to, init });
    const answer = answers[`${init?.method ?? "GET"} ${to}`];
    if (answer === undefined) throw new Error(`no answer for ${to}`);
    return answer();
  };
  return { fetch, asked };
}
const ok = (body: unknown) => () => Response.json(body);
const status =
  (code: number, body: unknown = null) =>
  () =>
    body === null
      ? new Response(null, { status: code })
      : Response.json(body, { status: code });
const signedAs = (user: Me | null, email_on = true) => ok({ user, email_on });
const bodyOf = (a: { init?: RequestInit }) => JSON.parse(String(a.init!.body));

function as<T>(me: Me | null, run: () => T): T {
  markets.me.value = me;
  try {
    return run();
  } finally {
    markets.me.value = null;
  }
}

describe("the code boxes", () => {
  test("typing fills the next box and moves on", () => {
    expect(put("", 0, "4")).toEqual({ value: "4", focus: 1 });
    expect(put("48", 2, "2")).toEqual({ value: "482", focus: 3 });
    // a box past the first empty one takes the digit there, never a gap
    expect(put("48", 5, "2")).toEqual({ value: "482", focus: 3 });
    // over a digit: the new one replaces it
    expect(put("482", 1, "7")).toEqual({ value: "472", focus: 2 });
    expect(typedIn("8", "87")).toBe("7");
    // the caret before the digit, after a tap or ArrowLeft
    expect(typedIn("2", "92")).toBe("9");
    expect(put("12", 1, typedIn("2", "92"))?.value).toBe("19");
    expect(typedIn(undefined, "7")).toBe("7");
    // the last box keeps the focus
    expect(put("48291", 5, "3")).toEqual({ value: "482913", focus: 5 });
    // nothing that is not a digit
    expect(put("48", 2, "a")).toBeNull();
    expect(put("48", 2, " ")).toBeNull();
  });

  test("Backspace takes the box's digit, or the one before an empty box", () => {
    expect(erase("482", 2)).toEqual({ value: "48", focus: 2 });
    expect(erase("482", 3)).toEqual({ value: "48", focus: 2 });
    expect(erase("482", 0)).toEqual({ value: "82", focus: 0 });
    expect(erase("482", 5)).toEqual({ value: "48", focus: 2 });
    expect(erase("", 0)).toBeNull();
  });

  test("a paste fills from the box it lands in, a whole code every box", () => {
    expect(put("", 0, "48")).toEqual({ value: "48", focus: 2 });
    expect(put("48", 2, "29")).toEqual({ value: "4829", focus: 4 });
    // a whole code, pasted or filled by the system, from any box
    for (let at = 0; at < DIGITS; at++) {
      expect(put("12", at, "482913")).toEqual({ value: "482913", focus: 5 });
    }
    expect(put("", 3, "482 913")).toEqual({ value: "482913", focus: 5 });
    expect(typedIn("", "482913")).toBe("482913");
    // more digits than boxes keep the first six
    expect(put("", 0, "4829130")).toEqual({ value: "482913", focus: 5 });
  });

  test("the sixth digit signs in once, however many land together", async () => {
    const tried: string[] = [];
    const done = Promise.withResolvers<void>();
    const check = oneAtATime(async (code: string) => {
      tried.push(code);
      await done.promise;
    });
    const first = check("482913");
    void check("482913");
    void check("482913");
    done.resolve();
    await first;
    expect(tried).toEqual(["482913"]);
    // a later try runs once the first has answered
    await check("111111");
    expect(tried).toEqual(["482913", "111111"]);
  });

  test("the line under the boxes always says something", () => {
    const base = {
      checking: false,
      error: null,
      resent: false,
      email: "ana@example.com",
    };
    expect(sayLine(base)).toBe("Sent to ana@example.com");
    expect(sayLine({ ...base, resent: true })).toBe(
      "New code sent to ana@example.com",
    );
    expect(sayLine({ ...base, checking: true })).toBe("Signing in");
    expect(sayLine({ ...base, error: "Wrong or expired code." })).toBe(
      "Wrong or expired code.",
    );
  });

  test("six boxes in a fieldset, the first offered the code from Mail", () => {
    const html = render(
      <CodeBoxes
        value="48"
        first={{ current: null }}
        wrong
        disabled={false}
        onChange={() => {}}
      />,
    );
    expect(html).toStartWith(
      '<fieldset class="signin-boxes" aria-labelledby="signin-code-label">',
    );
    expect(html.match(/<input/g)).toHaveLength(DIGITS);
    expect(html.match(/inputmode="numeric"/g)).toHaveLength(DIGITS);
    expect(html.match(/autocomplete="one-time-code"/g)).toHaveLength(1);
    expect(html.indexOf("one-time-code")).toBeLessThan(
      html.indexOf('aria-label="Digit 2"'),
    );
    expect(html.match(/signin-box-wrong/g)).toHaveLength(DIGITS);
    expect(html).toContain('value="4"');
    expect(html).not.toContain("placeholder");
  });
});

describe("signing in", () => {
  test("with email on: the email step and the admin key behind a switch", () => {
    const s = store(fake({}).fetch);
    s.emailOn.value = true;
    const html = render(<SignIn store={s} />);
    expect(html).toContain('<span class="label">Email</span>');
    expect(html).toContain('autocomplete="email"');
    expect(html).toContain(">Sign in</button>");
    expect(html).toContain("Sign in with the admin key");
    expect(html).not.toContain("Admin key</span>");
    expect(html).not.toContain("placeholder");
  });

  test("with email off: the admin key alone, with no switch", () => {
    const s = store(fake({}).fetch);
    const html = render(<SignIn store={s} />);
    expect(html).toContain("Admin key</span>");
    expect(html).not.toContain('type="email"');
    expect(html).not.toContain("Sign in by email");
    expect(html).not.toContain("Sign in with the admin key");
  });

  test("an ask posts the address alone; a refusal says the server's words", async () => {
    const f = fake({ [`POST ${LINK_PATH}`]: status(202) });
    const s = store(f.fetch);
    await s.askLink(" ana@example.com ");
    expect(f.asked.map((a) => a.path)).toEqual([LINK_PATH]);
    expect(bodyOf(f.asked[0]!)).toEqual({ email: "ana@example.com" });
    expect(f.asked[0]!.init?.credentials).toBe("same-origin");
    const busy = store(
      fake({
        [`POST ${LINK_PATH}`]: status(429, {
          error: "too_many_requests",
          message: "too many tries; wait a minute",
        }),
      }).fetch,
    );
    const err = await busy.askLink("ana@example.com").catch((e) => e);
    expect((err as Error).message).toBe("too many tries; wait a minute");
    expect(busy.signedIn.value).toBeUndefined();
  });

  test("a code signs in and goes to its landing; a wrong one keeps the page", async () => {
    let right = false;
    const f = fake({
      [`POST ${CODE_PATH}`]: () =>
        right
          ? Response.json({ landing: "/portfolios" })
          : Response.json(
              { error: "unauthorized", message: "wrong code" },
              { status: 401 },
            ),
      [`GET ${ME_PATH}`]: signedAs(MEMBER),
    });
    const s = store(f.fetch);
    const went: string[] = [];
    const err = await s
      .signInByCode("ana@example.com", "111111", (to) => went.push(to))
      .catch((e) => e);
    expect((err as Error).message).toBe("wrong or expired code");
    expect(s.signedIn.value).toBeUndefined();
    expect(went).toEqual([]);
    right = true;
    await s.signInByCode("ana@example.com", "482913", (to) => went.push(to));
    expect(went).toEqual(["/portfolios"]);
    expect(s.signedIn.value).toBe(true);
    expect(s.me.value).toEqual(MEMBER);
    expect(bodyOf(f.asked[0]!)).toEqual({
      email: "ana@example.com",
      code: "111111",
    });
  });

  test("a read of who is signed in from before a sign-out never signs back in", async () => {
    const late = Promise.withResolvers<Response>();
    const s = store(async (to, init) => {
      if (init?.method === "DELETE") return new Response(null, { status: 204 });
      if (to === ME_PATH) return late.promise;
      throw new Error(`no answer for ${to}`);
    });
    s.signedIn.value = true;
    const reading = s.check();
    await s.signOut();
    late.resolve(Response.json({ user: MEMBER, email_on: true }));
    await reading;
    expect(s.signedIn.value).toBe(false);
    expect(s.me.value).toBeNull();
  });

  test("the web UI starts from /ui/me: signed out, email off, a member, an admin, the operator", async () => {
    const cases = [
      [signedAs(null, true), false, false, true],
      [signedAs(null, false), false, false, false],
      [signedAs(MEMBER), true, false, true],
      [signedAs(ADMIN), true, true, true],
      [signedAs(OPERATOR, false), true, true, false],
    ] as const;
    for (const [answer, signed, admin, emailOn] of cases) {
      const f = fake({ [`GET ${ME_PATH}`]: answer });
      const s = store(f.fetch);
      await s.check();
      expect([s.signedIn.value, s.isAdmin.value, s.emailOn.value]).toEqual([
        signed,
        admin,
        emailOn,
      ]);
      expect(f.asked.map((a) => a.path)).toEqual([ME_PATH]);
    }
  });
});

describe("members", () => {
  test("an admin's page is no page for a member", () => {
    const was = path.value;
    markets.signedIn.value = true;
    try {
      for (const at of ["/status", "/admin", "/admin/smtp"]) {
        path.value = at;
        expect([at, as(MEMBER, () => render(<App />))]).toEqual([at, ""]);
      }
      path.value = "/admin";
      const html = as(OPERATOR, () => render(<App />));
      expect(html).toContain("People");
      expect(html).toContain('href="/admin/smtp"');
    } finally {
      path.value = was;
      markets.signedIn.value = undefined;
    }
  });

  test("an admin's routes are pages the server serves", () => {
    for (const p of ["/admin", "/admin/smtp"]) {
      expect(UI_PATHS as readonly string[]).toContain(p);
      expect(ROUTES.some((r) => r.path === p && r.admin === true)).toBe(true);
    }
  });

  test("a member's own name reads you, another's as their name", () => {
    expect(authorWords("Ana", "Ana")).toBe("you");
    expect(authorWords("Jo", "Ana")).toBe("Jo");
    expect(authorWords("admin", "Ana")).toBe("you");
    expect(authorWords("web", "Ana")).toBe("you");
    expect(authorWords("ana-agent", "Ana")).toBe("ana-agent");
    expect(authorWords(null, "Ana")).toBe("");
    expect(enteredBy("Ana", "Ana")).toBe("You");
    expect(enteredBy("Jo", "Ana")).toBe("Jo");
    expect(enteredBy("admin", "Ana")).toBe("Admin");
    expect(enteredBy("web", "Ana")).toBe("Web");
    expect(enteredBy("ana-agent", "Ana")).toBe("ana-agent");
  });
});

const key = (name: string, owner: Me): AgentKey => ({
  id: `k-${name}`,
  name,
  owner: { id: owner.id, name: owner.name },
  created_at: "2026-11-01T00:00:00Z",
  last_used_at: null,
  expires_at: null,
});

describe("Connect agents for an admin", () => {
  test("everyone's keys with their owner; the cap counts their own", async () => {
    const keys = [key("casey-agent", OPERATOR), key("ana-agent", MEMBER)];
    const s = store(
      fake({ [`GET ${KEYS_PATH}`]: ok({ keys, limit: 1 }) }).fetch,
      () => NOW,
      () => "/connect",
      () => {},
      (_ms, fire) => {
        fire();
        return () => {};
      },
    );
    await s.loadKeys();
    s.me.value = OPERATOR;
    const html = render(<Keys store={s} shown={{ value: null } as any} />);
    expect(html).toContain(">Owner<");
    expect(html).toContain("Ana");
    expect(html).toContain("1 of 1");
    expect(ownKey(keys[1]!, OPERATOR.id)).toBe(false);
    expect(ownKey(keys[0]!, OPERATOR.id)).toBe(true);
    // a member's list is theirs alone, with no Owner column
    expect(
      keyColumns(keys, NOW, false).find((c) => c.key === "owner")?.show,
    ).toBe(false);
  });
});

const person = (more: Partial<Person> = {}): Person => ({
  id: "ana",
  name: "Ana",
  email: "ana@example.com",
  role: "member",
  operator: false,
  created_at: "2026-11-01T00:00:00Z",
  last_sign_in_at: "2026-11-01T12:00:00Z",
  keys: 1,
  ...more,
});

describe("the Admin page", () => {
  test("people: the reader marked you, the admin key without email, the invited", () => {
    const cols = peopleColumns(OPERATOR.id, NOW);
    const cell = (key: string, p: Person) =>
      render(<span>{cols.find((c) => c.key === key)!.cell(p)}</span>);
    const op = person({
      id: "operator",
      name: "Casey",
      email: null,
      role: "admin",
      operator: true,
    });
    expect(cell("name", op)).toContain(
      '<span class="faint admin-tag">you</span>',
    );
    expect(cell("name", person())).not.toContain("you");
    expect(cell("email", op)).toContain("Admin key");
    expect(cell("role", op)).toContain("Admin");
    expect(cell("seen", person())).toContain("2 d ago");
    expect(cell("seen", person({ last_sign_in_at: null }))).toContain(
      "Invited",
    );
    expect(seenWords(person({ last_sign_in_at: null }), NOW, true)).toBe(
      "Invited, not signed in yet",
    );
  });

  test("Remove names what goes with the person", () => {
    expect(
      removeLine({
        portfolios: 6,
        trades: 412,
        positions: 3,
        profile: 2,
        rules: 0,
        alerts: 3,
        keys: 1,
      }),
    ).toBe(
      "Removes their portfolios (6), trades (412), profile, alerts (3) and keys (1).",
    );
    expect(removeLine({ keys: 1 })).toBe("Removes their keys (1).");
    expect(removeLine({ logins: 2 })).toBe("Removes them.");
  });

  test("its calls: add, role, invite, sign-out, a dry run before removing", async () => {
    const f = fake({
      "POST /api/v1/users": ok({ user: person(), invite: "sent" }),
      "PATCH /api/v1/users/ana": ok({ user: person({ role: "admin" }) }),
      "POST /api/v1/users/ana/invite": ok({
        invite: "failed",
        reason: "auth",
      }),
      "POST /api/v1/users/ana/sign-out": status(204),
      "DELETE /api/v1/users/ana?dry_run=true": ok({
        dry_run: true,
        deleted: { keys: 1 },
      }),
      "DELETE /api/v1/users/ana": ok({ dry_run: false, deleted: { keys: 1 } }),
    });
    const a = store(f.fetch).admin;
    expect(await a.addPerson("Ana", "ana@example.com", "member")).toEqual({
      sent: { sent: true },
    });
    expect(bodyOf(f.asked[0]!)).toEqual({
      name: "Ana",
      email: "ana@example.com",
      role: "member",
    });
    expect(a.people.value).toEqual([person()]);
    expect(await a.setPerson("ana", { role: "admin" })).toBeNull();
    expect(bodyOf(f.asked[1]!)).toEqual({ role: "admin" });
    expect(a.people.value![0]!.role).toBe("admin");
    expect(await a.invite("ana")).toEqual({ sent: false, reason: "auth" });
    expect(await a.signOutPerson("ana")).toBeNull();
    expect(await a.removal("ana")).toEqual({ keys: 1 });
    expect(await a.removePerson("ana")).toBeNull();
    expect(a.people.value).toEqual([]);
  });

  test("SMTP saves every field as the server takes it, and says how a test went", async () => {
    const form = formOf(null);
    expect(form).toEqual({
      host: "",
      port: "",
      security: "tls",
      username: "",
      keyName: null,
      from: "",
      link: "",
    });
    expect(
      settingsOf({
        ...form,
        host: " smtp.example.com ",
        port: "465",
        from: "m@example.com",
        link: "https://markets.example.com",
      }),
    ).toEqual({
      host: "smtp.example.com",
      port: 465,
      security: "tls",
      username: null,
      key_name: null,
      from: "m@example.com",
      public_url: "https://markets.example.com",
    });
    expect(testLine({ sent: true })).toEqual({
      text: "Test email sent to you.",
      error: false,
    });
    // the failure word in plain words, the server's reply on its own line
    expect(
      testLine({ sent: false, reason: "auth", reply: "535 refused" }),
    ).toEqual({
      text: "Not sent. The mail server refused the login.",
      error: true,
      detail: "535 refused",
    });
    const answer: SmtpAnswer = {
      settings: null,
      key_names: [],
      email_on: false,
      key_missing: false,
    };
    const on = { ...answer, email_on: true };
    const f = fake({
      "PUT /api/v1/smtp": ok(on),
      "POST /api/v1/smtp/test": ok({ result: "sent" }),
      "DELETE /api/v1/smtp": status(204),
    });
    const s = store(f.fetch);
    expect(await s.admin.saveSmtp(settingsOf(form))).toBeNull();
    // email on reaches the sign-in page at once
    expect(s.emailOn.value).toBe(true);
    expect(await s.admin.testSmtp()).toEqual({ sent: true });
    expect(bodyOf(f.asked[1]!)).toEqual({});
    expect(await s.admin.removeSmtp()).toBeNull();
    expect(s.emailOn.value).toBe(false);
  });

  const smtp = (more: Partial<SmtpAnswer> = {}): SmtpAnswer => ({
    settings: {
      host: "smtp.example.com",
      port: 465,
      security: "tls",
      username: "m@example.com",
      key_name: "email-casey",
      from: "m@example.com",
      public_url: "https://markets.example.com",
      updated_at: "2026-11-01T00:00:00Z",
      updated_by: "operator",
    },
    key_names: ["email-casey"],
    email_on: true,
    key_missing: false,
    ...more,
  });

  test("SMTP is the operator's to change; another admin reads it", () => {
    const s = store(fake({}).fetch);
    s.admin.smtp.value = smtp();
    s.me.value = OPERATOR;
    const mine = render(<SmtpTab store={s} />);
    expect(mine).toContain(">Save</button>");
    expect(mine).toContain(">Remove</button>");
    expect(mine).toContain(">Send test email</button>");
    expect(mine).toContain("email-casey.key");
    expect(mine).not.toMatch(/<input[^>]*disabled/);
    expect(mine).not.toContain("placeholder");
    s.me.value = ADMIN;
    const theirs = render(<SmtpTab store={s} />);
    expect(theirs).not.toContain(">Save</button>");
    expect(theirs).not.toContain(">Remove</button>");
    expect(theirs).not.toContain("Send test email");
    expect(theirs.match(/<input[^>]*disabled/g)).toHaveLength(5);
    expect(theirs).toContain('value="smtp.example.com"');
  });

  test("SMTP says where a missing password file goes", () => {
    const s = store(fake({}).fetch);
    s.me.value = OPERATOR;
    s.admin.smtp.value = smtp({ email_on: false, key_missing: true });
    const html = render(<SmtpTab store={s} />);
    expect(html).toContain("Put the password in secrets/ as email-casey.key.");
    expect(html).toContain("Off");
    expect(html).not.toContain("Send test email");
  });

  test("Users says how to set up email while it is off", () => {
    const s = store(fake({}).fetch);
    s.me.value = OPERATOR;
    s.admin.people.value = [person()];
    s.admin.emailOn.value = false;
    const html = render(<AdminPage store={s} tab="users" />);
    expect(html).toContain("People can't be added until email is set up.");
    expect(html).toContain("Set up email");
    expect(html).toContain("Add person");
    s.admin.emailOn.value = true;
    expect(render(<AdminPage store={s} tab="users" />)).not.toContain(
      "Set up email",
    );
  });
});

describe("after the review", () => {
  test("the line under the boxes holds the longest address line", () => {
    const email = "a.very.long.address@an-example-domain.example.com";
    expect(holdLine(email)).toBe(`New code sent to ${email}`);
    for (const state of [
      { checking: true, error: null, resent: false },
      { checking: false, error: "Wrong or expired code.", resent: false },
      { checking: false, error: null, resent: false },
    ]) {
      expect(sayLine({ ...state, email }).length).toBeLessThanOrEqual(
        holdLine(email).length,
      );
    }
    expect(UNREAD).toBe("Couldn't load.");
  });

  test("a code taken but not read back is no wrong code", async () => {
    let reads = 0;
    const s = store(async (to) => {
      if (to === CODE_PATH) return Response.json({ landing: "/" });
      if (to === ME_PATH) {
        reads++;
        return reads === 1
          ? new Response(null, { status: 502 })
          : Response.json({ user: MEMBER, email_on: true });
      }
      throw new Error(to);
    });
    let went = 0;
    const err = await s
      .signInByCode("ana@example.com", "482913", () => went++)
      .catch((e) => e);
    // the landing was taken, so the page knows the code was right
    expect(went).toBe(1);
    expect((err as { status: number }).status).toBe(0);
    // the retry reads who it is, never the used code again
    expect(await s.check()).toBe(true);
    expect(s.me.value).toEqual(MEMBER);
  });

  test("an admin's server state never reaches the next person", async () => {
    let who: Me = OPERATOR;
    const s = store(async (to) => {
      if (to === ME_PATH) return Response.json({ user: who, email_on: true });
      if (to === "/api/v1/status") {
        return Response.json({ version: "v9.9.9", jobs: [] });
      }
      if (to === "/ui/session") return new Response(null, { status: 204 });
      throw new Error(to);
    });
    await s.check();
    await s.checkPulse();
    expect(s.pulse.value).not.toBeNull();
    await s.signOut();
    expect(s.pulse.value).toBeNull();
    who = MEMBER;
    await s.signIn("x");
    expect(s.pulse.value).toBeNull();
    // a member's footer names no version, whatever is held
    markets.pulse.value = { version: "v9.9.9" } as never;
    try {
      const foot = (me: Me) =>
        as(me, () =>
          render(
            <Page title="Home" foot="f">
              x
            </Page>,
          ),
        );
      expect(foot(MEMBER)).not.toContain("v9.9.9");
      expect(foot(OPERATOR)).toContain("v9.9.9");
    } finally {
      markets.pulse.value = null;
    }
  });

  test("a status read from before a sign-out lands nowhere", async () => {
    const late = Promise.withResolvers<Response>();
    const s = store(async (to, init) => {
      if (init?.method === "DELETE") return new Response(null, { status: 204 });
      if (to === "/api/v1/status") return late.promise;
      throw new Error(to);
    });
    const reading = s.checkPulse();
    await s.signOut();
    late.resolve(Response.json({ version: "v9.9.9", jobs: [] }));
    await reading;
    expect(s.pulse.value).toBeNull();
  });

  test("Recent goes when signed out", () => {
    recent.value = [{ id: "US:AMD", name: "AMD" }];
    forgetRecent(true);
    forgetRecent(undefined);
    expect(recent.value).toHaveLength(1);
    forgetRecent(false);
    expect(recent.value).toEqual([]);
  });

  test("the avatar is the key for the admin key's person, a person for anyone else", () => {
    const icon = (me: Me) =>
      as(me, () => render(<Rail here="/" onHide={() => {}} />)).match(
        /<span class="avatar">.*?<\/span>/,
      )![0];
    const KEY = "M5.5 13.5a3 3 0 1 0 0-6";
    expect(icon(OPERATOR)).toContain(KEY);
    expect(icon(MEMBER)).not.toContain(KEY);
    expect(icon(ADMIN)).not.toContain(KEY);
  });

  test("failures and refusals read in plain words", () => {
    for (const r of [
      "auth",
      "tls",
      "connect",
      "rejected",
      "timeout",
      "other",
    ]) {
      expect(failureWords(r)).not.toContain(r);
    }
    expect(failureWords("odd")).toBe("Sending failed");
    expect(inviteFailed("timeout")).toBe(
      "Invite not sent. The mail server didn't answer in time.",
    );
    expect(inviteFailed("auth", true)).toBe(
      "Added, but the invite wasn't sent. The mail server refused the login.",
    );
    expect(plainError("Username is required with a key_name.")).toBe(
      "Add the username for the password file.",
    );
    expect(plainError("Key_name is required with a username.")).toBe(
      "Pick a password file for the username.",
    );
    expect(plainError("Missing host, key_name, public_url.")).toBe(
      "Fill in Host, Password file, Link address.",
    );
    expect(plainError("Port must be 1 to 65535.")).toBe(
      "Port is a number from 1 to 65535.",
    );
    expect(plainError("Public_url must be an origin, with no path.")).toBe(
      "Link address has no path.",
    );
    expect(plainError("Another person has this email.")).toBe(
      "Someone else has this email.",
    );
    expect(plainError("Email is not set up.")).toBe("Email isn't set up yet.");
    expect(plainError("Something new.")).toBe("Something new.");
  });

  test("the reader's own row: no Remove, role locked, their name and the operator's email", () => {
    const own = person({ id: ADMIN.id, name: ADMIN.name, role: "admin" });
    expect(personItems(own, true)).toEqual(["signout"]);
    expect(personItems(person(), false)).toEqual(["signout", "remove"]);
    expect(personItems(person({ last_sign_in_at: null }), false)).toEqual([
      "invite",
      "signout",
      "remove",
    ]);
    const op = person({
      id: "operator",
      name: "Casey",
      email: null,
      role: "admin",
      operator: true,
    });
    expect(personItems(op, true)).toEqual([]);
  });

  test("names and the operator's email are saved through their routes", async () => {
    const f = fake({
      [`PATCH ${ME_PATH}`]: () =>
        Response.json({
          user: { ...OPERATOR, name: "Casey P" },
          email_on: true,
        }),
      "PATCH /api/v1/users/ana": ok({ user: person({ name: "Ana B" }) }),
    });
    const s = store(f.fetch);
    s.me.value = OPERATOR;
    s.admin.people.value = [
      person({ id: "operator", name: "Casey", operator: true }),
      person(),
    ];
    expect(await s.setMyName("Casey P")).toBeNull();
    expect(s.me.value?.name).toBe("Casey P");
    expect(s.admin.people.value[0]!.name).toBe("Casey P");
    expect(bodyOf(f.asked[0]!)).toEqual({ name: "Casey P" });
    expect(await s.admin.setPerson("ana", { name: "Ana B" })).toBeNull();
    expect(bodyOf(f.asked[1]!)).toEqual({ name: "Ana B" });
    const g = fake({ [`PATCH ${ME_PATH}`]: ok({ link: "sent" }) });
    const t = store(g.fetch);
    expect(await t.setMyEmail("casey@example.com")).toEqual({ sent: true });
    expect(bodyOf(g.asked[0]!)).toEqual({ email: "casey@example.com" });
  });

  test("the test email waits for the reader's own email; no files, a picker that says so", () => {
    const s = store(fake({}).fetch);
    s.me.value = OPERATOR;
    s.admin.smtp.value = {
      settings: null,
      key_names: [],
      email_on: true,
      key_missing: false,
    };
    const html = render(<SmtpTab store={s} />);
    expect(html).toContain("Add your email to send a test.");
    expect(html).toMatch(/disabled[^>]*>Send test email/);
    expect(html).toMatch(/aria-label="Password file"[^>]*disabled/);
    expect(html).toContain("No files");
    s.me.value = { ...OPERATOR, email: "casey@example.com" };
    const mine = render(<SmtpTab store={s} />);
    expect(mine).not.toContain("Add your email to send a test.");
    expect(mine).not.toMatch(/disabled[^>]*>Send test email/);
  });

  test("the code boxes keep their digits' size on a phone, and the line its height", async () => {
    const base = await Bun.file("src/web/style/base.css").text();
    const touch = base.slice(base.indexOf("@media (pointer: coarse)"));
    expect(touch.slice(0, touch.indexOf("}"))).toContain(
      "input:not(.signin-box),",
    );
    const signin = await Bun.file("src/web/views/signin.css").text();
    expect(signin).toMatch(/\.signin-say > span \{\s*grid-area: 1 \/ 1;/);
    expect(signin).toMatch(/\.signin-say-hold \{\s*visibility: hidden;/);
  });

  test("a code taken but not read back retries the read, and starts over on a new code", async () => {
    const posted: string[] = [];
    let reads: ("in" | "nobody" | "failed")[] = [];
    let take = true;
    const flow = codeFlow({
      post: async (code, landed) => {
        posted.push(code);
        if (!take) throw new Error("wrong code");
        landed();
        // the read after the code failed
        throw new Error("the server failed");
      },
      read: async () => reads.shift()!,
    });
    expect(await flow.submit("482913")).toEqual({ kind: "unread" });
    expect(flow.accepted()).toBe(true);
    // Try again reads who it is, never the used code
    reads = ["failed", "in"];
    expect(await flow.retry()).toEqual({ kind: "unread" });
    expect(await flow.submit("482913")).toEqual({ kind: "in" });
    expect(posted).toEqual(["482913"]);
    // the login gone meanwhile: a new code is asked, and posted
    reads = ["nobody"];
    expect(await flow.retry()).toEqual({ kind: "wrong", error: null });
    expect(flow.accepted()).toBe(false);
    take = false;
    const wrong = await flow.submit("111111");
    expect(wrong.kind).toBe("wrong");
    expect(posted).toEqual(["482913", "111111"]);
    // a new code or another email starts over after a taken code
    take = true;
    await flow.submit("222222");
    expect(flow.accepted()).toBe(true);
    flow.reset();
    take = false;
    await flow.submit("333333");
    expect(posted.at(-1)).toBe("333333");
  });

  test("the operator's Email field shows only while email is on", () => {
    const s = store(fake({}).fetch);
    s.me.value = OPERATOR;
    const op = person({
      id: "operator",
      name: "Casey",
      email: null,
      role: "admin",
      operator: true,
    });
    const drawer = () =>
      render(
        <PersonDetails store={s} person={op} now={NOW} onClose={() => {}} />,
      );
    s.admin.emailOn.value = false;
    expect(drawer()).not.toContain('type="email"');
    expect(drawer()).toContain('<span class="label">Name</span>');
    s.admin.emailOn.value = true;
    expect(drawer()).toContain('type="email"');
  });

  test("Try again after a failed read names nobody through the real store", async () => {
    let reads = 0;
    const s = store(async (to) => {
      if (to === CODE_PATH) return Response.json({ landing: "/" });
      if (to === ME_PATH) {
        reads++;
        if (reads === 2) return new Response(null, { status: 502 });
        return Response.json({ user: null, email_on: true });
      }
      throw new Error(to);
    });
    // the sign-in page: nobody signed in yet
    await s.check();
    expect(s.signedIn.value).toBe(false);
    const flow = codeFlow({
      post: (code, landed) => s.signInByCode("ana@example.com", code, landed),
      read: () => s.whoIs(),
    });
    expect(await flow.submit("482913")).toEqual({ kind: "unread" });
    expect(s.statusError.value).not.toBeNull();
    // Try again: the server now names nobody, so a new code is asked
    expect(await flow.retry()).toEqual({ kind: "wrong", error: null });
    expect(s.statusError.value).toBeNull();
    expect(flow.accepted()).toBe(false);
  });
});
