// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Bar } from "../market/bars.ts";
import { weekOf } from "../market/calendars.ts";
import type { Instrument } from "../market/instruments.ts";
import { dateOfWall } from "../market/zone.ts";
import { DAY_MS, MINUTE_MS } from "../runtime/clock.ts";
import type { Db } from "../storage/db/index.ts";

export const BACKFILL_YEARS = 10;
// a failed pass or backfill, or a refused whole history, waits this long
export const RETRY_MS = 60 * MINUTE_MS;
export const REFETCH_DAYS = 30;

// a Monday so the first week is whole; from the UTC day before, for any zone
export function backfillStart(now: number): { monday: string; from: number } {
  const today = dateOfWall(now);
  const back = `${Number(today.slice(0, 4)) - BACKFILL_YEARS}${today.slice(4)}`;
  // ten years before a 29 February is no leap year
  const monday = weekOf(
    back.endsWith("-02-29") ? `${back.slice(0, 8)}28` : back,
  );
  return { monday, from: Date.parse(`${monday}T00:00:00Z`) - DAY_MS };
}

// a shared ratio this far from 1 is a rescale, not numerical noise
const RESCALE = 0.001;
// ratios this close to each other are one ratio
const SAME_RATIO = 0.0001;
// fewer days moved by one ratio are corrections
const RESCALE_DAYS = 3;

// the ratio past prices moved by and the stored days that show it
export type Rescale = { ratio: number; dates: string[] };

export const sameRatio = (a: number, b: number) =>
  Math.abs(a / b - 1) <= SAME_RATIO;

// final days repriced by one ratio with no split: past prices adjusted in
// place; an adjustment moves every day before its date, so the oldest show it
export function rescaleOf(
  db: Db,
  instrument: Pick<Instrument, "id">,
  bars: readonly Bar[],
): Rescale | null {
  const stored = db.query<{ close: number }, [string, string]>(
    `select close from bars where instrument = ? and interval = '1d'
     and date = ? and final = 1`,
  );
  let ratio = 0;
  let dates: string[] = [];
  for (const b of [...bars].sort((x, y) => (x.date < y.date ? -1 : 1))) {
    const s = stored.get(instrument.id, b.date);
    if (s === null || s.close <= 0) continue;
    const r = b.close / s.close;
    if (dates.length > 0 && sameRatio(r, ratio)) dates.push(b.date);
    else if (dates.length >= RESCALE_DAYS) break;
    else {
      ratio = r;
      dates = [b.date];
    }
    if (dates.length === RESCALE_DAYS && Math.abs(ratio - 1) <= RESCALE) {
      return null;
    }
  }
  if (dates.length < RESCALE_DAYS) return null;
  return { ratio, dates };
}
