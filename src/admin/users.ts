// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// The people on the server, for admins: invite only, by email. An admin
// never reads another's portfolios, profile, dashboard or rules; they add,
// rename, promote, sign out and remove people. The operator always stays.

import { json, NO_STORE, problem } from "../api/http.ts";
import { iso } from "../market/format.ts";
import { ArgError, fields } from "../operations/args.ts";
import type { Markets } from "../operations/markets.ts";
import { OPERATOR, type Who } from "../operations/who.ts";
import { recheck } from "../server/caller.ts";
import { type Email, emailOf } from "../server/email/settings.ts";
import { type Links, type Sent, signOutEverywhere } from "../server/links.ts";
import { newId, type Role } from "../server/session.ts";
import type { Db } from "../storage/db/index.ts";

export const ROLES = ["admin", "member"] as const;
export const MAX_USER_NAME = 80;
const ID = /^[a-z0-9]{1,40}$/;

export type PeopleDeps = { m: Markets; email: Email; links: Links };

type Raw = {
  id: string;
  name: string;
  email: string | null;
  role: Role;
  created_at: number;
  last_sign_in_at: number | null;
  keys: number;
};

const userItem = (r: Raw) => ({
  id: r.id,
  name: r.name,
  email: r.email,
  role: r.role,
  operator: r.id === OPERATOR,
  created_at: iso(r.created_at),
  last_sign_in_at: iso(r.last_sign_in_at),
  keys: r.keys,
});

const SELECT = `select u.id, u.name, u.email, u.role, u.created_at,
    u.last_sign_in_at,
    (select count(*) from keys k where k.user_id = u.id) as keys
  from users u`;

const readUser = (db: Db, id: string): Raw | null =>
  db.query<Raw, [string]>(`${SELECT} where u.id = ?`).get(id);

const noUser = () => problem("not_found", "no such user");

const sentItem = (s: Sent) =>
  s.sent ? { invite: "sent" } : { invite: "failed", reason: s.failure };

function nameOf(value: unknown): string {
  const name = typeof value === "string" ? value.trim() : "";
  if (name === "" || name.length > MAX_USER_NAME || /\p{Cc}/u.test(name)) {
    throw new ArgError(`name is 1 to ${MAX_USER_NAME} characters on one line`);
  }
  return name;
}

function roleOf(value: unknown): Role {
  if (!(ROLES as readonly unknown[]).includes(value)) {
    throw new ArgError(`role is ${ROLES.join(" or ")}`);
  }
  return value as Role;
}

const idOf = (raw: string): string | null => (ID.test(raw) ? raw : null);

export function listUsers(d: PeopleDeps): Response {
  return json({
    users: d.m.db
      .query<Raw, []>(`${SELECT} order by u.created_at, u.id`)
      .all()
      .map(userItem),
    email_on: d.email.on(d.m.db),
  });
}

class Taken extends Error {}

export async function addUser(
  d: PeopleDeps,
  who: Who,
  body: unknown,
): Promise<Response> {
  const b = fields(body, ["name", "email", "role"]);
  const name = nameOf(b.name);
  const email = emailOf(b.email);
  if (email === null) throw new ArgError("email is an email address");
  const role = roleOf(b.role ?? "member");
  // without email nobody could ever sign in, so nobody is added
  if (!d.email.on(d.m.db)) {
    return problem("conflict", "email is not set up");
  }
  const id = newId();
  try {
    await d.m.writer.write((db) => {
      recheck(db, "admin");
      if (db.query("select 1 from users where email = ?").get(email) !== null) {
        throw new Taken();
      }
      db.query(
        `insert into users (id, name, email, role, created_at)
         values (?, ?, ?, ?, ?)`,
      ).run(id, name, email, role, d.m.clock.now());
    });
  } catch (error) {
    if (error instanceof Taken) {
      return problem("conflict", "another person has this email");
    }
    throw error;
  }
  d.m.log.info("user added", { user: id!, by: who.user });
  const sent = await d.links.invite(id, email);
  return json(
    {
      user: userItem(readUser(d.m.db, id)!),
      ...(sent === null
        ? { invite: "failed", reason: "other" }
        : sentItem(sent)),
    },
    201,
  );
}

