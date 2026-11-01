// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// A fund's ten largest holdings, its asset split, sectors and bond ratings
// from Yahoo's quote summary; replaced once a day, no history.

import {
  checkStored,
  type Instrument,
  readBySourceSymbol,
} from "../../market/instruments.ts";
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
import { dueAt } from "../finnhub/store.ts";
import { RETRY_MS } from "../history.ts";
import { YAHOO } from "../ids.ts";
import {
  DeadlinePassed,
  Paused,
  phraseOf,
  QueueClosed,
  SourceError,
} from "../source.ts";
import type {
  FundPositions,
  FundWeight,
  TopHoldings,
  Yahoo,
} from "./client.ts";
import type { YahooContext } from "./sync.ts";

export const TOP_HOLDINGS_JOB = "top_holdings";
export const TOP_HOLDINGS_TICK_MS = MINUTE_MS;
export const NO_TOP_HOLDINGS = "Yahoo has no top holdings for this fund.";
export const NOT_A_FUND = "Top holdings are for ETFs and mutual funds only.";
export const TOP_ONLY =
  "the fund's ten largest positions as Yahoo lists them, not its full list; Yahoo gives no as-of date";

// an owner-priced fund is type FUND, so never one of these
const FUND_TYPES = new Set(["ETF", "MUTUALFUND"]);

export const isFund = (i: Pick<Instrument, "type">): boolean =>
  FUND_TYPES.has(i.type);

// a fund another source prices has no Yahoo listing to ask
export const asked = (i: Pick<Instrument, "type" | "source">): boolean =>
  isFund(i) && i.source === YAHOO;

export type StoredHolding = {
  rank: number;
  symbol: string | null;
  // the stored instrument that has this symbol as its Yahoo listing
  id: string | null;
  name: string;
  weight: number;
};

export type StoredTopHoldings = {
  fetchedAt: number;
  positions: FundPositions;
  government: number | null;
  holdings: StoredHolding[];
  // largest first
  sectors: FundWeight[];
  ratings: FundWeight[];
};

export function readTopHoldings(
  db: Db,
  instrument: string,
): StoredTopHoldings | null {
  const head = db
    .query<
      FundPositions & { fetchedAt: number; government: number | null },
      [string]
    >(
      `select fetched_at as fetchedAt, stock, bond, cash, other, preferred,
         convertible, government
       from fund_top_holdings where instrument = ?`,
    )
    .get(instrument);
  if (head === null) return null;
  const holdings = db
    .query<Omit<StoredHolding, "id">, [string]>(
      `select rank, symbol, name, weight from fund_top_holding_rows
       where instrument = ? order by rank`,
    )
    .all(instrument)
    .map((h) => ({
      ...h,
      // joined at answer time: a holding is never resolved or fetched
      id:
        h.symbol === null
          ? null
          : (readBySourceSymbol(db, YAHOO, h.symbol.toUpperCase())?.id ?? null),
    }));
  const weights = (kind: "sector" | "rating") =>
    db
      .query<FundWeight, [string, string]>(
        `select key, weight from fund_weights
         where instrument = ? and kind = ? order by weight desc, key`,
      )
      .all(instrument, kind);
  const { fetchedAt, government, ...positions } = head;
  return {
    fetchedAt,
    positions,
    government,
    holdings,
    sectors: weights("sector"),
    ratings: weights("rating"),
  };
}

export const topHoldingsFetched = (db: Db, instrument: string): boolean =>
  lastStarted(db, YAHOO, TOP_HOLDINGS_JOB, instrument, "ok") !== null;

// the research stale phrases, on the daily refresh's schedule
export function topHoldingsState(db: Db, instrument: string, now: number) {
  const ok = lastStarted(db, YAHOO, TOP_HOLDINGS_JOB, instrument, "ok");
  const last = lastStarted(db, YAHOO, TOP_HOLDINGS_JOB, instrument);
  const stale: string[] = [];
  if (ok === null) stale.push(STALE_RESEARCH.none);
  if (failedRun(last)) stale.push(STALE_RESEARCH.failed);
  else if (ok !== null && ok.startedAt < dueAt(now)) {
    stale.push(STALE_RESEARCH.pending);
  }
  return { fetchedAt: ok?.endedAt ?? null, stale };
}

const failedLately = (db: Db, instrument: string, now: number): boolean => {
  const last = lastStarted(db, YAHOO, TOP_HOLDINGS_JOB, instrument);
  return failedRun(last) && now - last.startedAt < RETRY_MS;
};

// A page re-reads its route every minute, so a fund that keeps failing
// is asked inline at most once per retry wait.
export const inlineDue = (db: Db, instrument: string, now: number): boolean =>
  !topHoldingsFetched(db, instrument) && !failedLately(db, instrument, now);

// once a day after 23:00 UTC, the first time on the next tick
export function topHoldingsDue(
  db: Db,
  instrument: string,
  now: number,
): boolean {
  const ok = lastStarted(db, YAHOO, TOP_HOLDINGS_JOB, instrument, "ok");
  if (ok !== null && ok.startedAt >= dueAt(now)) return false;
  return !failedLately(db, instrument, now);
}

const clear = (db: Db, instrument: string) => {
  for (const table of [
    "fund_top_holding_rows",
    "fund_weights",
    "fund_top_holdings",
  ]) {
    db.query(`delete from ${table} where instrument = ?`).run(instrument);
  }
};

