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
import { eligible as edgarEligible } from "../sources/edgar/store.ts";
import { refreshFilings } from "../sources/edgar/sync.ts";
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
import {
  refreshTopHoldings,
  asked as topHoldingsAsked,
} from "../sources/yahoo/top-holdings.ts";
import {
  refreshValuation,
  covered as valuationCovered,
} from "../sources/yahoo/valuation.ts";
import { endRun, failRun, startRun } from "../storage/runs.ts";
import { WriterClosed } from "../storage/writer.ts";

export const PARTS = [
  "bars",
  "quotes",
  "research",
  "calendar",
  "news",
  "top_holdings",
] as const;
export type Part = (typeof PARTS)[number];
// a daily job's own fetch, asked again only by the failed jobs' retry
export type JobPart = Part | "valuation" | "filings";

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

export type Result<P extends JobPart = Part> = {
  symbol: string;
  part: P;
  section?: ResearchSection;
} & Outcome;

export type Task<P extends JobPart = JobPart> = {
  instrument: Instrument;
  part: P;
  section?: ResearchSection;
  // the jobs a failed bars fetch fails, so a retry fails only the rows it asked
  failAs?: string[];
};

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
  jobs: readonly string[],
): Promise<void> {
  if (!reached(error)) return;
  await m.writer
    .write((db) => {
      for (const job of jobs) {
        failRun(db, startRun(db, source, job, at, id), m.clock.now(), error);
      }
    })
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
  failAs: readonly string[] = [JOBS.bars],
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
    await failBars(m, i.source, i.id, at, error, failAs);
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

// a fund Yahoo lists; any other instrument has none to ask
async function topHoldings(
  m: Markets,
  i: Instrument,
  live: () => boolean,
): Promise<Outcome> {
  if (!topHoldingsAsked(i)) return NOT_COVERED;
  try {
    const r = await refreshTopHoldings(m, i, {
      live,
      client: m.yahoo.within(live),
    });
    if (r === null) return fetched(0);
    return r.status === "ok" ? fetched(r.rows) : failed(m, r.error);
  } catch (error) {
    return failed(m, error);
  }
}

// a US share Finnhub answers from a foreign listing
async function valuation(
  m: Markets,
  i: Instrument,
  live: () => boolean,
): Promise<Outcome> {
  if (!valuationCovered(m.db, i)) return NOT_COVERED;
  try {
    const r = await refreshValuation(yahooCtx(m, live), i, {
      live,
      client: m.yahoo.within(live),
    });
    if (r === null) return fetched(0);
    return r.status === "ok" ? fetched(r.rows) : failed(m, r.error);
  } catch (error) {
    return failed(m, error);
  }
}

async function filings(
  m: Markets,
  i: Instrument,
  live: () => boolean,
): Promise<Outcome> {
  const edgar = m.edgar;
  if (edgar === null) return OFF;
  if (!edgarEligible(i)) return NOT_COVERED;
  try {
    const r = await refreshFilings(
      { db: m.db, clock: m.clock, writer: m.writer, edgar },
      i,
      { live, client: edgar.within(live) },
    );
    return r.status === "ok" ? fetched(r.rows) : failed(m, r.error);
  } catch (error) {
    return failed(m, error);
  }
}

function runOf(
  m: Markets,
  t: Task,
  live: () => boolean,
): () => Promise<Outcome> {
  const i = t.instrument;
  switch (t.part) {
    case "bars":
      return () => bars(m, i, live, t.failAs);
    case "quotes":
      return () => quotes(m, i, live);
    case "news":
      return () => news(m, i, live);
    case "top_holdings":
      return () => topHoldings(m, i, live);
    case "calendar":
      return () => research(m, i, "calendar", live);
    case "research":
      return () => research(m, i, t.section!, live);
    case "valuation":
      return () => valuation(m, i, live);
    case "filings":
      return () => filings(m, i, live);
  }
}

const EXPIRED = Symbol("expired");

// every task at once under one deadline: each source's own queue or
// limiter paces its calls
export async function fetchAll<P extends JobPart>(
  m: Markets,
  tasks: readonly Task<P>[],
): Promise<Result<P>[]> {
  const deadline = m.clock.now() + m.callMs;
  const live = () => m.clock.now() < deadline;
  let cancel = () => {};
  const expiry = new Promise<typeof EXPIRED>((resolve) => {
    cancel = m.clock.at(deadline, () => resolve(EXPIRED));
  });
  const answers = tasks.map((t) => {
    const base = {
      symbol: t.instrument.id,
      part: t.part,
      ...(t.section ? { section: t.section } : {}),
    };
    // a call in flight may run to its own timeout; the answer does not
    return Promise.race([runOf(m, t, live)(), expiry]).then(
      (o): Result<P> => ({ ...base, ...(o === EXPIRED ? TIMED_OUT : o) }),
    );
  });
  try {
    return await Promise.all(answers);
  } finally {
    cancel();
  }
}

export function refetch(
  m: Markets,
  instruments: readonly Instrument[],
  plan: Plan,
): Promise<Result[]> {
  const tasks: Task<Part>[] = [];
  for (const instrument of instruments) {
    for (const part of plan.parts) {
      if (part !== "research") tasks.push({ instrument, part });
      else {
        for (const section of plan.sections) {
          tasks.push({ instrument, part, section });
        }
      }
    }
  }
  return fetchAll(m, tasks);
}
