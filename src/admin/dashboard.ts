// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { itemOf, json, problem } from "../api/http.ts";
import { round } from "../market/format.ts";
import { type Instrument, readInstrument } from "../market/instruments.ts";
import { ArgError, fields, MAX_SYMBOL } from "../operations/args.ts";
import { hasIntraday } from "../operations/intraday.ts";
import type { Markets } from "../operations/markets.ts";
import { crossing } from "../operations/movers.ts";
import { closeOn, readLatest, sessionOf } from "../operations/quote.ts";
import { resolveTargets } from "../operations/targets.ts";
import type { TrackState } from "../operations/track.ts";
import { ATTRIBUTION } from "../sources/fred/sync.ts";
import { FRED } from "../sources/ids.ts";
import type { Db } from "../storage/db/index.ts";
import { listRow, type Stored, storedRow } from "./http.ts";

export const OWNER = "operator";

export const MAX_SECTIONS = 20;
export const MAX_SECTION_SYMBOLS = 100;
export const MAX_DASHBOARD_SYMBOLS = 200;
export const MAX_SECTION_NAME = 40;
export const VIEWS = ["cards", "table"] as const;

type View = (typeof VIEWS)[number];

type Section = { name: string; view: View; ids: string[] };

export type LayoutArgs = {
  revision: number;
  sections: { name: string; view: View; symbols: string[] }[];
};

const PLURAL: Record<string, string> = {
  INDEX: "Indices",
  EQUITY: "Stocks",
  ETF: "ETFs",
  BOND: "Bonds",
  FUTURE: "Futures",
  CRYPTOCURRENCY: "Crypto",
  CURRENCY: "Currencies",
  MUTUALFUND: "Funds",
  SERIES: "Series",
};

const pluralOf = (type: string) =>
  PLURAL[type] ?? type.charAt(0) + type.slice(1).toLowerCase();

function stored(db: Db): { revision: number; sections: Section[] } | null {
  const head = db
    .query<{ revision: number }, [string]>(
      "select revision from dashboards where owner = ?",
    )
    .get(OWNER);
  if (head === null) return null;
  const sections = db
    .query<{ position: number; name: string; view: View }, [string]>(
      "select position, name, view from dashboard_sections where owner = ? order by position",
    )
    .all(OWNER);
  const items = db
    .query<{ section: number; instrument: string }, [string]>(
      "select section, instrument from dashboard_items where owner = ? order by section, position",
    )
    .all(OWNER);
  return {
    revision: head.revision,
    sections: sections.map((s) => ({
      name: s.name,
      view: s.view,
      ids: items
        .filter((i) => i.section === s.position)
        .map((i) => i.instrument),
    })),
  };
}

// in flag order, so the operator's own order is the page's
function seed(db: Db, track: readonly TrackState[]): Section[] {
  const sections: Section[] = [];
  const by = new Map<string, Section>();
  const seen = new Set<string>();
  for (const t of track) {
    if (t.id === null || seen.has(t.id)) continue;
    // past a save's limits the first edit could never be saved
    if (seen.size >= MAX_DASHBOARD_SYMBOLS) break;
    const i = readInstrument(db, t.id);
    if (i === null) continue;
    let s = by.get(i.type);
    if (s === undefined) {
      if (sections.length >= MAX_SECTIONS) continue;
      s = { name: pluralOf(i.type), view: "cards", ids: [] };
      by.set(i.type, s);
      sections.push(s);
    }
    if (s.ids.length >= MAX_SECTION_SYMBOLS) continue;
    seen.add(t.id);
    s.ids.push(t.id);
  }
  return sections;
}

function trackStates(db: Db, track: readonly TrackState[]) {
  return track.map((t) => ({
    value: t.value,
    state:
      t.id !== null && readInstrument(db, t.id) !== null
        ? "ready"
        : t.state === "pending"
          ? "pending"
          : "failed",
  }));
}

