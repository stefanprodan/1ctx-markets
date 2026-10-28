// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { useEffect } from "preact/hooks";

// prices land every few minutes; a page's re-read is cheap
export const REFRESH_MS = 60_000;

// while the page is on screen, and at once when the tab comes back
export function useRefresh(load: () => unknown): void {
  useEffect(() => {
    const visible = () => document.visibilityState === "visible";
    const timer = setInterval(() => {
      if (visible()) void load();
    }, REFRESH_MS);
    const back = () => {
      if (visible()) void load();
    };
    document.addEventListener("visibilitychange", back);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", back);
    };
  }, [load]);
}
