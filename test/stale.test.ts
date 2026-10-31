// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { recordSession } from "../src/market/calendars.ts";
import { upsertInstrument } from "../src/market/instruments.ts";
import { barsStale, JOBS, quoteStale, STALE } from "../src/market/stale.ts";
import { DAY_MS, MINUTE_MS } from "../src/runtime/clock.ts";
import { STALE_RESEARCH, sectionState } from "../src/sources/finnhub/read.ts";
import { newsState, STALE_NEWS } from "../src/sources/massive/store.ts";
import { QueueClosed, SourceError } from "../src/sources/source.ts";
import { open } from "../src/storage/db/index.ts";
import { endRun, failRun, startRun } from "../src/storage/runs.ts";
import { fakeClock } from "./helpers/clock.ts";

const instrument = (market: string, symbol: string) => ({
  market,
  symbol,
  source: "yahoo",
  sourceSymbol: symbol,
  exchange: market,
  name: null,
  type: "EQUITY",
  currency: "USD",
  unit: "per_share" as const,
  zone: "America/New_York",
});

function setup() {
  const clock = fakeClock();
  const { db } = open(":memory:", clock);
  const us = upsertInstrument(db, instrument("US", "NVDA"), clock.now());
  const other = upsertInstrument(db, instrument("OTHER", "X"), clock.now());
  // runs a job to its end, a step after the last; a quote pass that
  // ends well answers every instrument of its market
  let at = clock.now();
  const run = (job: string, scope: string, error?: unknown) => {
    at += MINUTE_MS;
    const id = startRun(db, "yahoo", job, at, scope);
    if (error === undefined) {
      if (job === JOBS.quotes) quote(scope!, at);
      endRun(db, id, at, 1);
    } else failRun(db, id, at, error);
  };
  const quote = (market: string, fetchedAt: number) =>
    db
      .query(
        `insert into quotes (instrument, price, time, source, fetched_at)
         select id, 1, ?1, 'yahoo', ?1 from instruments where market = ?2
         on conflict (instrument) do update set fetched_at = ?1`,
      )
      .run(fetchedAt, market);
  return { clock, db, us, other, run, now: () => at };
}

