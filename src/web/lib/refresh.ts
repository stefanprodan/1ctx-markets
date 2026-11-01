// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { signal } from "@preact/signals";
import { useEffect, useRef } from "preact/hooks";

// prices land every few minutes; a page's re-read is cheap
export const REFRESH_MS = 60_000;

// true while the page left stays on screen for the next one's read: its
// refresh would supersede that read and land the page left again
export const holding = signal(false);

// a refresh every REFRESH_MS while the page is on screen, and at once
// when the tab comes back. The timer is set once: the latest load is
// read when it fires, so a redraw (a crosshair moving) never restarts it
export function useRefresh(load: () => unknown): void {
  const latest = useRef(load);
  latest.current = load;
  useEffect(() => {
    const visible = () => document.visibilityState === "visible";
    const fire = () => {
      if (visible() && !holding.peek()) void latest.current();
    };
    const timer = setInterval(fire, REFRESH_MS);
    document.addEventListener("visibilitychange", fire);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", fire);
    };
  }, []);
}
