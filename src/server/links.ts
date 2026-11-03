// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// Sign-in links by email, as 1ctx's, cut down to a family's: an invite
// and a sign-in link, each with a six-digit code for the installed app,
// whose cookies are apart from the browser's. A link and its code are rows
// holding only a sha256; the token reaches no log and no answer, only the
// one email that carries it. Owning the inbox is the proof.

import { type Clock, DAY_MS, HOUR_MS, MINUTE_MS } from "../runtime/clock.ts";
import { errorFields, type Log } from "../runtime/log.ts";
import type { Db } from "../storage/db/index.ts";
import type { Writer } from "../storage/writer.ts";
import { recheck } from "./caller.ts";
import type { Email } from "./email/settings.ts";
import type { Failure } from "./email/smtp.ts";
import { newId, newToken, openLogin, sha256 } from "./session.ts";

export const SIGN_IN_MS = 15 * MINUTE_MS;
export const INVITE_MS = 7 * DAY_MS;
// the fifth wrong code kills the link
export const MAX_CODE_TRIES = 5;
// asks at the sign-in page, so nobody floods an inbox or the server's
// quota from it; invites are not counted. A person's cap is per asking
// browser, so a stranger's asks never use up the person's own
export const ASKS_PER_USER_DAY = 3;
export const ASKS_PER_CHALLENGE_HOUR = 5;
export const ASKS_PER_HOUR = 50;
// an invite or a test email answers by then, under Bun's 30 s idle
// limit; the send itself goes on
export const SEND_DEADLINE_MS = 25_000;
export const LINK_PATH = "/ui/link";

export type Purpose = "invite" | "sign_in";

// a six-digit code, uniform: a draw past the last whole million is drawn
// again
export function newCode(): string {
  const top = 4_294_000_000;
  for (;;) {
    const n = crypto.getRandomValues(new Uint32Array(1))[0]!;
    if (n < top) return String(n % 1_000_000).padStart(6, "0");
  }
}

// salted by the link, so one code's hash never matches another link's
const codeHash = (link: string, code: string) => sha256(`${link}:${code}`);

type Made = {
  id: string;
  user: string;
  token: string;
  // null for a link that sets an address, which takes no code
  code: string | null;
  purpose: Purpose;
  expiresAt: number;
};

