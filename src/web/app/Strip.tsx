// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { Icon, Mark } from "../lib/icons.tsx";
import { useServerFailing } from "./failing.ts";
import { HOME, lit, RAIL, STATUS } from "./routes.ts";
import { showRail } from "./shell.ts";
import { toggleUserMenu, UserMenu, userMenuOpen } from "./UserMenu.tsx";
import "./strip.css";

export function Strip({ here }: { here: string }) {
  const failing = useServerFailing();
  return (
    <aside class="strip">
      <button
        type="button"
        class="btn-icon strip-show"
        aria-label="Show the menu"
        title="Show the menu"
        onClick={showRail}
      >
        <Icon name="sidebar" />
      </button>
      <a class="strip-mark" href={HOME} aria-label="Home" title="Home">
        <Mark />
      </a>
      <nav class="strip-nav">
        {RAIL.map((r) => {
          const red = r.path === STATUS && failing;
          return (
            <a
              key={r.path}
              href={r.path}
              class={`strip-item${lit(here, r.path) ? " strip-item-on" : ""}`}
              aria-current={here === r.path ? "page" : undefined}
              aria-label={red ? `${r.label}: something is failing` : r.label}
              title={red ? `${r.label}: something is failing` : r.label}
            >
              <Icon
                name={r.icon}
                class={red ? "rail-icon-failed" : undefined}
              />
            </a>
          );
        })}
      </nav>
      <div class="strip-foot">
        <UserMenu wrap="strip-user" place="strip-menu">
          <button
            type="button"
            class="strip-avatar"
            aria-expanded={userMenuOpen.value}
            aria-label="Admin"
            title="Admin"
            onClick={toggleUserMenu}
          >
            <span class="avatar">
              <Icon name="key" size={14} />
            </span>
          </button>
        </UserMenu>
      </div>
    </aside>
  );
}
