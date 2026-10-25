// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Yahoo's scheduled work. One short tick decides what is due from the
// stored sessions and runs: quotes for markets in session, one batch
// after each close, a check of one instrument per closed market, then
// the 30-day bar refetch of each market whose session moved on.
// Backfill takes its own turns, never the quote path's.

import {
  closeQuoteAt,
  isQuoted,
  nextCheck,
  readSession,
} from "../calendars.ts";
import { MINUTE_MS } from "../clock.ts";
import {
  type Instrument,
  readInstrument,
  readInstruments,
} from "../instruments.ts";
import type { Log } from "../log.ts";
import { endRun, failRun, lastStarted, runJob, startRun } from "../runs.ts";
import type { Scheduler } from "../scheduler.ts";
import { phraseOf } from "../source.ts";
import { barsDue, JOBS } from "../stale.ts";
import { SOURCE, type SparkAnswer } from "./client.ts";
import {
  backfill,
  type QuoteRow,
  refetch,
  storeQuotes,
  type YahooContext,
} from "./sync.ts";

export const TICK_MS = MINUTE_MS;
// a failed bar pass or backfill is asked again after this, not each tick
export const RETRY_MS = 60 * MINUTE_MS;
export const BACKFILL_JOB = "backfill";

export type JobsOptions = {
  ctx: YahooContext;
  quoteEveryMs: number;
  log: Log;
};

type Work = {
  market: string;
  job: typeof JOBS.quotes | typeof JOBS.check;
  instruments: Instrument[];
};

export type BarPass = {
  market: string;
  rows: number;
  // each instrument whose stored bars changed, from that date on, for
  // whatever is computed from past bars
  changed: { instrument: string; changedFrom: string }[];
  error: string | null;
};

export type TickReport = {
  // markets whose every instrument was asked, in session or after close
  quoted: string[];
  // closed markets checked with one instrument
  checked: string[];
  bars: BarPass[];
};

export type YahooJobs = {
  tick(): Promise<TickReport>;
  // the instrument backfilled, if any was waiting
  backfillTurn(): Promise<string | null>;
  schedule(jobs: Scheduler): void;
};

function byMarket(
  instruments: readonly Instrument[],
): Map<string, Instrument[]> {
  const out = new Map<string, Instrument[]>();
  for (const i of instruments) {
    if (i.source !== SOURCE) continue;
    const list = out.get(i.market);
    if (list) list.push(i);
    else out.set(i.market, [i]);
  }
  return out;
}

