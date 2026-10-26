// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// a run per section, scoped to the instrument, so one failure is stale alone

import type { Clock } from "../clock.ts";
import { DAY_MS, MINUTE_MS } from "../clock.ts";
import type { Db } from "../db/index.ts";
import type { Instrument } from "../instruments.ts";
import { exclusive } from "../lock.ts";
import { lastStarted } from "../runs.ts";
import { monthsBack } from "../signals/relative.ts";
import { DeadlinePassed, Paused, phraseOf, QueueClosed } from "../source.ts";
import type { Writer } from "../writer.ts";
import { WriterClosed } from "../writer.ts";
import { addDays, dateOfWall, localDate } from "../zone.ts";
import {
  type Analysts,
  type Answer,
  type CalendarEvent,
  type Earnings,
  type Finnhub,
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

export const RESEARCH_KEPT_MONTHS = 24;
export const EVENTS_KEPT_MONTHS = 24;
// the calendar asked from this far back to this far ahead
export const CALENDAR_BACK_DAYS = 120;
export const CALENDAR_AHEAD_DAYS = 90;
export const INSIDER_MONTHS = 12;

export const STALE_RESEARCH = {
  failed: "research sync failed",
  pending: "research sync pending",
  none: "no research yet",
  // the rows shown are from an earlier answer
  noData: "no data in the last answer",
} as const;

// db is for reads; writes go through writer; null while the source is off
export type FinnhubContext = {
  db: Db;
  clock: Clock;
  writer: Writer;
  finnhub: Finnhub | null;
};

// rules answer these, so the calendar is asked hourly and retention keeps it
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

export type SectionResult =
  | { section: Section; status: "ok"; rows: number; startedAt: number }
  | { section: Section; status: "failed"; error: unknown; startedAt: number };

type Fetched =
  | { section: "metric"; answer: Answer<Metric> }
  | { section: "analysts"; answer: Answer<Analysts[]> }
  | { section: "earnings"; answer: Answer<Earnings[]> }
  | { section: "insider"; answer: Answer<Insider[]> }
  | { section: "calendar"; answer: Answer<CalendarEvent[]> };

type Outcome =
  | { fetched: Fetched; startedAt: number }
  | { section: Section; error: unknown; startedAt: number };

function ask(
  client: Finnhub,
  symbol: string,
  section: Section,
  now: number,
): Promise<Fetched> {
  const today = dateOfWall(now);
  switch (section) {
    case "metric":
      return client.metric(symbol).then((answer) => ({ section, answer }));
    case "analysts":
      return client.analysts(symbol).then((answer) => ({ section, answer }));
    case "earnings":
      return client.earnings(symbol).then((answer) => ({ section, answer }));
    case "insider":
      return client
        .insider(symbol, monthsBack(today, INSIDER_MONTHS), today)
        .then((answer) => ({ section, answer }));
    case "calendar":
      return client
        .calendar(
          symbol,
          addDays(today, -CALENDAR_BACK_DAYS),
          addDays(today, CALENDAR_AHEAD_DAYS),
        )
        .then((answer) => ({ section, answer }));
  }
}

// a closing server or a read past its deadline says nothing about the
// source, so no run is recorded for it
const aborts = (error: unknown): boolean =>
  error instanceof QueueClosed ||
  error instanceof WriterClosed ||
  error instanceof DeadlinePassed;

// columns in kept hold a value once seen when a later answer leaves it
// out, as an earnings actual does
const upsertResearch = (
  db: Db,
  instrument: string,
  kind: string,
  period: string,
  values: Record<string, number | null>,
  fetchedAt: number,
  kept: readonly string[] = [],
) => {
  const columns = Object.keys(values);
  const set = (c: string) =>
    kept.includes(c)
      ? `${c} = coalesce(excluded.${c}, research.${c})`
      : `${c} = excluded.${c}`;
  db.query(
    `insert into research (instrument, kind, period, ${columns.join(", ")}, fetched_at)
     values (?, ?, ?, ${columns.map(() => "?").join(", ")}, ?)
     on conflict (instrument, kind, period) do update set
       ${columns.map(set).join(", ")},
       fetched_at = excluded.fetched_at`,
  ).run(instrument, kind, period, ...Object.values(values), fetchedAt);
};

// an actual, and the surprise worked out from it, never go back to null
const EARNINGS_KEPT = ["eps_actual", "surprise", "surprise_percent"];

const METRIC_COLUMNS: Record<keyof Metric, string> = {
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

// by fiscal quarter, so a moved date updates the event; actuals are kept
function upsertEvents(
  db: Db,
  instrument: string,
  events: readonly CalendarEvent[],
  fetchedAt: number,
): EventKey[] {
  const before = db.query<{ seen: number | null }, [string, number, number]>(
    `select reported_seen_at as seen from events
     where instrument = ? and fiscal_year = ? and fiscal_quarter = ?`,
  );
  const upsert = db.query(
    `insert into events (instrument, fiscal_year, fiscal_quarter, date, hour,
       eps_estimate, eps_actual, revenue_estimate, revenue_actual,
       reported_seen_at, fetched_at)
     values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9,
       case when ?7 is not null or ?9 is not null then ?10 end, ?10)
     on conflict (instrument, fiscal_year, fiscal_quarter) do update set
       date = excluded.date,
       hour = excluded.hour,
       eps_estimate = excluded.eps_estimate,
       eps_actual = coalesce(excluded.eps_actual, events.eps_actual),
       revenue_estimate = excluded.revenue_estimate,
       revenue_actual = coalesce(excluded.revenue_actual, events.revenue_actual),
       reported_seen_at = coalesce(events.reported_seen_at,
         excluded.reported_seen_at),
       fetched_at = excluded.fetched_at`,
  );
  const reported: EventKey[] = [];
  for (const e of events) {
    const was = before.get(instrument, e.fiscalYear, e.fiscalQuarter);
    upsert.run(
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
    );
    const actual = e.epsActual !== null || e.revenueActual !== null;
    if (actual && (was === null || was.seen === null)) {
      reported.push({
        instrument,
        fiscalYear: e.fiscalYear,
        fiscalQuarter: e.fiscalQuarter,
      });
    }
  }
  return reported;
}

// one section's answer into its rows; no data writes none
function storeSection(
  db: Db,
  instrument: string,
  f: Fetched,
  hooks: Hooks,
): number {
  const { answer } = f;
  if (answer.data === null) return 0;
  const at = answer.fetchedAt;
  switch (f.section) {
    case "metric": {
      const m = f.answer.data!;
      const values: Record<string, number | null> = {};
      for (const k of Object.keys(METRIC_FIELDS) as (keyof Metric)[]) {
        values[METRIC_COLUMNS[k]] = m[k];
      }
      db.query(
        "delete from research where instrument = ? and kind = 'metric'",
      ).run(instrument);
      upsertResearch(db, instrument, "metric", dateOfWall(at), values, at);
      return 1;
    }
    case "analysts":
      for (const r of f.answer.data!) {
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
          at,
        );
      }
      return f.answer.data!.length;
    case "earnings":
      for (const r of f.answer.data!) {
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
          at,
          EARNINGS_KEPT,
        );
      }
      return f.answer.data!.length;
    case "insider":
      for (const r of f.answer.data!) {
        upsertResearch(
          db,
          instrument,
          "insider",
          r.period,
          { insider_change: r.change, mspr: r.mspr },
          at,
        );
      }
      return f.answer.data!.length;
    case "calendar": {
      const reported = upsertEvents(db, instrument, f.answer.data!, at);
      if (reported.length > 0) hooks.reported?.(db, reported, at);
      return f.answer.data!.length;
    }
  }
}

