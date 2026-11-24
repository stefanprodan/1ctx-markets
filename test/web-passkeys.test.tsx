// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { options, type VNode } from "preact";
import { render } from "preact-render-to-string";
import {
  type AssertionJSON,
  assertionOf,
  type CreationJSON,
  cancelled,
  creationOf,
  elsewhere,
  fresh,
  fromB64url,
  LEEWAY_MS,
  type PasskeyItem,
  passkeyLines,
  passkeyWords,
  type RegistrationJSON,
  type RequestJSON,
  refreshIn,
  registrationOf,
  requestOf,
  takeSignedIn,
  toB64url,
} from "../src/web/app/Passkeys.model.ts";
import {
  type Address,
  dropSignedIn,
  PasskeysDrawer,
  PasskeysList,
  watchStep,
} from "../src/web/app/Passkeys.tsx";
import { UserItems } from "../src/web/app/UserMenu.tsx";
import { ApiError, type Fetch } from "../src/web/data/api.ts";
import {
  PASSKEY_OPTIONS_PATH,
  PASSKEY_SIGN_IN_OPTIONS_PATH,
  PASSKEY_SIGN_IN_PATH,
  PASSKEYS_PATH,
  type PasskeyDevice,
} from "../src/web/data/passkeys.ts";
import type { PushDevice } from "../src/web/data/push.ts";
import { markets, store } from "../src/web/data/store.ts";
import type { Later } from "../src/web/lib/slow.ts";
import { MenuButton, type MenuItem } from "../src/web/ui/Menu.tsx";
import { PasskeyStep, SignIn, wayOf } from "../src/web/views/SignIn.tsx";

const HOST = "markets.example.com";
const ORIGIN = `https://${HOST}`;
// the same host on another port
const LOCAL = "http://localhost:11239";
const NOW = Date.UTC(2026, 10, 24, 12, 0);
const bytes = (...v: number[]) => new Uint8Array(v).buffer;
const b64 = (...v: number[]) => toB64url(new Uint8Array(v));

const item = (over: Partial<PasskeyItem> = {}): PasskeyItem => ({
  id: "pk1",
  credential_id: "Y3JlZC0x",
  origin: ORIGIN,
  device: "Apple Passwords",
  created_at: "2026-11-12T09:00:00.000Z",
  last_used_at: null,
  ...over,
});

const CREATION: CreationJSON = {
  challenge: b64(1, 2, 3),
  rp: { id: HOST, name: "Markets" },
  user: { id: b64(111, 112), name: "ana@example.com", displayName: "Ana" },
  pubKeyCredParams: [{ type: "public-key", alg: -7 }],
  timeout: 120_000,
  attestation: "none",
  authenticatorSelection: { residentKey: "required" },
  excludeCredentials: [
    { type: "public-key", id: b64(9), transports: ["internal"] },
  ],
};

const REQUEST: RequestJSON = {
  challenge: b64(4, 5, 6),
  rpId: HOST,
  timeout: 120_000,
  userVerification: "required",
  allowCredentials: [],
};

const REGISTRATION: RegistrationJSON = {
  id: b64(7, 7),
  rawId: b64(7, 7),
  type: "public-key",
  response: {
    clientDataJSON: b64(1),
    authenticatorData: b64(2),
    publicKey: b64(3),
    publicKeyAlgorithm: -7,
    transports: ["internal"],
  },
};

const ASSERTION: AssertionJSON = {
  id: b64(7, 7),
  rawId: b64(7, 7),
  type: "public-key",
  response: {
    clientDataJSON: b64(1),
    authenticatorData: b64(2),
    signature: b64(3),
    userHandle: b64(111),
  },
};

describe("base64url", () => {
  test("round-trips every length, with no padding and no + or /", () => {
    for (const v of [[], [0], [251, 255], [62, 63, 255], [1, 2, 3, 4, 5]]) {
      const s = toB64url(new Uint8Array(v));
      expect(s).not.toMatch(/[+/=]/);
      expect([...new Uint8Array(fromB64url(s))]).toEqual(v);
    }
    expect(toB64url(new Uint8Array([251, 255]))).toBe("-_8");
  });

  test("options turn their base64url fields into bytes", () => {
    const c = creationOf(CREATION);
    expect([...new Uint8Array(c.challenge)]).toEqual([1, 2, 3]);
    expect([...new Uint8Array(c.user.id)]).toEqual([111, 112]);
    expect(c.user.name).toBe("ana@example.com");
    expect([...new Uint8Array(c.excludeCredentials[0]!.id)]).toEqual([9]);
    expect(c.excludeCredentials[0]!.transports).toEqual(["internal"]);
    const r = requestOf(REQUEST);
    expect([...new Uint8Array(r.challenge)]).toEqual([4, 5, 6]);
    expect(r.rpId).toBe(HOST);
  });
});

