// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// Finnhub answers an ADR from its home listing, whose P/E is on another
// price and currency; Yahoo's EPS is per US share, so P/E is worked out here.

import { checkStored, type Instrument } from "../../market/instruments.ts";
import {
  BY_USE,
  type Tracking,
  trackedInstruments,
} from "../../market/tracking.ts";
import { MINUTE_MS } from "../../runtime/clock.ts";
import { exclusive } from "../../runtime/lock.ts";
import type { Log } from "../../runtime/log.ts";
import type { Scheduler } from "../../runtime/scheduler.ts";
import type { Db } from "../../storage/db/index.ts";
import {
  endRun,
  failedRun,
  failRun,
  lastStarted,
  startRun,
} from "../../storage/runs.ts";
import { WriterClosed } from "../../storage/writer.ts";
import { STALE_RESEARCH } from "../finnhub/read.ts";
import { dueAt, eligible } from "../finnhub/store.ts";
import { sectionDue } from "../finnhub/sync.ts";
import { RETRY_MS } from "../history.ts";
import { YAHOO } from "../ids.ts";
import { DeadlinePassed, Paused, phraseOf, QueueClosed } from "../source.ts";
import type { Valuation, Yahoo } from "./client.ts";
import type { YahooContext } from "./sync.ts";

export const VALUATION_JOB = "valuation";
export const VALUATION_TICK_MS = MINUTE_MS;
export const PER_US_SHARE =
  "from Yahoo, per US share in the listing's currency; P/E at the quote's price";

export type ValuationRow = {
  epsTtm: number | null;
  epsForward: number | null;
  peg: number | null;
  currency: string;
  fetchedAt: number;
};

// a dotted listing is foreign; a dotless one is another US class, whose
// own figures Finnhub keeps
export function foreignListing(db: Db, instrument: string): string | null {
  const row = db
    .query<{ listing: string | null }, [string]>(
      "select listing from research where instrument = ? and kind = 'metric'",
    )
    .get(instrument);
  const listing = row?.listing ?? null;
  return listing?.includes(".") ? listing : null;
}

export const covered = (db: Db, i: Instrument): boolean =>
  eligible(i) && foreignListing(db, i.id) !== null;

export function readValuation(db: Db, instrument: string): ValuationRow | null {
  return (
    db
      .query<ValuationRow, [string]>(
        `select eps_ttm as epsTtm, eps_forward as epsForward, peg, currency,
           fetched_at as fetchedAt
         from valuations where instrument = ?`,
      )
      .get(instrument) ?? null
  );
}

export const valuationFetched = (db: Db, instrument: string): boolean =>
  lastStarted(db, YAHOO, VALUATION_JOB, instrument, "ok") !== null;

// the research stale phrases, on the daily refresh's schedule
export function valuationState(db: Db, instrument: string, now: number) {
  const ok = lastStarted(db, YAHOO, VALUATION_JOB, instrument, "ok");
  const last = lastStarted(db, YAHOO, VALUATION_JOB, instrument);
  const stale: string[] = [];
  if (ok === null) stale.push(STALE_RESEARCH.none);
  if (failedRun(last)) stale.push(STALE_RESEARCH.failed);
  else if (ok !== null && ok.startedAt < dueAt(now)) {
    stale.push(STALE_RESEARCH.pending);
  }
  return { fetchedAt: ok?.endedAt ?? null, stale };
}

// a currency other than the instrument's keeps nothing, nor does an
// answer with no figure; a failure keeps the stored row
function store(db: Db, instrument: Instrument, answer: Valuation): number {
  db.query("delete from valuations where instrument = ?").run(instrument.id);
  if (answer.currency === null || answer.currency !== instrument.currency) {
    return 0;
  }
  if (
    answer.epsTtm === null &&
    answer.epsForward === null &&
    answer.peg === null
  ) {
    return 0;
  }
  db.query(
    `insert into valuations (instrument, eps_ttm, eps_forward, peg, currency,
       fetched_at)
     values (?, ?, ?, ?, ?, ?)`,
  ).run(
    instrument.id,
    answer.epsTtm,
    answer.epsForward,
    answer.peg,
    answer.currency,
    answer.fetchedAt,
  );
  return 1;
}

export type ValuationResult =
  | { status: "ok"; rows: number }
  | { status: "failed"; error: unknown };

