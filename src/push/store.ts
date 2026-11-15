// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// A device's subscription is its login's: logins cascade them away.

import type { Db } from "../storage/db/index.ts";

export type Subscription = {
  id: number;
  owner: string;
  endpoint: string;
  p256dh: string;
  auth: string;
};

// a device signed in as another person takes its endpoint over
export function saveSubscription(
  db: Db,
  owner: string,
  login: string,
  s: Pick<Subscription, "endpoint" | "p256dh" | "auth">,
  now: number,
): void {
  db.query(
    `insert into push_subscriptions (owner, login, endpoint, p256dh, auth,
       created_at) values (?1, ?2, ?3, ?4, ?5, ?6)
     on conflict (endpoint) do update set owner = ?1, login = ?2,
       p256dh = ?4, auth = ?5, created_at = ?6`,
  ).run(owner, login, s.endpoint, s.p256dh, s.auth, now);
}

export const removeSubscription = (
  db: Db,
  login: string,
  endpoint: string,
): boolean =>
  db
    .query("delete from push_subscriptions where login = ? and endpoint = ?")
    .run(login, endpoint).changes > 0;

export const loginEndpoints = (db: Db, login: string): string[] =>
  db
    .query<{ endpoint: string }, [string]>(
      "select endpoint from push_subscriptions where login = ? order by id",
    )
    .all(login)
    .map((r) => r.endpoint);

export const ownerSubscriptions = (db: Db, owner: string): Subscription[] =>
  db
    .query<Subscription, [string]>(
      `select id, owner, endpoint, p256dh, auth from push_subscriptions
       where owner = ? order by id`,
    )
    .all(owner);

// gone at the push service: matched by endpoint too, so a row saved again
// meanwhile stays
export function dropSubscription(db: Db, s: Subscription): void {
  db.query("delete from push_subscriptions where id = ? and endpoint = ?").run(
    s.id,
    s.endpoint,
  );
}

export const sentUpTo = (db: Db): number =>
  db
    .query<{ alert: number }, []>("select alert from push_sent where id = 1")
    .get()?.alert ?? 0;

// forward only, so a pass that ran late never sends one again
export function markSent(db: Db, alert: number): void {
  db.query(
    `insert into push_sent (id, alert) values (1, ?1)
     on conflict (id) do update set alert = max(alert, ?1)`,
  ).run(alert);
}
