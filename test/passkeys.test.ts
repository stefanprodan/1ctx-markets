// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// Passkeys: an add from a signed-in browser and a sign-in with it, each
// check of both ceremonies, the challenge rows, the admin key's trust,
// sign out everywhere and removing a person. The authenticator is a fake
// on WebCrypto; people, addresses and keys are made up.

import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PREFIX } from "../src/api/http.ts";
import { iso } from "../src/market/format.ts";
import { OPERATOR } from "../src/operations/who.ts";
import { type Bytes, toB64url } from "../src/push/crypto.ts";
import { MINUTE_MS } from "../src/runtime/clock.ts";
import { keys } from "../src/runtime/keys.ts";
import { logger } from "../src/runtime/log.ts";
import type { Outgoing } from "../src/server/email/smtp.ts";
import { addedAt } from "../src/server/links.ts";
import {
  derToRaw,
  parseAuthenticatorData,
} from "../src/server/passkeys/authenticator.ts";
import { countMoves } from "../src/server/passkeys/checks.ts";
import { providerOf } from "../src/server/passkeys/provider.ts";
import {
  CHALLENGE_MS,
  PASSKEYS_PER_USER,
} from "../src/server/passkeys/store.ts";
import {
  adminDigest,
  COOKIE,
  openLogin,
  pruneLogins,
} from "../src/server/session.ts";
import {
  ASK_COOKIE,
  ASKS_PER_MINUTE,
  OPTIONS_PER_MINUTE,
} from "../src/server/ui.ts";
import type { Writer } from "../src/storage/writer.ts";
import { ADMIN_KEY, api, cookieFor } from "./helpers/api.ts";
import {
  type Authenticator,
  authenticator,
  type Bend,
  rawToDer,
} from "./helpers/passkeys.ts";
import { tempDirs } from "./helpers/temp.ts";
import { world } from "./helpers/world.ts";

const tempDir = tempDirs();

const ORIGIN = "https://markets.test";
const OTHER = "https://other.test";
const MAC =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";
const ANA = "ana@example.com";
const SMTP_PASSWORD = "made-up-smtp-password-0123456789";

type Json = Record<string, unknown>;

