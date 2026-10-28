// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { ComponentChildren } from "preact";
import { useEffect, useRef } from "preact/hooks";
import { markets, type Store } from "../data/store.ts";
import { Icon } from "../lib/icons.tsx";
import { SignIn } from "../views/SignIn.tsx";
import { Rail } from "./Rail.tsx";
import { navigate, path } from "./router.ts";
import { ALIASES, HOME, match } from "./routes.ts";
import { Strip } from "./Strip.tsx";
import {
  closeDrawer,
  drawerOpen,
  hideRail,
  openDrawer,
  railDrawer,
  railHidden,
} from "./shell.ts";
import "./shell.css";

// wide: the rail beside the view, or folded to the strip. Narrow or short:
// the rail covers the view, opened by a button floating at its top left;
// the view under it is inert, and closing it gives the button the focus
export function Shell({
  here,
  children,
}: {
  here: string;
  children: ComponentChildren;
}) {
  const phone = railDrawer.value;
  const railShown = phone ? drawerOpen.value : !railHidden.value;
  const covered = phone && drawerOpen.value;
  const show = useRef<HTMLButtonElement>(null);
  const main = useRef<HTMLElement>(null);
  const wasCovered = useRef(false);

  useEffect(() => {
    if (!covered) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeDrawer();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [covered]);
  useEffect(() => {
    closeDrawer();
    main.current?.scrollTo(0, 0);
  }, [here]);
  useEffect(() => {
    if (wasCovered.current && !covered) show.current?.focus();
    wasCovered.current = covered;
  }, [covered]);

  return (
    <div class="shell">
      {railShown && (
        <Rail
          here={here}
          narrow={phone}
          onHide={phone ? closeDrawer : hideRail}
        />
      )}
      {!railShown && !phone && <Strip here={here} />}
      <main
        ref={main}
        class={`shell-main${railShown ? "" : " shell-main-bare"}`}
        inert={covered}
      >
        {!railShown && phone && (
          <button
            ref={show}
            type="button"
            class="btn-icon shell-show-float"
            aria-label="Show the menu"
            onClick={openDrawer}
          >
            <Icon name="sidebar" />
          </button>
        )}
        {children}
      </main>
    </div>
  );
}

export function App({ store = markets }: { store?: Store }) {
  const signedIn = store.signedIn.value;
  const here = path.value;
  const found = match(here);
  const route = found?.route ?? null;
  const arrived = useRef<string | null>(null);

  // the first status answer is also the check of the cookie
  useEffect(() => {
    void store.check();
  }, [store]);
  useEffect(() => {
    const alias = ALIASES[here];
    if (alias !== undefined) navigate(alias, true);
    else if (route === null) navigate(HOME, true);
  }, [here, route]);
  // a page's load runs on arrival; the check above is the status page's
  useEffect(() => {
    // signed out, the page's data went; the next sign-in loads it again
    if (signedIn === false) arrived.current = null;
    if (signedIn !== true || route === null) return;
    const first = arrived.current === null;
    if (arrived.current !== here && !(first && route.path === "/status")) {
      void route.load?.(found!.params);
    }
    arrived.current = here;
  }, [here, signedIn, route]);

  if (signedIn === undefined) {
    const failed = store.statusError.value;
    if (failed === null) return null;
    return (
      <main class="shell-fail">
        <p class="error">{failed}</p>
        <button type="button" class="btn" onClick={() => void store.check()}>
          Try again
        </button>
      </main>
    );
  }
  if (!signedIn) return <SignIn store={store} />;
  if (found === null) return null;
  const View = found.route.view;
  return (
    <Shell here={here}>
      <View params={found.params} />
    </Shell>
  );
}
