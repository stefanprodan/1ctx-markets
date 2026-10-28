// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Instrument } from "../../market/instruments.ts";
import { addDays, localDate } from "../../market/zone.ts";
import type { Db } from "../../storage/db/index.ts";
import { failedRun, lastStarted } from "../../storage/runs.ts";
import { SOURCE } from "./client.ts";
import { dueAt, type EventKey, METRIC_COLUMNS, type Section } from "./store.ts";

export const STALE_RESEARCH = {
  failed: "research sync failed",
  pending: "research sync pending",
  none: "no research yet",
  // the rows shown are from an earlier answer
  noData: "no data in the last answer",
} as const;

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
  // a run cut by shutdown is no failure: the next run settles it
  if (failedRun(last)) stale.push(STALE_RESEARCH.failed);
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
  listing: string | null;
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
      `select period, ${KIND[kind].join(", ")}, listing,
         fetched_at as fetchedAt
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
  listing: string | null;
  fetchedAt: number;
};

const EVENT_SELECT = `select instrument, fiscal_year as fiscalYear,
  fiscal_quarter as fiscalQuarter, date, hour, eps_estimate as epsEstimate,
  eps_actual as epsActual, revenue_estimate as revenueEstimate,
  revenue_actual as revenueActual, reported_seen_at as reportedSeenAt,
  listing, fetched_at as fetchedAt from events`;

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

// the earliest event from the exchange's today, or one of the last week
// awaiting results; unreported skips any with actuals seen, as a gate would
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

// Only actuals report an event, stored or, for another listing, only
// seen: a passed date or an amc label never do.
export function eventStatus(
  e: Pick<EventRow, "date" | "reportedSeenAt">,
  today: string,
): EventStatus {
  if (e.reportedSeenAt !== null) return "reported";
  return e.date > today ? "scheduled" : "awaiting results";
}
