// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import {
  closeQuoteAt,
  isQuoted,
  nextCheck,
  readSession,
} from "../calendars.ts";
import { type Instrument, Moved, readInstrument } from "../instruments.ts";
import type { QuoteRow } from "../quotes.ts";
import { MINUTE_MS } from "../runtime/clock.ts";
import type { Log } from "../runtime/log.ts";
import type { Scheduler } from "../runtime/scheduler.ts";
import { type Phrase, phraseOf, SourceError } from "../source.ts";
import { RETRY_MS } from "../sources/history.ts";
import { barsDue, JOBS, owedDue } from "../stale.ts";
import {
  endRun,
  failRun,
  lastStarted,
  runJob,
  startRun,
} from "../storage/runs.ts";
import { TRACK_MS, trackedIds, trackedInstruments } from "../tracking.ts";
import { SOURCE, type SparkAnswer } from "./client.ts";
import { backfill, refetch, storeQuotes, type YahooContext } from "./sync.ts";

export const TICK_MS = MINUTE_MS;
export { RETRY_MS };
export const BACKFILL_JOB = "backfill";

export type JobsOptions = {
  ctx: YahooContext;
  quoteEveryMs: number;
  log: Log;
  // read within this long, or held by a rule, keeps an instrument synced
  trackMs?: number;
};

type Work = {
  market: string;
  job: typeof JOBS.quotes | typeof JOBS.check;
  instruments: Instrument[];
};

export type BarPass = {
  market: string;
  rows: number;
  // the first changed day per instrument, for whatever past bars feed
  changed: { instrument: string; changedFrom: string }[];
  error: string | null;
};

export type TickReport = {
  // markets whose every instrument was asked, in session or after close
  quoted: string[];
  checked: string[];
  bars: BarPass[];
};