function setup(options: { email?: boolean } = {}) {
  const w = world();
  const dir = join(tempDir("markets-passkeys-"), "secrets");
  mkdirSync(dir, { mode: 0o700 });
  writeFileSync(join(dir, "email-test.key"), SMTP_PASSWORD);
  const store = keys(dir);
  const lines: string[] = [];
  const mail: Outgoing[] = [];
  const log = logger(w.clock, store.values, (line) => lines.push(line));
  // while held, writes wait in their order, so a test can act between a
  // route's checks and its write
  let held: PromiseWithResolvers<void> | null = null;
  let queued = 0;
  const watchers: { n: number; fire: () => void }[] = [];
  const real = w.m.writer;
  const writer: Writer = {
    write(fn) {
      if (held === null) return real.write(fn);
      queued++;
      for (const x of watchers.filter((x) => x.n <= queued)) x.fire();
      return held.promise.then(() => real.write(fn));
    },
    close: () => real.close(),
  };
  const handle = api(
    { ...w.m, writer, log: log("admin") },
    {
      secrets: store,
      sender: async (_server, message) => {
        mail.push(message);
        return { ok: true };
      },
      log: log("access"),
    },
  );
  if (options.email !== false) {
    w.db
      .query(
        `insert into smtp_settings (id, host, port, security, username,
           key_name, from_address, public_url, updated_at, updated_by)
         values (1, 'smtp.example.com', 465, 'tls', 'markets@example.com',
           'email-test', 'markets@example.com', 'https://markets.test', 0,
           'operator')`,
      )
      .run();
  }
  // each call its own client address unless named, so the ask limit
  // holds only where a test counts it
  let next = 0;
  const at = (path: string, init: RequestInit = {}, ip?: string) =>
    handle(
      new Request(`${ORIGIN}${path}`, init),
      ip ?? `10.0.0.${next++ % 250}`,
    );
  const post = (
    cookie: string | null,
    body?: unknown,
    headers: Record<string, string> = {},
    method = "POST",
  ): RequestInit => ({
    method,
    headers: {
      "content-type": "application/json",
      "sec-fetch-site": "same-origin",
      origin: ORIGIN,
      "user-agent": MAC,
      ...(cookie === null ? {} : { cookie }),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const t = {
    ...w,
    lines,
    mail,
    at,
    post,
    settled: () => handle.links.settled(),
    hold() {
      const h = Promise.withResolvers<void>();
      held = h;
      queued = 0;
      return {
        // resolves once n writes wait
        queued: (n: number) =>
          new Promise<void>((fire) => {
            if (queued >= n) fire();
            else watchers.push({ n, fire });
          }),
        release() {
          held = null;
          h.resolve();
        },
      };
    },
    person(id: string, email: string | null) {
      w.db
        .query(
          "insert into users (id, name, email, role, created_at) values (?, ?, ?, 'member', 0)",
        )
        .run(id, `Person ${id}`, email);
      return cookieFor(w.db, w.clock.now(), id);
    },
    async addOptions(cookie: string, origin = ORIGIN) {
      const res = await at(
        "/ui/passkeys/options",
        post(cookie, undefined, { origin }),
      );
      return { res, options: res.status === 200 ? await res.json() : null };
    },
    // an add from options to answer; the options' origin unless named
    async add(
      cookie: string,
      key: Authenticator,
      bend: Bend = {},
      origin = ORIGIN,
      answerOrigin = origin,
    ) {
      const { options } = await t.addOptions(cookie, origin);
      const body = await key.create(options, answerOrigin, bend);
      return at("/ui/passkeys", post(cookie, body, { origin: answerOrigin }));
    },
    async signInOptions(origin = ORIGIN) {
      const res = await at(
        "/ui/passkeys/sign-in/options",
        post(null, undefined, { origin }),
      );
      return (await res.json()) as { challenge: string; rpId: string };
    },
    answer(body: unknown, cookie: string | null = null, origin = ORIGIN) {
      return at("/ui/passkeys/sign-in", post(cookie, body, { origin }));
    },
    async signIn(
      key: Authenticator,
      bend: Bend = {},
      origin = ORIGIN,
      cookie: string | null = null,
    ) {
      const options = await t.signInOptions(origin);
      return t.answer(await key.get(options, origin, bend), cookie, origin);
    },
    async list(cookie: string) {
      const res = await at("/ui/passkeys", { headers: { cookie } });
      return ((await res.json()) as { passkeys: Json[] }).passkeys;
    },
    async me(cookie: string) {
      const res = await at("/ui/me", { headers: { cookie } });
      return ((await res.json()) as { user: { id: string } | null }).user;
    },
    count: (sql: string, ...args: string[]) =>
      (
        w.db.query(`select count(*) as n from ${sql}`).get(...args) as {
          n: number;
        }
      ).n,
  };
  return t;
}

const loginOf = (res: Response): string => {
  const m = new RegExp(`${COOKIE}=([^;]*)`).exec(
    res.headers.get("set-cookie") ?? "",
  );
  return `${COOKIE}=${m?.[1] ?? ""}`;
};

describe("the authenticator data and the signature", () => {
  const head = (flags: number, count: number) => {
    const out = new Uint8Array(37);
    out.fill(7, 0, 32);
    out[32] = flags;
    new DataView(out.buffer).setUint32(33, count);
    return out;
  };

  test("reads the relying party hash, the flags, the count and an add's credential id", () => {
    const plain = parseAuthenticatorData(head(0x05, 258))!;
    expect(plain.rpIdHash).toEqual(new Uint8Array(32).fill(7));
    expect(plain.flags).toBe(0x05);
    expect(plain.signCount).toBe(258);
    expect(plain.credentialId).toBeNull();
    const id = new Uint8Array([1, 2, 3, 4]);
    const added = new Uint8Array([
      ...head(0x45, 0),
      ...new Uint8Array(16),
      0,
      4,
      ...id,
      0xa5,
    ]);
    expect(parseAuthenticatorData(added)!.credentialId).toEqual(id);
  });

  test("refuses bytes shorter than their flags say", () => {
    expect(parseAuthenticatorData(new Uint8Array(36))).toBeNull();
    // the attested flag with no data after the head
    expect(parseAuthenticatorData(head(0x45, 0))).toBeNull();
    // an id running past the end, and one with no key after it
    const over = [...head(0x45, 0), ...new Uint8Array(16), 0, 9, 1, 2];
    expect(parseAuthenticatorData(new Uint8Array(over))).toBeNull();
    const bare = [...head(0x45, 0), ...new Uint8Array(16), 0, 2, 1, 2];
    expect(parseAuthenticatorData(new Uint8Array(bare))).toBeNull();
  });

  test("turns DER into raw r and s, padded and with sign bytes dropped", () => {
    const raw = new Uint8Array(64);
    raw[0] = 0x80;
    raw[31] = 1;
    raw[63] = 2;
    const der = rawToDer(raw);
    // r takes a sign byte, s is one byte long
    expect(der[3]).toBe(33);
    expect(derToRaw(der)).toEqual(raw);
    for (let i = 0; i < 20; i++) {
      const r = crypto.getRandomValues(new Uint8Array(64)) as Bytes;
      expect(derToRaw(rawToDer(r))).toEqual(r);
    }
  });

  test("refuses DER that is not two integers of P-256", () => {
    const der = rawToDer(crypto.getRandomValues(new Uint8Array(64)) as Bytes);
    expect(derToRaw(new Uint8Array([...der, 0]))).toBeNull();
    const tag = new Uint8Array(der);
    tag[0] = 0x31;
    expect(derToRaw(tag)).toBeNull();
    const integer = new Uint8Array(der);
    integer[2] = 0x03;
    expect(derToRaw(integer)).toBeNull();
    expect(derToRaw(der.slice(0, der.length - 1))).toBeNull();
    // a 33-byte integer without its sign byte is too big
    const wide = new Uint8Array([
      0x30,
      0x26,
      0x02,
      0x21,
      ...new Uint8Array(33).fill(1),
      0x02,
      0x01,
      0x01,
    ]);
    expect(derToRaw(wide)).toBeNull();
  });

  test("the count moves forward once either side is above 0", () => {
    expect(countMoves(0, 0)).toBe(true);
    expect(countMoves(0, 1)).toBe(true);
    expect(countMoves(4, 5)).toBe(true);
    expect(countMoves(5, 5)).toBe(false);
    expect(countMoves(5, 4)).toBe(false);
    expect(countMoves(5, 0)).toBe(false);
  });

  test("the provider is named from the AAGUID, else a passkey", () => {
    expect(providerOf("fbfc3007-154e-4ecc-8c0b-6e020557d7bd")).toBe(
      "Apple Passwords",
    );
    expect(providerOf("ea9b8d66-4d01-1d21-3ce4-b6b48cb575d4")).toBe(
      "Google Password Manager",
    );
    expect(providerOf("00000000-0000-0000-0000-000000000000")).toBe("Passkey");
    expect(providerOf("01020304-0506-0708-0102-030405060708")).toBe("Passkey");
    expect(providerOf(null)).toBe("Passkey");
  });

  test("an add's AAGUID is read as 8-4-4-4-12 hex", () => {
    const id = new Uint8Array([7, 7, 7, 7]);
    const added = new Uint8Array([
      ...head(0x45, 0),
      ...Array.from({ length: 16 }, (_, i) => i * 17),
      0,
      id.length,
      ...id,
      0xa5,
    ]);
    expect(parseAuthenticatorData(added)!.aaguid).toBe(
      "00112233-4455-6677-8899-aabbccddeeff",
    );
  });

  test("refuses a credential id of 0 bytes or over 1023", () => {
    const attested = (length: number) =>
      new Uint8Array([
        ...head(0x45, 0),
        ...new Uint8Array(16),
        length >> 8,
        length & 0xff,
        ...new Uint8Array(length).fill(1),
        0xa5,
      ]);
    expect(parseAuthenticatorData(attested(0))).toBeNull();
    expect(parseAuthenticatorData(attested(1024))).toBeNull();
    expect(parseAuthenticatorData(attested(1023))!.credentialId).toHaveLength(
      1023,
    );
  });
});

describe("adding a passkey", () => {
  test("options name the host, the person and the host's own passkeys", async () => {
    const t = setup();
    const ana = t.person("ana", ANA);
    const { res, options } = await t.addOptions(ana);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(options).toMatchObject({
      rp: { id: "markets.test", name: "1ctx Markets" },
      user: { id: toB64url(new TextEncoder().encode("ana")), name: ANA },
      pubKeyCredParams: [
        { type: "public-key", alg: -7 },
        { type: "public-key", alg: -257 },
      ],
      timeout: CHALLENGE_MS,
      attestation: "none",
      authenticatorSelection: {
        residentKey: "required",
        userVerification: "required",
      },
      excludeCredentials: [],
    });
    expect(options.challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const key = await authenticator();
    expect((await t.add(ana, key)).status).toBe(201);
    await t.add(ana, await authenticator(), {}, OTHER);
    const again = (await t.addOptions(ana)).options;
    expect(again.excludeCredentials).toEqual([
      { type: "public-key", id: key.id, transports: ["hybrid", "internal"] },
    ]);
    // a person without an address is named by their name
    t.db.query("update users set email = null where id = 'ana'").run();
    expect((await t.addOptions(ana)).options.user.name).toBe("Person ana");
  });

  test("an ES256 and an RS256 passkey are added, listed and sign in", async () => {
    const t = setup();
    const ana = t.person("ana", ANA);
    for (const kind of ["ES256", "RS256"] as const) {
      const key = await authenticator(kind);
      const added = await t.add(ana, key);
      expect(added.status).toBe(201);
      const item = (await added.json()) as Json;
      expect(item).toEqual({
        id: expect.stringMatching(/^[a-z0-9]{12}$/),
        credential_id: key.id,
        origin: ORIGIN,
        device: "Passkey",
        created_at: expect.any(String),
        last_used_at: null,
      });
      const res = await t.signIn(key);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ landing: "/" });
      expect(res.headers.get("set-cookie")).toContain("Secure");
      expect((await t.me(loginOf(res)))?.id).toBe("ana");
      const listed = await t.list(ana);
      expect(listed.find((p) => p.id === item.id)?.last_used_at).toBe(
        iso(t.clock.now()),
      );
    }
    expect(await t.list(ana)).toHaveLength(2);
    // the challenges were used, so none is left
    expect(t.count("passkey_challenges")).toBe(0);
  });

  test("an answer that fails a check adds nothing", async () => {
    const t = setup();
    const ana = t.person("ana", ANA);
    const other = await authenticator();
    const cases: [string, Bend, string?][] = [
      ["a wrong origin", { client: { origin: OTHER } }],
      ["a sign-in's type", { client: { type: "webauthn.get" } }],
      ["a cross-origin frame", { client: { crossOrigin: true } }],
      ["another relying party", { rpId: "other.test" }],
      ["no user verification", { flags: 0x41 }],
      ["no user presence", { flags: 0x44 }],
      ["no attested data", { flags: 0x05 }],
      ["backed up, not backup eligible", { flags: 0x55 }],
      ["a credential id that is not rawId", { attestedId: other.rawId }],
      ["a key of another algorithm", { alg: -257 }],
      ["an algorithm not offered", { alg: -8 }],
      ["an unknown challenge", { client: { challenge: "A".repeat(43) } }],
    ];
    for (const [name, bend] of cases) {
      const res = await t.add(ana, await authenticator(), bend);
      expect([name, res.status]).toEqual([name, 400]);
    }
    for (const kind of ["P384", "RS1024"] as const) {
      const res = await t.add(ana, await authenticator(kind), {
        alg: kind === "P384" ? -7 : -257,
      });
      expect([kind, res.status]).toEqual([kind, 400]);
    }
    // an RSA key named ES256
    const rsa = await authenticator("RS256");
    expect((await t.add(ana, rsa, { alg: -7 })).status).toBe(400);
    expect(t.count("passkeys")).toBe(0);
  });

  test("the challenge is used once, held to its login and host, and lives two minutes", async () => {
    const t = setup();
    const ana = t.person("ana", ANA);
    const ana2 = cookieFor(t.db, t.clock.now(), "ana");
    const key = await authenticator();
    const { options } = await t.addOptions(ana);
    const body = await key.create(options, ORIGIN);
    // another login of the same person cannot answer it
    expect((await t.at("/ui/passkeys", t.post(ana2, body))).status).toBe(400);
    expect((await t.at("/ui/passkeys", t.post(ana, body))).status).toBe(201);
    // replayed
    expect((await t.at("/ui/passkeys", t.post(ana, body))).status).toBe(400);
    // another host's challenge
    const elsewhere = (await t.addOptions(ana, OTHER)).options;
    const crossed = await (await authenticator()).create(elsewhere, ORIGIN, {
      rpId: "markets.test",
    });
    expect((await t.at("/ui/passkeys", t.post(ana, crossed))).status).toBe(400);
    // expired
    const late = (await t.addOptions(ana)).options;
    await t.clock.advance(CHALLENGE_MS);
    const answer = await (await authenticator()).create(late, ORIGIN);
    expect((await t.at("/ui/passkeys", t.post(ana, answer))).status).toBe(400);
    // each insert deletes the expired rows
    expect(t.count("passkey_challenges")).toBe(2);
    await t.addOptions(ana);
    expect(t.count("passkey_challenges")).toBe(1);
  });

  test("an answer queued past its challenge's time adds nothing", async () => {
    const t = setup();
    const ana = t.person("ana", ANA);
    const { options } = await t.addOptions(ana);
    const body = await (await authenticator()).create(options, ORIGIN);
    await t.clock.advance(CHALLENGE_MS - 1);
    const h = t.hold();
    const pending = t.at("/ui/passkeys", t.post(ana, body));
    await h.queued(1);
    await t.clock.advance(1);
    h.release();
    expect((await pending).status).toBe(400);
    expect(t.count("passkeys")).toBe(0);
  });

  test(`at most ${PASSKEYS_PER_USER} a person across hosts, then 409`, async () => {
    const t = setup();
    const ana = t.person("ana", ANA);
    for (let i = 0; i < PASSKEYS_PER_USER - 1; i++) {
      const origin = i % 2 === 0 ? ORIGIN : OTHER;
      expect((await t.add(ana, await authenticator(), {}, origin)).status).toBe(
        201,
      );
    }
    // two options while one place is left; the second answer finds it taken
    const first = (await t.addOptions(ana)).options;
    const second = (await t.addOptions(ana)).options;
    const a = await (await authenticator()).create(first, ORIGIN);
    const b = await (await authenticator()).create(second, ORIGIN);
    expect((await t.at("/ui/passkeys", t.post(ana, a))).status).toBe(201);
    const full = await t.at("/ui/passkeys", t.post(ana, b));
    expect(full.status).toBe(409);
    expect((await t.addOptions(ana)).res.status).toBe(409);
    expect(t.count("passkeys")).toBe(PASSKEYS_PER_USER);
  });

  test("an answer whose id is not its rawId, or whose attested id is empty or too long, adds nothing", async () => {
    const t = setup();
    const ana = t.person("ana", ANA);
    const answer = async (
      edit: (body: Json) => void,
      bend: Bend = {},
    ): Promise<Response> => {
      const { options } = await t.addOptions(ana);
      const body = await (await authenticator()).create(options, ORIGIN, bend);
      edit(body);
      return t.at("/ui/passkeys", t.post(ana, body));
    };
    const other = await authenticator();
    expect((await answer((b) => (b.id = other.id))).status).toBe(400);
    expect(
      (await answer(() => {}, { attestedId: new Uint8Array(0) })).status,
    ).toBe(400);
    const long = new Uint8Array(1024).fill(3) as Bytes;
    const tooLong = await answer(
      (b) => {
        b.id = toB64url(long);
        b.rawId = toB64url(long);
      },
      { attestedId: long },
    );
    expect(tooLong.status).toBe(400);
    expect(t.count("passkeys")).toBe(0);
  });

  test("another person's credential is never added twice", async () => {
    const t = setup();
    const ana = t.person("ana", ANA);
    const ben = t.person("ben", "ben@example.com");
    const key = await authenticator();
    expect((await t.add(ana, key)).status).toBe(201);
    expect((await t.add(ben, key)).status).toBe(409);
    expect(t.count("passkeys where user_id = 'ben'")).toBe(0);
  });

  test("a sign out everywhere between the options and the answer adds nothing", async () => {
    const t = setup();
    const ana = t.person("ana", ANA);
    const signOut = () =>
      t.at(`${PREFIX}/users/ana/sign-out`, {
        method: "POST",
        headers: { authorization: `Bearer ${ADMIN_KEY}` },
      });
    const { options } = await t.addOptions(ana);
    const body = await (await authenticator()).create(options, ORIGIN);
    expect((await signOut()).status).toBe(204);
    expect((await t.at("/ui/passkeys", t.post(ana, body))).status).toBe(401);
    // and one landing mid-call: the login was read, the body still coming
    const again = cookieFor(t.db, t.clock.now(), "ana");
    const late = (await t.addOptions(again)).options;
    const text = JSON.stringify(
      await (await authenticator()).create(late, ORIGIN),
    );
    const reading = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const stream = new ReadableStream<Uint8Array>({
      async pull(c) {
        reading.resolve();
        await release.promise;
        c.enqueue(new TextEncoder().encode(text));
        c.close();
      },
    });
    const init = t.post(again);
    const pending = t.at("/ui/passkeys", { ...init, body: stream });
    await reading.promise;
    expect((await signOut()).status).toBe(204);
    release.resolve();
    const res = await pending;
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ message: "signed out" });
    expect(t.count("passkeys")).toBe(0);
  });

  test("an add emails the person's address with the server's, never a sign-in link; none without one or with email off", async () => {
    const t = setup();
    const ana = t.person("ana", ANA);
    const apple = Uint8Array.from(
      Buffer.from("fbfc3007154e4ecc8c0b6e020557d7bd", "hex"),
    );
    const added = await t.add(ana, await authenticator(), { aaguid: apple });
    expect(added.status).toBe(201);
    expect(((await added.json()) as Json).device).toBe("Apple Passwords");
    await t.settled();
    expect(t.mail).toHaveLength(1);
    expect(t.mail[0]!.to.address).toBe(ANA);
    expect(t.mail[0]!.text).toBe(
      `A passkey in Apple Passwords was added to your markets sign-in, ${addedAt(t.clock.now())}. Not you? Sign in at https://markets.test/, remove it under Passkeys, and have an admin sign you out everywhere.\n`,
    );
    // the server's address, never a sign-in link
    expect(t.mail[0]!.text).not.toContain("/ui/link");
    // the operator has no address
    const op = cookieFor(t.db, t.clock.now());
    expect((await t.add(op, await authenticator())).status).toBe(201);
    const off = setup({ email: false });
    const ben = off.person("ben", "ben@example.com");
    expect((await off.add(ben, await authenticator())).status).toBe(201);
    await t.settled();
    await off.settled();
    expect(t.mail).toHaveLength(1);
    expect(off.mail).toHaveLength(0);
    expect(addedAt(Date.UTC(2026, 10, 4, 9, 5))).toBe("4 Nov 2026 09:05 UTC");
  });

  test("an add from an unknown provider emails without naming one", async () => {
    const t = setup();
    const ana = t.person("ana", ANA);
    expect((await t.add(ana, await authenticator())).status).toBe(201);
    await t.settled();
    expect(t.mail[0]!.text).toBe(
      `A passkey was added to your markets sign-in, ${addedAt(t.clock.now())}. Not you? Sign in at https://markets.test/, remove it under Passkeys, and have an admin sign you out everywhere.\n`,
    );
  });

  test("a person removes their own passkey, never another's", async () => {
    const t = setup();
    const ana = t.person("ana", ANA);
    const ben = t.person("ben", "ben@example.com");
    const item = (await (await t.add(ana, await authenticator())).json()) as {
      id: string;
    };
    const remove = (cookie: string, id: string, headers = {}) =>
      t.at(`/ui/passkeys/${id}`, t.post(cookie, undefined, headers, "DELETE"));
    expect((await remove(ben, item.id)).status).toBe(404);
    expect(
      (await remove(ana, item.id, { "sec-fetch-site": "cross-site" })).status,
    ).toBe(403);
    expect((await remove(ana, "not-an-id!")).status).toBe(404);
    expect((await remove(ana, item.id)).status).toBe(204);
    expect(await t.list(ana)).toEqual([]);
  });

  test("a removal whose login ends while it waits for its write removes nothing", async () => {
    const t = setup();
    const ana = t.person("ana", ANA);
    expect((await t.add(ana, await authenticator())).status).toBe(201);
    const [row] = await t.list(ana);
    const h = t.hold();
    const pending = t.at(
      `/ui/passkeys/${row!.id}`,
      t.post(ana, undefined, {}, "DELETE"),
    );
    await h.queued(1);
    t.db.query("delete from logins where user_id = 'ana'").run();
    h.release();
    const res = await pending;
    expect(res.status).toBe(401);
    expect(t.count("passkeys")).toBe(1);
  });
});

