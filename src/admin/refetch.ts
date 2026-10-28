// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// Each source's own fetch code; the runs it records are the ones the jobs read.

import type { Written } from "../market/bars.ts";
import { checkSource, type Instrument, Moved } from "../market/instruments.ts";
import { JOBS } from "../market/stale.ts";
import type { Markets } from "../operations/markets.ts";
import { errorFields } from "../runtime/log.ts";
import type { Bvb } from "../sources/bvb/client.ts";
import { storeBvbQuotes } from "../sources/bvb/quotes.ts";
import { backfill as bvbBackfill, quoteNow } from "../sources/bvb/sync.ts";
import {
  eligible as finnhubEligible,
  type Section,
} from "../sources/finnhub/store.ts";
import { refreshResearch } from "../sources/finnhub/sync.ts";
import { refetchSeries } from "../sources/fred/sync.ts";
import { BVB, FRED, YAHOO } from "../sources/ids.ts";
import {
  eligible as massiveEligible,
  refreshNews,
} from "../sources/massive/store.ts";
import {
  DeadlinePassed,
  expired,
  Paused,
  QueueClosed,
  SourceError,
} from "../sources/source.ts";
import { storeQuotes } from "../sources/yahoo/quotes.ts";
import {
  requireQuote,
  backfill as yahooBackfill,
} from "../sources/yahoo/sync.ts";
import { endRun, failRun, startRun } from "../storage/runs.ts";
import { WriterClosed } from "../storage/writer.ts";

export const PARTS = [
  "bars",
  "quotes",
  "research",
  "calendar",
  "news",
] as const;
export type Part = (typeof PARTS)[number];

// Finnhub's sections but the calendar, which is a part of its own
export const RESEARCH_SECTIONS = [
  "metric",
  "analysts",
  "earnings",
  "insider",
] as const satisfies readonly Section[];
export type ResearchSection = (typeof RESEARCH_SECTIONS)[number];

export type Outcome =
  | { status: "fetched"; rows: number }
  | { status: "not covered" }
  | { status: "source off" }
  | { status: "failed"; error: string };

export type Result = {
  symbol: string;
  part: Part;
  section?: ResearchSection;
} & Outcome;

export type Plan = {
  parts: readonly Part[];
  sections: readonly ResearchSection[];
};

const fetched = (rows: number): Outcome => ({ status: "fetched", rows });
const NOT_COVERED: Outcome = { status: "not covered" };
const OFF: Outcome = { status: "source off" };
const TIMED_OUT: Outcome = { status: "failed", error: "timed out" };

// a fixed phrase for every error, never its text
function failed(m: Markets, error: unknown): Outcome {
  let phrase: string;
  if (error instanceof Paused) phrase = `backing off after ${error.phrase}`;
  else if (error instanceof DeadlinePassed) phrase = "timed out";
  else if (error instanceof QueueClosed || error instanceof WriterClosed) {
    phrase = "the server is stopping";
  } else if (error instanceof Moved) phrase = "moved to another source";
  else if (error instanceof SourceError) phrase = error.phrase;
  else {
    m.log.error("admin refetch failed", errorFields(error));
    phrase = "failed";
  }
  return { status: "failed", error: phrase };
}

// as the jobs do: what never reached the source records no run, which
// would hold off the job's retry
const reached = (error: unknown): boolean =>
  !(
    error instanceof Paused ||
    error instanceof DeadlinePassed ||
    error instanceof QueueClosed ||
    error instanceof WriterClosed ||
    error instanceof Moved
  );

// a failed refetch is the instrument's own bars run, as in the bar pass
async function failBars(
  m: Markets,
  source: string,
  id: string,
  at: number,
  error: unknown,
): Promise<void> {
  if (!reached(error)) return;
  await m.writer
    .write((db) =>
      failRun(
        db,
        startRun(db, source, JOBS.bars, at, id),
        m.clock.now(),
        error,
      ),
    )
    .catch(() => {});
}

const yahooCtx = (m: Markets, live: () => boolean) => ({
  db: m.db,
  clock: m.clock,
  writer: m.writer,
  yahoo: m.yahoo.within(live),
  rules: m.rules,
});

const bvbCtx = (m: Markets, bvb: Bvb, live: () => boolean) => ({
  db: m.db,
  clock: m.clock,
  writer: m.writer,
  bvb: bvb.within(live),
  rules: m.rules,
});

// the whole history, so a day stored by old code is written again
async function bars(
  m: Markets,
  i: Instrument,
  live: () => boolean,
): Promise<Outcome> {
  const at = m.clock.now();
  let written: Written;
  try {
    if (i.source === YAHOO || i.source === BVB) {
      if (i.source === YAHOO) {
        written = await yahooBackfill(yahooCtx(m, live), i, live);
      } else {
        if (m.bvb === null) return OFF;
        written = await bvbBackfill(bvbCtx(m, m.bvb, live), i, live);
      }
    } else if (i.source === FRED) {
      const fred = m.fred;
      if (fred === null) return OFF;
      const ctx = {
        db: m.db,
        clock: m.clock,
        writer: m.writer,
        fred: fred.within(live),
        rules: m.rules,
      };
      written = await refetchSeries(ctx, i, live, true);
      // as the series pass: the run ends, then its rules read it
      await m.writer.write((db) => {
        const now = m.clock.now();
        endRun(db, startRun(db, FRED, JOBS.bars, at, i.id), now, written.rows);
        m.rules.evaluate(db, [i.id], now);
      });
    } else return NOT_COVERED;
  } catch (error) {
    await failBars(m, i.source, i.id, at, error);
    return failed(m, error);
  }
  if (i.source !== FRED) {
    // the store's own evaluation ran before its run cleared a failed one;
    // outside the try, since the bars landed whatever this write does
    await m.writer
      .write((db) => m.rules.evaluate(db, [i.id], m.clock.now()))
      .catch(() => {});
  }
  return fetched(written.rows);
}

