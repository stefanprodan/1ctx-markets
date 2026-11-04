// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { markets } from "../data/store.ts";
import { Icon, Mark } from "../lib/icons.tsx";
import { useServerFailing } from "./failing.ts";
import { iconClass } from "./Rail.tsx";
import { ADMIN, HOME, lit, railFor } from "./routes.ts";
import { showRail } from "./shell.ts";
import {
  avatarIcon,
  toggleUserMenu,
  UserMenu,
  userMenuOpen,
  userName,
} from "./UserMenu.tsx";
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
        {railFor(markets.isAdmin.value).map((r) => {
          const red = r.path === ADMIN && failing;
          return (
            <a
              key={r.path}
              href={r.path}
              class={`strip-item${lit(here, r.path) ? " strip-item-on" : ""}`}
              aria-current={here === r.path ? "page" : undefined}
              aria-label={red ? `${r.label}: something is failing` : r.label}
              title={red ? `${r.label}: something is failing` : r.label}
            >
              <Icon name={r.icon} class={iconClass(red)} />
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
            aria-label={userName()}
            title={userName()}
            onClick={toggleUserMenu}
          >
            <span class="avatar">
              <Icon name={avatarIcon()} size={14} />
            </span>
          </button>
        </UserMenu>
      </div>
    </aside>
  );
}