describe("the browser's answers", () => {
  const getters = {
    clientDataJSON: bytes(1),
    getAuthenticatorData: () => bytes(2),
    getPublicKey: () => bytes(3),
    getPublicKeyAlgorithm: () => -7,
    getTransports: () => ["internal"],
  };

  test("an add's answer is built from the getters without toJSON", () => {
    expect(
      // the id is the raw bytes' form, whatever the browser put in id
      registrationOf({
        id: "made-up+id",
        rawId: bytes(7, 7),
        response: getters,
      }),
    ).toEqual(REGISTRATION);
  });

  test("toJSON is taken where it works, and a throwing one falls back", () => {
    const fromJson = registrationOf({
      id: b64(7, 7),
      rawId: bytes(7, 7),
      toJSON: () => ({
        response: { ...REGISTRATION.response, publicKey: b64(8) },
      }),
      response: getters,
    });
    expect(fromJson.response.publicKey).toBe(b64(8));
    const broken = registrationOf({
      id: b64(7, 7),
      rawId: bytes(7, 7),
      toJSON: () => {
        throw new Error("made-up");
      },
      response: getters,
    });
    expect(broken).toEqual(REGISTRATION);
  });

  test("a sign-in's answer keeps a missing user handle null", () => {
    const r = {
      clientDataJSON: bytes(1),
      authenticatorData: bytes(2),
      signature: bytes(3),
      userHandle: bytes(111),
    };
    expect(
      assertionOf({ id: "made-up+id", rawId: bytes(7, 7), response: r }),
    ).toEqual(ASSERTION);
    expect(
      assertionOf({
        id: b64(7, 7),
        rawId: bytes(7, 7),
        response: { ...r, userHandle: null },
      }).response.userHandle,
    ).toBeNull();
  });
});

describe("the options' freshness", () => {
  test("options serve until the leeway before their timeout", () => {
    expect(fresh(NOW, 120_000, NOW)).toBe(true);
    expect(fresh(NOW, 120_000, NOW + 120_000 - LEEWAY_MS - 1)).toBe(true);
    expect(fresh(NOW, 120_000, NOW + 120_000 - LEEWAY_MS)).toBe(false);
    expect(refreshIn(NOW, 120_000, NOW + 10_000)).toBe(
      120_000 - LEEWAY_MS - 10_000,
    );
    expect(refreshIn(NOW, 120_000, NOW + 500_000)).toBe(0);
  });
});

describe("the list", () => {
  test("names the address a passkey of another origin signs in at, port included", () => {
    expect(elsewhere(item(), ORIGIN)).toBeNull();
    expect(elsewhere(item({ origin: LOCAL }), ORIGIN)).toBe("localhost:11239");
    expect(elsewhere(item({ origin: LOCAL }), "http://localhost:3000")).toBe(
      "localhost:11239",
    );
  });

  test("names the day added and the day last used", () => {
    expect(passkeyLines(item(), NOW, "UTC")).toEqual({
      added: "Added 12 Nov",
      used: null,
    });
    expect(
      passkeyLines(
        item({
          created_at: "2025-03-02T10:00:00.000Z",
          last_used_at: "2026-11-20T23:30:00.000Z",
        }),
        NOW,
        "Europe/Bucharest",
      ),
    ).toEqual({ added: "Added 2 Mar 2025", used: "Last used 21 Nov" });
  });
});

describe("the passkey step", () => {
  test("the flag is taken from the address, the rest kept", () => {
    expect(takeSignedIn("?signed_in=1")).toEqual({ found: true, search: "" });
    expect(takeSignedIn("?tab=all&signed_in=1")).toEqual({
      found: true,
      search: "?tab=all",
    });
    expect(takeSignedIn("?tab=all")).toEqual({
      found: false,
      search: "?tab=all",
    });
    expect(takeSignedIn("")).toEqual({ found: false, search: "" });
    // only the landing's own value asks, any other goes all the same
    expect(takeSignedIn("?signed_in=0")).toEqual({ found: false, search: "" });
  });
});

describe("failures", () => {
  test("a cancel says nothing; the rest say what happened", () => {
    const cancel = new DOMException("made-up", "NotAllowedError");
    expect(cancelled(cancel)).toBe(true);
    expect(passkeyWords(cancel, true)).toBeNull();
    expect(
      passkeyWords(new DOMException("made-up", "AbortError"), false),
    ).toBeNull();
    expect(
      passkeyWords(new DOMException("made-up", "InvalidStateError"), true),
    ).toBe("This device already has a passkey.");
    expect(
      passkeyWords(new DOMException("made-up", "SecurityError"), true),
    ).toBe("The passkey was not added.");
    expect(
      passkeyWords(new DOMException("made-up", "SecurityError"), false),
    ).toBe("The passkey did not work.");
    expect(
      passkeyWords(new ApiError(409, "at most 10 passkeys a person"), true),
    ).toBe("At most 10 passkeys a person.");
    expect(passkeyWords(new ApiError(403, "forbidden"), true)).toBe(
      "Forbidden.",
    );
  });
});

function laterFake() {
  const timers: { ms: number; fire: () => void; live: boolean }[] = [];
  const later: Later = (ms, fire) => {
    const t = { ms, fire, live: true };
    timers.push(t);
    return () => {
      t.live = false;
    };
  };
  return { later, live: () => timers.filter((t) => t.live) };
}

type Held = {
  signal: AbortSignal;
  answer: PromiseWithResolvers<AssertionJSON>;
};

