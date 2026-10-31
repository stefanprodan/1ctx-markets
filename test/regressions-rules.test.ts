// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "bun:test";
import { readBars } from "../src/market/bars.ts";
import { readSession } from "../src/market/calendars.ts";
import { readInstrument } from "../src/market/instruments.ts";
import { readQuote } from "../src/market/quotes.ts";
import { barsStale, JOBS, quoteStale, STALE } from "../src/market/stale.ts";
import { type Markets, markets } from "../src/operations/markets.ts";
import { readLatest } from "../src/operations/quote.ts";
import { parseScreen, screenAnswer } from "../src/operations/screen.ts";
import { readAlertsAfter, readRule } from "../src/rules/store.ts";
import { DAY_MS } from "../src/runtime/clock.ts";
import { silent } from "../src/runtime/log.ts";
import { readSignals } from "../src/signals/read.ts";
import { finalPending, liveTarget } from "../src/signals/store.ts";
import { yahoo } from "../src/sources/yahoo/client.ts";
import { yahooJobs } from "../src/sources/yahoo/jobs.ts";
import { open } from "../src/storage/db/index.ts";
import { lastRun } from "../src/storage/runs.ts";
import { writer } from "../src/storage/writer.ts";
import { fakeClock } from "./helpers/clock.ts";
import { EVERY_MS, rulesTest } from "./helpers/rules.ts";
import {
  added,
  chartSymbol,
  clone,
  fakeFetch,
  listed,
  recorded,
} from "./helpers/yahoo.ts";

test("a failed refetch keeps split-sensitive rules unknown after other instruments sync", async () => {
  const nvda = listed(await recorded("chart-nvda-5d-1d"));
  const hyg = listed(await recorded("chart-hyg-5d-1d"));
  const failure = await recorded("chart-unknown-symbol");
  const t = await rulesTest({ charts: { NVDA: nvda, HYG: hyg } });
  try {
    const other = await added(t.ctx, "HYG");
    const created = await t.rules({
      action: "create",
      symbol: "NVDA",
      condition: { left: "price", op: "<", right: 200 },
    });
    expect(created.error).toBe(false);
    const id = created.body.rule.id as number;
    const jobs = yahooJobs({ ctx: t.ctx, quoteEveryMs: EVERY_MS, log: silent });
    await t.quote("NVDA", { price: 210 });
    await jobs.barTick();
    expect(readRule(t.db, id)).toMatchObject({
      lastResult: "false",
      armed: true,
      paused: null,
    });
    expect(readAlertsAfter(t.db, 0, 10)).toEqual([]);

    await t.clock.advance(Date.parse("2026-10-26T13:35:00Z") - t.clock.now());
    await t.quote("NVDA", {
      price: 21,
      previousClose: 21,
      dayHigh: 21.2,
      dayLow: 20.9,
      sessionDays: 3,
      time: Date.parse("2026-10-26T13:31:00Z"),
    });
    const instrument = readInstrument(t.db, "US:NVDA")!;
    expect(barsStale(t.db, instrument, t.clock.now())).toContain(
      STALE.barsPending,
    );
    expect(readRule(t.db, id)).toMatchObject({
      lastResult: "unknown",
      armed: true,
    });
    expect(readAlertsAfter(t.db, 0, 10)).toEqual([]);

    // The failed window never reveals the split to the rule hooks.
    t.charts.set("NVDA", () => failure);
    const monday = clone(hyg);
    const period =
      monday.body.chart.result[0].meta.currentTradingPeriod.regular;
    period.start += (3 * DAY_MS) / 1000;
    period.end += (3 * DAY_MS) / 1000;
    t.charts.set("HYG", () => monday);
    const before = t.calls.length;
    expect(await jobs.barTick()).toMatchObject([{ market: "US", error: null }]);
    expect(t.calls.slice(before).map(chartSymbol).sort()).toEqual([
      "HYG",
      "NVDA",
    ]);
    expect(lastRun(t.db, "yahoo", JOBS.bars, "US")!.status).toBe("ok");
    expect(lastRun(t.db, "yahoo", JOBS.bars, instrument.id)).toMatchObject({
      status: "failed",
      error: "not found",
    });
    expect(barsStale(t.db, instrument, t.clock.now())).toEqual([
      STALE.barsFailed,
    ]);
    expect(barsStale(t.db, other.instrument, t.clock.now())).toEqual([]);
    expect(
      quoteStale(t.db, instrument, { now: t.clock.now(), everyMs: EVERY_MS }),
    ).toEqual([]);
    expect(readQuote(t.db, instrument.id)!.price).toBe(21);
    expect(readBars(t.db, instrument.id, "1d").at(-1)).toMatchObject({
      date: "2026-10-23",
      final: false,
      close: expect.closeTo(210.96, 2),
    });

    // Another listing's success cannot establish this listing's price scale.
    expect({
      result: readRule(t.db, id)!.lastResult,
      armed: readRule(t.db, id)!.armed,
      alerts: readAlertsAfter(t.db, 0, 10).length,
    }).toEqual({ result: "unknown", armed: true, alerts: 0 });
  } finally {
    await t.write.close();
    t.db.close();
  }
});

