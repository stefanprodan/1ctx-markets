// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// a run per walk, scoped to the instrument, so one failure is stale alone

import { checkStored, type Instrument } from "../../market/instruments.ts";
import { type Clock, DAY_MS, MINUTE_MS } from "../../runtime/clock.ts";
import { exclusive } from "../../runtime/lock.ts";
import type { Db } from "../../storage/db/index.ts";
import { lastStarted } from "../../storage/runs.ts";
import type { Writer } from "../../storage/writer.ts";
import { WriterClosed } from "../../storage/writer.ts";
import {
  DeadlinePassed,
  Paused,
  phraseOf,
  QueueClosed,
  SourceError,
} from "../source.ts";
import {
  type Article,
  type Massive,
  type Page,
  type Sentiment,
  SOURCE,
} from "./client.ts";

export const JOB = "news";
export const KEPT_MS = 30 * DAY_MS;
export const EVERY_MS = 30 * MINUTE_MS;
// for an article published late with an earlier time
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

// null while the source is off
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
  // the title, publisher or reasoning was cut
  truncated: boolean;
  fetchedAt: number;
};

// an exact match only, so JPMpC is never JPM
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
    truncated: a.truncated || own?.truncated === true,
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

// Where an unfinished walk goes on: Massive's own cursor, or null to
// start it again from the newest article; the top walk keeps its floor.
export type WalkState = { cursor: string | null; after: number | null };
export type Walks = { top: WalkState | null; history: WalkState | null };

export function readWalks(db: Db, instrument: string): Walks {
  const rows = db
    .query<WalkState & { walk: "top" | "history" }, [string]>(
      "select walk, cursor, after from news_walks where instrument = ?",
    )
    .all(instrument);
  const of = (walk: string) => {
    const r = rows.find((w) => w.walk === walk);
    return r === undefined ? null : { cursor: r.cursor, after: r.after };
  };
  return { top: of("top"), history: of("history") };
}

export function newsAsked(db: Db, instrument: string): boolean {
  return lastStarted(db, SOURCE, JOB, instrument, "ok") !== null;
}

// a closing server or a read past its deadline says nothing about the
// source, so no run is recorded for it
const aborts = (error: unknown): boolean =>
  error instanceof QueueClosed ||
  error instanceof WriterClosed ||
  error instanceof DeadlinePassed;

// a cursor Massive no longer answers is started again, never retried
const expired = (error: unknown): boolean =>
  error instanceof SourceError &&
  (error.phrase === "not found" || error.phrase === "bad request");

export type NewsResult =
  | { status: "ok"; rows: number; pages: number; complete: boolean }
  | { status: "failed"; rows: number; pages: number; error: unknown };

