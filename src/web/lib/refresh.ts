// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { signal } from "@preact/signals";
import { useEffect, useRef } from "preact/hooks";

// a page's re-read is cheap: it reads the server's store, never a source
export const REFRESH_MS = 30_000;

// a read lands in tens of milliseconds; the menu's pulse needs this long
// to be seen at all
export const PULSE_MS = 600;

// true while the page left stays on screen for the next one's read: its
// refresh would supersede that read and land the page left again
export const holding = signal(false);

// the page's refreshes in flight, for the menu's pulse
export const reloading = signal(0);

// a refresh every REFRESH_MS while the page is on screen, and at once
// when the tab comes back. The timer is set once: the latest load is
// read when it fires, so a redraw (a crosshair moving) never restarts it.
// quiet keeps the menu still, for a read that is not the page's
export function useRefresh(load: () => unknown, quiet = false): void {
  const latest = useRef(load);
  latest.current = load;
  useEffect(() => {
    const visible = () => document.visibilityState === "visible";
    const fire = () => {
      if (!visible() || holding.peek()) return;
      const read = latest.current();
      // a load that asked nothing, such as one held while editing, never pulses
      if (quiet || read === undefined) return;
      reloading.value++;
      void Promise.allSettled([
        read,
        new Promise((r) => setTimeout(r, PULSE_MS)),
      ]).then(() => {
        reloading.value--;
      });
    };
    const timer = setInterval(fire, REFRESH_MS);
    document.addEventListener("visibilitychange", fire);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", fire);
    };
  }, []);
}
