// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { markets, type Store } from "../data/store.ts";
import { holding } from "../lib/refresh.ts";
import { hold } from "../lib/slow.ts";
import { Page } from "../ui/Page.tsx";
import { SignIn } from "../views/SignIn.tsx";
import { Bar } from "./Bar.tsx";
import { Rail } from "./Rail.tsx";
import { navigate, path, visits } from "./router.ts";
import { HOME, type Match, match } from "./routes.ts";
import { Strip } from "./Strip.tsx";
import { hideRail, onPhone, railHidden } from "./shell.ts";
import "./shell.css";

// wide: the rail beside the view, or folded to the strip. A phone: the
// view alone, with the bar floating over its foot
export function Shell({
  here,
  children,
}: {
  here: string;
  children: ComponentChildren;
}) {
  const phone = onPhone.value;
  const main = useRef<HTMLElement>(null);
  useEffect(() => {
    main.current?.scrollTo(0, 0);
  }, [here]);

  return (
    <div class="shell">
      {!phone &&
        (railHidden.value ? (
          <Strip here={here} />
        ) : (
          <Rail here={here} onHide={hideRail} />
        ))}
      <main
        ref={main}
        class={`shell-main${phone ? " shell-main-bar" : ""}${holding.value ? " shell-holding" : ""}`}
      >
        {children}
      </main>
      {phone && <Bar here={here} />}
    </div>
  );
}

export function App({ store = markets }: { store?: Store }) {
  const signedIn = store.signedIn.value;
  const here = path.value;
  const visit = `${here} ${visits.value}`;
  const admin = store.isAdmin.value;
  const found = match(here);
  // a member asking for an admin's page lands on Home
  const barred = signedIn === true && found?.route.admin === true && !admin;
  const route = barred ? null : (found?.route ?? null);
  const arrived = useRef<string | null>(null);
  // the page on screen, which stays while the next one reads (hold())
  const [shown, setShown] = useState<{
    visit: string;
    here: string;
    found: Match;
  } | null>(null);

  // /ui/me says whether the cookie holds and whose it is
  useEffect(() => {
    void store.check();
  }, [store]);
  useEffect(() => {
    if (route === null) navigate(HOME, true);
  }, [here, route]);
  // a page's load runs on arrival
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
    if (arrived.current !== visit) {
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
  if (found === null || route === null) return null;
  const held = shown !== null && shown.visit !== visit ? shown : null;
  const page = held?.found ?? found;
  const View = page.route.view;
  return (
    <Shell here={held?.here ?? here}>
      <View params={page.params} />
    </Shell>
  );
}