export type YahooJobs = {
  // quotes and checks, then the bars due, as both jobs run in a minute
  tick(): Promise<TickReport>;
  quoteTick(): Promise<Omit<TickReport, "bars">>;
  barTick(): Promise<BarPass[]>;
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
  const trackMs = options.trackMs ?? TRACK_MS;
  const tracked = () => byMarket(trackedInstruments(db, clock.now(), trackMs));
  let lastSlot: number | null = null;
  // each market's next check instrument, so one that never answers
  // cannot hide a new session from the rest
  const checkTurn = new Map<string, number>();
  const nextOne = (market: string, instruments: Instrument[]) => {
    const k = checkTurn.get(market) ?? 0;
    checkTurn.set(market, k + 1);
    return [instruments[k % instruments.length]!];
  };
  // when each instrument's backfill last failed or answered no bars
  const backfillMissed = new Map<string, number>();

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
      // a market with no stored session yet is asked on the period
      if (s === null) {
        if (quotePass) {
          const one = nextOne(market, instruments);
          work.push({ market, job: JOBS.check, instruments: one });
        }
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
        const one = nextOne(market, instruments);
        work.push({ market, job: JOBS.check, instruments: one });
      }
    }
    return work;
  }

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
      const missing = new Map<string, Phrase>();
      const answers: SparkAnswer[] = [];
      for (const b of batches) {
        if (!b.answer) {
          for (const s of b.symbols) failed.set(s, b.error);
          continue;
        }
        answers.push(b.answer);
        // a symbol skipped or left out is stale on its own
        const quoted = new Set(b.answer.quotes.map((q) => q.symbol));
        const skipped = new Map(
          b.answer.skipped.map((k) => [k.symbol, k.phrase]),
        );
        for (const s of b.symbols) {
          if (quoted.has(s)) continue;
          const phrase = skipped.get(s) ?? "malformed answer";
          missing.set(s, phrase);
          log.warn("yahoo quote missing", { symbol: s, error: phrase });
        }
      }
      return await writer.write((db) => {
        const quotes = answers.flatMap((a) => storeQuotes(db, a));
        const now = clock.now();
        work.forEach((w, k) => {
          const mine = new Set(w.instruments.map((i) => i.id));
          const rows = quotes.filter((q) => mine.has(q.instrument)).length;
          // the run fails on a failed call, or when no quote came back
          const symbols = w.instruments.map((i) => i.sourceSymbol);
          const none = symbols.every((s) => missing.has(s));
          const error =
            symbols.map((s) => failed.get(s)).find((e) => e !== undefined) ??
            (none ? new SourceError(missing.get(symbols[0]!)!) : undefined);
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
        // after the runs end, so a quote's staleness is this pass's
        ctx.rules?.evaluate(
          db,
          quotes.map((q) => q.instrument),
          now,
        );
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

  // a failed refetch is its instrument's own run, so it alone is stale
  async function barPass(
    market: string,
    instruments: Instrument[],
    marketRun = true,
  ): Promise<BarPass> {
    const id = marketRun
      ? await writer.write((db) =>
          startRun(db, SOURCE, JOBS.bars, clock.now(), market),
        )
      : null;
    let rows = 0;
    const changed: BarPass["changed"] = [];
    const attempts: {
      instrument: string;
      at: number;
      error?: unknown;
    }[] = [];
    for (const instrument of instruments) {
      const has = db
        .query<{ n: number }, [string]>(
          "select count(*) as n from bars where instrument = ? and interval = '1d'",
        )
        .get(instrument.id)!.n;
      // an instrument with no bars waits for the backfill job
      if (has === 0) continue;
      const at = clock.now();
      try {
        const written = await refetch(ctx, instrument);
        attempts.push({ instrument: instrument.id, at });
        rows += written.rows;
        if (written.changedFrom !== null) {
          changed.push({
            instrument: instrument.id,
            changedFrom: written.changedFrom,
          });
        }
      } catch (e) {
        // another source holds it now, and its own jobs keep its bars
        if (e instanceof Moved) continue;
        attempts.push({ instrument: instrument.id, at, error: e });
        log.warn("yahoo bars failed", {
          instrument: instrument.id,
          error: phraseOf(e),
        });
      }
    }
    const error =
      attempts.length > 0 && attempts.every((a) => "error" in a)
        ? attempts[0]!.error
        : undefined;
    // the session's bars are in, so its price levels can be read again
    await writer.write((db) => {
      const now = clock.now();
      for (const a of attempts) {
        if (!("error" in a)) continue;
        const run = startRun(db, SOURCE, JOBS.bars, a.at, a.instrument);
        failRun(db, run, now, a.error);
      }
      if (id !== null) {
        if (error === undefined) endRun(db, id, now, rows);
        else failRun(db, id, now, error, rows);
      }
      ctx.rules?.evaluate(
        db,
        instruments.map((i) => i.id),
        clock.now(),
      );
    });
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

  async function quoteTick(): Promise<Omit<TickReport, "bars">> {
    const now = clock.now();
    const slot = Math.floor(now / quoteEveryMs);
    const quotePass = slot !== lastSlot;
    lastSlot = slot;
    const work = plan(tracked(), now, quotePass);
    if (work.length > 0) await sparkPass(work);
    return {
      quoted: work.filter((w) => w.job === JOBS.quotes).map((w) => w.market),
      checked: work.filter((w) => w.job === JOBS.check).map((w) => w.market),
    };
  }

  async function barTick(): Promise<BarPass[]> {
    const bars: BarPass[] = [];
    for (const [market, instruments] of tracked()) {
      if (!barsDue(db, SOURCE, market, clock.now())) {
        // an instrument whose own refetch failed or left a close owed is
        // retried alone
        const owed = owedDue(db, SOURCE, market, instruments, clock.now());
        const retry = instruments.filter((i) => {
          const last = lastStarted(db, SOURCE, JOBS.bars, i.id);
          return (
            (last?.status === "failed" &&
              clock.now() - last.startedAt >= RETRY_MS) ||
            owed.includes(i)
          );
        });
        if (retry.length > 0) bars.push(await barPass(market, retry, false));
        continue;
      }
      const last = lastStarted(db, SOURCE, JOBS.bars, market);
      if (
        last?.status === "failed" &&
        clock.now() - last.startedAt < RETRY_MS
      ) {
        continue;
      }
      bars.push(await barPass(market, instruments));
    }
    return bars;
  }

  // the quote answers may move a session on before the bars are read
  async function tick(): Promise<TickReport> {
    const quotes = await quoteTick();
    return { ...quotes, bars: await barTick() };
  }

  // tracked only: an untracked instrument is fetched inside the read naming it
  async function backfillTurn(): Promise<string | null> {
    const now = clock.now();
    const wanted = trackedIds(db, now, trackMs);
    const waiting = db
      .query<{ id: string }, [string]>(
        `select id from instruments i where source = ?
           and not exists (select 1 from bars b
             where b.instrument = i.id and b.interval = '1d')
         order by added_at, id`,
      )
      .all(SOURCE)
      .map((r) => r.id)
      .filter((id) => wanted.has(id))
      .filter((id) => now - (backfillMissed.get(id) ?? -RETRY_MS) >= RETRY_MS);
    const instrument =
      waiting[0] === undefined ? null : readInstrument(db, waiting[0]);
    if (instrument === null) return null;
    let rows: number;
    try {
      rows = await runJob(writer, clock, SOURCE, BACKFILL_JOB, async () => {
        const written = await backfill(ctx, instrument);
        return written.rows;
      });
    } catch (error) {
      backfillMissed.set(instrument.id, now);
      throw error;
    }
    // an empty answer waits like a failure, so the next instrument goes
    if (rows === 0) backfillMissed.set(instrument.id, now);
    else backfillMissed.delete(instrument.id);
    return instrument.id;
  }

  return {
    tick,
    quoteTick,
    barTick,
    backfillTurn,
    schedule(jobs) {
      jobs.every("yahoo", TICK_MS, async () => {
        await quoteTick();
      });
      jobs.every("yahoo-bars", TICK_MS, async () => {
        await barTick();
      });
      jobs.every("yahoo-backfill", TICK_MS, async () => {
        await backfillTurn();
      });
    },
  };
}