function deviceFake(platform = true, autofill = false) {
  const order: string[] = [];
  const state = {
    origin: ORIGIN as string,
    refuse: null as Error | null,
    // an add's sheet still open, answered when the test says
    asking: null as PromiseWithResolvers<RegistrationJSON> | null,
    hidden: false,
    visible: [] as (() => void)[],
    // the autofill's requests, answered when the test says
    held: [] as Held[],
  };
  const device: PasskeyDevice = {
    supported: () => true,
    platform: async () => platform,
    autofill: async () => autofill,
    origin: () => state.origin,
    forget(credentialId) {
      order.push(`forget ${credentialId}`);
    },
    hidden: () => state.hidden,
    onVisible(fire) {
      state.visible.push(fire);
      return () => {
        state.visible = state.visible.filter((f) => f !== fire);
      };
    },
    create(o) {
      order.push(`create ${o.challenge}`);
      if (state.asking !== null) return state.asking.promise;
      return state.refuse === null
        ? Promise.resolve(REGISTRATION)
        : Promise.reject(state.refuse);
    },
    get(o, signal) {
      if (signal === undefined) {
        order.push(`get ${o.challenge}`);
        return Promise.resolve(ASSERTION);
      }
      order.push(`autofill ${o.challenge}`);
      const answer = Promise.withResolvers<AssertionJSON>();
      signal.addEventListener("abort", () =>
        answer.reject(new DOMException("made-up", "AbortError")),
      );
      state.held.push({ signal, answer });
      return answer.promise;
    },
  };
  return { device, order, state };
}

const noPush: PushDevice = {
  support: () => "none",
  current: async () => null,
  subscribe: async () => null,
  unsubscribe: async () => null,
  badge: () => {},
};

function server(list: PasskeyItem[] = []) {
  const knobs = {
    addStatus: 201,
    signIn: null as Response | null,
    // answers held until the test lets them go, and options refused
    optionsGate: null as Promise<void> | null,
    listGate: null as Promise<void> | null,
    optionsFail: 0,
  };
  const asked: { to: string; method: string; body: unknown }[] = [];
  let challenge = 0;
  const fetch: Fetch = async (to, init) => {
    const method = init?.method ?? "GET";
    asked.push({
      to,
      method,
      body: init?.body ? JSON.parse(String(init.body)) : null,
    });
    if (to === PASSKEY_OPTIONS_PATH || to === PASSKEY_SIGN_IN_OPTIONS_PATH) {
      if (knobs.optionsGate !== null) await knobs.optionsGate;
      if (knobs.optionsFail > 0) {
        knobs.optionsFail--;
        return new Response(null, { status: 503 });
      }
      const base = to === PASSKEY_OPTIONS_PATH ? CREATION : REQUEST;
      return Response.json({ ...base, challenge: b64(++challenge) });
    }
    if (to === PASSKEYS_PATH && method === "GET") {
      const now = [...list];
      if (knobs.listGate !== null) await knobs.listGate;
      return Response.json({ passkeys: now });
    }
    if (to === PASSKEYS_PATH && method === "POST") {
      return knobs.addStatus === 201
        ? Response.json(item({ id: "new" }), { status: 201 })
        : Response.json(
            {
              error: "bad_arguments",
              message: "the passkey did not check out",
            },
            { status: knobs.addStatus },
          );
    }
    if (to === PASSKEY_SIGN_IN_PATH) {
      return knobs.signIn ?? Response.json({ landing: "/" });
    }
    if (to.startsWith(`${PASSKEYS_PATH}/`))
      return new Response(null, { status: 204 });
    if (to === "/ui/me") {
      return Response.json({
        user: {
          id: "u1",
          name: "Ana",
          role: "member",
          email: null,
          operator: false,
        },
        email_on: true,
      });
    }
    return Response.json({});
  };
  return { fetch, asked, knobs };
}

const optionsAsked = (
  s: ReturnType<typeof server>,
  to = PASSKEY_OPTIONS_PATH,
) => s.asked.filter((a) => a.to === to).length;

const settle = () => new Promise((r) => setTimeout(r, 0));

function made(list: PasskeyItem[] = [], platform = true, autofill = false) {
  let now = NOW;
  const s = server(list);
  const l = laterFake();
  const d = deviceFake(platform, autofill);
  const st = store(
    s.fetch,
    () => now,
    () => "/",
    () => {},
    l.later,
    noPush,
    d.device,
  );
  return { st, s, l, d, tick: (ms: number) => (now += ms) };
}

