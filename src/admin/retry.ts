// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// Only a failed instrument's part is asked again; a market's job asks
// again within the hour on its own.

import { readInstrument } from "../market/instruments.ts";
import { JOBS } from "../market/stale.ts";
import type { Markets } from "../operations/markets.ts";
import { FILINGS_JOB } from "../sources/edgar/store.ts";
import { BVB, EDGAR, FINNHUB, FRED, MASSIVE, YAHOO } from "../sources/ids.ts";
import { JOB as NEWS_JOB } from "../sources/massive/store.ts";
import { BACKFILL_JOB } from "../sources/yahoo/jobs.ts";
import { TOP_HOLDINGS_JOB } from "../sources/yahoo/top-holdings.ts";
import { VALUATION_JOB } from "../sources/yahoo/valuation.ts";
import {
  fetchAll,
  type JobPart,
  RESEARCH_SECTIONS,
  type ResearchSection,
  type Task,
} from "./refetch.ts";

export type FailingScope = { source: string; job: string; scope: string };

export type Retried = {
  asked: number;
  fetched: number;
  failed: number;
  left_out: number;
};

type Ask = { part: JobPart; section?: ResearchSection };

// owed is left out: its runs never fail, and a good bars run writes one
// only while a day is still owed
function askOf(source: string, job: string): Ask | null {
  if (source === MASSIVE && job === NEWS_JOB) return { part: "news" };
  if (source === FINNHUB) {
    if (job === "calendar") return { part: "calendar" };
    const section = RESEARCH_SECTIONS.find((s) => s === job);
    return section === undefined ? null : { part: "research", section };
  }
  if (source === EDGAR && job === FILINGS_JOB) return { part: "filings" };
  if (source === YAHOO) {
    if (job === TOP_HOLDINGS_JOB) return { part: "top_holdings" };
    if (job === VALUATION_JOB) return { part: "valuation" };
    // a backfill is settled once any bars are stored
    if (job === BACKFILL_JOB) return { part: "bars" };
  }
  if (
    (source === YAHOO || source === BVB || source === FRED) &&
    job === JOBS.bars
  ) {
    return { part: "bars" };
  }
  return null;
}

// one fetch per instrument and part, however many failed rows ask it
export async function retryFailed(
  m: Markets,
  failing: readonly FailingScope[],
): Promise<Retried> {
  const tasks: Task[] = [];
  const byKey = new Map<string, number>();
  const rows: number[] = [];
  for (const f of failing) {
    const ask = f.scope.includes(":") ? askOf(f.source, f.job) : null;
    const instrument = ask === null ? null : readInstrument(m.db, f.scope);
    if (ask === null || instrument === null) continue;
    // a bars row of a source the instrument has moved from stays its own
    if (ask.part === "bars" && instrument.source !== f.source) continue;
    const key = `${instrument.id}|${ask.part}|${ask.section ?? ""}`;
    let at = byKey.get(key);
    if (at === undefined) {
      const failAs = ask.part === "bars" ? { failAs: [] } : {};
      at = tasks.push({ instrument, ...ask, ...failAs }) - 1;
      byKey.set(key, at);
    }
    tasks[at]!.failAs?.push(f.job);
    rows.push(at);
  }
  const results = await fetchAll(m, tasks);
  let fetched = 0;
  let failed = 0;
  for (const at of rows) {
    const status = results[at]!.status;
    if (status === "fetched") fetched++;
    else if (status === "failed") failed++;
  }
  return {
    asked: fetched + failed,
    fetched,
    failed,
    left_out: failing.length - fetched - failed,
  };
}
