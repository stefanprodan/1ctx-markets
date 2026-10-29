// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Listed, Spark, WatchEntry } from "../data/store.ts";
import { closes, figure } from "./Chart.model.ts";
import { change, kindOf, price, symbolOf } from "./Instruments.model.ts";

export type Group = { kind: string | null; entries: WatchEntry[] };

// a value with no kind yet stays beside its neighbours in the flag
export function groupsOf(entries: readonly WatchEntry[]): Group[] {
  const kinds = entries.map((e) =>
    e.instrument === null ? null : kindOf(e.instrument.kind),
  );
  const first = kinds.find((k) => k !== null) ?? null;
  let last: string | null = null;
  const groups: Group[] = [];
  const at = new Map<string | null, Group>();
  entries.forEach((e, i) => {
    last = kinds[i] ?? last;
    const kind = last ?? first;
    let g = at.get(kind);
    if (g === undefined) {
      g = { kind, entries: [] };
      at.set(kind, g);
      groups.push(g);
    }
    g.entries.push(e);
  });
  return groups;
}

type Dir = -1 | 0 | 1;

export type Card =
  | {
      type: "ready";
      href: string;
      name: string;
      symbol: string;
      price: string;
      // in its unit (a yield in points), then in percent
      move: string;
      percent: string;
      dir: Dir;
      state: string;
    }
  | { type: "pending"; value: string }
  // a stored row keeps its link and price beside the failure
  | {
      type: "failed";
      value: string;
      text: string;
      href?: string;
      price?: string;
    };

const points = (row: Listed) =>
  row.unit === "percent" || row.unit === "percent_of_par";

// the day's change in the price's own unit, signed as the percent is
export function moveOf(row: Listed): { text: string; dir: Dir } {
  if (row.change === null) return { text: "", dir: 0 };
  const n = figure(Math.abs(row.change));
  const dir: Dir =
    Number(n.replaceAll(",", "")) === 0 ? 0 : row.change > 0 ? 1 : -1;
  const unit = points(row) ? " pts" : row.currency ? ` ${row.currency}` : "";
  return { text: `${dir > 0 ? "+" : dir < 0 ? "−" : ""}${n}${unit}`, dir };
}

// a typo or an ambiguous value is not found; a source failure may pass
const MISSING = new Set(["not_found", "candidates", "no_data"]);

const hrefOf = (id: string) => `/instruments/${encodeURIComponent(id)}`;

export function cardOf(e: WatchEntry): Card {
  const row = e.instrument;
  if (e.state !== "tracked" && e.state !== "pending") {
    return {
      type: "failed",
      value: e.value,
      text: MISSING.has(e.state) ? "Not found" : "Not available",
      ...(row !== null && e.id !== null
        ? { href: hrefOf(e.id), price: price(row) }
        : {}),
    };
  }
  if (row === null || e.id === null) {
    return { type: "pending", value: e.value };
  }
  const pct = change(row);
  const move = moveOf(row);
  return {
    type: "ready",
    href: hrefOf(e.id),
    name: row.name ?? symbolOf(e.id),
    symbol: symbolOf(e.id),
    price: price(row),
    move: move.text,
    percent: pct.text,
    dir: pct.text === "" ? move.dir : pct.dir,
    state:
      e.session === null ? "" : e.session.state === "open" ? "Open" : "Closed",
  };
}

// by instrument id, escaped for XML, so a reorder keeps each card's own
export function clipIds(
  entries: readonly WatchEntry[],
): Map<WatchEntry, string> {
  const seen = new Map<string, number>();
  const out = new Map<WatchEntry, string>();
  for (const e of entries) {
    const base = `spark-${(e.id ?? e.value).replace(
      /[^A-Za-z0-9]/g,
      (c) => `_${c.codePointAt(0)!.toString(16)}_`,
    )}`;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    out.set(e, n === 1 ? base : `${base}-${n}`);
  }
  return out;
}

export const SPARK_W = 120;
export const SPARK_H = 36;
// room for the stroke at the top and bottom
const PAD = 2;

export type Line = {
  points: string;
  base: number | null;
  tone: "up" | "down";
};

const round = (n: number) => Math.round(n * 100) / 100;

function geometry(
  values: readonly { t: number; v: number }[],
  ref: number,
  span: [number, number],
  split: boolean,
): Line {
  const all = [...values.map((p) => p.v), ref];
  const lo = Math.min(...all);
  const hi = Math.max(...all);
  const y = (v: number) =>
    hi === lo
      ? SPARK_H / 2
      : round(SPARK_H - PAD - ((v - lo) / (hi - lo)) * (SPARK_H - 2 * PAD));
  const [t0, t1] = span;
  const x = (t: number) =>
    t1 === t0 ? 0 : round(((t - t0) / (t1 - t0)) * SPARK_W);
  const xy = values.map((p) => `${x(p.t)},${y(p.v)}`);
  // one point is a dot
  if (xy.length === 1) xy.push(xy[0]!);
  return {
    points: xy.join(" "),
    base: split ? y(ref) : null,
    tone: values.at(-1)!.v >= ref ? "up" : "down",
  };
}

// a day across its whole session, so a morning fills only the morning
export function sparkOf(s: Spark | undefined): Line | null {
  if (s === undefined) return null;
  if (s.interval === "5m") {
    const values = s.points.map((p) => ({ t: Date.parse(p.at), v: p.close }));
    const a = values[0];
    const b = values.at(-1);
    if (a === undefined || b === undefined) return null;
    const start = Date.parse(s.session?.start ?? "");
    const end = Date.parse(s.session?.end ?? "");
    const whole = start <= a.t && b.t <= end && start < end;
    return geometry(
      values,
      s.previous_close ?? a.v,
      whole ? [start, end] : [a.t, b.t],
      true,
    );
  }
  const values = closes(s.bars).map((c) => ({
    t: Date.parse(c.time),
    v: c.value,
  }));
  const a = values[0];
  const b = values.at(-1);
  if (a === undefined || b === undefined) return null;
  return geometry(values, a.v, [a.t, b.t], false);
}
