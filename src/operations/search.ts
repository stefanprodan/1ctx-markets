// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Tracks nothing, so a search never keeps an instrument synced.

import { type Instrument, readInstrument } from "../market/instruments.ts";
import { candidateOf, TRADABLE } from "../sources/bvb/resolve.ts";
import { KINDS } from "../sources/bvb/sync.ts";
import { NO_DATA, seriesId } from "../sources/fred/sync.ts";
import { BVB, FRED_MARKET, YAHOO } from "../sources/ids.ts";
import { keyOf } from "../sources/yahoo/resolve.ts";
import { cursor, fitPage, readCursor } from "./answer.ts";
import { ArgError, fields, optionalText, text } from "./args.ts";
import type { Markets } from "./markets.ts";
import { itemError } from "./targets.ts";

const STORED = 20;

export type SearchArgs = { query: string; next: string | null };

export function parseSearch(input: unknown): SearchArgs {
  const f = fields(input, ["query", "next"]);
  return {
    query: text(f.query, "query"),
    next: optionalText(f.next, "next", 200),
  };
}

type Found = {
  id: string;
  name: string | null;
  type: string | null;
  exchange: string;
  source: string;
  source_symbol: string;
  // the Bucharest feed's listings only
  isin?: string | null;
  stored: boolean;
  note?: string;
};

const fromStored = (i: Instrument): Found => ({
  id: i.id,
  name: i.name,
  type: i.type,
  exchange: i.exchange,
  source: i.source,
  source_symbol: i.sourceSymbol,
  stored: true,
});

function stored(m: Markets, query: string): Found[] {
  const q = query.toUpperCase();
  return m.db
    .query<{ id: string }, [string, number]>(
      `select id from instruments
       where instr(upper(id), ?1) > 0 or instr(upper(source_symbol), ?1) > 0
         or instr(upper(coalesce(name, '')), ?1) > 0
       order by id limit ?2`,
    )
    .all(q, STORED)
    .map((r) => fromStored(readInstrument(m.db, r.id)!));
}

const EXPIRED = Symbol("expired");

// an answer by the call's deadline, and no source call started after it
async function within<T>(
  m: Markets,
  work: (live: () => boolean) => Promise<T>,
  deadline = m.clock.now() + m.callMs,
): Promise<T | typeof EXPIRED> {
  if (m.clock.now() >= deadline) return EXPIRED;
  let cancel = () => {};
  const expired = new Promise<typeof EXPIRED>((resolve) => {
    cancel = m.clock.at(deadline, () => resolve(EXPIRED));
  });
  try {
    return await Promise.race([work(() => m.clock.now() < deadline), expired]);
  } finally {
    cancel();
  }
}

type SourceNote = { source: string; error: string; message: string };

const late = (m: Markets, source: string): SourceNote => ({
  source,
  error: "timeout",
  message: `no answer within ${m.callMs / 1000} seconds`,
});

async function fredCandidates(
  m: Markets,
  query: string,
): Promise<{ found: Found[]; notes: SourceNote[] }> {
  let id: string;
  try {
    id = seriesId(query);
  } catch {
    return { found: [], notes: [] };
  }
  const key = `${FRED_MARKET}:${id}`;
  const known = readInstrument(m.db, key);
  if (known !== null) return { found: [fromStored(known)], notes: [] };
  const fred = m.fred;
  if (fred === null) {
    return {
      found: [],
      notes: [{ source: "fred", error: "no_data", message: NO_DATA }],
    };
  }
  try {
    const meta = await within(m, (live) => fred.within(live).series(id));
    if (meta === EXPIRED) return { found: [], notes: [late(m, "fred")] };
    return {
      found: [
        {
          id: key,
          name: meta.title,
          type: "SERIES",
          exchange: FRED_MARKET,
          source: "fred",
          source_symbol: id,
          stored: false,
          ...(meta.frequencyShort === "D"
            ? {}
            : { note: "only daily FRED series are supported" }),
        },
      ],
      notes: [],
    };
  } catch (error) {
    const e = itemError(m, error);
    if (e.error === "not_found") return { found: [], notes: [] };
    return { found: [], notes: [{ source: "fred", ...e }] };
  }
}

