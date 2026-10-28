// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { dailyRange } from "../../market/bars.ts";
import { weekOf } from "../../market/calendars.ts";
import {
  checkSource,
  type Instrument,
  readInstruments,
  upsertInstrument,
} from "../../market/instruments.ts";
import { SWITCH } from "../../market/stale.ts";
import { startOfDate } from "../../market/zone.ts";
import { MINUTE_MS } from "../../runtime/clock.ts";
import { exclusive } from "../../runtime/lock.ts";
import { errorFields, type Log } from "../../runtime/log.ts";
import type { Scheduler } from "../../runtime/scheduler.ts";
import type { Db } from "../../storage/db/index.ts";
import { endRun, failRun, lastStarted, startRun } from "../../storage/runs.ts";
import { backfillStart, RETRY_MS } from "../history.ts";
import { YAHOO } from "../ids.ts";
import { phraseOf, Refused, SourceError } from "../source.ts";
import { dailyBars } from "../yahoo/history.ts";
import { keyOf as yahooKey } from "../yahoo/resolve.ts";
import {
  requireQuote,
  storeSwitched,
  type YahooContext,
} from "../yahoo/sync.ts";
import { MARKET, SOURCE } from "./client.ts";
import { barsAnswered, CutShort, checkCovers, storeWhole } from "./history.ts";
import { storeBvbQuotes } from "./quotes.ts";
import {
  type BvbContext,
  checkListed,
  draft,
  fieldsOf,
  quoteNow,
  wholeHistory,
} from "./sync.ts";

const TICK_MS = MINUTE_MS;

export const priceSources = (feed: boolean): string[] =>
  feed ? [SOURCE, YAHOO] : [YAHOO];

// before this table existed, Yahoo was the only price source
export function readSources(db: Db): string[] {
  const names = db
    .query<{ name: string }, []>("select name from sources order by name")
    .all()
    .map((r) => r.name);
  return names.length > 0 ? names : [YAHOO];
}

export function writeSources(db: Db, names: readonly string[], now: number) {
  const keep = JSON.stringify(names);
  db.query(
    "delete from sources where name not in (select value from json_each(?))",
  ).run(keep);
  const add = db.query(
    "insert into sources (name, since) values (?, ?) on conflict (name) do nothing",
  );
  for (const name of names) add.run(name, now);
}

// its prices and bars came from the other source; the identity stays
function clear(db: Db, id: string, splits: boolean): void {
  for (const table of ["bars", "signals", "quotes", "intraday"]) {
    db.query(`delete from ${table} where instrument = ?`).run(id);
  }
  if (splits) db.query("delete from splits where instrument = ?").run(id);
}

export type SourceSwitch = {
  needed(): boolean;
  run(): Promise<void>;
  // the run still going, for shutdown to wait on
  settled(): Promise<void>;
  schedule(jobs: Scheduler): void;
};

