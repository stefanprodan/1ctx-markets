// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { MINUTE_MS } from "../src/clock.ts";
import { type Log, silent } from "../src/log.ts";
import { scheduler } from "../src/scheduler.ts";
import { fakeClock, START } from "./helpers/clock.ts";

const EVERY = 5 * MINUTE_MS;

function captured(): { log: Log; lines: string[] } {
  const lines: string[] = [];
  const at = (level: string) => (msg: string) => lines.push(`${level} ${msg}`);
  return {
    log: { info: at("info"), warn: at("warn"), error: at("error") },
    lines,
  };
}

describe("scheduler", () => {
  test("runs a job at each step of its period and not between", async () => {
    const clock = fakeClock();
    const jobs = scheduler(clock, silent);
    const runs: number[] = [];
    jobs.every("quotes", EVERY, (due) => {
      runs.push(due);
    });

    await clock.advance(EVERY - 1);
    expect(runs).toEqual([]);
    await clock.advance(1);
    expect(runs).toEqual([START + EVERY]);
    await clock.advance(EVERY - 1);
    expect(runs).toHaveLength(1);
    await clock.advance(1);
    expect(runs).toEqual([START + EVERY, START + 2 * EVERY]);

    await clock.advance(3 * EVERY);
    expect(runs).toEqual([1, 2, 3, 4, 5].map((n) => START + n * EVERY));
    await jobs.stop();
  });

  test("a run still going takes the next turn", async () => {
    const clock = fakeClock();
    const { log, lines } = captured();
    const jobs = scheduler(clock, log);
    let release = () => {};
    let runs = 0;
    jobs.every("slow", EVERY, () => {
      runs++;
      return new Promise<void>((resolve) => {
        release = resolve;
      });
    });

    await clock.advance(EVERY);
    await clock.advance(EVERY);
    expect(runs).toBe(1);
    expect(lines).toEqual(["warn job skipped"]);
    release();
    await clock.advance(EVERY);
    expect(runs).toBe(2);
    release();
    await jobs.stop();
  });

  test("a failing run is logged and the next one still comes", async () => {
    const clock = fakeClock();
    const { log, lines } = captured();
    const jobs = scheduler(clock, log);
    let runs = 0;
    jobs.every("flaky", EVERY, () => {
      runs++;
      throw new Error("source down");
    });

    await clock.advance(2 * EVERY);
    expect(runs).toBe(2);
    expect(lines).toEqual(["error job failed", "error job failed"]);
    await jobs.stop();
  });

  test("a late run keeps to the period and runs once for the turns missed", () => {
    let now = START;
    const timers: number[] = [];
    let fire = () => {};
    const clock = {
      now: () => now,
      at(at: number, run: () => void) {
        timers.push(at);
        fire = run;
        return () => {};
      },
    };
    const jobs = scheduler(clock, silent);
    const runs: number[] = [];
    jobs.every("quotes", EVERY, (due) => {
      runs.push(due);
    });
    // the host slept through three turns
    now = START + 3 * EVERY + 1;
    fire();
    expect(runs).toEqual([START + EVERY]);
    expect(timers).toEqual([START + EVERY, START + 4 * EVERY]);
  });

  test("stop resolves once a run still going has finished", async () => {
    const clock = fakeClock();
    const jobs = scheduler(clock, silent);
    let release = () => {};
    let finished = false;
    jobs.every("slow", EVERY, async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      finished = true;
    });
    await clock.advance(EVERY);
    let stopped = false;
    const stopping = jobs.stop().then(() => {
      stopped = true;
    });
    await clock.advance(EVERY);
    expect(stopped).toBe(false);
    release();
    await stopping;
    expect(finished).toBe(true);
  });

  test("stop cancels every job", async () => {
    const clock = fakeClock();
    const jobs = scheduler(clock, silent);
    let runs = 0;
    jobs.every("quotes", EVERY, () => {
      runs++;
    });
    await jobs.stop();
    await clock.advance(3 * EVERY);
    expect(runs).toBe(0);
  });
});
