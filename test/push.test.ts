// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { markets } from "../src/operations/markets.ts";
import {
  type Bytes,
  concat,
  contentKeys,
  encrypt,
  fromB64url,
  PUBLIC_KEY_BYTES,
  RECORD_SIZE,
  sharedSecret,
  TOKEN_S,
  toB64url,
  type Vapid,
  vapidAuth,
  vapidKeys,
} from "../src/push/crypto.ts";
import {
  FIRED_PATH,
  type Payload,
  payloadOf,
  push,
  TTL_S,
} from "../src/push/send.ts";
import { saveSubscription } from "../src/push/store.ts";
import { notification } from "../src/push/text.ts";
import { ruleEngine, type Snapshot } from "../src/rules/evaluate.ts";
import { insertAlert, markSeen, readSeen } from "../src/rules/store.ts";
import { HOUR_MS } from "../src/runtime/clock.ts";
import { createPush, keys, PUSH_FILE } from "../src/runtime/keys.ts";
import { type Log, silent } from "../src/runtime/log.ts";
import { openLogin, pruneLogins, SESSION_MS } from "../src/server/session.ts";
import type { Fetch } from "../src/sources/source.ts";
import { yahoo } from "../src/sources/yahoo/client.ts";
import { type Db, open } from "../src/storage/db/index.ts";
import { writer } from "../src/storage/writer.ts";
import page from "../src/web/index.html";
import { api, cookieFor, READ_KEY } from "./helpers/api.ts";
import { withApp } from "./helpers/app.ts";
import { fakeClock, START } from "./helpers/clock.ts";
import { instrument } from "./helpers/world.ts";

const b = fromB64url;

// RFC 8291, Appendix A
const RFC = {
  plaintext: "When I grow up, I want to be a watermelon",
  asPublic:
    "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
  asPrivate: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
  uaPublic:
    "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
  uaPrivate: "q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94",
  auth: "BTBZMqHH6r4Tts7J_aSIgg",
  salt: "DGv6ra1nlYgDCS1FRnbzlw",
  ecdh: "kyrL1jIIOHEzg3sM2ZWRHDRB62YACZhhSlknJ672kSs",
  cek: "oIhVW04MRdy2XN9CiKLxTg",
  nonce: "4h_95klXJ5E_qnoN",
  header:
    "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
  ciphertext:
    "8pfeW0KbunFT06SuDKoJH9Ql87S1QUrdirN6GcG7sFz1y1sqLgVi1VhjVkHsUoEsbI_0LpXMuGvnzQ",
};

// a P-256 private key from its raw parts, as JWK holds them
async function ecdhKey(publicRaw: string, privateRaw: string) {
  const pub = b(publicRaw);
  return crypto.subtle.importKey(
    "jwk",
    {
      kty: "EC",
      crv: "P-256",
      x: toB64url(pub.slice(1, 33)),
      y: toB64url(pub.slice(33, 65)),
      d: privateRaw,
    },
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"],
  );
}

// the browser's side: one aes128gcm record back to its plaintext
async function decrypt(
  body: Bytes,
  ua: CryptoKey,
  uaPublic: Bytes,
  auth: Bytes,
): Promise<string> {
  const salt = body.slice(0, 16);
  const rs = new DataView(body.buffer, body.byteOffset).getUint32(16);
  expect(rs).toBe(RECORD_SIZE);
  const idlen = body[20]!;
  const asPublic = body.slice(21, 21 + idlen);
  const ecdh = await sharedSecret(ua, asPublic);
  const { cek, nonce } = await contentKeys(
    ecdh,
    auth,
    uaPublic,
    asPublic,
    salt,
  );
  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, [
    "decrypt",
  ]);
  const padded = new Uint8Array(
    await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: nonce },
      key,
      body.slice(21 + idlen),
    ),
  );
  let end = padded.length - 1;
  while (padded[end] === 0) end--;
  expect(padded[end]).toBe(2);
  return new TextDecoder().decode(padded.slice(0, end));
}

