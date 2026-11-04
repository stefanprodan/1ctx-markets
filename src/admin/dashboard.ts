// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { itemOf, json, problem } from "../api/http.ts";
import { readSession } from "../market/calendars.ts";
import { round } from "../market/format.ts";
import { type Instrument, readInstrument } from "../market/instruments.ts";
import { readQuote } from "../market/quotes.ts";
import { HOME_PER_GROUP } from "../market/world.ts";
import { ArgError, fields, MAX_SYMBOL } from "../operations/args.ts";
import { hasIntraday } from "../operations/intraday.ts";
import type { Markets } from "../operations/markets.ts";
import { crossing } from "../operations/movers.ts";
import { closeOn, readLatest, sessionOf } from "../operations/quote.ts";
import { resolveTargets } from "../operations/targets.ts";
import type { World } from "../operations/track.ts";
import { MINUTE_MS } from "../runtime/clock.ts";
import { recheck } from "../server/caller.ts";
import { ATTRIBUTION } from "../sources/fred/sync.ts";
import { FRED } from "../sources/ids.ts";
import type { Db } from "../storage/db/index.ts";
import { listRow, type Stored, storedRow } from "./http.ts";

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

function stored(
  db: Db,
  owner: string,
): { revision: number; sections: Section[] } | null {
  const head = db
    .query<{ revision: number }, [string]>(
      "select revision from dashboards where owner = ?",
    )
    .get(owner);
  if (head === null) return null;
  const sections = db
    .query<{ position: number; name: string; view: View }, [string]>(
      "select position, name, view from dashboard_sections where owner = ? order by position",
    )
    .all(owner);
  const items = db
    .query<{ section: number; instrument: string }, [string]>(
      "select section, instrument from dashboard_items where owner = ? order by section, position",
    )
    .all(owner);
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

type Seeded = { value: string; id: string | null; state: "ready" | "pending" };

// a source's pause passes; any other failure may last until a new build,
// so it must not hold Home waiting
const HOLDS = new Set<string>([
  "pending",
  "tracked",
  "rate_limited",
  "timeout",
]);

// each group's first entries that did not fail, so a failed one lets the
// next move up; one resolving, or waiting out a pause, keeps its place
function home(db: Db, world: World): { name: string; picks: Seeded[] }[] {
  const status = new Map(world.status().map((t) => [t.value, t]));
  const groups = new Map<string, Seeded[]>();
  for (const e of world.entries) {
    let picks = groups.get(e.group);
    if (picks === undefined) {
      picks = [];
      groups.set(e.group, picks);
    }
    if (picks.length >= HOME_PER_GROUP) continue;
    const t = status.get(e.symbol);
    if (t?.id && readInstrument(db, t.id) !== null) {
      picks.push({ value: e.symbol, id: t.id, state: "ready" });
    } else if (world.resolving && (t === undefined || HOLDS.has(t.state))) {
      picks.push({ value: e.symbol, id: null, state: "pending" });
    }
  }
  return [...groups].map(([name, picks]) => ({ name, picks }));
}

// a group shows once one of its entries is in
function seed(db: Db, world: World): Section[] {
  const seen = new Set<string>();
  return home(db, world).flatMap((g) => {
    const ids = g.picks.flatMap((p) => {
      if (p.id === null || seen.has(p.id)) return [];
      seen.add(p.id);
      return [p.id];
    });
    return ids.length === 0 ? [] : [{ name: g.name, view: "cards", ids }];
  });
}

const seeding = (db: Db, world: World) =>
  home(db, world).flatMap((g) =>
    g.picks.map((p) => ({ value: p.value, state: p.state })),
  );

// Yahoo delays CME by about 10 minutes and CME's shortest pause is an
// hour, so an older last trade means its market is shut
export const FUTURES_FRESH_MS = 30 * MINUTE_MS;

type Pair = { id: string; label: string };

// by the ids each symbol resolved to, never by symbol text
function pairsOf(world: World): Map<string, Pair> {
  const ids = new Map(world.status().map((t) => [t.value, t.id]));
  const pairs = new Map<string, Pair>();
  for (const e of world.entries) {
    if (e.futures === undefined) continue;
    const index = ids.get(e.symbol);
    const id = ids.get(e.futures.symbol);
    if (index && id) pairs.set(index, { id, label: e.futures.label });
  }
  return pairs;
}

// the list's short name over the source's ("HANG SENG INDEX")
function namesOf(world: World): Map<string, string> {
  const names = new Map(world.entries.map((e) => [e.symbol, e.name]));
  const out = new Map<string, string>();
  for (const t of world.status()) {
    const name = names.get(t.value);
    if (t.id !== null && name !== undefined) out.set(t.id, name);
  }
  return out;
}

// Yahoo's regular period names the coming session before the open, so
// the index's own last trade marks its close
function futuresOf(
  m: Markets,
  row: ReturnType<typeof listRow>,
  i: Instrument,
  session: ReturnType<typeof sessionOf>,
  pair: Pair | undefined,
  now: number,
) {
  if (pair === undefined || session === null || session.state === "open") {
    return undefined;
  }
  const f = readInstrument(m.db, pair.id);
  const st = storedRow(m.db, pair.id);
  const traded = readQuote(m.db, pair.id)?.time ?? null;
  if (f === null || st === null || traded === null) return undefined;
  const ended = readSession(m.db, i.market)?.end ?? null;
  const closed =
    readQuote(m.db, i.id)?.time ??
    (ended !== null && ended <= now ? ended : null);
  if (closed === null || traded <= closed) return undefined;
  const hours = sessionOf(m, f, now);
  return {
    label: pair.label,
    instrument: row(st),
    session: {
      state: now - traded <= FUTURES_FRESH_MS ? "open" : "closed",
      start: hours?.start ?? null,
      end: hours?.end ?? null,
    },
    intraday: hasIntraday(st),
  };
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

function item(
  m: Markets,
  row: ReturnType<typeof listRow>,
  s: Stored,
  pair: Pair | undefined,
  name: string | undefined,
  now: number,
) {
  const i = readInstrument(m.db, s.id)!;
  const session = sessionOf(m, i, now);
  const futures = futuresOf(m, row, i, session, pair, now);
  return {
    id: s.id,
    instrument: name === undefined ? row(s) : { ...row(s), name },
    session,
    intraday: hasIntraday(s),
    averages: averagesOf(m, i, s.price, now),
    ...(futures === undefined ? {} : { futures }),
  };
}

// no read and no fetch: the page asks every minute
export function readDashboard(m: Markets, owner: string, world: World) {
  const now = m.clock.now();
  const saved = stored(m.db, owner);
  const sections = saved?.sections ?? seed(m.db, world);
  const row = listRow(m, owner, now);
  const pairs = pairsOf(world);
  const names = namesOf(world);
  let fred = false;
  const out = sections.map((s) => ({
    name: s.name,
    view: s.view,
    items: s.ids.flatMap((id) => {
      const st = storedRow(m.db, id);
      if (st === null) return [];
      if (st.source === FRED) fred = true;
      return [item(m, row, st, pairs.get(id), names.get(id), now)];
    }),
  }));
  return {
    ...(fred ? { attribution: ATTRIBUTION } : {}),
    revision: saved?.revision ?? 0,
    created: saved !== null,
    // a save while one is pending would leave it out for good
    ...(saved === null ? { track: seeding(m.db, world) } : {}),
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

const revisionOf = (db: Db, owner: string) => stored(db, owner)?.revision ?? 0;

const changed = (m: Markets, owner: string, world: World) =>
  problem("conflict", "the dashboard changed since that revision", {
    dashboard: readDashboard(m, owner, world),
  });

// resolved before the write, since a fetch never runs inside one
export async function saveDashboard(
  m: Markets,
  owner: string,
  world: World,
  args: LayoutArgs,
): Promise<Response> {
  if (args.revision !== revisionOf(m.db, owner)) {
    return changed(m, owner, world);
  }
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
    recheck(db);
    if (revisionOf(db, owner) !== args.revision) return false;
    const now = m.clock.now();
    db.query(
      `insert into dashboards (owner, revision, updated_at) values (?1, ?2, ?3)
       on conflict (owner) do update set revision = ?2, updated_at = ?3`,
    ).run(owner, args.revision + 1, now);
    db.query("delete from dashboard_items where owner = ?").run(owner);
    db.query("delete from dashboard_sections where owner = ?").run(owner);
    const section = db.query(
      "insert into dashboard_sections (owner, position, name, view) values (?, ?, ?, ?)",
    );
    const add = db.query(
      "insert into dashboard_items (owner, section, position, instrument) values (?, ?, ?, ?)",
    );
    sections.forEach((s, k) => {
      section.run(owner, k, s.name, s.view);
      // one deleted since it resolved has no card to keep
      s.ids
        .filter((id) => readInstrument(db, id) !== null)
        .forEach((id, j) => {
          add.run(owner, k, j, id);
        });
    });
    return true;
  });
  if (!saved) return changed(m, owner, world);
  return json(readDashboard(m, owner, world));
}
