// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { type Session, session } from "../../market/calendars.ts";
import { type Instrument, readInstruments } from "../../market/instruments.ts";
import { type QuoteRow, readQuote, upsertQuote } from "../../market/quotes.ts";
import { fromWallTime, localDate, wallTime } from "../../market/zone.ts";
import { NO_RULES, type RuleHooks } from "../../rules/hooks.ts";
import { DAY_MS, MINUTE_MS } from "../../runtime/clock.ts";
import { pruneLive, refreshLive } from "../../signals/store.ts";
import type { Db } from "../../storage/db/index.ts";
import { SourceError } from "../source.ts";
import { MARKET, SOURCE } from "./client.ts";
import type { Detail, IndexRow, ListRow, Schedule } from "./parse.ts";

// the schedule's times on now's local date
export function sessionOf(zone: string, s: Schedule, now: number): Session {
  const day = Math.floor(wallTime(zone, now) / DAY_MS) * DAY_MS;
  return session(
    zone,
    fromWallTime(zone, day + s.start),
    fromWallTime(zone, day + s.end),
  );
}

function quoteRow(
  instrument: Instrument,
  price: number,
  previousClose: number | null,
  field: "reference" | "change",
  range: { high: number | null; low: number | null },
  time: number | null,
  fetchedAt: number,
): QuoteRow {
  const change = previousClose === null ? null : price - previousClose;
  return {
    instrument: instrument.id,
    price,
    previousClose,
    previousCloseField: previousClose === null ? null : field,
    change,
    changePercent:
      change === null || previousClose === 0
        ? null
        : (change / previousClose!) * 100,
    dayHigh: range.high,
    dayLow: range.low,
    volume: null,
    time,
    source: SOURCE,
    fetchedAt,
  };
}

// the instrument page's reference price is the previous close, never one
// worked back from a rounded change percent
export function detailQuote(
  instrument: Instrument,
  d: Detail,
): QuoteRow | null {
  // the page of another symbol is that listing's price, never ours
  if (d.symbol.toUpperCase() !== instrument.sourceSymbol.toUpperCase()) {
    throw new SourceError(
      "malformed answer",
      `${instrument.id} answered as ${d.symbol}`,
    );
  }
  if (d.price === null || d.at === null) return null;
  return quoteRow(
    instrument,
    d.price,
    d.reference,
    "reference",
    { high: d.high, low: d.low },
    fromWallTime(instrument.zone, d.at),
    d.fetchedAt,
  );
}

// the index page gives the exact change and no trade time
export function indexQuote(
  instrument: Instrument,
  row: IndexRow,
  fetchedAt: number,
): QuoteRow {
  return quoteRow(
    instrument,
    row.value,
    row.value - row.change,
    "change",
    { high: null, low: null },
    null,
    fetchedAt,
  );
}

// a traded row of the stored quote's day keeps its previous close and widens
// its day range; one of a later day needs the instrument page (null)
export function listQuote(
  db: Db,
  instrument: Instrument,
  row: ListRow & { price: number; at: number },
  fetchedAt: number,
): QuoteRow | null {
  const listed = fromWallTime(instrument.zone, row.at);
  const stored = readQuote(db, instrument.id);
  if (
    stored === null ||
    stored.time === null ||
    stored.previousClose === null ||
    localDate(instrument.zone, stored.time) !==
      localDate(instrument.zone, listed)
  ) {
    return null;
  }
  // the list writes minutes, the instrument page seconds: the same trade
  const time =
    stored.time >= listed && stored.time < listed + MINUTE_MS
      ? stored.time
      : listed;
  const widen = (v: number | null, f: (a: number, b: number) => number) =>
    v === null ? null : f(v, row.price);
  return quoteRow(
    instrument,
    row.price,
    stored.previousClose,
    "reference",
    {
      high: widen(stored.dayHigh, Math.max),
      low: widen(stored.dayLow, Math.min),
    },
    time,
    fetchedAt,
  );
}

// live rows follow the quotes; a market's others lose a live row its
// session moved past
export function storeBvbQuotes(
  db: Db,
  quotes: readonly QuoteRow[],
  rules: RuleHooks = NO_RULES,
  now: number,
): QuoteRow[] {
  const written: QuoteRow[] = [];
  const moved = new Set<string>();
  const instruments = readInstruments(db).filter((i) => i.market === MARKET);
  const byId = new Map(instruments.map((i) => [i.id, i]));
  for (const q of quotes) {
    const instrument = byId.get(q.instrument);
    if (instrument === undefined || !upsertQuote(db, q)) continue;
    written.push(q);
    refreshLive(db, instrument, q.fetchedAt);
    moved.add(instrument.id);
  }
  for (const i of instruments) {
    if (!moved.has(i.id)) pruneLive(db, i, now);
  }
  rules.evaluate(db, moved, now);
  return written;
}
