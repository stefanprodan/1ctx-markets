// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "bun:test";
import { readBars } from "../src/market/bars.ts";
import { recordSession } from "../src/market/calendars.ts";
import { readInstrument } from "../src/market/instruments.ts";
import { readQuote } from "../src/market/quotes.ts";
import { JOBS, quoteStale, STALE, SWITCH } from "../src/market/stale.ts";
import { ruleEngine } from "../src/rules/evaluate.ts";
import {
  bindCondition,
  parseCondition,
  writeCondition,
} from "../src/rules/format.ts";
import { insertRule, readRule } from "../src/rules/store.ts";
import { MINUTE_MS } from "../src/runtime/clock.ts";
import { silent } from "../src/runtime/log.ts";
import { bvb, MARKET } from "../src/sources/bvb/client.ts";
import {
  readSources,
  sourceSwitch,
  writeSources,
} from "../src/sources/bvb/switch.ts";
import { fetchInstrument as fetchBvb } from "../src/sources/bvb/sync.ts";
import { backfillStart } from "../src/sources/history.ts";
import { SourceError } from "../src/sources/source.ts";
import { parseChart, parseSpark, yahoo } from "../src/sources/yahoo/client.ts";
import { dailyBars, settle } from "../src/sources/yahoo/history.ts";
import { keyOf } from "../src/sources/yahoo/resolve.ts";
import {
  addInstrument,
  catchUp,
  fetchQuotes,
  refetch,
} from "../src/sources/yahoo/sync.ts";
import { type Db, open } from "../src/storage/db/index.ts";
import { lastStarted } from "../src/storage/runs.ts";
import { writer } from "../src/storage/writer.ts";
import { bvbFetch, bvbRecorded } from "./helpers/bvb.ts";
import { fakeClock } from "./helpers/clock.ts";
import { drive } from "./helpers/drive.ts";
import { NOW, sources } from "./helpers/sources.ts";
import {
  backTo,
  chartSymbol,
  clone,
  fakeFetch,
  listed,
  recorded,
} from "./helpers/yahoo.ts";

const signalRows = (db: Db, instrument: string) =>
  db
    .query(
      `select * from signals where instrument = ?
       order by interval, kind, date`,
    )
    .all(instrument);

test("a quote whose listing differs from the stored one is refused", async () => {
  const chart = listed(await recorded("chart-nvda-5d-1d"));
  const spark = clone(await recorded("spark-v7-batch"));
  spark.body.spark.result = spark.body.spark.result.filter(
    (entry: any) => entry.symbol === "NVDA",
  );
  const wrong = clone(spark);
  const meta = wrong.body.spark.result[0].response[0].meta;
  meta.exchangeName = "GER";
  meta.regularMarketPrice = 1;
  meta.regularMarketTime += 60;

  const clock = fakeClock(Date.parse(spark.recordedAt));
  const { db } = open(":memory:", clock);
  const write = writer(db);
  let quote = spark;
  const f = fakeFetch((url) => {
    if (chartSymbol(url) === "NVDA") return chart;
    if (
      url.pathname === "/v7/finance/spark" &&
      url.searchParams.get("symbols") === "NVDA"
    ) {
      return quote;
    }
    return undefined;
  });
  const ctx = {
    db,
    clock,
    writer: write,
    yahoo: yahoo({ clock, fetch: f.fetch }),
  };

  try {
    const { instrument } = await addInstrument(ctx, "NVDA", "US:NVDA");
    await fetchQuotes(ctx, [instrument]);
    const previous = readQuote(db, instrument.id)!;
    const signals = signalRows(db, instrument.id);
    expect(previous.price).toBeGreaterThan(1);
    expect(signals.filter((row: any) => row.kind === "live")).toHaveLength(2);
    const parsed = parseSpark(wrong.body, clock.now());
    expect(parsed.skipped).toEqual([]);
    expect(keyOf(parsed.quotes[0]!.exchange, parsed.quotes[0]!.symbol)).toBe(
      "XETRA:NVDA",
    );

    await clock.advance(1000);
    quote = wrong;
    const answer = await fetchQuotes(ctx, [instrument]);
    expect(answer.quotes).toEqual([]);
    expect(answer.skipped).toEqual([
      { symbol: "NVDA", phrase: "malformed answer" },
    ]);
    expect(f.urls.map((url) => url.pathname)).toEqual([
      "/v8/finance/chart/NVDA",
      "/v7/finance/spark",
      "/v7/finance/spark",
    ]);
    expect(readQuote(db, instrument.id)).toEqual(previous);
    expect(signalRows(db, instrument.id)).toEqual(signals);
    expect(readInstrument(db, "XETRA:NVDA")).toBeNull();

    // a path that needs the quote fails rather than keep the old price as live
    const caught = await catchUp(ctx, instrument, () => true).then(
      () => null,
      (error: unknown) => error,
    );
    expect(caught).toBeInstanceOf(SourceError);
    expect((caught as SourceError).phrase).toBe("malformed answer");
    expect(readQuote(db, instrument.id)).toEqual(previous);
  } finally {
    await write.close();
    db.close();
  }
});

