// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The Bucharest feed's schedule: one check of the trading schedule page
// a day, the list pages each quote period while the session is open and
// once an exchange day whatever is tracked, and the 30-day refetch once a
// new session shows.

import {
  closeQuoteAt,
  isQuoted,
  nextCheck,
  readSession,
  recordSession,
  type StoredSession,
} from "../calendars.ts";
import { DAY_MS, MINUTE_MS } from "../clock.ts";
import { type Instrument, Moved } from "../instruments.ts";
import type { Log } from "../log.ts";
import type { QuoteRow } from "../quotes.ts";
import { endRun, failRun, lastStarted, startRun } from "../runs.ts";
import type { Scheduler } from "../scheduler.ts";
import { phraseOf, SourceError } from "../source.ts";
import { barsDue, JOBS } from "../stale.ts";
import { TRACK_MS, trackedInstruments } from "../tracking.ts";
import { RETRY_MS } from "../yahoo/sync.ts";
import { localDate } from "../zone.ts";
import {
  type ListKind,
  type ListRow,
  MARKET,
  type Schedule,
  SOURCE,
} from "./client.ts";
import {
  type BvbContext,
  detailQuote,
  indexQuote,
  listQuote,
  refetch,
  sessionOf,
  storeBvbQuotes,
} from "./sync.ts";

export const TICK_MS = MINUTE_MS;
const HOUR_MS = 60 * MINUTE_MS;

export type BvbJobsOptions = {
  ctx: BvbContext;
  quoteEveryMs: number;
  log: Log;
  trackMs?: number;
};

export type BvbTick = {
  quoted: boolean;
  checked: boolean;
  // the instruments whose bars a pass refetched
  bars: string[];
};

export type BvbJobs = {
  quoteTick(): Promise<Omit<BvbTick, "bars">>;
  barTick(): Promise<string[]>;
  // quotes and checks, then the bars due, as both jobs run in a minute
  tick(): Promise<BvbTick>;
  schedule(jobs: Scheduler): void;
};

type Traded = ListRow & { price: number; at: number };

const traded = (r: ListRow | undefined): r is Traded =>
  r !== undefined && r.price !== null && r.at !== null;

