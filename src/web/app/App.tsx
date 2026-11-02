// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { markets, type Store } from "../data/store.ts";
import { Icon } from "../lib/icons.tsx";
import { holding, reloading } from "../lib/refresh.ts";
import { hold } from "../lib/slow.ts";
import { Page } from "../ui/Page.tsx";
import { SignIn } from "../views/SignIn.tsx";
import { Rail } from "./Rail.tsx";
import { navigate, path, visits } from "./router.ts";
import { HOME, type Match, match } from "./routes.ts";
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
  // the drawer closes on the tap, the page scrolls up once it shows
  const address = path.value;
  useEffect(() => {
    closeDrawer();
  }, [address]);
  useEffect(() => {
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
        class={`shell-main${railShown ? "" : " shell-main-bare"}${holding.value ? " shell-holding" : ""}`}
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
            <Icon
              name="sidebar"
              class={reloading.value > 0 ? "rail-icon-reload" : undefined}
            />
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
  const visit = `${here} ${visits.value}`;
  const found = match(here);
  const route = found?.route ?? null;
  const arrived = useRef<string | null>(null);
  // the page on screen, which stays while the next one reads (hold())
  const [shown, setShown] = useState<{
    visit: string;
    here: string;
    found: Match;
  } | null>(null);

  // the first status answer is also the check of the cookie
  useEffect(() => {
    void store.check();
  }, [store]);
  useEffect(() => {
    if (route === null) navigate(HOME, true);
  }, [here, route]);
  // a page's load runs on arrival; the check above is the status page's
  useEffect(() => {
    // signed out, the page's data went; the next sign-in loads it again
    // and holds no page from before
    if (signedIn === false) {
      arrived.current = null;
      setShown(null);
    }
    if (signedIn !== true || route === null) return;
    const first = arrived.current === null;
    let work: Promise<void> | undefined;
    if (arrived.current !== visit && !(first && route.path === "/status")) {
      work = route.load?.(found!.params);
    }
    arrived.current = visit;
    const arrive = () => setShown({ visit, here, found: found! });
    if (first || work === undefined) {
      arrive();
      return;
    }
    holding.value = true;
    const drop = hold(
      work,
      () => {
        holding.value = false;
        arrive();
      },
      store.later,
    );
    return () => {
      drop();
      holding.value = false;
    };
  }, [visit, signedIn, route]);

  if (signedIn === undefined) {
    const failed = store.statusError.value;
    if (failed === null) return null;
    // the page asked for keeps its place in the rail and its title, so a
    // failed first load reads as that page failing, not a blank site
    return (
      <Shell here={here}>
        <Page
          title={route?.label ?? "Home"}
          search={false}
          failed={{
            words: failed,
            status: store.statusCode.value,
            retry: () => void store.check(),
          }}
        />
      </Shell>
    );
  }
  if (!signedIn) return <SignIn store={store} />;
  if (found === null) return null;
  const held = shown !== null && shown.visit !== visit ? shown : null;
  const page = held?.found ?? found;
  const View = page.route.view;
  return (
    <Shell here={held?.here ?? here}>
      <View params={page.params} />
    </Shell>
  );
}
