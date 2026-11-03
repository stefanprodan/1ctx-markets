// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// The pages; the server answers the same paths with the page (UI_PATHS in
// src/server/http.ts), and the rail is drawn from the ones without a
// parameter.

import type { ComponentType } from "preact";
import { viewOf } from "../data/portfolios.ts";
import { markets } from "../data/store.ts";
import type { IconName } from "../lib/icons.tsx";
import { Connect } from "../views/Connect.tsx";
import { Dashboard } from "../views/Dashboard.tsx";
import { Instrument } from "../views/Instrument.tsx";
import { Portfolios } from "../views/Portfolios.tsx";
import { Profile } from "../views/Profile.tsx";
import { Screener } from "../views/Screener.tsx";
import { Status } from "../views/Status.tsx";
import { SCREENER, SYMBOL } from "./paths.ts";

export type Params = Record<string, string>;

export type Route = {
  // a segment that starts with ":" takes any one segment as that param
  path: string;
  label: string;
  icon: IconName;
  view: ComponentType<{ params: Params }>;
  // the page the rail and the bar light for one outside its path
  parent?: string;
  // what arriving on the page loads, before it renders
  load?: (params: Params) => Promise<void>;
};

export const ROUTES: readonly Route[] = [
  {
    path: "/",
    label: "Home",
    icon: "home",
    view: Dashboard,
    load: async () => {
      await markets.loadDashboard();
    },
  },

  {
    path: SCREENER,
    label: "Screener",
    icon: "list",
    view: Screener,
    load: async () => {
      await markets.loadScreener();
    },
  },
  {
    path: `${SYMBOL}:id`,
    label: "Instrument",
    icon: "list",
    parent: SCREENER,
    view: Instrument,
    load: async (p) => {
      await markets.loadInstrument(p.id!);
    },
  },
  {
    path: "/portfolios",
    label: "Portfolios",
    icon: "briefcase",
    view: Portfolios,
    load: async () => {
      await markets.portfolios.open(viewOf(undefined, location.search));
    },
  },
  {
    path: "/portfolios/:id",
    label: "Portfolios",
    icon: "briefcase",
    view: Portfolios,
    load: async (p) => {
      await markets.portfolios.open(viewOf(p.id, location.search));
    },
  },
  {
    path: "/profile",
    label: "Profile",
    icon: "user",
    view: Profile,
    load: async () => {
      await markets.profile.load();
    },
  },
  {
    path: "/connect",
    label: "Connect agents",
    icon: "plug",
    view: Connect,
    load: async () => {
      await markets.loadKeys();
    },
  },
  {
    path: "/status",
    label: "Server status",
    icon: "status",
    view: Status,
    load: async () => {
      await markets.loadStatus();
    },
  },
];

export const HOME = "/";
export const STATUS = "/status";

// the rail's pages: a page with a parameter lights its parent
export const RAIL = ROUTES.filter((r) => !r.path.includes(":"));
export const lit = (here: string, path: string): boolean =>
  here === path ||
  here.startsWith(`${path}/`) ||
  match(here)?.route.parent === path;

export type Match = { route: Route; params: Params };

export function match(pathname: string): Match | null {
  const parts = pathname.split("/");
  for (const route of ROUTES) {
    const want = route.path.split("/");
    if (want.length !== parts.length) continue;
    const params: Params = {};
    let ok = true;
    for (let i = 0; i < want.length; i++) {
      const w = want[i]!;
      const p = parts[i]!;
      if (w.startsWith(":")) {
        let value: string;
        try {
          value = decodeURIComponent(p);
        } catch {
          ok = false;
          break;
        }
        if (value === "") {
          ok = false;
          break;
        }
        params[w.slice(1)] = value;
      } else if (w !== p) {
        ok = false;
        break;
      }
    }
    if (ok) return { route, params };
  }
  return null;
}
