// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { signal } from "@preact/signals";

export const NARROW = "(max-width: 719px)";
// a phone on its side is wide but too short for a rail beside the view
export const DRAWER = `${NARROW}, (max-height: 500px) and (pointer: coarse)`;
const KEY = "rail";

const stored = (): boolean => {
  try {
    return localStorage.getItem(KEY) === "hidden";
  } catch {
    return false;
  }
};

export const railDrawer = signal(false);
export const railHidden = signal(stored());
// never kept: a reload opens on the view
export const drawerOpen = signal(false);

export function hideRail(): void {
  railHidden.value = true;
  try {
    localStorage.setItem(KEY, "hidden");
  } catch {}
}

export function showRail(): void {
  railHidden.value = false;
  try {
    localStorage.removeItem(KEY);
  } catch {}
}

export function openDrawer(): void {
  drawerOpen.value = true;
}

export function closeDrawer(): void {
  drawerOpen.value = false;
}

// a drawer left open when the rail stops being one is closed, so it is not
// open again the next time it becomes one
export function watchScreen(): void {
  if (typeof matchMedia === "undefined") return;
  const drawer = matchMedia(DRAWER);
  const apply = () => {
    railDrawer.value = drawer.matches;
    if (!drawer.matches) closeDrawer();
  };
  apply();
  drawer.addEventListener("change", apply);
}