export function yahooJobs(options: JobsOptions): YahooJobs {
  const { ctx, quoteEveryMs, log } = options;
  const { db, clock, yahoo, writer } = ctx;
  let lastSlot: number | null = null;
  const backfillFailed = new Map<string, number>();

  // what each market needs now; quotePass is the turn of the period
  function plan(
    markets: Map<string, Instrument[]>,
    now: number,
    quotePass: boolean,
  ): Work[] {
    const work: Work[] = [];
    for (const [market, instruments] of markets) {
      const s = readSession(db, market);
      if (isQuoted(market, s, now)) {
        if (quotePass) work.push({ market, job: JOBS.quotes, instruments });
        continue;
      }
      const one = instruments.slice(0, 1);
      // a market with no stored session yet is asked on the period
      if (s === null) {
        if (quotePass) work.push({ market, job: JOBS.check, instruments: one });
        continue;
      }
      const close = closeQuoteAt(market, s);
      if (close !== null && now >= close) {
        const last = lastStarted(db, SOURCE, JOBS.quotes, market);
        if (last === null || last.startedAt < close) {
          work.push({ market, job: JOBS.quotes, instruments });
          continue;
        }
      }
      // from the last attempt, so a source that is down is not asked on
      // every tick
      const checked = lastStarted(db, SOURCE, JOBS.check, market);
      const since = Math.max(s.fetchedAt, checked?.startedAt ?? 0);
      if (now >= nextCheck(s, since)) {
        work.push({ market, job: JOBS.check, instruments: one });
      }
    }
    return work;
  }

  // every market's symbols in one set of spark calls of 20, and one
  // run per market
  async function sparkPass(work: Work[]): Promise<QuoteRow[]> {
    const ids = await writer.write((db) =>
      work.map((w) => startRun(db, SOURCE, w.job, clock.now(), w.market)),
    );
    try {
      const symbols = [
        ...new Set(
          work.flatMap((w) => w.instruments.map((i) => i.sourceSymbol)),
        ),
      ];
      const batches = await yahoo.sparkAll(symbols);
      const failed = new Map<string, unknown>();
      const answers: SparkAnswer[] = [];
      for (const b of batches) {
        if (b.answer) answers.push(b.answer);
        else for (const s of b.symbols) failed.set(s, b.error);
      }
      return await writer.write((db) => {
        const quotes = answers.flatMap((a) => storeQuotes(db, a));
        const now = clock.now();
        work.forEach((w, k) => {
          const mine = new Set(w.instruments.map((i) => i.id));
          const rows = quotes.filter((q) => mine.has(q.instrument)).length;
          const error = w.instruments
            .map((i) => failed.get(i.sourceSymbol))
            .find((e) => e !== undefined);
          if (error === undefined) endRun(db, ids[k]!, now, rows);
          else {
            failRun(db, ids[k]!, now, error, rows);
            log.warn("yahoo quotes failed", {
              market: w.market,
              job: w.job,
              error: phraseOf(error),
            });
          }
        });
        return quotes;
      });
    } catch (error) {
      await writer
        .write((db) => {
          for (const id of ids) failRun(db, id, clock.now(), error);
        })
        .catch(() => {});
      throw error;
    }
  }

  // The last 30 days of each instrument with bars: finalises the
  // previous bar, applies a new split before the session's quotes are
  // used, and fills gaps. An instrument with none waits for backfill.
  async function barPass(
    market: string,
    instruments: Instrument[],
  ): Promise<BarPass> {
    const id = await writer.write((db) =>
      startRun(db, SOURCE, JOBS.bars, clock.now(), market),
    );
    let rows = 0;
    let error: unknown;
    const changed: BarPass["changed"] = [];
    for (const instrument of instruments) {
      const has = db
        .query<{ n: number }, [string]>(
          "select count(*) as n from bars where instrument = ? and interval = '1d'",
        )
        .get(instrument.id)!.n;
      if (has === 0) continue;
      try {
        const written = await refetch(ctx, instrument);
        rows += written.rows;
        if (written.changedFrom !== null) {
          changed.push({
            instrument: instrument.id,
            changedFrom: written.changedFrom,
          });
        }
      } catch (e) {
        error ??= e;
        log.warn("yahoo bars failed", {
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
    const from = changed.map((c) => c.changedFrom).sort()[0];
    log.info("yahoo bars refetched", {
      market,
      rows,
      changed: changed.length,
      changed_from: from,
    });
    return {
      market,
      rows,
      changed,
      error: error === undefined ? null : phraseOf(error),
    };
  }

  async function tick(): Promise<TickReport> {
    const now = clock.now();
    const slot = Math.floor(now / quoteEveryMs);
    const quotePass = slot !== lastSlot;
    lastSlot = slot;
    let markets = byMarket(readInstruments(db));
    const work = plan(markets, now, quotePass);
    if (work.length > 0) await sparkPass(work);

    // the answers may have moved a session on
    markets = byMarket(readInstruments(db));
    const bars: BarPass[] = [];
    for (const [market, instruments] of markets) {
      if (!barsDue(db, SOURCE, market, clock.now())) continue;
      const last = lastStarted(db, SOURCE, JOBS.bars, market);
      if (
        last?.status === "failed" &&
        clock.now() - last.startedAt < RETRY_MS
      ) {
        continue;
      }
      bars.push(await barPass(market, instruments));
    }
    return {
      quoted: work.filter((w) => w.job === JOBS.quotes).map((w) => w.market),
      checked: work.filter((w) => w.job === JOBS.check).map((w) => w.market),
      bars,
    };
  }

  async function backfillTurn(): Promise<string | null> {
    const now = clock.now();
    const waiting = db
      .query<{ id: string }, [string]>(
        `select id from instruments i where source = ?
           and not exists (select 1 from bars b
             where b.instrument = i.id and b.interval = '1d')
         order by added_at, id`,
      )
      .all(SOURCE)
      .map((r) => r.id)
      .filter((id) => now - (backfillFailed.get(id) ?? -RETRY_MS) >= RETRY_MS);
    const instrument =
      waiting[0] === undefined ? null : readInstrument(db, waiting[0]);
    if (instrument === null) return null;
    try {
      await runJob(writer, clock, SOURCE, BACKFILL_JOB, async () => {
        const written = await backfill(ctx, instrument);
        return written.rows;
      });
    } catch (error) {
      backfillFailed.set(instrument.id, now);
      throw error;
    }
    backfillFailed.delete(instrument.id);
    return instrument.id;
  }

  return {
    tick,
    backfillTurn,
    schedule(jobs) {
      jobs.every("yahoo", TICK_MS, async () => {
        await tick();
      });
      jobs.every("yahoo-backfill", TICK_MS, async () => {
        await backfillTurn();
      });
    },
  };
}
