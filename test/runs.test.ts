// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { DAY_MS } from "../src/clock.ts";
import { open } from "../src/db/index.ts";
import {
  isStale,
  lastRun,
  pruneRuns,
  runJob,
  staleJobs,
  startRun,
} from "../src/runs.ts";
import { SourceError } from "../src/source.ts";
import { fakeClock } from "./helpers/clock.ts";

describe("sync runs", () => {
  test("record each run's status, rows and only a fixed phrase", async () => {
    const clock = fakeClock();
    const { db } = open(":memory:", clock);
    expect(await runJob(db, clock, "yahoo", "quotes", async () => 7)).toBe(7);
    expect(lastRun(db, "yahoo", "quotes")).toMatchObject({
      status: "ok",
      rows: 7,
      error: null,
      startedAt: clock.now(),
      endedAt: clock.now(),
    });
    await expect(
      runJob(db, clock, "yahoo", "bars", async () => {
        throw new Error("https://example.test/secret detail");
      }),
    ).rejects.toThrow();
    expect(lastRun(db, "yahoo", "bars")).toMatchObject({
      status: "failed",
      error: "failed",
    });
    await expect(
      runJob(db, clock, "yahoo", "bars", async () => {
        throw new SourceError("timed out", "NVDA");
      }),
    ).rejects.toThrow();
    expect(lastRun(db, "yahoo", "bars")!.error).toBe("timed out");
  });

  test("a job whose last run failed is stale, per source and per job", async () => {
    const clock = fakeClock();
    const { db } = open(":memory:", clock);
    const fail = async () => {
      throw new SourceError("rate limited");
    };
    await runJob(db, clock, "yahoo", "quotes", async () => 1);
    await expect(runJob(db, clock, "yahoo", "bars", fail)).rejects.toThrow();
    await runJob(db, clock, "finnhub", "research", async () => 1);
    expect(staleJobs(db, "yahoo")).toEqual(["bars"]);
    expect(isStale(db, "yahoo")).toBe(true);
    expect(isStale(db, "yahoo", "quotes")).toBe(false);
    expect(isStale(db, "yahoo", "bars")).toBe(true);
    expect(isStale(db, "finnhub")).toBe(false);

    // a run still going does not hide the failure before it
    await clock.advance(1);
    startRun(db, "yahoo", "bars", clock.now());
    expect(isStale(db, "yahoo", "bars")).toBe(true);
    await clock.advance(1);
    await runJob(db, clock, "yahoo", "bars", async () => 2);
    expect(staleJobs(db, "yahoo")).toEqual([]);
  });

  test("are kept 30 days", async () => {
    const clock = fakeClock();
    const { db } = open(":memory:", clock);
    await runJob(db, clock, "yahoo", "quotes", async () => 1);
    await clock.advance(30 * DAY_MS);
    expect(pruneRuns(db, clock.now())).toBe(0);
    await clock.advance(1);
    expect(pruneRuns(db, clock.now())).toBe(1);
  });
});
