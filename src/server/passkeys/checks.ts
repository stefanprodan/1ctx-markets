// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// Every check of an add and a sign-in (WebAuthn, "Registering a New
// Credential" and "Verifying an Authentication Assertion"), attestation
// none: the browser's getPublicKey() and getAuthenticatorData() hand over
// what the attestation object holds, so it is never read.

import { createHash } from "node:crypto";
import { type Bytes, fromB64url, toB64url } from "../../push/crypto.ts";
import {
  type AuthenticatorData,
  derToRaw,
  FLAG_AT,
  FLAG_BE,
  FLAG_BS,
  FLAG_UP,
  FLAG_UV,
  MAX_CREDENTIAL_ID,
  parseAuthenticatorData,
} from "./authenticator.ts";

export const ES256 = -7;
export const RS256 = -257;
export const ALGS = [ES256, RS256] as const;
export type Alg = (typeof ALGS)[number];
const MIN_RSA_BITS = 2048;

// what refused an answer: logged, never answered, as every failed sign-in
// reads the same
export type Reason =
  | "body"
  | "client_data"
  | "challenge"
  | "origin"
  | "cross_origin"
  | "rp"
  | "flags"
  | "credential"
  | "key"
  | "user"
  | "signature"
  | "count"
  | "admin_key";

export type Refused = { refused: Reason };
const refuse = (reason: Reason): Refused => ({ refused: reason });

const B64URL = /^[A-Za-z0-9_-]*$/;
// a field's base64url, at most bytes long once decoded
function bytesOf(value: unknown, max: number): Bytes | null {
  if (typeof value !== "string" || !B64URL.test(value)) return null;
  if (value.length > Math.ceil((max * 4) / 3)) return null;
  const out = fromB64url(value);
  // one spelling per value, so the id compared is the id stored
  return toB64url(out) === value ? out : null;
}

const MAX_CLIENT_DATA = 2048;
const MAX_AUTH_DATA = 2048;
const MAX_KEY = 1024;
const MAX_SIGNATURE = 1024;
const MAX_USER_HANDLE = 64;
const TRANSPORTS = new Set([
  "ble",
  "hybrid",
  "internal",
  "nfc",
  "smart-card",
  "usb",
]);

type Common = {
  id: string;
  rawId: Bytes;
  clientDataJSON: Bytes;
  authenticatorData: Bytes;
};

export type Registration = Common & {
  publicKey: Bytes;
  alg: number;
  transports: string[];
};

export type Assertion = Common & {
  signature: Bytes;
  userHandle: Bytes | null;
};

const record = (v: unknown): Record<string, unknown> | null =>
  typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;

function commonOf(body: Record<string, unknown>) {
  const response = record(body.response);
  if (body.type !== "public-key" || response === null) return null;
  const rawId = bytesOf(body.rawId, MAX_CREDENTIAL_ID);
  const clientDataJSON = bytesOf(response.clientDataJSON, MAX_CLIENT_DATA);
  const authenticatorData = bytesOf(response.authenticatorData, MAX_AUTH_DATA);
  if (
    rawId === null ||
    rawId.length === 0 ||
    body.id !== toB64url(rawId) ||
    clientDataJSON === null ||
    authenticatorData === null
  ) {
    return null;
  }
  return {
    response,
    common: { id: body.id as string, rawId, clientDataJSON, authenticatorData },
  };
}

// an add's answer as the browser's toJSON() gives it; null for anything else
export function registrationOf(
  body: Record<string, unknown>,
): Registration | null {
  const c = commonOf(body);
  if (c === null) return null;
  const publicKey = bytesOf(c.response.publicKey, MAX_KEY);
  const alg = c.response.publicKeyAlgorithm;
  const transports = c.response.transports ?? [];
  if (
    publicKey === null ||
    publicKey.length === 0 ||
    !Number.isInteger(alg) ||
    !Array.isArray(transports) ||
    transports.length > TRANSPORTS.size
  ) {
    return null;
  }
  return {
    ...c.common,
    publicKey,
    alg: alg as number,
    transports: [
      ...new Set(
        transports.filter(
          (t): t is string => typeof t === "string" && TRANSPORTS.has(t),
        ),
      ),
    ].sort(),
  };
}

// a sign-in's answer as the browser's toJSON() gives it
export function assertionOf(body: Record<string, unknown>): Assertion | null {
  const c = commonOf(body);
  if (c === null) return null;
  const signature = bytesOf(c.response.signature, MAX_SIGNATURE);
  const handle = c.response.userHandle;
  const userHandle =
    handle === undefined || handle === null
      ? null
      : bytesOf(handle, MAX_USER_HANDLE);
  if (signature === null || signature.length === 0) return null;
  if (handle !== undefined && handle !== null && userHandle === null) {
    return null;
  }
  return { ...c.common, signature, userHandle };
}

export type ClientData = {
  type: string;
  challenge: string;
  origin: string;
  crossOrigin: boolean;
};

function clientDataOf(bytes: Bytes): ClientData | null {
  let c: Record<string, unknown> | null;
  try {
    c = record(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
    );
  } catch {
    return null;
  }
  if (
    c === null ||
    typeof c.type !== "string" ||
    typeof c.challenge !== "string" ||
    typeof c.origin !== "string" ||
    (c.crossOrigin !== undefined && typeof c.crossOrigin !== "boolean")
  ) {
    return null;
  }
  return {
    type: c.type,
    challenge: c.challenge,
    origin: c.origin,
    crossOrigin: c.crossOrigin === true,
  };
}

