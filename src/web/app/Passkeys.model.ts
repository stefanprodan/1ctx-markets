// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// The WebAuthn wire types and their codecs, the passkeys list's lines and
// the words for a failed add or sign-in, kept apart from the browser.

import { ApiError, says } from "../data/api.ts";
import { day, dayIn } from "../lib/format.ts";

// as GET /ui/passkeys answers each
export type PasskeyItem = {
  id: string;
  // base64url
  credential_id: string;
  origin: string;
  device: string;
  created_at: string;
  last_used_at: string | null;
};

type Described = { type: string; id: string; transports?: string[] };

// PublicKeyCredentialCreationOptionsJSON, as the add's options answer
export type CreationJSON = {
  challenge: string;
  rp: { id: string; name: string };
  user: { id: string; name: string; displayName: string };
  pubKeyCredParams: { type: string; alg: number }[];
  timeout: number;
  attestation: string;
  authenticatorSelection: Record<string, unknown>;
  excludeCredentials: Described[];
};

// PublicKeyCredentialRequestOptionsJSON, as the sign-in's options answer
export type RequestJSON = {
  challenge: string;
  rpId: string;
  timeout: number;
  userVerification: string;
  allowCredentials: Described[];
};

export type RegistrationJSON = {
  id: string;
  rawId: string;
  type: "public-key";
  response: {
    clientDataJSON: string;
    authenticatorData: string;
    publicKey: string;
    publicKeyAlgorithm: number;
    transports: string[];
  };
};

export type AssertionJSON = {
  id: string;
  rawId: string;
  type: "public-key";
  response: {
    clientDataJSON: string;
    authenticatorData: string;
    signature: string;
    userHandle: string | null;
  };
};