// a closing server or a read past its deadline says nothing about the
// source, nor does a back-off met before asking, so none records a run
const aborts = (error: unknown): boolean =>
  error instanceof QueueClosed ||
  error instanceof WriterClosed ||
  error instanceof DeadlinePassed ||
  error instanceof Paused;

export async function refreshValuation(
  ctx: Pick<YahooContext, "db" | "clock" | "writer" | "yahoo">,
  instrument: Instrument,
  options: {
    live?: () => boolean;
    client?: Yahoo;
    // read again once the lock is held, so a caller that waited on
    // another's fetch asks nothing it stored
    due?: (db: Db) => boolean;
  } = {},
): Promise<ValuationResult | null> {
  const live = options.live ?? (() => true);
  const client = options.client ?? ctx.yahoo;
  return exclusive(
    ctx.db,
    `${YAHOO}:${VALUATION_JOB}:${instrument.id}`,
    async () => {
      if (options.due !== undefined && !options.due(ctx.db)) return null;
      if (!live()) throw new DeadlinePassed();
      const startedAt = ctx.clock.now();
      let outcome: { answer: Valuation } | { error: unknown };
      try {
        outcome = { answer: await client.valuation(instrument.sourceSymbol) };
      } catch (error) {
        if (aborts(error)) throw error;
        outcome = { error };
      }
      return ctx.writer.write((db): ValuationResult => {
        if (!live()) throw new DeadlinePassed();
        checkStored(db, instrument.id);
        const now = ctx.clock.now();
        const id = startRun(db, YAHOO, VALUATION_JOB, startedAt, instrument.id);
        if ("error" in outcome) {
          failRun(db, id, now, outcome.error);
          return { status: "failed", error: outcome.error };
        }
        const rows = store(db, instrument, outcome.answer);
        endRun(db, id, now, rows);
        return { status: "ok", rows };
      });
    },
  );
}

// After the research refresh: one call a day per tracked share Finnhub
// answers from a foreign listing, once its metric is refreshed.
export function valuationDue(db: Db, instrument: string, now: number): boolean {
  const ok = lastStarted(db, YAHOO, VALUATION_JOB, instrument, "ok");
  if (ok !== null && ok.startedAt >= dueAt(now)) return false;
  if (sectionDue(db, instrument, "metric", now)) return false;
  const last = lastStarted(db, YAHOO, VALUATION_JOB, instrument);
  return !(failedRun(last) && now - last.startedAt < RETRY_MS);
}

export type ValuationPass = {
  asked: string[];
  failed: { instrument: string; error: string }[];
};

export function valuationJobs(options: {
  ctx: YahooContext;
  log: Log;
  tracking?: Tracking;
}) {
  const { ctx, log } = options;
  const tracking = options.tracking ?? BY_USE;

  async function tick(): Promise<ValuationPass> {
    const pass: ValuationPass = { asked: [], failed: [] };
    const now = ctx.clock.now();
    const due = trackedInstruments(ctx.db, now, tracking).filter(
      (i) => covered(ctx.db, i) && valuationDue(ctx.db, i.id, now),
    );
    for (const instrument of due) {
      try {
        const result = await refreshValuation(ctx, instrument, {
          due: (db) => valuationDue(db, instrument.id, ctx.clock.now()),
        });
        if (result === null) continue;
        pass.asked.push(instrument.id);
        if (result?.status === "failed") {
          pass.failed.push({
            instrument: instrument.id,
            error: phraseOf(result.error),
          });
        }
      } catch (error) {
        // shutting down, or another call's back-off: a later tick goes on
        if (
          error instanceof QueueClosed ||
          error instanceof WriterClosed ||
          error instanceof Paused
        ) {
          break;
        }
        throw error;
      }
    }
    if (pass.asked.length > 0) {
      log.info("yahoo valuations refreshed", {
        instruments: pass.asked.length,
        failed: pass.failed.length,
      });
    }
    for (const f of pass.failed) {
      log.warn("yahoo valuation failed", {
        instrument: f.instrument,
        error: f.error,
      });
    }
    return pass;
  }

  return {
    tick,
    schedule(jobs: Scheduler) {
      jobs.every("yahoo-valuation", VALUATION_TICK_MS, async () => {
        await tick();
      });
    },
  };
}