describe("payload encryption", () => {
  test("matches RFC 8291's worked example and decrypts back", async () => {
    const as = await ecdhKey(RFC.asPublic, RFC.asPrivate);
    const ua = await ecdhKey(RFC.uaPublic, RFC.uaPrivate);
    const ecdh = await sharedSecret(as, b(RFC.uaPublic));
    expect(toB64url(ecdh)).toBe(RFC.ecdh);
    const keys = await contentKeys(
      ecdh,
      b(RFC.auth),
      b(RFC.uaPublic),
      b(RFC.asPublic),
      b(RFC.salt),
    );
    expect(toB64url(keys.cek)).toBe(RFC.cek);
    expect(toB64url(keys.nonce)).toBe(RFC.nonce);
    const body = await encrypt(
      new TextEncoder().encode(RFC.plaintext),
      b(RFC.uaPublic),
      b(RFC.auth),
      {
        sender: {
          pair: { privateKey: as, publicKey: as },
          publicRaw: b(RFC.asPublic),
        },
        salt: b(RFC.salt),
      },
    );
    const header = b(RFC.header);
    expect(toB64url(body.slice(0, header.length))).toBe(RFC.header);
    expect(toB64url(body.slice(header.length))).toBe(RFC.ciphertext);
    expect(
      await decrypt(
        concat(header, b(RFC.ciphertext)),
        ua,
        b(RFC.uaPublic),
        b(RFC.auth),
      ),
    ).toBe(RFC.plaintext);
  });

  test("a fresh key pair and salt each time, both readable", async () => {
    const device = await browser();
    const text = new TextEncoder().encode("made up");
    const one = await encrypt(text, device.publicRaw, device.auth);
    const two = await encrypt(text, device.publicRaw, device.auth);
    expect(toB64url(one.slice(0, 16))).not.toBe(toB64url(two.slice(0, 16)));
    for (const body of [one, two]) {
      expect(await device.read(body)).toBe("made up");
    }
  });
});

// a made-up browser: its subscription's keys and its decryption
async function browser() {
  const pair = (await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"],
  )) as CryptoKeyPair;
  const publicRaw = new Uint8Array(
    await crypto.subtle.exportKey("raw", pair.publicKey),
  );
  const auth = crypto.getRandomValues(new Uint8Array(16));
  return {
    publicRaw,
    auth,
    p256dh: toB64url(publicRaw),
    authText: toB64url(auth),
    read: (body: Bytes) => decrypt(body, pair.privateKey, publicRaw, auth),
  };
}

async function newVapid(): Promise<Vapid> {
  const pair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const pkcs8 = await crypto.subtle.exportKey("pkcs8", pair.privateKey);
  return (await vapidKeys(toB64url(pkcs8)))!;
}

