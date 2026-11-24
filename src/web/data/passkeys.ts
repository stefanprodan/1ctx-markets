// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// Passkeys: this origin's list, the add and the sign-in. Options are
// fetched before the tap, since iOS runs create() and get() only inside it
// and a fetch between may lose it: a tap without them only fetches.

import { type Signal, signal } from "@preact/signals";
import {
  type Asserted,
  type AssertionJSON,
  type Attested,
  assertionOf,
  type CreationJSON,
  creationOf,
  fresh,
  type PasskeyItem,
  passkeyWords,
  type RegistrationJSON,
  type RequestJSON,
  refreshIn,
  registrationOf,
  requestOf,
} from "../app/Passkeys.model.ts";
import type { Later } from "../lib/slow.ts";
import { type Call, says } from "./api.ts";

export const PASSKEYS_PATH = "/ui/passkeys";
export const PASSKEY_OPTIONS_PATH = "/ui/passkeys/options";
export const PASSKEY_SIGN_IN_PATH = "/ui/passkeys/sign-in";
export const PASSKEY_SIGN_IN_OPTIONS_PATH = "/ui/passkeys/sign-in/options";

export type PasskeyDevice = {
  supported(): boolean;
  // Face ID, Touch ID or Windows Hello on this device
  platform(): Promise<boolean>;
  // passkeys offered in a field's autofill (conditional mediation)
  autofill(): Promise<boolean>;
  origin(): string;
  // each calls the browser before it returns, never after an await
  create(o: CreationJSON): Promise<RegistrationJSON>;
  // with a signal: the autofill's request, held open until it is aborted
  get(o: RequestJSON, autofill?: AbortSignal): Promise<AssertionJSON>;
  // a passkey this server no longer holds, so the password manager stops
  // offering it (the Signal API, where the browser has it)
  forget(credentialId: string): void;
  // a hidden tab's timers fire late or never, so it refreshes on return
  hidden(): boolean;
  onVisible(fire: () => void): () => void;
};

type Browser = {
  PublicKeyCredential?: {
    isUserVerifyingPlatformAuthenticatorAvailable?: () => Promise<boolean>;
    isConditionalMediationAvailable?: () => Promise<boolean>;
    signalUnknownCredential?: (o: {
      rpId: string;
      credentialId: string;
    }) => Promise<void>;
  };
  navigator?: {
    credentials?: {
      create(o: unknown): Promise<unknown>;
      get(o: unknown): Promise<unknown>;
    };
  };
  location?: { origin: string; hostname: string };
  document?: Document;
};

const nothing = () => new DOMException("no passkey", "NotAllowedError");

export function browserPasskeys(): PasskeyDevice {
  const w = globalThis as Browser;
  const creds = () => w.navigator!.credentials!;
  return {
    supported: () =>
      typeof w.PublicKeyCredential === "function" &&
      w.navigator?.credentials !== undefined,
    async platform() {
      const ask =
        w.PublicKeyCredential?.isUserVerifyingPlatformAuthenticatorAvailable;
      return ask === undefined ? false : ask.call(w.PublicKeyCredential);
    },
    forget(credentialId) {
      const signal = w.PublicKeyCredential?.signalUnknownCredential;
      const rpId = w.location?.hostname;
      if (signal === undefined || rpId === undefined) return;
      try {
        signal
          .call(w.PublicKeyCredential, { rpId, credentialId })
          .catch(() => {});
      } catch {}
    },
    async autofill() {
      const ask = w.PublicKeyCredential?.isConditionalMediationAvailable;
      return ask === undefined ? false : ask.call(w.PublicKeyCredential);
    },
    origin: () => w.location?.origin ?? "",
    hidden: () => w.document?.hidden === true,
    onVisible(fire) {
      const d = w.document;
      if (d === undefined) return () => {};
      const seen = () => {
        if (!d.hidden) fire();
      };
      d.addEventListener("visibilitychange", seen);
      return () => d.removeEventListener("visibilitychange", seen);
    },
    create(o) {
      try {
        return creds()
          .create({ publicKey: creationOf(o) })
          .then((c) => {
            if (c === null) throw nothing();
            return registrationOf(c as Attested);
          });
      } catch (e) {
        return Promise.reject(e);
      }
    },
    get(o, autofill) {
      try {
        return creds()
          .get(
            autofill === undefined
              ? { publicKey: requestOf(o) }
              : {
                  publicKey: requestOf(o),
                  mediation: "conditional",
                  signal: autofill,
                },
          )
          .then((c) => {
            if (c === null) throw nothing();
            return assertionOf(c as Asserted);
          });
      } catch (e) {
        return Promise.reject(e);
      }
    },
  };
}

// a failed options refresh tries again after this
const RETRY_MS = 30_000;

