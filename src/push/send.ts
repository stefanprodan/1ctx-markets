// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// Fired alerts go out after the write that stored them, never inside one:
// a pass reads past the cursor, posts, then moves it in a short write.

import { readInstrument } from "../market/instruments.ts";
import { storedTrigger, type TriggerItem } from "../operations/alerts.ts";
import { readSeen } from "../rules/store.ts";
import type { Clock } from "../runtime/clock.ts";
import { errorFields, type Log } from "../runtime/log.ts";
import type { Fetch } from "../sources/source.ts";
import type { Db } from "../storage/db/index.ts";
import type { Writer } from "../storage/writer.ts";
import {
  type Bytes,
  encrypt,
  fromB64url,
  toB64url,
  type Vapid,
  vapidAuth,
} from "./crypto.ts";
import {
  dropSubscription,
  markSent,
  ownerSubscriptions,
  type Subscription,
  sentUpTo,
} from "./store.ts";
import { type Listing, notification } from "./text.ts";

// past an hour, a price alert describes a market that moved on
export const TTL_S = 3600;
export const PUSH_TIMEOUT_MS = 10_000;
// the Alerts page's Fired tab
export const FIRED_PATH = "/alerts/history";
// Apple's limit is 4 KB; the record adds 103 bytes
const MAX_PAYLOAD = 3800;
const PASS_ALERTS = 100;

export type Payload = {
  title: string;
  body: string;
  url: string;
  // the owner's alerts newer than their seen mark, as the rail counts
  badge: number;
  tag: string;
};

type Row = {
  id: number;
  owner: string;
  ruleId: number;
  firedAt: number;
  snapshot: string;
};

export function payloadOf(db: Db, row: Row, log: Log): Payload | null {
  const { item } = storedTrigger(row, log);
  if (!("when" in item)) return null;
  const t = item as TriggerItem;
  const ids = new Set<string>([t.symbol]);
  for (const key of Object.keys(t.values)) {
    for (const m of key.matchAll(/\(([^,)]+)(?:,\s*([^)]+))?\)/g)) {
      ids.add(m[1]!);
      if (m[2] !== undefined) ids.add(m[2]);
    }
  }
  const listings: Record<string, Listing> = {};
  for (const id of ids) {
    const i = readInstrument(db, id);
    if (i !== null) listings[id] = i;
  }
  const words = notification(t, listings);
  const p: Payload = {
    title: words.title,
    body: words.body,
    url: FIRED_PATH,
    badge: readSeen(db, row.owner).unseen,
    tag: `alert-${row.id}`,
  };
  // the note gives way first, then the name; the rest is small and fixed
  const cut = (s: string) => s.slice(0, Math.floor(s.length * 0.8));
  while (new TextEncoder().encode(JSON.stringify(p)).length > MAX_PAYLOAD) {
    if (p.body !== "") p.body = cut(p.body);
    else if (p.title !== "") p.title = cut(p.title);
    else break;
  }
  return p;
}

export type Push = {
  // the page's applicationServerKey, null while push is off
  publicKey(db: Db): string | null;
  // a pass soon, after the write that called it commits
  kick(): void;
  // the pass running and any it queued
  settled(): Promise<void>;
  close(): void;
};

export const NO_PUSH: Push = {
  publicKey: () => null,
  kick() {},
  settled: async () => {},
  close() {},
};

export function push(deps: {
  db: Db;
  writer: Writer;
  clock: Clock;
  log: Log;
  fetch: Fetch;
  keys: Vapid;
  // the VAPID contact, the origin sign-in links use; push is off without one
  origin: (db: Db) => string | null;
  // user-admin.key's login digest, so a device whose login no longer
  // signs in gets nothing
  adminDigest: string | null;
}): Push {
  const { db, writer, clock, log } = deps;
  const key = toB64url(deps.keys.publicKey);
  let running: Promise<void> | null = null;
  let again = false;
  let closed = false;

  const post = async (
    s: Subscription,
    body: Bytes,
    subject: string,
  ): Promise<number | null> => {
    const abort = new AbortController();
    const cancel = clock.at(clock.now() + PUSH_TIMEOUT_MS, () => abort.abort());
    try {
      const res = await deps.fetch(s.endpoint, {
        method: "POST",
        headers: {
          authorization: await vapidAuth(
            deps.keys,
            s.endpoint,
            subject,
            clock.now(),
          ),
          "content-encoding": "aes128gcm",
          "content-type": "application/octet-stream",
          ttl: String(TTL_S),
          urgency: "high",
        },
        body,
        signal: abort.signal,
        // a redirect would take the post past the endpoint's checked host
        redirect: "error",
      });
      await res.arrayBuffer().catch(() => {});
      return res.status;
    } catch {
      return null;
    } finally {
      cancel();
    }
  };

  // one alert to each of its owner's devices; the gone ones are returned
  const sendOne = async (
    row: Row,
    subject: string,
  ): Promise<Subscription[]> => {
    const gone: Subscription[] = [];
    if (clock.now() - row.firedAt > TTL_S * 1000) return gone;
    const subs = ownerSubscriptions(
      db,
      row.owner,
      clock.now(),
      deps.adminDigest,
    );
    if (subs.length === 0) return gone;
    const p = payloadOf(db, row, log);
    if (p === null) return gone;
    const text = new TextEncoder().encode(JSON.stringify(p));
    await Promise.all(
      subs.map(async (s) => {
        let body: Bytes;
        try {
          body = await encrypt(text, fromB64url(s.p256dh), fromB64url(s.auth));
        } catch {
          // keys no browser makes: the device can never read a push
          gone.push(s);
          return;
        }
        const status = await post(s, body, subject);
        if (status === 404 || status === 410) gone.push(s);
        else if (status === null || status < 200 || status > 299) {
          // never the endpoint: it is the device's capability
          log.warn("push failed", {
            alert: row.id,
            status: status ?? "network",
          });
        }
      }),
    );
    return gone;
  };

  const pass = async () => {
    for (;;) {
      if (closed) return;
      const subject = deps.origin(db);
      const from = sentUpTo(db);
      const rows = db
        .query<Row, [number, number]>(
          `select id, owner, rule_id as ruleId, fired_at as firedAt, snapshot
           from alerts where id > ? order by id limit ?`,
        )
        .all(from, PASS_ALERTS);
      if (rows.length === 0) return;
      for (const row of rows) {
        if (closed) return;
        let gone: Subscription[] = [];
        try {
          if (subject !== null) gone = await sendOne(row, subject);
        } catch (error) {
          // one alert that cannot go never holds back the ones after it
          log.error("push send failed", {
            alert: row.id,
            ...errorFields(error),
          });
        }
        await writer.write((w) => {
          for (const s of gone) dropSubscription(w, s);
          markSent(w, row.id);
        });
        if (gone.length > 0) {
          log.info("push subscriptions gone", { count: gone.length });
        }
      }
    }
  };

  const loop = async () => {
    // a microtask on, so the write that fired the alert has committed
    await Promise.resolve();
    do {
      again = false;
      try {
        await pass();
      } catch (error) {
        log.error("push pass failed", errorFields(error));
      }
    } while (again && !closed);
    // at once after the last check, so a kick from here on starts a loop
    running = null;
  };

  return {
    publicKey: (d) => (deps.origin(d) === null ? null : key),
    kick() {
      if (closed) return;
      if (running !== null) {
        again = true;
        return;
      }
      running = loop();
    },
    async settled() {
      while (running !== null) await running;
    },
    close() {
      closed = true;
    },
  };
}