function recordRun(
  db: Db,
  instrument: string,
  section: Section,
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
    section,
    instrument,
    startedAt,
    now,
    failed ? "failed" : "ok",
    failed ? 0 : outcome.rows,
    failed ? phraseOf(outcome.error) : null,
  );
}

// fetched sections land in one write; a Paused refusal stores those before
// it, a passed deadline none
export async function refreshResearch(
  ctx: FinnhubContext,
  instrument: Instrument,
  sections: readonly Section[] = SECTIONS,
  options: {
    live?: () => boolean;
    hooks?: Hooks;
    client?: Finnhub;
    // only those still without a good run once the lock is held, so a
    // call that waited on another's fetch asks nothing it stored
    unfetched?: boolean;
  } = {},
): Promise<SectionResult[]> {
  const client = options.client ?? ctx.finnhub;
  if (client === null) throw new Error("finnhub is off");
  const live = options.live ?? (() => true);
  const hooks = options.hooks ?? NO_HOOKS;
  const symbol = finnhubSymbol(instrument);
  // its own lock key, so research never waits on the instrument's bar fetch
  return exclusive(ctx.db, `${SOURCE}:${instrument.id}`, async () => {
    const asked = options.unfetched
      ? unfetched(ctx.db, instrument.id, sections)
      : sections;
    if (asked.length === 0) return [];
    const outcomes: Outcome[] = [];
    let paused: Paused | null = null;
    for (const section of asked) {
      if (!live()) throw new DeadlinePassed();
      const startedAt = ctx.clock.now();
      try {
        const fetched = await ask(client, symbol, section, startedAt);
        outcomes.push({ fetched, startedAt });
      } catch (error) {
        if (aborts(error)) throw error;
        // no run: it would hold off the job's retry
        if (error instanceof Paused) {
          paused = error;
          break;
        }
        outcomes.push({ section, error, startedAt });
      }
    }
    if (paused === null) return store(outcomes);
    if (outcomes.length > 0) await store(outcomes);
    throw paused;
  });

  function store(outcomes: readonly Outcome[]): Promise<SectionResult[]> {
    return ctx.writer.write((db) => {
      if (!live()) throw new DeadlinePassed();
      const now = ctx.clock.now();
      return outcomes.map((o): SectionResult => {
        if ("error" in o) {
          recordRun(db, instrument.id, o.section, o.startedAt, now, o);
          return { ...o, status: "failed" };
        }
        const rows = storeSection(db, instrument.id, o.fetched, hooks);
        recordRun(db, instrument.id, o.fetched.section, o.startedAt, now, {
          rows,
        });
        return {
          section: o.fetched.section,
          status: "ok",
          rows,
          startedAt: o.startedAt,
        };
      });
    });
  }
}

