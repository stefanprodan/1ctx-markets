// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// Each person's agent keys: a made key's token is answered once and joins
// the log mask first; a list or a log line names a key, never its token. An
// admin lists and revokes anyone's, by name and owner, and makes only
// their own.

import { json, NO_STORE, problem } from "../api/http.ts";
import { iso } from "../market/format.ts";
import { ArgError, fields } from "../operations/args.ts";
import type { Markets } from "../operations/markets.ts";
import type { Who } from "../operations/who.ts";
import {
  allKeys,
  createKey,
  isKeyId,
  isKeyName,
  KEY_DAYS,
  type KeyAccess,
  KeyConflict,
  type KeyDays,
  type KeyRow,
  listKeys,
  MAX_KEYS,
  MAX_NAME,
  MIN_NAME,
  PORTFOLIO_ACCESS,
  type PortfolioAccess,
  PROFILE_ACCESS,
  type ProfileAccess,
  RULES_ACCESS,
  type RulesAccess,
  revokeKey,
  setKeyAccess,
} from "../server/access.ts";
import { recheck } from "../server/caller.ts";

export type KeysDeps = {
  m: Markets;
  // hides a made token from every later log line
  mask: (token: string) => void;
};

// whose key it is, named for an admin's list
export const keyItem = (k: KeyRow, names: ReadonlyMap<string, string>) => ({
  id: k.id,
  name: k.name,
  owner: { id: k.user, name: names.get(k.user) ?? k.user },
  created_at: iso(k.createdAt),
  last_used_at: k.lastUsedAt === null ? null : iso(k.lastUsedAt),
  expires_at: k.expiresAt === null ? null : iso(k.expiresAt),
  portfolio: k.portfolio,
  rules: k.rules,
  profile: k.profile,
});

const namesOf = (m: Markets): Map<string, string> =>
  new Map(
    m.db
      .query<{ id: string; name: string }, []>("select id, name from users")
      .all()
      .map((u) => [u.id, u.name]),
  );

// an admin key or an admin's login; a key never reaches these routes
export const isAdmin = (m: Markets, who: Who): boolean =>
  who.credential.kind === "admin" ||
  m.db
    .query<{ role: string }, [string]>("select role from users where id = ?")
    .get(who.user)?.role === "admin";

// the caller's own keys; an admin's list holds everyone's
export const listAnswer = (m: Markets, who: Who) => {
  const names = namesOf(m);
  const list = isAdmin(m, who) ? allKeys(m.db) : listKeys(m.db, who.user);
  return json({ keys: list.map((k) => keyItem(k, names)), limit: MAX_KEYS });
};

function portfolioOf(value: unknown): PortfolioAccess {
  if (!(PORTFOLIO_ACCESS as readonly unknown[]).includes(value)) {
    throw new ArgError(`portfolio is ${PORTFOLIO_ACCESS.join(", ")}`);
  }
  return value as PortfolioAccess;
}

function rulesOf(value: unknown): RulesAccess {
  if (!(RULES_ACCESS as readonly unknown[]).includes(value)) {
    throw new ArgError(`rules is ${RULES_ACCESS.join(", ")}`);
  }
  return value as RulesAccess;
}

function profileOf(value: unknown): ProfileAccess {
  if (!(PROFILE_ACCESS as readonly unknown[]).includes(value)) {
    throw new ArgError(`profile is ${PROFILE_ACCESS.join(", ")}`);
  }
  return value as ProfileAccess;
}

function parseCreate(body: unknown): {
  name: string;
  days: KeyDays | null;
  portfolio: PortfolioAccess;
  rules: RulesAccess;
  profile: ProfileAccess;
} {
  const b = fields(body, [
    "name",
    "expiresInDays",
    "portfolio",
    "rules",
    "profile",
  ]);
  if (!isKeyName(b.name)) {
    throw new ArgError(
      `name is ${MIN_NAME} to ${MAX_NAME} lowercase letters, digits, dashes and underscores, starting with a letter or digit`,
    );
  }
  const days = b.expiresInDays ?? null;
  if (days !== null && !(KEY_DAYS as readonly unknown[]).includes(days)) {
    throw new ArgError(`expiresInDays is null, ${KEY_DAYS.join(", ")}`);
  }
  return {
    name: b.name,
    days: days as KeyDays | null,
    portfolio: portfolioOf(b.portfolio ?? "none"),
    rules: rulesOf(b.rules ?? "none"),
    profile: profileOf(b.profile ?? "none"),
  };
}

function parseAccess(body: unknown): KeyAccess {
  const b = fields(body, ["portfolio", "rules", "profile"]);
  if (
    b.portfolio === undefined &&
    b.rules === undefined &&
    b.profile === undefined
  ) {
    throw new ArgError("give portfolio, rules, profile or more than one");
  }
  return {
    ...(b.portfolio === undefined
      ? {}
      : { portfolio: portfolioOf(b.portfolio) }),
    ...(b.rules === undefined ? {} : { rules: rulesOf(b.rules) }),
    ...(b.profile === undefined ? {} : { profile: profileOf(b.profile) }),
  };
}

export async function createOne(d: KeysDeps, who: Who, body: unknown) {
  const args = parseCreate(body);
  let made: { key: KeyRow; token: string };
  try {
    made = await d.m.writer.write((db) => {
      recheck(db);
      return createKey(db, who.user, args, d.m.clock.now());
    });
  } catch (error) {
    if (error instanceof KeyConflict) return problem("conflict", error.message);
    throw error;
  }
  d.mask(made.token);
  d.m.log.info("key created", {
    key: made.key.id,
    key_name: made.key.name,
    user: made.key.user,
  });
  return json({ key: keyItem(made.key, namesOf(d.m)), token: made.token }, 201);
}

// the key's next request reads the new access, as a revoke holds
export async function setOne(d: KeysDeps, who: Who, id: string, body: unknown) {
  const change = parseAccess(body);
  const key = isKeyId(id)
    ? await d.m.writer.write((db) => {
        recheck(db);
        return setKeyAccess(db, who.user, id, change);
      })
    : null;
  if (key === null) return problem("not_found", "no such key");
  d.m.log.info("key access set", {
    key: key.id,
    key_name: key.name,
    portfolio: key.portfolio,
    rules: key.rules,
    profile: key.profile,
  });
  return json({ key: keyItem(key, namesOf(d.m)) });
}

// an admin revokes anyone's, re-checked as an admin when it is another's
export async function revokeOne(d: KeysDeps, who: Who, id: string) {
  const any = isAdmin(d.m, who);
  const gone = isKeyId(id)
    ? await d.m.writer.write((db) => {
        recheck(db);
        const own = revokeKey(db, who.user, id);
        if (own !== null || !any) return own;
        recheck(db, "admin");
        return revokeKey(db, null, id);
      })
    : null;
  if (gone === null) return problem("not_found", "no such key");
  d.m.log.info("key revoked", {
    key: gone.id,
    key_name: gone.name,
    user: gone.user,
    by: who.user,
  });
  return new Response(null, { status: 204, headers: NO_STORE });
}