async function yahooCandidates(
  m: Markets,
  query: string,
): Promise<{ found: Found[]; notes: SourceNote[] }> {
  try {
    const listings = await within(m, (live) =>
      m.yahoo.within(live).search(query),
    );
    if (listings === EXPIRED) return { found: [], notes: [late(m, YAHOO)] };
    return {
      found: listings.map((l) => {
        const id = keyOf(l.exchange, l.sourceSymbol);
        return {
          id,
          name: l.name,
          type: l.type,
          exchange: l.exchange,
          source: YAHOO,
          source_symbol: l.sourceSymbol,
          stored: readInstrument(m.db, id) !== null,
        };
      }),
      notes: [],
    };
  } catch (error) {
    return { found: [], notes: [{ source: YAHOO, ...itemError(m, error) }] };
  }
}

// The site's search has no type, so the chart feed names it; a failed or
// late answer leaves it null, within what is left of the search's deadline.
async function typesOf(
  m: Markets,
  bvb: NonNullable<Markets["bvb"]>,
  query: string,
  symbol: string,
  deadline: number,
): Promise<Map<string, string>> {
  try {
    const types = await within(
      m,
      (live) => bvb.within(live).types(query, symbol),
      deadline,
    );
    return types === EXPIRED ? new Map() : types;
  } catch {
    return new Map();
  }
}

async function bvbCandidates(
  m: Markets,
  query: string,
): Promise<{ found: Found[]; notes: SourceNote[] }> {
  const bvb = m.bvb;
  if (bvb === null) return { found: [], notes: [] };
  const deadline = m.clock.now() + m.callMs;
  try {
    const listings = await within(
      m,
      (live) => bvb.within(live).search(query),
      deadline,
    );
    if (listings === EXPIRED) return { found: [], notes: [late(m, BVB)] };
    const tradable = listings.filter((l) => l.status === TRADABLE);
    const types =
      tradable.length === 0
        ? new Map<string, string>()
        : await typesOf(m, bvb, query, tradable[0]!.symbol, deadline);
    return {
      found: tradable.map((l) => {
        const c = candidateOf(l);
        const type = types.get(l.symbol.toUpperCase()) ?? null;
        return {
          id: c.id,
          name: c.name,
          type: type === null ? null : (KINDS[type]?.type ?? type),
          exchange: c.exchange,
          source: BVB,
          source_symbol: c.sourceSymbol,
          isin: l.isin,
          stored: readInstrument(m.db, c.id) !== null,
        };
      }),
      notes: [],
    };
  } catch (error) {
    return { found: [], notes: [{ source: BVB, ...itemError(m, error) }] };
  }
}

export async function searchAll(
  m: Markets,
  query: string,
): Promise<{ notes: SourceNote[]; all: Found[] }> {
  const fredQuery = query.toUpperCase().startsWith(`${FRED_MARKET}:`);
  const local = fredQuery ? [] : stored(m, query);
  const [exchange, remote] = await Promise.all([
    fredQuery ? { found: [], notes: [] } : bvbCandidates(m, query),
    fredQuery ? fredCandidates(m, query) : yahooCandidates(m, query),
  ]);
  const notes = [...exchange.notes, ...remote.notes];
  const seen = new Set<string>();
  // the instrument stores no ISIN, so a stored listing takes the feed's
  const isins = new Map(exchange.found.map((c) => [c.id, c.isin]));
  const known = local.map((c) =>
    isins.has(c.id) ? { ...c, isin: isins.get(c.id) } : c,
  );
  // a Bucharest listing is the feed's while it is on
  const all = [...known, ...exchange.found, ...remote.found].filter((c) => {
    if (seen.has(c.id)) return false;
    seen.add(c.id);
    return true;
  });
  return { notes, all };
}

export async function searchPage(
  m: Markets,
  args: SearchArgs,
): Promise<string> {
  let offset = 0;
  if (args.next !== null) {
    const at = readCursor(args.next, args.query);
    offset = at === null ? Number.NaN : Number(at);
    if (!Number.isSafeInteger(offset) || offset < 1) {
      throw new ArgError("next does not continue this query");
    }
  }
  const { notes, all } = await searchAll(m, args.query);
  const rest = all.slice(offset);
  return fitPage(
    rest,
    (count) => ({
      query: args.query,
      ...(notes.length > 0 ? { errors: notes } : {}),
      next:
        offset + count < all.length
          ? cursor(String(offset + count), args.query)
          : null,
    }),
    "candidates",
  ).text;
}
