// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { PositionChange } from "../data/portfolios.ts";
import { day } from "../lib/format.ts";
import { typed } from "./Portfolios.model.ts";

// a row of a position's chain as /positions/{id}/history answers it
export type ChainRow = {
  id: number;
  name: string | null;
  currency: string;
  amount: number | null;
  as_of: string | null;
  dry_powder?: boolean;
  broker: string | null;
  note: string | null;
  maturity?: string | null;
  replaces: number | null;
  // a balance dated before its row's day, beside the chain, never in it
  past?: boolean;
  entered_at: string;
  removed_at: string | null;
};

export type HistoryLine = {
  key: string;
  date: string;
  amount: number | null;
  currency: string;
  // from the line before, in the same currency; none across currencies
  change: number | null;
  // what an update changed besides the amount, or Removed and Restored
  what: string | null;
  // a removal or a restore: no balance of its own
  event: boolean;
};

// an instant's day on the owner's calendar, not UTC's
export function dayIn(iso: string, zone: string | null): string {
  try {
    return new Date(iso).toLocaleDateString("en-CA", {
      timeZone: zone ?? undefined,
    });
  } catch {
    return iso.slice(0, 10);
  }
}

function changedWords(a: ChainRow, b: ChainRow): string[] {
  const out: string[] = [];
  if (a.name !== b.name) out.push(`Renamed to ${b.name}`);
  if (a.broker !== b.broker)
    out.push(b.broker ? `Moved to ${b.broker}` : "Broker taken off");
  if ((a.dry_powder ?? false) !== (b.dry_powder ?? false))
    out.push(b.dry_powder ? "Moved to dry powder" : "Moved to reserve");
  if ((a.maturity ?? null) !== (b.maturity ?? null))
    out.push(b.maturity ? "Maturity set" : "Maturity taken off");
  if (a.currency !== b.currency) out.push(`Now in ${b.currency}`);
  return out;
}

const byEntry = (rows: readonly ChainRow[]) =>
  [...rows].sort(
    (a, b) => a.entered_at.localeCompare(b.entered_at) || a.id - b.id,
  );

// an update and the row it replaces share one instant: its removal is
// the new row's entry. Any other removal set the row aside for a restore,
// or took it off by hand when no row was live just after
export function endOf(
  r: ChainRow,
  rows: readonly ChainRow[],
): "replaced" | { restored: ChainRow } | "removed" | null {
  const t = r.removed_at;
  if (t === null) return null;
  if (rows.some((c) => c.replaces === r.id && c.entered_at === t)) {
    return "replaced";
  }
  // a row restored since shows as live then too: the newest one was
  const back = rows.findLast(
    (x) =>
      x.id !== r.id &&
      x.entered_at <= t &&
      (x.removed_at === null || x.removed_at > t),
  );
  return back ? { restored: back } : "removed";
}

// the rows that stand: the live one (or the last taken off) back to the
// first through replaces; a row off it was undone by a restore
export function kept(entries: readonly ChainRow[]): Set<number> {
  const chain = entries.filter((r) => !r.past);
  const byId = new Map(chain.map((r) => [r.id, r]));
  const tip =
    chain.find((r) => r.removed_at === null) ??
    [...chain].sort((a, b) =>
      (b.removed_at ?? "").localeCompare(a.removed_at ?? ""),
    )[0];
  const out = new Set<number>();
  for (
    let r: ChainRow | undefined = tip;
    r;
    r = r.replaces ? byId.get(r.replaces) : undefined
  ) {
    out.add(r.id);
  }
  return out;
}

// newest day first, the later entry first on a day: each update a line
// with its change from the row it replaced, a removal and a restore lines
// of their own, a past balance at its day
export function historyLines(
  chain: readonly ChainRow[],
  zone: string | null = null,
): HistoryLine[] {
  const rows = byEntry(chain.filter((r) => !r.past));
  const byId = new Map(rows.map((r) => [r.id, r]));
  const when = (iso: string) => dayIn(iso, zone);
  const out: { at: string; line: HistoryLine }[] = [];
  for (const r of chain) {
    if (!r.past) continue;
    out.push({
      at: r.entered_at,
      line: {
        key: `${r.id}`,
        date: r.as_of ?? when(r.entered_at),
        amount: r.amount,
        currency: r.currency,
        change: null,
        what: "Past balance",
        event: false,
      },
    });
    if (r.removed_at !== null) {
      out.push({
        at: r.removed_at,
        line: {
          key: `${r.id}/removed`,
          date: when(r.removed_at),
          amount: null,
          currency: r.currency,
          change: null,
          what: "Past balance removed",
          event: true,
        },
      });
    }
  }
  for (const r of rows) {
    const date = r.as_of ?? when(r.entered_at);
    const prev = r.replaces ? byId.get(r.replaces) : undefined;
    if (prev === undefined) {
      out.push({
        at: r.entered_at,
        line: {
          key: `${r.id}`,
          date,
          amount: r.amount,
          currency: r.currency,
          change: null,
          what: "Added",
          event: false,
        },
      });
    } else {
      const change =
        prev.currency === r.currency &&
        r.amount !== null &&
        prev.amount !== null
          ? r.amount - prev.amount
          : null;
      const words = changedWords(prev, r);
      // the words only: a note runs to paragraphs, and Edit details holds it
      if (r.note !== prev.note) {
        words.push(r.note === null ? "Note taken off" : "Note changed");
      }
      if (change === 0 && words.length === 0 && r.as_of !== prev.as_of) {
        words.push("Date changed");
      }
      out.push({
        at: r.entered_at,
        line: {
          key: `${r.id}`,
          // an update that left the balance and its day alone is dated when made
          date:
            change === 0 && r.as_of === prev.as_of ? when(r.entered_at) : date,
          amount: r.amount,
          currency: r.currency,
          change: change === 0 ? null : change,
          what: words.length > 0 ? words.join(" · ") : null,
          event: false,
        },
      });
    }
    const end = endOf(r, rows);
    if (end === null || end === "replaced") continue;
    const at = r.removed_at!;
    if (end === "removed") {
      out.push({
        at,
        line: {
          key: `${r.id}/removed`,
          date: when(at),
          amount: null,
          currency: r.currency,
          change: null,
          what: "Removed",
          event: true,
        },
      });
      continue;
    }
    const back = end.restored;
    out.push({
      at,
      line: {
        key: `${r.id}/restored`,
        date: when(at),
        amount: back.amount,
        currency: back.currency,
        change:
          back.currency === r.currency &&
          back.amount !== null &&
          r.amount !== null &&
          back.amount !== r.amount
            ? back.amount - r.amount
            : null,
        what: "Restored",
        event: false,
      },
    });
  }
  return out
    .sort(
      (a, b) =>
        a.line.date.localeCompare(b.line.date) || a.at.localeCompare(b.at),
    )
    .map((x) => x.line)
    .reverse();
}

