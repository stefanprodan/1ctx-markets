// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Db } from "../storage/db/index.ts";
import { isQuoted, readSession } from "./calendars.ts";
import type { Instrument } from "./instruments.ts";
import {
  newestSession,
  readIntraday,
  type StoredPoint,
  trailingStep,
} from "./intraday.ts";

export type QuoteRow = {
  instrument: string;
  price: number;
  previousClose: number | null;
  // where the previous close came from: a Yahoo meta field, the
  // exchange's reference price, or the price minus its exact change
  previousCloseField:
    | "previousClose"
    | "chartPreviousClose"
    | "reference"
    | "change"
    | null;
  change: number | null;
  changePercent: number | null;
  dayHigh: number | null;
  dayLow: number | null;
  volume: number | null;
  // the trade time; null when the source gives none, never the fetch time
  time: number | null;
  source: string;
  fetchedAt: number;
};

// an older trade is kept out; the same trade, or one without a time,
// replaces it only when fetched later
export function upsertQuote(db: Db, q: QuoteRow): boolean {
  const { changes } = db
    .query(
      `insert into quotes (instrument, price, previous_close,
         previous_close_field, change, change_percent, day_high, day_low,
         volume, time, source, fetched_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       on conflict (instrument) do update set
         price = excluded.price,
         previous_close = excluded.previous_close,
         previous_close_field = excluded.previous_close_field,
         change = excluded.change,
         change_percent = excluded.change_percent,
         day_high = excluded.day_high,
         day_low = excluded.day_low,
         volume = excluded.volume,
         time = excluded.time,
         source = excluded.source,
         fetched_at = excluded.fetched_at
       where excluded.time > quotes.time
         or ((excluded.time is quotes.time or excluded.time is null
             or quotes.time is null)
           and excluded.fetched_at > quotes.fetched_at)`,
    )
    .run(
      q.instrument,
      q.price,
      q.previousClose,
      q.previousCloseField,
      q.change,
      q.changePercent,
      q.dayHigh,
      q.dayLow,
      q.volume,
      q.time,
      q.source,
      q.fetchedAt,
    );
  return changes > 0;
}

export function readQuote(db: Db, instrument: string): QuoteRow | null {
  return (
    db
      .query<QuoteRow, [string]>(
        `select instrument, price, previous_close as previousClose,
           previous_close_field as previousCloseField, change,
           change_percent as changePercent, day_high as dayHigh,
           day_low as dayLow, volume, time, source, fetched_at as fetchedAt
         from quotes where instrument = ?`,
      )
      .get(instrument) ?? null
  );
}

// a print this many times the session's second largest step can be held
export const HELD_PRINT_TIMES = 4;

type Print = { held: StoredPoint; print: StoredPoint; points: StoredPoint[] };

// the newest session ending on a trailing step the hold applies to
function trailingPrint(db: Db, id: string): Print | null {
  const session = newestSession(db, id);
  if (session === null) return null;
  const points = readIntraday(db, id, session, session);
  const step = trailingStep(points.map((p) => p.close));
  if (step === null || step.times < HELD_PRINT_TIMES) return null;
  return { held: points[step.before]!, print: points.at(-1)!, points };
}

const isCurrency = (type: string) => type.toUpperCase() === "CURRENCY";

// A pair's off-market print at the weekend close is no price to act on;
// while open nothing is held, and the next session's quote replaces it.
// Run after both the quote and its points are stored, whichever is last.
export function holdPrint(
  db: Db,
  instrument: Pick<Instrument, "id" | "type" | "market">,
  now: number,
): QuoteRow | null {
  if (!isCurrency(instrument.type)) return null;
  if (isQuoted(instrument.market, readSession(db, instrument.market), now)) {
    return null;
  }
  const q = readQuote(db, instrument.id);
  if (q === null) return null;
  const found = trailingPrint(db, instrument.id);
  if (found === null || q.price !== found.print.close) return null;
  const { held, print, points } = found;
  const upTo = points.slice(0, points.indexOf(held) + 1).map((p) => p.close);
  // only the side the print moved is the print's
  const down = print.close < held.close;
  const change = q.previousClose === null ? null : held.close - q.previousClose;
  const row: QuoteRow = {
    ...q,
    price: held.close,
    change,
    changePercent:
      change === null || q.previousClose === 0
        ? null
        : (change / q.previousClose!) * 100,
    dayLow: down ? Math.min(...upTo) : q.dayLow,
    dayHigh: down ? q.dayHigh : Math.max(...upTo),
    time: held.at,
  };
  db.query(
    `update quotes set price = ?, change = ?, change_percent = ?,
       day_low = ?, day_high = ?, time = ?
     where instrument = ?`,
  ).run(
    row.price,
    row.change,
    row.changePercent,
    row.dayLow,
    row.dayHigh,
    row.time,
    row.instrument,
  );
  return row;
}

// the stored quote is a held one: its session's point before the print
export function isPrintHeld(db: Db, id: string): boolean {
  const type = db
    .query<{ type: string }, [string]>(
      "select type from instruments where id = ?",
    )
    .get(id)?.type;
  if (type === undefined || !isCurrency(type)) return false;
  const q = readQuote(db, id);
  if (q === null || q.time === null) return false;
  // only a held quote is older than its session's last point
  const last = db
    .query<{ at: number | null }, [string]>(
      `select max(at) as at from intraday where instrument = ?1
       and session = (select max(session) from intraday where instrument = ?1)`,
    )
    .get(id)?.at;
  if (last == null || q.time >= last) return false;
  const found = trailingPrint(db, id);
  return (
    found !== null &&
    q.time === found.held.at &&
    q.price === found.held.close &&
    q.price !== found.print.close
  );
}
