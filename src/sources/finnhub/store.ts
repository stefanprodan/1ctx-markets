// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// a run per section, scoped to the instrument, so one failure is stale alone

import type { Instrument } from "../../market/instruments.ts";
import { dateOfWall, localDate } from "../../market/zone.ts";
import { DAY_MS, MINUTE_MS } from "../../runtime/clock.ts";
import { monthsBack } from "../../signals/relative.ts";
import type { Db } from "../../storage/db/index.ts";
import { phraseOf } from "../source.ts";
import {
  type Analysts,
  type Answer,
  type CalendarEvent,
  type Earnings,
  type Insider,
  METRIC_FIELDS,
  type Metric,
  SOURCE,
} from "./client.ts";

export const SECTIONS = [
  "metric",
  "analysts",
  "earnings",
  "insider",
  "calendar",
] as const;
export type Section = (typeof SECTIONS)[number];

// what a read answers while the source is off, never an error
export const NO_DATA = "no data from Finnhub";
export const NOT_COVERED =
  "no data from Finnhub: it covers US-listed equities only";
export const NO_EVENTS = "no event source";
// beside rows Finnhub answered for another listing of the share's company
export const OTHER_LISTING =
  "from another listing of the company on Finnhub, without the values that depend on the listing";

export const RESEARCH_KEPT_MONTHS = 24;
export const EVENTS_KEPT_MONTHS = 24;
// the calendar asked from this far back to this far ahead
export const CALENDAR_BACK_DAYS = 120;
export const CALENDAR_AHEAD_DAYS = 90;
export const INSIDER_MONTHS = 12;

// rules answer these, so retention keeps them
export type EventKey = {
  instrument: string;
  fiscalYear: number;
  fiscalQuarter: number;
};

export type Hooks = {
  waited(db: Db, now: number): EventKey[];
  // inside the write that first saw an event's actuals
  reported?(db: Db, events: readonly EventKey[], now: number): void;
};

export const NO_HOOKS: Hooks = { waited: () => [] };

// Finnhub's free key covers US listings, and only shares answer: ETFs,
// indices, futures, FX, crypto and FRED are never asked.
export function eligible(i: Pick<Instrument, "market" | "type">): boolean {
  return i.market === "US" && i.type === "EQUITY";
}

// a class share is BRK-B on Yahoo and BRK.B on Finnhub
export const finnhubSymbol = (i: Pick<Instrument, "symbol">): string =>
  i.symbol.replaceAll("-", ".");

export type Fetched =
  | { section: "metric"; answer: Answer<Metric> }
  | { section: "analysts"; answer: Answer<Analysts[]> }
  | { section: "earnings"; answer: Answer<Earnings[]> }
  | { section: "insider"; answer: Answer<Insider[]> }
  | { section: "calendar"; answer: Answer<CalendarEvent[]> };

// columns in kept hold a value once seen when a later answer leaves it
// out, as an earnings actual does
const upsertResearch = (
  db: Db,
  instrument: string,
  kind: string,
  period: string,
  values: Record<string, number | null>,
  listing: string | null,
  fetchedAt: number,
  kept: readonly string[] = [],
) => {
  const columns = Object.keys(values);
  const set = (c: string) =>
    kept.includes(c)
      ? `${c} = coalesce(excluded.${c}, research.${c})`
      : `${c} = excluded.${c}`;
  db.query(
    `insert into research (instrument, kind, period, ${columns.join(", ")},
       listing, fetched_at)
     values (?, ?, ?, ${columns.map(() => "?").join(", ")}, ?, ?)
     on conflict (instrument, kind, period) do update set
       ${columns.map(set).join(", ")},
       listing = excluded.listing,
       fetched_at = excluded.fetched_at`,
  ).run(instrument, kind, period, ...Object.values(values), listing, fetchedAt);
};

// an actual, and the surprise worked out from it, never go back to null
const EARNINGS_KEPT = ["eps_actual", "surprise", "surprise_percent"];

