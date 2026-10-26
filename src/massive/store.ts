// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Massive's news per tracked US ticker: which instruments are asked, how
// one instrument's news is walked from the newest article down to what
// is stored, and how each article lands. Each walk records one run
// scoped to the instrument, so one ticker failing is stale alone.

import { type Clock, DAY_MS, MINUTE_MS } from "../clock.ts";
import type { Db } from "../db/index.ts";
import type { Instrument } from "../instruments.ts";
import { exclusive } from "../lock.ts";
import { lastStarted } from "../runs.ts";
import { DeadlinePassed, Paused, phraseOf, QueueClosed } from "../source.ts";
import type { Writer } from "../writer.ts";
import { WriterClosed } from "../writer.ts";
import {
  type Article,
  type Massive,
  type Page,
  type Sentiment,
  SOURCE,
} from "./client.ts";

export const JOB = "news";
export const KEPT_MS = 30 * DAY_MS;
// each ticker is asked this often
export const EVERY_MS = 30 * MINUTE_MS;
// asked again from this far before the newest stored article, for one
// published late with an earlier time
export const OVERLAP_MS = 2 * 60 * MINUTE_MS;
// pages one run follows for one ticker; the rest continue next run
export const MAX_PAGES = 3;

// what a read answers while the source is off, never an error
export const NO_NEWS = "no news source";
export const NEWS_NOT_COVERED =
  "no news: Massive is asked for US-listed shares and ETFs only";

export const STALE_NEWS = {
  failed: "news sync failed",
  pending: "news sync pending",
  none: "no news yet",
  older: "older news pending",
} as const;

// db is for reads; every write goes through writer; massive is null
// while the source is off
export type MassiveContext = {
  db: Db;
  clock: Clock;
  writer: Writer;
  massive: Massive | null;
};

// Massive's news is mostly US: only US shares and ETFs are asked.
export function eligible(i: Pick<Instrument, "market" | "type">): boolean {
  return i.market === "US" && (i.type === "EQUITY" || i.type === "ETF");
}

// a class share is BRK-B on Yahoo and BRK.B on Massive
export const massiveSymbol = (i: Pick<Instrument, "symbol">): string =>
  i.symbol.replaceAll("-", ".");

export type NewsRow = {
  id: string;
  publishedAt: number;
  title: string;
  url: string;
  publisher: string | null;
  sentiment: Sentiment | null;
  reasoning: string | null;
  fetchedAt: number;
};

// The article as one ticker's row, or null when the ticker is not one
// of its own: only an exact match counts, so JPMpC is not JPM.
export function rowFor(
  a: Article,
  symbol: string,
  fetchedAt: number,
): NewsRow | null {
  const own = a.insights.find((i) => i.ticker === symbol);
  if (own === undefined && !a.tickers.includes(symbol)) return null;
  return {
    id: a.id,
    publishedAt: a.publishedAt,
    title: a.title,
    url: a.url,
    publisher: a.publisher,
    sentiment: own?.sentiment ?? null,
    reasoning: own?.reasoning ?? null,
    fetchedAt,
  };
}

export function newestPublished(db: Db, instrument: string): number | null {
  return (
    db
      .query<{ at: number | null }, [string]>(
        "select max(published_at) as at from news where instrument = ?",
      )
      .get(instrument)?.at ?? null
  );
}

// the time below which the instrument's 30 days are not complete yet
export function backfillBefore(db: Db, instrument: string): number | null {
  return (
    db
      .query<{ before: number }, [string]>(
        "select before from news_backfill where instrument = ?",
      )
      .get(instrument)?.before ?? null
  );
}

// whether a run of the instrument's news ever ended well
export function newsAsked(db: Db, instrument: string): boolean {
  return lastStarted(db, SOURCE, JOB, instrument, "ok") !== null;
}

type Walk = {
  rows: NewsRow[];
  // the oldest article the walk reached, null with none
  oldest: number | null;
  // reached the window's floor or the last page
  complete: boolean;
  error: unknown;
};

// a closing server or a read past its deadline says nothing about the
// source, so no run is recorded for it
const aborts = (error: unknown): boolean =>
  error instanceof QueueClosed ||
  error instanceof WriterClosed ||
  error instanceof DeadlinePassed;

export type NewsResult =
  | { status: "ok"; rows: number; pages: number; complete: boolean }
  | { status: "failed"; rows: number; pages: number; error: unknown };

