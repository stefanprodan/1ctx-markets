// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// The authenticator data's fixed layout (WebAuthn, "Authenticator Data")
// and an ES256 signature's DER as WebCrypto takes it. The credential's
// COSE key is never read: the browser hands it over as SPKI.

import type { Bytes } from "../../push/crypto.ts";

export const FLAG_UP = 0x01;
export const FLAG_UV = 0x04;
export const FLAG_BE = 0x08;
export const FLAG_BS = 0x10;
export const FLAG_AT = 0x40;
export const FLAG_ED = 0x80;

const HEAD = 37;
const AAGUID = 16;
// WebAuthn caps a credential id at 1023 bytes
export const MAX_CREDENTIAL_ID = 1023;

export type AuthenticatorData = {
  rpIdHash: Bytes;
  flags: number;
  signCount: number;
  // only with the attested-data flag, as an add carries it
  credentialId: Bytes | null;
  // the authenticator model, as 8-4-4-4-12 hex
  aaguid: string | null;
};

// null for bytes shorter or longer than their flags say
export function parseAuthenticatorData(bytes: Bytes): AuthenticatorData | null {
  if (bytes.length < HEAD) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const flags = bytes[32]!;
  const out: AuthenticatorData = {
    rpIdHash: bytes.slice(0, 32),
    flags,
    signCount: view.getUint32(33),
    credentialId: null,
    aaguid: null,
  };
  if ((flags & FLAG_AT) === 0) {
    // the extension data is never read, so only its flag allows a tail
    if ((flags & FLAG_ED) === 0 && bytes.length !== HEAD) return null;
    return out;
  }
  if (bytes.length < HEAD + AAGUID + 2) return null;
  const length = view.getUint16(HEAD + AAGUID);
  const start = HEAD + AAGUID + 2;
  if (length === 0 || length > MAX_CREDENTIAL_ID) return null;
  // a key follows the id, so the id never runs to the end
  if (bytes.length <= start + length) return null;
  out.credentialId = bytes.slice(start, start + length);
  out.aaguid = uuid(bytes.slice(HEAD, HEAD + AAGUID));
  return out;
}

function uuid(b: Bytes): string {
  const hex = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// one DER INTEGER, its sign byte dropped, left-padded to size
function integer(der: Bytes, at: number, size: number) {
  if (der[at] !== 0x02) return null;
  const length = der[at + 1];
  if (length === undefined || length === 0 || length > size + 1) return null;
  let value = der.slice(at + 2, at + 2 + length);
  if (value.length !== length) return null;
  if (length === size + 1) {
    if (value[0] !== 0) return null;
    value = value.slice(1);
  }
  const out = new Uint8Array(size);
  out.set(value, size - value.length);
  return { value: out, next: at + 2 + length };
}

// SEQUENCE { r INTEGER, s INTEGER } to the raw r || s of P-256; null for
// anything else
export function derToRaw(der: Bytes): Bytes | null {
  if (der.length < 8 || der[0] !== 0x30 || der[1] !== der.length - 2) {
    return null;
  }
  const r = integer(der, 2, 32);
  if (r === null) return null;
  const s = integer(der, r.next, 32);
  if (s === null || s.next !== der.length) return null;
  const out = new Uint8Array(64);
  out.set(r.value, 0);
  out.set(s.value, 32);
  return out;
}