describe("the passkeys store", () => {
  test("a tap calls the browser at once with options fetched before it", async () => {
    const m = made();
    const release = m.st.passkeys.prime("add");
    await settle();
    expect(m.s.asked.filter((a) => a.to === PASSKEY_OPTIONS_PATH)).toHaveLength(
      1,
    );
    const adding = m.st.passkeys.add();
    // before any await: create() ran inside the tap
    expect(m.d.order).toEqual([`create ${b64(1)}`]);
    expect(await adding).toBe(true);
    expect(
      m.s.asked.find((a) => a.method === "POST" && a.to === PASSKEYS_PATH)
        ?.body,
    ).toEqual(REGISTRATION);
    expect(m.st.passkeys.list.value?.map((p) => p.id)).toEqual(["new"]);
    // each challenge is used once: the next tap has new options
    await settle();
    expect(m.s.asked.filter((a) => a.to === PASSKEY_OPTIONS_PATH)).toHaveLength(
      2,
    );
    release();
  });

  test("options past their freshness are fetched again before the tap", async () => {
    const m = made();
    const release = m.st.passkeys.prime("add");
    await settle();
    const timer = m.l.live().at(-1)!;
    expect(timer.ms).toBe(120_000 - LEEWAY_MS);
    m.tick(timer.ms);
    timer.fire();
    await settle();
    expect(m.s.asked.filter((a) => a.to === PASSKEY_OPTIONS_PATH)).toHaveLength(
      2,
    );
    expect(await m.st.passkeys.add()).toBe(true);
    expect(m.d.order).toEqual([`create ${b64(2)}`]);
    release();
    await settle();
    expect(m.l.live()).toHaveLength(0);
  });

  test("a tap on stale options only fetches them, never then the browser", async () => {
    const m = made();
    const release = m.st.passkeys.prime("add");
    await settle();
    release();
    m.tick(120_000);
    const tapped = m.st.passkeys.add();
    expect(m.st.passkeys.waiting("add")).toBe(true);
    expect(await tapped).toBe(false);
    expect(m.d.order).toEqual([]);
    expect(optionsAsked(m.s)).toBe(2);
    expect(m.st.passkeys.waiting("add")).toBe(false);
    expect(m.st.passkeys.error.value).toBeNull();
    // the next tap has them
    expect(await m.st.passkeys.add()).toBe(true);
    expect(m.d.order).toEqual([`create ${b64(2)}`]);
  });

  test("a sign-in tap on stale options only fetches them", async () => {
    const m = made();
    const release = m.st.passkeys.prime("sign_in");
    await settle();
    release();
    m.tick(120_000);
    await m.st.signInByPasskey(() => {});
    expect(m.d.order).toEqual([]);
    expect(m.s.asked.some((a) => a.to === PASSKEY_SIGN_IN_PATH)).toBe(false);
    expect(optionsAsked(m.s, PASSKEY_SIGN_IN_OPTIONS_PATH)).toBe(2);
    const landed: string[] = [];
    await m.st.signInByPasskey((to) => landed.push(to));
    expect(m.d.order).toEqual([`get ${b64(2)}`]);
    expect(landed).toEqual(["/"]);
  });

  test("an add still asking when the session ends sends nothing", async () => {
    const m = made();
    await m.st.check();
    const release = m.st.passkeys.prime("add");
    await settle();
    m.d.state.asking = Promise.withResolvers<RegistrationJSON>();
    const adding = m.st.passkeys.add();
    expect(m.st.passkeys.busy.value).toBe(true);
    await m.st.signOut();
    expect(m.st.passkeys.busy.value).toBe(false);
    release();
    const asked = optionsAsked(m.s);
    m.d.state.asking.resolve(REGISTRATION);
    expect(await adding).toBe(false);
    await settle();
    expect(
      m.s.asked.some((a) => a.method === "POST" && a.to === PASSKEYS_PATH),
    ).toBe(false);
    // nor fetches the next options for a session that is gone
    expect(optionsAsked(m.s)).toBe(asked);
    expect(m.st.passkeys.busy.value).toBe(false);
    expect(m.st.passkeys.error.value).toBeNull();
  });

  test("a remove drops the row and fetches the add's options again", async () => {
    const m = made([item()]);
    const release = m.st.passkeys.prime("add");
    await m.st.passkeys.read();
    expect(await m.st.passkeys.remove("pk1")).toBeNull();
    expect(
      m.s.asked.some(
        (a) => a.method === "DELETE" && a.to === `${PASSKEYS_PATH}/pk1`,
      ),
    ).toBe(true);
    expect(m.st.passkeys.list.value).toEqual([]);
    await settle();
    expect(m.s.asked.filter((a) => a.to === PASSKEY_OPTIONS_PATH)).toHaveLength(
      2,
    );
    release();
  });

  test("a removed passkey of this host is forgotten by the browser, another's not", async () => {
    const m = made([
      item(),
      item({ id: "pk2", credential_id: "b3RoZXI", origin: LOCAL }),
    ]);
    await m.st.passkeys.read();
    expect(await m.st.passkeys.remove("pk2")).toBeNull();
    expect(m.d.order).toEqual([]);
    expect(await m.st.passkeys.remove("pk1")).toBeNull();
    expect(m.d.order).toEqual(["forget Y3JlZC0x"]);
  });

  test("a passkey the server does not hold is forgotten and says so", async () => {
    const m = made();
    const release = m.st.passkeys.prime("sign_in");
    await settle();
    m.s.knobs.signIn = Response.json(
      {
        error: "unauthorized",
        code: "unknown_passkey",
        message: "passkey not accepted",
      },
      { status: 401 },
    );
    const err = await m.st.signInByPasskey(() => {}).catch((e: unknown) => e);
    expect(m.d.order).toEqual([`get ${b64(1)}`, `forget ${ASSERTION.id}`]);
    expect(passkeyWords(err, false)).toBe(
      "This passkey was removed. Sign in another way.",
    );
    release();
  });

  test("an unknown passkey on loopback is not forgotten: another install may hold it", async () => {
    const m = made();
    m.d.state.origin = LOCAL;
    const release = m.st.passkeys.prime("sign_in");
    await settle();
    m.s.knobs.signIn = Response.json(
      {
        error: "unauthorized",
        code: "unknown_passkey",
        message: "passkey not accepted",
      },
      { status: 401 },
    );
    await m.st.signInByPasskey(() => {}).catch(() => {});
    expect(m.d.order).toEqual([`get ${b64(1)}`]);
    release();
  });

  test("a failed options refresh tries again", async () => {
    const m = made();
    const release = m.st.passkeys.prime("sign_in");
    await settle();
    m.s.knobs.optionsFail = 1;
    m.l.live().at(-1)!.fire();
    await settle();
    expect(optionsAsked(m.s, PASSKEY_SIGN_IN_OPTIONS_PATH)).toBe(2);
    const retry = m.l.live().at(-1)!;
    expect(retry.ms).toBe(30_000);
    retry.fire();
    await settle();
    expect(optionsAsked(m.s, PASSKEY_SIGN_IN_OPTIONS_PATH)).toBe(3);
    expect(m.l.live().at(-1)!.ms).toBeGreaterThan(30_000);
    release();
  });

  test("options answered late count their freshness from the ask", async () => {
    const m = made();
    const gate = Promise.withResolvers<void>();
    m.s.knobs.optionsGate = gate.promise;
    const release = m.st.passkeys.prime("add");
    m.tick(100_000);
    m.s.knobs.optionsGate = null;
    gate.resolve();
    await settle();
    // past their leeway already: the tap only fetches new ones
    expect(await m.st.passkeys.add()).toBe(false);
    expect(m.d.order).toEqual([]);
    release();
  });

  test("an add before the list has loaded keeps the passkeys already there", async () => {
    const m = made([item()]);
    const gate = Promise.withResolvers<void>();
    m.s.knobs.listGate = gate.promise;
    const reading = m.st.passkeys.read();
    const release = m.st.passkeys.prime("add");
    await settle();
    m.s.knobs.listGate = null;
    expect(await m.st.passkeys.add()).toBe(true);
    gate.resolve();
    await reading;
    await settle();
    expect(m.st.passkeys.list.value?.map((p) => p.id)).toContain("pk1");
    release();
  });

  test("a passkey refused for another reason is not forgotten", async () => {
    const m = made();
    const release = m.st.passkeys.prime("sign_in");
    await settle();
    m.s.knobs.signIn = Response.json(
      { error: "unauthorized", message: "passkey not accepted" },
      { status: 401 },
    );
    const err = await m.st.signInByPasskey(() => {}).catch((e: unknown) => e);
    expect(m.d.order).toEqual([`get ${b64(1)}`]);
    expect(passkeyWords(err, false)).toBe("Passkey not accepted.");
    release();
  });

  test("a passkey sign-in posts the browser's answer and lands where answered", async () => {
    const m = made();
    const release = m.st.passkeys.prime("sign_in");
    await settle();
    const landed: string[] = [];
    const signing = m.st.signInByPasskey((to) => landed.push(to));
    expect(m.d.order).toEqual([`get ${b64(1)}`]);
    await signing;
    expect(m.s.asked.find((a) => a.to === PASSKEY_SIGN_IN_PATH)?.body).toEqual(
      ASSERTION,
    );
    expect(landed).toEqual(["/"]);
    expect(m.st.signedIn.value).toBe(true);
    // a sign-in done needs no next challenge
    await settle();
    expect(optionsAsked(m.s, PASSKEY_SIGN_IN_OPTIONS_PATH)).toBe(1);
    release();
  });

  test("an autofill's answer is posted without asking the browser", async () => {
    const m = made();
    const landed: string[] = [];
    await m.st.signInByPasskey((to) => landed.push(to), ASSERTION);
    expect(m.d.order).toEqual([]);
    expect(m.s.asked.find((a) => a.to === PASSKEY_SIGN_IN_PATH)?.body).toEqual(
      ASSERTION,
    );
    expect(landed).toEqual(["/"]);
    expect(m.st.signedIn.value).toBe(true);
  });

  test("the passkey step is offered on every call where a platform authenticator is", async () => {
    // a passkey already here changes nothing: the step asks each time
    const m = made([item()]);
    await m.st.passkeys.considerStep();
    expect(m.st.passkeys.step.value).toBe(true);
    m.st.passkeys.step.value = false;
    await m.st.passkeys.considerStep();
    expect(m.st.passkeys.step.value).toBe(true);
    const none = made([], false);
    await none.st.passkeys.considerStep();
    expect(none.st.passkeys.step.value).toBe(false);
    const unsupported = store(server().fetch);
    await unsupported.passkeys.considerStep();
    expect(unsupported.passkeys.step.value).toBe(false);
  });

  test("an added passkey ends the step", async () => {
    const m = made();
    await m.st.passkeys.considerStep();
    const release = m.st.passkeys.prime("add");
    await settle();
    expect(await m.st.passkeys.add()).toBe(true);
    expect(m.st.passkeys.step.value).toBe(false);
    release();
  });
});