describe("staleness", () => {
  test("a quote no pass refreshed in a trading session is overdue", () => {
    const { db, us, other, run, now } = setup();
    const every = 5 * MINUTE_MS;
    run(JOBS.quotes, "US");
    run(JOBS.quotes, "OTHER");
    const fetched = now();
    const due = (at: number) => ({ now: at, everyMs: every });
    const start = fetched + 60 * MINUTE_MS;
    recordSession(
      db,
      "US",
      { zone: "America/New_York", start, end: start + 390 * MINUTE_MS },
      fetched,
    );
    // closed: the last quote stands for the close
    expect(quoteStale(db, us, due(start - 1))).toEqual([]);
    // in session, within two periods of the pass, then past them
    expect(quoteStale(db, us, due(start + 1))).toEqual(["quote overdue"]);
    db.query("update quotes set fetched_at = ? where instrument = ?").run(
      start,
      us.id,
    );
    expect(quoteStale(db, us, due(start + 2 * every))).toEqual([]);
    expect(quoteStale(db, us, due(start + 2 * every + 1))).toEqual([
      "quote overdue",
    ]);
    // without the period, as the jobs read it, and with no session, never
    expect(quoteStale(db, us)).toEqual([]);
    expect(quoteStale(db, other, due(start + DAY_MS))).toEqual([]);
    // a quote that missed the close stays overdue after it, until the
    // post-close quote lands
    const end = start + 390 * MINUTE_MS;
    db.query("update quotes set fetched_at = ? where instrument = ?").run(
      end - 60 * MINUTE_MS,
      us.id,
    );
    expect(quoteStale(db, us, due(end + MINUTE_MS))).toEqual(["quote overdue"]);
    expect(quoteStale(db, us, due(end + DAY_MS))).toEqual(["quote overdue"]);
    db.query("update quotes set fetched_at = ? where instrument = ?").run(
      end + 15 * MINUTE_MS,
      us.id,
    );
    expect(quoteStale(db, us, due(end + DAY_MS))).toEqual([]);
  });

  test("a quote is due by the session's end until the closing pass is late", () => {
    const { db, us, run, now } = setup();
    const every = 5 * MINUTE_MS;
    run(JOBS.quotes, "US");
    const start = now() + 60 * MINUTE_MS;
    const end = start + 390 * MINUTE_MS;
    const close = end + 15 * MINUTE_MS;
    recordSession(db, "US", { zone: "America/New_York", start, end }, now());
    const due = (at: number) => ({ now: at, everyMs: every });
    const fetched = (at: number) =>
      db
        .query("update quotes set fetched_at = ? where instrument = ?")
        .run(at, us.id);
    // the last pass in session, read before the closing pass runs
    fetched(end - 4 * MINUTE_MS);
    expect(quoteStale(db, us, due(end + 10 * MINUTE_MS))).toEqual([]);
    expect(quoteStale(db, us, due(close + 2 * every - 1))).toEqual([]);
    // the closing pass missed
    expect(quoteStale(db, us, due(close + 2 * every + 1))).toEqual([
      "quote overdue",
    ]);
    expect(quoteStale(db, us, due(end + DAY_MS))).toEqual(["quote overdue"]);
    // the closing pass ran
    fetched(close + 17_000);
    expect(quoteStale(db, us, due(close + 20 * MINUTE_MS))).toEqual([]);
    expect(quoteStale(db, us, due(end + DAY_MS))).toEqual([]);
    // passes stopped mid-session
    fetched(start + 60 * MINUTE_MS);
    expect(quoteStale(db, us, due(start + 120 * MINUTE_MS))).toEqual([
      "quote overdue",
    ]);
    expect(quoteStale(db, us, due(end + 10 * MINUTE_MS))).toEqual([
      "quote overdue",
    ]);
  });

  test("is per job and scope: a successful search never clears a failed quote pass", () => {
    const { db, us, other, run, now } = setup();
    run(JOBS.quotes, "US");
    expect(quoteStale(db, us)).toEqual([]);
    run(JOBS.quotes, "US", new SourceError("rate limited"));
    run("search", "US");
    run(JOBS.quotes, "OTHER");
    expect(quoteStale(db, us)).toEqual(["quote sync failed"]);
    expect(quoteStale(db, other)).toEqual([]);
    // a run still going hides nothing
    startRun(db, "yahoo", JOBS.quotes, now() + 1, "US");
    expect(quoteStale(db, us)).toEqual(["quote sync failed"]);
    run(JOBS.quotes, "US");
    expect(quoteStale(db, us)).toEqual([]);
    run(JOBS.check, "US", new SourceError("timed out"));
    expect(quoteStale(db, us)).toEqual(["session check failed"]);
  });

  test("a failed quote pass marks only the quotes it did not store", () => {
    const { db, us, run, now } = setup();
    run(JOBS.quotes, "US");
    const amd = upsertInstrument(db, instrument("US", "AMD"), now());
    db.query(
      `insert into quotes (instrument, price, time, source, fetched_at)
       values (?, 1, ?2, 'yahoo', ?2)`,
    ).run(amd.id, now());
    run(JOBS.quotes, "US", new SourceError("source error"));
    // the failed pass stored NVDA's quote, never AMD's
    db.query("update quotes set fetched_at = ? where instrument = ?").run(
      now(),
      us.id,
    );
    expect(quoteStale(db, us)).toEqual([]);
    expect(quoteStale(db, amd)).toEqual([STALE.quotesFailed]);
  });

  test("a quote pass that answered marks only the instrument left out", () => {
    const { db, us, run, now } = setup();
    run(JOBS.quotes, "US");
    // added after the pass, so not asked in it, and with no quote
    const later = upsertInstrument(db, instrument("US", "AMD"), now() + 1);
    expect(quoteStale(db, later)).toEqual(["no quote yet"]);
    run(JOBS.quotes, "US");
    expect(quoteStale(db, later)).toEqual([]);
    db.query("update quotes set fetched_at = ? where instrument = ?").run(
      now() - 1,
      later.id,
    );
    expect(quoteStale(db, later)).toEqual(["no quote in the last pass"]);
    expect(quoteStale(db, us)).toEqual([]);
  });

  test("an instrument with no quote is stale, whatever the passes", () => {
    const { db, us, run } = setup();
    expect(quoteStale(db, us)).toEqual(["no quote yet"]);
    run(JOBS.quotes, "US");
    // added before the pass ended, though not asked in it
    db.query("delete from quotes where instrument = ?").run(us.id);
    expect(quoteStale(db, us)).toEqual(["no quote yet"]);
    run(JOBS.quotes, "US", new SourceError("rate limited"));
    db.query("delete from quotes where instrument = ?").run(us.id);
    expect(quoteStale(db, us)).toEqual(["quote sync failed", "no quote yet"]);
  });

  test("bars: none stored, a failed pass, and a session newer than the last good pass", () => {
    const { db, us, run, now } = setup();
    expect(barsStale(db, us, now())).toEqual(["no history"]);
    db.query(
      `insert into bars (instrument, interval, date, close, final, fetched_at)
       values ('US:NVDA', '1d', '2026-10-23', 1, 0, 0)`,
    ).run();
    expect(barsStale(db, us, now())).toEqual([]);
    const start = now() + MINUTE_MS;
    recordSession(
      db,
      "US",
      { zone: "America/New_York", start, end: start + 390 * MINUTE_MS },
      start,
    );
    // a session not begun yet asks for nothing
    expect(barsStale(db, us, start - 1)).toEqual([]);
    expect(barsStale(db, us, start)).toEqual(["bar sync pending"]);
    run(JOBS.bars, "US", new SourceError("network error"));
    expect(barsStale(db, us, now())).toEqual([
      "bar sync failed",
      "bar sync pending",
    ]);
    run(JOBS.bars, "OTHER");
    run(JOBS.bars, "US");
    expect(barsStale(db, us, now())).toEqual([]);
  });
});

