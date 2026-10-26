// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The latest quote per instrument, whichever source gave it.

import type { Db } from "./db/index.ts";

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
