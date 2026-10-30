// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// The pages; the server answers the same paths with the page (UI_PATHS in
// src/server/http.ts), and the rail is drawn from the ones without a
// parameter.

import type { ComponentType } from "preact";
import { markets } from "../data/store.ts";
import type { IconName } from "../lib/icons.tsx";
import { Connect } from "../views/Connect.tsx";
import { Dashboard } from "../views/Dashboard.tsx";
import { Instrument } from "../views/Instrument.tsx";
import { Instruments } from "../views/Instruments.tsx";
import { Portfolios } from "../views/Portfolios.tsx";
import { Status } from "../views/Status.tsx";

export type Params = Record<string, string>;

export type Route = {
  // a segment that starts with ":" takes any one segment as that param
  path: string;
  label: string;
  icon: IconName;
  view: ComponentType<{ params: Params }>;
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
    path: "/instruments",
    label: "Instruments",
    icon: "list",
    view: Instruments,
    load: async () => {
      await markets.loadInstruments();
    },
  },
  {
    path: "/instruments/:id",
    label: "Instrument",
    icon: "list",
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
      await markets.portfolios.load();
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
  here === path || here.startsWith(`${path}/`);

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
