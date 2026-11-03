// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { symbolHref } from "../app/paths.ts";
import type {
  Board,
  BoardItem,
  BoardSection,
  Earning,
  Extended,
  Gap,
  Listed,
  Saved,
  Spark,
  View,
  WatchEntry,
} from "../data/store.ts";
import {
  change,
  figure,
  price,
  priceParts,
  type Signed,
} from "../lib/format.ts";
import { nameOf, symbolOf, tickerOf } from "../lib/names.ts";
import { closes, sessionSlots } from "./Chart.model.ts";

// the server's limits, so an edit past one is never sent
export const MAX_SECTIONS = 20;
export const MAX_SECTION_SYMBOLS = 100;
export const MAX_SYMBOLS = 200;
export const MAX_NAME = 40;
export const FIRST = "Favourites";

export const entryOf = (id: string, item: BoardItem | undefined): WatchEntry =>
  item === undefined
    ? {
        value: symbolOf(id),
        id,
        state: "pending",
        instrument: null,
        session: null,
        intraday: false,
      }
    : {
        value: symbolOf(id),
        id,
        state: "tracked",
        instrument: item.instrument,
        session: item.session,
        intraday: item.intraday,
      };

export const idsOf = (layout: readonly BoardSection[]): string[] => [
  ...new Set(layout.flatMap((s) => s.ids)),
];

export const SHOWN_MOVERS = 4;

// the list is tight, so a company drops its legal suffix
const SUFFIX =
  /,?\s+(Inc\.?|Corporation|Corp\.?|Company Limited|Limited|Ltd\.?|plc|N\.V\.|S\.A\.|AG|SE|UCITS ETF.*|Holdings?)$/i;
export function shortName(r: Listed): string {
  if (r.name === null || r.kind === "BOND") return symbolOf(r.id);
  let n = r.name;
  for (let i = 0; i < 3; i++) n = n.replace(SUFFIX, "");
  return n;
}

// a move that rounds to nothing is no move
export function moversOf(
  ids: readonly string[],
  items: ReadonlyMap<string, BoardItem>,
): { up: Listed[]; down: Listed[]; top: number } {
  const moved = ids
    .map((id) => items.get(id)?.instrument)
    .filter(
      (r): r is Listed =>
        r !== undefined &&
        r.change_percent !== null &&
        Math.abs(r.change_percent) >= 0.005,
    );
  const pct = (r: Listed) => r.change_percent!;
  return {
    up: moved
      .filter((r) => pct(r) > 0)
      .sort((a, b) => pct(b) - pct(a))
      .slice(0, SHOWN_MOVERS),
    down: moved
      .filter((r) => pct(r) < 0)
      .sort((a, b) => pct(a) - pct(b))
      .slice(0, SHOWN_MOVERS),
    top: Math.max(...moved.map((r) => Math.abs(pct(r))), 1),
  };
}

// what is bought: an index, a yield, a rate or a bond has no dip to buy
const TRADED = new Set(["EQUITY", "ETF", "CRYPTOCURRENCY"]);

export type Side = { gap: number; crossed: boolean };
export type Trend = {
  id: string;
  name: string | null;
  price: number;
  sma50: Side | null;
  sma200: Side | null;
  wma200: Side | null;
};

const sideOf = (g: Gap | null): Side | null =>
  g === null || g.distance_pct === null
    ? null
    : { gap: g.distance_pct, crossed: g.crossed_today === true };

export function trendsOf(
  ids: readonly string[],
  items: ReadonlyMap<string, BoardItem>,
): Trend[] {
  return ids.flatMap((id) => {
    const i = items.get(id);
    if (i === undefined || i.instrument.price === null) return [];
    if (!TRADED.has(i.instrument.kind)) return [];
    const t: Trend = {
      id,
      name: i.instrument.name,
      price: i.instrument.price,
      sma50: sideOf(i.averages.daily_sma50),
      sma200: sideOf(i.averages.daily_sma200),
      // the server says no weekly crossing, so it never counts as today's
      wma200: sideOf(i.averages.weekly_sma200),
    };
    return t.sma50 === null && t.sma200 === null && t.wma200 === null
      ? []
      : [t];
  });
}

