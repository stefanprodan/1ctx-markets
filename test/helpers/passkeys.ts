// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// A fake authenticator on WebCrypto: a P-256 or an RSA key answering an
// add and a sign-in for a challenge, as a browser's toJSON() gives them.
// Each answer can be bent one way, so a test names the check it breaks.

import { createHash } from "node:crypto";
import { type Bytes, concat, toB64url } from "../../src/push/crypto.ts";

export type Kind = "ES256" | "RS256" | "RS1024" | "P384";

const UP = 0x01;
const UV = 0x04;
const AT = 0x40;

const sha256 = (v: Bytes | string): Bytes =>
  new Uint8Array(createHash("sha256").update(v).digest());

const u16 = (n: number): Bytes => new Uint8Array([n >> 8, n & 0xff]);
const u32 = (n: number): Bytes =>
  new Uint8Array([n >>> 24, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]);

// one DER INTEGER of an unsigned big-endian value
function derInteger(v: Bytes): Bytes {
  let i = 0;
  while (i < v.length - 1 && v[i] === 0) i++;
  let body = v.slice(i);
  if (body[0]! & 0x80) body = concat(new Uint8Array([0]), body);
  return concat(new Uint8Array([0x02, body.length]), body);
}

// WebCrypto's raw r || s as the DER a browser hands over
export function rawToDer(raw: Bytes): Bytes {
  const half = raw.length / 2;
  const body = concat(
    derInteger(raw.slice(0, half)),
    derInteger(raw.slice(half)),
  );
  return concat(new Uint8Array([0x30, body.length]), body);
}

const fromB64 = (v: string): Bytes =>
  new Uint8Array(Buffer.from(v, "base64url"));

const algorithm = (kind: Kind) =>
  kind === "ES256"
    ? { name: "ECDSA", namedCurve: "P-256" }
    : kind === "P384"
      ? { name: "ECDSA", namedCurve: "P-384" }
      : {
          name: "RSASSA-PKCS1-v1_5",
          modulusLength: kind === "RS1024" ? 1024 : 2048,
          publicExponent: new Uint8Array([1, 0, 1]),
          hash: "SHA-256",
        };

const signParams = (kind: Kind) =>
  kind === "ES256"
    ? { name: "ECDSA", hash: "SHA-256" }
    : kind === "P384"
      ? { name: "ECDSA", hash: "SHA-384" }
      : { name: "RSASSA-PKCS1-v1_5" };

// the COSE key an authenticator writes after the credential id; the
// server never reads it, so its form only has to be plausible
async function coseKey(kind: Kind, key: CryptoKey): Promise<Bytes> {
  const jwk = await crypto.subtle.exportKey("jwk", key);
  if (kind === "ES256" || kind === "P384") {
    const x = fromB64(jwk.x!);
    const y = fromB64(jwk.y!);
    return concat(
      new Uint8Array([0xa5, 0x01, 0x02, 0x03, 0x26, 0x20, 0x01]),
      new Uint8Array([0x21, 0x58, x.length]),
      x,
      new Uint8Array([0x22, 0x58, y.length]),
      y,
    );
  }
  const n = fromB64(jwk.n!);
  const e = fromB64(jwk.e!);
  return concat(
    new Uint8Array([0xa4, 0x01, 0x03, 0x03, 0x39, 0x01, 0x00]),
    new Uint8Array([0x20, 0x59]),
    u16(n.length),
    n,
    new Uint8Array([0x21, 0x40 + e.length]),
    e,
  );
}

type Client = {
  type?: string;
  challenge?: string;
  origin?: string;
  crossOrigin?: boolean;
};

// what an answer may be bent by; the rest is as a real authenticator does
export type Bend = {
  client?: Client;
  // the relying party hashed into the authenticator data
  rpId?: string;
  flags?: number;
  count?: number;
  // the credential id written into an add's authenticator data
  attestedId?: Bytes;
  // the authenticator model in an add's authenticator data, zeros if unset
  aaguid?: Bytes;
  // bytes after the authenticator data's own, signed with it
  tail?: Bytes;
  // an add's key and algorithm as the page sends them
  publicKey?: Bytes;
  alg?: number;
  // a sign-in's user handle
  userHandle?: Bytes | null;
  // a sign-in's signature, made and then spoiled
  spoil?: boolean;
};

