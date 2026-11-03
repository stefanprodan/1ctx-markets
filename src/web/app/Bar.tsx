// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// A phone's navigation: one bar floating over the view's foot, in place of
// the rail and the strip. More holds the rest of the rail.

import { effect, signal } from "@preact/signals";
import { useEffect, useRef, useState } from "preact/hooks";
import { markets } from "../data/store.ts";
import { Icon, type IconName } from "../lib/icons.tsx";
import { Drawer } from "../ui/Drawer.tsx";
import { OPENER, openSearch, searchShown } from "../ui/SymbolSearch.tsx";
import { useServerFailing } from "./failing.ts";
import { SCREENER } from "./paths.ts";
import { iconClass, Recent } from "./Rail.tsx";
import { path, visits } from "./router.ts";
import { HOME, lit, RAIL, railFor, STATUS } from "./routes.ts";
import { UserItems } from "./UserMenu.tsx";
import "./bar.css";

const PORTFOLIOS = "/portfolios";
// the rail's pages the bar has no slot for, in More
export const MORE = RAIL.filter(
  (r) => r.path !== HOME && r.path !== SCREENER && r.path !== PORTFOLIOS,
);

// More's pages for this person: an admin's only for admins
export const moreFor = (admin: boolean) => {
  const shown = new Set(railFor(admin));
  return MORE.filter((r) => shown.has(r));
};

// never kept: a reload opens on the view
export const moreOpen = signal(false);

// a step to another address, Back or the browser's own, closes More, so no
// page opens under it
export function watchMore(): () => void {
  return effect(() => {
    void path.value;
    void visits.value;
    moreOpen.value = false;
  });
}

export type Slot = "home" | "screener" | "portfolios" | "more";

export function barLit(here: string): Slot | null {
  if (here === HOME) return "home";
  if (lit(here, SCREENER)) return "screener";
  if (lit(here, PORTFOLIOS)) return "portfolios";
  if (MORE.some((r) => lit(here, r.path))) return "more";
  return null;
}

const KEYS = new Set([
  "",
  "text",
  "search",
  "email",
  "number",
  "password",
  "tel",
  "url",
  "date",
  "datetime-local",
  "month",
  "time",
  "week",
]);

// a field that opens the keyboard, which the bar would ride on
export function isTextField(el: EventTarget | null): boolean {
  const e = el as HTMLElement | null;
  if (e === null || typeof e.tagName !== "string") return false;
  if (e.isContentEditable || e.tagName === "TEXTAREA") return true;
  if (e.tagName !== "INPUT") return false;
  return KEYS.has((e.getAttribute("type") ?? "").toLowerCase());
}

// a text field outside the bar has the focus, and is still on the page
export function typingIn(active: Element | null, bar: Node | null): boolean {
  return (
    active?.isConnected === true &&
    isTextField(active) &&
    !(bar?.contains(active) ?? false)
  );
}

type Watched = {
  doc: Pick<Document, "addEventListener" | "removeEventListener"> & {
    activeElement: Element | null;
    body: Node | null;
  };
  view?: Pick<VisualViewport, "addEventListener" | "removeEventListener">;
  Observer?: typeof MutationObserver;
};

// WebKit fires no focusout when the focused field leaves the page (a
// drawer or the sheet closing, a page going), so the bar asks the active
// element again on every change that could end the typing; the tree is
// watched only while the bar is away
export function watchTyping(
  w: Watched,
  bar: () => Node | null,
  set: (typing: boolean) => void,
): { check: () => void; stop: () => void } {
  let away = false;
  let tree: MutationObserver | null = null;
  const check = () => {
    const now = typingIn(w.doc.activeElement, bar());
    if (now === away) return;
    away = now;
    set(now);
    if (now && w.Observer && w.doc.body) {
      tree = new w.Observer(check);
      tree.observe(w.doc.body, { childList: true, subtree: true });
    } else {
      tree?.disconnect();
      tree = null;
    }
  };
  // the focus moves only after focusout has run
  const later = () => queueMicrotask(check);
  w.doc.addEventListener("focusin", check);
  w.doc.addEventListener("focusout", later);
  w.view?.addEventListener("resize", check);
  // a screen turning into a phone may already have a field focused
  check();
  return {
    check,
    stop: () => {
      w.doc.removeEventListener("focusin", check);
      w.doc.removeEventListener("focusout", later);
      w.view?.removeEventListener("resize", check);
      tree?.disconnect();
    },
  };
}

