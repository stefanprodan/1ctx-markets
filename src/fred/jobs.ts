// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// FRED's one scheduled job: once a day at 23:00 UTC on the server's
// clock, since a FRED-only server may know no market's hours, every
// series refetches its last observations. Each series records its own
// run, scoped to its id, so one dead series never marks another stale.
// A minute tick decides what is due, so a pass missed while the server
// was down runs on start.

import { DAY_MS, MINUTE_MS } from "../clock.ts";
import type { Db } from "../db/index.ts";
import { type Instrument, readInstruments } from "../instruments.ts";
import type { Log } from "../log.ts";
import { endRun, failRun, lastRun, lastStarted, startRun } from "../runs.ts";
import type { Scheduler } from "../scheduler.ts";
import { phraseOf } from "../source.ts";
import { JOBS, STALE, type StaleReason } from "../stale.ts";
import { SOURCE } from "./client.ts";
import { type FredContext, refetchSeries } from "./sync.ts";

export const TICK_MS = MINUTE_MS;
// the time of day, UTC, the daily pass is due
export const DAILY_AT_MS = 23 * 60 * MINUTE_MS;
// a failed series is asked again after this, not each tick
export const RETRY_MS = 60 * MINUTE_MS;

export type FredPass = {
  rows: number;
  // each series whose stored bars changed, from that date on, for
  // whatever is computed from past bars
  changed: { instrument: string; changedFrom: string }[];
  // each series that failed, with its fixed phrase
  failed: { instrument: string; error: string }[];
};

export type FredJobs = {
  // the series due, when any is
  tick(): Promise<FredPass | null>;
  // these series, or every one
  pass(instruments?: readonly Instrument[]): Promise<FredPass>;
  schedule(jobs: Scheduler): void;
};

// the latest 23:00 UTC at or before now
export function dueAt(now: number): number {
  return Math.floor((now - DAILY_AT_MS) / DAY_MS) * DAY_MS + DAILY_AT_MS;
}

const series = (db: Db): Instrument[] =>
  readInstruments(db).filter((i) => i.source === SOURCE);

type Scoped = Pick<Instrument, "id" | "addedAt">;

// Due when the series is older than the latest 23:00 and has had no
// run end well since then; one added later was backfilled after it.
export function seriesDue(db: Db, instrument: Scoped, now: number): boolean {
  const due = dueAt(now);
  if (instrument.addedAt >= due) return false;
  const ok = lastStarted(db, SOURCE, JOBS.bars, instrument.id, "ok");
  return ok === null || ok.startedAt < due;
}

// A series' bars, stale with the same reasons as a market's, read from
// its own runs only: none yet, its last run failed, or its daily run is
// due and has not ended well.
export function seriesStale(
  db: Db,
  instrument: Scoped,
  now: number,
): StaleReason[] {
  const has = db
    .query<{ n: number }, [string]>(
      "select count(*) as n from bars where instrument = ? and interval = '1d'",
    )
    .get(instrument.id)!.n;
  if (has === 0) return [STALE.noHistory];
  const reasons: StaleReason[] = [];
  if (lastRun(db, SOURCE, JOBS.bars, instrument.id)?.status === "failed") {
    reasons.push(STALE.barsFailed);
  }
  if (seriesDue(db, instrument, now)) reasons.push(STALE.barsPending);
  return reasons;
}

export function fredJobs(options: { ctx: FredContext; log: Log }): FredJobs {
  const { ctx, log } = options;
  const { db, clock, writer } = ctx;

  async function pass(
    instruments: readonly Instrument[] = series(db),
  ): Promise<FredPass> {
    let rows = 0;
    const changed: FredPass["changed"] = [];
    const failed: FredPass["failed"] = [];
    for (const instrument of instruments) {
      const id = await writer.write((db) =>
        startRun(db, SOURCE, JOBS.bars, clock.now(), instrument.id),
      );
      try {
        const written = await refetchSeries(ctx, instrument);
        await writer.write((db) => endRun(db, id, clock.now(), written.rows));
        rows += written.rows;
        if (written.changedFrom !== null) {
          changed.push({
            instrument: instrument.id,
            changedFrom: written.changedFrom,
          });
        }
      } catch (e) {
        await writer.write((db) => failRun(db, id, clock.now(), e));
        failed.push({ instrument: instrument.id, error: phraseOf(e) });
        log.warn("fred series failed", {
          instrument: instrument.id,
          error: phraseOf(e),
        });
      }
    }
    log.info("fred series refetched", {
      rows,
      changed: changed.length,
      changed_from: changed.map((c) => c.changedFrom).sort()[0],
      failed: failed.length,
    });
    return { rows, changed, failed };
  }

  async function tick(): Promise<FredPass | null> {
    const now = clock.now();
    const due = series(db).filter((i) => {
      if (!seriesDue(db, i, now)) return false;
      const last = lastStarted(db, SOURCE, JOBS.bars, i.id);
      return !(last?.status === "failed" && now - last.startedAt < RETRY_MS);
    });
    return due.length === 0 ? null : pass(due);
  }

  return {
    tick,
    pass,
    schedule(jobs) {
      jobs.every("fred", TICK_MS, async () => {
        await tick();
      });
    },
  };
}
