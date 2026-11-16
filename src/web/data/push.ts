// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// Push notifications are this device's, never the account's: the switch
// reads the browser's own subscription against the ones the server holds.

import { effect, signal } from "@preact/signals";
import { type Call, says } from "./api.ts";

export const PUSH_PATH = "/ui/push";
export const WORKER_PATH = "/sw.js";

export type Subscribed = {
  endpoint: string;
  keys: { p256dh: string; auth: string };
};

// ready: the browser pushes; install: iOS Safari, which pushes only from
// the Home Screen app; none: no push here
export type Support = "ready" | "install" | "none";

export type PushDevice = {
  support(): Support;
  // this browser's subscription, null with none
  current(): Promise<string | null>;
  // asks for permission first, inside the tap; null when refused
  subscribe(key: string): Promise<Subscribed | null>;
  // the endpoint it ended, null with none
  unsubscribe(): Promise<string | null>;
  badge(count: number): void;
};

const bytesOf = (b64url: string): Uint8Array<ArrayBuffer> => {
  const text = atob(b64url.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(text, (c) => c.charCodeAt(0));
};

const sameBytes = (a: ArrayBuffer | null, b: Uint8Array) => {
  if (a === null || a.byteLength !== b.length) return false;
  const x = new Uint8Array(a);
  return x.every((v, i) => v === b[i]);
};

type Nav = Navigator & {
  standalone?: boolean;
  setAppBadge?: (n: number) => Promise<void>;
  clearAppBadge?: () => Promise<void>;
};

export function browserPush(): PushDevice {
  const nav = (typeof navigator === "undefined" ? undefined : navigator) as
    | Nav
    | undefined;
  let registered: Promise<ServiceWorkerRegistration> | null = null;
  const registration = () => {
    // ready: a tap right after the first registration needs the worker
    // active before any subscription call; a failed one is asked again
    if (registered === null) {
      const asked = nav!.serviceWorker
        .register(WORKER_PATH)
        .then(() => nav!.serviceWorker.ready);
      registered = asked;
      asked.catch(() => {
        if (registered === asked) registered = null;
      });
    }
    return registered;
  };
  const subscription = async () =>
    (await registration()).pushManager.getSubscription();
  return {
    support() {
      if (nav === undefined) return "none";
      const app =
        typeof matchMedia === "function" &&
        matchMedia("(display-mode: standalone)").matches;
      // only iOS Safari names standalone; outside the Home Screen it has
      // no PushManager at all
      if ("standalone" in nav && nav.standalone !== true && !app) {
        return "install";
      }
      if (!("serviceWorker" in nav) || typeof PushManager === "undefined") {
        return "none";
      }
      return "ready";
    },
    async current() {
      return (await subscription())?.endpoint ?? null;
    },
    async subscribe(key) {
      const allowed = await Notification.requestPermission();
      if (allowed !== "granted") return null;
      const reg = await registration();
      const server = bytesOf(key);
      const held = await reg.pushManager.getSubscription();
      // a subscription to another server key cannot be reused
      if (
        held !== null &&
        !sameBytes(held.options.applicationServerKey, server)
      ) {
        await held.unsubscribe();
      }
      const s = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: server,
      });
      const json = s.toJSON();
      return {
        endpoint: s.endpoint,
        keys: { p256dh: json.keys?.p256dh ?? "", auth: json.keys?.auth ?? "" },
      };
    },
    async unsubscribe() {
      const s = await subscription();
      if (s === null) return null;
      await s.unsubscribe();
      return s.endpoint;
    },
    badge(count) {
      if (nav?.setAppBadge === undefined) return;
      const set = count > 0 ? nav.setAppBadge(count) : nav.clearAppBadge?.();
      void set?.catch(() => {});
    },
  };
}

type PushAnswer = { key: string | null; endpoints: string[] };

export function pushStore(
  call: Call,
  session: () => number,
  device: PushDevice,
  // the rail's count of unseen alerts, null signed out
  unseen: () => number | null,
) {
  // the server's public key; null while push is off there
  const key = signal<string | null>(null);
  const support = signal<Support>(device.support());
  const on = signal(false);
  const busy = signal(false);
  const error = signal<string | null>(null);
  let load = 0;

  // the app icon counts what the rail counts, and clears at zero
  effect(() => {
    const n = unseen();
    if (n !== null) device.badge(n);
  });

  async function read(): Promise<void> {
    const mine = ++load;
    const at = session();
    try {
      const a = await call<PushAnswer>(PUSH_PATH);
      if (mine !== load || at !== session()) return;
      key.value = a.key;
      if (a.key === null || support.peek() !== "ready") {
        on.value = false;
        return;
      }
      const held = await device.current();
      if (mine !== load || at !== session()) return;
      on.value = held !== null && a.endpoints.includes(held);
    } catch {
      // the switch keeps what it showed
    }
  }

  async function set(want: boolean): Promise<void> {
    const k = key.peek();
    if (busy.peek() || k === null) return;
    const at = session();
    load++;
    busy.value = true;
    error.value = null;
    try {
      if (want) {
        const s = await device.subscribe(k);
        if (s === null) {
          if (at === session()) error.value = "Notifications not allowed.";
          return;
        }
        await call(PUSH_PATH, "POST", s);
      } else {
        const held = await device.current();
        if (held !== null) await call(PUSH_PATH, "DELETE", { endpoint: held });
        await device.unsubscribe();
      }
      if (at === session()) on.value = want;
    } catch (e) {
      if (at === session()) error.value = says(e);
    } finally {
      busy.value = false;
    }
  }

  const signedOut = () => {
    load++;
    key.value = null;
    on.value = false;
    error.value = null;
    device.badge(0);
  };

  return { key, support, on, busy, error, read, set, signedOut };
}

export type PushStore = ReturnType<typeof pushStore>;
