// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { markets } from "../data/store.ts";
import { Icon, Logo } from "../lib/icons.tsx";
import { nameOf, tickerOf } from "../lib/names.ts";
import { SymbolName } from "../ui/Symbol.tsx";
import { useServerFailing } from "./failing.ts";
import { ALERTS, symbolHref } from "./paths.ts";
import { pickRecent, RECENT_MAX, recent } from "./recent.ts";
import { ADMIN, HOME, lit, railFor } from "./routes.ts";
import {
  avatarIcon,
  toggleUserMenu,
  UserMenu,
  userMenuOpen,
  userName,
} from "./UserMenu.tsx";
import "./rail.css";

export function Rail({ here, onHide }: { here: string; onHide: () => void }) {
  const failing = useServerFailing();
  const pages = railFor(markets.isAdmin.value);
  return (
    <aside class="rail">
      <div class="rail-top">
        <div class="rail-head">
          <a class="rail-logo" href={HOME} aria-label="Home">
            <Logo height={26} />
          </a>
          <span class="rail-word">Markets</span>
          <button
            type="button"
            class="btn-icon rail-hide"
            aria-label="Hide the menu"
            onClick={onHide}
          >
            <Icon name="sidebar" />
          </button>
        </div>
        <nav class="rail-nav">
          {pages.map((r) => (
            <a
              key={r.path}
              href={r.path}
              class={`rail-item${lit(here, r.path) ? " rail-item-on" : ""}`}
              aria-current={here === r.path ? "page" : undefined}
              title={
                r.path === ADMIN && failing ? "Something is failing" : undefined
              }
              aria-label={
                r.path === ADMIN && failing
                  ? `${r.label}: something is failing`
                  : undefined
              }
            >
              <Icon
                name={r.icon}
                class={iconClass(r.path === ADMIN && failing)}
              />
              <span>{r.label}</span>
              {r.path === ALERTS && <Unseen />}
            </a>
          ))}
          <SharedWithMe here={here} />
          <Recent here={here} />
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
            <Icon name={avatarIcon()} size={14} />
          </span>
          <span class="rail-user-name cut">{userName()}</span>
          <Icon name="chevron" size={14} class="rail-user-chevron" />
        </button>
      </UserMenu>
    </aside>
  );
}

export const iconClass = (failed: boolean): string | undefined =>
  failed ? "rail-icon-failed" : undefined;

// the people who let this one see their portfolios: the rail's, and
// More's on a phone
export function SharedWithMe({
  here,
  follow,
}: {
  here: string;
  follow?: () => void;
}) {
  const rows = markets.sharers.value;
  if (rows.length === 0) return null;
  return (
    <>
      <span class="rail-label">Shared with me</span>
      {rows.map((s) => {
        const href = `/portfolios/shared/${encodeURIComponent(s.id)}`;
        const on = here === href || here.startsWith(`${href}/`);
        return (
          <a
            key={s.id}
            href={href}
            class={`rail-item${on ? " rail-item-on" : ""}`}
            aria-current={here === href ? "page" : undefined}
            onClick={() => follow?.()}
          >
            <Icon name="briefcase" />
            <span class="cut" title={`${s.name}'s portfolios`}>
              {s.name}'s portfolios
            </span>
          </a>
        );
      })}
    </>
  );
}

// the last instruments opened: the rail's, and More's on a phone
export function Recent({
  here,
  follow,
  max = RECENT_MAX,
}: {
  here: string;
  follow?: () => void;
  max?: number;
}) {
  const rows = recent.value.slice(0, max);
  if (rows.length === 0) return null;
  return (
    <>
      <span class="rail-label">Recent</span>
      {rows.map((row) => {
        const href = symbolHref(row.id);
        const symbol = tickerOf(row.id);
        const name = nameOf(row.name, null, row.id);
        return (
          <a
            key={row.id}
            href={href}
            class={`rail-recent${here === href ? " rail-item-on" : ""}`}
            aria-current={here === href ? "page" : undefined}
            title={name ? `${symbol} · ${name}` : symbol}
            onClick={() => {
              pickRecent(row.id);
              follow?.();
            }}
          >
            <SymbolName ticker={symbol} name={name} compact />
          </a>
        );
      })}
    </>
  );
}

// the alerts fired since Fired was last opened, on the rail's and More's row
export function Unseen() {
  const n = markets.alerts.seen.value?.unseen ?? 0;
  if (n === 0) return null;
  return (
    <span class="rail-count num" role="img" aria-label={`${n} new`}>
      {n > 99 ? "99+" : n}
    </span>
  );
}