// resumes from Massive's cursor, never a time: no tie at a page edge is lost
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
  // its own lock key, so news never waits on the instrument's bar fetch
  return exclusive(ctx.db, `${SOURCE}:${instrument.id}`, async () => {
    const startedAt = ctx.clock.now();
    const floor = startedAt - KEPT_MS;
    const newest = newestPublished(ctx.db, instrument.id);
    const walks = readWalks(ctx.db, instrument.id);
    const first =
      walks.top === null &&
      walks.history === null &&
      !newsAsked(ctx.db, instrument.id);
    // pages asked, a refusal while backing off, and a cursor to restart
    const seen = { pages: 0, paused: null as Paused | null, reset: false };
    const rows: NewsRow[] = [];
    let error: unknown = null;
    const stopped = () => error !== null || seen.paused !== null;

    const walk = async (
      from: WalkState,
      after: number,
      limit: number,
    ): Promise<WalkState | null> => {
      let cursor = from.cursor;
      for (let n = 0; n < limit; n++) {
        if (!live()) throw new DeadlinePassed();
        if (seen.pages >= maxPages || !more() || stopped()) break;
        let page: Page;
        try {
          page =
            cursor === null
              ? await client.news({ ticker: symbol, after })
              : await client.next(cursor);
        } catch (e) {
          if (aborts(e)) throw e;
          if (e instanceof Paused) seen.paused = e;
          else if (cursor !== null && expired(e)) {
            cursor = null;
            seen.reset = true;
          } else error = e;
          break;
        }
        seen.pages++;
        for (const a of page.articles) {
          if (a.publishedAt <= after || a.publishedAt <= floor) continue;
          const row = rowFor(a, symbol, page.fetchedAt);
          if (row !== null) rows.push(row);
        }
        const last = page.articles.at(-1)?.publishedAt ?? null;
        // newest first, so a page reaching the floor is the last needed
        if (page.next === null || last === null || last <= after) return null;
        cursor = page.next;
      }
      return { cursor, after: from.after };
    };

    // a new walk that got no page leaves nothing to go on from
    const fresh = async (after: number) => {
      const before = seen.pages;
      const state = await walk({ cursor: null, after }, after, maxPages);
      return seen.pages === before ? null : state;
    };
    let top = walks.top;
    let history = walks.history;
    if (first) {
      const state = await fresh(floor);
      history = state === null ? null : { cursor: state.cursor, after: null };
    } else {
      // an unfinished history always gets a page, whatever the top needs
      if (history !== null) history = await walk(history, floor, 1);
      // a new top walk waits for the next run once one was finished, or
      // the pages left would cut it again over the same overlap
      const resumed = top !== null;
      // a walk saved long ago stops at today's floor, not its own
      if (top !== null) {
        top = await walk(top, Math.max(top.after ?? floor, floor), maxPages);
      }
      if (top === null && !resumed && !stopped()) {
        const after =
          newest === null ? floor : Math.max(floor, newest - OVERLAP_MS);
        top = await fresh(after);
      }
      if (history !== null) history = await walk(history, floor, maxPages);
    }

    const { pages, paused } = seen;
    // no call reached the source, refused or cut by a budget: no run
    // records it, so neither a retry nor the next walk is held off
    if (pages === 0 && error === null && !seen.reset) {
      if (paused !== null) throw paused;
      return { status: "ok", rows: 0, pages: 0, complete: false };
    }

    const result = await ctx.writer.write((db): NewsResult => {
      if (!live()) throw new DeadlinePassed();
      checkStored(db, instrument.id);
      const now = ctx.clock.now();
      const stored = storeRows(db, instrument.id, rows);
      saveWalk(db, instrument.id, "top", top);
      saveWalk(db, instrument.id, "history", history);
      recordRun(db, instrument.id, startedAt, now, stored, error);
      return error === null
        ? {
            status: "ok",
            rows: stored,
            pages,
            complete: top === null && history === null,
          }
        : { status: "failed", rows: stored, pages, error };
    });
    if (paused !== null) throw paused;
    return result;
  });
}

function saveWalk(
  db: Db,
  instrument: string,
  walk: "top" | "history",
  state: WalkState | null,
): void {
  if (state === null) {
    db.query("delete from news_walks where instrument = ? and walk = ?").run(
      instrument,
      walk,
    );
    return;
  }
  db.query(
    `insert into news_walks (instrument, walk, cursor, after)
     values (?, ?, ?, ?)
     on conflict (instrument, walk) do update set
       cursor = excluded.cursor, after = excluded.after`,
  ).run(instrument, walk, state.cursor, state.after);
}

