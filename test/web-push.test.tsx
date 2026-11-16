// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { signal } from "@preact/signals";
import { render } from "preact-render-to-string";
import { UserItems } from "../src/web/app/UserMenu.tsx";
import { client } from "../src/web/data/api.ts";
import {
  browserPush,
  PUSH_PATH,
  type PushDevice,
  pushStore,
  type Subscribed,
  type Support,
} from "../src/web/data/push.ts";
import { markets } from "../src/web/data/store.ts";

const ROW = "Push notifications";

// synchronous, so no other test renders the menu in between
function menuWith(key: string | null, support: Support, on = false): string {
  const p = markets.push;
  const was = [p.key.peek(), p.support.peek(), p.on.peek()] as const;
  p.key.value = key;
  p.support.value = support;
  p.on.value = on;
  try {
    return render(<UserItems />);
  } finally {
    p.key.value = was[0];
    p.support.value = was[1];
    p.on.value = was[2];
  }
}

describe("the push switch", () => {
  test("is absent while push is off on the server or the browser has none", () => {
    expect(menuWith(null, "ready")).not.toContain(ROW);
    expect(menuWith("made-up-key", "none")).not.toContain(ROW);
    expect(render(<UserItems />)).not.toContain(ROW);
  });

  test("sits under Hide amounts and shows this device's state", () => {
    const html = menuWith("made-up-key", "ready", true);
    expect(html.indexOf("Hide amounts")).toBeLessThan(html.indexOf(ROW));
    expect(html.indexOf(ROW)).toBeLessThan(html.indexOf("Sign out"));
    expect(html).toMatch(
      /role="switch" aria-checked="true" class="menu-item">[\s\S]*Push notifications/,
    );
    expect(html).not.toContain("Add to Home Screen first.");
  });

  test("outside the Home Screen app it is off with one line", () => {
    const html = menuWith("made-up-key", "install");
    expect(html).toMatch(
      /role="switch" aria-checked="false" class="menu-item" disabled[^>]*>[\s\S]*Push notifications/,
    );
    expect(html).toContain("Add to Home Screen first.");
  });
});

const SUB: Subscribed = {
  endpoint: "https://web.push.apple.com/made-up",
  keys: { p256dh: "made-up-p256dh", auth: "made-up-auth" },
};

function fakeDevice(allow = true) {
  let held: string | null = null;
  const badges: number[] = [];
  const device: PushDevice = {
    support: () => "ready",
    current: async () => held,
    subscribe: async () => {
      if (!allow) return null;
      held = SUB.endpoint;
      return SUB;
    },
    unsubscribe: async () => {
      const was = held;
      held = null;
      return was;
    },
    badge: (n) => badges.push(n),
  };
  return { device, badges };
}

function server(endpoints: string[] = []) {
  const calls: { method: string; body: unknown }[] = [];
  const fetchFn = async (input: string, init?: RequestInit) => {
    expect(input).toBe(PUSH_PATH);
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ method, body });
    if (method === "GET") {
      return Response.json({ key: "made-up-key", endpoints });
    }
    return new Response(null, { status: 204 });
  };
  return { calls, call: client(fetchFn, () => {}) };
}

describe("the push store", () => {
  test("on saves the subscription, off deletes it, and a refusal stays off", async () => {
    const s = server();
    const d = fakeDevice();
    const unseen = signal<number | null>(null);
    const p = pushStore(
      s.call,
      () => 1,
      d.device,
      () => unseen.value,
    );
    await p.read();
    expect(p.key.value).toBe("made-up-key");
    expect(p.on.value).toBe(false);
    await p.set(true);
    expect(p.on.value).toBe(true);
    expect(s.calls.at(-1)).toEqual({ method: "POST", body: SUB });
    await p.set(false);
    expect(p.on.value).toBe(false);
    expect(s.calls.at(-1)).toEqual({
      method: "DELETE",
      body: { endpoint: SUB.endpoint },
    });
    const refused = pushStore(
      s.call,
      () => 1,
      fakeDevice(false).device,
      () => null,
    );
    await refused.read();
    await refused.set(true);
    expect(refused.on.value).toBe(false);
    expect(refused.error.value).toBe("Notifications not allowed.");
  });

  test("on only when the server holds this browser's endpoint", async () => {
    const d = fakeDevice();
    await d.device.subscribe("made-up-key");
    const held = pushStore(
      server([SUB.endpoint]).call,
      () => 1,
      d.device,
      () => null,
    );
    await held.read();
    expect(held.on.value).toBe(true);
    const other = pushStore(
      server([]).call,
      () => 1,
      d.device,
      () => null,
    );
    await other.read();
    expect(other.on.value).toBe(false);
  });

  test("the badge follows the rail's count and clears on sign-out", () => {
    const d = fakeDevice();
    const unseen = signal<number | null>(null);
    const p = pushStore(
      server().call,
      () => 1,
      d.device,
      () => unseen.value,
    );
    unseen.value = 3;
    unseen.value = 0;
    p.signedOut();
    expect(d.badges).toEqual([3, 0, 0]);
  });
});

describe("the browser's push", () => {
  test("a failed worker registration is tried again", async () => {
    let tries = 0;
    const was = globalThis.navigator;
    const sub = { endpoint: "https://push.example.test/made-up" };
    const ready = { pushManager: { getSubscription: async () => sub } };
    globalThis.navigator = {
      serviceWorker: {
        register: async () => {
          tries++;
          if (tries === 1) throw new Error("offline");
          return ready;
        },
        ready: Promise.resolve(ready),
      },
    } as unknown as Navigator;
    try {
      const device = browserPush();
      await expect(device.current()).rejects.toThrow("offline");
      expect(await device.current()).toBe(sub.endpoint);
      expect(tries).toBe(2);
    } finally {
      globalThis.navigator = was;
    }
  });
});
