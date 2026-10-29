// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The rail's Recent list: an instrument page is recorded once its detail
// is read, from what the page already loaded, so no request is added. The
// list is this browser's; storage can be absent or full, so every access
// is guarded and a failed write keeps the list for the tab.

import { effect, signal } from "@preact/signals";
import { markets } from "../data/store.ts";
import { path } from "./router.ts";

export type RecentRow = { id: string; name: string | null };

export const RECENT_MAX = 5;
const KEY = "recent";

export const recentHref = (id: string) =>
  `/instruments/${encodeURIComponent(id)}`;

export function readRecent(raw: string | null): RecentRow[] {
  try {
    const list: unknown = JSON.parse(raw ?? "[]");
    if (!Array.isArray(list)) return [];
    return list
      .filter(
        (r): r is RecentRow =>
          typeof r?.id === "string" &&
          (r.name === null || typeof r.name === "string"),
      )
      .slice(0, RECENT_MAX);
  } catch {
    return [];
  }
}

// the page just opened goes first; one opened from Recent keeps its place,
// so flipping between a few never moves the list under the finger
export function putRecent(
  list: RecentRow[],
  row: RecentRow,
  keep: boolean,
): RecentRow[] {
  const at = list.findIndex((r) => r.id === row.id);
  if (keep && at !== -1) return list.map((r, i) => (i === at ? row : r));
  return [row, ...list.filter((r) => r.id !== row.id)].slice(0, RECENT_MAX);
}

const stored = (): RecentRow[] => {
  try {
    return readRecent(localStorage.getItem(KEY));
  } catch {
    return [];
  }
};

export const recent = signal<RecentRow[]>(stored());

function save(list: RecentRow[]): void {
  recent.value = list;
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {}
}

let picked: string | null = null;

export function pickRecent(id: string): void {
  picked = id;
}

export function dropRecent(id: string): void {
  const list = recent.peek();
  if (list.some((r) => r.id === id)) save(list.filter((r) => r.id !== id));
}

function pageId(here: string): string | null {
  try {
    return decodeURIComponent(here.slice("/instruments/".length));
  } catch {
    return null;
  }
}

// once per visit: the page's minute refresh reads the detail again
let recordedAt: string | null = null;

export function watchRecent(): void {
  effect(() => {
    const here = path.value;
    const d = markets.detail.value;
    const id = markets.detailId.value;
    if (!here.startsWith("/instruments/")) {
      recordedAt = null;
      picked = null;
      return;
    }
    if (markets.detailCode.value === 404 && id !== null) {
      dropRecent(id);
      return;
    }
    // the address moves before the page's load starts, so the detail
    // read may still be the page left
    if (d === null || id !== pageId(here) || recordedAt === here) return;
    recordedAt = here;
    const row = { id: d.instrument.id, name: d.instrument.name };
    save(putRecent(recent.peek(), row, picked === row.id || picked === id));
    picked = null;
  });
}