// Walks one ticker's news newest first, from the top and then down the
// part not complete yet, each article kept for this ticker alone and
// deduplicated by its id. What was fetched is stored in one write with
// one run; a page that failed is the run's failure, with the pages
// before it kept, and where it stopped is where the next run goes on.
// A passed deadline or a closing server stores nothing and is thrown;
// a tool's call refused while the source backs off records no run.
export async function refreshNews(
  ctx: MassiveContext,
  instrument: Instrument,
  options: {
    // false past a read's deadline: the walk throws, storing nothing
    live?: () => boolean;
    // false past a job tick's budget: the walk stops, storing its pages
    more?: () => boolean;
    maxPages?: number;
    client?: Massive;
  } = {},
): Promise<NewsResult> {
  const client = options.client ?? ctx.massive;
  if (client === null) throw new Error("massive is off");
  const live = options.live ?? (() => true);
  const more = options.more ?? (() => true);
  const maxPages = options.maxPages ?? MAX_PAGES;
  const symbol = massiveSymbol(instrument);
  return exclusive(ctx.db, `${SOURCE}:${instrument.id}`, async () => {
    const startedAt = ctx.clock.now();
    const floor = startedAt - KEPT_MS;
    const newest = newestPublished(ctx.db, instrument.id);
    const gap = backfillBefore(ctx.db, instrument.id);
    // what the walks share: pages asked, and a refusal while backing off
    const seen = { pages: 0, paused: null as Paused | null };

    const walk = async (after: number, before: number | null) => {
      const w: Walk = { rows: [], oldest: null, complete: false, error: null };
      let page: Page | null = null;
      for (;;) {
        if (!live()) throw new DeadlinePassed();
        if (seen.pages >= maxPages || !more()) return w;
        try {
          page =
            page === null
              ? await client.news({ ticker: symbol, after, before })
              : await client.next(page.next!);
        } catch (error) {
          if (aborts(error)) throw error;
          if (error instanceof Paused) seen.paused = error;
          else w.error = error;
          return w;
        }
        seen.pages++;
        for (const a of page.articles) {
          if (a.publishedAt <= after) continue;
          if (before !== null && a.publishedAt >= before) continue;
          const row = rowFor(a, symbol, page.fetchedAt);
          if (row !== null) w.rows.push(row);
        }
        const last = page.articles.at(-1)?.publishedAt ?? null;
        if (last !== null) w.oldest = Math.min(w.oldest ?? last, last);
        // newest first, so a page reaching the floor is the last needed
        if (page.next === null || last === null || last <= after) {
          w.complete = true;
          return w;
        }
      }
    };

    const top = await walk(
      newest === null ? floor : Math.max(floor, newest - OVERLAP_MS),
      null,
    );
    const rows = [...top.rows];
    let error = top.error;
    // where the next run goes on below, null once all 30 days are in
    let resume: number | null;
    if (!top.complete) {
      // cut short: everything under where it stopped is asked again
      resume = top.oldest ?? gap;
    } else if (newest === null) {
      // the first walk came down to the floor
      resume = null;
    } else {
      resume = gap;
      if (gap !== null) {
        const down = await walk(floor, gap);
        rows.push(...down.rows);
        error = down.error;
        resume = down.complete ? null : (down.oldest ?? gap);
      }
    }
    const { pages, paused } = seen;
    // no call reached the source, refused or cut by a budget: no run
    // records it, so neither a retry nor the next walk is held off
    if (pages === 0 && error === null) {
      if (paused !== null) throw paused;
      return { status: "ok", rows: 0, pages: 0, complete: false };
    }

    const result = await ctx.writer.write((db): NewsResult => {
      if (!live()) throw new DeadlinePassed();
      const now = ctx.clock.now();
      const stored = storeRows(db, instrument.id, rows);
      if (resume === null || resume <= now - KEPT_MS) {
        db.query("delete from news_backfill where instrument = ?").run(
          instrument.id,
        );
      } else {
        db.query(
          `insert into news_backfill (instrument, before) values (?, ?)
           on conflict (instrument) do update set before = excluded.before`,
        ).run(instrument.id, resume);
      }
      recordRun(db, instrument.id, startedAt, now, stored, error);
      return error === null
        ? {
            status: "ok",
            rows: stored,
            pages,
            complete: resume === null,
          }
        : failedResult(stored, pages, error);
    });
    if (paused !== null) throw paused;
    return result;
  });
}