type Gap = { distance_pct: number | null; crossed_today?: boolean } | null;

const distance = (price: number, avg: number) =>
  avg > 0 ? round(100 * (price / avg - 1)) : null;

// read as movers reads them, so both answers agree
function averagesOf(
  m: Markets,
  i: Instrument,
  price: number | null,
  now: number,
) {
  const none = { daily_sma50: null, daily_sma200: null, weekly_sma200: null };
  if (i.source === FRED || price === null) return none;
  const latest = readLatest(m.db, i, now, m.quoteEveryMs);
  const rows = latest.signals?.daily;
  const live = rows?.live ?? null;
  const final = rows?.final ?? null;
  const close =
    live !== null && final !== null && final.date < live.date
      ? closeOn(m.db, i.id, "1d", final.date)
      : null;
  const daily = (key: "sma50" | "sma200"): Gap => {
    const avg = latest.daily?.row[key] ?? null;
    if (avg === null) return null;
    const then = final?.[key] ?? null;
    const crossed =
      latest.daily?.kind === "live" &&
      close !== null &&
      then !== null &&
      crossing(close, then, price, avg) !== null;
    return { distance_pct: distance(price, avg), crossed_today: crossed };
  };
  const weekly = latest.weekly?.row.sma200 ?? null;
  return {
    daily_sma50: daily("sma50"),
    daily_sma200: daily("sma200"),
    weekly_sma200:
      weekly === null ? null : { distance_pct: distance(price, weekly) },
  };
}

// a watchlist entry's fields, so every card draws from one shape
function item(
  m: Markets,
  row: ReturnType<typeof listRow>,
  s: Stored,
  now: number,
) {
  const i = readInstrument(m.db, s.id)!;
  return {
    id: s.id,
    instrument: row(s),
    session: sessionOf(m, i, now),
    intraday: hasIntraday(s),
    averages: averagesOf(m, i, s.price, now),
  };
}

// no read and no fetch: the page asks every minute
export function readDashboard(m: Markets, track: () => readonly TrackState[]) {
  const now = m.clock.now();
  const saved = stored(m.db);
  const sections = saved?.sections ?? seed(m.db, track());
  const row = listRow(m, now);
  let fred = false;
  const out = sections.map((s) => ({
    name: s.name,
    view: s.view,
    items: s.ids.flatMap((id) => {
      const st = storedRow(m.db, id);
      if (st === null) return [];
      if (st.source === FRED) fred = true;
      return [item(m, row, st, now)];
    }),
  }));
  return {
    ...(fred ? { attribution: ATTRIBUTION } : {}),
    revision: saved?.revision ?? 0,
    created: saved !== null,
    // a save while one is pending would leave it out for good
    ...(saved === null ? { track: trackStates(m.db, track()) } : {}),
    sections: out,
  };
}

export function parseLayout(body: unknown): LayoutArgs {
  const b = fields(body, ["revision", "sections"]);
  if (
    typeof b.revision !== "number" ||
    !Number.isSafeInteger(b.revision) ||
    b.revision < 0
  ) {
    throw new ArgError("revision is the whole number the dashboard answered");
  }
  if (!Array.isArray(b.sections) || b.sections.length > MAX_SECTIONS) {
    throw new ArgError(`sections is a list of at most ${MAX_SECTIONS}`);
  }
  const names = new Set<string>();
  let total = 0;
  const sections = b.sections.map((raw, k) => {
    const s = fields(raw, ["name", "view", "symbols"]);
    const at = `sections[${k}]`;
    const name = typeof s.name === "string" ? s.name.trim() : "";
    if (name === "" || name.length > MAX_SECTION_NAME) {
      throw new ArgError(`${at}.name is 1 to ${MAX_SECTION_NAME} characters`);
    }
    if (names.has(name.toLowerCase())) {
      throw new ArgError(`${at}.name is taken by another section`);
    }
    names.add(name.toLowerCase());
    if (!(VIEWS as readonly unknown[]).includes(s.view)) {
      throw new ArgError(`${at}.view is one of ${VIEWS.join(", ")}`);
    }
    if (!Array.isArray(s.symbols) || s.symbols.length > MAX_SECTION_SYMBOLS) {
      throw new ArgError(
        `${at}.symbols is a list of at most ${MAX_SECTION_SYMBOLS}`,
      );
    }
    const symbols = s.symbols.map((v, j) => {
      if (typeof v !== "string" || v.trim() === "" || v.length > MAX_SYMBOL) {
        throw new ArgError(
          `${at}.symbols[${j}] is a symbol of at most ${MAX_SYMBOL} characters`,
        );
      }
      return v.trim();
    });
    total += symbols.length;
    return { name, view: s.view as View, symbols };
  });
  if (total > MAX_DASHBOARD_SYMBOLS) {
    throw new ArgError(
      `the dashboard holds at most ${MAX_DASHBOARD_SYMBOLS} symbols`,
    );
  }
  return { revision: b.revision, sections };
}