export const METRIC_COLUMNS: Record<keyof Metric, string> = {
  forwardPE: "forward_pe",
  forwardPEG: "forward_peg",
  peTTM: "pe_ttm",
  psTTM: "ps_ttm",
  pb: "pb",
  epsGrowthTTMYoy: "eps_growth_ttm_yoy",
  revenueGrowthTTMYoy: "revenue_growth_ttm_yoy",
  netMarginTTM: "net_margin_ttm",
  roeTTM: "roe_ttm",
  currentRatioQuarterly: "current_ratio_quarterly",
  debtToEquityQuarterly: "debt_to_equity_quarterly",
  dividendYieldTTM: "dividend_yield_ttm",
  beta: "beta",
};

// By fiscal quarter, so a moved date updates the event; actuals are
// kept, but never across listings, whose figures are another currency's.
export function upsertEvents(
  db: Db,
  instrument: string,
  events: readonly CalendarEvent[],
  listing: string | null,
  fetchedAt: number,
): EventKey[] {
  const before = db.query<{ seen: number | null }, [string, number, number]>(
    `select reported_seen_at as seen from events
     where instrument = ? and fiscal_year = ? and fiscal_quarter = ?`,
  );
  const upsert = db.query(
    `insert into events (instrument, fiscal_year, fiscal_quarter, date, hour,
       eps_estimate, eps_actual, revenue_estimate, revenue_actual,
       reported_seen_at, listing, fetched_at)
     values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9,
       case when ?11 then ?10 end, ?12, ?10)
     on conflict (instrument, fiscal_year, fiscal_quarter) do update set
       date = excluded.date,
       hour = excluded.hour,
       eps_estimate = excluded.eps_estimate,
       eps_actual = case when excluded.listing is events.listing
         then coalesce(excluded.eps_actual, events.eps_actual)
         else excluded.eps_actual end,
       revenue_estimate = excluded.revenue_estimate,
       revenue_actual = case when excluded.listing is events.listing
         then coalesce(excluded.revenue_actual, events.revenue_actual)
         else excluded.revenue_actual end,
       reported_seen_at = coalesce(events.reported_seen_at,
         excluded.reported_seen_at),
       listing = excluded.listing,
       fetched_at = excluded.fetched_at
     where excluded.fetched_at >= events.fetched_at`,
  );
  const reported: EventKey[] = [];
  for (const e of events) {
    const was = before.get(instrument, e.fiscalYear, e.fiscalQuarter);
    // the research pass and the market calendar fetch apart and write in
    // either order; an answer older than the stored one is not newer news
    const { changes } = upsert.run(
      instrument,
      e.fiscalYear,
      e.fiscalQuarter,
      e.date,
      e.hour,
      e.epsEstimate,
      e.epsActual,
      e.revenueEstimate,
      e.revenueActual,
      fetchedAt,
      e.reported ? 1 : 0,
      listing,
    );
    if (changes === 0) continue;
    if (e.reported && (was === null || was.seen === null)) {
      reported.push({
        instrument,
        fiscalYear: e.fiscalYear,
        fiscalQuarter: e.fiscalQuarter,
      });
    }
  }
  return reported;
}

const eventKey = (k: EventKey) =>
  `${k.instrument}|${k.fiscalYear}|${k.fiscalQuarter}`;

// an event a rule waits on stays, as retention keeps it
function dropEvents(
  db: Db,
  events: readonly EventKey[],
  held: readonly EventKey[],
): number {
  const keep = new Set(held.map(eventKey));
  const del = db.query(
    `delete from events where instrument = ? and fiscal_year = ?
       and fiscal_quarter = ?`,
  );
  let n = 0;
  for (const k of events) {
    if (keep.has(eventKey(k))) continue;
    n += del.run(k.instrument, k.fiscalYear, k.fiscalQuarter).changes;
  }
  return n;
}

