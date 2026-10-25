// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// FRED series as instruments of the FRED market, their observations as
// daily bars that carry only a close. FRED publishes only closed days,
// so a bar is final once fetched, and a revision replaces it.

import {
  type Bar,
  dailyRange,
  deleteDailyBars,
  earliest,
  rebuildWeeks,
  upsertBars,
  type Written,
} from "../bars.ts";
import { type Session, weekOf } from "../calendars.ts";
import { type Clock, DAY_MS } from "../clock.ts";
import type { Db } from "../db/index.ts";
import {
  type Instrument,
  type InstrumentFields,
  readInstrument,
  type Unit,
  upsertInstrument,
} from "../instruments.ts";
import { exclusive } from "../lock.ts";
import { SourceError } from "../source.ts";
import type { Writer } from "../writer.ts";
import { addDays, dateOfWall, startOfDate } from "../zone.ts";
import {
  type Fred,
  type Observations,
  type SeriesMeta,
  SOURCE,
} from "./client.ts";

export const MARKET = "FRED";
// observation dates are calendar dates, not an exchange's
export const ZONE = "UTC";
const TYPE = "SERIES";
export const BACKFILL_YEARS = 10;
export const REFETCH_OBSERVATIONS = 30;

// FRED's terms ask every answer carrying its values to say this
export const ATTRIBUTION =
  "This product uses the FRED® API but is not endorsed or certified by the Federal Reserve Bank of St. Louis";
// what a FRED read answers while the source is off, never an error
export const NO_DATA = "no data from FRED";
export const DAILY_ONLY = "only daily FRED series are supported";

// db is for reads; every write goes through writer; fred is null while
// the source is off
export type FredContext = {
  db: Db;
  clock: Clock;
  writer: Writer;
  fred: Fred | null;
};

// a series the server will not keep, said to the caller as it is
export class Refused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Refused";
  }
}

export type AddResult =
  | { kind: "off"; message: typeof NO_DATA }
  // stored already, with bars
  | { kind: "known"; instrument: Instrument }
  | ({ kind: "added"; instrument: Instrument; meta: SeriesMeta } & Written);

const SERIES_ID = /^[A-Z0-9_]{1,40}$/;

// "DGS10" or "FRED:DGS10" to the series id, any case
export function seriesId(input: string): string {
  let id = input.trim().toUpperCase();
  if (id.startsWith(`${MARKET}:`)) id = id.slice(MARKET.length + 1);
  if (!SERIES_ID.test(id)) {
    throw new SourceError("bad request", "not a FRED series id");
  }
  return id;
}

// FRED's long units name what a value is; a price per barrel or any
// other unit outside the list is unknown, never a guess
export function unitOf(meta: Pick<SeriesMeta, "units" | "unitsShort">): Unit {
  if (meta.unitsShort === "%" || /^percent$/i.test(meta.units)) {
    return "percent";
  }
  if (/^index\b/i.test(meta.units)) return "index_points";
  return "unknown";
}

function fields(meta: SeriesMeta): InstrumentFields {
  return {
    market: MARKET,
    symbol: meta.id,
    source: SOURCE,
    sourceSymbol: meta.id,
    exchange: MARKET,
    name: meta.title,
    type: TYPE,
    currency: null,
    unit: unitOf(meta),
    zone: ZONE,
  };
}

// Every observation date is a closed day, so any date before today is
// final; weeks are final once their Sunday has ended in UTC. Only the
// weekly build reads it: FRED has no session to store.
function today(now: number): Session {
  const start = startOfDate(ZONE, dateOfWall(now));
  return { zone: ZONE, start, end: start + DAY_MS - 1 };
}

const barsOf = (answer: Observations): Bar[] =>
  answer.observations.map((o) => ({
    date: o.date,
    open: null,
    high: null,
    low: null,
    close: o.value,
    volume: null,
    final: true,
  }));