describe("a run cut by shutdown", () => {
  test("is no failure for bars, research or news; one the source failed is", () => {
    const { db, us, run, now } = setup();
    db.query(
      `insert into bars (instrument, interval, date, open, high, low, close, volume, final, fetched_at)
       values (?, '1d', '2026-10-23', 1, 1, 1, 1, 1, 1, ?)`,
    ).run(us.id, now());
    run(JOBS.bars, us.id, new QueueClosed());
    expect(barsStale(db, us, now())).not.toContain(STALE.barsFailed);
    run(JOBS.bars, us.id, new SourceError("timed out"));
    expect(barsStale(db, us, now())).toContain(STALE.barsFailed);

    const cut = (source: string, job: string, error: unknown) => {
      const at = now() + MINUTE_MS;
      failRun(db, startRun(db, source, job, at, us.id), at, error);
    };
    cut("massive", "news", new QueueClosed());
    expect(newsState(db, us.id, now()).stale).not.toContain(STALE_NEWS.failed);
    cut("massive", "news", new SourceError("timed out"));
    expect(newsState(db, us.id, now()).stale).toContain(STALE_NEWS.failed);
    cut("finnhub", "metric", new QueueClosed());
    expect(sectionState(db, us.id, "metric", now()).stale).not.toContain(
      STALE_RESEARCH.failed,
    );
    cut("finnhub", "metric", new SourceError("timed out"));
    expect(sectionState(db, us.id, "metric", now()).stale).toContain(
      STALE_RESEARCH.failed,
    );
  });
});
