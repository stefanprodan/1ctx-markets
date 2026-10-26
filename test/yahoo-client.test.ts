// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { open } from "../src/db/index.ts";
import { isStale, lastRun, runJob } from "../src/runs.ts";
import {
  FAILURE_BACKOFF_MS,
  queue,
  RATE_LIMIT_BACKOFF_MS,
  SourceError,
} from "../src/source.ts";
import { writer } from "../src/writer.ts";
import {
  parseChart,
  parseSpark,
  SPARK_MAX,
  yahoo,
} from "../src/yahoo/client.ts";
import { fakeClock } from "./helpers/clock.ts";
import {
  chartSymbol,
  clone,
  fakeFetch,
  type Recorded,
  recorded,
} from "./helpers/yahoo.ts";

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

async function phrase(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (error) {
    if (error instanceof SourceError) return error.phrase;
    throw error;
  }
  throw new Error("did not fail");
}

describe("chart", () => {
  test("asks for daily bars with splits as Mozilla/5.0 and reads the answer", async () => {
    const fx = await recorded("chart-nvda-5d-1d");
    const clock = fakeClock(Date.parse(fx.recordedAt));
    const f = fakeFetch(() => fx);
    const answer = await yahoo({ clock, fetch: f.fetch }).chart(
      "NVDA",
      Date.UTC(2026, 9, 19),
      clock.now(),
    );
    expect(f.urls).toHaveLength(1);
    const url = f.urls[0]!;
    expect(url.origin).toBe("https://query1.finance.yahoo.com");
    expect(chartSymbol(url)).toBe("NVDA");
    expect(url.searchParams.get("interval")).toBe("1d");
    expect(url.searchParams.get("events")).toBe("div,split");
    expect(url.searchParams.get("period1")).toBe(
      String(Date.UTC(2026, 9, 19) / 1000),
    );
    expect(f.headers[0]!.get("user-agent")).toBe("Mozilla/5.0");
    expect(answer).toMatchObject({
      symbol: "NVDA",
      exchange: "NMS",
      type: "EQUITY",
      currency: "USD",
      name: "NVIDIA Corporation",
      price: 210.96,
      time: 1792785600_000,
      session: {
        zone: "America/New_York",
        start: Date.parse("2026-10-23T13:30:00Z"),
        end: Date.parse("2026-10-23T20:00:00Z"),
      },
      fetchedAt: clock.now(),
    });
    expect(answer.rows).toHaveLength(5);
    expect(answer.rows[4]).toEqual({
      at: Date.parse("2026-10-23T13:30:00Z"),
      open: expect.any(Number),
      high: expect.any(Number),
      low: expect.any(Number),
      close: 210.9600067138672,
      volume: expect.any(Number),
    });
  });

  test("encodes index, futures and FX symbols in the path", async () => {
    const fx = await recorded("chart-vix-5d-1d");
    const clock = fakeClock(Date.parse(fx.recordedAt));
    const f = fakeFetch(() => fx);
    await yahoo({ clock, fetch: f.fetch }).chart("^VIX", 0, clock.now());
    expect(f.urls[0]!.pathname).toBe("/v8/finance/chart/%5EVIX");
  });

  test("reads split events, a bonus issue included", async () => {
    const nvda = parseChart((await recorded("chart-nvda-split-2024")).body, 0);
    expect(nvda.splits).toEqual([
      {
        at: 1718026200_000,
        numerator: 10,
        denominator: 1,
        ratio: "10:1",
      },
    ]);
    const tlv = parseChart((await recorded("chart-tlv-ro-bonus-2026")).body, 0);
    expect(tlv.splits).toEqual([
      {
        at: 1784185200_000,
        numerator: 114.42,
        denominator: 100,
        ratio: "114.42:100",
      },
    ]);
  });

  test("an unknown symbol is not found, and does not back the queue off", async () => {
    const missing = await recorded("chart-unknown-symbol");
    const nvda = await recorded("chart-nvda-5d-1d");
    const clock = fakeClock();
    const f = fakeFetch((url) =>
      chartSymbol(url) === "NOPE-ZZZZ" ? missing : nvda,
    );
    const client = yahoo({ clock, fetch: f.fetch });
    expect(await phrase(client.chart("NOPE-ZZZZ", 0, clock.now()))).toBe(
      "not found",
    );
    await client.chart("NVDA", 0, clock.now());
    expect(f.urls).toHaveLength(2);
  });

  test("a malformed answer is an error, never empty rows", async () => {
    const fx = await recorded("chart-nvda-5d-1d");
    const cases: ((body: any) => unknown)[] = [
      () => "<html>not json</html>",
      (b) => {
        b.chart.result = [];
        return b;
      },
      (b) => {
        delete b.chart.result[0].meta.exchangeTimezoneName;
        return b;
      },
      (b) => {
        b.chart.result[0].indicators.quote[0].close.pop();
        return b;
      },
      (b) => {
        b.chart.result[0].indicators.quote[0].close[1] = "212.2";
        return b;
      },
      (b) => {
        delete b.chart.result[0].meta.regularMarketPrice;
        return b;
      },
    ];
    for (const edit of cases) {
      const clock = fakeClock();
      const answer: Recorded = { ...fx, body: edit(clone(fx.body)) };
      const f = fakeFetch(() => answer);
      expect(
        await phrase(yahoo({ clock, fetch: f.fetch }).chart("NVDA", 0, 1)),
      ).toBe("malformed answer");
    }
  });

  test("a range without trading has no rows", () => {
    const body = {
      chart: {
        result: [
          {
            meta: {
              symbol: "X",
              exchangeName: "NMS",
              instrumentType: "EQUITY",
              exchangeTimezoneName: "America/New_York",
              regularMarketPrice: 1,
              regularMarketTime: 1792785600,
              currentTradingPeriod: {
                regular: { start: 1792762200, end: 1792785600 },
              },
            },
            indicators: { quote: [{}] },
          },
        ],
        error: null,
      },
    };
    expect(parseChart(body, 0).rows).toEqual([]);
  });
});

