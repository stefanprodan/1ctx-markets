// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// a minute tick decides what is due, so a day missed while down runs on start

import { MINUTE_MS } from "../clock.ts";
import type { Db } from "../db/index.ts";
import type { Instrument } from "../instruments.ts";
import type { Log } from "../log.ts";
import { lastStarted } from "../runs.ts";
import type { Scheduler } from "../scheduler.ts";
import { Paused, phraseOf, QueueClosed } from "../source.ts";
import { TRACK_MS, trackedInstruments } from "../tracking.ts";
import { WriterClosed } from "../writer.ts";
import { addDays, localDate } from "../zone.ts";
import { SOURCE } from "./client.ts";
import {
  eligible,
  type FinnhubContext,
  type Hooks,
  MARKET_CALENDAR,
  NO_HOOKS,
  refreshResearch,
  SECTIONS,
  type Section,
  sectionDue,
  storeMarketCalendar,
} from "./store.ts";

export const TICK_MS = MINUTE_MS;
// a failed section is asked again after this, not each tick
export const RETRY_MS = 60 * MINUTE_MS;
// how often the whole-market calendar is asked while a share reports
export const MARKET_EVERY_MS = 60 * MINUTE_MS;
// no instrument starts after this much of a tick, so one ends in its minute
export const TICK_BUDGET_MS = 45_000;

export type ResearchPass = {
  // the whole-market calendar, null when not asked
  market: { rows: number; reported: string[] } | { error: string } | null;
  asked: { instrument: string; sections: Section[] }[];
  failed: { instrument: string; section: Section; error: string }[];
};

// The range of exchange dates, yesterday to today in each share's zone,
// holding an unreported stored event of one of these shares; null when
// none does. Yesterday too, as many reporters have no actuals a day on.
export function reportingWindow(
  db: Db,
  shares: readonly Instrument[],
  now: number,
): { from: string; to: string } | null {
  const today = new Map<string, string>();
  const days = new Map<string, string>();
  for (const s of shares) {
    let d = today.get(s.zone);
    if (d === undefined) {
      d = localDate(s.zone, now);
      today.set(s.zone, d);
    }
    days.set(s.id, d);
  }
  if (days.size === 0) return null;
  const all = [...today.values()].sort();
  const waiting = db
    .query<{ instrument: string; date: string }, [string, string]>(
      `select instrument, date from events
       where date >= ? and date <= ? and reported_seen_at is null`,
    )
    .all(addDays(all[0]!, -1), all.at(-1)!)
    .map((e) => ({ e, d: days.get(e.instrument) }))
    .filter(
      ({ e, d }) => d !== undefined && e.date >= addDays(d, -1) && e.date <= d,
    )
    .map(({ d }) => d!)
    .sort();
  if (waiting.length === 0) return null;
  return { from: addDays(waiting[0]!, -1), to: waiting.at(-1)! };
}

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

  const daily = (shares: readonly Instrument[], now: number) =>
    shares
      .map((instrument) => ({
        instrument,
        sections: SECTIONS.filter(
          (s) =>
            sectionDue(db, instrument.id, s, now) &&
            !retrying(instrument.id, s, now),
        ),
      }))
      .filter((w) => w.sections.length > 0);

  // One call for every tracked share around its report, however many
  // there are; a first sighting asks that share's earnings once, so its
  // surprises carry the new quarter the same hour.
  async function market(
    shares: readonly Instrument[],
    now: number,
    pass: ResearchPass,
  ): Promise<Instrument[]> {
    const window = reportingWindow(db, shares, now);
    if (window === null || ctx.finnhub === null) return [];
    const last = lastStarted(
      db,
      SOURCE,
      MARKET_CALENDAR.job,
      MARKET_CALENDAR.scope,
    );
    const wait = last?.status === "failed" ? RETRY_MS : MARKET_EVERY_MS;
    if (last !== null && now - last.startedAt < wait) return [];
    const startedAt = clock.now();
    let outcome: Parameters<typeof storeMarketCalendar>[2];
    try {
      const answer = await ctx.finnhub.marketCalendar(window.from, window.to);
      outcome = { answer, startedAt };
    } catch (error) {
      if (error instanceof QueueClosed || error instanceof WriterClosed) {
        throw error;
      }
      // no run: it would hold off the next hour's ask
      if (error instanceof Paused) return [];
      outcome = { error, startedAt };
    }
    const result = await storeMarketCalendar(ctx, shares, outcome, hooks);
    if (result.status === "failed") {
      pass.market = { error: phraseOf(result.error) };
      return [];
    }
    pass.market = { rows: result.rows, reported: result.reported };
    const sighted = new Set(result.reported);
    return shares.filter((s) => sighted.has(s.id));
  }

  async function tick(): Promise<ResearchPass> {
    const pass: ResearchPass = { market: null, asked: [], failed: [] };
    if (ctx.finnhub === null) return pass;
    const started = clock.now();
    const shares = trackedInstruments(db, started, trackMs).filter(eligible);
    let sighted: Instrument[];
    try {
      sighted = await market(shares, started, pass);
    } catch (error) {
      // shutting down: the next start picks the work up
      if (error instanceof QueueClosed || error instanceof WriterClosed) {
        return pass;
      }
      throw error;
    }
    // first sightings' earnings first, each instrument once with all it is due
    const work = new Map<
      string,
      { instrument: Instrument; sections: Section[] }
    >();
    const reported = sighted.map((instrument) => ({
      instrument,
      sections: ["earnings"] as Section[],
    }));
    for (const w of [...reported, ...daily(shares, started)]) {
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
    if (pass.market !== null && "error" in pass.market) {
      log.warn("finnhub market calendar failed", { error: pass.market.error });
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