// a passkey's relying party is the host, whatever the port
function sameHost(a: string, b: string): boolean {
  try {
    return new URL(a).hostname === new URL(b).hostname;
  } catch {
    return false;
  }
}

type Purpose = "add" | "sign_in";
const OPTIONS: Record<Purpose, string> = {
  add: PASSKEY_OPTIONS_PATH,
  sign_in: PASSKEY_SIGN_IN_OPTIONS_PATH,
};
type Options = CreationJSON | RequestJSON;
type Primed = { json: Options; at: number; session: number };

export function passkeysStore(
  call: Call,
  session: () => number,
  device: PasskeyDevice,
  now: () => number,
  later: Later,
) {
  const support = signal(device.supported());
  // every host's, as answered; null until read
  const list = signal<PasskeyItem[] | null>(null);
  const error = signal<string | null>(null);
  const busy = signal(false);
  // no usable options and a fetch on its way: the button waits for it
  const waiting: Record<Purpose, Signal<boolean>> = {
    add: signal(false),
    sign_in: signal(false),
  };
  // the sign-in card's passkey step, after every emailed sign-in
  const step = signal(false);
  // asked once at start, so the step shows in the sign-in's own render
  let platform: Promise<boolean> | boolean = support.peek()
    ? device.platform().then(
        (v) => (platform = v),
        () => (platform = false),
      )
    : false;
  // the email and admin key fields offer passkeys in their autofill, so
  // the sign-in needs no button of its own
  const autofill = signal(false);
  if (support.peek()) {
    device.autofill().then(
      (v) => {
        autofill.value = v;
      },
      () => {},
    );
  }
  // the autofill's request starts again with each new sign-in options
  let freshSignIn: (() => void) | null = null;
  let autofillHeld: AbortController | null = null;
  // the drawer: closed with the session, so the next sign-in opens on the page
  const open = signal(false);
  const primed: Record<Purpose, Primed | null> = { add: null, sign_in: null };
  const wants: Record<Purpose, number> = { add: 0, sign_in: 0 };
  const asked: Record<Purpose, number> = { add: 0, sign_in: 0 };
  const timers: Record<Purpose, () => void> = {
    add: () => {},
    sign_in: () => {},
  };
  let load = 0;
  let unwatch = () => {};

  const stale = (p: Purpose) => {
    const o = primed[p];
    return (
      o === null ||
      o.session !== session() ||
      !fresh(o.at, o.json.timeout, now())
    );
  };

  const shown = () => {
    for (const p of ["add", "sign_in"] as const) {
      if (wants[p] > 0 && stale(p)) void fetchOptions(p).catch(() => {});
    }
  };

  function schedule(p: Purpose) {
    timers[p]();
    timers[p] = () => {};
    const o = primed[p];
    if (wants[p] === 0 || o === null) return;
    const refresh = () => {
      if (wants[p] > 0 && !device.hidden()) {
        // a failed refresh tries again, or the autofill would end with it
        void fetchOptions(p).catch(() => {
          timers[p] = later(RETRY_MS, refresh);
        });
      }
    };
    timers[p] = later(refreshIn(o.at, o.json.timeout, now()), refresh);
  }

  async function fetchOptions(p: Purpose): Promise<Options> {
    const mine = ++asked[p];
    const at = session();
    // the challenge's two minutes may start any time after the ask
    const sent = now();
    if (stale(p)) waiting[p].value = true;
    try {
      const json = await call<Options>(OPTIONS[p], "POST");
      if (mine === asked[p] && at === session()) {
        primed[p] = { json, at: sent, session: at };
        schedule(p);
        if (p === "sign_in") freshSignIn?.();
      }
      return json;
    } finally {
      // a sign-out bumps asked, so a session check would only strand it
      if (mine === asked[p]) waiting[p].value = false;
    }
  }

  // options in hand from when a page part showed, while still fresh
  function take(p: Purpose): Options | null {
    const o = primed[p];
    primed[p] = null;
    return o !== null &&
      o.session === session() &&
      fresh(o.at, o.json.timeout, now())
      ? o.json
      : null;
  }

  // each challenge is used once, so the next tap needs new options
  const again = (p: Purpose) => {
    if (wants[p] > 0) void fetchOptions(p).catch(() => {});
  };

  // while a passkey button shows; the release lets go
  function prime(p: Purpose): () => void {
    if (wants.add + wants.sign_in === 0) unwatch = device.onVisible(shown);
    wants[p]++;
    if (stale(p)) void fetchOptions(p).catch(() => {});
    else schedule(p);
    let held = true;
    return () => {
      if (!held) return;
      held = false;
      wants[p]--;
      if (wants[p] === 0) schedule(p);
      if (wants.add + wants.sign_in === 0) {
        unwatch();
        unwatch = () => {};
      }
    };
  }

  async function read(): Promise<void> {
    const mine = ++load;
    const at = session();
    try {
      const a = await call<{ passkeys: PasskeyItem[] }>(PASSKEYS_PATH);
      if (mine === load && at === session()) list.value = a.passkeys;
    } catch (e) {
      if (mine === load && at === session()) error.value = says(e);
    }
  }

  // a tap without fresh options only fetches them; the button waits
  async function refetch(p: Purpose): Promise<void> {
    const at = session();
    error.value = null;
    try {
      await fetchOptions(p);
    } catch (e) {
      if (at === session() && p === "add") error.value = passkeyWords(e, true);
      if (p === "sign_in") throw e;
    }
  }

  async function add(): Promise<boolean> {
    if (busy.peek() || waiting.add.peek()) return false;
    const o = take("add") as CreationJSON | null;
    if (o === null) {
      await refetch("add");
      return false;
    }
    // no await before create(): iOS runs it only inside the tap
    const made = device.create(o);
    const at = session();
    busy.value = true;
    error.value = null;
    try {
      const sent = await made;
      // signed out while the browser asked: the answer is never sent
      if (at !== session()) return false;
      const item = await call<PasskeyItem>(PASSKEYS_PATH, "POST", sent);
      if (at !== session()) return false;
      list.value = [...(list.peek() ?? []), item];
      // a list read before the add lacks it, so read again
      void read();
      step.value = false;
      return true;
    } catch (e) {
      if (at === session()) error.value = passkeyWords(e, true);
      return false;
    } finally {
      if (at === session()) {
        busy.value = false;
        again("add");
      }
    }
  }

  // the refusal's sentence, or null once removed
  async function remove(id: string): Promise<string | null> {
    const at = session();
    try {
      await call(`${PASSKEYS_PATH}/${encodeURIComponent(id)}`, "DELETE");
      // this host's: else the password manager would keep offering it
      const gone = list.peek()?.find((p) => p.id === id);
      if (gone !== undefined && sameHost(gone.origin, device.origin())) {
        device.forget(gone.credential_id);
      }
      if (at === session()) {
        load++;
        list.value = (list.peek() ?? []).filter((p) => p.id !== id);
      }
      // the add's options no longer hold it among this device's own
      again("add");
      return null;
    } catch (e) {
      return says(e);
    }
  }

  // null: no fresh options, so the tap only fetched them
  function assert(): Promise<AssertionJSON | null> {
    if (waiting.sign_in.peek()) return Promise.resolve(null);
    const o = take("sign_in") as RequestJSON | null;
    if (o === null) return refetch("sign_in").then(() => null);
    // a browser holds one request at a time: the autofill's goes first
    autofillHeld?.abort();
    autofillHeld = null;
    return device.get(o).catch((e: unknown) => {
      again("sign_in");
      throw e;
    });
  }

  // held open while the fields show; each options refresh restarts it
  function listen(answered: (a: AssertionJSON) => void): () => void {
    let done = false;
    const start = () => {
      autofillHeld?.abort();
      autofillHeld = null;
      const o = primed.sign_in;
      if (done || o === null || stale("sign_in")) return;
      const c = new AbortController();
      autofillHeld = c;
      device.get(o.json as RequestJSON, c.signal).then(
        (a) => {
          if (c.signal.aborted) return;
          // its challenge is spent: the next one waits for new options
          primed.sign_in = null;
          answered(a);
        },
        // refused: held again by the next refresh, never at once, since a
        // browser refusing every request would loop on the options
        () => {},
      );
    };
    freshSignIn = start;
    const release = prime("sign_in");
    start();
    return () => {
      done = true;
      if (freshSignIn === start) freshSignIn = null;
      autofillHeld?.abort();
      autofillHeld = null;
      release();
    };
  }

  // after every emailed sign-in, on a device with a platform authenticator
  async function considerStep(): Promise<void> {
    if (!support.peek()) return;
    const at = session();
    const p = typeof platform === "boolean" ? platform : await platform;
    if (at !== session()) return;
    error.value = null;
    step.value = p;
  }

  const signedOut = () => {
    load++;
    asked.add++;
    asked.sign_in++;
    primed.add = null;
    primed.sign_in = null;
    waiting.add.value = false;
    waiting.sign_in.value = false;
    busy.value = false;
    list.value = null;
    error.value = null;
    step.value = false;
    open.value = false;
  };

  return {
    support,
    autofill,
    list,
    error,
    busy,
    // the Add and the Sign in buttons hold off while it is true
    waiting: (p: Purpose) => waiting[p].value,
    step,
    open,
    origin: () => device.origin(),
    signInFailed: () => again("sign_in"),
    // one https host is one server; on loopback two installs on two ports
    // share the relying party, so another's passkey must not be forgotten
    forget: (credentialId: string) => {
      if (device.origin().startsWith("https:")) device.forget(credentialId);
    },
    prime,
    read,
    add,
    remove,
    assert,
    listen,
    considerStep,
    signedOut,
  };
}