// the time of day, UTC, the daily refresh is due: after the US close
// and the after-market reports
export const DAILY_AT_MS = 23 * 60 * MINUTE_MS;

// the latest 23:00 UTC at or before now
export function dueAt(now: number): number {
  return Math.floor((now - DAILY_AT_MS) / DAY_MS) * DAY_MS + DAILY_AT_MS;
}

// due when no run of the section has ended well since the latest 23:00
export function sectionDue(
  db: Db,
  instrument: string,
  section: Section,
  now: number,
): boolean {
  const ok = lastStarted(db, SOURCE, section, instrument, "ok");
  return ok === null || ok.startedAt < dueAt(now);
}

// the sections of these that never ended well
export function unfetched(
  db: Db,
  instrument: string,
  sections: readonly Section[],
): Section[] {
  return sections.filter(
    (s) => lastStarted(db, SOURCE, s, instrument, "ok") === null,
  );
}

export type SectionState = {
  // when the section's last good run ended, null before the first
  fetchedAt: number | null;
  // the last good run answered no data
  noData: boolean;
  stale: string[];
};

function hasRows(db: Db, instrument: string, section: Section): boolean {
  const sql =
    section === "calendar"
      ? "select count(*) as n from events where instrument = ?"
      : "select count(*) as n from research where instrument = ? and kind = ?";
  const args = section === "calendar" ? [instrument] : [instrument, section];
  return (db.query(sql).get(...args) as { n: number }).n > 0;
}

export function sectionState(
  db: Db,
  instrument: string,
  section: Section,
  now: number,
): SectionState {
  const ok = lastStarted(db, SOURCE, section, instrument, "ok");
  const last = lastStarted(db, SOURCE, section, instrument);
  const stale: string[] = [];
  if (ok === null) stale.push(STALE_RESEARCH.none);
  if (last?.status === "failed") stale.push(STALE_RESEARCH.failed);
  else if (ok !== null && ok.startedAt < dueAt(now)) {
    stale.push(STALE_RESEARCH.pending);
  }
  const noData = ok !== null && ok.rows === 0;
  if (noData && hasRows(db, instrument, section)) {
    stale.push(STALE_RESEARCH.noData);
  }
  return {
    fetchedAt: ok?.endedAt ?? null,
    noData: ok !== null && ok.rows === 0,
    stale,
  };
}

export type ResearchRow = {
  period: string;
  fetchedAt: number;
} & Record<string, number | string | null>;

const KIND: Record<"analysts" | "earnings" | "insider" | "metric", string[]> = {
  analysts: ["strong_buy", "buy", "hold", "sell", "strong_sell"],
  earnings: ["eps_estimate", "eps_actual", "surprise", "surprise_percent"],
  insider: ["insider_change", "mspr"],
  metric: Object.values(METRIC_COLUMNS),
};