describe("signing in with a passkey", () => {
  test("every failed sign-in answers the same 401, an unknown passkey's with its code", async () => {
    const t = setup();
    const ana = t.person("ana", ANA);
    t.person("ben", "ben@example.com");
    const key = await authenticator("ES256", 5);
    expect((await t.add(ana, key)).status).toBe(201);
    const unknown = await authenticator();
    const cases: [string, () => Promise<Response>][] = [
      ["a wrong origin", () => t.signIn(key, { client: { origin: OTHER } })],
      [
        "an add's type",
        () => t.signIn(key, { client: { type: "webauthn.create" } }),
      ],
      [
        "a cross-origin frame",
        () => t.signIn(key, { client: { crossOrigin: true } }),
      ],
      ["another relying party", () => t.signIn(key, { rpId: "other.test" })],
      ["no user verification", () => t.signIn(key, { flags: 0x01 })],
      [
        "attested data",
        () =>
          t.signIn(key, {
            flags: 0x45,
            tail: new Uint8Array([...new Uint8Array(16), 0, 2, 1, 2, 0xa5]),
          }),
      ],
      ["backed up, not backup eligible", () => t.signIn(key, { flags: 0x15 })],
      [
        "bytes after the head with no flag for them",
        () => t.signIn(key, { tail: new Uint8Array([0xa0]) }),
      ],
      ["a bad signature", () => t.signIn(key, { spoil: true })],
      [
        "another person's user id",
        () =>
          t.signIn(key, {
            userHandle: new TextEncoder().encode("ben") as Bytes,
          }),
      ],
      ["no user id", () => t.signIn(key, { userHandle: null })],
      ["a count going to 0", () => t.signIn(key, { count: 0 })],
      ["a count standing still", () => t.signIn(key, { count: 5 })],
      [
        "an unknown challenge",
        () => t.signIn(key, { client: { challenge: "A".repeat(43) } }),
      ],
      ["a body that is not an answer", () => t.answer({ id: key.id })],
    ];
    const answers: unknown[] = [];
    for (const [name, attempt] of cases) {
      const res = await attempt();
      expect([name, res.status]).toEqual([name, 401]);
      expect(res.headers.get("set-cookie")).toBeNull();
      answers.push(await res.json());
    }
    expect(new Set(answers.map((a) => JSON.stringify(a))).size).toBe(1);
    // the page asks the browser to forget a passkey this server never held
    const gone = await t.signIn(unknown);
    expect(gone.status).toBe(401);
    expect(gone.headers.get("set-cookie")).toBeNull();
    expect(await gone.json()).toEqual({
      ...(answers[0] as object),
      code: "unknown_passkey",
    });
    // the count moves forward, and back is refused
    expect((await t.signIn(key)).status).toBe(200);
    // backed up and eligible, and extension data after its flag
    expect((await t.signIn(key, { flags: 0x1d })).status).toBe(200);
    expect(
      (await t.signIn(key, { flags: 0x85, tail: new Uint8Array([0xa0]) }))
        .status,
    ).toBe(200);
    expect((await t.signIn(key, { count: key.count - 1 })).status).toBe(401);
    expect((await t.signIn(key)).status).toBe(200);
  });

  test("a challenge is used once, of its purpose and host, and lives two minutes", async () => {
    const t = setup();
    const ana = t.person("ana", ANA);
    const key = await authenticator();
    expect((await t.add(ana, key)).status).toBe(201);
    const options = await t.signInOptions();
    const body = await key.get(options, ORIGIN);
    expect((await t.answer(body)).status).toBe(200);
    expect((await t.answer(body)).status).toBe(401);
    // an add's challenge answered as a sign-in
    const add = (await t.addOptions(ana)).options;
    const crossed = await key.get(
      { challenge: add.challenge, rpId: "markets.test" },
      ORIGIN,
    );
    expect((await t.answer(crossed)).status).toBe(401);
    // another host's challenge
    const there = await t.signInOptions(OTHER);
    const moved = await key.get(
      { challenge: there.challenge, rpId: "markets.test" },
      ORIGIN,
    );
    expect((await t.answer(moved)).status).toBe(401);
    const late = await t.signInOptions();
    await t.clock.advance(CHALLENGE_MS);
    expect((await t.answer(await key.get(late, ORIGIN))).status).toBe(401);
  });

  test("a sign-in queued past its challenge's time opens no login", async () => {
    const t = setup();
    const ana = t.person("ana", ANA);
    const key = await authenticator();
    expect((await t.add(ana, key)).status).toBe(201);
    const options = await t.signInOptions();
    const body = await key.get(options, ORIGIN);
    await t.clock.advance(CHALLENGE_MS - 1);
    const h = t.hold();
    const pending = t.answer(body);
    await h.queued(1);
    await t.clock.advance(1);
    h.release();
    expect((await pending).status).toBe(401);
    expect(t.count("logins where user_id = 'ana'")).toBe(1);
  });

  test("a sign-in whose passkey is removed before its write opens no login", async () => {
    const t = setup();
    const ana = t.person("ana", ANA);
    const key = await authenticator();
    expect((await t.add(ana, key)).status).toBe(201);
    const body = await key.get(await t.signInOptions(), ORIGIN);
    const h = t.hold();
    const pending = t.answer(body);
    // the checks passed; a removal or a sign out everywhere lands now
    await h.queued(1);
    t.db.query("delete from passkeys where user_id = 'ana'").run();
    h.release();
    const res = await pending;
    expect(res.status).toBe(401);
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(t.count("logins where user_id = 'ana'")).toBe(1);
  });

  test("a sign-in whose id is not its rawId opens no login", async () => {
    const t = setup();
    const ana = t.person("ana", ANA);
    const key = await authenticator();
    expect((await t.add(ana, key)).status).toBe(201);
    const body = await key.get(await t.signInOptions(), ORIGIN);
    body.rawId = (await authenticator()).id;
    const res = await t.answer(body);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({
      error: "unauthorized",
      message: "passkey not accepted",
    });
    expect(t.count("logins where user_id = 'ana'")).toBe(1);
  });

  test("a sign-in posted as a form is refused with the same 401", async () => {
    const t = setup();
    const ana = t.person("ana", ANA);
    const key = await authenticator();
    expect((await t.add(ana, key)).status).toBe(201);
    const body = await key.get(await t.signInOptions(), ORIGIN);
    const res = await t.at(
      "/ui/passkeys/sign-in",
      t.post(null, body, {
        "content-type": "application/x-www-form-urlencoded",
      }),
    );
    expect(res.status).toBe(401);
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(await res.json()).toEqual({
      error: "unauthorized",
      message: "passkey not accepted",
    });
    expect(t.count("logins where user_id = 'ana'")).toBe(1);
  });

  test("a passkey signs in only on the host it was made on", async () => {
    const t = setup();
    const ana = t.person("ana", ANA);
    const key = await authenticator();
    expect((await t.add(ana, key)).status).toBe(201);
    const there = await t.signIn(key, {}, OTHER);
    expect(there.status).toBe(401);
    // held here, so the browser is never asked to forget it
    expect(await there.json()).toEqual({
      error: "unauthorized",
      message: "passkey not accepted",
    });
    const unknown = await t.signIn(await authenticator(), {}, OTHER);
    expect(await unknown.json()).toMatchObject({ code: "unknown_passkey" });
    expect((await t.signIn(key)).status).toBe(200);
  });

  test("a sign-in ends the browser's older login, as the code does", async () => {
    const t = setup();
    const ana = t.person("ana", ANA);
    const ben = t.person("ben", "ben@example.com");
    const key = await authenticator();
    expect((await t.add(ana, key)).status).toBe(201);
    const res = await t.signIn(key, {}, ORIGIN, ben);
    expect(res.status).toBe(200);
    expect(await t.me(ben)).toBeNull();
    expect((await t.me(loginOf(res)))?.id).toBe("ana");
  });

  test("works on plain HTTP to loopback, its cookie without Secure", async () => {
    const t = setup();
    const ana = t.person("ana", ANA);
    const local = "http://localhost:11238";
    const key = await authenticator();
    expect((await t.add(ana, key, {}, local)).status).toBe(201);
    const res = await t.signIn(key, {}, local);
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).not.toContain("Secure");
    expect((await t.list(ana))[0]!.origin).toBe(local);
    expect(t.db.query("select rp_id, origin from passkeys").get()).toEqual({
      rp_id: "localhost",
      origin: local,
    });
  });

  test("a passkey signs in only at the origin it was added at, port included", async () => {
    const t = setup();
    const ana = t.person("ana", ANA);
    const added = "http://localhost:11239";
    const other = "http://localhost:3000";
    const key = await authenticator();
    expect((await t.add(ana, key, {}, added)).status).toBe(201);
    // the same rp id from another port's page
    expect((await t.signIn(key, {}, other)).status).toBe(401);
    // a challenge of the other port, answered with this port's Origin
    const there = await t.signInOptions(other);
    const crossed = await key.get(there, added);
    expect((await t.answer(crossed, null, added)).status).toBe(401);
    // and a caller sending the other port's Origin with its answer
    const forged = await key.get(await t.signInOptions(other), other);
    expect((await t.answer(forged, null, other)).status).toBe(401);
    expect((await t.signIn(key, {}, added)).status).toBe(200);
    // an add's challenge is held to its port too
    const { options } = await t.addOptions(ana, other);
    const body = await (await authenticator()).create(options, added);
    const res = await t.at(
      "/ui/passkeys",
      t.post(ana, body, { origin: added }),
    );
    expect(res.status).toBe(400);
    // the keychain keys by host, so another port's add leaves it out too
    const exclude = (await t.addOptions(ana, other)).options.excludeCredentials;
    expect(exclude).toHaveLength(1);
  });
});