describe("the autofill", () => {
  test("holds a request on the primed options and restarts it on fresh ones", async () => {
    const m = made([], true, true);
    const answers: AssertionJSON[] = [];
    const release = m.st.passkeys.listen((a) => answers.push(a));
    await settle();
    expect(m.d.order).toEqual([`autofill ${b64(1)}`]);
    const timer = m.l.live().at(-1)!;
    m.tick(timer.ms);
    timer.fire();
    await settle();
    expect(m.d.state.held[0]!.signal.aborted).toBe(true);
    expect(m.d.order).toEqual([`autofill ${b64(1)}`, `autofill ${b64(2)}`]);
    // an aborted request fetches nothing more
    expect(optionsAsked(m.s, PASSKEY_SIGN_IN_OPTIONS_PATH)).toBe(2);
    m.d.state.held[1]!.answer.resolve(ASSERTION);
    await settle();
    expect(answers).toEqual([ASSERTION]);
    // its challenge is spent, so a tap only fetches new options
    expect(await m.st.passkeys.assert()).toBeNull();
    expect(m.d.order.some((o) => o.startsWith("get"))).toBe(false);
    release();
  });

  test("a refused request waits for the next refresh; the release aborts it", async () => {
    const m = made([], true, true);
    const answers: AssertionJSON[] = [];
    const release = m.st.passkeys.listen((a) => answers.push(a));
    await settle();
    m.d.state.held[0]!.answer.reject(
      new DOMException("made-up", "NotAllowedError"),
    );
    await settle();
    // a browser refusing every request would otherwise loop on the options
    expect(optionsAsked(m.s, PASSKEY_SIGN_IN_OPTIONS_PATH)).toBe(1);
    expect(m.d.order).toEqual([`autofill ${b64(1)}`]);
    m.l.live().at(-1)!.fire();
    await settle();
    expect(optionsAsked(m.s, PASSKEY_SIGN_IN_OPTIONS_PATH)).toBe(2);
    expect(m.d.order).toEqual([`autofill ${b64(1)}`, `autofill ${b64(2)}`]);
    release();
    expect(m.d.state.held[1]!.signal.aborted).toBe(true);
    await settle();
    expect(answers).toEqual([]);
    expect(m.l.live()).toHaveLength(0);
    expect(m.d.state.visible).toHaveLength(0);
  });
});

