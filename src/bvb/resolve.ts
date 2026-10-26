// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// With the feed on, a symbol or name is resolved by the exchange's own
// instrument search beside Yahoo's, under the same rules: one exact
// listing is it, several are candidates, never a guess.

import type { Clock } from "../clock.ts";
import type { Db } from "../db/index.ts";
import {
  type Instrument,
  readBySourceSymbol,
  readInstrument,
} from "../instruments.ts";
import { SOURCE as YAHOO, type Yahoo } from "../yahoo/client.ts";
import {
  type Candidate,
  ResolveError,
  resolve as resolveYahoo,
} from "../yahoo/resolve.ts";
import { type Bvb, type Listing, MARKET, SOURCE } from "./client.ts";
import { keyOf } from "./sync.ts";

export type Resolution =
  | { kind: "known"; instrument: Instrument }
  | {
      kind: "new";
      source: "yahoo" | "bvb";
      sourceSymbol: string;
      id: string;
    }
  | { kind: "candidates"; candidates: Candidate[] };

// only a tradable listing counts; a delisted one is no instrument to fetch
export const TRADABLE = "T";

export const candidateOf = (l: Listing): Candidate => ({
  sourceSymbol: l.symbol,
  exchange: MARKET,
  type: null,
  name: l.name,
  id: keyOf(l.symbol),
  market: MARKET,
  symbol: l.symbol.toUpperCase(),
});

// the exchange writes some symbols in mixed case (BETPlus)
export function readByFeedSymbol(db: Db, symbol: string): Instrument | null {
  const row = db
    .query<{ id: string }, [string, string]>(
      `select id from instruments
       where source = ? and upper(source_symbol) = upper(?)`,
    )
    .get(SOURCE, symbol.trim());
  return row === null ? null : readInstrument(db, row.id);
}

const marketOfId = (id: string) => id.slice(0, id.indexOf(":"));

export async function resolveBoth(
  ctx: { db: Db; clock: Clock; yahoo: Yahoo; bvb: Bvb },
  input: string,
): Promise<Resolution> {
  const given = input.trim();
  if (given === "") throw new ResolveError(input);
  const stored = [
    readByFeedSymbol(ctx.db, given),
    readBySourceSymbol(ctx.db, YAHOO, given.toUpperCase()),
  ].filter((i) => i !== null);
  if (stored.length === 1) return { kind: "known", instrument: stored[0]! };
  // stored once from each source: TLV on Bucharest and elsewhere
  if (stored.length > 1) {
    return {
      kind: "candidates",
      candidates: stored.map((i) => ({
        id: i.id,
        market: i.market,
        symbol: i.symbol,
        sourceSymbol: i.sourceSymbol,
        exchange: i.exchange,
        type: i.type,
        name: i.name,
      })),
    };
  }
  const [y] = await Promise.allSettled([resolveYahoo(ctx, given)]);
  if (y.status === "fulfilled" && y.value.kind === "known") return y.value;
  // Yahoo's exact match skips the exchange's search, which waits on the
  // feed's spacing, only when it is a Bucharest listing or the exchange's
  // last list pages lack the symbol and Yahoo's results name none there
  const lists = ctx.bvb.listed();
  if (
    y.status === "fulfilled" &&
    y.value.kind === "new" &&
    (marketOfId(y.value.id) === MARKET ||
      (lists !== null &&
        !lists.has(given.toUpperCase()) &&
        !(y.value.listings ?? []).some((c) => c.market === MARKET)))
  ) {
    const { id, sourceSymbol } = y.value;
    return marketOfId(id) === MARKET
      ? {
          kind: "new",
          source: "bvb",
          sourceSymbol: id.slice(MARKET.length + 1),
          id,
        }
      : { kind: "new", source: "yahoo", sourceSymbol, id };
  }
  const [b] = await Promise.allSettled([ctx.bvb.search(given)]);
  const listings =
    b.status === "fulfilled"
      ? b.value.filter((l) => l.status === TRADABLE).map(candidateOf)
      : [];
  const upper = given.toUpperCase();
  // the exact listings by key: a Bucharest one is the feed's, whichever
  // search named it
  const exact = new Map<string, Candidate>();
  if (y.status === "fulfilled" && y.value.kind === "new") {
    const { id, sourceSymbol } = y.value;
    const market = marketOfId(id);
    exact.set(id, {
      id,
      market,
      symbol: id.slice(market.length + 1),
      sourceSymbol:
        market === MARKET ? id.slice(market.length + 1) : sourceSymbol,
      exchange: market,
      type: null,
      name: null,
    });
  }
  for (const c of listings) {
    if (c.sourceSymbol.toUpperCase() === upper) exact.set(c.id, c);
  }
  if (exact.size === 1) {
    const [one] = exact.values();
    return {
      kind: "new",
      source: one!.market === MARKET ? "bvb" : "yahoo",
      sourceSymbol: one!.sourceSymbol,
      id: one!.id,
    };
  }
  if (exact.size > 1)
    return { kind: "candidates", candidates: [...exact.values()] };
  const fromYahoo =
    y.status === "fulfilled" && y.value.kind === "candidates"
      ? y.value.candidates
      : [];
  const seen = new Set<string>();
  const all = [...listings, ...fromYahoo].filter((c) => {
    if (seen.has(c.id)) return false;
    seen.add(c.id);
    return true;
  });
  if (all.length > 0) return { kind: "candidates", candidates: all };
  if (y.status === "rejected" && !(y.reason instanceof ResolveError)) {
    throw y.reason;
  }
  if (b.status === "rejected") throw b.reason;
  throw new ResolveError(given);
}