// inside a write; an invite replaces the person's unused one, a sign-in
// link leaves earlier live ones working, so nobody's ask kills another's
export function createLink(
  db: Db,
  args: {
    user: string;
    purpose: Purpose;
    // the asking browser's challenge; null for an invite
    challenge: string | null;
    // the address it sets once used
    email?: string | null;
  },
  now: number,
): Made {
  if (args.purpose === "invite") {
    db.query(
      "delete from links where user_id = ? and purpose = 'invite' and used_at is null",
    ).run(args.user);
  }
  const id = newId();
  const token = newToken();
  // a link that sets an address opens no login, so no code is sent; its
  // hash is of a token nobody holds
  const code = args.email == null ? newCode() : null;
  const expiresAt = now + (args.purpose === "invite" ? INVITE_MS : SIGN_IN_MS);
  db.query(
    `insert into links (id, user_id, purpose, token_hash, code_hash,
       challenge_hash, email, created_at, expires_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    args.user,
    args.purpose,
    sha256(token),
    codeHash(id, code ?? newToken()),
    args.challenge === null ? null : sha256(args.challenge),
    args.email ?? null,
    now,
    expiresAt,
  );
  return { id, user: args.user, token, code, purpose: args.purpose, expiresAt };
}

// a person signed out everywhere: their logins and live links end
export function signOutEverywhere(db: Db, user: string): number {
  db.query("delete from links where user_id = ? and used_at is null").run(user);
  return db.query("delete from logins where user_id = ?").run(user).changes;
}

// the landing a used link opens: an invite's first stop is Portfolios,
// empty, with its setup
export const landingOf = (purpose: Purpose): string =>
  purpose === "invite" ? "/portfolios" : "/";

// login and token null: a link that set an address, and opened no login
type Used = {
  user: string;
  purpose: Purpose;
  link: string;
  login: string | null;
  token: string | null;
};

class Dead extends Error {}

// the conditional update a link and a code share: unused, unexpired, its
// person still there. A link that carries an address only sets it, and
// only for a browser already signed in as its person (signedIn), so one
// sent to a wrong address signs nobody in; it is set unless another
// person took it meanwhile
function use(
  db: Db,
  where: string,
  args: string[],
  now: number,
  signedIn: string | null,
): Used | null {
  const r = db
    .query<
      { id: string; user_id: string; purpose: Purpose; email: string | null },
      (string | number)[]
    >(
      `update links set used_at = ?1
       where used_at is null and expires_at > ?1 and ${where}
         and (email is null or user_id = ?3)
         and exists (select 1 from users u where u.id = links.user_id)
       returning id, user_id, purpose, email`,
    )
    .get(now, args[0]!, signedIn ?? "");
  if (r === null) return null;
  if (r.email !== null) {
    const set = db
      .query(
        `update users set email = ?1 where id = ?2
         and not exists (select 1 from users where email = ?1 and id <> ?2)`,
      )
      .run(r.email, r.user_id);
    if (set.changes === 0) throw new Dead();
    return {
      user: r.user_id,
      purpose: r.purpose,
      link: r.id,
      login: null,
      token: null,
    };
  }
  const login = openLogin(db, r.user_id, now);
  return {
    user: r.user_id,
    purpose: r.purpose,
    link: r.id,
    login: login.id,
    token: login.token,
  };
}

export type Sent = { sent: true } | { sent: false; failure: Failure };

export type Links = {
  // after the answer: an invited address within the caps gets a link and
  // a code bound to this challenge; anything else gets nothing
  ask(email: string, challenge: string): void;
  // a new invite, replacing an unused one, made as an admin; null while
  // email is off; past the deadline it answers timeout and goes on
  invite(user: string, email: string): Promise<Sent | null>;
  // a link to a new address, set once its person uses it signed in; null
  // while email is off
  confirm(user: string, email: string): Promise<Sent | null>;
  // the purpose of a live link, or null for a dead or unknown one
  live(token: string): Purpose | null;
  // a login, or a set address, or null for a dead link; current: the
  // browser's login
  useLink(
    token: string,
    current: { id: string; user: string } | null,
  ): Promise<Used | null>;
  // a login, or null for a wrong code, an unknown address or no challenge
  useCode(
    email: string,
    code: string,
    challenge: string | null,
    replaces: string | null,
  ): Promise<Used | null>;
  // the sends after their answers, which the shutdown awaits
  settled(): Promise<void>;
  // no new ask starts; one already answered still runs
  close(): void;
};

const signInText = (link: string, code: string) => ({
  subject: `Your markets sign-in code: ${code}`,
  text: `Sign in to markets: ${link}, or enter ${code}. Both work once, for 15 minutes.\n`,
});

const inviteText = (link: string, code: string) => ({
  subject: `Your markets sign-in code: ${code}`,
  text: `You were added to markets. Sign in: ${link}, or enter ${code}. Both work once, for 7 days.\n`,
});

const confirmText = (link: string) => ({
  subject: "Confirm your markets email",
  text: `Confirm this email for markets: ${link}. Open it where you are signed in to markets. It works once, for 15 minutes.\n`,
});

// p's answer, or late's once the clock passes ms; p goes on either way
export function deadline<T>(
  clock: Clock,
  p: Promise<T>,
  ms: number,
  late: T,
): Promise<T> {
  let cancel = () => {};
  const timer = new Promise<T>((resolve) => {
    cancel = clock.at(clock.now() + ms, () => resolve(late));
  });
  return Promise.race([p, timer]).finally(() => cancel());
}

export function links(deps: {
  db: Db;
  writer: Writer;
  email: Email;
  clock: Clock;
  log: Log;
}): Links {
  const now = () => deps.clock.now();
  const pending = new Set<Promise<unknown>>();
  let closed = false;
  const track = (p: Promise<unknown>) => {
    pending.add(p);
    void p.finally(() => pending.delete(p));
  };
  // the email for a made link; the reply never reaches a log, as it can
  // carry addresses
  const send = async (made: Made, to: string, invite: boolean) => {
    const origin = deps.email.origin(deps.db);
    if (origin === null) return null;
    const url = `${origin}${LINK_PATH}/${made.token}`;
    const m =
      made.code === null
        ? confirmText(url)
        : invite
          ? inviteText(url, made.code)
          : signInText(url, made.code);
    const result = await deps.email.send(
      deps.db,
      { name: "", address: to },
      m.subject,
      m.text,
    );
    if (result === null) return null;
    if (result.ok) {
      deps.log.info("link email sent", { user: made.user, link: made.id });
      return { sent: true } as const;
    }
    deps.log.warn("link email failed", {
      user: made.user,
      link: made.id,
      failure: result.failure,
    });
    return { sent: false, failure: result.failure } as const;
  };
  const askNow = async (address: string, challenge: string) => {
    if (!deps.email.on(deps.db)) return;
    const at = now();
    const asker = sha256(challenge);
    const made = await deps.writer.write((db) => {
      const u = db
        .query<{ id: string }, [string]>("select id from users where email = ?")
        .get(address);
      if (u === null) return null;
      const count = (sql: string, ...args: (string | number)[]) =>
        db.query<{ n: number }, (string | number)[]>(sql).get(...args)!.n;
      const day = count(
        `select count(*) as n from link_asks
         where user_id = ? and challenge_hash = ? and asked_at > ?`,
        u.id,
        asker,
        at - DAY_MS,
      );
      const browser = count(
        `select count(*) as n from link_asks
         where challenge_hash = ? and asked_at > ?`,
        asker,
        at - HOUR_MS,
      );
      const hour = count(
        "select count(*) as n from link_asks where asked_at > ?",
        at - HOUR_MS,
      );
      if (
        day >= ASKS_PER_USER_DAY ||
        browser >= ASKS_PER_CHALLENGE_HOUR ||
        hour >= ASKS_PER_HOUR
      ) {
        return { capped: u.id };
      }
      db.query(
        "insert into link_asks (user_id, challenge_hash, asked_at) values (?, ?, ?)",
      ).run(u.id, asker, at);
      return createLink(db, { user: u.id, purpose: "sign_in", challenge }, at);
    });
    if (made === null) return;
    if ("capped" in made) {
      deps.log.warn("link ask capped", { user: made.capped });
      return;
    }
    deps.log.info("link made", { user: made.user, link: made.id });
    await send(made, address, false);
  };
  const using = async (
    fn: (db: Db, now: number) => Used | null,
    replaces: string | null,
  ) => {
    const at = now();
    let used: Used | null;
    try {
      used = await deps.writer.write((db) => {
        const u = fn(db, at);
        // the tab's old login ends, so one browser holds one
        if (u !== null && u.login !== null && replaces !== null) {
          db.query("delete from logins where id = ? and id <> ?").run(
            replaces,
            u.login,
          );
        }
        return u;
      });
    } catch (error) {
      if (error instanceof Dead) return null;
      throw error;
    }
    if (used !== null) {
      deps.log.info("link used", {
        user: used.user,
        link: used.link,
        ...(used.login === null ? {} : { login: used.login }),
      });
    }
    return used;
  };
  return {
    ask(email, challenge) {
      if (closed) return;
      track(
        askNow(email, challenge).catch((error: unknown) => {
          deps.log.error("link ask failed", errorFields(error));
        }),
      );
    },
    async invite(user, email) {
      if (!deps.email.on(deps.db)) return null;
      // the admin re-read in the write that makes the link
      const made = await deps.writer.write((db) => {
        recheck(db, "admin");
        return createLink(
          db,
          { user, purpose: "invite", challenge: null },
          now(),
        );
      });
      deps.log.info("link made", { user, link: made.id, purpose: "invite" });
      const p = send(made, email, true);
      track(p);
      return deadline(deps.clock, p, SEND_DEADLINE_MS, {
        sent: false,
        failure: "timeout",
      });
    },
    async confirm(user, email) {
      if (!deps.email.on(deps.db)) return null;
      const made = await deps.writer.write((db) => {
        recheck(db);
        return createLink(
          db,
          { user, purpose: "sign_in", challenge: null, email },
          now(),
        );
      });
      deps.log.info("link made", { user, link: made.id });
      const p = send(made, email, false);
      track(p);
      return deadline(deps.clock, p, SEND_DEADLINE_MS, {
        sent: false,
        failure: "timeout",
      });
    },
    live(token) {
      const r = deps.db
        .query<{ purpose: Purpose }, [string, number]>(
          `select purpose from links l where token_hash = ? and used_at is null
           and expires_at > ? and exists (select 1 from users u where u.id = l.user_id)`,
        )
        .get(sha256(token), now());
      return r?.purpose ?? null;
    },
    useLink: (token, current) =>
      using(
        (db, at) =>
          use(
            db,
            "token_hash = ?2",
            [sha256(token)],
            at,
            current?.user ?? null,
          ),
        current?.id ?? null,
      ),
    useCode: (email, code, challenge, replaces) =>
      using((db, at) => {
        // a code is only tried beside the browser that asked, so nobody
        // burns another's tries; an invite, which no browser asked for,
        // takes any challenge
        if (challenge === null || !/^\d{6}$/.test(code)) return null;
        const asker = sha256(challenge);
        const u = db
          .query<{ id: string }, [string]>(
            "select id from users where email = ?",
          )
          .get(email);
        if (u === null) return null;
        // an invite's misses count per trying browser, which is dead for
        // that invite after the fifth; a link that sets an address takes
        // no code
        const tried = db
          .query<
            { id: string; code_hash: string; asked: number },
            [string, number, string, number]
          >(
            `select l.id, l.code_hash, l.challenge_hash is not null as asked
             from links l
             left join link_misses m
               on m.link_id = l.id and m.challenge_hash = ?3
             where l.user_id = ?1 and l.used_at is null and l.expires_at > ?2
               and l.email is null
               and (l.challenge_hash = ?3
                 or (l.challenge_hash is null and coalesce(m.misses, 0) < ?4))`,
          )
          .all(u.id, at, asker, MAX_CODE_TRIES);
        const hit = tried.find((l) => l.code_hash === codeHash(l.id, code));
        if (hit !== undefined) return use(db, "id = ?2", [hit.id], at, null);
        for (const l of tried) {
          if (l.asked) {
            db.query(
              `update links set code_tries = code_tries + 1,
                 used_at = case when code_tries + 1 >= ?2 then ?3 else used_at end
               where id = ?1`,
            ).run(l.id, MAX_CODE_TRIES, at);
          } else {
            db.query(
              `insert into link_misses (link_id, challenge_hash, misses)
               values (?, ?, 1) on conflict (link_id, challenge_hash)
               do update set misses = misses + 1`,
            ).run(l.id, asker);
          }
        }
        return null;
      }, replaces),
    async settled() {
      while (pending.size > 0) await Promise.allSettled([...pending]);
    },
    close() {
      closed = true;
    },
  };
}
