// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// Passkeys and their challenges as rows. A challenge row holds only the
// SHA-256 of 32 random bytes and is deleted by the answer that uses it, so
// a replay finds none; every function here runs inside a write but the
// reads.

import { iso } from "../../market/format.ts";
import type { Bytes } from "../../push/crypto.ts";
import { MINUTE_MS } from "../../runtime/clock.ts";
import type { Db } from "../../storage/db/index.ts";
import { newId, newToken, sha256 } from "../session.ts";
import type { Alg } from "./checks.ts";

// counted across hosts
export const PASSKEYS_PER_USER = 10;
export const CHALLENGE_MS = 2 * MINUTE_MS;

export type Purpose = "add" | "sign_in";

// the origin binds a challenge to the page that asked, port included
type Scope = {
  purpose: Purpose;
  rpId: string;
  origin: string;
  login: string | null;
};

// expired rows go in the same write, so anonymous asks never pile up
export function newChallenge(db: Db, scope: Scope, now: number): string {
  db.query("delete from passkey_challenges where expires_at <= ?").run(now);
  const challenge = newToken();
  db.query(
    `insert into passkey_challenges (id, challenge_hash, purpose, login_id,
       rp_id, origin, expires_at) values (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    newId(),
    sha256(challenge),
    scope.purpose,
    scope.login,
    scope.rpId,
    scope.origin,
    now + CHALLENGE_MS,
  );
  return challenge;
}

// true once: the unexpired row of this purpose, origin and login, deleted
export const takeChallenge = (
  db: Db,
  challenge: string,
  scope: Scope,
  now: number,
): boolean =>
  db
    .query(
      `delete from passkey_challenges where challenge_hash = ?
         and purpose = ? and rp_id = ? and origin = ? and login_id is ?
         and expires_at > ?`,
    )
    .run(
      sha256(challenge),
      scope.purpose,
      scope.rpId,
      scope.origin,
      scope.login,
      now,
    ).changes === 1;

type Raw = {
  id: string;
  user_id: string;
  rp_id: string;
  origin: string;
  credential_id: string;
  public_key: Uint8Array;
  alg: number;
  sign_count: number;
  transports: string;
  device: string;
  admin_digest: string | null;
  created_at: number;
  last_used_at: number | null;
};

export type Passkey = {
  id: string;
  user: string;
  rpId: string;
  origin: string;
  credentialId: string;
  publicKey: Bytes;
  alg: number;
  signCount: number;
  transports: string[];
  device: string;
  adminDigest: string | null;
  createdAt: number;
  lastUsedAt: number | null;
};

const passkeyOf = (r: Raw): Passkey => ({
  id: r.id,
  user: r.user_id,
  rpId: r.rp_id,
  origin: r.origin,
  credentialId: r.credential_id,
  publicKey: new Uint8Array(r.public_key),
  alg: r.alg,
  signCount: r.sign_count,
  transports: JSON.parse(r.transports) as string[],
  device: r.device,
  adminDigest: r.admin_digest,
  createdAt: r.created_at,
  lastUsedAt: r.last_used_at,
});

// what GET /ui/passkeys answers of each; the credential id lets the page
// ask the browser to forget a removed one, never its key
export const passkeyItem = (p: Passkey) => ({
  id: p.id,
  credential_id: p.credentialId,
  origin: p.origin,
  device: p.device,
  created_at: iso(p.createdAt),
  last_used_at: iso(p.lastUsedAt),
});

export const userPasskeys = (db: Db, user: string): Passkey[] =>
  db
    .query<Raw, [string]>(
      "select * from passkeys where user_id = ? order by created_at, id",
    )
    .all(user)
    .map(passkeyOf);

export const countPasskeys = (db: Db, user: string): number =>
  db
    .query<{ n: number }, [string]>(
      "select count(*) as n from passkeys where user_id = ?",
    )
    .get(user)!.n;

export function findPasskey(db: Db, credentialId: string): Passkey | null {
  const r = db
    .query<Raw, [string]>("select * from passkeys where credential_id = ?")
    .get(credentialId);
  return r === null ? null : passkeyOf(r);
}

export type NewPasskey = {
  user: string;
  rpId: string;
  origin: string;
  credentialId: string;
  publicKey: Bytes;
  alg: Alg;
  signCount: number;
  transports: string[];
  device: string;
  adminDigest: string | null;
};

// null when the credential is already a row, whoever's
export function insertPasskey(
  db: Db,
  p: NewPasskey,
  now: number,
): Passkey | null {
  const r = db
    .query<Raw, (string | number | Bytes | null)[]>(
      `insert into passkeys (id, user_id, rp_id, origin, credential_id,
         public_key, alg, sign_count, transports, device, admin_digest,
         created_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       on conflict (credential_id) do nothing
       returning *`,
    )
    .get(
      newId(),
      p.user,
      p.rpId,
      p.origin,
      p.credentialId,
      p.publicKey,
      p.alg,
      p.signCount,
      JSON.stringify(p.transports),
      p.device,
      p.adminDigest,
      now,
    );
  return r === null ? null : passkeyOf(r);
}

// a sign-in's count and time, only while the row still holds the count
// the checks read, so two answers racing move it once
export const usePasskey = (
  db: Db,
  id: string,
  from: number,
  to: number,
  now: number,
): boolean =>
  db
    .query(
      `update passkeys set sign_count = ?, last_used_at = ?
       where id = ? and sign_count = ?`,
    )
    .run(to, now, id, from).changes === 1;

export const removePasskey = (db: Db, user: string, id: string): boolean =>
  db.query("delete from passkeys where id = ? and user_id = ?").run(id, user)
    .changes === 1;