const revisionOf = (db: Db) => stored(db)?.revision ?? 0;

const changed = (m: Markets, track: () => readonly TrackState[]) =>
  problem("conflict", "the dashboard changed since that revision", {
    dashboard: readDashboard(m, track),
  });

// resolved before the write, since a fetch never runs inside one
export async function saveDashboard(
  m: Markets,
  track: () => readonly TrackState[],
  args: LayoutArgs,
): Promise<Response> {
  if (args.revision !== revisionOf(m.db)) return changed(m, track);
  const inputs = [...new Set(args.sections.flatMap((s) => s.symbols))];
  // asking a stored card's source again would refuse a rename while it is off
  const idOf = new Map<string, string>();
  for (const input of inputs) {
    const id = input.includes(":") ? input.toUpperCase() : null;
    if (id !== null && readInstrument(m.db, id) !== null) idOf.set(input, id);
  }
  const targets = await resolveTargets(
    m,
    inputs.filter((i) => !idOf.has(i)),
  );
  const failed = targets.filter((t) => "error" in t);
  if (failed.length > 0) {
    return problem(
      "unresolved",
      "some symbols did not resolve; nothing was saved",
      {
        errors: failed.map((t) =>
          itemOf({ input: t.input, ...(t as { error: object }).error }),
        ),
      },
    );
  }
  for (const t of targets) {
    if ("instrument" in t) idOf.set(t.input, t.instrument.id);
  }
  const seen = new Set<string>();
  const sections: Section[] = args.sections.map((s) => ({
    name: s.name,
    view: s.view,
    ids: s.symbols.flatMap((input) => {
      const id = idOf.get(input)!;
      if (seen.has(id)) return [];
      seen.add(id);
      return [id];
    }),
  }));
  const saved = await m.writer.write((db) => {
    if (revisionOf(db) !== args.revision) return false;
    const now = m.clock.now();
    db.query(
      `insert into dashboards (owner, revision, updated_at) values (?1, ?2, ?3)
       on conflict (owner) do update set revision = ?2, updated_at = ?3`,
    ).run(OWNER, args.revision + 1, now);
    db.query("delete from dashboard_items where owner = ?").run(OWNER);
    db.query("delete from dashboard_sections where owner = ?").run(OWNER);
    const section = db.query(
      "insert into dashboard_sections (owner, position, name, view) values (?, ?, ?, ?)",
    );
    const add = db.query(
      "insert into dashboard_items (owner, section, position, instrument) values (?, ?, ?, ?)",
    );
    sections.forEach((s, k) => {
      section.run(OWNER, k, s.name, s.view);
      // one deleted since it resolved has no card to keep
      s.ids
        .filter((id) => readInstrument(db, id) !== null)
        .forEach((id, j) => {
          add.run(OWNER, k, j, id);
        });
    });
    return true;
  });
  if (!saved) return changed(m, track);
  return json(readDashboard(m, track));
}