export type Step = { date: string; amount: number };

// the balance after each day's last entry over the rows that stand and
// the live past balances, oldest first, in its one currency: a chain that
// changed currency draws from the change on
export function steps(
  chain: readonly ChainRow[],
  zone: string | null = null,
): Step[] {
  const stands = kept(chain);
  const rows = byEntry(chain).filter((r) =>
    r.past ? r.removed_at === null : stands.has(r.id),
  );
  const ccy = rows.findLast((r) => !r.past)?.currency;
  const byDay = new Map<string, number>();
  for (const r of rows) {
    if (r.past && r.currency !== ccy) continue;
    if (r.currency !== ccy) {
      byDay.clear();
      continue;
    }
    if (r.amount === null) continue;
    byDay.set(r.as_of ?? dayIn(r.entered_at, zone), r.amount);
  }
  return [...byDay.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, amount]) => ({ date, amount }));
}

const DAY = 86_400_000;
const dayMs = (d: string) => Date.parse(`${d}T00:00:00Z`);

// a step line and its area in a w×h box, held flat to today
export function stepPath(
  s: readonly Step[],
  today: string,
  w: number,
  h: number,
): { line: string; area: string } | null {
  if (s.length < 2) return null;
  const t0 = dayMs(s[0]!.date);
  const t1 = Math.max(dayMs(today), dayMs(s.at(-1)!.date) + DAY);
  // the balance's own range, never tighter than a fifth of the balance,
  // so a small change reads as a small step and a large one as a fall
  const min = Math.min(...s.map((p) => p.amount));
  const max = Math.max(...s.map((p) => p.amount));
  const floor = Math.max(Math.abs(max), Math.abs(min)) * 0.2 || 1;
  const pad = Math.max(0, floor - (max - min)) / 2;
  const lo = min - pad;
  const span = max + pad - lo;
  // a few px clear of the box's top and bottom, so the stroke is never cut
  const inset = 4;
  const y = (v: number) => h - inset - ((v - lo) / span) * (h - 2 * inset);
  const x = (d: string) => ((dayMs(d) - t0) / (t1 - t0)) * w;
  let line = `M0,${y(s[0]!.amount).toFixed(1)}`;
  for (const p of s.slice(1)) {
    line += `H${x(p.date).toFixed(1)}V${y(p.amount).toFixed(1)}`;
  }
  line += `H${w}`;
  return { line, area: `${line}V${h}H0Z` };
}

// the box: a balance sets it, a signed change moves it; nothing to save
// for an empty box or the balance it already holds
export function balanceChange(
  text: string,
  current: number | null,
):
  | { change: Pick<PositionChange, "amount" | "by"> }
  | { none: true }
  | { error: string } {
  const t = text.trim().replace(/^−/, "-");
  if (t === "") return { none: true };
  const sign = t[0] === "+" ? 1 : t[0] === "-" ? -1 : 0;
  const n = figure(sign === 0 ? t : t.slice(1));
  if (n === null || Number.isNaN(n)) return { error: "Not a number." };
  if (sign !== 0)
    return n === 0 ? { none: true } : { change: { by: sign * n } };
  return n === current ? { none: true } : { change: { amount: n } };
}

// 12,400 is twelve thousand, never twelve point four, as the head writes it
const figure = (body: string): number | null =>
  typed(
    /^\d{1,3}(,\d{3})+(\.\d+)?$/.test(body) ? body.replaceAll(",", "") : body,
  );

// a past balance: a day before the row's own and the balance it held then
export function pastBalance(
  date: string,
  text: string,
  rowDay: string | null,
):
  | { change: Required<Pick<PositionChange, "amount" | "date">> }
  | { error: string } {
  if (date === "") return { error: "Pick a day." };
  if (rowDay !== null && date >= rowDay) {
    return { error: `Pick a day before ${day(rowDay)}.` };
  }
  const n = figure(text.trim());
  if (n === null) return { error: "Give the balance." };
  if (Number.isNaN(n)) return { error: "Not a number." };
  return { change: { amount: n, date } };
}
