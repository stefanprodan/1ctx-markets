// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// Knows no route, so a view may navigate without a cycle through the table.

import { signal } from "@preact/signals";

export const path = signal(
  typeof location === "undefined" ? "/" : location.pathname,
);

// a step to a new address or back through history, never one corrected
// in place, so a page loads again on the same path with another query
export const visits = signal(0);

// each entry the app pushes is one step past the one it left; a reload
// keeps the entry's step, so the page the tab opened on is the base and
// only an entry past it was reached inside the app
export const stepOf = (state: unknown): number => {
  const at = (state as { step?: unknown } | null)?.step;
  return typeof at === "number" ? at : 0;
};
let base = 0;

export function navigate(to: string, replace = false): void {
  const url = new URL(to, location.origin);
  const next = url.pathname + url.search;
  if (next === location.pathname + location.search) return;
  const step = stepOf(history.state);
  if (replace) history.replaceState({ step }, "", next);
  else {
    history.pushState({ step: step + 1 }, "", next);
    visits.value++;
  }
  path.value = url.pathname;
}

// back through the app's own history, or, opened cold, to the address
// given: history.back() there would leave the app
export function backFrom(state: unknown, start: number): "history" | "address" {
  return stepOf(state) > start ? "history" : "address";
}

export function goBack(to: string): void {
  if (backFrom(history.state, base) === "history") history.back();
  else navigate(to);
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
  navigate(anchor.pathname + anchor.search);
}

export function boot(): void {
  base = stepOf(history.state);
  window.addEventListener("popstate", () => {
    path.value = location.pathname;
    visits.value++;
  });
  document.addEventListener("click", onLinkClick);
}