test("a source switch without a replacement quote preserves the old data and remains pending", async () => {
  const chart = listed(
    backTo(await recorded("chart-tlv-ro-bonus-2026"), "2026-06-22"),
  );
  const history = await bvbRecorded("wapi-history-tlv-1d-bonus-2026");
  const missing = clone(await recorded("spark-v7-batch"));
  missing.body.spark.result = [{ symbol: "TLV.RO", response: null }];
  const clock = fakeClock(NOW);
  const { db } = open(":memory:", clock);
  const write = writer(db);
  const feed = await bvbFetch({ histories: { TLV: history } });
  const exchange = bvb({ clock, fetch: feed.fetch });
  const f = await sources({
    charts: { "TLV.RO": chart },
    hold: async (url) =>
      url.pathname === "/v7/finance/spark" ? missing : undefined,
  });
  const ctx = {
    db,
    clock,
    writer: write,
    yahoo: yahoo({ clock, fetch: f.fetch }),
  };

  try {
    const answered = parseChart(chart.body, clock.now());
    // A stored session survives a change of source.
    await write.write((db) =>
      recordSession(db, MARKET, answered.session, clock.now()),
    );
    const instrument = await drive(
      clock,
      exchange,
      fetchBvb(
        { db, clock, writer: write, bvb: exchange },
        "TLV",
        "BVB:TLV",
        () => true,
      ),
    );
    await write.write((db) => writeSources(db, ["bvb", "yahoo"], clock.now()));
    const previous = readQuote(db, instrument.id)!;
    const days = readBars(db, instrument.id, "1d");
    const weeks = readBars(db, instrument.id, "1wk");
    const signals = signalRows(db, instrument.id);
    expect(previous.source).toBe("bvb");
    expect(days).toHaveLength(30);
    expect(signals.length).toBeGreaterThan(0);
    expect(dailyBars(answered, null).map((bar) => bar.date)).toEqual(
      days.map((bar) => bar.date),
    );
    expect(parseSpark(missing.body, clock.now())).toMatchObject({
      quotes: [],
      skipped: [{ symbol: "TLV.RO", phrase: "not found" }],
    });
    const move = sourceSwitch({ yahoo: ctx, bvb: null, log: silent });
    expect(move.needed()).toBe(true);

    await move.run();
    expect(f.calls.searches().map((url) => url.searchParams.get("q"))).toEqual([
      "TLV",
    ]);
    expect(f.calls.charts("TLV.RO")).toHaveLength(1);
    expect(f.calls.sparks()).toHaveLength(1);

    expect({
      quote: readQuote(db, instrument.id),
      source: readInstrument(db, instrument.id)!.source,
      status: lastStarted(db, SWITCH.source, SWITCH.job, MARKET)!.status,
    }).toEqual({ quote: previous, source: "bvb", status: "failed" });
    expect(readBars(db, instrument.id, "1d")).toEqual(days);
    expect(readBars(db, instrument.id, "1wk")).toEqual(weeks);
    expect(signalRows(db, instrument.id)).toEqual(signals);
    expect(readSources(db)).toEqual(["bvb", "yahoo"]);
    expect(move.needed()).toBe(true);
    expect(quoteStale(db, readInstrument(db, instrument.id)!)).toContain(
      STALE.switchPending,
    );
  } finally {
    exchange.close();
    await write.close();
    db.close();
  }
});

