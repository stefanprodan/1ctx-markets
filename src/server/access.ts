// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// Who sent a request: user-admin.key, an agent key from the keys table, or no
// one. A token is never stored, logged or kept past its request.

import { createHash, timingSafeEqual } from "node:crypto";
import { DAY_MS, MINUTE_MS } from "../runtime/clock.ts";
import { errorFields, type Log } from "../runtime/log.ts";
import type { Db } from "../storage/db/index.ts";
import type { Writer } from "../storage/writer.ts";

// names the key's owner wherever it is pasted
export const KEY_PREFIX = "1ctx-markets-";
// 1ctx's default cap, expired keys included
export const MAX_KEYS = 5;
export const KEY_DAYS = [30, 90, 365] as const;
export type KeyDays = (typeof KEY_DAYS)[number];
// 1ctx's agent name rule
export const MIN_NAME = 2;
export const MAX_NAME = 80;
const NAME = /^[a-z0-9][a-z0-9_-]*$/;
const ID = /^[a-z0-9]{12}$/;
const ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

export const isKeyName = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length >= MIN_NAME &&
  value.length <= MAX_NAME &&
  NAME.test(value);

// the authors the server records for the web UI and the admin key, so a
// key by either name would read as the owner
export const RESERVED_NAMES: readonly string[] = ["web", "admin"];

export const isKeyId = (value: string): boolean => ID.test(value);

// what a key may do with portfolios, with alerts and their history, with the
// owner's profile and with the shared analysis; none unless the admin says
export const PORTFOLIO_ACCESS = ["none", "read", "write"] as const;
export type PortfolioAccess = (typeof PORTFOLIO_ACCESS)[number];
export const ALERTS_ACCESS = ["none", "read", "write"] as const;
export type AlertsAccess = (typeof ALERTS_ACCESS)[number];
export const PROFILE_ACCESS = ["none", "read", "write"] as const;
export type ProfileAccess = (typeof PROFILE_ACCESS)[number];
export const ANALYSIS_ACCESS = ["none", "read", "write"] as const;
export type AnalysisAccess = (typeof ANALYSIS_ACCESS)[number];

export type KeyRow = {
  id: string;
  // the person who made it, whose rows its agent reads and writes
  user: string;
  name: string;
  createdAt: number;
  // null never expires
  expiresAt: number | null;
  lastUsedAt: number | null;
  portfolio: PortfolioAccess;
  alerts: AlertsAccess;
  profile: ProfileAccess;
  analysis: AnalysisAccess;
};

export type Caller = { kind: "admin" } | { kind: "agent"; key: KeyRow };

type Raw = {
  id: string;
  user_id: string;
  name: string;
  created_at: number;
  expires_at: number | null;
  last_used_at: number | null;
  portfolio: PortfolioAccess;
  alerts: AlertsAccess;
  profile: ProfileAccess;
  analysis: AnalysisAccess;
};

const COLUMNS =
  "id, user_id, name, created_at, expires_at, last_used_at, portfolio, alerts, profile, analysis";

const rowOf = (raw: Raw): KeyRow => ({
  id: raw.id,
  user: raw.user_id,
  name: raw.name,
  createdAt: raw.created_at,
  expiresAt: raw.expires_at,
  lastUsedAt: raw.last_used_at,
  portfolio: raw.portfolio,
  alerts: raw.alerts,
  profile: raw.profile,
  analysis: raw.analysis,
});

// a token is 32 random bytes, so a plain hash cannot be reversed
export const tokenHash = (token: string): string =>
  createHash("sha256").update(token).digest("hex");

function newId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  let out = "";
  for (const b of bytes) out += ID_ALPHABET[b % ID_ALPHABET.length];
  return out;
}

const newToken = (): string =>
  KEY_PREFIX +
  Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");

// the person's own keys
export const listKeys = (db: Db, user: string): KeyRow[] =>
  db
    .query<Raw, [string]>(
      `select ${COLUMNS} from keys where user_id = ? order by created_at, rowid`,
    )
    .all(user)
    .map(rowOf);

export class KeyConflict extends Error {}