export function bvbJobs(options: BvbJobsOptions): BvbJobs {
  const { ctx, quoteEveryMs, log } = options;
  const { db, clock, bvb, writer } = ctx;
  const trackMs = options.trackMs ?? TRACK_MS;
  const tracked = () =>
    trackedInstruments(db, clock.now(), trackMs).filter(
      (i) => i.source === SOURCE,
    );
  let lastSlot: number | null = null;
  // the last schedule read, so a market with no session yet is checked at
  // its local start and hourly after, not on every period
  let template: Schedule | null = null;
  // a list page that failed waits RETRY_MS, as a failed bar refetch does
  const listFailed = new Map<ListKind, number>();
  const pages: [ListKind, () => Promise<unknown>][] = [
    ["shares", () => bvb.shares()],
    ["bonds", () => bvb.bonds()],
    ["indices", () => bvb.indices()],
  ];

  // the exchange's zone from its session or a stored listing; none known
  // yet, a day is a day since the last read
  function zoneOf(): string | null {
    const s = readSession(db, MARKET);
    if (s !== null) return s.zone;
    const row = db
      .query<{ zone: string }, [string]>(
        "select zone from instruments where source = ? limit 1",
      )
      .get(SOURCE);
    return row?.zone ?? null;
  }

  // every list page once an exchange day, so resolution knows what the
  // exchange lists without its search; a quote pass's read counts
  async function readLists(): Promise<void> {
    const zone = zoneOf();
    for (const [kind, read] of pages) {
      const now = clock.now();
      const at = bvb.listedAt(kind);
      if (at !== null) {
        const today =
          zone === null
            ? now - at < DAY_MS
            : localDate(zone, at) === localDate(zone, now);
        if (today) continue;
      }
      const failed = listFailed.get(kind);
      if (failed !== undefined && now - failed < RETRY_MS) continue;
      try {
        await read();
        listFailed.delete(kind);
      } catch (error) {
        listFailed.set(kind, clock.now());
        log.warn("bvb list failed", { list: kind, error: phraseOf(error) });
      }
    }
  }

  function checkDue(
    s: StoredSession | null,
    zone: string,
    now: number,
  ): boolean {
    const last = lastStarted(db, SOURCE, JOBS.check, MARKET);
    if (s !== null) {
      return now >= nextCheck(s, Math.max(s.fetchedAt, last?.startedAt ?? 0));
    }
    if (last === null) return true;
    if (template === null) return now - last.startedAt >= HOUR_MS;
    return (
      now >=
      nextCheck(sessionOf(zone, template, last.startedAt), last.startedAt)
    );
  }

  // a closed status starts no session, so no quote pass follows it
  async function check(zone: string): Promise<void> {
    const id = await writer.write((db) =>
      startRun(db, SOURCE, JOBS.check, clock.now(), MARKET),
    );
    try {
      const s = await bvb.schedule();
      template = s;
      await writer.write((db) => {
        const opened = s.status === "open";
        if (opened) {
          recordSession(
            db,
            MARKET,
            sessionOf(zone, s, s.fetchedAt),
            s.fetchedAt,
          );
        }
        endRun(db, id, clock.now(), opened ? 1 : 0);
      });
    } catch (error) {
      await writer
        .write((db) => failRun(db, id, clock.now(), error))
        .catch(() => {});
      log.warn("bvb check failed", { error: phraseOf(error) });
    }
  }

  // one call per list page the tracked kinds need, and an instrument page
  // for each listing's first trade of a day, for its reference price
  async function quotePass(instruments: Instrument[]): Promise<void> {
    const id = await writer.write((db) =>
      startRun(db, SOURCE, JOBS.quotes, clock.now(), MARKET),
    );
    const quotes: QuoteRow[] = [];
    let failed: unknown;
    // listed on its page, traded or not
    let seen = 0;
    const of = (type: string) => instruments.filter((i) => i.type === type);
    const lists: [
      ListKind,
      Instrument[],
      () => Promise<{ rows: ListRow[]; fetchedAt: number }>,
    ][] = [
      ["shares", of("EQUITY"), () => bvb.shares()],
      ["bonds", of("BOND"), () => bvb.bonds()],
    ];
    for (const [kind, mine, read] of lists) {
      if (mine.length === 0) continue;
      let page: { rows: ListRow[]; fetchedAt: number };
      try {
        page = await read();
      } catch (error) {
        listFailed.set(kind, clock.now());
        failed ??= error;
        continue;
      }
      const rows = new Map(page.rows.map((r) => [r.symbol, r]));
      for (const i of mine) {
        const row = rows.get(i.sourceSymbol);
        if (row !== undefined) seen++;
        if (!traded(row)) continue;
        const q = listQuote(db, i, row, page.fetchedAt);
        if (q !== null) {
          quotes.push(q);
          continue;
        }
        try {
          const d = detailQuote(i, await bvb.detail(i.sourceSymbol));
          if (d !== null) quotes.push(d);
        } catch (error) {
          log.warn("bvb quote missing", {
            instrument: i.id,
            error: phraseOf(error),
          });
        }
      }
    }
    const indices = of("INDEX");
    if (indices.length > 0) {
      try {
        const page = await bvb.indices();
        const rows = new Map(page.rows.map((r) => [r.symbol.toUpperCase(), r]));
        for (const i of indices) {
          const row = rows.get(i.symbol);
          if (row === undefined) continue;
          seen++;
          quotes.push(indexQuote(i, row, page.fetchedAt));
        }
      } catch (error) {
        listFailed.set("indices", clock.now());
        failed ??= error;
      }
    }
    // the run fails on a page it could not read, or when no listing it
    // asked for is on its page
    const error =
      failed ?? (seen === 0 ? new SourceError("not found") : undefined);
    await writer.write((db) => {
      const now = clock.now();
      const stored = storeBvbQuotes(db, quotes, undefined, now);
      if (error === undefined) endRun(db, id, now, stored.length);
      else failRun(db, id, now, error, stored.length);
      // after the run ends, so a quote's staleness is this pass's
      ctx.rules?.evaluate(
        db,
        quotes.map((q) => q.instrument),
        now,
      );
    });
    if (error !== undefined) {
      log.warn("bvb quotes failed", { error: phraseOf(error) });
    }
  }

  // after the quotes, so the pages a pass read are not read twice
  async function quoteTick(): Promise<Omit<BvbTick, "bars">> {
    const done = await quoteOrCheck();
    await readLists();
    return done;
  }

  async function quoteOrCheck(): Promise<Omit<BvbTick, "bars">> {
    const now = clock.now();
    const slot = Math.floor(now / quoteEveryMs);
    const periodTurn = slot !== lastSlot;
    lastSlot = slot;
    const instruments = tracked();
    if (instruments.length === 0) return { quoted: false, checked: false };
    const s = readSession(db, MARKET);
    if (isQuoted(MARKET, s, now)) {
      if (!periodTurn) return { quoted: false, checked: false };
      await quotePass(instruments);
      return { quoted: true, checked: false };
    }
    if (s !== null) {
      const close = closeQuoteAt(MARKET, s);
      const last = lastStarted(db, SOURCE, JOBS.quotes, MARKET);
      if (
        close !== null &&
        now >= close &&
        (last === null || last.startedAt < close)
      ) {
        await quotePass(instruments);
        return { quoted: true, checked: false };
      }
    }
    if (!checkDue(s, instruments[0]!.zone, now)) {
      return { quoted: false, checked: false };
    }
    await check(instruments[0]!.zone);
    return { quoted: false, checked: true };
  }

  // a failed refetch is its instrument's own run, so it alone is stale
  async function barPass(
    instruments: Instrument[],
    marketRun: boolean,
  ): Promise<string[]> {
    const id = marketRun
      ? await writer.write((db) =>
          startRun(db, SOURCE, JOBS.bars, clock.now(), MARKET),
        )
      : null;
    let rows = 0;
    const done: string[] = [];
    const failures: { instrument: string; at: number; error: unknown }[] = [];
    for (const instrument of instruments) {
      const at = clock.now();
      try {
        rows += (await refetch(ctx, instrument)).rows;
        done.push(instrument.id);
      } catch (error) {
        // another source holds it now, and its own jobs keep its bars
        if (error instanceof Moved) continue;
        failures.push({ instrument: instrument.id, at, error });
        log.warn("bvb bars failed", {
          instrument: instrument.id,
          error: phraseOf(error),
        });
      }
    }
    const error =
      done.length === 0 && failures.length > 0 ? failures[0]!.error : undefined;
    // the session's bars are in, so its price levels can be read again
    await writer.write((db) => {
      const now = clock.now();
      for (const f of failures) {
        failRun(
          db,
          startRun(db, SOURCE, JOBS.bars, f.at, f.instrument),
          now,
          f.error,
        );
      }
      if (id !== null) {
        if (error === undefined) endRun(db, id, now, rows);
        else failRun(db, id, now, error, rows);
      }
      ctx.rules?.evaluate(
        db,
        instruments.map((i) => i.id),
        now,
      );
    });
    return done;
  }

  async function barTick(): Promise<string[]> {
    const instruments = tracked();
    if (instruments.length === 0) return [];
    const now = clock.now();
    if (!barsDue(db, SOURCE, MARKET, now)) {
      // an instrument whose own refetch failed is retried alone
      const retry = instruments.filter((i) => {
        const last = lastStarted(db, SOURCE, JOBS.bars, i.id);
        return last?.status === "failed" && now - last.startedAt >= RETRY_MS;
      });
      return retry.length > 0 ? barPass(retry, false) : [];
    }
    const last = lastStarted(db, SOURCE, JOBS.bars, MARKET);
    if (last?.status === "failed" && now - last.startedAt < RETRY_MS) return [];
    return barPass(instruments, true);
  }

  // the check may record a new session before the bars are read
  async function tick(): Promise<BvbTick> {
    const quotes = await quoteTick();
    return { ...quotes, bars: await barTick() };
  }

  return {
    quoteTick,
    barTick,
    tick,
    schedule(jobs) {
      jobs.every("bvb", TICK_MS, async () => {
        await quoteTick();
      });
      jobs.every("bvb-bars", TICK_MS, async () => {
        await barTick();
      });
    },
  };
}