export function toB64url(bytes: ArrayBuffer | Uint8Array): string {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let text = "";
  for (const v of b) text += String.fromCharCode(v);
  return btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromB64url(s: string): ArrayBuffer {
  const std = s.replace(/-/g, "+").replace(/_/g, "/");
  const text = atob(std + "=".repeat((4 - (std.length % 4)) % 4));
  return Uint8Array.from(text, (c) => c.charCodeAt(0)).buffer;
}

const described = (d: Described) => ({
  type: d.type as "public-key",
  id: fromB64url(d.id),
  ...(d.transports ? { transports: d.transports } : {}),
});

// the bytes create() takes where the answer has base64url
export function creationOf(j: CreationJSON) {
  return {
    ...j,
    challenge: fromB64url(j.challenge),
    user: { ...j.user, id: fromB64url(j.user.id) },
    excludeCredentials: j.excludeCredentials.map(described),
  };
}

export function requestOf(j: RequestJSON) {
  return {
    ...j,
    challenge: fromB64url(j.challenge),
    allowCredentials: j.allowCredentials.map(described),
  };
}

// what create() hands back, as far as the server reads it
export type Attested = {
  id: string;
  rawId: ArrayBuffer;
  toJSON?: () => unknown;
  response: {
    clientDataJSON: ArrayBuffer;
    getAuthenticatorData?: () => ArrayBuffer;
    getPublicKey?: () => ArrayBuffer | null;
    getPublicKeyAlgorithm?: () => number;
    getTransports?: () => string[];
  };
};

export type Asserted = {
  id: string;
  rawId: ArrayBuffer;
  toJSON?: () => unknown;
  response: {
    clientDataJSON: ArrayBuffer;
    authenticatorData: ArrayBuffer;
    signature: ArrayBuffer;
    userHandle: ArrayBuffer | null;
  };
};

// a password manager's own toJSON() may throw or leave fields out
function jsonOf(c: { toJSON?: () => unknown }): Record<string, unknown> {
  try {
    const j = c.toJSON?.() as { response?: unknown } | undefined;
    const r = j?.response;
    return typeof r === "object" && r !== null
      ? (r as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

const text = (v: unknown): string | undefined =>
  typeof v === "string" ? v : undefined;

// the add's answer: toJSON() where the browser has it, each field it
// leaves out from the response's own getters
export function registrationOf(c: Attested): RegistrationJSON {
  const j = jsonOf(c);
  const r = c.response;
  const key = r.getPublicKey?.() ?? null;
  const alg =
    typeof j.publicKeyAlgorithm === "number"
      ? j.publicKeyAlgorithm
      : (r.getPublicKeyAlgorithm?.() ?? 0);
  const transports = Array.isArray(j.transports)
    ? j.transports.filter((t): t is string => typeof t === "string")
    : (r.getTransports?.() ?? []);
  return {
    // the bytes' own form, whatever a password manager put in id
    id: toB64url(c.rawId),
    rawId: toB64url(c.rawId),
    type: "public-key",
    response: {
      clientDataJSON: text(j.clientDataJSON) ?? toB64url(r.clientDataJSON),
      authenticatorData:
        text(j.authenticatorData) ??
        toB64url(r.getAuthenticatorData?.() ?? new ArrayBuffer(0)),
      publicKey: text(j.publicKey) ?? (key === null ? "" : toB64url(key)),
      publicKeyAlgorithm: alg,
      transports,
    },
  };
}

export function assertionOf(c: Asserted): AssertionJSON {
  const r = c.response;
  return {
    // the bytes' own form, whatever a password manager put in id
    id: toB64url(c.rawId),
    rawId: toB64url(c.rawId),
    type: "public-key",
    response: {
      clientDataJSON: toB64url(r.clientDataJSON),
      authenticatorData: toB64url(r.authenticatorData),
      signature: toB64url(r.signature),
      userHandle: r.userHandle === null ? null : toB64url(r.userHandle),
    },
  };
}

// options are used this long before the challenge's end, so the tap and
// the face or finger check still land inside it
export const LEEWAY_MS = 30_000;

const usableFor = (timeout: number) => Math.max(0, timeout - LEEWAY_MS);

export const fresh = (at: number, timeout: number, now: number): boolean =>
  now - at < usableFor(timeout);

// when options fetched at `at` need fetching again
export const refreshIn = (at: number, timeout: number, now: number): number =>
  Math.max(0, at + usableFor(timeout) - now);

// every origin's is listed, so one added at another address never hides;
// it signs in only there, port included, so its row names it
export function elsewhere(p: PasskeyItem, origin: string): string | null {
  if (p.origin === origin) return null;
  try {
    return new URL(p.origin).host;
  } catch {
    return p.origin;
  }
}

// on the reader's own calendar
export function passkeyLines(
  p: PasskeyItem,
  now: number,
  zone: string | undefined,
): { added: string; used: string | null } {
  const on = (iso: string) => day(dayIn(iso, zone), now);
  return {
    added: `Added ${on(p.created_at)}`,
    // none until a sign-in: the add itself asked for the face or finger
    used: p.last_used_at === null ? null : `Last used ${on(p.last_used_at)}`,
  };
}

// the emailed sign-in's landing carries it once, for the passkey step
const SIGNED_IN = "signed_in";

export function takeSignedIn(search: string): {
  found: boolean;
  search: string;
} {
  const q = new URLSearchParams(search);
  if (!q.has(SIGNED_IN)) return { found: false, search };
  // only the landing's own value asks; any other is dropped all the same
  const found = q.get(SIGNED_IN) === "1";
  q.delete(SIGNED_IN);
  const rest = q.toString();
  return { found, search: rest === "" ? "" : `?${rest}` };
}

const named = (e: unknown): string | null =>
  typeof e === "object" && e !== null && "name" in e
    ? String((e as { name: unknown }).name)
    : null;

// the person closed the browser's sheet, or it timed out
export const cancelled = (e: unknown): boolean => {
  const n = named(e);
  return n === "NotAllowedError" || n === "AbortError";
};

// the server holds no such passkey: the browser is asked to forget it
export const UNKNOWN_PASSKEY = "unknown_passkey";

// a failed add or sign-in in plain words; null for a cancel
export function passkeyWords(e: unknown, adding: boolean): string | null {
  if (cancelled(e)) return null;
  if (e instanceof ApiError && e.code === UNKNOWN_PASSKEY) {
    return "This passkey was removed. Sign in another way.";
  }
  if (e instanceof ApiError) return says(e);
  if (named(e) === "InvalidStateError") {
    return "This device already has a passkey.";
  }
  return adding ? "The passkey was not added." : "The passkey did not work.";
}
