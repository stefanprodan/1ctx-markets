// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { signal, useSignal } from "@preact/signals";
import type { ComponentChildren } from "preact";
import { useEffect, useRef } from "preact/hooks";
import { says } from "../data/api.ts";
import { markets } from "../data/store.ts";
import { Icon } from "../lib/icons.tsx";
import { MenuHead } from "../ui/Menu.tsx";
import { theme, toggleTheme } from "./theme.ts";
import "./usermenu.css";

// one for both owners, which never show together
export const userMenuOpen = signal(false);

export function toggleUserMenu(): void {
  userMenuOpen.value = !userMenuOpen.value;
}

// who is signed in, as the menu names them
export const userName = (): string => markets.me.value?.name ?? "";

// the admin key's person by the key, anyone else as a person
export const avatarIcon = (): "key" | "user" =>
  markets.me.value?.operator === true ? "key" : "user";

// the signed-in person's name, then two items: the user menu's, and
// More's on a phone
export function UserItems({ onSignedOut }: { onSignedOut?: () => void }) {
  const failure = useSignal<string | null>(null);
  return (
    <>
      {userName() !== "" && (
        <MenuHead>
          <span class="cut">{userName()}</span>
        </MenuHead>
      )}
      <button
        type="button"
        role="switch"
        aria-checked={theme.value === "dark"}
        class="menu-item"
        onClick={toggleTheme}
      >
        <Icon name="moon" size={14} />
        <span>Dark theme</span>
        <span
          class={`usermenu-switch switch${theme.value === "dark" ? " switch-on" : ""}`}
        >
          <span class="switch-knob" />
        </span>
      </button>
      <button
        type="button"
        class="menu-item"
        onClick={async () => {
          failure.value = null;
          try {
            await markets.signOut();
          } catch (err) {
            failure.value = says(err);
            return;
          }
          onSignedOut?.();
        }}
      >
        <Icon name="sign-out" size={14} />
        <span>Sign out</span>
      </button>
      {failure.value && <p class="usermenu-error error">{failure.value}</p>}
    </>
  );
}

export function UserMenu({
  wrap,
  place,
  children,
}: {
  wrap: string;
  place: string;
  // the button that opens it, inside the box so its click is no click outside
  children: ComponentChildren;
}) {
  const root = useRef<HTMLDivElement>(null);
  const open = userMenuOpen.value;
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) userMenuOpen.value = false;
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") userMenuOpen.value = false;
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  // the owner leaving closes it, so the rail folded opens it shut
  useEffect(
    () => () => {
      userMenuOpen.value = false;
    },
    [],
  );
  return (
    <div ref={root} class={wrap}>
      {open && (
        <div class={`menu ${place}`}>
          <UserItems
            onSignedOut={() => {
              userMenuOpen.value = false;
            }}
          />
        </div>
      )}
      {children}
    </div>
  );
}