export async function changeUser(
  d: PeopleDeps,
  who: Who,
  raw: string,
  body: unknown,
): Promise<Response> {
  const b = fields(body, ["name", "role"]);
  if (b.name === undefined && b.role === undefined) {
    throw new ArgError("give name, role or both");
  }
  const name = b.name === undefined ? null : nameOf(b.name);
  const role = b.role === undefined ? null : roleOf(b.role);
  const id = idOf(raw);
  if (id === null) return noUser();
  if (id === OPERATOR && role === "member") {
    return problem("conflict", "the operator stays an admin");
  }
  // an admin never demotes themself, so the last other admin's slip
  // never locks the Admin page away from them
  if (id === who.user && role !== null && role !== "admin") {
    return problem("conflict", "you cannot change your own role");
  }
  const done = await d.m.writer.write((db) => {
    recheck(db, "admin");
    return db
      .query(
        `update users set name = coalesce(?, name), role = coalesce(?, role)
         where id = ?`,
      )
      .run(name, role, id).changes;
  });
  if (done === 0) return noUser();
  d.m.log.info("user changed", { user: id!, by: who.user });
  return json({ user: userItem(readUser(d.m.db, id)!) });
}

export async function inviteAgain(
  d: PeopleDeps,
  who: Who,
  raw: string,
): Promise<Response> {
  const id = idOf(raw);
  const user = id === null ? null : readUser(d.m.db, id);
  if (user === null) return noUser();
  if (user.email === null) {
    return problem("conflict", "this person has no email");
  }
  if (!d.email.on(d.m.db)) {
    return problem("conflict", "email is not set up");
  }
  d.m.log.info("user invited", { user: user.id, by: who.user });
  const sent = await d.links.invite(user.id, user.email);
  return json(
    sent === null ? { invite: "failed", reason: "other" } : sentItem(sent),
  );
}

export async function signOutUser(
  d: PeopleDeps,
  who: Who,
  raw: string,
): Promise<Response> {
  const id = idOf(raw);
  const ended = await d.m.writer.write((db) => {
    recheck(db, "admin");
    if (id === null || readUser(db, id) === null) return null;
    return signOutEverywhere(db, id);
  });
  if (ended === null) return noUser();
  d.m.log.info("user signed out", { user: id!, by: who.user, logins: ended });
  return new Response(null, { status: 204, headers: NO_STORE });
}

// every table a person's rows live in, in the order they go: children
// before their parents
const OWNED: readonly { name: string; table: string; where: string }[] = [
  {
    name: "trades",
    table: "trades",
    where: "portfolio in (select id from portfolios where owner = ?1)",
  },
  {
    name: "positions",
    table: "positions",
    where: "portfolio in (select id from portfolios where owner = ?1)",
  },
  { name: "portfolios", table: "portfolios", where: "owner = ?1" },
  { name: "brokers", table: "brokers", where: "owner = ?1" },
  { name: "settings", table: "portfolio_settings", where: "owner = ?1" },
  { name: "profile", table: "profile_versions", where: "owner = ?1" },
  { name: "dashboard", table: "dashboard_items", where: "owner = ?1" },
  {
    name: "dashboard_sections",
    table: "dashboard_sections",
    where: "owner = ?1",
  },
  { name: "dashboards", table: "dashboards", where: "owner = ?1" },
  { name: "rules", table: "rules", where: "owner = ?1" },
  { name: "alerts", table: "alerts", where: "owner = ?1" },
  { name: "keys", table: "keys", where: "user_id = ?1" },
  { name: "logins", table: "logins", where: "user_id = ?1" },
  { name: "links", table: "links", where: "user_id = ?1" },
];

// what removing a person deletes, counted per kind the confirmation names
export function ownedCounts(db: Db, user: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const t of OWNED) {
    out[t.name] = db
      .query<{ n: number }, [string]>(
        `select count(*) as n from ${t.table} where ${t.where}`,
      )
      .get(user)!.n;
  }
  return out;
}

// one transaction across every owned table; fund prices they entered stay,
// being shared, their author's id set null by its reference
export function removeUserRows(db: Db, user: string): Record<string, number> {
  const counts = ownedCounts(db, user);
  for (const t of OWNED) {
    db.query(`delete from ${t.table} where ${t.where}`).run(user);
  }
  db.query("delete from users where id = ?").run(user);
  return counts;
}

export async function removeUser(
  d: PeopleDeps,
  who: Who,
  raw: string,
  dryRun: boolean,
): Promise<Response> {
  const id = idOf(raw);
  if (id === OPERATOR) {
    return problem("conflict", "the operator cannot be removed");
  }
  if (id === who.user) {
    return problem("conflict", "you cannot remove yourself");
  }
  const counts = await d.m.writer.write((db) => {
    recheck(db, "admin");
    if (id === null || readUser(db, id) === null) return null;
    return dryRun ? ownedCounts(db, id) : removeUserRows(db, id);
  });
  if (counts === null) return noUser();
  if (!dryRun) d.m.log.info("user removed", { user: id!, by: who.user });
  return json({ dry_run: dryRun, deleted: counts });
}
