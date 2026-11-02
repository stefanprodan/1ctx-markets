// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// One setting for every page: each figure has the class "amount", the
// element around them hiddenClass(hide).

import { signal } from "@preact/signals";
import { Icon } from "../lib/icons.tsx";
import "./amounts.css";

export const HIDE_KEY = "markets-portfolio-hide";

export const hiddenClass = (hide: boolean): string =>
  hide ? "amounts-hidden" : "";

// browser storage is a convenience: a browser that keeps nothing shows them
export const readHidden = (): boolean => {
  try {
    return localStorage.getItem(HIDE_KEY) === "1";
  } catch {
    return false;
  }
};

// one for the whole app, so the head's eye reaches every figure at once
export const amountsHidden = signal(readHidden());

export function toggleAmounts(): void {
  const next = !amountsHidden.value;
  amountsHidden.value = next;
  try {
    localStorage.setItem(HIDE_KEY, next ? "1" : "0");
  } catch {}
}

export function HideAmounts() {
  const hide = amountsHidden.value;
  const label = hide ? "Show amounts" : "Hide amounts";
  return (
    <button
      type="button"
      class="btn-icon"
      aria-label={label}
      title={label}
      onClick={toggleAmounts}
    >
      <Icon name={hide ? "eye-off" : "eye"} />
    </button>
  );
}