// no data writes no row; an answer naming a listing replaces the kind's rows of
// any other, so no figure of one listing is read as another's
export function storeSection(
  db: Db,
  instrument: string,
  f: Fetched,
  hooks: Hooks,
): number {
  const { answer } = f;
  const { listing } = answer;
  if (answer.data === null && listing === null) return 0;
  const at = answer.fetchedAt;
  let rows = 0;
  switch (f.section) {
    case "metric": {
      db.query(
        "delete from research where instrument = ? and kind = 'metric'",
      ).run(instrument);
      const m = f.answer.data;
      if (m === null) return 0;
      const values: Record<string, number | null> = {};
      for (const k of Object.keys(METRIC_FIELDS) as (keyof Metric)[]) {
        values[METRIC_COLUMNS[k]] = m[k];
      }
      upsertResearch(
        db,
        instrument,
        "metric",
        dateOfWall(at),
        values,
        listing,
        at,
      );
      return 1;
    }
    case "analysts":
      for (const r of f.answer.data ?? []) {
        upsertResearch(
          db,
          instrument,
          "analysts",
          r.period,
          {
            strong_buy: r.strongBuy,
            buy: r.buy,
            hold: r.hold,
            sell: r.sell,
            strong_sell: r.strongSell,
          },
          listing,
          at,
        );
        rows++;
      }
      break;
    case "earnings":
      for (const r of f.answer.data ?? []) {
        // a quarter not ended by its fetch day is a mislabelled report
        if (r.period > localDate("UTC", at)) continue;
        upsertResearch(
          db,
          instrument,
          "earnings",
          r.period,
          {
            eps_estimate: r.estimate,
            eps_actual: r.actual,
            surprise: r.surprise,
            surprise_percent: r.surprisePercent,
          },
          listing,
          at,
          EARNINGS_KEPT,
        );
        rows++;
      }
      break;
    case "insider":
      for (const r of f.answer.data ?? []) {
        upsertResearch(
          db,
          instrument,
          "insider",
          r.period,
          { insider_change: r.change, mspr: r.mspr },
          listing,
          at,
        );
        rows++;
      }
      break;
    case "calendar": {
      const events = f.answer.data ?? [];
      const reported = upsertEvents(db, instrument, events, listing, at);
      if (reported.length > 0) hooks.reported?.(db, reported, at);
      // a row newer than this answer was kept by upsertEvents; never drop it
      const stale = db
        .query<EventKey, [string, string | null, number]>(
          `select instrument, fiscal_year as fiscalYear,
             fiscal_quarter as fiscalQuarter
           from events where instrument = ? and listing is not ?
             and fetched_at <= ?`,
        )
        .all(instrument, listing, at);
      if (stale.length > 0) dropEvents(db, stale, hooks.waited(db, at));
      return events.length;
    }
  }
  db.query(
    "delete from research where instrument = ? and kind = ? and listing is not ?",
  ).run(instrument, f.section, listing);
  return rows;
}

export function recordRun(
  db: Db,
  scope: string,
  job: string,
  startedAt: number,
  now: number,
  outcome: { rows: number } | { error: unknown },
): void {
  const failed = "error" in outcome;
  db.query(
    `insert into sync_runs (source, job, scope, started_at, ended_at, status,
       rows, error)
     values (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    SOURCE,
    job,
    scope,
    startedAt,
    now,
    failed ? "failed" : "ok",
    failed ? 0 : outcome.rows,
    failed ? phraseOf(outcome.error) : null,
  );
}

// the time of day, UTC, the daily refresh is due: after the US close
// and the after-market reports
export const DAILY_AT_MS = 23 * 60 * MINUTE_MS;

// the latest 23:00 UTC at or before now
export function dueAt(now: number): number {
  return Math.floor((now - DAILY_AT_MS) / DAY_MS) * DAY_MS + DAILY_AT_MS;
}

export function pruneResearch(
  db: Db,
  now: number,
  held: readonly EventKey[] = [],
): number {
  const cut = monthsBack(dateOfWall(now), RESEARCH_KEPT_MONTHS);
  let n = db
    .query("delete from research where kind <> 'metric' and period < ?")
    .run(cut).changes;
  const old = db
    .query<EventKey, [string]>(
      `select instrument, fiscal_year as fiscalYear,
         fiscal_quarter as fiscalQuarter from events where date < ?`,
    )
    .all(monthsBack(dateOfWall(now), EVENTS_KEPT_MONTHS));
  n += dropEvents(db, old, held);
  return n;
}
