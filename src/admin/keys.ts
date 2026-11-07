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
  ALERTS_ACCESS,
  type AlertsAccess,
  ANALYSIS_ACCESS,
  type AnalysisAccess,
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
  MAX_NAME,
  MIN_NAME,
  PORTFOLIO_ACCESS,
  type PortfolioAccess,
  PROFILE_ACCESS,
  type ProfileAccess,
  revokeKey,
  setKeyAccess,
  TRADE_PLANS_ACCESS,
  type TradePlansAccess,
} from "../server/access.ts";
import { recheck } from "../server/caller.ts";

export type KeysDeps = {
  m: Markets;
  // keys a person may hold, from --max-keys
  maxKeys: number;
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
  alerts: k.alerts,
  profile: k.profile,
  analysis: k.analysis,
  trade_plans: k.tradePlans,
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
export const listAnswer = (m: Markets, who: Who, maxKeys: number) => {
  const names = namesOf(m);
  const list = isAdmin(m, who) ? allKeys(m.db) : listKeys(m.db, who.user);
  return json({ keys: list.map((k) => keyItem(k, names)), limit: maxKeys });
};

function portfolioOf(value: unknown): PortfolioAccess {
  if (!(PORTFOLIO_ACCESS as readonly unknown[]).includes(value)) {
    throw new ArgError(`portfolio is ${PORTFOLIO_ACCESS.join(", ")}`);
  }
  return value as PortfolioAccess;
}

function alertsOf(value: unknown): AlertsAccess {
  if (!(ALERTS_ACCESS as readonly unknown[]).includes(value)) {
    throw new ArgError(`alerts is ${ALERTS_ACCESS.join(", ")}`);
  }
  return value as AlertsAccess;
}

function profileOf(value: unknown): ProfileAccess {
  if (!(PROFILE_ACCESS as readonly unknown[]).includes(value)) {
    throw new ArgError(`profile is ${PROFILE_ACCESS.join(", ")}`);
  }
  return value as ProfileAccess;
}

function analysisOf(value: unknown): AnalysisAccess {
  if (!(ANALYSIS_ACCESS as readonly unknown[]).includes(value)) {
    throw new ArgError(`analysis is ${ANALYSIS_ACCESS.join(", ")}`);
  }
  return value as AnalysisAccess;
}

function tradePlansOf(value: unknown): TradePlansAccess {
  if (!(TRADE_PLANS_ACCESS as readonly unknown[]).includes(value)) {
    throw new ArgError(`trade_plans is ${TRADE_PLANS_ACCESS.join(", ")}`);
  }
  return value as TradePlansAccess;
}

function parseCreate(body: unknown): {
  name: string;
  days: KeyDays | null;
  portfolio: PortfolioAccess;
  alerts: AlertsAccess;
  profile: ProfileAccess;
  analysis: AnalysisAccess;
  tradePlans: TradePlansAccess;
} {
  const b = fields(body, [
    "name",
    "expiresInDays",
    "portfolio",
    "alerts",
    "profile",
    "analysis",
    "trade_plans",
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
    alerts: alertsOf(b.alerts ?? "none"),
    profile: profileOf(b.profile ?? "none"),
    analysis: analysisOf(b.analysis ?? "none"),
    tradePlans: tradePlansOf(b.trade_plans ?? "none"),
  };
}

function parseAccess(body: unknown): KeyAccess {
  const b = fields(body, [
    "portfolio",
    "alerts",
    "profile",
    "analysis",
    "trade_plans",
  ]);
  if (
    b.portfolio === undefined &&
    b.alerts === undefined &&
    b.profile === undefined &&
    b.analysis === undefined &&
    b.trade_plans === undefined
  ) {
    throw new ArgError(
      "give portfolio, alerts, profile, analysis, trade_plans or more than one",
    );
  }
  return {
    ...(b.portfolio === undefined
      ? {}
      : { portfolio: portfolioOf(b.portfolio) }),
    ...(b.alerts === undefined ? {} : { alerts: alertsOf(b.alerts) }),
    ...(b.profile === undefined ? {} : { profile: profileOf(b.profile) }),
    ...(b.analysis === undefined ? {} : { analysis: analysisOf(b.analysis) }),
    ...(b.trade_plans === undefined
      ? {}
      : { tradePlans: tradePlansOf(b.trade_plans) }),
  };
}

export async function createOne(d: KeysDeps, who: Who, body: unknown) {
  const args = parseCreate(body);
  let made: { key: KeyRow; token: string };
  try {
    made = await d.m.writer.write((db) => {
      recheck(db);
      return createKey(db, who.user, args, d.m.clock.now(), d.maxKeys);
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
    alerts: key.alerts,
    profile: key.profile,
    analysis: key.analysis,
    trade_plans: key.tradePlans,
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