// no run: a quote run is the market's, and one symbol is not its pass
async function quotes(
  m: Markets,
  i: Instrument,
  live: () => boolean,
): Promise<Outcome> {
  try {
    if (i.source === YAHOO) {
      const answer = await m.yahoo.within(live).spark([i.sourceSymbol]);
      const symbol = i.sourceSymbol.toUpperCase();
      if (!answer.quotes.some((q) => q.symbol.toUpperCase() === symbol)) {
        const skipped = answer.skipped.find(
          (s) => s.symbol?.toUpperCase() === symbol,
        );
        throw new SourceError(skipped?.phrase ?? "source error");
      }
      requireQuote(answer, i.sourceSymbol, i.id);
      return fetched(
        await m.writer.write((db) => {
          if (!live()) throw expired();
          checkSource(db, i);
          return storeQuotes(db, answer, m.rules, m.clock.now()).length;
        }),
      );
    }
    if (i.source === BVB) {
      if (m.bvb === null) return OFF;
      const quote = await quoteNow(bvbCtx(m, m.bvb, live), i);
      return fetched(
        await m.writer.write((db) => {
          if (!live()) throw expired();
          checkSource(db, i);
          return storeBvbQuotes(db, [quote], m.rules, m.clock.now()).length;
        }),
      );
    }
    // a FRED series has no quote
    return NOT_COVERED;
  } catch (error) {
    return failed(m, error);
  }
}

// each section on its own, so one backing off never hides another's rows
async function research(
  m: Markets,
  i: Instrument,
  section: Section,
  live: () => boolean,
): Promise<Outcome> {
  const finnhub = m.finnhub;
  if (finnhub === null) return OFF;
  if (!finnhubEligible(i)) return NOT_COVERED;
  try {
    const [r] = await refreshResearch(
      { db: m.db, clock: m.clock, writer: m.writer, finnhub },
      i,
      [section],
      { live, hooks: m.hooks, client: finnhub.within(live) },
    );
    if (r === undefined) return fetched(0);
    return r.status === "ok" ? fetched(r.rows) : failed(m, r.error);
  } catch (error) {
    return failed(m, error);
  }
}

// one page, as a tool asks: a walk the deadline cuts stores nothing
async function news(
  m: Markets,
  i: Instrument,
  live: () => boolean,
): Promise<Outcome> {
  const massive = m.massive;
  if (massive === null) return OFF;
  if (!massiveEligible(i)) return NOT_COVERED;
  try {
    const r = await refreshNews(
      { db: m.db, clock: m.clock, writer: m.writer, massive },
      i,
      { live, maxPages: 1, client: massive.within(live) },
    );
    return r.status === "ok" ? fetched(r.rows) : failed(m, r.error);
  } catch (error) {
    return failed(m, error);
  }
}

const EXPIRED = Symbol("expired");

// every part at once: each source's own queue or limiter paces its calls
export async function refetch(
  m: Markets,
  instruments: readonly Instrument[],
  plan: Plan,
): Promise<Result[]> {
  const deadline = m.clock.now() + m.callMs;
  const live = () => m.clock.now() < deadline;
  let cancel = () => {};
  const expiry = new Promise<typeof EXPIRED>((resolve) => {
    cancel = m.clock.at(deadline, () => resolve(EXPIRED));
  });
  const tasks: Promise<Result>[] = [];
  const add = (
    i: Instrument,
    part: Part,
    run: () => Promise<Outcome>,
    section?: ResearchSection,
  ) => {
    const base = { symbol: i.id, part, ...(section ? { section } : {}) };
    tasks.push(
      // a call in flight may run to its own timeout; the answer does not
      Promise.race([run(), expiry]).then(
        (o): Result => ({ ...base, ...(o === EXPIRED ? TIMED_OUT : o) }),
      ),
    );
  };
  for (const i of instruments) {
    for (const part of plan.parts) {
      if (part === "bars") add(i, part, () => bars(m, i, live));
      else if (part === "quotes") add(i, part, () => quotes(m, i, live));
      else if (part === "news") add(i, part, () => news(m, i, live));
      else if (part === "calendar") {
        add(i, part, () => research(m, i, "calendar", live));
      } else {
        for (const s of plan.sections) {
          add(i, part, () => research(m, i, s, live), s);
        }
      }
    }
  }
  try {
    return await Promise.all(tasks);
  } finally {
    cancel();
  }
}
