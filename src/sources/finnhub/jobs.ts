// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// a minute tick decides what is due, so a day missed while down runs on start

import type { Instrument } from "../../market/instruments.ts";
import { TRACK_MS, trackedInstruments } from "../../market/tracking.ts";
import { addDays, localDate } from "../../market/zone.ts";
import { MINUTE_MS } from "../../runtime/clock.ts";
import type { Log } from "../../runtime/log.ts";
import type { Scheduler } from "../../runtime/scheduler.ts";
import type { Db } from "../../storage/db/index.ts";
import { lastStarted } from "../../storage/runs.ts";
import { WriterClosed } from "../../storage/writer.ts";
import { Paused, phraseOf, QueueClosed } from "../source.ts";
import { SOURCE } from "./client.ts";
import {
  eligible,
  type Hooks,
  NO_HOOKS,
  SECTIONS,
  type Section,
} from "./store.ts";
import {
  type FinnhubContext,
  MARKET_CALENDAR,
  refreshResearch,
  sectionDue,
  storeMarketCalendar,
} from "./sync.ts";

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

export type WindowEvent = {
  instrument: Instrument;
  date: string;
  listing: string | null;
  seenAt: number | null;
};

// Every stored event of these shares dated their exchange's yesterday or
// today; yesterday too, as many reporters have no actuals a day on.
export function windowEvents(
  db: Db,
  shares: readonly Instrument[],
  now: number,
): WindowEvent[] {
  const today = new Map<string, string>();
  const days = new Map<string, { share: Instrument; today: string }>();
  for (const share of shares) {
    let d = today.get(share.zone);
    if (d === undefined) {
      d = localDate(share.zone, now);
      today.set(share.zone, d);
    }
    days.set(share.id, { share, today: d });
  }
  if (days.size === 0) return [];
  const all = [...today.values()].sort();
  const out: WindowEvent[] = [];
  const rows = db
    .query<
      {
        instrument: string;
        date: string;
        listing: string | null;
        seenAt: number | null;
      },
      [string, string]
    >(
      `select instrument, date, listing, reported_seen_at as seenAt
       from events where date >= ? and date <= ?`,
    )
    .all(addDays(all[0]!, -1), all.at(-1)!);
  for (const r of rows) {
    const d = days.get(r.instrument);
    if (d === undefined) continue;
    if (r.date < addDays(d.today, -1) || r.date > d.today) continue;
    out.push({ ...r, instrument: d.share });
  }
  return out;
}

// the range for the shares' own unreported events, null when none waits;
// another listing's events are not in the market answer under its symbol
export function reportingWindow(
  events: readonly WindowEvent[],
  now: number,
): { from: string; to: string } | null {
  const days = events
    .filter((e) => e.seenAt === null && e.listing === null)
    .map((e) => localDate(e.instrument.zone, now))
    .sort();
  if (days.length === 0) return null;
  return { from: addDays(days[0]!, -1), to: days.at(-1)! };
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

  // the share's section was asked within the hour, or failed and waits
  const askedWithin = (id: string, section: Section, now: number) => {
    const last = lastStarted(db, SOURCE, section, id);
    return (
      (last !== null && now - last.startedAt < MARKET_EVERY_MS) ||
      retrying(id, section, now)
    );
  };

  // A share's event of another listing is not in the market answer, so
  // its own calendar is asked hourly; these are few, foreign companies.
  const otherListings = (events: readonly WindowEvent[], now: number) => {
    const due = new Map<string, Instrument>();
    for (const e of events) {
      if (e.seenAt !== null || e.listing === null) continue;
      if (askedWithin(e.instrument.id, "calendar", now)) continue;
      due.set(e.instrument.id, e.instrument);
    }
    return [...due.values()].map((instrument) => ({
      instrument,
      sections: ["calendar"] as Section[],
    }));
  };

  // seen reported since its last good earnings run started: asked its earnings,
  // so surprises carry the quarter that hour; stored state resumes a cut tick
  const sightedEarnings = (events: readonly WindowEvent[], now: number) => {
    const seen = new Map<string, { instrument: Instrument; at: number }>();
    for (const e of events) {
      if (e.seenAt === null) continue;
      const had = seen.get(e.instrument.id);
      if (had === undefined || had.at < e.seenAt) {
        seen.set(e.instrument.id, { instrument: e.instrument, at: e.seenAt });
      }
    }
    return [...seen.values()]
      .filter(({ instrument, at }) => {
        const ok = lastStarted(db, SOURCE, "earnings", instrument.id, "ok");
        const before = ok === null || ok.startedAt < at;
        return before && !retrying(instrument.id, "earnings", now);
      })
      .map(({ instrument }) => ({
        instrument,
        sections: ["earnings"] as Section[],
      }));
  };

  // one call for every tracked share reporting; true when it was asked
  async function market(
    shares: readonly Instrument[],
    window: { from: string; to: string } | null,
    now: number,
    pass: ResearchPass,
  ): Promise<boolean> {
    const client = ctx.finnhub;
    if (window === null || client === null) return false;
    const last = lastStarted(
      db,
      SOURCE,
      MARKET_CALENDAR.job,
      MARKET_CALENDAR.scope,
    );
    const wait = last?.status === "failed" ? RETRY_MS : MARKET_EVERY_MS;
    if (last !== null && now - last.startedAt < wait) return false;
    const startedAt = clock.now();
    let outcome: Parameters<typeof storeMarketCalendar>[2];
    try {
      const answer = await client.marketCalendar(window.from, window.to);
      outcome = { answer, startedAt };
    } catch (error) {
      if (error instanceof QueueClosed || error instanceof WriterClosed) {
        throw error;
      }
      // no run: it would hold off the next hour's ask
      if (error instanceof Paused) return false;
      outcome = { error, startedAt };
    }
    const result = await storeMarketCalendar(ctx, shares, outcome, hooks);
    pass.market =
      result.status === "failed"
        ? { error: phraseOf(result.error) }
        : { rows: result.rows, reported: result.reported };
    return true;
  }

  async function tick(): Promise<ResearchPass> {
    const pass: ResearchPass = { market: null, asked: [], failed: [] };
    if (ctx.finnhub === null) return pass;
    const started = clock.now();
    const shares = trackedInstruments(db, started, trackMs).filter(eligible);
    let events = windowEvents(db, shares, started);
    try {
      const window = reportingWindow(events, started);
      if (await market(shares, window, started, pass)) {
        events = windowEvents(db, shares, started);
      }
    } catch (error) {
      // shutting down: the next start picks the work up
      if (error instanceof QueueClosed || error instanceof WriterClosed) {
        return pass;
      }
      throw error;
    }
    // reporting shares first, each instrument once with all it is due
    const work = new Map<
      string,
      { instrument: Instrument; sections: Section[] }
    >();
    for (const w of [
      ...otherListings(events, started),
      ...sightedEarnings(events, started),
      ...daily(shares, started),
    ]) {
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
