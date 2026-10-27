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
import {
  type Instrument,
  type InstrumentFields,
  readInstrument,
  type Unit,
  upsertInstrument,
} from "../instruments.ts";
import type { RuleHooks } from "../rules/hooks.ts";
import { type Clock, DAY_MS } from "../runtime/clock.ts";
import { exclusive } from "../runtime/lock.ts";
import { signalsAfterBars } from "../signals/store.ts";
import { DeadlinePassed, Refused, SourceError } from "../source.ts";
import { FRED_MARKET } from "../sources/ids.ts";
import type { Db } from "../storage/db/index.ts";
import type { Writer } from "../storage/writer.ts";
import { dateOfWall, startOfDate } from "../zone.ts";
import {
  type Fred,
  type Observations,
  type SeriesMeta,
  SOURCE,
} from "./client.ts";

export const MARKET = FRED_MARKET;
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

// db is for reads; writes go through writer; null while the source is off
export type FredContext = {
  db: Db;
  clock: Clock;
  writer: Writer;
  fred: Fred | null;
  // told when a series' run ends; none in tests that need no rules
  rules?: RuleHooks;
};

export type AddResult =
  | { kind: "off"; message: typeof NO_DATA }
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

// keyed by the id asked for, uppercase, as the lock is
function fields(id: string, meta: SeriesMeta): InstrumentFields {
  return {
    market: MARKET,
    symbol: id,
    source: SOURCE,
    sourceSymbol: id,
    exchange: MARKET,
    name: meta.title,
    type: TYPE,
    currency: null,
    unit: unitOf(meta),
    zone: ZONE,
  };
}

// for the weekly build only: FRED has no session, every date a closed day
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

// a stored day the answer's span no longer holds goes (a "." or no row)
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
  signalsAfterBars(db, instrument, changedFrom, now);
  return { rows: written.rows, changedFrom };
}

// The Monday on or before ten years back, so the first week is whole;
// a series that keeps less answers what it has.
export function backfillStart(now: number): string {
  const day = dateOfWall(now);
  const back = `${Number(day.slice(0, 4)) - BACKFILL_YEARS}${day.slice(4)}`;
  // ten years before a 29 February is no leap year
  return weekOf(back.endsWith("-02-29") ? `${back.slice(0, 8)}28` : back);
}

function source(ctx: FredContext): Fred {
  if (ctx.fred === null) throw new Refused(NO_DATA);
  return ctx.fred;
}

// daily series only, since every signal assumes daily bars
export async function addSeries(
  ctx: FredContext,
  input: string,
  live: () => boolean = () => true,
): Promise<AddResult> {
  if (ctx.fred === null) return { kind: "off", message: NO_DATA };
  const id = seriesId(input);
  const key = `${MARKET}:${id}`;
  const known = readInstrument(ctx.db, key);
  if (known !== null && dailyRange(ctx.db, key) !== null) {
    return { kind: "known", instrument: known };
  }
  const client = ctx.fred;
  if (!live()) throw new DeadlinePassed();
  const meta = await client.series(id);
  // neither id is repeated: an echoed one is the source's text
  if (meta.id.toUpperCase() !== id) {
    throw new SourceError("malformed answer", "another series answered");
  }
  if (meta.frequencyShort !== "D") throw new Refused(DAILY_ONLY);
  return exclusive(ctx.db, key, async () => {
    // another call may have added it while this one asked
    const stored = readInstrument(ctx.db, key);
    if (stored !== null && dailyRange(ctx.db, key) !== null) {
      return { kind: "known", instrument: stored };
    }
    if (!live()) throw new DeadlinePassed();
    const answer = await client.observations(id, {
      start: backfillStart(ctx.clock.now()),
    });
    return ctx.writer.write((db) => {
      if (!live()) throw new DeadlinePassed();
      const now = ctx.clock.now();
      const instrument = upsertInstrument(db, fields(id, meta), now);
      return {
        kind: "added",
        instrument,
        meta,
        ...store(db, instrument, answer, now),
      };
    });
  });
}

// after a gap past 30 observations, asked again from the last stored day;
// whole asks from the first stored day, as after a parser fix
export function refetchSeries(
  ctx: FredContext,
  instrument: Instrument,
  live: () => boolean = () => true,
  whole = false,
): Promise<Written> {
  const client = source(ctx);
  return exclusive(ctx.db, instrument.id, async () => {
    if (!live()) throw new DeadlinePassed();
    const range = dailyRange(ctx.db, instrument.id);
    const start = backfillStart(ctx.clock.now());
    let answer = await client.observations(
      instrument.sourceSymbol,
      range === null
        ? { start }
        : whole
          ? { start: earliest(range.first, start)! }
          : { limit: REFETCH_OBSERVATIONS },
    );
    const oldest = answer.dates[0];
    if (range !== null && oldest !== undefined && oldest > range.last) {
      if (!live()) throw new DeadlinePassed();
      answer = await client.observations(instrument.sourceSymbol, {
        start: range.last,
      });
    }
    return ctx.writer.write((db) => {
      if (!live()) throw new DeadlinePassed();
      return store(db, instrument, answer, ctx.clock.now());
    });
  });
}
