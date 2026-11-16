// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// A missing, null or stale input never matches: only a match misleads unseen.

import type { Instrument } from "../market/instruments.ts";
import type { StaleReason } from "../market/stale.ts";
import {
  fitPage,
  notShown,
  readCursor,
  shownCursor,
  shownOf,
} from "./answer.ts";
import { ArgError } from "./args.ts";
import type { ErrorItem, Target } from "./targets.ts";

export type Resolved = { input: string; instrument: Instrument };

export function distinct(targets: readonly Target[]): {
  resolved: Resolved[];
  errors: ErrorItem[];
} {
  const seen = new Set<string>();
  const resolved: Resolved[] = [];
  const errors: ErrorItem[] = [];
  for (const t of targets) {
    if ("error" in t) {
      errors.push({ input: t.input, ...t.error });
    } else if (!seen.has(t.instrument.id)) {
      seen.add(t.instrument.id);
      resolved.push(t);
    }
  }
  return { resolved, errors };
}

export type Unavailable = {
  input: string;
  id: string;
  status: "unavailable";
  missing: string[];
  stale: string[];
  reason?: string;
};

export function unavailable(
  r: Resolved,
  missing: readonly string[],
  stale: readonly string[],
  reason?: string,
): Unavailable {
  return {
    input: r.input,
    id: r.instrument.id,
    status: "unavailable",
    missing: [...new Set(missing)],
    stale: [...new Set(stale)],
    ...(reason === undefined ? {} : { reason }),
  };
}

// a benchmark's reasons, told apart from the symbol's own
export const benchmarkStale = (reasons: readonly StaleReason[]) =>
  reasons.map((r) => `benchmark: ${r}`);

export const byId = (a: { id: string }, b: { id: string }) =>
  a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

// key: the instrument's id, err:<input> for a row resolved to none, so a
// symbol that turns matched between pages is not shown again
type Entry = { key: string; item: object; fred: boolean };

const NOT_THESE = "next does not continue these arguments";

// checked before anything is read or fetched
export function shownBy(
  next: string | null,
  args: unknown,
): ReadonlySet<string> {
  if (next === null) return new Set();
  const at = readCursor(next, args);
  const shown = at === null ? null : shownOf(at);
  if (shown === null) throw new ArgError(NOT_THESE);
  return shown;
}

export type SetRead = {
  matched: Entry[];
  notMatched: number;
  unavailable: Unavailable[];
  errors: ErrorItem[];
  head: Record<string, unknown>;
  attribution: string;
};

const keyOf = (item: ErrorItem): string =>
  "id" in item && typeof item.id === "string" ? item.id : `err:${item.input}`;

const ordered = (read: SetRead): Entry[] => [
  ...read.matched,
  ...[...read.unavailable]
    .sort(byId)
    .map((item) => ({ key: item.id, item, fred: false })),
  ...read.errors.map((item) => ({ key: keyOf(item), item, fred: false })),
];

const countsOf = (read: SetRead) => ({
  matched: read.matched.length,
  not_matched: read.notMatched,
  unavailable: read.unavailable.length,
  errors: read.errors.length,
});

// counts cover every page
export function setPage(
  options: SetRead & { args: unknown; shown: ReadonlySet<string> },
): string {
  const { rows: rest, tags } = notShown(
    ordered(options),
    (e) => e.key,
    options.shown,
  );
  return fitPage(
    rest.map((e) => e.item),
    (count) => ({
      ...options.head,
      counts: countsOf(options),
      ...(rest.slice(0, count).some((e) => e.fred)
        ? { attribution: options.attribution }
        : {}),
      next:
        count < rest.length
          ? shownCursor(options.shown, tags.slice(0, count), options.args)
          : null,
    }),
  ).text;
}

export function setAll(read: SetRead): object {
  const items = ordered(read);
  return {
    ...read.head,
    counts: countsOf(read),
    ...(items.some((e) => e.fred) ? { attribution: read.attribution } : {}),
    items: items.map((e) => e.item),
  };
}