test("a rescaled FX history covering the live-minute day is accepted", async () => {
  const history = listed(await recorded("chart-eurron-x-5d-1d"));
  const scaled = clone(history);
  const result = scaled.body.chart.result[0];
  for (const field of ["open", "high", "low", "close"]) {
    result.indicators.quote[0][field] = result.indicators.quote[0][field].map(
      (value: number | null) => (value === null ? null : value / 2),
    );
  }
  for (const field of [
    "regularMarketPrice",
    "regularMarketDayHigh",
    "regularMarketDayLow",
    "chartPreviousClose",
  ]) {
    result.meta[field] /= 2;
  }
  const clock = fakeClock(Date.parse(history.recordedAt));
  const { db } = open(":memory:", clock);
  const write = writer(db);
  const answers = [history, scaled, scaled];
  const f = fakeFetch((url) =>
    chartSymbol(url) === "EURRON=X" ? answers.shift() : undefined,
  );
  const rules = ruleEngine({ quoteEveryMs: 5 * MINUTE_MS });
  const ctx = {
    db,
    clock,
    writer: write,
    yahoo: yahoo({ clock, fetch: f.fetch }),
    rules,
  };

  try {
    const { instrument } = await addInstrument(ctx, "EURRON=X", "CCY:EURRON=X");
    const before = readBars(db, instrument.id, "1d");
    expect(before.at(-1)).toMatchObject({ date: "2026-10-26", final: false });
    expect(before.filter((bar) => bar.final)).toHaveLength(4);
    const whole = parseChart(scaled.body, clock.now());
    expect(whole.rows.at(-1)!.at).toBe(whole.time);
    // a rescale settles each final day at the next day's open
    const expected = settle(
      db,
      instrument,
      dailyBars(whole, whole.session),
      false,
    ).bars;
    expect(expected.map((bar) => bar.date)).toEqual(
      before.map((bar) => bar.date),
    );
    const condition = bindCondition(
      parseCondition({ left: "price", op: ">", right: 6 }),
      instrument.id,
      (symbol) => symbol,
      null,
    );
    const rule = await write.write((db) =>
      insertRule(
        db,
        {
          instrument: instrument.id,
          condition: writeCondition(condition),
          note: null,
        },
        clock.now(),
      ),
    );
    expect(readRule(db, rule)!.paused).toBeNull();

    const outcome = await refetch(ctx, instrument).then(
      (written) => ({ written, error: null }),
      (error: unknown) => ({ written: null, error }),
    );
    expect(answers).toHaveLength(0);
    expect(f.urls).toHaveLength(3);
    expect(f.urls[2]!.searchParams.get("period1")).toBe(
      String(backfillStart(clock.now()).from / 1000),
    );
    expect(readRule(db, rule)!.paused).toBe("split");

    expect(outcome.error).toBeNull();
    expect(outcome.written).toMatchObject({
      rows: 5,
      changedFrom: before[0]!.date,
      owed: null,
    });
    expect(readBars(db, instrument.id, "1d")).toEqual(expected);
    expect(lastStarted(db, "yahoo", JOBS.bars, instrument.id)!.status).toBe(
      "ok",
    );
  } finally {
    await write.close();
    db.close();
  }
});