describe("the queue", () => {
  test("a 429 fails the run with a fixed phrase, marks it stale and backs the queue off", async () => {
    const limited = await recorded("chart-429-chrome-ua");
    const nvda = await recorded("chart-nvda-5d-1d");
    const clock = fakeClock();
    const { db } = open(":memory:", clock);
    let answer = limited;
    const f = fakeFetch(() => answer);
    const client = yahoo({ clock, fetch: f.fetch });
    const run = runJob(writer(db), clock, "yahoo", "bars", async () => {
      await client.chart("NVDA", 0, clock.now());
      return 1;
    });
    expect(await phrase(run)).toBe("rate limited");
    expect(lastRun(db, "yahoo", "bars")).toMatchObject({
      status: "failed",
      error: "rate limited",
      rows: 0,
    });
    expect(isStale(db, "yahoo")).toBe(true);

    answer = nvda;
    // a tool's fetch waits on the same queue as the job
    const next = client.chart("NVDA", 0, clock.now());
    await settle();
    expect(f.urls).toHaveLength(1);
    await clock.advance(RATE_LIMIT_BACKOFF_MS - 1);
    expect(f.urls).toHaveLength(1);
    await clock.advance(1);
    await next;
    expect(f.urls).toHaveLength(2);

    await runJob(writer(db), clock, "yahoo", "bars", async () => 3);
    expect(isStale(db, "yahoo")).toBe(false);
  });

  test("a tool's call fails at once while the queue is paused; a job's waits", async () => {
    const limited = await recorded("chart-429-chrome-ua");
    const nvda = await recorded("chart-nvda-5d-1d");
    const clock = fakeClock();
    let answer = limited;
    const f = fakeFetch(() => answer);
    const client = yahoo({ clock, fetch: f.fetch });
    expect(await phrase(client.chart("NVDA", 0, 1))).toBe("rate limited");
    answer = nvda;
    const job = client.chart("NVDA", 0, 1);
    expect(await phrase(client.failFast().chart("NVDA", 0, 1))).toBe(
      "rate limited",
    );
    expect(f.urls).toHaveLength(1);
    await clock.advance(RATE_LIMIT_BACKOFF_MS);
    await job;
    await client.failFast().chart("NVDA", 0, 1);
    expect(f.urls).toHaveLength(3);
  });

  test("closed at shutdown, the waiting calls fail and none waits out a back-off", async () => {
    const limited = await recorded("chart-429-chrome-ua");
    const clock = fakeClock();
    const f = fakeFetch(() => limited);
    const calls = queue(clock, 2);
    const client = yahoo({ clock, fetch: f.fetch, queue: calls });
    expect(await phrase(client.chart("NVDA", 0, 1))).toBe("rate limited");
    const waiting = client.chart("NVDA", 0, 1);
    calls.close();
    await expect(waiting).rejects.toThrow("the source queue is closed");
    await expect(client.chart("NVDA", 0, 1)).rejects.toThrow(
      "the source queue is closed",
    );
    await clock.advance(RATE_LIMIT_BACKOFF_MS);
    expect(f.urls).toHaveLength(1);
  });

  test("a failure backs off for a shorter while, and nothing is retried", async () => {
    const nvda = await recorded("chart-nvda-5d-1d");
    const clock = fakeClock();
    let fail = true;
    const f = fakeFetch(() =>
      fail ? { ...nvda, status: 503, body: "unavailable" } : nvda,
    );
    const client = yahoo({ clock, fetch: f.fetch });
    expect(await phrase(client.chart("NVDA", 0, 1))).toBe("source error");
    fail = false;
    const next = client.chart("NVDA", 0, 1);
    await clock.advance(FAILURE_BACKOFF_MS - 1);
    expect(f.urls).toHaveLength(1);
    await clock.advance(1);
    await next;
    expect(f.urls).toHaveLength(2);
  });

  test("an answer that reads wrong backs the queue off like a failure", async () => {
    const chart = await recorded("chart-nvda-5d-1d");
    const spark = await recorded("spark-v7-batch");
    const search = await recorded("search-nvda");
    const bad = clone(chart);
    delete bad.body.chart.result[0].meta.regularMarketPrice;
    const cases: [
      Recorded,
      (y: ReturnType<typeof yahoo>) => Promise<unknown>,
      string,
    ][] = [
      [bad, (y) => y.chart("NVDA", 0, 1), "malformed answer"],
      [
        { ...spark, body: { spark: { result: null, error: { code: "x" } } } },
        (y) => y.spark(["NVDA"]),
        "source error",
      ],
      [
        { ...search, body: { quotes: "none" } },
        (y) => y.search("NVDA"),
        "malformed answer",
      ],
    ];
    for (const [answer, call, expected] of cases) {
      const clock = fakeClock();
      let first = true;
      const f = fakeFetch(() => {
        const out = first ? answer : chart;
        first = false;
        return out;
      });
      const client = yahoo({ clock, fetch: f.fetch });
      expect(await phrase(call(client))).toBe(expected);
      expect(await phrase(client.failFast().chart("NVDA", 0, 1))).toBe(
        expected,
      );
      expect(f.urls).toHaveLength(1);
    }
  });

  test("never starts a call waiting past its caller's deadline, nor backs off", async () => {
    const clock = fakeClock();
    const q = queue(clock, 1);
    let open = () => {};
    const first = q.run(
      () =>
        new Promise<void>((resolve) => {
          open = resolve;
        }),
    );
    let live = true;
    let ran = false;
    const late = q.run(
      async () => {
        ran = true;
      },
      { failFast: true, live: () => live },
    );
    await settle();
    live = false;
    open();
    await first;
    expect(await phrase(late)).toBe("timed out");
    expect(ran).toBe(false);
    // the queue goes on at once
    expect(await q.run(async () => "next", { failFast: true })).toBe("next");
  });

  test("runs a few calls at a time", async () => {
    const clock = fakeClock();
    const q = queue(clock, 2);
    const gates: (() => void)[] = [];
    let started = 0;
    const task = () =>
      new Promise<void>((resolve) => {
        started++;
        gates.push(resolve);
      });
    const all = [q.run(task), q.run(task), q.run(task)];
    await settle();
    expect(started).toBe(2);
    gates.shift()!();
    await settle();
    await settle();
    expect(started).toBe(3);
    for (const open of gates) open();
    await Promise.all(all);
  });
});

