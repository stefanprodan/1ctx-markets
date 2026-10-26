// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A name or symbol to the instruments it may mean: the stored ones and
// Yahoo's listings. It fetches no prices and tracks nothing, so a search
// never keeps an instrument synced.

import { SOURCE as BVB } from "../bvb/client.ts";
import { candidateOf, TRADABLE } from "../bvb/resolve.ts";
import { MARKET as FRED_MARKET, NO_DATA, seriesId } from "../fred/sync.ts";
import { type Instrument, readInstrument } from "../instruments.ts";
import { SOURCE as YAHOO } from "../yahoo/client.ts";
import { keyOf } from "../yahoo/resolve.ts";
import { cursor, fitPage, readCursor } from "./answer.ts";
import { ArgError, fields, optionalText, text } from "./args.ts";
import { itemError, type Markets } from "./targets.ts";

// stored matches answered at most
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
): Promise<T | typeof EXPIRED> {
  const deadline = m.clock.now() + m.callMs;
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

// the exchange's own listings, tradable only, while the feed is on
async function bvbCandidates(
  m: Markets,
  query: string,
): Promise<{ found: Found[]; notes: SourceNote[] }> {
  const bvb = m.bvb;
  if (bvb === null) return { found: [], notes: [] };
  try {
    const listings = await within(m, (live) => bvb.within(live).search(query));
    if (listings === EXPIRED) return { found: [], notes: [late(m, BVB)] };
    return {
      found: listings
        .filter((l) => l.status === TRADABLE)
        .map((l) => {
          const c = candidateOf(l);
          return {
            id: c.id,
            name: c.name,
            type: c.type,
            exchange: c.exchange,
            source: BVB,
            source_symbol: c.sourceSymbol,
            stored: readInstrument(m.db, c.id) !== null,
          };
        }),
      notes: [],
    };
  } catch (error) {
    return { found: [], notes: [{ source: BVB, ...itemError(m, error) }] };
  }
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
  const fredQuery = args.query.toUpperCase().startsWith(`${FRED_MARKET}:`);
  const local = fredQuery ? [] : stored(m, args.query);
  const [exchange, remote] = await Promise.all([
    fredQuery ? { found: [], notes: [] } : bvbCandidates(m, args.query),
    fredQuery ? fredCandidates(m, args.query) : yahooCandidates(m, args.query),
  ]);
  const notes = [...exchange.notes, ...remote.notes];
  const seen = new Set<string>();
  // a Bucharest listing is the feed's while it is on
  const all = [...local, ...exchange.found, ...remote.found].filter((c) => {
    if (seen.has(c.id)) return false;
    seen.add(c.id);
    return true;
  });
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