export const crossedToday = (t: Trend): boolean =>
  (t.sma50?.crossed ?? false) || (t.sma200?.crossed ?? false);

export type SortKey = "sma50" | "sma200" | "wma200";
export type Sort = { key: SortKey; dir: 1 | -1 };
// the dips first: the deepest under its 50SMA leads
export const DEFAULT_SORT: Sort = { key: "sma50", dir: 1 };
export const SORT_KEYS: readonly SortKey[] = ["sma50", "sma200", "wma200"];

export const isSort = (v: unknown): v is Sort =>
  typeof v === "object" &&
  v !== null &&
  SORT_KEYS.includes((v as Sort).key) &&
  ((v as Sort).dir === 1 || (v as Sort).dir === -1);

// a missing average sorts last either way
export const bySort = (s: Sort) => (a: Trend, b: Trend) => {
  const x = a[s.key]?.gap;
  const y = b[s.key]?.gap;
  if (x === undefined) return y === undefined ? 0 : 1;
  if (y === undefined) return -1;
  return (x - y) * s.dir;
};

// two decimals near the line, where the second one matters
export function gapText(gap: number): string {
  const a = Math.abs(gap);
  return `${gap >= 0 ? "+" : "−"}${a.toFixed(a < 1 ? 2 : 1)}%`;
}

export const priceText = (v: number): string =>
  v.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: Math.abs(v) >= 10 ? 2 : 3,
  });

export const HOUR: Record<string, string> = {
  bmo: "Before open",
  amc: "After close",
  dmh: "During day",
};

export function money(v: number | null): string {
  if (v === null) return "—";
  const a = Math.abs(v);
  if (a >= 1e12) return `${(v / 1e12).toFixed(2)}T`;
  if (a >= 1e9) return `${(v / 1e9).toFixed(1)}B`;
  if (a >= 1e6) return `${(v / 1e6).toFixed(0)}M`;
  return v.toLocaleString("en-US");
}

const plusDay = (date: string) =>
  new Date(Date.parse(`${date}T12:00:00Z`) + 86_400_000)
    .toISOString()
    .slice(0, 10);

export function dayText(date: string, today: string): string {
  if (date === today) return "Today";
  if (date === plusDay(today)) return "Tomorrow";
  return new Date(`${date}T12:00:00Z`).toLocaleDateString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });
}

export type EarningRow = {
  id: string;
  name: string | null;
  day: string;
  today: boolean;
  symbol: string;
  time: string;
  eps: string;
  revenue: string;
};

export const earningRows = (
  list: readonly Earning[],
  today: string,
): EarningRow[] =>
  list.map((e) => ({
    id: e.id,
    name: e.name,
    day: dayText(e.date, today),
    today: e.date === today,
    symbol: symbolOf(e.id),
    time: HOUR[e.hour ?? ""] ?? "—",
    eps: e.eps_estimate === null ? "—" : e.eps_estimate.toFixed(2),
    revenue: money(e.revenue_estimate),
  }));

const copy = (layout: readonly BoardSection[]) =>
  layout.map((s) => ({ ...s, ids: [...s.ids] }));

const total = (layout: readonly BoardSection[]) =>
  layout.reduce((n, s) => n + s.ids.length, 0);

export function addRefusal(
  layout: readonly BoardSection[],
  section: number,
  id: string,
): string | null {
  if (layout.some((s) => s.ids.includes(id)))
    return "Already on your dashboard.";
  if (total(layout) >= MAX_SYMBOLS) return "Your dashboard is full.";
  if (layout.length === 0) return null;
  const s = layout[section];
  if (s === undefined) return "That section is gone.";
  if (s.ids.length >= MAX_SECTION_SYMBOLS) return "This section is full.";
  return null;
}

export function addTo(
  layout: readonly BoardSection[],
  section: number,
  id: string,
): BoardSection[] | null {
  if (addRefusal(layout, section, id) !== null) return null;
  if (layout.length === 0) return [{ name: FIRST, view: "cards", ids: [id] }];
  const next = copy(layout);
  next[section]!.ids.push(id);
  return next;
}

