// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// Rates from the currency pairs the server quotes, never a guess: a pair
// it has no price for is null with the reason.

import { iso } from "../market/format.ts";
import { readBySourceSymbol } from "../market/instruments.ts";
import { readQuote } from "../market/quotes.ts";
import { quoteStale } from "../market/stale.ts";
import { HUNDREDTHS } from "../shared/currencies.ts";
import { YAHOO } from "../sources/ids.ts";
import type { Db } from "../storage/db/index.ts";

const major = (c: string): [string, number] => HUNDREDTHS[c] ?? [c, 1];

export type Rate =
  | {
      rate: number;
      // the pair read, null when the two are one currency
      pair: string | null;
      // a live rate's trade time, or a close's date
      at: string | null;
      stale: string[];
    }
  | { rate: null; pair: null; at: null; stale: string[]; reason: string };

// both ways a pair can be listed, as Yahoo symbols
export function pairSymbols(from: string, to: string): string[] {
  const [a] = major(from);
  const [b] = major(to);
  return a === b ? [] : [`${a}${b}=X`, `${b}${a}=X`];
}

export const noRate = (from: string, to: string): string =>
  `no ${major(from)[0]} to ${major(to)[0]} rate`;

type Close = { date: string; close: number };

// a final close only: a day still trading is no day's rate; a trade
// older than the pair's first close has none, never a later one
function closeOn(db: Db, id: string, date: string): Close | null {
  return (
    db
      .query<Close, [string, string]>(
        `select date, close from bars where instrument = ? and interval = '1d'
         and final = 1 and date <= ? order by date desc limit 1`,
      )
      .get(id, date) ?? null
  );
}

export const noClose = (from: string, to: string, date: string): string =>
  `no ${major(from)[0]} to ${major(to)[0]} close on or before ${date}`;

// a rate a holdings answer read, said back with it
export type Used = {
  from: string;
  to: string;
  // a close's date asked for, null for the live rate
  date: string | null;
  rate: Rate;
};

export type Rates = {
  // date: a close on or before it; null: the live quote
  rate(from: string, to: string, date: string | null): Rate;
  // every rate read so far, in the order first asked
  used(): Used[];
};

// memoised per answer, since a holdings read asks the same pair often
export function rates(db: Db, now: number, everyMs: number): Rates {
  const seen = new Map<string, Used>();
  const read = (from: string, to: string, date: string | null): Rate => {
    const [a, am] = major(from);
    const [b, bm] = major(to);
    if (a === b) return { rate: am / bm, pair: null, at: null, stale: [] };
    let stored = false;
    for (const [symbol, inverse] of [
      [`${a}${b}=X`, false],
      [`${b}${a}=X`, true],
    ] as const) {
      const pair = readBySourceSymbol(db, YAHOO, symbol);
      if (pair === null) continue;
      stored = true;
      let value: number | null = null;
      let at: string | null = null;
      let stale: string[] = [];
      if (date === null) {
        const q = readQuote(db, pair.id);
        if (q !== null) {
          value = q.price;
          at = iso(q.time ?? q.fetchedAt);
          stale = quoteStale(db, pair, { now, everyMs });
        }
      } else {
        const c = closeOn(db, pair.id, date);
        if (c !== null) {
          value = c.close;
          at = c.date;
        }
      }
      if (value === null || value <= 0) continue;
      const rate = (inverse ? 1 / value : value) * (am / bm);
      return { rate, pair: pair.id, at, stale };
    }
    return {
      rate: null,
      pair: null,
      at: null,
      stale: [],
      reason:
        stored && date !== null ? noClose(from, to, date) : noRate(from, to),
    };
  };
  return {
    rate(from, to, date) {
      const key = `${from}>${to}@${date ?? "live"}`;
      let u = seen.get(key);
      if (u === undefined) {
        u = { from, to, date, rate: read(from, to, date) };
        seen.set(key, u);
      }
      return u.rate;
    },
    used: () => [...seen.values()],
  };
}

// a pair neither way stored, so the caller can fetch it once
export function missingPairs(db: Db, pairs: Iterable<[string, string]>) {
  const out = new Set<string>();
  for (const [from, to] of pairs) {
    const both = pairSymbols(from, to);
    if (both.length === 0) continue;
    if (both.some((s) => readBySourceSymbol(db, YAHOO, s) !== null)) continue;
    out.add(both[0]!);
  }
  return [...out];
}
