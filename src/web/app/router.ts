// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// Knows no route, so a view may navigate without a cycle through the table.

import { signal } from "@preact/signals";

export const path = signal(
  typeof location === "undefined" ? "/" : location.pathname,
);

export function navigate(to: string, replace = false): void {
  const url = new URL(to, location.origin);
  if (url.pathname === path.value) return;
  if (replace) history.replaceState(null, "", url.pathname);
  else history.pushState(null, "", url.pathname);
  path.value = url.pathname;
}

// a same-origin link opens in place unless it asks for a download or a new
// tab, or leaves the UI for the API's own pages. An installed app has no
// tabs: a new one would leave it for the browser, so there a page of the
// app opens in place even when the link asks for a new tab
export function inApp(
  link: { origin: string; pathname: string; download: boolean; blank: boolean },
  origin: string,
  standalone = false,
): boolean {
  return (
    link.origin === origin &&
    !link.download &&
    (!link.blank || standalone) &&
    link.pathname !== "/api" &&
    !link.pathname.startsWith("/api/")
  );
}

const STANDALONE = "(display-mode: standalone)";

function onLinkClick(event: MouseEvent): void {
  if (event.defaultPrevented || event.button !== 0) return;
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  const anchor = (event.target as HTMLElement).closest("a");
  if (anchor === null) return;
  const link = {
    origin: anchor.origin,
    pathname: anchor.pathname,
    download: anchor.hasAttribute("download"),
    blank: anchor.target === "_blank",
  };
  if (!inApp(link, location.origin, matchMedia(STANDALONE).matches)) return;
  event.preventDefault();
  navigate(anchor.pathname);
}

export function boot(): void {
  window.addEventListener("popstate", () => {
    path.value = location.pathname;
  });
  document.addEventListener("click", onLinkClick);
}