// The answer's values replace the stored ones, and a stored day inside
// its span that it now leaves out (a "." or no row) goes. The weeks
// from the span on are built again, so one whose Sunday has passed
// turns final.
function store(
  db: Db,
  instrument: Instrument,
  answer: Observations,
  now: number,
): Written {
  const bars = barsOf(answer);
  const written = upsertBars(db, instrument.id, "1d", bars, answer.fetchedAt);
  let deleted: string | null = null;
  const first = answer.dates[0];
  const last = answer.dates.at(-1);
  if (first !== undefined && last !== undefined) {
    const keep = new Set(bars.map((b) => b.date));
    deleted = deleteDailyBars(db, instrument.id, first, last, keep);
  }
  const changedFrom = earliest(deleted, written.changedFrom);
  const from = earliest(changedFrom, first ?? null);
  if (from !== null) rebuildWeeks(db, instrument.id, today(now), now, from);
  return { rows: written.rows, changedFrom };
}

// The Monday on or before ten years back, so the first week is whole;
// a series that keeps less answers what it has.
export function backfillStart(now: number): string {
  const day = dateOfWall(now);
  const back = `${Number(day.slice(0, 4)) - BACKFILL_YEARS}${day.slice(4)}`;
  return weekOf(back.endsWith("-02-29") ? addDays(back, -1) : back);
}

function source(ctx: FredContext): Fred {
  if (ctx.fred === null) throw new Refused(NO_DATA);
  return ctx.fred;
}

// The series and ten years of its observations, stored together, for a
// tool reading FRED:<id> it has not seen. Only daily series are kept,
// since signals assume daily bars; one whose notes restrict passing the
// values on is still kept for the server's own callers.
export async function addSeries(
  ctx: FredContext,
  input: string,
): Promise<AddResult> {
  if (ctx.fred === null) return { kind: "off", message: NO_DATA };
  const id = seriesId(input);
  const key = `${MARKET}:${id}`;
  const known = readInstrument(ctx.db, key);
  if (known !== null && dailyRange(ctx.db, key) !== null) {
    return { kind: "known", instrument: known };
  }
  const client = ctx.fred;
  const meta = await client.series(id);
  if (meta.id.toUpperCase() !== id) {
    throw new SourceError("malformed answer", `${id} answered as ${meta.id}`);
  }
  if (meta.frequencyShort !== "D") throw new Refused(DAILY_ONLY);
  return exclusive(ctx.db, key, async () => {
    // another call may have added it while this one asked
    const stored = readInstrument(ctx.db, key);
    if (stored !== null && dailyRange(ctx.db, key) !== null) {
      return { kind: "known", instrument: stored };
    }
    const answer = await client.observations(id, {
      start: backfillStart(ctx.clock.now()),
    });
    return ctx.writer.write((db) => {
      const now = ctx.clock.now();
      const instrument = upsertInstrument(db, fields(meta), now);
      return {
        kind: "added",
        instrument,
        meta,
        ...store(db, instrument, answer, now),
      };
    });
  });
}

// The last 30 observations, so late and revised values land; after a
// gap longer than those, again from the last stored day. A series with
// no bars yet is backfilled.
export function refetchSeries(
  ctx: FredContext,
  instrument: Instrument,
): Promise<Written> {
  const client = source(ctx);
  return exclusive(ctx.db, instrument.id, async () => {
    const range = dailyRange(ctx.db, instrument.id);
    let answer = await client.observations(
      instrument.sourceSymbol,
      range === null
        ? { start: backfillStart(ctx.clock.now()) }
        : { limit: REFETCH_OBSERVATIONS },
    );
    const oldest = answer.dates[0];
    if (range !== null && oldest !== undefined && oldest > range.last) {
      answer = await client.observations(instrument.sourceSymbol, {
        start: range.last,
      });
    }
    return ctx.writer.write((db) =>
      store(db, instrument, answer, ctx.clock.now()),
    );
  });
}
