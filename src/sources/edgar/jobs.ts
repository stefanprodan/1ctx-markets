// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// a minute tick decides what is due, so a day missed while down runs on start

import {
  BY_USE,
  type Tracking,
  trackedInstruments,
} from "../../market/tracking.ts";
import { MINUTE_MS } from "../../runtime/clock.ts";
import type { Log } from "../../runtime/log.ts";
import type { Scheduler } from "../../runtime/scheduler.ts";
import { lastStarted } from "../../storage/runs.ts";
import { WriterClosed } from "../../storage/writer.ts";
import { Paused, phraseOf, QueueClosed } from "../source.ts";
import { SOURCE } from "./client.ts";
import {
  eligible,
  FILINGS_JOB,
  filingsDue,
  RETRY_MS,
  TICKERS,
  TICKERS_EVERY_MS,
  tickersFetched,
} from "./store.ts";
import { type EdgarContext, refreshFilings, refreshTickers } from "./sync.ts";

export const TICK_MS = MINUTE_MS;
// no share starts after this much of a tick, so one ends in its minute
export const TICK_BUDGET_MS = 45_000;

export type FilingsPass = {
  // the ticker map, null when not asked
  tickers: { rows: number } | { error: string } | null;
  asked: string[];
  failed: { instrument: string; error: string }[];
};

export type EdgarJobs = {
  tick(): Promise<FilingsPass>;
  schedule(jobs: Scheduler): void;
};

export function edgarJobs(options: {
  ctx: EdgarContext;
  log: Log;
  tracking?: Tracking;
}): EdgarJobs {
  const { ctx, log } = options;
  const { db, clock } = ctx;
  const tracking = options.tracking ?? BY_USE;

  const retrying = (job: string, scope: string, now: number) => {
    const last = lastStarted(db, SOURCE, job, scope);
    return last?.status === "failed" && now - last.startedAt < RETRY_MS;
  };

  const tickersDue = (now: number) => {
    const ok = lastStarted(db, SOURCE, TICKERS.job, TICKERS.scope, "ok");
    return (
      (ok === null || now - ok.startedAt >= TICKERS_EVERY_MS) &&
      !retrying(TICKERS.job, TICKERS.scope, now)
    );
  };

  async function tick(): Promise<FilingsPass> {
    const pass: FilingsPass = { tickers: null, asked: [], failed: [] };
    if (ctx.edgar === null) return pass;
    const started = clock.now();
    const shares = trackedInstruments(db, started, tracking).filter(eligible);
    // no share to ask for, no map to keep fresh
    if (shares.length === 0) return pass;
    try {
      if (tickersDue(started)) {
        const r = await refreshTickers(ctx);
        pass.tickers =
          r.status === "ok" ? { rows: r.rows } : { error: phraseOf(r.error) };
      }
      // without a map each share would ask for it again
      const mapped = tickersFetched(db);
      for (const share of mapped ? shares : []) {
        if (clock.now() - started >= TICK_BUDGET_MS) break;
        if (!filingsDue(db, share, started)) continue;
        if (retrying(FILINGS_JOB, share.id, started)) continue;
        const r = await refreshFilings(ctx, share);
        pass.asked.push(share.id);
        if (r.status === "failed") {
          pass.failed.push({ instrument: share.id, error: phraseOf(r.error) });
        }
      }
    } catch (error) {
      // shutting down: the next start picks the work up; a back-off, the next tick
      if (
        !(
          error instanceof QueueClosed ||
          error instanceof WriterClosed ||
          error instanceof Paused
        )
      ) {
        throw error;
      }
    }
    if (pass.tickers !== null && "error" in pass.tickers) {
      log.warn("edgar tickers failed", { error: pass.tickers.error });
    }
    if (pass.asked.length > 0) {
      log.info("edgar filings refreshed", {
        instruments: pass.asked.length,
        failed: pass.failed.length,
      });
    }
    for (const f of pass.failed) {
      log.warn("edgar filings failed", {
        instrument: f.instrument,
        error: f.error,
      });
    }
    return pass;
  }

  return {
    tick,
    schedule(jobs) {
      jobs.every("edgar", TICK_MS, async () => {
        await tick();
      });
    },
  };
}
