// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Yahoo symbols into market:symbol keys, for any exchange it carries,
// and which listing a caller's symbol means, never by a guess.

import { CRYPTO } from "../calendars.ts";
import type { Db } from "../db/index.ts";
import {
  type Instrument,
  readBySourceSymbol,
  readInstrument,
} from "../instruments.ts";
import type { Listing, Yahoo } from "./client.ts";
import { SOURCE } from "./client.ts";

// The key is the identity: an alias added later moves stored keys, so
// it ships with a migration that re-keys them.
const ALIASES: Readonly<Record<string, string>> = {
  NMS: "US",
  NGM: "US",
  NCM: "US",
  NAS: "US",
  NYQ: "US",
  ASE: "US",
  PCX: "US",
  BTS: "US",
  PNK: "US",
  GER: "XETRA",
  CCC: CRYPTO,
};

// any code not aliased is a market of its own, so a new exchange needs
// no change here
export function marketOf(exchange: string): string {
  const code = exchange.trim().toUpperCase();
  if (code === "") throw new Error("no exchange code");
  return ALIASES[code] ?? code;
}

// VVSM.DE is VVSM; index, futures and FX symbols (^VIX, CL=F, EURUSD=X)
// have no suffix and keep their form
export function symbolOf(sourceSymbol: string): string {
  const s = sourceSymbol.trim().toUpperCase();
  const dot = s.lastIndexOf(".");
  return dot > 0 && hasSuffix(s) ? s.slice(0, dot) : s;
}

const SUFFIX = /^[^.^=]+\.[A-Z]{1,4}$/;

function hasSuffix(symbol: string): boolean {
  return SUFFIX.test(symbol);
}

export function keyOf(exchange: string, sourceSymbol: string): string {
  return `${marketOf(exchange)}:${symbolOf(sourceSymbol)}`;
}

export type Candidate = Listing & {
  id: string;
  market: string;
  symbol: string;
};

export type Resolution =
  // stored already
  | { kind: "known"; instrument: Instrument }
  // one listing, added by its source symbol; the key is null when only
  // the chart answer will name the exchange
  | { kind: "new"; sourceSymbol: string; id: string | null }
  // several listings, for the caller to pick from
  | { kind: "candidates"; candidates: Candidate[] };

export class ResolveError extends Error {
  constructor(readonly input: string) {
    super(`no listing found for ${input}`);
    this.name = "ResolveError";
  }
}

const candidate = (l: Listing): Candidate => ({
  ...l,
  id: keyOf(l.exchange, l.sourceSymbol),
  market: marketOf(l.exchange),
  symbol: symbolOf(l.sourceSymbol),
});

const KEY = /^([A-Za-z0-9]+):(\S+)$/;

// A key not yet stored is searched on its market's codes. A Yahoo
// symbol with its suffix, or an index, futures or FX symbol, is exact
// and needs no search. A bare symbol takes the listing whose Yahoo
// symbol equals it; a name, or a symbol with no such listing, answers
// every listing as a candidate.
export async function resolve(
  db: Db,
  yahoo: Yahoo,
  input: string,
): Promise<Resolution> {
  const given = input.trim();
  if (given === "") throw new ResolveError(input);
  const key = KEY.exec(given);
  if (key) {
    const id = `${key[1]!.toUpperCase()}:${key[2]!.toUpperCase()}`;
    const known = readInstrument(db, id);
    if (known) return { kind: "known", instrument: known };
    const found = (await yahoo.search(key[2]!))
      .map(candidate)
      .filter((c) => c.id === id);
    if (found.length === 1) {
      return { kind: "new", sourceSymbol: found[0]!.sourceSymbol, id };
    }
    if (found.length > 1) return { kind: "candidates", candidates: found };
    throw new ResolveError(id);
  }
  const upper = given.toUpperCase();
  const known = readBySourceSymbol(db, SOURCE, upper);
  if (known) return { kind: "known", instrument: known };
  if (isExact(upper)) return { kind: "new", sourceSymbol: upper, id: null };
  const listings = (await yahoo.search(given)).map(candidate);
  const exact = listings.find((l) => l.sourceSymbol.toUpperCase() === upper);
  if (exact) {
    return { kind: "new", sourceSymbol: exact.sourceSymbol, id: exact.id };
  }
  if (listings.length === 0) throw new ResolveError(given);
  return { kind: "candidates", candidates: listings };
}

// a symbol that names one listing by itself
export function isExact(symbol: string): boolean {
  return hasSuffix(symbol) || /[\^=]/.test(symbol);
}