describe("a sign-in by key or passkey", () => {
  test("drops an emailed sign-in's flag, so it asks no passkey step", () => {
    let search = "?a=1&signed_in=1";
    const address: Address = {
      search: () => search,
      replace: (s) => {
        search = s;
      },
    };
    dropSignedIn(address);
    expect(search).toBe("?a=1");
    dropSignedIn(address);
    expect(search).toBe("?a=1");
  });
});

describe("the pages", () => {
  test("the menu item sits between Hide amounts and Sign out, only where passkeys work", () => {
    const p = markets.passkeys;
    const was = p.support.peek();
    try {
      p.support.value = false;
      expect(render(<UserItems />)).not.toContain("Passkeys");
      p.support.value = true;
      const html = render(<UserItems />);
      expect(html.indexOf("Hide amounts")).toBeLessThan(
        html.indexOf("Passkeys"),
      );
      expect(html.indexOf("Passkeys")).toBeLessThan(html.indexOf("Sign out"));
    } finally {
      p.support.value = was;
    }
  });

  test("the drawer lists every passkey, another address's named, or says there are none", () => {
    const m = made();
    m.st.passkeys.list.value = [
      item(),
      item({ id: "pk2", origin: LOCAL, device: "Windows Hello" }),
    ];
    const html = render(<PasskeysList store={m.st} onClose={() => {}} />);
    expect(html).toContain("Apple Passwords");
    expect(html).toContain("Added 12 Nov");
    expect(html).not.toContain("Last used");
    // a passkey added elsewhere, as a stolen session could, never hides
    expect(html).toContain("Windows Hello");
    expect(html).toContain("localhost:11239");
    expect(html).not.toContain("markets.example.com");
    expect(html).toContain("Add a passkey");
    expect(button(html, "Remove")).toContain("Remove Apple Passwords");
    m.st.passkeys.list.value = [];
    expect(render(<PasskeysList store={m.st} onClose={() => {}} />)).toContain(
      "No passkeys yet.",
    );
  });

  test("Add a passkey waits for its options", async () => {
    const m = made();
    const add = () =>
      button(
        render(<PasskeysList store={m.st} onClose={() => {}} />),
        "Add a passkey",
      );
    const release = m.st.passkeys.prime("add");
    expect(add()).toContain("disabled");
    await settle();
    expect(add()).not.toContain("disabled");
    // a tap uses them, so the button waits for the next
    const adding = m.st.passkeys.add();
    await adding;
    expect(add()).toContain("disabled");
    await settle();
    expect(add()).not.toContain("disabled");
    release();
  });

  test("the passkey step offers an add or a skip, the add waiting for its options", async () => {
    const m = made();
    const release = m.st.passkeys.prime("add");
    const html = render(<PasskeyStep store={m.st} />);
    expect(html).toContain("Sign in faster next time");
    expect(html).toContain(
      "Use Face ID, Touch ID or your password manager instead of a code.",
    );
    expect(button(html, "Add a passkey")).toContain("disabled");
    expect(button(html, "Skip")).not.toContain("disabled");
    await settle();
    expect(
      button(render(<PasskeyStep store={m.st} />), "Add a passkey"),
    ).not.toContain("disabled");
    release();
  });
});

const button = (html: string, label: string) =>
  new RegExp(`<button[^>]*>(?:(?!</button>).)*${label}`).exec(html)![0];

// a closed menu renders no items, so they are read off its props
function menusOf(node: VNode): { label: string; items: MenuItem[] }[] {
  const seen: { label: string; items: MenuItem[] }[] = [];
  const was = options.vnode;
  options.vnode = (v) => {
    if (v.type === MenuButton)
      seen.push(v.props as unknown as (typeof seen)[number]);
    was?.(v);
  };
  try {
    render(node);
  } finally {
    options.vnode = was;
  }
  return seen;
}

const labels = (items: MenuItem[]) =>
  items.map((i) => `${i.label}${i.checked ? " (picked)" : ""}`);

function keptAs<T>(way: string | null, run: (kept: Storage) => T): T {
  const g = globalThis as { localStorage?: unknown };
  const was = g.localStorage;
  const kept = storageFake();
  if (way !== null) kept.setItem("markets-sign-in", way);
  g.localStorage = kept;
  try {
    return run(kept as unknown as Storage);
  } finally {
    if (was === undefined) delete g.localStorage;
    else g.localStorage = was;
  }
}

