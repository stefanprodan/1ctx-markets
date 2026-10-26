// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Finnhub's scheduled work: once a day, after 23:00 UTC, each tracked
// US share's five sections; and for an event a rule waits on, its
// calendar hourly on the event's date and the day after, so its actuals
// are seen within the hour. A minute tick decides what is due, so a day
// missed while the server was down runs on start, and a tick starts no
// new instrument after its budget, so ticks never pile up.

import { MINUTE_MS } from "../clock.ts";
import { type Instrument, readInstrument } from "../instruments.ts";
import type { Log } from "../log.ts";
import { lastStarted } from "../runs.ts";
import type { Scheduler } from "../scheduler.ts";
import { phraseOf, QueueClosed } from "../source.ts";
import { TRACK_MS, trackedInstruments } from "../tracking.ts";
import { WriterClosed } from "../writer.ts";
import { addDays, localDate } from "../zone.ts";
import { SOURCE } from "./client.ts";
import {
  eligible,
  type FinnhubContext,
  type Hooks,
  NO_HOOKS,
  readEvent,
  refreshResearch,
  SECTIONS,
  type Section,
  sectionDue,
} from "./store.ts";

export const TICK_MS = MINUTE_MS;
// a failed section is asked again after this, not each tick
export const RETRY_MS = 60 * MINUTE_MS;
// how often a waited event's calendar is asked around its date
export const WAITED_EVERY_MS = 60 * MINUTE_MS;
// no instrument starts after this much of a tick, so one ends in its minute
export const TICK_BUDGET_MS = 45_000;

export type ResearchPass = {
  // instruments asked, with the sections asked
  asked: { instrument: string; sections: Section[] }[];
  failed: { instrument: string; section: Section; error: string }[];
};

export type FinnhubJobs = {
  tick(): Promise<ResearchPass>;
  schedule(jobs: Scheduler): void;
};

export function finnhubJobs(options: {
  ctx: FinnhubContext;
  log: Log;
  trackMs?: number;
  hooks?: Hooks;
}): FinnhubJobs {
  const { ctx, log } = options;
  const { db, clock } = ctx;
  const trackMs = options.trackMs ?? TRACK_MS;
  const hooks = options.hooks ?? NO_HOOKS;

  const retrying = (id: string, section: Section, now: number) => {
    const last = lastStarted(db, SOURCE, section, id);
    return last?.status === "failed" && now - last.startedAt < RETRY_MS;
  };

  // the daily sections due for each tracked share
  const daily = (now: number) =>
    trackedInstruments(db, now, trackMs)
      .filter(eligible)
      .map((instrument) => ({
        instrument,
        sections: SECTIONS.filter(
          (s) =>
            sectionDue(db, instrument.id, s, now) &&
            !retrying(instrument.id, s, now),
        ),
      }))
      .filter((w) => w.sections.length > 0);

  // the calendar of each instrument with a waited event dated today or
  // yesterday on its exchange and not reported yet, asked hourly
  const waited = (now: number) => {
    const due = new Map<string, Instrument>();
    for (const key of hooks.waited(db, now)) {
      const event = readEvent(db, key);
      const instrument = readInstrument(db, key.instrument);
      if (event === null || instrument === null || !eligible(instrument)) {
        continue;
      }
      if (event.reportedSeenAt !== null) continue;
      const today = localDate(instrument.zone, now);
      if (today !== event.date && today !== addDays(event.date, 1)) continue;
      const last = lastStarted(db, SOURCE, "calendar", instrument.id);
      if (last !== null && now - last.startedAt < WAITED_EVERY_MS) continue;
      due.set(instrument.id, instrument);
    }
    return [...due.values()].map((instrument) => ({
      instrument,
      sections: ["calendar"] as Section[],
    }));
  };

  async function tick(): Promise<ResearchPass> {
    const pass: ResearchPass = { asked: [], failed: [] };
    if (ctx.finnhub === null) return pass;
    const started = clock.now();
    // waited calendars first, each instrument once with all it is due
    const work = new Map<
      string,
      { instrument: Instrument; sections: Section[] }
    >();
    for (const w of [...waited(started), ...daily(started)]) {
      const had = work.get(w.instrument.id);
      if (had === undefined) work.set(w.instrument.id, w);
      else {
        had.sections = SECTIONS.filter(
          (s) => had.sections.includes(s) || w.sections.includes(s),
        );
      }
    }
    for (const w of work.values()) {
      if (clock.now() - started >= TICK_BUDGET_MS) break;
      try {
        const results = await refreshResearch(ctx, w.instrument, w.sections, {
          hooks,
        });
        pass.asked.push({ instrument: w.instrument.id, sections: w.sections });
        for (const r of results) {
          if (r.status === "failed") {
            pass.failed.push({
              instrument: w.instrument.id,
              section: r.section,
              error: phraseOf(r.error),
            });
          }
        }
      } catch (error) {
        // shutting down: the next start picks the work up
        if (error instanceof QueueClosed || error instanceof WriterClosed)
          break;
        throw error;
      }
    }
    if (pass.asked.length > 0) {
      log.info("finnhub research refreshed", {
        instruments: pass.asked.length,
        failed: pass.failed.length,
      });
    }
    for (const f of pass.failed) {
      log.warn("finnhub section failed", {
        instrument: f.instrument,
        section: f.section,
        error: f.error,
      });
    }
    return pass;
  }

  return {
    tick,
    schedule(jobs) {
      jobs.every("finnhub", TICK_MS, async () => {
        await tick();
      });
    },
  };
}