describe("the VAPID token", () => {
  test("is an ES256 JWT for the endpoint's origin, verified by k", async () => {
    const v = await newVapid();
    const header = await vapidAuth(
      v,
      "https://web.push.apple.com/made-up-device",
      "https://markets.example.com",
      START,
    );
    const m = /^vapid t=([\w-]+)\.([\w-]+)\.([\w-]+), k=([\w-]+)$/.exec(header);
    expect(m).not.toBeNull();
    const [, head, claims, sig, k] = m!;
    const json = (s: string) =>
      JSON.parse(new TextDecoder().decode(b(s))) as Record<string, unknown>;
    expect(json(head!)).toEqual({ typ: "JWT", alg: "ES256" });
    expect(json(claims!)).toEqual({
      aud: "https://web.push.apple.com",
      exp: START / 1000 + TOKEN_S,
      sub: "https://markets.example.com",
    });
    expect(TOKEN_S).toBeLessThanOrEqual(24 * 3600);
    expect(b(k!).length).toBe(PUBLIC_KEY_BYTES);
    expect(k).toBe(toB64url(v.publicKey));
    const pub = await crypto.subtle.importKey(
      "raw",
      b(k!),
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
    expect(b(sig!).length).toBe(64);
    const ok = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      pub,
      b(sig!),
      new TextEncoder().encode(`${head}.${claims}`),
    );
    expect(ok).toBe(true);
  });

  test("the key file is made once, private, and anything else is refused", async () => {
    const dir = mkdtempSync(join(tmpdir(), "markets-push-"));
    try {
      const secrets = join(dir, "secrets");
      expect(await createPush(secrets)).toBe(true);
      const held = keys(secrets).push()!;
      expect(statSync(join(secrets, PUSH_FILE)).mode & 0o777).toBe(0o600);
      expect(await createPush(secrets)).toBe(false);
      expect(keys(secrets).push()).toBe(held);
      // the store masks it, as every key read
      expect(keys(secrets).values()).toEqual([]);
      const store = keys(secrets);
      store.push();
      expect(store.values()).toEqual([held]);
      const v = await vapidKeys(held);
      expect(v?.publicKey.length).toBe(PUBLIC_KEY_BYTES);
      expect(await vapidKeys("not a key")).toBeNull();
      // a key the server cannot read is a missing one, never a failed start
      chmodSync(join(secrets, PUSH_FILE), 0);
      expect(keys(secrets).push()).toBeNull();
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});

const NVDA = "US:NVDA";

const snapshot = (note: string | null = null): Snapshot => ({
  rule: {
    id: 1,
    symbol: NVDA,
    condition: { left: { field: "price", symbol: NVDA }, op: "<", right: 170 },
    note,
  },
  values: [
    {
      left: {
        field: "price",
        symbol: NVDA,
        value: 168.4,
        trade_time: "2026-10-26T14:00:00Z",
      },
      op: "<",
      right: 170,
      holds: true,
    },
  ],
});

const ORIGIN = "https://markets.example.com";

function setSmtp(db: Db) {
  db.query(
    `insert into smtp_settings (id, host, port, security, username, key_name,
       from_address, public_url, updated_at, updated_by)
     values (1, 'smtp.example.com', 465, 'tls', null, null,
       'markets@example.com', ?, 0, 'operator')`,
  ).run(ORIGIN);
}

function person(db: Db, id: string) {
  db.query(
    `insert into users (id, name, email, role, created_at)
     values (?, ?, ?, 'member', 0)`,
  ).run(id, id, `${id}@example.com`);
}

type Posted = { url: string; headers: Headers; body: Bytes };

// the push services, answering by endpoint
function services(answer: (url: string) => number | "fail" = () => 201) {
  const posted: Posted[] = [];
  const fetch = async (url: string, init: RequestInit) => {
    posted.push({
      url,
      headers: new Headers(init.headers),
      body: init.body as Bytes,
    });
    const status = answer(url);
    if (status === "fail") throw new Error("made-up network failure");
    return new Response(null, { status });
  };
  return { posted, fetch };
}

async function pushTest(
  options: {
    answer?: (url: string) => number | "fail";
    db?: Db;
    smtp?: boolean;
    log?: Log;
    adminDigest?: string | null;
    fetch?: Fetch;
  } = {},
) {
  const clock = fakeClock(START);
  const db = options.db ?? open(":memory:", clock).db;
  const write = writer(db);
  const s = services(options.answer);
  const v = await newVapid();
  if (options.db === undefined) {
    instrument(db, NVDA, { currency: "USD", name: "NVIDIA Corporation" });
    if (options.smtp !== false) setSmtp(db);
    person(db, "casey");
  }
  const p = push({
    db,
    writer: write,
    clock,
    log: options.log ?? silent,
    fetch: options.fetch ?? s.fetch,
    keys: v,
    origin: (d) =>
      d
        .query<{ u: string }, []>("select public_url as u from smtp_settings")
        .get()?.u ?? null,
    adminDigest: options.adminDigest ?? null,
  });
  // a browser signed in as casey: its login and its subscription
  const device = async (endpoint: string, owner = "casey") => {
    const dev = await browser();
    const login = openLogin(db, owner, clock.now());
    saveSubscription(
      db,
      owner,
      login.id,
      { endpoint, p256dh: dev.p256dh, auth: dev.authText },
      clock.now(),
    );
    return { ...dev, login: login.id };
  };
  const fire = (owner = "casey", note: string | null = null) =>
    write.write((d) =>
      insertAlert(d, { id: 1, owner }, snapshot(note), clock.now()),
    );
  const pass = async () => {
    p.kick();
    await p.settled();
  };
  return { clock, db, write, p, v, device, fire, pass, ...s };
}

const APPLE = "https://web.push.apple.com/made-up-1";
const FCM = "https://fcm.googleapis.com/fcm/send/made-up-2";

describe("the send pass", () => {
  test("sends each new alert once to each of its owner's devices", async () => {
    const t = await pushTest();
    const phone = await t.device(APPLE);
    const laptop = await t.device(FCM);
    person(t.db, "other");
    await t.device("https://web.push.apple.com/made-up-other", "other");
    await t.fire("casey", "trim the position");
    await t.pass();
    expect(t.posted.map((x) => x.url).sort()).toEqual([APPLE, FCM].sort());
    const toPhone = t.posted.find((x) => x.url === APPLE)!;
    expect(toPhone.headers.get("ttl")).toBe(String(TTL_S));
    expect(toPhone.headers.get("urgency")).toBe("high");
    expect(toPhone.headers.get("content-encoding")).toBe("aes128gcm");
    expect(toPhone.headers.get("authorization")).toStartWith("vapid t=");
    const payload = JSON.parse(await phone.read(toPhone.body)) as Payload;
    expect(payload).toEqual({
      title: "NVIDIA Corporation",
      body: "NVDA fell below 170.00 USD: 168.40 USD\ntrim the position",
      url: FIRED_PATH,
      badge: 1,
      tag: expect.stringMatching(/^alert-\d+$/),
    });
    const toLaptop = t.posted.find((x) => x.url === FCM)!;
    expect(JSON.parse(await laptop.read(toLaptop.body))).toEqual(payload);
    // nothing new: nothing sent
    await t.pass();
    expect(t.posted.length).toBe(2);
  });

  test("the badge is the rail's unseen count", async () => {
    const t = await pushTest();
    const phone = await t.device(APPLE);
    const first = await t.fire();
    await t.fire();
    await t.write.write((d) => markSeen(d, "casey", first));
    await t.fire();
    await t.pass();
    const badges = await Promise.all(
      t.posted.map(
        async (x) => (JSON.parse(await phone.read(x.body)) as Payload).badge,
      ),
    );
    const rail = readSeen(t.db, "casey").unseen;
    expect(rail).toBe(2);
    expect(badges).toEqual([rail, rail, rail]);
  });

  test("a gone device is deleted; any other failure moves on, unsent again", async () => {
    const lines: string[] = [];
    const log: Log = {
      info: () => {},
      warn: (m, f) => lines.push(`${m} ${JSON.stringify(f)}`),
      error: (m, f) => lines.push(`${m} ${JSON.stringify(f)}`),
    };
    const gone = "https://web.push.apple.com/made-up-gone";
    const lost = "https://fcm.googleapis.com/fcm/send/made-up-lost";
    const t = await pushTest({
      log,
      answer: (url) =>
        url === gone ? 410 : url === lost ? 404 : url === FCM ? "fail" : 500,
    });
    await t.device(gone);
    await t.device(lost);
    await t.device(FCM);
    await t.device(APPLE);
    await t.fire();
    await t.pass();
    expect(t.posted.length).toBe(4);
    expect(
      t.db
        .query("select endpoint from push_subscriptions order by endpoint")
        .all(),
    ).toEqual([{ endpoint: FCM }, { endpoint: APPLE }]);
    // a fixed phrase, never the endpoint
    expect(lines.some((l) => l.startsWith("push failed"))).toBe(true);
    for (const l of lines) expect(l).not.toContain("made-up");
    await t.pass();
    expect(t.posted.length).toBe(4);
  });

  test("nothing is sent twice across a restart; one fired while down still goes", async () => {
    const t = await pushTest();
    await t.device(APPLE);
    await t.fire();
    await t.pass();
    expect(t.posted.length).toBe(1);
    // the same database, a new start
    await t.fire();
    const again = await pushTest({ db: t.db });
    await again.pass();
    expect(again.posted.length).toBe(1);
    await again.pass();
    expect(again.posted.length).toBe(1);
  });

  test("an alert older than the push's TTL and pushes off send nothing", async () => {
    const t = await pushTest();
    await t.device(APPLE);
    await t.fire();
    await t.clock.advance(TTL_S * 1000 + 1);
    await t.pass();
    expect(t.posted).toEqual([]);
    const off = await pushTest({ smtp: false });
    await off.device(APPLE);
    await off.fire();
    await off.pass();
    expect(off.posted).toEqual([]);
    expect(off.p.publicKey(off.db)).toBeNull();
    expect(t.p.publicKey(t.db)).toBe(toB64url(t.v.publicKey));
    // turned on later, the alerts fired while off stay unsent
    setSmtp(off.db);
    await off.pass();
    expect(off.posted).toEqual([]);
  });

  test("a pass reads only committed alerts: a rolled-back fire sends nothing", async () => {
    const t = await pushTest();
    await t.device(APPLE);
    const engine = ruleEngine({
      quoteEveryMs: 5 * 60_000,
      fired: () => t.p.kick(),
    });
    const fireIn = (fail: boolean) =>
      t.write.write((d) => {
        insertAlert(d, { id: 1, owner: "casey" }, snapshot(), t.clock.now());
        engine.fired?.();
        if (fail) throw new Error("made-up failure");
      });
    await expect(fireIn(true)).rejects.toThrow("made-up failure");
    await t.p.settled();
    expect(t.posted).toEqual([]);
    await fireIn(false);
    await t.p.settled();
    expect(t.posted.length).toBe(1);
  });

  test("a kick as a pass ends is never lost", async () => {
    // every point in the pass's last microtasks, the gap included
    for (let ticks = 0; ticks < 30; ticks++) {
      const t = await pushTest();
      await t.device(APPLE);
      t.p.kick();
      for (let k = 0; k < ticks; k++) await Promise.resolve();
      insertAlert(t.db, { id: 1, owner: "casey" }, snapshot(), t.clock.now());
      t.p.kick();
      await t.p.settled();
      expect([ticks, t.posted.length]).toEqual([ticks, 1]);
    }
  });

  test("only devices whose login still signs in get pushes", async () => {
    const t = await pushTest({ adminDigest: "made-up-current" });
    await t.device(APPLE);
    const expired = await t.device(
      "https://web.push.apple.com/made-up-expired",
    );
    t.db
      .query("update logins set expires_at = ? where id = ?")
      .run(t.clock.now(), expired.login);
    const stale = await t.device("https://web.push.apple.com/made-up-stale");
    t.db
      .query("update logins set admin_digest = 'made-up-old' where id = ?")
      .run(stale.login);
    const current = await t.device(FCM);
    t.db
      .query("update logins set admin_digest = 'made-up-current' where id = ?")
      .run(current.login);
    await t.fire();
    await t.pass();
    expect(t.posted.map((x) => x.url).sort()).toEqual([APPLE, FCM].sort());
    // the prune takes the older key's login and its device with it
    pruneLogins(t.db, t.clock.now() - 1, "made-up-current");
    expect(
      t.db
        .query("select endpoint from push_subscriptions order by endpoint")
        .all(),
    ).toEqual(
      [FCM, APPLE, "https://web.push.apple.com/made-up-expired"]
        .sort()
        .map((endpoint) => ({ endpoint })),
    );
    // without the digest it leaves admin-key logins alone
    const kept = t.db.query("select count(*) as n from logins").get();
    pruneLogins(t.db, t.clock.now() - 1);
    expect(t.db.query("select count(*) as n from logins").get()).toEqual(kept);
  });

  test("a redirect is never followed", async () => {
    const lines: string[] = [];
    const log: Log = {
      info: () => {},
      warn: (m) => lines.push(m),
      error: (m) => lines.push(m),
    };
    const followed: string[] = [];
    const posted: string[] = [];
    // a 302 to another host, as fetch handles it per its redirect mode
    const fetch: Fetch = async (url, init) => {
      posted.push(url);
      if (init.redirect === "error") throw new TypeError("redirect");
      followed.push("https://elsewhere.example/");
      return new Response(null, { status: 201 });
    };
    const t = await pushTest({ log, fetch });
    await t.device(APPLE);
    await t.fire();
    await t.pass();
    expect(posted).toEqual([APPLE]);
    expect(followed).toEqual([]);
    expect(lines).toEqual(["push failed"]);
    expect(t.db.query("select endpoint from push_subscriptions").all()).toEqual(
      [{ endpoint: APPLE }],
    );
  });

  test("an oversized name is cut to fit after the note", async () => {
    const t = await pushTest();
    t.db
      .query("update instruments set name = ? where id = ?")
      .run("N".repeat(6000), NVDA);
    await t.fire("casey", "n".repeat(500));
    const row = t.db
      .query<
        {
          id: number;
          owner: string;
          ruleId: number;
          firedAt: number;
          snapshot: string;
        },
        []
      >(
        "select id, owner, rule_id as ruleId, fired_at as firedAt, snapshot from alerts",
      )
      .get()!;
    const p = payloadOf(t.db, row, silent)!;
    expect(p.body).toBe("");
    expect(p.title.length).toBeGreaterThan(0);
    expect(
      new TextEncoder().encode(JSON.stringify(p)).length,
    ).toBeLessThanOrEqual(3800);
  });

  test("the text names a non-price field and leaves a long note to fit", () => {
    const words = notification(
      {
        symbol: NVDA,
        when: "rsi14 < 30 or price < 100",
        note: null,
        values: { rsi14: 28.43, price: 150 },
      },
      {
        [NVDA]: { name: null, type: "EQUITY", currency: "USD", unit: "price" },
      },
    );
    expect(words).toEqual({ title: "NVDA", body: "NVDA RSI below 30: 28.4" });
  });

  test("a cross and a MACD turn read as the Alerts page words them", () => {
    const l = {
      [NVDA]: { name: null, type: "EQUITY", currency: "USD", unit: "price" },
    };
    expect(
      notification(
        { symbol: NVDA, when: "cross > 0", note: null, values: { cross: 1 } },
        l,
      ).body,
    ).toBe("NVDA 50/200-day cross above none: golden");
    expect(
      notification(
        {
          symbol: NVDA,
          when: "macd_turn < 0",
          note: null,
          values: { macd_turn: -1 },
        },
        l,
      ).body,
    ).toBe("NVDA MACD turn below none: down");
  });
});

describe("subscriptions", () => {
  test("go with their login: sign-out and expiry delete them", async () => {
    const t = await pushTest();
    const phone = await t.device(APPLE);
    const laptop = await t.device(FCM);
    t.db.query("delete from logins where id = ?").run(phone.login);
    expect(t.db.query("select endpoint from push_subscriptions").all()).toEqual(
      [{ endpoint: FCM }],
    );
    void laptop;
    pruneLogins(t.db, t.clock.now() + SESSION_MS + HOUR_MS);
    expect(t.db.query("select * from push_subscriptions").all()).toEqual([]);
  });
});

async function routes() {
  const clock = fakeClock(START);
  const { db } = open(":memory:", clock);
  setSmtp(db);
  const v = await newVapid();
  const write = writer(db);
  const m = markets({
    db,
    clock,
    writer: write,
    yahoo: yahoo({
      clock,
      fetch: async () => {
        throw new Error("no network in tests");
      },
    }),
    fred: null,
    log: silent,
  });
  const p = push({
    db,
    writer: write,
    clock,
    log: silent,
    fetch: async () => {
      throw new Error("no network in tests");
    },
    keys: v,
    origin: (d) =>
      d
        .query<{ u: string }, []>("select public_url as u from smtp_settings")
        .get()?.u ?? null,
    adminDigest: null,
  });
  const handle = api(m, { push: p });
  const dev = await browser();
  const sub = {
    endpoint: APPLE,
    keys: { p256dh: dev.p256dh, auth: dev.authText },
  };
  const send = (
    method: string,
    headers: Record<string, string>,
    body: unknown = sub,
  ) =>
    handle(
      new Request("http://markets.test/ui/push", {
        method,
        headers: { "content-type": "application/json", ...headers },
        ...(method === "GET" ? {} : { body: JSON.stringify(body) }),
      }),
    );
  return { db, clock, v, send };
}

describe("the push routes", () => {
  test("a login saves, reads and deletes its own device", async () => {
    const r = await routes();
    const cookie = cookieFor(r.db, START);
    const same = { cookie, "sec-fetch-site": "same-origin" };
    expect((await r.send("POST", same)).status).toBe(204);
    const read = await r.send("GET", { cookie });
    expect(await read.json()).toEqual({
      key: toB64url(r.v.publicKey),
      endpoints: [APPLE],
    });
    // signed out: the row goes with the login
    const out = await r.send("GET", {});
    expect(out.status).toBe(401);
    expect((await r.send("DELETE", same, { endpoint: APPLE })).status).toBe(
      204,
    );
    expect(r.db.query("select * from push_subscriptions").all()).toEqual([]);
  });

  test("refuse a key, a foreign origin, another host and bad keys", async () => {
    const r = await routes();
    const cookie = cookieFor(r.db, START);
    const keyed = await r.send("POST", {
      cookie,
      "sec-fetch-site": "same-origin",
      authorization: `Bearer ${READ_KEY}`,
    });
    expect(keyed.status).toBe(403);
    expect(
      (await r.send("POST", { cookie, "sec-fetch-site": "cross-site" })).status,
    ).toBe(403);
    expect(
      (await r.send("DELETE", { cookie, origin: "https://elsewhere.example" }))
        .status,
    ).toBe(403);
    const same = { cookie, "sec-fetch-site": "same-origin" };
    for (const endpoint of [
      "http://web.push.apple.com/x",
      "https://127.0.0.1/x",
      "https://push.apple.com.example/x",
      "https://user:pw@web.push.apple.com/x",
    ]) {
      const res = await r.send("POST", same, { endpoint, keys: {} });
      expect(res.status).toBe(400);
    }
    const bad = await r.send("POST", same, {
      endpoint: APPLE,
      keys: { p256dh: "AAAA", auth: "AAAA" },
    });
    expect(bad.status).toBe(400);
    expect(r.db.query("select * from push_subscriptions").all()).toEqual([]);
  });

  test("off without the server's origin: no key, and no saving", async () => {
    const r = await routes();
    r.db.exec("delete from smtp_settings");
    const cookie = cookieFor(r.db, START);
    expect(await (await r.send("GET", { cookie })).json()).toEqual({
      key: null,
      endpoints: [],
    });
    const res = await r.send("POST", {
      cookie,
      "sec-fetch-site": "same-origin",
    });
    expect(res.status).toBe(404);
  });
});

describe("the app", () => {
  test("sends at start and serves the service worker", async () => {
    const v = await newVapid();
    const s = services();
    const clock = fakeClock(START);
    const { db } = open(":memory:", clock);
    instrument(db, NVDA, { currency: "USD", name: "NVIDIA Corporation" });
    setSmtp(db);
    const dev = await browser();
    const login = openLogin(db, "operator", START);
    saveSubscription(
      db,
      "operator",
      login.id,
      { endpoint: APPLE, p256dh: dev.p256dh, auth: dev.authText },
      START,
    );
    insertAlert(db, { id: 1, owner: "operator" }, snapshot(), START);
    const worker = join(import.meta.dir, "..", "src", "web", "sw.js");
    const run = () =>
      withApp(
        async (t) => {
          await t.app.push.settled();
          const res = await fetch(`${t.url}/sw.js`);
          expect(res.status).toBe(200);
          expect(res.headers.get("cache-control")).toBe("no-cache");
          expect(res.headers.get("content-type")).toContain("javascript");
          const text = await res.text();
          // it shows pushes and caches nothing
          expect(text).toContain('addEventListener("push"');
          expect(text).not.toContain("caches.");
          expect(text).not.toContain('addEventListener("fetch"');
        },
        {
          db,
          ui: true,
          page,
          push: v,
          files: { "/sw.js": worker },
          fetch: s.fetch,
        },
      );
    await run();
    expect(s.posted.map((x) => x.url)).toEqual([APPLE]);
    await run();
    expect(s.posted.length).toBe(1);
    db.close();
  });
});