const sha256 = (bytes: Bytes | string): Bytes =>
  new Uint8Array(createHash("sha256").update(bytes).digest());

const equal = (a: Bytes, b: Bytes): boolean =>
  a.length === b.length && a.every((v, i) => v === b[i]);

export type Want = {
  type: "webauthn.create" | "webauthn.get";
  // the request's Origin, and its hostname as the relying party
  origin: string;
  rpId: string;
};

type Checked = { challenge: string; auth: AuthenticatorData };

// what both ceremonies check; the caller looks the challenge up
function ceremony(
  clientDataJSON: Bytes,
  authenticatorData: Bytes,
  want: Want,
): Checked | Refused {
  const client = clientDataOf(clientDataJSON);
  if (client === null || client.type !== want.type) {
    return refuse("client_data");
  }
  if (client.origin !== want.origin) return refuse("origin");
  // the page sends no frame-ancestors, so a frame could ask
  if (client.crossOrigin) return refuse("cross_origin");
  const auth = parseAuthenticatorData(authenticatorData);
  if (auth === null) return refuse("body");
  if (!equal(auth.rpIdHash, sha256(want.rpId))) return refuse("rp");
  // a passkey is the sign-in's only factor
  const need = FLAG_UP | FLAG_UV;
  if ((auth.flags & need) !== need) return refuse("flags");
  // backed up yet not eligible for backup is no authenticator's state
  if ((auth.flags & FLAG_BS) !== 0 && (auth.flags & FLAG_BE) === 0) {
    return refuse("flags");
  }
  return { challenge: client.challenge, auth };
}

const algorithmOf = (alg: Alg) =>
  alg === ES256
    ? { name: "ECDSA", namedCurve: "P-256" }
    : { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" };

// the SPKI imported for the algorithm it is named for; another curve or
// kind fails the import
export async function importKey(
  spki: Bytes,
  alg: number,
): Promise<CryptoKey | null> {
  if (alg !== ES256 && alg !== RS256) return null;
  let key: CryptoKey;
  try {
    key = await crypto.subtle.importKey("spki", spki, algorithmOf(alg), false, [
      "verify",
    ]);
  } catch {
    return null;
  }
  if (alg === RS256) {
    const bits = (key.algorithm as RsaHashedKeyAlgorithm).modulusLength;
    if (bits < MIN_RSA_BITS) return null;
  }
  return key;
}

export type Added = {
  challenge: string;
  credentialId: string;
  publicKey: Bytes;
  alg: Alg;
  signCount: number;
  transports: string[];
  aaguid: string | null;
};

export async function checkRegistration(
  r: Registration,
  want: Want,
): Promise<Added | Refused> {
  const c = ceremony(r.clientDataJSON, r.authenticatorData, want);
  if ("refused" in c) return c;
  if ((c.auth.flags & FLAG_AT) === 0) return refuse("flags");
  if (c.auth.credentialId === null || !equal(c.auth.credentialId, r.rawId)) {
    return refuse("credential");
  }
  if ((await importKey(r.publicKey, r.alg)) === null) return refuse("key");
  return {
    challenge: c.challenge,
    credentialId: r.id,
    publicKey: r.publicKey,
    alg: r.alg as Alg,
    signCount: c.auth.signCount,
    transports: r.transports,
    aaguid: c.auth.aaguid,
  };
}

// what a sign-in checks against: the passkey's row and its person
export type Stored = {
  user: string;
  publicKey: Bytes;
  alg: number;
  signCount: number;
};

// WebAuthn's rule: once either count is above 0, the new one is greater
export const countMoves = (stored: number, sent: number): boolean =>
  (stored === 0 && sent === 0) || sent > stored;

export async function checkAssertion(
  a: Assertion,
  want: Want,
  stored: Stored,
): Promise<{ challenge: string; signCount: number } | Refused> {
  const c = ceremony(a.clientDataJSON, a.authenticatorData, want);
  if ("refused" in c) return c;
  // a sign-in attests no credential
  if ((c.auth.flags & FLAG_AT) !== 0) return refuse("flags");
  // the user id the passkey was made for is the person's users.id
  if (
    a.userHandle === null ||
    !equal(a.userHandle, new TextEncoder().encode(stored.user))
  ) {
    return refuse("user");
  }
  const key = await importKey(stored.publicKey, stored.alg);
  if (key === null) return refuse("key");
  const signed = new Uint8Array(a.authenticatorData.length + 32);
  signed.set(a.authenticatorData, 0);
  signed.set(sha256(a.clientDataJSON), a.authenticatorData.length);
  const signature = stored.alg === ES256 ? derToRaw(a.signature) : a.signature;
  if (signature === null) return refuse("signature");
  const ok = await crypto.subtle.verify(
    stored.alg === ES256
      ? { name: "ECDSA", hash: "SHA-256" }
      : { name: "RSASSA-PKCS1-v1_5" },
    key,
    signature,
    signed,
  );
  if (!ok) return refuse("signature");
  if (!countMoves(stored.signCount, c.auth.signCount)) return refuse("count");
  return { challenge: c.challenge, signCount: c.auth.signCount };
}