describe("the sign-in ways", () => {
  test("a way the server or browser does not offer falls back to one that is", () => {
    expect(wayOf("passkey", true, true)).toBe("passkey");
    expect(wayOf("passkey", true, false)).toBe("email");
    expect(wayOf("passkey", false, false)).toBe("key");
    expect(wayOf("email", false, true)).toBe("key");
    expect(wayOf("code", false, true)).toBe("key");
    expect(wayOf("code", true, false)).toBe("code");
    expect(wayOf("key", true, true)).toBe("key");
  });

  test("with email, passkeys and autofill: one Sign in, three ways, and the field offers passkeys", async () => {
    const m = made([], true, true);
    await settle();
    m.st.emailOn.value = true;
    const html = render(<SignIn store={m.st} />);
    expect(html).toContain('autocomplete="email webauthn"');
    expect(html).toContain(
      '<button type="submit" class="btn btn-primary signin-go">Sign in</button>',
    );
    const menus = menusOf(<SignIn store={m.st} />);
    expect(menus.map((x) => x.label)).toEqual(["Ways to sign in"]);
    expect(labels(menus[0]!.items)).toEqual([
      "Email code (picked)",
      "Passkey",
      "Admin key",
    ]);
  });

  test("without autofill the fields autocomplete as before", () => {
    const m = made();
    m.st.emailOn.value = true;
    const html = render(<SignIn store={m.st} />);
    expect(html).toContain('autocomplete="email"');
    expect(html).not.toContain("webauthn");
    m.st.emailOn.value = false;
    const key = render(<SignIn store={m.st} />);
    expect(key).toContain('autocomplete="current-password"');
    expect(key).not.toContain("webauthn");
  });

  test("with email off there is no email way, and the key field offers passkeys", async () => {
    const m = made([], true, true);
    await settle();
    m.st.emailOn.value = false;
    const html = render(<SignIn store={m.st} />);
    expect(html).toContain("Admin key</span>");
    expect(html).not.toContain('type="email"');
    expect(html).toContain('autocomplete="current-password webauthn"');
    expect(labels(menusOf(<SignIn store={m.st} />)[0]!.items)).toEqual([
      "Passkey",
      "Admin key (picked)",
    ]);
  });

  test("a browser without passkeys has no passkey way", () => {
    const s = store(server().fetch);
    s.emailOn.value = true;
    expect(labels(menusOf(<SignIn store={s} />)[0]!.items)).toEqual([
      "Email code (picked)",
      "Admin key",
    ]);
  });

  test("a single way has no menu", () => {
    const s = store(server().fetch);
    s.emailOn.value = false;
    expect(menusOf(<SignIn store={s} />)).toEqual([]);
    expect(render(<SignIn store={s} />)).not.toContain("Ways to sign in");
  });

  test("the way picked is kept for the next visit", () => {
    const m = made();
    m.st.emailOn.value = true;
    keptAs(null, (kept) => {
      const items = menusOf(<SignIn store={m.st} />)[0]!.items;
      items.find((i) => i.label === "Admin key")!.run!();
      expect(kept.getItem("markets-sign-in")).toBe("key");
      expect(render(<SignIn store={m.st} />)).toContain("Admin key</span>");
    });
  });

  test("picking Passkey in the menu asks the browser in the same tap", async () => {
    const m = made();
    m.st.emailOn.value = true;
    const release = m.st.passkeys.prime("sign_in");
    await settle();
    const menus = keptAs("email", () => menusOf(<SignIn store={m.st} />));
    const passkey = menus[0]!.items.find((i) => i.label === "Passkey")!;
    // the landing and the flag's drop reach the address
    const g = globalThis as { location?: unknown; history?: unknown };
    const had = { location: g.location, history: g.history };
    g.location = { origin: ORIGIN, pathname: "/", search: "", hash: "" };
    g.history = { state: null, replaceState() {}, pushState() {} };
    try {
      keptAs("email", () => passkey.run!());
      // no await between the tap and the browser
      expect(m.d.order).toEqual([`get ${b64(1)}`]);
      await settle();
      expect(m.s.asked.some((a) => a.to === PASSKEY_SIGN_IN_PATH)).toBe(true);
    } finally {
      g.location = had.location;
      g.history = had.history;
      release();
    }
  });

  test("a tap's request first aborts the autofill's, as a browser holds one", async () => {
    const m = made([], true, true);
    const stop = m.st.passkeys.listen(() => {});
    await settle();
    const signing = m.st.signInByPasskey(() => {});
    expect(m.d.state.held[0]!.signal.aborted).toBe(true);
    expect(m.d.order).toEqual([`autofill ${b64(1)}`, `get ${b64(1)}`]);
    await signing;
    stop();
  });

  test("the passkey way asks the browser on Sign in, which waits for its options", async () => {
    const m = made();
    m.st.emailOn.value = true;
    const shown = () =>
      keptAs("passkey", () => render(<SignIn store={m.st} />));
    const release = m.st.passkeys.prime("sign_in");
    const html = shown();
    expect(html).toContain("Use Face ID, Touch ID or your password manager.");
    expect(html).not.toContain('type="email"');
    expect(button(html, "Sign in")).toContain("disabled");
    expect(html).toContain('<span class="spinner signin-spin"');
    await settle();
    const ready = shown();
    expect(button(ready, "Sign in")).not.toContain("disabled");
    expect(ready).not.toContain("signin-spin");
    release();
  });

  test("the code step has one Sign in and a More menu, no text links", () => {
    const m = made();
    m.st.emailOn.value = true;
    const html = render(<SignIn store={m.st} opening="code" />);
    expect(html).toContain('aria-label="Digit 1"');
    expect(button(html, "Sign in")).toContain("disabled");
    expect(html).toContain('aria-label="More"');
    const menus = menusOf(<SignIn store={m.st} opening="code" />);
    expect(menus.map((x) => x.label)).toEqual(["More"]);
    expect(labels(menus[0]!.items)).toEqual([
      "Send a new code",
      "Use another email",
    ]);
  });
});