function useTyping(bar: { current: HTMLElement | null }): boolean {
  const [typing, setTyping] = useState(false);
  const watch = useRef<{ check: () => void } | null>(null);
  useEffect(() => {
    const w = watchTyping(
      {
        doc: document,
        view: window.visualViewport ?? undefined,
        Observer: MutationObserver,
      },
      () => bar.current,
      setTyping,
    );
    watch.current = w;
    return w.stop;
  }, []);
  const address = path.value;
  useEffect(() => {
    watch.current?.check();
  }, [address]);
  return typing;
}

function BarLink({
  href,
  icon,
  label,
  on,
  here,
}: {
  href: string;
  icon: IconName;
  label: string;
  on: boolean;
  here: string;
}) {
  return (
    <a
      href={href}
      class={`bar-slot${on ? " bar-slot-on" : ""}`}
      aria-current={on ? (here === href ? "page" : "true") : undefined}
    >
      <Icon name={icon} size={20} />
      <span class="bar-label">{label}</span>
    </a>
  );
}

export function Bar({ here }: { here: string }) {
  const failing = useServerFailing();
  const bar = useRef<HTMLElement>(null);
  const typing = useTyping(bar);
  const on = barLit(here);
  return (
    <>
      <nav
        ref={bar}
        class={`bar${typing ? " bar-away" : ""}`}
        aria-label="Pages"
      >
        <BarLink
          href={HOME}
          icon="home"
          label="Home"
          on={on === "home"}
          here={here}
        />
        <BarLink
          href={SCREENER}
          icon="list"
          label="Screener"
          on={on === "screener"}
          here={here}
        />
        <BarLink
          href={PORTFOLIOS}
          icon="briefcase"
          label="Portfolios"
          on={on === "portfolios"}
          here={here}
        />
        <button
          type="button"
          class="bar-slot"
          disabled={searchShown.value === 0}
          onClick={openSearch}
          {...{ [OPENER]: "" }}
        >
          <Icon name="search" size={20} />
          <span class="bar-label">Search</span>
        </button>
        <button
          type="button"
          class={`bar-slot${on === "more" ? " bar-slot-on" : ""}`}
          aria-haspopup="dialog"
          aria-expanded={moreOpen.value}
          aria-label={failing ? "More: something is failing" : undefined}
          title={failing ? "Something is failing" : undefined}
          onClick={() => {
            moreOpen.value = true;
          }}
        >
          <Icon name="more" size={20} class={iconClass(failing)} />
          <span class="bar-label">More</span>
        </button>
      </nav>
      {moreOpen.value && (
        <More
          here={here}
          failing={failing}
          onClose={() => {
            moreOpen.value = false;
          }}
        />
      )}
    </>
  );
}

// outside the bar: its blur would hold a fixed drawer inside it
export function More({
  here,
  failing,
  onClose,
}: {
  here: string;
  failing: boolean;
  onClose: () => void;
}) {
  return (
    <Drawer title="More" onClose={onClose}>
      {(close) => (
        <nav class="more" aria-label="More">
          {moreFor(markets.isAdmin.value).map((r) => {
            const red = r.path === STATUS && failing;
            return (
              <a
                key={r.path}
                href={r.path}
                class={`rail-item${lit(here, r.path) ? " rail-item-on" : ""}`}
                aria-current={here === r.path ? "page" : undefined}
                aria-label={
                  red ? `${r.label}: something is failing` : undefined
                }
                onClick={close}
              >
                <Icon name={r.icon} class={iconClass(red)} />
                <span>{r.label}</span>
              </a>
            );
          })}
          <Recent here={here} follow={close} />
          <div class="more-user">
            <UserItems onSignedOut={close} />
          </div>
        </nav>
      )}
    </Drawer>
  );
}
