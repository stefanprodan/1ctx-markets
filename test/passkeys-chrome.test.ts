// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// A real browser's answers, recorded from Chrome's virtual authenticator,
// through the server's checks: the fake authenticator shares the parser's
// reading of the layout, so only bytes a browser made can catch a
// misreading of it.

import { describe, expect, test } from "bun:test";
import {
  assertionOf,
  checkAssertion,
  checkRegistration,
  registrationOf,
  type Want,
} from "../src/server/passkeys/checks.ts";
import fixture from "./fixtures/passkeys/chrome.json";

const want = (type: Want["type"]): Want => ({
  type,
  origin: fixture.origin,
  rpId: fixture.rpId,
});

async function added() {
  const r = registrationOf(fixture.add.answer);
  if (r === null) throw new Error("the add did not parse");
  const a = await checkRegistration(r, want("webauthn.create"));
  if ("refused" in a) throw new Error(`the add was refused: ${a.refused}`);
  return a;
}

describe("a passkey recorded from chrome", () => {
  test("adds with its challenge", async () => {
    const a = await added();
    expect(a.challenge).toBe(fixture.add.challenge);
    expect(a.credentialId).toBe(fixture.add.answer.id);
    expect(a.alg).toBe(-7);
    // the virtual authenticator's placeholder model, in no provider's list
    expect(a.aaguid).toBe("01020304-0506-0708-0102-030405060708");
  });

  test("signs in with its challenge", async () => {
    const a = await added();
    const s = assertionOf(fixture.signIn.answer);
    if (s === null) throw new Error("the sign-in did not parse");
    const out = await checkAssertion(s, want("webauthn.get"), {
      user: fixture.user,
      publicKey: a.publicKey,
      alg: a.alg,
      signCount: a.signCount,
    });
    expect(out).toEqual({
      challenge: fixture.signIn.challenge,
      signCount: expect.any(Number),
    });
  });

  test("refuses a changed signature", async () => {
    const a = await added();
    const body = structuredClone(fixture.signIn.answer);
    const sig = body.response.signature;
    // a byte inside r, so the DER still parses
    body.response.signature = `${sig.slice(0, 12)}${sig[12] === "A" ? "B" : "A"}${sig.slice(13)}`;
    const s = assertionOf(body);
    if (s === null) throw new Error("the sign-in did not parse");
    const out = await checkAssertion(s, want("webauthn.get"), {
      user: fixture.user,
      publicKey: a.publicKey,
      alg: a.alg,
      signCount: a.signCount,
    });
    expect(out).toEqual({ refused: "signature" });
  });

  test("refuses another origin", async () => {
    const r = registrationOf(fixture.add.answer);
    if (r === null) throw new Error("the add did not parse");
    const out = await checkRegistration(r, {
      ...want("webauthn.create"),
      origin: "https://markets.test",
    });
    expect(out).toEqual({ refused: "origin" });
  });
});