export const removeFrom = (
  layout: readonly BoardSection[],
  section: number,
  id: string,
): BoardSection[] =>
  layout.map((s, i) =>
    i === section ? { ...s, ids: s.ids.filter((x) => x !== id) } : s,
  );

export function moveTo(
  layout: readonly BoardSection[],
  from: number,
  id: string,
  to: number,
  before: string | null,
): BoardSection[] | null {
  const source = layout[from];
  const target0 = layout[to];
  // a refresh between the drag and the drop can take either away
  if (source === undefined || target0 === undefined) return null;
  if (before === id || !source.ids.includes(id)) return null;
  if (from !== to && target0.ids.length >= MAX_SECTION_SYMBOLS) return null;
  const next = copy(layout);
  next[from]!.ids = next[from]!.ids.filter((x) => x !== id);
  const target = next[to]!.ids.filter((x) => x !== id);
  const at = before === null ? -1 : target.indexOf(before);
  if (at < 0) target.push(id);
  else target.splice(at, 0, id);
  next[to]!.ids = target;
  return JSON.stringify(next) === JSON.stringify(layout) ? null : next;
}

export function swap(
  layout: readonly BoardSection[],
  a: number,
  b: number,
): BoardSection[] {
  const next = [...layout];
  [next[a], next[b]] = [next[b]!, next[a]!];
  return next;
}

export const withView = (
  layout: readonly BoardSection[],
  section: number,
  view: View,
): BoardSection[] => layout.map((s, i) => (i === section ? { ...s, view } : s));

export const dropSection = (
  layout: readonly BoardSection[],
  section: number,
): BoardSection[] => layout.filter((_, i) => i !== section);

const taken = (layout: readonly BoardSection[], name: string, except: number) =>
  layout.some(
    (s, i) => i !== except && s.name.toLowerCase() === name.toLowerCase(),
  );

export function addSection(
  layout: readonly BoardSection[],
): BoardSection[] | null {
  if (layout.length >= MAX_SECTIONS) return null;
  let n = layout.length + 1;
  while (taken(layout, `Section ${n}`, -1)) n++;
  return [...layout, { name: `Section ${n}`, view: "cards", ids: [] }];
}

export function nameError(
  layout: readonly BoardSection[],
  section: number,
  name: string,
): string | null {
  const n = name.trim();
  if (n === "") return "Give it a name.";
  if (n.length > MAX_NAME) return `At most ${MAX_NAME} characters.`;
  if (taken(layout, n, section)) return "Another section has this name.";
  return null;
}

export function rename(
  layout: readonly BoardSection[],
  section: number,
  name: string,
): BoardSection[] | null {
  const n = name.trim();
  if (layout[section]?.name === n) return null;
  if (nameError(layout, section, n) !== null) return null;
  return layout.map((s, i) => (i === section ? { ...s, name: n } : s));
}

// the saved layout stays as it was until Save
export const draftOf = (layout: readonly BoardSection[]): BoardSection[] =>
  copy(layout);

export const savedDraft = (
  draft: readonly BoardSection[],
  layout: readonly BoardSection[],
): BoardSection[] | null =>
  JSON.stringify(draft) === JSON.stringify(layout) ? null : [...draft];

// the layout and revision the draft was copied from, so Save compares
// against what was edited and a save made since is a conflict
export type Editing = {
  draft: BoardSection[];
  base: readonly BoardSection[];
  revision: number;
};

export const editOf = (
  layout: readonly BoardSection[],
  revision: number,
): Editing => ({ draft: draftOf(layout), base: draftOf(layout), revision });

export const saveOf = (
  e: Editing,
): { next: BoardSection[]; revision: number } | null => {
  const next = savedDraft(e.draft, e.base);
  return next === null ? null : { next, revision: e.revision };
};

// only the edit saved ends: one begun after a Cancel during the save stays,
// and a failure other than a conflict keeps it to try again
export const afterSave = (
  cur: Editing | null,
  saved: Editing,
  end: Saved,
): Editing | null => (end === "failed" || cur !== saved ? cur : null);

