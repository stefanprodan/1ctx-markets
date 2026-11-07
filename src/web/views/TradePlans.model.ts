// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// The Trade plans page's filters and words, and the instrument card's list.

import type {
  PlanFields,
  PlanFilter,
  PlanItem,
  PlanStatus,
} from "../data/trade-plans.ts";

export const FILTERS: readonly { key: PlanFilter; label: string }[] = [
  { key: "active", label: "Active" },
  { key: "archived", label: "Archived" },
  { key: "all", label: "All" },
  { key: "removed", label: "Deleted" },
];

export const STATUS_WORDS: Record<PlanStatus, string> = {
  active: "Active",
  archived: "Archived",
  removed: "Deleted",
};

// All is active and archived, as the server's own all is
export function inFilter(p: PlanItem, filter: PlanFilter): boolean {
  if (filter === "all") return p.status !== "removed";
  return p.status === filter;
}

// the rows a filter and a symbol leave, newest updated first as answered
export function shownPlans(
  plans: readonly PlanItem[],
  removed: readonly PlanItem[] | null,
  filter: PlanFilter,
  symbol: string | null,
): PlanItem[] {
  const pool = filter === "removed" ? (removed ?? []) : plans;
  return pool.filter(
    (p) =>
      inFilter(p, filter) && (symbol === null || p.symbols.includes(symbol)),
  );
}

// a filter's count; Deleted's only once read
export function filterCount(
  plans: readonly PlanItem[] | null,
  removed: readonly PlanItem[] | null,
  filter: PlanFilter,
): number | null {
  const pool = filter === "removed" ? removed : plans;
  return pool === null ? null : pool.filter((p) => inFilter(p, filter)).length;
}

export function symbolChoices(plans: readonly PlanItem[]): string[] {
  return [...new Set(plans.flatMap((p) => p.symbols))].sort();
}

export function cardPlans(
  plans: readonly PlanItem[],
  archived: boolean,
): PlanItem[] {
  return plans.filter(
    (p) => p.status === "active" || (archived && p.status === "archived"),
  );
}

export const hasArchived = (plans: readonly PlanItem[]): boolean =>
  plans.some((p) => p.status === "archived");

export const fieldsOf = (p: PlanItem): PlanFields => ({
  name: p.name,
  symbols: p.symbols,
  review_by: p.review_by,
});

export const NO_FIELDS: PlanFields = { name: "", symbols: [], review_by: null };