describe("the passkeys store after a tap", () => {
  test("a cancelled tap says nothing and fetches new options", async () => {
    const m = made();
    const release = m.st.passkeys.prime("add");
    await settle();
    m.d.state.refuse = new DOMException("made-up", "NotAllowedError");
    expect(await m.st.passkeys.add()).toBe(false);
    expect(m.st.passkeys.error.value).toBeNull();
    await settle();
    expect(optionsAsked(m.s)).toBe(2);
    release();
  });

  test("a refused answer says so and fetches new options", async () => {
    const m = made();
    const release = m.st.passkeys.prime("add");
    await settle();
    m.s.knobs.addStatus = 400;
    expect(await m.st.passkeys.add()).toBe(false);
    expect(m.st.passkeys.error.value).toBe("The passkey did not check out.");
    await settle();
    expect(optionsAsked(m.s)).toBe(2);
    m.s.knobs.addStatus = 201;
    expect(await m.st.passkeys.add()).toBe(true);
    expect(m.d.order.at(-1)).toBe(`create ${b64(2)}`);
    release();
  });

  test("a hidden tab skips the refresh and fetches stale options once shown", async () => {
    const m = made();
    const release = m.st.passkeys.prime("sign_in");
    await settle();
    m.d.state.hidden = true;
    const timer = m.l.live().at(-1)!;
    m.tick(timer.ms);
    timer.fire();
    await settle();
    expect(optionsAsked(m.s, PASSKEY_SIGN_IN_OPTIONS_PATH)).toBe(1);
    m.d.state.hidden = false;
    for (const f of m.d.state.visible) f();
    await settle();
    expect(optionsAsked(m.s, PASSKEY_SIGN_IN_OPTIONS_PATH)).toBe(2);
    // shown again with fresh options: nothing more
    for (const f of m.d.state.visible) f();
    await settle();
    expect(optionsAsked(m.s, PASSKEY_SIGN_IN_OPTIONS_PATH)).toBe(2);
    release();
    expect(m.d.state.visible).toHaveLength(0);
  });

  test("sign-out drops the options and the list, and closes the drawer", async () => {
    const m = made([item()]);
    await m.st.check();
    const release = m.st.passkeys.prime("add");
    await m.st.passkeys.read();
    await settle();
    m.st.passkeys.open.value = true;
    expect(render(<PasskeysDrawer store={m.st} />)).toContain("Passkeys");
    await m.st.signOut();
    expect(m.st.passkeys.open.value).toBe(false);
    expect(m.st.passkeys.list.value).toBeNull();
    release();
    await m.st.check();
    expect(render(<PasskeysDrawer store={m.st} />)).toBe("");
    // the options of the session before are never used: the tap fetches
    expect(await m.st.passkeys.add()).toBe(false);
    expect(m.d.order).toEqual([]);
    expect(await m.st.passkeys.add()).toBe(true);
    expect(m.d.order).toEqual([`create ${b64(2)}`]);
  });
});

function addressFake(search: string) {
  const a = { now: search, replaced: [] as string[] };
  const address: Address = {
    search: () => a.now,
    replace: (s) => {
      a.now = s;
      a.replaced.push(s);
    },
  };
  return { a, address };
}

function storageFake() {
  const held = new Map<string, string>();
  return {
    getItem: (k: string) => held.get(k) ?? null,
    setItem: (k: string, v: string) => {
      held.set(k, v);
    },
  };
}

describe("the passkey step's watch", () => {
  test("strips the flag, keeps the rest of the address and offers on each sign-in", async () => {
    const m = made();
    const f = addressFake("?tab=all&signed_in=1");
    const stop = watchStep(m.st, f.address);
    await m.st.check();
    await settle();
    expect(f.a.replaced).toEqual(["?tab=all"]);
    expect(m.st.passkeys.step.value).toBe(true);
    // skipped, and a later read of who is in finds no flag
    m.st.passkeys.step.value = false;
    await m.st.check();
    await settle();
    expect(f.a.replaced).toEqual(["?tab=all"]);
    expect(m.st.passkeys.step.value).toBe(false);
    await m.st.signOut();
    f.a.now = "?signed_in=1";
    await m.st.check();
    await settle();
    expect(f.a.replaced).toEqual(["?tab=all", ""]);
    expect(m.st.passkeys.step.value).toBe(true);
    stop();
  });

  test("strips the flag but offers nothing without a platform authenticator", async () => {
    const m = made([], false);
    const f = addressFake("?signed_in=1");
    const stop = watchStep(m.st, f.address);
    await m.st.check();
    await settle();
    expect(f.a.replaced).toEqual([""]);
    expect(m.st.passkeys.step.value).toBe(false);
    stop();
  });
});