export type CreationOptions = {
  challenge: string;
  rp: { id: string };
  user: { id: string };
};

export type RequestOptions = { challenge: string; rpId: string };

export type Authenticator = {
  kind: Kind;
  id: string;
  rawId: Bytes;
  // the count the next answer carries; 0 stays 0, as Apple's passkeys do
  count: number;
  // the user handle the add stored, as the browser keeps it
  userHandle: Bytes | null;
  spki(): Promise<Bytes>;
  create(
    options: CreationOptions,
    origin: string,
    bend?: Bend,
  ): Promise<Record<string, unknown>>;
  get(
    options: RequestOptions,
    origin: string,
    bend?: Bend,
  ): Promise<Record<string, unknown>>;
};

export async function authenticator(
  kind: Kind = "ES256",
  count = 0,
): Promise<Authenticator> {
  const pair = (await crypto.subtle.generateKey(algorithm(kind), true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const rawId = crypto.getRandomValues(new Uint8Array(16));
  const clientData = (
    type: string,
    challenge: string,
    origin: string,
    c: Client = {},
  ): Bytes =>
    new TextEncoder().encode(
      JSON.stringify({
        type: c.type ?? type,
        challenge: c.challenge ?? challenge,
        origin: c.origin ?? origin,
        crossOrigin: c.crossOrigin ?? false,
      }),
    );
  const spki = async () =>
    new Uint8Array(await crypto.subtle.exportKey("spki", pair.publicKey));
  const a: Authenticator = {
    kind,
    id: toB64url(rawId),
    rawId,
    count,
    userHandle: null,
    spki,
    async create(options, origin, bend = {}) {
      const client = clientData(
        "webauthn.create",
        options.challenge,
        origin,
        bend.client,
      );
      const id = bend.attestedId ?? rawId;
      const auth = concat(
        sha256(bend.rpId ?? options.rp.id),
        new Uint8Array([bend.flags ?? UP | UV | AT]),
        u32(bend.count ?? a.count),
        bend.aaguid ?? new Uint8Array(16),
        u16(id.length),
        id,
        await coseKey(kind, pair.publicKey),
        bend.tail ?? new Uint8Array(0),
      );
      a.userHandle = fromB64(options.user.id);
      return {
        id: a.id,
        rawId: a.id,
        type: "public-key",
        authenticatorAttachment: "platform",
        clientExtensionResults: {},
        response: {
          clientDataJSON: toB64url(client),
          authenticatorData: toB64url(auth),
          attestationObject: toB64url(new Uint8Array(8)),
          publicKey: toB64url(bend.publicKey ?? (await spki())),
          publicKeyAlgorithm:
            bend.alg ?? (kind === "ES256" || kind === "P384" ? -7 : -257),
          transports: ["hybrid", "internal"],
        },
      };
    },
    async get(options, origin, bend = {}) {
      const client = clientData(
        "webauthn.get",
        options.challenge,
        origin,
        bend.client,
      );
      if (a.count > 0) a.count++;
      const auth = concat(
        sha256(bend.rpId ?? options.rpId),
        new Uint8Array([bend.flags ?? UP | UV]),
        u32(bend.count ?? a.count),
        bend.tail ?? new Uint8Array(0),
      );
      const signed = concat(auth, sha256(client));
      let signature = new Uint8Array(
        await crypto.subtle.sign(signParams(kind), pair.privateKey, signed),
      );
      if (kind === "ES256" || kind === "P384") signature = rawToDer(signature);
      if (bend.spoil) {
        const last = signature.length - 1;
        signature[last] = signature[last]! ^ 0x01;
      }
      const handle =
        bend.userHandle === undefined ? a.userHandle : bend.userHandle;
      return {
        id: a.id,
        rawId: a.id,
        type: "public-key",
        authenticatorAttachment: "platform",
        clientExtensionResults: {},
        response: {
          clientDataJSON: toB64url(client),
          authenticatorData: toB64url(auth),
          signature: toB64url(signature),
          userHandle: handle === null ? null : toB64url(handle),
        },
      };
    },
  };
  return a;
}
