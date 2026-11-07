// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// The market list is held in memory, never stored: one grouped call per
// report a day, made at start whether anyone asks or not.

import { dateOfWall } from "../../market/zone.ts";
import { type Clock, DAY_MS, HOUR_MS, MINUTE_MS } from "../../runtime/clock.ts";
import type { Log } from "../../runtime/log.ts";
import type { Scheduler } from "../../runtime/scheduler.ts";
import { runJob } from "../../storage/runs.ts";
import { type Writer, WriterClosed } from "../../storage/writer.ts";
import { phraseOf, QueueClosed } from "../source.ts";
import {
  type Cftc,
  type Market,
  REPORTS,
  type Report,
  SOURCE,
} from "./client.ts";

// a market missing from one week's report stays findable for a year
export const LIST_WEEKS = 52;
export const LIST_MS = DAY_MS;
// a failed list is asked again after this, not each tick
export const RETRY_MS = 60 * MINUTE_MS;
export const TICK_MS = MINUTE_MS;
// a list this old means the job keeps failing, which search says
export const LIST_STALE_MS = 2 * DAY_MS;
export const LIST_JOB = "markets";
// three years of weeks, one call; more would need storage
export const HISTORY_WEEKS = 156;
export const POSITIONING_WEEKS = 12;
// a Friday report lands within hours, and a repeated read costs nothing
export const POSITIONING_MS = 6 * HOUR_MS;
// a COT index from a shorter range is no figure at all
export const COT_WEEKS = 52;

export type Held = {
  markets: Market[];
  byCode: Map<string, Market>;
  // the newest report date of any market in the report
  latest: string;
  fetchedAt: number;
};

export type MarketList = {
  held(report: Report): Held | null;
  find(code: string): { report: Report; market: Market } | null;
  // the report's list, joining a fetch in flight
  fetch(client: Cftc, report: Report): Promise<Held>;
  // when a list was first wanted, so one never filled reads old too
  startedAt: number;
  // a World markets code no longer listed, by when it was last logged
  retired: Map<string, number>;
};

export function marketList(clock: Clock): MarketList {
  const held = new Map<Report, Held>();
  const flights = new Map<Report, Promise<Held>>();
  return {
    held: (report) => held.get(report) ?? null,
    find(code) {
      for (const report of REPORTS) {
        const market = held.get(report)?.byCode.get(code);
        if (market !== undefined) return { report, market };
      }
      return null;
    },
    fetch(client, report) {
      const running = flights.get(report);
      if (running !== undefined) return running;
      const since = dateOfWall(clock.now() - LIST_WEEKS * 7 * DAY_MS);
      const flight = client
        .markets(report, since)
        .then((answer) => {
          const list: Held = {
            markets: answer.markets,
            byCode: new Map(answer.markets.map((m) => [m.code, m])),
            latest:
              answer.markets
                .map((m) => m.latest)
                .sort()
                .at(-1) ?? "",
            fetchedAt: answer.fetchedAt,
          };
          held.set(report, list);
          return list;
        })
        .finally(() => flights.delete(report));
      flights.set(report, flight);
      return flight;
    },
    startedAt: clock.now(),
    retired: new Map(),
  };
}

// an old list or none, past the stale span: the job keeps failing
export function listStale(list: MarketList, now: number): boolean {
  return REPORTS.some(
    (r) => now - (list.held(r)?.fetchedAt ?? list.startedAt) > LIST_STALE_MS,
  );
}

export type CftcJobs = {
  // the reports due, each its own run
  tick(): Promise<void>;
  schedule(jobs: Scheduler): void;
};

export function cftcJobs(options: {
  clock: Clock;
  writer: Writer;
  cftc: Cftc;
  list: MarketList;
  log: Log;
}): CftcJobs {
  const { clock, writer, cftc, list, log } = options;
  const failedAt = new Map<Report, number>();
  // the start's tick and the first minute's would record two runs of one fetch
  let running = false;
  const due = (report: Report, now: number) => {
    const ok = list.held(report)?.fetchedAt ?? null;
    const failed = failedAt.get(report);
    return (
      (ok === null || now - ok >= LIST_MS) &&
      (failed === undefined || now - failed >= RETRY_MS)
    );
  };
  async function tick() {
    if (running) return;
    running = true;
    try {
      await pass();
    } finally {
      running = false;
    }
  }
  async function pass() {
    for (const report of REPORTS) {
      if (!due(report, clock.now())) continue;
      try {
        await runJob(
          writer,
          clock,
          SOURCE,
          LIST_JOB,
          async () => (await list.fetch(cftc, report)).markets.length,
          report,
        );
        failedAt.delete(report);
      } catch (error) {
        // shutting down: the next start asks again
        if (error instanceof QueueClosed || error instanceof WriterClosed) {
          return;
        }
        failedAt.set(report, clock.now());
        log.warn("cftc markets failed", { report, error: phraseOf(error) });
      }
    }
  }
  return {
    tick,
    schedule(jobs) {
      jobs.every("cftc-markets", TICK_MS, tick);
    },
  };
}

// what every tool but research answers for a CFTC id
export const NO_PRICE =
  "A CFTC market has no price; read it with research, section positioning.";