function storeRows(
  db: Db,
  instrument: string,
  rows: readonly NewsRow[],
): number {
  const upsert = db.query(
    `insert into news (instrument, id, published_at, title, url, publisher,
       sentiment, reasoning, truncated, fetched_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     on conflict (instrument, id) do update set
       published_at = excluded.published_at,
       title = excluded.title,
       url = excluded.url,
       publisher = excluded.publisher,
       sentiment = excluded.sentiment,
       reasoning = excluded.reasoning,
       truncated = excluded.truncated,
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
      r.truncated ? 1 : 0,
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

export function newsState(db: Db, instrument: string, now: number): NewsState {
  const ok = lastStarted(db, SOURCE, JOB, instrument, "ok");
  const last = lastStarted(db, SOURCE, JOB, instrument);
  const stale: string[] = [];
  if (ok === null) stale.push(STALE_NEWS.none);
  if (last?.status === "failed") stale.push(STALE_NEWS.failed);
  else if (ok !== null && now - ok.startedAt >= 2 * EVERY_MS) {
    stale.push(STALE_NEWS.pending);
  }
  const walks = readWalks(db, instrument);
  if (walks.top !== null || walks.history !== null) {
    stale.push(STALE_NEWS.older);
  }
  return { fetchedAt: ok?.endedAt ?? null, stale };
}

// where a page of news starts: older than this article
export type NewsCursor = { publishedAt: number; id: string };

type StoredRow = Omit<NewsRow, "truncated"> & { truncated: number };

const COLUMNS = `id, published_at as publishedAt, title, url, publisher,
  sentiment, reasoning, truncated, fetched_at as fetchedAt`;

const asRow = (r: StoredRow): NewsRow => ({
  ...r,
  truncated: r.truncated === 1,
});

// newest first, ties by id, below the cursor when given, from since on; only
// the last 30 days, whether or not retention has run
export function readNews(
  db: Db,
  instrument: string,
  now: number,
  limit: number,
  from: NewsCursor | null = null,
  since: number | null = null,
): NewsRow[] {
  return db
    .query<StoredRow, [string, number, number, string, number, number]>(
      `select ${COLUMNS}
       from news where instrument = ?1 and published_at > ?2
         and published_at >= ?6
         and (?3 < 0 or published_at < ?3 or (published_at = ?3 and id < ?4))
       order by published_at desc, id desc limit ?5`,
    )
    .all(
      instrument,
      now - KEPT_MS,
      from?.publishedAt ?? -1,
      from?.id ?? "",
      limit,
      since ?? 0,
    )
    .map(asRow);
}

// unknown is an article Massive gave no sentiment for this ticker
export type NewsCounts = {
  positive: number;
  neutral: number;
  negative: number;
  unknown: number;
};

// the articles readNews answers from since, by sentiment
export function countNews(
  db: Db,
  instrument: string,
  now: number,
  since: number,
): NewsCounts {
  const counts = { positive: 0, neutral: 0, negative: 0, unknown: 0 };
  const rows = db
    .query<
      { sentiment: Sentiment | null; n: number },
      [string, number, number]
    >(
      `select sentiment, count(*) as n from news
       where instrument = ?1 and published_at > ?2 and published_at >= ?3
       group by sentiment`,
    )
    .all(instrument, now - KEPT_MS, since);
  for (const r of rows) counts[r.sentiment ?? "unknown"] = r.n;
  return counts;
}

// Articles that take a side first, then neutral, then none, each newest
// first: a neutral one is most often a passing mention of the ticker.
export function topNews(
  db: Db,
  instrument: string,
  now: number,
  since: number,
  limit: number,
): NewsRow[] {
  return db
    .query<StoredRow, [string, number, number, number]>(
      `select ${COLUMNS}
       from news where instrument = ?1 and published_at > ?2
         and published_at >= ?3
       order by case when sentiment is null then 2
           when sentiment = 'neutral' then 1 else 0 end,
         published_at desc, id desc limit ?4`,
    )
    .all(instrument, now - KEPT_MS, since, limit)
    .map(asRow);
}

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
      "select instrument from news union select instrument from news_walks",
    )
    .all();
  for (const { instrument } of held) {
    if (tracked.has(instrument)) continue;
    n += db
      .query("delete from news where instrument = ?")
      .run(instrument).changes;
    db.query("delete from news_walks where instrument = ?").run(instrument);
  }
  return n;
}
