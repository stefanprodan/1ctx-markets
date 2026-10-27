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
import { type Clock, DAY_MS } from "../runtime/clock.ts";
import { SourceError } from "../source.ts";
import type { Listing, Yahoo } from "./client.ts";
import { SOURCE } from "./client.ts";

// a short chart is enough for an exact symbol's answer to name its key
const CHECK_MS = 7 * DAY_MS;

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

// any code not aliased is its own market, so a new exchange needs no change
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
  | { kind: "known"; instrument: Instrument }
  // one listing, added by its source symbol; listings: the search's,
  // when a search found it
  | {
      kind: "new";
      sourceSymbol: string;
      id: string;
      listings?: Candidate[];
    }
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

// never a guess: exact symbols ask a chart, bare ones must equal a listing
export async function resolve(
  ctx: { db: Db; clock: Clock; yahoo: Yahoo },
  input: string,
): Promise<Resolution> {
  const { db, yahoo } = ctx;
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
  if (isExact(upper)) {
    // Yahoo writes share classes BRK-B, so BRK.B falls back to a search
    try {
      const now = ctx.clock.now();
      const a = await yahoo.chart(upper, now - CHECK_MS, now);
      return {
        kind: "new",
        sourceSymbol: a.symbol,
        id: keyOf(a.exchange, a.symbol),
      };
    } catch (error) {
      if (!(error instanceof SourceError && error.phrase === "not found")) {
        throw error;
      }
    }
  }
  const listings = (await yahoo.search(given)).map(candidate);
  const exact = listings.find((l) => l.sourceSymbol.toUpperCase() === upper);
  if (exact) {
    return {
      kind: "new",
      sourceSymbol: exact.sourceSymbol,
      id: exact.id,
      listings,
    };
  }
  if (listings.length === 0) throw new ResolveError(given);
  return { kind: "candidates", candidates: listings };
}

// a symbol that names one listing by itself
export function isExact(symbol: string): boolean {
  return hasSuffix(symbol) || /[\^=]/.test(symbol);
}
