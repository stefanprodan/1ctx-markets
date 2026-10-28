// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Research and calendar fetches, each section's answers stored in one write.

import type { Instrument } from "../../market/instruments.ts";
import { addDays, dateOfWall } from "../../market/zone.ts";
import type { Clock } from "../../runtime/clock.ts";
import { exclusive } from "../../runtime/lock.ts";
import { monthsBack } from "../../signals/relative.ts";
import type { Db } from "../../storage/db/index.ts";
import { lastStarted } from "../../storage/runs.ts";
import type { Writer } from "../../storage/writer.ts";
import { WriterClosed } from "../../storage/writer.ts";
import { DeadlinePassed, Paused, QueueClosed } from "../source.ts";
import {
  type Answer,
  type CalendarEvent,
  type Finnhub,
  SOURCE,
} from "./client.ts";
import {
  CALENDAR_AHEAD_DAYS,
  CALENDAR_BACK_DAYS,
  dueAt,
  type EventKey,
  type Fetched,
  finnhubSymbol,
  type Hooks,
  INSIDER_MONTHS,
  NO_HOOKS,
  recordRun,
  SECTIONS,
  type Section,
  storeSection,
  upsertEvents,
} from "./store.ts";

// db is for reads; writes go through writer; null while the source is off
export type FinnhubContext = {
  db: Db;
  clock: Clock;
  writer: Writer;
  finnhub: Finnhub | null;
};

export type SectionResult =
  | { section: Section; status: "ok"; rows: number; startedAt: number }
  | { section: Section; status: "failed"; error: unknown; startedAt: number };

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
    // the calendar first, so earnings asked in the same pass are fetched
    // after any report the calendar first sees; results come back in SECTIONS order
    const fetchOrder = asked.toSorted(
      (a, b) => Number(b === "calendar") - Number(a === "calendar"),
    );
    for (const section of fetchOrder) {
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
    if (paused === null) return inOrder(await store(outcomes));
    if (outcomes.length > 0) await store(outcomes);
    throw paused;
  });

  function inOrder(results: SectionResult[]): SectionResult[] {
    return results.toSorted(
      (a, b) => SECTIONS.indexOf(a.section) - SECTIONS.indexOf(b.section),
    );
  }

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

// The whole-market calendar's run: Finnhub's market calendar holds US
// listings only, which is all eligible() lets it research.
export const MARKET_CALENDAR = { job: "market-calendar", scope: "US" } as const;

export type MarketCalendarResult =
  | {
      status: "ok";
      rows: number;
      // instruments with an event first seen reported in this answer
      reported: string[];
    }
  | { status: "failed"; error: unknown };

// Only events already stored for these shares, of their own listing, are
// updated, through the write a share's calendar uses; a row of any other
// symbol or quarter is ignored, and a missing row deletes nothing, since
// the list changes between calls.
export function storeMarketCalendar(
  ctx: FinnhubContext,
  shares: readonly Instrument[],
  outcome:
    | { answer: Answer<Map<string, CalendarEvent[]>>; startedAt: number }
    | { error: unknown; startedAt: number },
  hooks: Hooks = NO_HOOKS,
): Promise<MarketCalendarResult> {
  const { job, scope } = MARKET_CALENDAR;
  return ctx.writer.write((db): MarketCalendarResult => {
    const now = ctx.clock.now();
    if ("error" in outcome) {
      recordRun(db, scope, job, outcome.startedAt, now, outcome);
      return { status: "failed", error: outcome.error };
    }
    const { answer } = outcome;
    const stored = db.query<
      { fiscalYear: number; fiscalQuarter: number },
      [string]
    >(
      `select fiscal_year as fiscalYear, fiscal_quarter as fiscalQuarter
       from events where instrument = ? and listing is null`,
    );
    const reported: EventKey[] = [];
    let rows = 0;
    for (const share of shares) {
      const answered = answer.data?.get(finnhubSymbol(share));
      if (answered === undefined) continue;
      const own = new Set(
        stored.all(share.id).map((k) => `${k.fiscalYear} Q${k.fiscalQuarter}`),
      );
      const events = answered.filter((e) =>
        own.has(`${e.fiscalYear} Q${e.fiscalQuarter}`),
      );
      if (events.length === 0) continue;
      reported.push(
        ...upsertEvents(db, share.id, events, null, answer.fetchedAt),
      );
      rows += events.length;
    }
    if (reported.length > 0) hooks.reported?.(db, reported, answer.fetchedAt);
    recordRun(db, scope, job, outcome.startedAt, now, { rows });
    return {
      status: "ok",
      rows,
      reported: [...new Set(reported.map((k) => k.instrument))],
    };
  });
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
