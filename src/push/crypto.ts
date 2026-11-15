// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// Web Push on WebCrypto alone: the payload's aes128gcm encryption (RFC 8291)
// and the VAPID token that signs each post (RFC 8292).

const enc = new TextEncoder();

// WebCrypto takes bytes over a plain ArrayBuffer
export type Bytes = Uint8Array<ArrayBuffer>;

export const toB64url = (bytes: Bytes | ArrayBuffer): string =>
  Buffer.from(
    bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes),
  ).toString("base64url");

export const fromB64url = (text: string): Bytes =>
  new Uint8Array(Buffer.from(text, "base64url"));

export function concat(...parts: Bytes[]): Bytes {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

// WebCrypto's HKDF is extract then expand in one call
export async function hkdf(
  salt: Bytes,
  ikm: Bytes,
  info: Bytes,
  bytes: number,
): Promise<Bytes> {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, [
    "deriveBits",
  ]);
  return new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "HKDF", hash: "SHA-256", salt, info },
      key,
      bytes * 8,
    ),
  );
}

export const RECORD_SIZE = 4096;
// a P-256 public key, uncompressed
export const PUBLIC_KEY_BYTES = 65;

// the content key and nonce both sides derive from the shared secret
export async function contentKeys(
  ecdh: Bytes,
  auth: Bytes,
  uaPublic: Bytes,
  asPublic: Bytes,
  salt: Bytes,
): Promise<{ cek: Bytes; nonce: Bytes }> {
  const keyInfo = concat(enc.encode("WebPush: info\0"), uaPublic, asPublic);
  const ikm = await hkdf(auth, ecdh, keyInfo, 32);
  const cek = await hkdf(
    salt,
    ikm,
    enc.encode("Content-Encoding: aes128gcm\0"),
    16,
  );
  const nonce = await hkdf(
    salt,
    ikm,
    enc.encode("Content-Encoding: nonce\0"),
    12,
  );
  return { cek, nonce };
}

export type Sender = { pair: CryptoKeyPair; publicRaw: Bytes };

export async function ecdhPair(): Promise<Sender> {
  const pair = (await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"],
  )) as CryptoKeyPair;
  const publicRaw = new Uint8Array(
    await crypto.subtle.exportKey("raw", pair.publicKey),
  );
  return { pair, publicRaw };
}

export async function sharedSecret(
  own: CryptoKey,
  other: Bytes,
): Promise<Bytes> {
  const pub = await crypto.subtle.importKey(
    "raw",
    other,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
  return new Uint8Array(
    await crypto.subtle.deriveBits({ name: "ECDH", public: pub }, own, 256),
  );
}

// one record: the payload, then the last record's delimiter; a fresh key
// pair and salt each time, unless a test fixes them
export async function encrypt(
  payload: Bytes,
  uaPublic: Bytes,
  auth: Bytes,
  fixed: { sender?: Sender; salt?: Bytes } = {},
): Promise<Bytes> {
  const sender = fixed.sender ?? (await ecdhPair());
  const salt = fixed.salt ?? crypto.getRandomValues(new Uint8Array(16));
  const ecdh = await sharedSecret(sender.pair.privateKey, uaPublic);
  const { cek, nonce } = await contentKeys(
    ecdh,
    auth,
    uaPublic,
    sender.publicRaw,
    salt,
  );
  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, [
    "encrypt",
  ]);
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: nonce },
      key,
      concat(payload, new Uint8Array([2])),
    ),
  );
  const header = new Uint8Array(21);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, RECORD_SIZE);
  header[20] = sender.publicRaw.length;
  return concat(header, sender.publicRaw, sealed);
}

export type Vapid = {
  privateKey: CryptoKey;
  // the uncompressed public key, the page's applicationServerKey
  publicKey: Bytes;
};

// push-vapid.key's PKCS #8 text; null when it holds no P-256 private key
export async function vapidKeys(pkcs8: string): Promise<Vapid | null> {
  try {
    const algorithm = { name: "ECDSA", namedCurve: "P-256" };
    const privateKey = await crypto.subtle.importKey(
      "pkcs8",
      fromB64url(pkcs8),
      algorithm,
      true,
      ["sign"],
    );
    const jwk = await crypto.subtle.exportKey("jwk", privateKey);
    const publicKey = concat(
      new Uint8Array([4]),
      fromB64url(jwk.x ?? ""),
      fromB64url(jwk.y ?? ""),
    );
    if (publicKey.length !== PUBLIC_KEY_BYTES) return null;
    return { privateKey, publicKey };
  } catch {
    return null;
  }
}

// 12 hours, under the 24 RFC 8292 allows
export const TOKEN_S = 12 * 3600;

// the Authorization header for one endpoint's origin
export async function vapidAuth(
  keys: Vapid,
  endpoint: string,
  subject: string,
  now: number,
): Promise<string> {
  const part = (v: unknown) => toB64url(enc.encode(JSON.stringify(v)));
  const signing = `${part({ typ: "JWT", alg: "ES256" })}.${part({
    aud: new URL(endpoint).origin,
    exp: Math.floor(now / 1000) + TOKEN_S,
    sub: subject,
  })}`;
  // WebCrypto signs ECDSA as r and s side by side, the form JWS wants
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    keys.privateKey,
    enc.encode(signing),
  );
  return `vapid t=${signing}.${toB64url(signature)}, k=${toB64url(keys.publicKey)}`;
}