async function atCryptoRollover(
  check: (m: Markets, calls: URL[]) => Promise<void>,
) {
  const history = listed(await recorded("chart-sol-usd-1mo-1d"));
  const spark = await recorded("spark-v7-batch");
  const rollover = Date.parse("2026-10-26T00:00:00Z");
  const clock = fakeClock(Date.parse(history.recordedAt));
  const { db } = open(":memory:", clock);
  const write = writer(db);
  const f = fakeFetch((url) => {
    const days = clock.now() >= rollover ? 1 : 0;
    if (chartSymbol(url) === "SOL-USD") {
      const answer = clone(history);
      const meta = answer.body.chart.result[0].meta;
      meta.currentTradingPeriod.regular.start += (days * DAY_MS) / 1000;
      meta.currentTradingPeriod.regular.end += (days * DAY_MS) / 1000;
      return answer;
    }
    if (
      url.pathname === "/v7/finance/spark" &&
      url.searchParams.get("symbols") === "SOL-USD"
    ) {
      const answer = clone(spark);
      answer.body.spark.result = answer.body.spark.result.filter(
        (r: any) => r.symbol === "SOL-USD",
      );
      const meta = answer.body.spark.result[0].response[0].meta;
      meta.currentTradingPeriod.regular.start += (days * DAY_MS) / 1000;
      meta.currentTradingPeriod.regular.end += (days * DAY_MS) / 1000;
      meta.regularMarketTime =
        Date.parse(days ? "2026-10-25T23:59:00Z" : "2026-10-25T23:55:00Z") /
        1000;
      return answer;
    }
    return undefined;
  });
  const ctx = {
    db,
    clock,
    writer: write,
    yahoo: yahoo({ clock, fetch: f.fetch }),
  };
  const m = markets({
    ...ctx,
    fred: null,
    log: silent,
    quoteEveryMs: EVERY_MS,
  });
  try {
    const { instrument } = await added(ctx, "SOL-USD");
    const jobs = yahooJobs({ ctx, quoteEveryMs: EVERY_MS, log: silent });
    await clock.advance(Date.parse("2026-10-25T23:55:00Z") - clock.now());
    await jobs.quoteTick();
    await jobs.barTick();
    expect(
      readSignals(db, instrument.id, clock.now(), EVERY_MS)!.stale,
    ).toEqual({
      final: [],
      live: [],
    });

    await clock.advance(rollover - clock.now());
    await jobs.quoteTick();
    expect(readSession(db, "CRYPTO")!.start).toBe(rollover);
    expect(readQuote(db, instrument.id)).toMatchObject({
      time: Date.parse("2026-10-25T23:59:00Z"),
      fetchedAt: rollover,
    });
    expect(await jobs.barTick()).toMatchObject([
      { market: "CRYPTO", error: null },
    ]);
    expect(lastRun(db, "yahoo", JOBS.bars, "CRYPTO")!.status).toBe("ok");
    expect(barsStale(db, instrument, clock.now())).toEqual([]);
    expect(
      quoteStale(db, instrument, { now: clock.now(), everyMs: EVERY_MS }),
    ).toEqual([]);
    expect(readBars(db, instrument.id, "1d").at(-1)).toMatchObject({
      date: "2026-10-25",
      final: true,
    });
    expect(readBars(db, instrument.id, "1wk").at(-1)).toMatchObject({
      date: "2026-10-19",
      final: true,
    });
    expect(finalPending(db, instrument.id)).toBe(false);
    // a trade before the stored period's start dates no live row
    expect(liveTarget(db, instrument)).toBeNull();
    const s = readSignals(db, instrument.id, clock.now(), EVERY_MS)!;
    expect(s.daily.final!.date).toBe("2026-10-25");
    expect(s.daily.final!.rsi14).not.toBeNull();
    expect(s.weekly.final!.date).toBe("2026-10-19");
    expect(s.daily.live).toBeNull();
    expect(s.weekly.live).toBeNull();
    expect(s.stale.final).toEqual([]);
    await check(m, f.urls);
  } finally {
    await write.close();
    db.close();
  }
}

test("final signals stay current when the latest crypto trade is already finalized", async () => {
  await atCryptoRollover(async (m) => {
    const instrument = readInstrument(m.db, "CRYPTO:SOL-USD")!;
    const latest = readLatest(m.db, instrument, m.clock.now(), m.quoteEveryMs);
    expect(latest.daily).toMatchObject({
      kind: "final",
      row: { date: "2026-10-25" },
    });
    expect(latest.weekly).toMatchObject({
      kind: "final",
      row: { date: "2026-10-19" },
    });
    expect(latest.stale).toEqual([]);
  });
});

test("screen accepts final signals when the latest crypto trade is already finalized", async () => {
  await atCryptoRollover(async (m, calls) => {
    const before = calls.length;
    const result = await screenAnswer(
      m,
      parseScreen({ symbols: ["CRYPTO:SOL-USD"], sort: "rsi14" }),
    );
    expect(result.isError).not.toBe(true);
    expect(calls).toHaveLength(before);
    const body = JSON.parse(result.content[0]!.text);
    expect(body.items[0]).toMatchObject({
      id: "CRYPTO:SOL-USD",
      status: "matched",
      fields: { rsi14: { kind: "final", date: "2026-10-25" } },
    });
    expect(body.counts).toEqual({
      matched: 1,
      not_matched: 0,
      unavailable: 0,
      errors: 0,
    });
  });
});
