// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { recordSession } from "../src/calendars.ts";
import { MINUTE_MS } from "../src/clock.ts";
import { open } from "../src/db/index.ts";
import { upsertInstrument } from "../src/instruments.ts";
import { endRun, failRun, startRun } from "../src/runs.ts";
import { SourceError } from "../src/source.ts";
import { barsStale, JOBS, quoteStale } from "../src/stale.ts";
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
    // added after the pass, so not asked in it
    const later = upsertInstrument(db, instrument("US", "AMD"), now() + 1);
    expect(quoteStale(db, later)).toEqual([]);
    run(JOBS.quotes, "US");
    db.query("update quotes set fetched_at = ? where instrument = ?").run(
      now() - 1,
      later.id,
    );
    expect(quoteStale(db, later)).toEqual(["no quote in the last pass"]);
    expect(quoteStale(db, us)).toEqual([]);
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
