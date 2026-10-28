// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useRef } from "preact/hooks";
import { Icon, Logo } from "../lib/icons.tsx";
import { HOME, lit, RAIL } from "./routes.ts";
import { toggleUserMenu, UserMenu, userMenuOpen } from "./UserMenu.tsx";
import "./rail.css";

export function Rail({
  here,
  narrow,
  onHide,
}: {
  here: string;
  narrow: boolean;
  onHide: () => void;
}) {
  const hide = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (narrow) hide.current?.focus();
  }, [narrow]);
  // a link to the page on screen is no navigation, so it closes the drawer
  const follow = narrow ? onHide : undefined;
  return (
    <aside class={`rail${narrow ? " rail-drawer" : ""}`}>
      <div class="rail-top">
        <div class="rail-head">
          <a class="rail-logo" href={HOME} aria-label="Home" onClick={follow}>
            <Logo height={26} />
          </a>
          <span class="rail-word">Markets</span>
          <button
            ref={hide}
            type="button"
            class="btn-icon rail-hide"
            aria-label={narrow ? "Close the menu" : "Hide the menu"}
            onClick={onHide}
          >
            <Icon name={narrow ? "close" : "sidebar"} />
          </button>
        </div>
        <nav class="rail-nav">
          {RAIL.map((r) => (
            <a
              key={r.path}
              href={r.path}
              class={`rail-item${lit(here, r.path) ? " rail-item-on" : ""}`}
              aria-current={here === r.path ? "page" : undefined}
              onClick={follow}
            >
              <Icon name={r.icon} />
              <span>{r.label}</span>
            </a>
          ))}
        </nav>
      </div>
      <UserMenu wrap="rail-user" place="rail-menu">
        <button
          type="button"
          class="rail-user-row"
          aria-expanded={userMenuOpen.value}
          onClick={toggleUserMenu}
        >
          <span class="avatar">
            <Icon name="key" size={14} />
          </span>
          <span class="rail-user-name cut">Admin</span>
          <Icon name="chevron" size={14} class="rail-user-chevron" />
        </button>
      </UserMenu>
    </aside>
  );
}