describe("the routes", () => {
  test("a ceremony needs an https Origin or loopback, else 403", async () => {
    const t = setup();
    const ana = t.person("ana", ANA);
    const routes: [string, string | null][] = [
      ["/ui/passkeys/options", ana],
      ["/ui/passkeys", ana],
      ["/ui/passkeys/sign-in/options", null],
      ["/ui/passkeys/sign-in", null],
    ];
    for (const [path, cookie] of routes) {
      for (const origin of [
        null,
        "http://192.168.1.20:11238",
        "http://markets.test",
        "null",
        "https://markets.test/path",
      ]) {
        const init = t.post(cookie, {});
        const headers = init.headers as Record<string, string>;
        if (origin === null) delete headers.origin;
        else headers.origin = origin;
        const res = await t.at(path, init);
        expect([path, origin, res.status]).toEqual([path, origin, 403]);
      }
      const foreign = await t.at(
        path,
        t.post(cookie, {}, { "sec-fetch-site": "cross-site" }),
      );
      expect([path, foreign.status]).toEqual([path, 403]);
    }
  });

  test("the account routes are a login's own: a key is 403, none 401", async () => {
    const t = setup();
    const ana = t.person("ana", ANA);
    const key = { authorization: `Bearer ${ADMIN_KEY}` };
    const calls: [string, string][] = [
      ["GET", "/ui/passkeys"],
      ["POST", "/ui/passkeys/options"],
      ["POST", "/ui/passkeys"],
      ["DELETE", "/ui/passkeys/abcdefabcdef"],
    ];
    for (const [method, path] of calls) {
      const withKey = await t.at(path, t.post(ana, {}, key, method));
      expect([path, withKey.status]).toEqual([path, 403]);
      const none = await t.at(path, t.post(null, {}, {}, method));
      expect([path, none.status]).toEqual([path, 401]);
    }
    expect(
      (await t.at("/ui/passkeys/options", { headers: { cookie: ana } })).status,
    ).toBe(405);
    expect((await t.at("/ui/passkeys/sign-in")).status).toBe(405);
  });

  test(`the answers share the ${ASKS_PER_MINUTE} asks a minute of a client address with the codes, the options have their own`, async () => {
    const t = setup();
    const ip = "192.0.2.7";
    const code = () =>
      t.at(
        "/ui/code",
        t.post(
          null,
          { email: ANA, code: "000000" },
          {
            cookie: `${ASK_COOKIE}=${"A".repeat(43)}`,
          },
        ),
        ip,
      );
    const options = () =>
      t.at("/ui/passkeys/sign-in/options", t.post(null), ip);
    const answer = () =>
      t.at("/ui/passkeys/sign-in", t.post(null, { type: "public-key" }), ip);
    // a sign-in page reloaded often never spends the codes' window
    for (let i = 0; i < OPTIONS_PER_MINUTE; i++) {
      expect((await options()).status).toBe(200);
    }
    const tooMany = await options();
    expect(tooMany.status).toBe(429);
    expect(tooMany.headers.get("retry-after")).not.toBeNull();
    for (let i = 0; i < ASKS_PER_MINUTE / 2; i++) {
      expect((await code()).status).toBe(401);
      expect((await answer()).status).toBe(401);
    }
    const over = await answer();
    expect(over.status).toBe(429);
    expect(over.headers.get("retry-after")).not.toBeNull();
    expect((await code()).status).toBe(429);
    await t.clock.advance(MINUTE_MS);
    expect((await options()).status).toBe(200);
    expect((await code()).status).toBe(401);
  });

  test("no log line holds a credential id, a key or a challenge", async () => {
    const t = setup();
    const ana = t.person("ana", ANA);
    const key = await authenticator();
    const { options } = await t.addOptions(ana);
    const body = await key.create(options, ORIGIN);
    expect((await t.at("/ui/passkeys", t.post(ana, body))).status).toBe(201);
    const login = await t.signIn(key);
    expect((await t.signIn(key, { spoil: true })).status).toBe(401);
    const spki = toB64url(await key.spki());
    const text = t.lines.join("\n");
    expect(text).toContain("passkey added");
    expect(text).toContain("passkey used");
    expect(text).toContain("reason=signature");
    for (const secret of [key.id, spki, options.challenge, loginOf(login)]) {
      expect(text).not.toContain(secret);
    }
  });
});