describe("spark", () => {
  test("gives each symbol's price, trade time, previous close and session", async () => {
    const fx = await recorded("spark-v7-batch");
    const answer = parseSpark(fx.body, 1);
    expect(answer.quotes.map((q) => q.symbol)).toEqual([
      "SOL-USD",
      "TLV.RO",
      "NVDA",
      "VVSM.DE",
      "EURUSD=X",
    ]);
    const sol = answer.quotes[0]!;
    expect(sol).toMatchObject({
      exchange: "CCC",
      price: 101.52,
      time: 1792962233_000,
      previousClose: 102.269684,
      dayHigh: 102.57087,
      dayLow: 100.37113,
      volume: 1255574400,
      session: { zone: "UTC", start: 1792886400_000, end: 1792972740_000 },
    });
    const vvsm = answer.quotes[3]!;
    expect(vvsm.time).toBe(Date.parse("2026-10-23T15:35:57Z"));
    expect(answer.quotes[4]!.volume).toBe(0);
  });

  test("21 symbols go out as two calls, each with _=", async () => {
    const fx = await recorded("spark-v7-batch");
    const clock = fakeClock(Date.parse(fx.recordedAt));
    const f = fakeFetch(() => fx);
    const symbols = Array.from({ length: 21 }, (_, i) => `S${i}`);
    symbols[20] = "EURUSD=X";
    const batches = await yahoo({ clock, fetch: f.fetch }).sparkAll(symbols);
    expect(batches.map((b) => b.symbols.length)).toEqual([SPARK_MAX, 1]);
    expect(f.urls).toHaveLength(2);
    for (const url of f.urls) {
      expect(url.pathname).toBe("/v7/finance/spark");
      expect(url.searchParams.get("_")).toBe(String(clock.now()));
      expect(url.searchParams.get("range")).toBe("1d");
      expect(url.searchParams.get("interval")).toBe("5m");
    }
    expect(f.urls[0]!.searchParams.get("symbols")!.split(",")).toHaveLength(20);
    expect(f.urls[1]!.searchParams.get("symbols")).toBe("EURUSD=X");
    expect(f.urls[1]!.search).toContain("EURUSD%3DX");
  });

  test("a call over 20 symbols is refused before it goes out", async () => {
    const clock = fakeClock();
    const f = fakeFetch(() => undefined);
    const symbols = Array.from({ length: 21 }, (_, i) => `S${i}`);
    await expect(
      yahoo({ clock, fetch: f.fetch }).spark(symbols),
    ).rejects.toThrow("1 to 20");
    expect(f.urls).toHaveLength(0);
  });

  test("the source's 400 for 21 symbols is a bad request", async () => {
    const fx = await recorded("spark-v7-21-symbols");
    const clock = fakeClock();
    const f = fakeFetch(() => fx);
    expect(await phrase(yahoo({ clock, fetch: f.fetch }).spark(["A"]))).toBe(
      "bad request",
    );
  });

  test("a failed call keeps the other batch's answer", async () => {
    const fx = await recorded("spark-v7-batch");
    const limited = await recorded("chart-429-chrome-ua");
    const clock = fakeClock();
    let n = 0;
    const f = fakeFetch(() => (n++ === 0 ? fx : limited));
    const symbols = Array.from({ length: 21 }, (_, i) => `S${i}`);
    const batches = await yahoo({ clock, fetch: f.fetch }).sparkAll(symbols);
    expect(batches[0]!.answer?.quotes).toHaveLength(5);
    expect((batches[1]!.error as SourceError).phrase).toBe("rate limited");
  });
});

describe("search", () => {
  test("lists each listing with its exchange code", async () => {
    const fx = await recorded("search-vvsm");
    const clock = fakeClock();
    const f = fakeFetch(() => fx);
    const listings = await yahoo({ clock, fetch: f.fetch }).search("VVSM");
    expect(f.urls[0]!.searchParams.get("q")).toBe("VVSM");
    expect(listings[0]).toEqual({
      sourceSymbol: "VVSM.DE",
      exchange: "GER",
      type: "ETF",
      name: "VanEck Semiconductor UCITS ETF",
    });
    expect(listings.map((l) => l.exchange)).toEqual([
      "GER",
      "MUN",
      "DXE",
      "PNK",
      "CXE",
      "HAN",
      "DUS",
    ]);
  });
});
