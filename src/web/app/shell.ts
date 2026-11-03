// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { signal } from "@preact/signals";

export const NARROW = "(max-width: 719px)";
// a phone on its side is wide but too short for a rail beside the view
export const PHONE = `${NARROW}, (max-height: 500px) and (pointer: coarse)`;
const KEY = "rail";

const stored = (): boolean => {
  try {
    return localStorage.getItem(KEY) === "hidden";
  } catch {
    return false;
  }
};

// a phone: the bottom bar in place of the rail and the strip
export const onPhone = signal(false);
export const railHidden = signal(stored());

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

export function watchScreen(): void {
  if (typeof matchMedia === "undefined") return;
  const phone = matchMedia(PHONE);
  const apply = () => {
    onPhone.value = phone.matches;
  };
  apply();
  phone.addEventListener("change", apply);
}
