// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// Tracks nothing, so a search never keeps an instrument synced.

import { type Instrument, readInstrument } from "../market/instruments.ts";
import { findListings } from "../sources/bvb/listings.ts";
import { keyOf as bvbKey } from "../sources/bvb/sync.ts";
import { NO_DATA, seriesId } from "../sources/fred/sync.ts";
import {
  BVB,
  BVB_MARKET,
  FRED_MARKET,
  FUND_SOURCE,
  YAHOO,
} from "../sources/ids.ts";
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
  // the exchange in words, from the source's search, when it gives one
  exchange_name?: string;
  // a stored listing's, so one fund on several exchanges reads apart
  currency?: string | null;
  source: string;
  source_symbol: string;
  // the Bucharest exchange's listings only
  isin?: string | null;
  stored: boolean;
  note?: string;
};

const fromStored = (i: Instrument): Found => ({
  id: i.id,
  name: i.name,
  type: i.type,
  exchange: i.exchange,
  currency: i.currency,
  source: i.source,
  source_symbol: i.sourceSymbol,
  stored: true,
});

function stored(m: Markets, query: string): Found[] {
  const q = query.toUpperCase();
  return m.db
    .query<{ id: string }, [string, number, string]>(
      `select id from instruments
       where (instr(upper(id), ?1) > 0 or instr(upper(source_symbol), ?1) > 0
         or instr(upper(coalesce(name, '')), ?1) > 0) and source <> ?3
       order by id limit ?2`,
    )
    .all(q, STORED, FUND_SOURCE)
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
          ...(l.exchangeName === undefined
            ? {}
            : { exchange_name: l.exchangeName }),
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

// the list pages as last read, so a search waits on no exchange call;
// none until they are first read
function bvbCandidates(m: Markets, query: string): Found[] {
  if (m.bvb === null) return [];
  return findListings(m.db, query, STORED).map((l) => {
    const id = bvbKey(l.symbol);
    return {
      id,
      name: l.name,
      type: l.type,
      exchange: BVB_MARKET,
      source: BVB,
      source_symbol: l.symbol,
      isin: l.isin,
      stored: readInstrument(m.db, id) !== null,
    };
  });
}

const NONE = { found: [] as Found[], notes: [] as SourceNote[] };

// upstream false asks no source: stored instruments and stored listings
export async function searchAll(
  m: Markets,
  query: string,
  upstream = true,
): Promise<{ notes: SourceNote[]; all: Found[] }> {
  const fredQuery = query.toUpperCase().startsWith(`${FRED_MARKET}:`);
  // a stored series matches by id here, as the FRED side would find it
  const local = fredQuery && upstream ? [] : stored(m, query);
  const listed = fredQuery ? [] : bvbCandidates(m, query);
  const remote = !upstream
    ? NONE
    : fredQuery
      ? await fredCandidates(m, query)
      : await yahooCandidates(m, query);
  const notes = remote.notes;
  const seen = new Set<string>();
  // the instrument stores no ISIN, so a stored listing takes the list's
  const isins = new Map(listed.map((c) => [c.id, c.isin]));
  // nor the exchange in words, so a stored listing takes Yahoo's
  const words = new Map(
    remote.found.flatMap((c) =>
      c.exchange_name === undefined ? [] : [[c.id, c.exchange_name] as const],
    ),
  );
  const known = local.map((c) => {
    const isin = isins.has(c.id) ? { isin: isins.get(c.id) } : {};
    const said = words.get(c.id);
    return {
      ...c,
      ...isin,
      ...(said === undefined ? {} : { exchange_name: said }),
    };
  });
  // a Bucharest listing is the exchange's while its source is on
  const all = [...known, ...listed, ...remote.found].filter((c) => {
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