// one write replaces the three; none from Yahoo deletes them
function store(db: Db, instrument: string, answer: TopHoldings): number {
  clear(db, instrument);
  const fund = answer.fund;
  if (fund === null) return 0;
  const p = fund.positions;
  db.query(
    `insert into fund_top_holdings (instrument, fetched_at, stock, bond, cash,
       other, preferred, convertible, government)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    instrument,
    answer.fetchedAt,
    p.stock,
    p.bond,
    p.cash,
    p.other,
    p.preferred,
    p.convertible,
    fund.government,
  );
  const row = db.query(
    `insert into fund_top_holding_rows (instrument, rank, symbol, name, weight)
     values (?, ?, ?, ?, ?)`,
  );
  for (const [k, h] of fund.holdings.entries()) {
    row.run(instrument, k + 1, h.symbol, h.name, h.weight);
  }
  const weight = db.query(
    `insert into fund_weights (instrument, kind, key, weight)
     values (?, ?, ?, ?)`,
  );
  for (const s of fund.sectors)
    weight.run(instrument, "sector", s.key, s.weight);
  for (const r of fund.ratings)
    weight.run(instrument, "rating", r.key, r.weight);
  return 1 + fund.holdings.length + fund.sectors.length + fund.ratings.length;
}

export type TopHoldingsResult =
  | { status: "ok"; rows: number }
  | { status: "failed"; error: unknown };

// a closing server or a read past its deadline says nothing about the
// source, nor does a back-off met before asking, so none records a run
const aborts = (error: unknown): boolean =>
  error instanceof QueueClosed ||
  error instanceof WriterClosed ||
  error instanceof DeadlinePassed ||
  error instanceof Paused;

// Yahoo's 404 is its answer that it has none, asked again the next day
const none = (error: unknown): boolean =>
  error instanceof SourceError && error.phrase === "not found";

export async function refreshTopHoldings(
  ctx: Pick<YahooContext, "db" | "clock" | "writer" | "yahoo">,
  instrument: Instrument,
  options: {
    live?: () => boolean;
    client?: Yahoo;
    // read again once the lock is held, so a caller that waited on
    // another's fetch asks nothing it stored
    due?: (db: Db) => boolean;
  } = {},
): Promise<TopHoldingsResult | null> {
  const live = options.live ?? (() => true);
  const client = options.client ?? ctx.yahoo;
  return exclusive(
    ctx.db,
    `${YAHOO}:${TOP_HOLDINGS_JOB}:${instrument.id}`,
    async () => {
      if (options.due !== undefined && !options.due(ctx.db)) return null;
      if (!live()) throw new DeadlinePassed();
      const startedAt = ctx.clock.now();
      let outcome: { answer: TopHoldings } | { error: unknown };
      try {
        outcome = {
          answer: await client.topHoldings(instrument.sourceSymbol),
        };
      } catch (error) {
        if (aborts(error)) throw error;
        outcome = none(error)
          ? {
              answer: {
                symbol: instrument.sourceSymbol,
                fund: null,
                fetchedAt: ctx.clock.now(),
              },
            }
          : { error };
      }
      return ctx.writer.write((db): TopHoldingsResult => {
        if (!live()) throw new DeadlinePassed();
        checkStored(db, instrument.id);
        const now = ctx.clock.now();
        const id = startRun(
          db,
          YAHOO,
          TOP_HOLDINGS_JOB,
          startedAt,
          instrument.id,
        );
        if ("error" in outcome) {
          failRun(db, id, now, outcome.error);
          return { status: "failed", error: outcome.error };
        }
        const rows = store(db, instrument.id, outcome.answer);
        endRun(db, id, now, rows);
        return { status: "ok", rows };
      });
    },
  );
}

export type TopHoldingsPass = {
  asked: string[];
  failed: { instrument: string; error: string }[];
};

// always on: Yahoo is the one source every install has
export function topHoldingsJobs(options: {
  ctx: YahooContext;
  log: Log;
  tracking?: Tracking;
}) {
  const { ctx, log } = options;
  const tracking = options.tracking ?? BY_USE;

  async function tick(): Promise<TopHoldingsPass> {
    const pass: TopHoldingsPass = { asked: [], failed: [] };
    const now = ctx.clock.now();
    const due = trackedInstruments(ctx.db, now, tracking).filter(
      (i) => asked(i) && topHoldingsDue(ctx.db, i.id, now),
    );
    for (const instrument of due) {
      try {
        const result = await refreshTopHoldings(ctx, instrument, {
          due: (db) => topHoldingsDue(db, instrument.id, ctx.clock.now()),
        });
        if (result === null) continue;
        pass.asked.push(instrument.id);
        if (result.status === "failed") {
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
      log.info("yahoo top holdings refreshed", {
        instruments: pass.asked.length,
        failed: pass.failed.length,
      });
    }
    for (const f of pass.failed) {
      log.warn("yahoo top holdings failed", {
        instrument: f.instrument,
        error: f.error,
      });
    }
    return pass;
  }

  return {
    tick,
    schedule(jobs: Scheduler) {
      jobs.every("yahoo-top-holdings", TOP_HOLDINGS_TICK_MS, async () => {
        await tick();
      });
    },
  };
}