// inside a write, so the cap and the name hold against a concurrent create
export function createKey(
  db: Db,
  user: string,
  args: {
    name: string;
    days: KeyDays | null;
    portfolio?: PortfolioAccess;
    alerts?: AlertsAccess;
    profile?: ProfileAccess;
    analysis?: AnalysisAccess;
  },
  now: number,
): { key: KeyRow; token: string } {
  if (RESERVED_NAMES.includes(args.name))
    throw new KeyConflict("name reserved");
  // unique per person, as 1ctx's
  if (keyByName(db, user, args.name) !== null) {
    throw new KeyConflict("name taken");
  }
  const keys = listKeys(db, user);
  if (keys.length >= MAX_KEYS) throw new KeyConflict("too many keys");
  const key: KeyRow = {
    id: newId(),
    user,
    name: args.name,
    createdAt: now,
    expiresAt: args.days === null ? null : now + args.days * DAY_MS,
    lastUsedAt: null,
    portfolio: args.portfolio ?? "none",
    alerts: args.alerts ?? "none",
    profile: args.profile ?? "none",
    analysis: args.analysis ?? "none",
  };
  const token = newToken();
  db.query(
    `insert into keys
       (id, user_id, name, token_hash, created_at, expires_at, portfolio,
        alerts, profile, analysis)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    key.id,
    key.user,
    key.name,
    tokenHash(token),
    key.createdAt,
    key.expiresAt,
    key.portfolio,
    key.alerts,
    key.profile,
    key.analysis,
  );
  return { key, token };
}

export type KeyAccess = {
  portfolio?: PortfolioAccess;
  alerts?: AlertsAccess;
  profile?: ProfileAccess;
  analysis?: AnalysisAccess;
};

// the token, name and expiry stay; an expired key changes too
export function setKeyAccess(
  db: Db,
  user: string,
  id: string,
  change: KeyAccess,
): KeyRow | null {
  const raw = db
    .query<
      Raw,
      [
        string | null,
        string | null,
        string | null,
        string | null,
        string,
        string,
      ]
    >(
      `update keys set portfolio = coalesce(?, portfolio),
         alerts = coalesce(?, alerts), profile = coalesce(?, profile),
         analysis = coalesce(?, analysis)
       where id = ? and user_id = ? returning ${COLUMNS}`,
    )
    .get(
      change.portfolio ?? null,
      change.alerts ?? null,
      change.profile ?? null,
      change.analysis ?? null,
      id,
      user,
    );
  return raw === null ? null : rowOf(raw);
}

// user null: anyone's, for an admin
export function revokeKey(
  db: Db,
  user: string | null,
  id: string,
): KeyRow | null {
  const raw = db
    .query<Raw, [string, string | null]>(
      `delete from keys where id = ?1 and (?2 is null or user_id = ?2)
       returning ${COLUMNS}`,
    )
    .get(id, user);
  return raw === null ? null : rowOf(raw);
}

// every person's keys, for an admin
export const allKeys = (db: Db): KeyRow[] =>
  db
    .query<Raw, []>(`select ${COLUMNS} from keys order by created_at, rowid`)
    .all()
    .map(rowOf);

export function keyByName(db: Db, user: string, name: string): KeyRow | null {
  const raw = db
    .query<Raw, [string, string]>(
      `select ${COLUMNS} from keys where user_id = ? and name = ?`,
    )
    .get(user, name);
  return raw === null ? null : rowOf(raw);
}

function keyByToken(db: Db, token: string): KeyRow | null {
  const raw = db
    .query<Raw, [string]>(`select ${COLUMNS} from keys where token_hash = ?`)
    .get(tokenHash(token));
  return raw === null ? null : rowOf(raw);
}

const digest = (value: string): Buffer =>
  createHash("sha256").update(value).digest();

// both sides hashed, so the compare takes the same time whatever was sent
export function bearerCheck(key: string): (sent: string) => boolean {
  const want = digest(key);
  return (sent) => timingSafeEqual(digest(sent), want);
}

export const bearerOf = (req: Request): string | null =>
  /^Bearer +(\S+)$/i.exec(req.headers.get("authorization") ?? "")?.[1] ?? null;

export type Access = {
  // the request's key, read anew each time, so a revoke holds on the next
  // request; null for none, an unknown one or an expired one
  caller(req: Request): Caller | null;
};

export function access(deps: {
  db: Db;
  writer: Writer;
  // with none, only agent keys open anything
  adminKey: string | null;
  now: () => number;
  log: Log;
}): Access {
  const isAdmin =
    deps.adminKey === null ? () => false : bearerCheck(deps.adminKey);
  // when each key's last use was queued, so a burst before the write lands
  // queues one write, not one a call
  const queued = new Map<string, number>();
  return {
    caller(req) {
      const sent = bearerOf(req);
      if (sent === null) return null;
      if (isAdmin(sent)) return { kind: "admin" };
      const key = keyByToken(deps.db, sent);
      const now = deps.now();
      if (key === null || (key.expiresAt !== null && key.expiresAt <= now)) {
        return null;
      }
      // at most once a minute, so a busy agent costs no write per call
      const last = Math.max(
        key.lastUsedAt ?? Number.NEGATIVE_INFINITY,
        queued.get(key.id) ?? Number.NEGATIVE_INFINITY,
      );
      if (now - last >= MINUTE_MS) {
        queued.set(key.id, now);
        void deps.writer
          .write((db) =>
            db
              .query(
                `update keys set last_used_at = ? where id = ?
                 and (last_used_at is null or last_used_at <= ?)`,
              )
              .run(now, key.id, now - MINUTE_MS),
          )
          .catch((error: unknown) => {
            deps.log.error("key use write failed", {
              key: key.id,
              ...errorFields(error),
            });
          });
      }
      return { kind: "agent", key };
    },
  };
}
