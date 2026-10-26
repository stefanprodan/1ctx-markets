// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Massive's scheduled work: every 30 minutes, each tracked US share's
// and ETF's news since its newest stored article. A minute tick takes
// the tickers due, longest waiting first, and asks no page after its
// budget, so ticks never pile up; a walk cut there goes on next time.

import { MINUTE_MS } from "../clock.ts";
import type { Log } from "../log.ts";
import { lastStarted } from "../runs.ts";
import type { Scheduler } from "../scheduler.ts";
import { phraseOf, QueueClosed } from "../source.ts";
import { TRACK_MS, trackedInstruments } from "../tracking.ts";
import { WriterClosed } from "../writer.ts";
import { SOURCE } from "./client.ts";
import {
  eligible,
  JOB,
  type MassiveContext,
  newsDue,
  refreshNews,
} from "./store.ts";

export const TICK_MS = MINUTE_MS;
// no page is asked after this much of a tick: with one start every 13 s
// the last one still ends inside the minute
export const TICK_BUDGET_MS = 30_000;

export type NewsPass = {
  asked: { instrument: string; rows: number; pages: number }[];
  failed: { instrument: string; error: string }[];
};

export type MassiveJobs = {
  tick(): Promise<NewsPass>;
  schedule(jobs: Scheduler): void;
};

export function massiveJobs(options: {
  ctx: MassiveContext;
  log: Log;
  trackMs?: number;
}): MassiveJobs {
  const { ctx, log } = options;
  const { db, clock } = ctx;
  const trackMs = options.trackMs ?? TRACK_MS;

  // the tickers due, the one asked longest ago (or never) first
  const due = (now: number) =>
    trackedInstruments(db, now, trackMs)
      .filter((i) => eligible(i) && newsDue(db, i.id, now))
      .map((i) => ({
        instrument: i,
        last: lastStarted(db, SOURCE, JOB, i.id)?.startedAt ?? -1,
      }))
      .sort((a, b) => a.last - b.last)
      .map((w) => w.instrument);

  async function tick(): Promise<NewsPass> {
    const pass: NewsPass = { asked: [], failed: [] };
    if (ctx.massive === null) return pass;
    const started = clock.now();
    const more = () => clock.now() - started < TICK_BUDGET_MS;
    for (const instrument of due(started)) {
      if (!more()) break;
      try {
        const r = await refreshNews(ctx, instrument, { more });
        // a walk the budget cut before its first page asked nothing
        if (r.pages === 0 && r.status === "ok") continue;
        pass.asked.push({
          instrument: instrument.id,
          rows: r.rows,
          pages: r.pages,
        });
        if (r.status === "failed") {
          pass.failed.push({
            instrument: instrument.id,
            error: phraseOf(r.error),
          });
        }
      } catch (error) {
        // shutting down: the next start picks the work up
        if (error instanceof QueueClosed || error instanceof WriterClosed)
          break;
        throw error;
      }
    }
    if (pass.asked.length > 0) {
      log.info("massive news refreshed", {
        instruments: pass.asked.length,
        rows: pass.asked.reduce((n, a) => n + a.rows, 0),
        failed: pass.failed.length,
      });
    }
    for (const f of pass.failed) {
      log.warn("massive news failed", {
        instrument: f.instrument,
        error: f.error,
      });
    }
    return pass;
  }

  return {
    tick,
    schedule(jobs) {
      jobs.every("massive", TICK_MS, async () => {
        await tick();
      });
    },
  };
}