describe("the admin key, sign out everywhere and removing a person", () => {
  test("a passkey added from an admin-key login keeps its digest, and a new key ends it", async () => {
    const t = setup();
    const op = cookieFor(t.db, t.clock.now());
    const byLink = t.person("ana", ANA);
    const opKey = await authenticator();
    const anaKey = await authenticator();
    expect((await t.add(op, opKey)).status).toBe(201);
    expect((await t.add(byLink, anaKey)).status).toBe(201);
    const digests = t.db
      .query("select user_id, admin_digest from passkeys order by user_id")
      .all();
    expect(digests).toEqual([
      { user_id: "ana", admin_digest: null },
      { user_id: OPERATOR, admin_digest: adminDigest(ADMIN_KEY) },
    ]);
    const res = await t.signIn(opKey);
    expect(res.status).toBe(200);
    expect(
      t.db
        .query(
          "select count(*) as n from logins where user_id = 'operator' and admin_digest = ?",
        )
        .get(adminDigest(ADMIN_KEY)),
    ).toEqual({ n: 2 });
    // a new user-admin.key: the prune takes its passkeys and their logins
    await t.m.writer.write((db) =>
      pruneLogins(db, t.clock.now(), adminDigest("a-new-made-up-admin-key")),
    );
    expect(t.count("passkeys where user_id = 'operator'")).toBe(0);
    expect(t.count("logins where admin_digest is not null")).toBe(0);
    expect(t.count("passkeys where user_id = 'ana'")).toBe(1);
  });

  test("before the prune, a passkey of an older admin key signs nobody in", async () => {
    const t = setup();
    const op = cookieFor(t.db, t.clock.now());
    const key = await authenticator();
    expect((await t.add(op, key)).status).toBe(201);
    t.db
      .query("update passkeys set admin_digest = ?")
      .run(adminDigest("an-older-made-up-admin-key"));
    expect((await t.signIn(key)).status).toBe(401);
  });

  test("the prune deletes expired challenges", async () => {
    const t = setup();
    await t.signInOptions();
    await t.clock.advance(CHALLENGE_MS);
    await t.m.writer.write((db) => pruneLogins(db, t.clock.now()));
    expect(t.count("passkey_challenges")).toBe(0);
  });

  test("sign out everywhere removes the person's passkeys", async () => {
    const t = setup();
    const ana = t.person("ana", ANA);
    const key = await authenticator();
    expect((await t.add(ana, key)).status).toBe(201);
    const res = await t.at(`${PREFIX}/users/ana/sign-out`, {
      method: "POST",
      headers: { authorization: `Bearer ${ADMIN_KEY}` },
    });
    expect(res.status).toBe(204);
    expect(t.count("passkeys")).toBe(0);
    expect((await t.signIn(key)).status).toBe(401);
  });

  test("removing a person deletes their passkeys and counts them", async () => {
    const t = setup();
    const ana = t.person("ana", ANA);
    expect((await t.add(ana, await authenticator())).status).toBe(201);
    // an add's challenge left unanswered goes with its login
    await t.addOptions(ana);
    const admin = { authorization: `Bearer ${ADMIN_KEY}` };
    const dry = await t.at(`${PREFIX}/users/ana?dry_run=true`, {
      method: "DELETE",
      headers: admin,
    });
    expect(((await dry.json()) as { deleted: Json }).deleted).toMatchObject({
      passkeys: 1,
    });
    const res = await t.at(`${PREFIX}/users/ana`, {
      method: "DELETE",
      headers: admin,
    });
    expect(res.status).toBe(200);
    expect(t.count("passkeys")).toBe(0);
    expect(t.count("passkey_challenges")).toBe(0);
    expect(t.db.query("pragma foreign_key_check").all()).toEqual([]);
  });

  test("a login opened by a passkey of an emailed sign-in holds no digest", async () => {
    const t = setup();
    t.person("ana", ANA);
    const made = await t.m.writer.write((db) =>
      openLogin(db, "ana", t.clock.now()),
    );
    const ana = `${COOKIE}=${made.token}`;
    const key = await authenticator();
    expect((await t.add(ana, key)).status).toBe(201);
    expect((await t.signIn(key)).status).toBe(200);
    expect(
      t.count("logins where user_id = 'ana' and admin_digest is null"),
    ).toBe(3);
  });
});
