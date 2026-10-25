// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// FRED's one scheduled job: once a day at 23:00 UTC on the server's
// clock, since a FRED-only server may know no market's hours, every
// series refetches its last observations. A minute tick decides when
// it is due, so a pass missed while the server was down runs on start.

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
// a failed pass is asked again after this, not each tick
export const RETRY_MS = 60 * MINUTE_MS;

export type FredPass = {
  rows: number;
  // each series whose stored bars changed, from that date on, for
  // whatever is computed from past bars
  changed: { instrument: string; changedFrom: string }[];
  error: string | null;
};

export type FredJobs = {
  // the pass, when one is due
  tick(): Promise<FredPass | null>;
  pass(): Promise<FredPass>;
  schedule(jobs: Scheduler): void;
};

// the latest 23:00 UTC at or before now
export function dueAt(now: number): number {
  return Math.floor((now - DAILY_AT_MS) / DAY_MS) * DAY_MS + DAILY_AT_MS;
}

const series = (db: Db): Instrument[] =>
  readInstruments(db).filter((i) => i.source === SOURCE);

// Due when a series older than the latest 23:00 has had no pass end
// well since then; a series added later was backfilled after it.
export function passDue(db: Db, now: number): boolean {
  const due = dueAt(now);
  if (!series(db).some((i) => i.addedAt < due)) return false;
  const ok = lastStarted(db, SOURCE, JOBS.bars, null, "ok");
  return ok === null || ok.startedAt < due;
}

type Scoped = Pick<Instrument, "id" | "source" | "addedAt">;

// A series' bars, stale with the same reasons as a market's: none yet,
// the last pass failed, or the daily pass is due and has not run.
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
  if (lastRun(db, SOURCE, JOBS.bars, null)?.status === "failed") {
    reasons.push(STALE.barsFailed);
  }
  if (instrument.addedAt < dueAt(now) && passDue(db, now)) {
    reasons.push(STALE.barsPending);
  }
  return reasons;
}

export function fredJobs(options: { ctx: FredContext; log: Log }): FredJobs {
  const { ctx, log } = options;
  const { db, clock, writer } = ctx;

  async function pass(): Promise<FredPass> {
    const id = await writer.write((db) =>
      startRun(db, SOURCE, JOBS.bars, clock.now()),
    );
    let rows = 0;
    let error: unknown;
    const changed: FredPass["changed"] = [];
    for (const instrument of series(db)) {
      try {
        const written = await refetchSeries(ctx, instrument);
        rows += written.rows;
        if (written.changedFrom !== null) {
          changed.push({
            instrument: instrument.id,
            changedFrom: written.changedFrom,
          });
        }
      } catch (e) {
        error ??= e;
        log.warn("fred series failed", {
          instrument: instrument.id,
          error: phraseOf(e),
        });
      }
    }
    await writer.write((db) =>
      error === undefined
        ? endRun(db, id, clock.now(), rows)
        : failRun(db, id, clock.now(), error, rows),
    );
    log.info("fred series refetched", {
      rows,
      changed: changed.length,
      changed_from: changed.map((c) => c.changedFrom).sort()[0],
    });
    return {
      rows,
      changed,
      error: error === undefined ? null : phraseOf(error),
    };
  }

  async function tick(): Promise<FredPass | null> {
    const now = clock.now();
    if (!passDue(db, now)) return null;
    const last = lastStarted(db, SOURCE, JOBS.bars, null);
    if (last?.status === "failed" && now - last.startedAt < RETRY_MS) {
      return null;
    }
    return pass();
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