export type ResearchKind = keyof typeof KIND;
export const kindColumns = (kind: ResearchKind): readonly string[] =>
  KIND[kind];

// newest first
export function readResearch(
  db: Db,
  instrument: string,
  kind: ResearchKind,
  limit = -1,
): ResearchRow[] {
  return db
    .query<ResearchRow, [string, string, number]>(
      `select period, ${KIND[kind].join(", ")}, fetched_at as fetchedAt
       from research where instrument = ? and kind = ?
       order by period desc limit ?`,
    )
    .all(instrument, kind, limit);
}

export type EventRow = {
  instrument: string;
  fiscalYear: number;
  fiscalQuarter: number;
  date: string;
  hour: string;
  epsEstimate: number | null;
  epsActual: number | null;
  revenueEstimate: number | null;
  revenueActual: number | null;
  reportedSeenAt: number | null;
  fetchedAt: number;
};

const EVENT_SELECT = `select instrument, fiscal_year as fiscalYear,
  fiscal_quarter as fiscalQuarter, date, hour, eps_estimate as epsEstimate,
  eps_actual as epsActual, revenue_estimate as revenueEstimate,
  revenue_actual as revenueActual, reported_seen_at as reportedSeenAt,
  fetched_at as fetchedAt from events`;

// by date, then instrument and fiscal key
export function readEvents(
  db: Db,
  from: string,
  to: string,
  instruments: readonly string[] | null = null,
): EventRow[] {
  const rows = db
    .query<EventRow, [string, string]>(
      `${EVENT_SELECT} where date >= ? and date <= ?
       order by date, instrument, fiscal_year, fiscal_quarter`,
    )
    .all(from, to);
  if (instruments === null) return rows;
  const want = new Set(instruments);
  return rows.filter((r) => want.has(r.instrument));
}

export function readEvent(db: Db, key: EventKey): EventRow | null {
  return (
    db
      .query<EventRow, [string, number, number]>(
        `${EVENT_SELECT} where instrument = ? and fiscal_year = ?
           and fiscal_quarter = ?`,
      )
      .get(key.instrument, key.fiscalYear, key.fiscalQuarter) ?? null
  );
}

// days a passed event still counts as next while it awaits results
export const AWAITING_DAYS = 7;

// The instrument's earliest event dated from its exchange's today on,
// or one of the last week still awaiting its results; unreported skips
// any whose actuals were seen, which a gate waiting on it would pass.
export function nextEvent(
  db: Db,
  instrument: Pick<Instrument, "id" | "zone">,
  now: number,
  unreported = false,
): EventRow | null {
  const today = localDate(instrument.zone, now);
  return (
    db
      .query<EventRow, [string, string, string, number]>(
        `${EVENT_SELECT} where instrument = ?1
           and (date >= ?2 or (reported_seen_at is null and date >= ?3))
           and (?4 = 0 or reported_seen_at is null)
         order by date limit 1`,
      )
      .get(
        instrument.id,
        today,
        addDays(today, -AWAITING_DAYS),
        unreported ? 1 : 0,
      ) ?? null
  );
}

export type EventStatus = "scheduled" | "awaiting results" | "reported";

// Only actuals report an event: a passed date or an amc label never do.
export function eventStatus(
  e: Pick<EventRow, "date" | "reportedSeenAt">,
  today: string,
): EventStatus {
  if (e.reportedSeenAt !== null) return "reported";
  return e.date > today ? "scheduled" : "awaiting results";
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
  const keep = new Set(
    held.map((k) => `${k.instrument}|${k.fiscalYear}|${k.fiscalQuarter}`),
  );
  const old = db
    .query<EventKey, [string]>(
      `select instrument, fiscal_year as fiscalYear,
         fiscal_quarter as fiscalQuarter from events where date < ?`,
    )
    .all(monthsBack(dateOfWall(now), EVENTS_KEPT_MONTHS));
  const del = db.query(
    `delete from events where instrument = ? and fiscal_year = ?
       and fiscal_quarter = ?`,
  );
  for (const k of old) {
    if (keep.has(`${k.instrument}|${k.fiscalYear}|${k.fiscalQuarter}`))
      continue;
    n += del.run(k.instrument, k.fiscalYear, k.fiscalQuarter).changes;
  }
  return n;
}
