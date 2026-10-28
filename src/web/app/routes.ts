// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// The pages; the server answers the same paths with the page (UI_PATHS in
// src/server/http.ts), and the rail is drawn from this table.

import type { ComponentType } from "preact";
import { markets } from "../data/store.ts";
import type { IconName } from "../lib/icons.tsx";
import { Instruments } from "../views/Instruments.tsx";
import { Status } from "../views/Status.tsx";

export type Route = {
  path: string;
  label: string;
  icon: IconName;
  view: ComponentType;
  // what arriving on the page loads, before it renders
  load?: () => Promise<void>;
};

export const ROUTES: readonly Route[] = [
  {
    path: "/status",
    label: "Status",
    icon: "status",
    view: Status,
    load: async () => {
      await markets.loadStatus();
    },
  },
  {
    path: "/instruments",
    label: "Instruments",
    icon: "list",
    view: Instruments,
  },
];

export const HOME = "/status";

// an address the server serves the page at that has no page of its own
export const ALIASES: Readonly<Record<string, string>> = { "/": HOME };

export const match = (pathname: string): Route | null =>
  ROUTES.find((r) => r.path === pathname) ?? null;