export function sourceSwitch(options: {
  yahoo: YahooContext;
  bvb: BvbContext | null;
  log: Log;
}): SourceSwitch {
  const { yahoo, bvb, log } = options;
  const { db, clock, writer } = yahoo;
  const wanted = priceSources(bvb !== null);
  const target = bvb === null ? YAHOO : SOURCE;
  let inflight: Promise<void> | null = null;

  const needed = () => {
    const last = lastStarted(db, SWITCH.source, SWITCH.job, MARKET);
    return (
      readSources(db).join() !== [...wanted].sort().join() ||
      (last !== null && last.status !== "ok")
    );
  };

  // Yahoo's listing for the key, by its search, never a guessed suffix
  async function toYahoo(i: Instrument): Promise<void> {
    const listings = await yahoo.yahoo.search(i.symbol);
    const found = listings.filter(
      (l) => yahooKey(l.exchange, l.sourceSymbol) === i.id,
    );
    if (found.length !== 1) throw new SourceError("not found");
    const symbol = found[0]!.sourceSymbol;
    let { monday, from } = backfillStart(clock.now());
    const range = dailyRange(db, i.id);
    if (range !== null && range.first < monday) {
      monday = weekOf(range.first);
      from = startOfDate(i.zone, monday);
    }
    const answer = await yahoo.yahoo.chart(symbol, from, clock.now());
    if (yahooKey(answer.exchange, answer.symbol) !== i.id) {
      throw new SourceError("malformed answer", `${i.id} answered otherwise`);
    }
    const quote = await yahoo.yahoo.spark([answer.symbol]);
    // the old source's quote is cleared with its bars
    requireQuote(quote, answer.symbol, i.id);
    const dates = dailyBars(answer, null)
      .map((b) => b.date)
      .filter((d) => d >= monday);
    await writer.write((db) => {
      checkSource(db, i);
      // checked against the old source's days before any is cleared
      checkCovers(db, i.id, dates, monday, false);
      clear(db, i.id, true);
      storeSwitched(db, clock.now(), answer, quote, monday, yahoo.rules);
    });
  }

  // Yahoo's splits stay: they date the corporate actions the feed's raw
  // volumes change scale on
  async function toBvb(ctx: BvbContext, i: Instrument): Promise<void> {
    const meta = await ctx.bvb.meta(i.symbol);
    if (meta.expired) throw new SourceError("not found");
    const planned = draft(meta, clock.now());
    if (planned.id !== i.id) {
      throw new SourceError("malformed answer", `${i.id} answered otherwise`);
    }
    // an AeRO share stays on Yahoo
    await checkListed(ctx, meta);
    const { history, since } = await wholeHistory(ctx, {
      ...planned,
      id: i.id,
    });
    const quote = await quoteNow(ctx, planned);
    const dates = history.bars.map((b) => b.date).filter((d) => d >= since);
    await writer.write((db) => {
      checkSource(db, i);
      // checked against the old source's days before any is cleared
      checkCovers(db, i.id, dates, since, false);
      clear(db, i.id, false);
      const now = clock.now();
      const instrument = upsertInstrument(db, fieldsOf(meta), now);
      barsAnswered(
        db,
        instrument,
        storeWhole(db, now, instrument, history, since, ctx.rules),
        now,
      );
      storeBvbQuotes(db, [quote], ctx.rules, now);
    });
  }

  async function switchAll(): Promise<void> {
    const id = await writer.write((db) =>
      startRun(db, SWITCH.source, SWITCH.job, clock.now(), MARKET),
    );
    let failed: unknown;
    let moved = 0;
    const from = target === SOURCE ? YAHOO : SOURCE;
    const movers = readInstruments(db).filter(
      (i) => i.market === MARKET && i.source === from,
    );
    for (const i of movers) {
      try {
        await exclusive(db, i.id, () => {
          checkSource(db, i);
          return bvb === null ? toYahoo(i) : toBvb(bvb, i);
        });
        moved++;
      } catch (error) {
        // a listing the other source lacks, or holds only in part, stays
        // where it is, so one short history never holds the market back
        if (
          error instanceof Refused ||
          error instanceof CutShort ||
          (error instanceof SourceError && error.phrase === "not found")
        ) {
          log.info("source switch kept", {
            instrument: i.id,
            source: from,
            error: phraseOf(error),
          });
          continue;
        }
        failed ??= error;
        log.warn("source switch failed", {
          instrument: i.id,
          error: phraseOf(error),
        });
      }
    }
    await writer.write((db) => {
      const now = clock.now();
      if (failed !== undefined) {
        failRun(db, id, now, failed, moved);
        return;
      }
      endRun(db, id, now, moved);
      writeSources(db, wanted, now);
      // a listing kept on a source now off reads its source off
      yahoo.rules?.evaluate(
        db,
        readInstruments(db)
          .filter((i) => i.market === MARKET)
          .map((i) => i.id),
        now,
      );
    });
    log.info("source switch", {
      market: MARKET,
      to: target,
      moved,
      error: failed === undefined ? undefined : phraseOf(failed),
    });
  }

  const run = (): Promise<void> => {
    inflight ??= switchAll()
      .catch((error: unknown) => {
        log.error("source switch failed", errorFields(error));
      })
      .finally(() => {
        inflight = null;
      });
    return inflight;
  };

  return {
    needed,
    run,
    settled: () => inflight ?? Promise.resolve(),
    schedule(jobs) {
      jobs.every("sources", TICK_MS, async () => {
        if (inflight !== null || !needed()) return;
        const last = lastStarted(db, SWITCH.source, SWITCH.job, MARKET);
        if (
          last?.status === "failed" &&
          clock.now() - last.startedAt < RETRY_MS
        ) {
          return;
        }
        await run();
      });
    },
  };
}
