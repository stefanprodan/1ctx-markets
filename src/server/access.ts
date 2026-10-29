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

export const isKeyId = (value: string): boolean => ID.test(value);

export type KeyRow = {
  id: string;
  name: string;
  createdAt: number;
  // null never expires
  expiresAt: number | null;
  lastUsedAt: number | null;
};

export type Caller = { kind: "admin" } | { kind: "agent"; key: KeyRow };

type Raw = {
  id: string;
  name: string;
  created_at: number;
  expires_at: number | null;
  last_used_at: number | null;
};

const COLUMNS = "id, name, created_at, expires_at, last_used_at";

const rowOf = (raw: Raw): KeyRow => ({
  id: raw.id,
  name: raw.name,
  createdAt: raw.created_at,
  expiresAt: raw.expires_at,
  lastUsedAt: raw.last_used_at,
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

export const listKeys = (db: Db): KeyRow[] =>
  db
    .query<Raw, []>(`select ${COLUMNS} from keys order by created_at, rowid`)
    .all()
    .map(rowOf);

export class KeyConflict extends Error {}

// inside a write, so the cap and the name hold against a concurrent create
export function createKey(
  db: Db,
  args: { name: string; days: KeyDays | null },
  now: number,
): { key: KeyRow; token: string } {
  const keys = listKeys(db);
  if (keys.some((k) => k.name === args.name)) {
    throw new KeyConflict("name taken");
  }
  if (keys.length >= MAX_KEYS) throw new KeyConflict("too many keys");
  const key: KeyRow = {
    id: newId(),
    name: args.name,
    createdAt: now,
    expiresAt: args.days === null ? null : now + args.days * DAY_MS,
    lastUsedAt: null,
  };
  const token = newToken();
  db.query(
    `insert into keys (id, name, token_hash, created_at, expires_at)
     values (?, ?, ?, ?, ?)`,
  ).run(key.id, key.name, tokenHash(token), key.createdAt, key.expiresAt);
  return { key, token };
}

export function revokeKey(db: Db, id: string): KeyRow | null {
  const raw = db
    .query<Raw, [string]>(`delete from keys where id = ? returning ${COLUMNS}`)
    .get(id);
  return raw === null ? null : rowOf(raw);
}

export function keyByName(db: Db, name: string): KeyRow | null {
  const raw = db
    .query<Raw, [string]>(`select ${COLUMNS} from keys where name = ?`)
    .get(name);
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
