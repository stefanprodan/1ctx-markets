// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// A cash account's balance on a day, from its chain's rows and the past
// balances entered on them (entriesOf); pure, so a series is a loop.

import type { Position } from "./store.ts";

export type Entry = Pick<
  Position,
  "id" | "asOf" | "amount" | "enteredAt" | "replaces" | "pastOf" | "removedAt"
>;

// the chain rows that stand: the live one, or the last taken off, back to
// the first through replaces; a row off that path was undone by a restore
export function standing<E extends Entry>(entries: readonly E[]): Set<number> {
  const rows = entries.filter((r) => r.pastOf === null);
  const byId = new Map(rows.map((r) => [r.id, r]));
  const tip =
    rows.find((r) => r.removedAt === null) ??
    [...rows].sort((a, b) => (b.removedAt ?? 0) - (a.removedAt ?? 0))[0];
  const out = new Set<number>();
  for (
    let r: E | undefined = tip;
    r;
    r = r.replaces === null ? undefined : byId.get(r.replaces)
  ) {
    out.add(r.id);
  }
  return out;
}

// what a balance is read from: the rows that stand and the live past
// balances; a wrong update set back by a restore never counts
export function counted<E extends Entry>(entries: readonly E[]): E[] {
  const stands = standing(entries);
  return entries.filter((e) =>
    e.pastOf === null ? stands.has(e.id) : e.removedAt === null,
  );
}

// the entry holding the balance on a day: the latest dated on or before
// it, the one entered last on a tie; none before the first
export function balanceOn<E extends Entry>(
  entries: readonly E[],
  day: string,
): E | null {
  let best: E | null = null;
  for (const e of entries) {
    if (e.asOf > day) continue;
    if (
      best === null ||
      e.asOf > best.asOf ||
      (e.asOf === best.asOf &&
        (e.enteredAt > best.enteredAt ||
          (e.enteredAt === best.enteredAt && e.id > best.id)))
    ) {
      best = e;
    }
  }
  return best;
}