export function renameOf(
  layout: readonly BoardSection[],
  section: number,
  name: string,
): { next: BoardSection[] } | { error: string } | null {
  if (layout[section]?.name === name.trim()) return null;
  const error = nameError(layout, section, name);
  if (error !== null) return { error };
  return { next: rename(layout, section, name)! };
}

// still fetched for the seed, so an edit would leave it out for good
export const waiting = (track: Board["track"] | null): boolean =>
  track?.some((t) => t.state === "pending") ?? false;

type Dir = -1 | 0 | 1;

export type Card =
  | {
      type: "ready";
      href: string;
      name: string;
      symbol: string;
      // the figure, its currency apart (none for a yield in percent)
      price: string;
      currency: string | null;
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

export function cardOf(e: WatchEntry): Card {
  const row = e.instrument;
  if (e.state !== "tracked" && e.state !== "pending") {
    return {
      type: "failed",
      value: e.value,
      text: MISSING.has(e.state) ? "Not found" : "Not available",
      ...(row !== null && e.id !== null
        ? { href: symbolHref(e.id), price: price(row) }
        : {}),
    };
  }
  if (row === null || e.id === null) {
    return { type: "pending", value: e.value };
  }
  const pct = change(row);
  const move = moveOf(row);
  const p = priceParts(row);
  return {
    type: "ready",
    href: symbolHref(e.id),
    name: nameOf(row.name, row.kind, e.id),
    symbol: tickerOf(e.id, row.kind),
    price: p.value,
    currency: p.currency,
    move: move.text,
    percent: pct.text,
    dir: pct.text === "" ? move.dir : pct.dir,
    state:
      e.session === null ? "" : e.session.state === "open" ? "Open" : "Closed",
  };
}

// a day split at its previous close; a month from its first close
const SLOT_S = 300;

// a day across its whole session, so a morning fills only the morning
export function sparkOf(
  s: Spark | undefined,
): { closes: number[]; base: "start" | number; slots?: number } | null {
  if (s === undefined) return null;
  if (s.interval === "5m") {
    const c = s.points.map((p) => p.close);
    if (c.length === 0) return null;
    const base = s.previous_close ?? c[0]!;
    const times = s.points.map((p) => Date.parse(p.at) / 1000);
    const start = Date.parse(s.session?.start ?? "") / 1000;
    // the slots count from the session's start, so a gap before the
    // first close would shift the line: then it spans what it has
    if (!(times[0]! - start < SLOT_S)) return { closes: c, base };
    const rest = sessionSlots(times, s.session).length;
    return rest === 0
      ? { closes: c, base }
      : { closes: c, base, slots: c.length + rest };
  }
  const c = closes(s.bars).map((x) => x.value);
  return c.length === 0 ? null : { closes: c, base: "start" };
}

// a tile alone on the last row looks stranded: one fewer or more to a
// row, down to one, keeps it company
export function tileColumns(n: number, most: number): number {
  for (const c of [most, most - 1, most + 1]) {
    if (c >= 1 && (n <= c || n % c !== 1)) return c;
  }
  return most;
}

export type ExtMove = {
  session: "pre" | "post";
  change: Signed;
  title: string;
};

const CLOCK = new Intl.DateTimeFormat("en-GB", {
  hour: "2-digit",
  minute: "2-digit",
});
const WEEKDAY = new Intl.DateTimeFormat("en-GB", { weekday: "short" });

// a trade from another day names it, so a weekend's move shows its age
export function extMove(
  x: Extended | undefined,
  row: Listed | null,
  now: number,
): ExtMove | null {
  if (x === undefined || x.price === null || x.change_percent === null) {
    return null;
  }
  const at = new Date(x.time);
  const time = CLOCK.format(at);
  const when =
    at.toDateString() === new Date(now).toDateString()
      ? time
      : `${WEEKDAY.format(at)} ${time}`;
  const word = x.session === "pre" ? "Pre-market" : "After hours";
  const value =
    row === null
      ? figure(x.price)
      : price({ price: x.price, unit: row.unit, currency: row.currency });
  return {
    session: x.session,
    change: change(x),
    title: `${word} ${value} · ${when}`,
  };
}
