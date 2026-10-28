// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { DAY_MS } from "../src/runtime/clock.ts";
import { QueueClosed, SourceError } from "../src/sources/source.ts";
import { open } from "../src/storage/db/index.ts";
import {
  INTERRUPTED,
  isStale,
  lastRun,
  pruneRuns,
  runJob,
  staleJobs,
  startRun,
} from "../src/storage/runs.ts";
import { writer } from "../src/storage/writer.ts";
import { fakeClock } from "./helpers/clock.ts";

describe("sync runs", () => {
  test("record each run's status, rows and only a fixed phrase", async () => {
    const clock = fakeClock();
    const { db } = open(":memory:", clock);
    expect(
      await runJob(writer(db), clock, "yahoo", "quotes", async () => 7, "US"),
    ).toBe(7);
    expect(lastRun(db, "yahoo", "quotes")).toMatchObject({
      status: "ok",
      rows: 7,
      error: null,
      startedAt: clock.now(),
      endedAt: clock.now(),
    });
    await expect(
      runJob(
        writer(db),
        clock,
        "yahoo",
        "bars",
        async () => {
          throw new Error("https://example.test/secret detail");
        },
        "US",
      ),
    ).rejects.toThrow();
    expect(lastRun(db, "yahoo", "bars")).toMatchObject({
      status: "failed",
      error: "failed",
    });
    await expect(
      runJob(
        writer(db),
        clock,
        "yahoo",
        "bars",
        async () => {
          throw new SourceError("timed out", "NVDA");
        },
        "US",
      ),
    ).rejects.toThrow();
    expect(lastRun(db, "yahoo", "bars")!.error).toBe("timed out");
    // shutdown closes the queue under a run: interrupted, not a source failure
    await expect(
      runJob(
        writer(db),
        clock,
        "yahoo",
        "quotes",
        async () => {
          throw new QueueClosed();
        },
        "US",
      ),
    ).rejects.toThrow();
    expect(lastRun(db, "yahoo", "quotes")!.error).toBe(INTERRUPTED);
  });

  test("a job whose last run failed is stale, per source and per job", async () => {
    const clock = fakeClock();
    const { db } = open(":memory:", clock);
    const fail = async () => {
      throw new SourceError("rate limited");
    };
    await runJob(writer(db), clock, "yahoo", "quotes", async () => 1, "US");
    await expect(
      runJob(writer(db), clock, "yahoo", "bars", fail, "US"),
    ).rejects.toThrow();
    await runJob(writer(db), clock, "finnhub", "research", async () => 1, "US");
    expect(staleJobs(db, "yahoo")).toEqual(["bars"]);
    expect(isStale(db, "yahoo")).toBe(true);
    expect(isStale(db, "yahoo", "quotes")).toBe(false);
    expect(isStale(db, "yahoo", "bars")).toBe(true);
    expect(isStale(db, "finnhub")).toBe(false);

    // a run still going does not hide the failure before it
    await clock.advance(1);
    startRun(db, "yahoo", "bars", clock.now(), "US");
    expect(isStale(db, "yahoo", "bars")).toBe(true);
    await clock.advance(1);
    await runJob(writer(db), clock, "yahoo", "bars", async () => 2, "US");
    expect(staleJobs(db, "yahoo")).toEqual([]);
  });

  test("are kept 30 days", async () => {
    const clock = fakeClock();
    const { db } = open(":memory:", clock);
    await runJob(writer(db), clock, "yahoo", "quotes", async () => 1, "US");
    await clock.advance(30 * DAY_MS);
    expect(pruneRuns(db, clock.now())).toBe(0);
    await clock.advance(1);
    expect(pruneRuns(db, clock.now())).toBe(1);
  });
});
