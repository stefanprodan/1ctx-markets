// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// What movers and screen share: the symbols a caller passes, each once,
// sorted into matched, not matched and unavailable, with the matches
// paged first. Only a match can be wrong in silence, so a missing,
// null or stale input never makes one.

import type { Instrument } from "../instruments.ts";
import type { StaleReason } from "../stale.ts";
import { cursor, fitPage, readCursor } from "./answer.ts";
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

type Entry = { item: object; fred: boolean };

const NOT_THESE = "next does not continue these arguments";

// Where a page starts, checked before anything is read or fetched: a
// cursor is an offset made for these arguments.
export function startOf(next: string | null, args: unknown): number {
  if (next === null) return 0;
  const at = readCursor(next, args);
  const n = at !== null && /^[1-9]\d{0,5}$/.test(at) ? Number(at) : null;
  if (n === null) throw new ArgError(NOT_THESE);
  return n;
}

// what a movers or screen call found, before any page
export type SetRead = {
  matched: Entry[];
  notMatched: number;
  unavailable: Unavailable[];
  errors: ErrorItem[];
  head: Record<string, unknown>;
  attribution: string;
};

// matches first, then the unavailable by id, then the errors
const ordered = (read: SetRead): Entry[] => [
  ...read.matched,
  ...[...read.unavailable].sort(byId).map((item) => ({ item, fred: false })),
  ...read.errors.map((item) => ({ item, fred: false })),
];

const countsOf = (read: SetRead) => ({
  matched: read.matched.length,
  not_matched: read.notMatched,
  unavailable: read.unavailable.length,
  errors: read.errors.length,
});

// counts cover every page
export function setPage(
  options: SetRead & { args: unknown; offset: number },
): string {
  const items = ordered(options);
  const offset = options.offset;
  // the set may have shrunk since the cursor was made
  if (offset > 0 && offset >= items.length) throw new ArgError(NOT_THESE);
  const rest = items.slice(offset);
  return fitPage(
    rest.map((e) => e.item),
    (count) => ({
      ...options.head,
      counts: countsOf(options),
      ...(rest.slice(0, count).some((e) => e.fred)
        ? { attribution: options.attribution }
        : {}),
      next:
        offset + count < items.length
          ? cursor(String(offset + count), options.args)
          : null,
    }),
  ).text;
}

// the whole set in one answer, as setPage orders it
export function setAll(read: SetRead): object {
  const items = ordered(read);
  return {
    ...read.head,
    counts: countsOf(read),
    ...(items.some((e) => e.fred) ? { attribution: read.attribution } : {}),
    items: items.map((e) => e.item),
  };
}
