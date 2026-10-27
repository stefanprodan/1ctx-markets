// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { recordSession } from "../src/calendars.ts";
import { upsertInstrument } from "../src/instruments.ts";
import { DAY_MS, MINUTE_MS } from "../src/runtime/clock.ts";
import { SourceError } from "../src/source.ts";
import { barsStale, JOBS, quoteStale } from "../src/stale.ts";
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
  const run = (job: string, scope: string | null, error?: unknown) => {
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
    // without the period, as the jobs read it, and for a market with no
    // session, never
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

  test("is per job and scope: a successful search never clears a failed quote pass", () => {
    const { db, us, other, run, now } = setup();
    run(JOBS.quotes, "US");
    expect(quoteStale(db, us)).toEqual([]);
    run(JOBS.quotes, "US", new SourceError("rate limited"));
    run("search", null);
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
