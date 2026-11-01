// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// One setting for every page: each figure has the class "amount", the
// element around them hiddenClass(hide).

import { useState } from "preact/hooks";
import { Icon } from "../lib/icons.tsx";
import "./amounts.css";

export const HIDE_KEY = "markets-portfolio-hide";

export const hiddenClass = (hide: boolean): string =>
  hide ? "amounts-hidden" : "";

// browser storage is a convenience: a browser that keeps nothing shows them
const read = (): boolean => {
  try {
    return localStorage.getItem(HIDE_KEY) === "1";
  } catch {
    return false;
  }
};

export function useHideAmounts(): [boolean, () => void] {
  const [hide, setHide] = useState(read);
  const toggle = () => {
    const next = !hide;
    setHide(next);
    try {
      localStorage.setItem(HIDE_KEY, next ? "1" : "0");
    } catch {}
  };
  return [hide, toggle];
}

export function HideAmounts({
  hide,
  onToggle,
}: {
  hide: boolean;
  onToggle: () => void;
}) {
  const label = hide ? "Show amounts" : "Hide amounts";
  return (
    <button
      type="button"
      class="btn-icon"
      aria-label={label}
      title={label}
      onClick={onToggle}
    >
      <Icon name={hide ? "eye-off" : "eye"} />
    </button>
  );
}