const failedResult = (
  rows: number,
  pages: number,
  error: unknown,
): NewsResult => ({ status: "failed", rows, pages, error });

function storeRows(
  db: Db,
  instrument: string,
  rows: readonly NewsRow[],
): number {
  const upsert = db.query(
    `insert into news (instrument, id, published_at, title, url, publisher,
       sentiment, reasoning, fetched_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?)
     on conflict (instrument, id) do update set
       published_at = excluded.published_at,
       title = excluded.title,
       url = excluded.url,
       publisher = excluded.publisher,
       sentiment = excluded.sentiment,
       reasoning = excluded.reasoning,
       fetched_at = excluded.fetched_at`,
  );
  const seen = new Set<string>();
  for (const r of rows) {
    // a page boundary can repeat an article; it is one row
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    upsert.run(
      instrument,
      r.id,
      r.publishedAt,
      r.title,
      r.url,
      r.publisher,
      r.sentiment,
      r.reasoning,
      r.fetchedAt,
    );
  }
  return seen.size;
}

function recordRun(
  db: Db,
  instrument: string,
  startedAt: number,
  now: number,
  rows: number,
  error: unknown,
): void {
  const failed = error !== null;
  db.query(
    `insert into sync_runs (source, job, scope, started_at, ended_at, status,
       rows, error)
     values (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    SOURCE,
    JOB,
    instrument,
    startedAt,
    now,
    failed ? "failed" : "ok",
    rows,
    failed ? phraseOf(error) : null,
  );
}

// due when no run of the ticker started within the period
export function newsDue(db: Db, instrument: string, now: number): boolean {
  const last = lastStarted(db, SOURCE, JOB, instrument);
  return last === null || now - last.startedAt >= EVERY_MS;
}

export type NewsState = {
  // when the last good run ended, null before the first
  fetchedAt: number | null;
  stale: string[];
};

// The ticker's own runs only: never asked, its last run failed, no good
// run for two periods, or its 30 days not complete yet.
export function newsState(db: Db, instrument: string, now: number): NewsState {
  const ok = lastStarted(db, SOURCE, JOB, instrument, "ok");
  const last = lastStarted(db, SOURCE, JOB, instrument);
  const stale: string[] = [];
  if (ok === null) stale.push(STALE_NEWS.none);
  if (last?.status === "failed") stale.push(STALE_NEWS.failed);
  else if (ok !== null && now - ok.startedAt >= 2 * EVERY_MS) {
    stale.push(STALE_NEWS.pending);
  }
  if (backfillBefore(db, instrument) !== null) stale.push(STALE_NEWS.older);
  return { fetchedAt: ok?.endedAt ?? null, stale };
}

// where a page of news starts: older than this article
export type NewsCursor = { publishedAt: number; id: string };

// newest first, ties by id, from below the cursor when one is given
export function readNews(
  db: Db,
  instrument: string,
  limit: number,
  from: NewsCursor | null = null,
): NewsRow[] {
  return db
    .query<NewsRow, [string, number, string, number]>(
      `select id, published_at as publishedAt, title, url, publisher,
         sentiment, reasoning, fetched_at as fetchedAt
       from news where instrument = ?1
         and (?2 < 0 or published_at < ?2 or (published_at = ?2 and id < ?3))
       order by published_at desc, id desc limit ?4`,
    )
    .all(instrument, from?.publishedAt ?? -1, from?.id ?? "", limit);
}

// Articles past 30 days go, and those of an instrument no longer tracked,
// with where its backfill stood.
export function pruneNews(
  db: Db,
  now: number,
  tracked: ReadonlySet<string>,
): number {
  let n = db
    .query("delete from news where published_at <= ?")
    .run(now - KEPT_MS).changes;
  const held = db
    .query<{ instrument: string }, []>(
      `select instrument from news union select instrument from news_backfill`,
    )
    .all();
  for (const { instrument } of held) {
    if (tracked.has(instrument)) continue;
    n += db
      .query("delete from news where instrument = ?")
      .run(instrument).changes;
    db.query("delete from news_backfill where instrument = ?").run(instrument);
  }
  db.query("delete from news_backfill where before <= ?").run(now - KEPT_MS);
  return n;
}
