// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// A write re-reads the credential that sent it, inside its transaction, as
// 1ctx's checkKey(): a key revoked, a login ended or a person removed or
// demoted mid-call writes nothing. The router runs each request under its
// own check; a write of a person's rows calls recheck() first. Shared work
// (a fetch two callers wait on, a job) never calls it, so one caller's
// revoke never fails another's read.

import { AsyncLocalStorage } from "node:async_hooks";
import type { Who } from "../operations/who.ts";
import type { Db } from "../storage/db/index.ts";

// person: the credential and its person are still there; admin: and the
// person is still an admin
export type Need = "person" | "admin";
type Check = (db: Db, need: Need) => void;

export class CallerGone extends Error {
  constructor(
    readonly status: 401 | 403,
    message: string,
  ) {
    super(message);
    this.name = "CallerGone";
  }
}

const current = new AsyncLocalStorage<Check>();

// fn and everything it awaits writes as this check allows
export const asCaller = <T>(check: Check, fn: () => T): T =>
  current.run(check, fn);

// outside a request (a job, a test calling a write directly) it passes
export function recheck(db: Db, need: Need = "person"): void {
  current.getStore()?.(db, need);
}

type Row = { expires_at: number | null; role: string; digest?: string | null };

export function checkOf(
  who: Who,
  deps: { adminDigest: string | null; now: () => number },
): Check {
  return (db, need) => {
    const c = who.credential;
    if (c.kind === "admin") return;
    if (c.kind === "none") throw new CallerGone(401, "no or wrong key");
    if (c.kind === "key") {
      const r = db
        .query<Row, [string, string]>(
          `select k.expires_at, u.role from keys k
           join users u on u.id = k.user_id where k.id = ? and k.user_id = ?`,
        )
        .get(c.id, who.user);
      if (r === null || (r.expires_at !== null && r.expires_at <= deps.now())) {
        throw new CallerGone(401, "the key was revoked or expired");
      }
      if (need === "admin") {
        throw new CallerGone(403, "this key does not open this route");
      }
      return;
    }
    const r = db
      .query<Row, [string, string]>(
        `select l.expires_at, l.admin_digest as digest, u.role from logins l
         join users u on u.id = l.user_id where l.id = ? and l.user_id = ?`,
      )
      .get(c.id, who.user);
    if (
      r === null ||
      (r.expires_at !== null && r.expires_at <= deps.now()) ||
      (r.digest != null && r.digest !== deps.adminDigest)
    ) {
      throw new CallerGone(401, "signed out");
    }
    if (need === "admin" && r.role !== "admin") {
      throw new CallerGone(403, "for admins only");
    }
  };
}
