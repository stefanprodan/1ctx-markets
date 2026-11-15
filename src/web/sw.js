// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// Shows a fired alert's push and opens Fired on a tap. It caches nothing,
// so the app never shows an old price offline.

const FIRED = "/alerts/history";

// a new worker takes over at once and controls the open app, so a tap can
// move it to Fired
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", (event) => {
  let p = {};
  try {
    p = event.data ? event.data.json() : {};
  } catch {}
  const shown = self.registration.showNotification(p.title || "Markets", {
    body: p.body || "",
    tag: p.tag,
    data: { url: typeof p.url === "string" ? p.url : FIRED },
    icon: "/icon-192.png",
  });
  // a push that shows nothing may end the subscription, so the badge never
  // holds the notification back
  const badge =
    typeof p.badge === "number" && "setAppBadge" in navigator
      ? (p.badge > 0
          ? navigator.setAppBadge(p.badge)
          : navigator.clearAppBadge()
        ).catch(() => {})
      : Promise.resolve();
  event.waitUntil(Promise.all([shown, badge]));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = new URL(
    event.notification.data?.url || FIRED,
    self.location.origin,
  );
  // same origin only, so a payload never opens another site
  const to = url.origin === self.location.origin ? url.href : FIRED;
  event.waitUntil(
    self.clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((open) => {
        const app = open.find((c) => "focus" in c);
        if (!app) return self.clients.openWindow(to);
        return app
          .navigate(to)
          .then((c) => (c ?? app).focus())
          .catch(() => self.clients.openWindow(to));
      }),
  );
});
