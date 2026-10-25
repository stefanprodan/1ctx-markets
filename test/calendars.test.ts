// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  barDate,
  CRYPTO,
  isBarFinal,
  isQuoted,
  isWeekFinal,
  nextCheck,
  readSession,
  readSessions,
  recordSession,
  type Session,
  session,
  sessionDate,
  sessionFromChartMeta,
  weekEnd,
  weekOf,
} from "../src/calendars.ts";
import { open } from "../src/db/index.ts";
import { fakeClock } from "./helpers/clock.ts";

const YAHOO = join(import.meta.dir, "fixtures", "yahoo");

type Recorded = { recordedAt: string; body: any };

async function recorded(name: string): Promise<Recorded> {
  return Bun.file(join(YAHOO, `${name}.json`)).json();
}

async function chart(name: string) {
  const r = await recorded(name);
  const result = r.body.chart.result[0];
  return {
    meta: result.meta,
    stamps: (result.timestamp as number[]).map((s) => s * 1000),
    fetchedAt: Date.parse(r.recordedAt),
  };
}

const utc = (iso: string) => Date.parse(iso);

function period(zone: string, start: string, end: string) {
  return {
    exchangeTimezoneName: zone,
    currentTradingPeriod: {
      regular: { start: utc(start) / 1000, end: utc(end) / 1000 },
    },
  };
}

const at = (s: Session, start: string, end: string): Session => ({
  zone: s.zone,
  start: utc(start),
  end: utc(end),
});

function database() {
  return open(":memory:", fakeClock()).db;
}

describe("sessions from answers", () => {
  const cases: [string, string, string, string][] = [
    [
      "chart-vvsm-de-5d-1d",
      "Europe/Berlin",
      "2026-10-23T07:00:00Z",
      "2026-10-23T15:30:00Z",
    ],
    [
      "chart-nvda-5d-1d",
      "America/New_York",
      "2026-10-23T13:30:00Z",
      "2026-10-23T20:00:00Z",
    ],
    [
      "chart-h2o-ro-5d-1d",
      "Europe/Bucharest",
      "2026-10-23T07:00:00Z",
      "2026-10-23T15:00:00Z",
    ],
    [
      "chart-sol-usd-5d-1d",
      "UTC",
      "2026-10-25T00:00:00Z",
      "2026-10-25T23:59:00Z",
    ],
    [
      "chart-btc-usd-5d-1d",
      "UTC",
      "2026-10-25T00:00:00Z",
      "2026-10-25T23:59:00Z",
    ],
    [
      "chart-eurusd-x-5d-1d",
      "Europe/London",
      "2026-10-22T23:00:00Z",
      "2026-10-23T22:59:00Z",
    ],
    [
      "chart-cl-f-5d-1d",
      "America/New_York",
      "2026-10-25T04:00:00Z",
      "2026-10-26T03:59:00Z",
    ],
  ];
  for (const [name, zone, start, end] of cases) {
    test(`reads the zone and regular session of ${name}`, async () => {
      const { meta } = await chart(name);
      expect(sessionFromChartMeta(meta)).toEqual({
        zone,
        start: utc(start),
        end: utc(end),
      });
    });
  }

  test("reads the same session from a spark batch as from a chart", async () => {
    const spark = await recorded("spark-v7-batch");
    const charts: Record<string, string> = {
      "SOL-USD": "chart-sol-usd-5d-1d",
      "TLV.RO": "chart-h2o-ro-5d-1d",
      NVDA: "chart-nvda-5d-1d",
      "VVSM.DE": "chart-vvsm-de-5d-1d",
      "EURUSD=X": "chart-eurusd-x-5d-1d",
    };
    const results = spark.body.spark.result as any[];
    expect(results.map((r) => r.symbol).sort()).toEqual(
      Object.keys(charts).sort(),
    );
    for (const result of results) {
      const { meta } = await chart(charts[result.symbol]!);
      expect(sessionFromChartMeta(result.response[0].meta)).toEqual(
        sessionFromChartMeta(meta),
      );
    }
  });

  test("dates a session by its local start", async () => {
    expect(
      sessionDate(
        sessionFromChartMeta((await chart("chart-eurusd-x-5d-1d")).meta),
      ),
    ).toBe("2026-10-23");
    expect(
      sessionDate(sessionFromChartMeta((await chart("chart-cl-f-5d-1d")).meta)),
    ).toBe("2026-10-25");
  });

  test("rejects an answer without a usable zone or period", () => {
    const good = period(
      "Europe/Berlin",
      "2026-10-23T07:00:00Z",
      "2026-10-23T15:30:00Z",
    );
    const bad: [unknown, string][] = [
      [null, "no exchange zone"],
      [{ ...good, exchangeTimezoneName: undefined }, "no exchange zone"],
      [{ ...good, exchangeTimezoneName: "" }, "no exchange zone"],
      [{ ...good, exchangeTimezoneName: "Mars/Base" }, "unknown exchange zone"],
      [
        { ...good, exchangeTimezoneName: "+01:00" },
        "exchange zone is an offset",
      ],
      [
        { ...good, currentTradingPeriod: undefined },
        "no regular trading period",
      ],
      [
        { ...good, currentTradingPeriod: { regular: { start: "1", end: 2 } } },
        "no regular trading period",
      ],
      [
        { ...good, currentTradingPeriod: { regular: { start: 1.5, end: 2 } } },
        "no regular trading period",
      ],
      [
        period("Europe/Berlin", "2026-10-23T15:30:00Z", "2026-10-23T07:00:00Z"),
        "malformed regular trading period",
      ],
      [
        period("Europe/Berlin", "2026-10-23T07:00:00Z", "2026-10-23T07:00:00Z"),
        "malformed regular trading period",
      ],
      [
        period("Europe/Berlin", "2026-10-23T07:00:00Z", "2026-10-24T08:01:00Z"),
        "malformed regular trading period",
      ],
    ];
    for (const [m, error] of bad) {
      expect(() => sessionFromChartMeta(m)).toThrow(error);
    }
  });

  test("accepts the 25-hour local day of a clock change", () => {
    const s = sessionFromChartMeta(
      period(
        "America/New_York",
        "2026-11-01T04:00:00Z",
        "2026-11-02T04:59:00Z",
      ),
    );
    expect(sessionDate(s)).toBe("2026-11-01");
  });
});

describe("stored sessions", () => {
  test("keeps the session of the latest answer and never a stale one", async () => {
    const db = database();
    const { meta: friday, fetchedAt } = await chart("chart-vvsm-de-5d-1d");
    const monday = sessionFromChartMeta(
      period("Europe/Berlin", "2026-10-26T08:00:00Z", "2026-10-26T16:30:00Z"),
    );
    const mondayAt = utc("2026-10-26T08:00:01Z");

    expect(readSession(db, "XETRA")).toBeNull();
    expect(recordSession(db, "XETRA", monday, mondayAt)).toBe(true);
    expect(
      recordSession(db, "XETRA", sessionFromChartMeta(friday), fetchedAt),
    ).toBe(false);
    expect(readSession(db, "XETRA")).toEqual({
      market: "XETRA",
      ...monday,
      fetchedAt: mondayAt,
    });
    db.close();
  });

  test("a later answer with the same session moves only its fetch time", async () => {
    const db = database();
    const { meta, fetchedAt } = await chart("chart-nvda-5d-1d");
    const s = sessionFromChartMeta(meta);
    expect(recordSession(db, "US", s, utc("2026-10-23T20:05:00Z"))).toBe(true);
    expect(recordSession(db, "US", s, fetchedAt)).toBe(true);
    expect(
      recordSession(
        db,
        "CRYPTO",
        sessionFromChartMeta((await chart("chart-sol-usd-5d-1d")).meta),
        fetchedAt,
      ),
    ).toBe(true);
    expect(readSessions(db)).toEqual([
      {
        market: "CRYPTO",
        zone: "UTC",
        start: utc("2026-10-25T00:00:00Z"),
        end: utc("2026-10-25T23:59:00Z"),
        fetchedAt,
      },
      { market: "US", ...s, fetchedAt },
    ]);
    db.close();
  });

  test("an answer fetched at the same time as the stored one replaces it", () => {
    const db = database();
    const t = utc("2026-10-26T08:00:00Z");
    const friday = sessionFromChartMeta(
      period("Europe/Berlin", "2026-10-23T07:00:00Z", "2026-10-23T15:30:00Z"),
    );
    const monday = at(friday, "2026-10-26T08:00:00Z", "2026-10-26T16:30:00Z");
    recordSession(db, "XETRA", friday, t);
    expect(recordSession(db, "XETRA", monday, t)).toBe(true);
    expect(readSession(db, "XETRA")?.start).toBe(monday.start);
    db.close();
  });

  test("rejects a session the answer could not give", () => {
    const db = database();
    const s = { zone: "Mars/Base", start: 0, end: 1 };
    expect(() => recordSession(db, "XETRA", s, 1)).toThrow(
      "unknown exchange zone",
    );
    expect(readSessions(db)).toEqual([]);
    db.close();
  });
});

describe("quoting", () => {
  test("quotes only inside the stored session", async () => {
    const s = sessionFromChartMeta((await chart("chart-vvsm-de-5d-1d")).meta);
    expect(isQuoted("XETRA", s, utc("2026-10-23T06:59:59Z"))).toBe(false);
    expect(isQuoted("XETRA", s, utc("2026-10-23T07:00:00Z"))).toBe(true);
    expect(isQuoted("XETRA", s, utc("2026-10-23T15:30:00Z"))).toBe(true);
    expect(isQuoted("XETRA", s, utc("2026-10-23T15:31:00Z"))).toBe(false);
    expect(isQuoted("XETRA", s, utc("2026-10-25T19:40:00Z"))).toBe(false);
    expect(isQuoted("XETRA", s, utc("2026-10-26T08:00:00Z"))).toBe(false);
    expect(isQuoted("XETRA", null, utc("2026-10-23T08:00:00Z"))).toBe(false);
  });

  test("a whole-day session is quoted up to the next local midnight", async () => {
    const s = sessionFromChartMeta((await chart("chart-cl-f-5d-1d")).meta);
    expect(isQuoted("NYM", s, utc("2026-10-25T03:59:59Z"))).toBe(false);
    expect(isQuoted("NYM", s, utc("2026-10-26T03:59:00Z"))).toBe(true);
    expect(isQuoted("NYM", s, utc("2026-10-26T03:59:59.999Z"))).toBe(true);
    expect(isQuoted("NYM", s, utc("2026-10-26T04:00:00Z"))).toBe(false);
    // the next day's first check lands on that midnight
    expect(nextCheck(s, utc("2026-10-25T19:40:07Z"))).toBe(
      utc("2026-10-26T04:00:00Z"),
    );
  });

  test("crypto is always quoted", async () => {
    const s = sessionFromChartMeta((await chart("chart-btc-usd-5d-1d")).meta);
    expect(isQuoted(CRYPTO, s, utc("2026-10-28T12:00:00Z"))).toBe(true);
    expect(isQuoted(CRYPTO, null, utc("2026-10-28T12:00:00Z"))).toBe(true);
  });
});

describe("checks for a closed market", () => {
  test("a Friday session read on Sunday checks at Monday's local start, then hourly", async () => {
    const db = database();
    const { meta, fetchedAt } = await chart("chart-vvsm-de-5d-1d");
    recordSession(db, "XETRA", sessionFromChartMeta(meta), fetchedAt);

    // 09:00 CEST on Friday is 09:00 CET on Monday
    let stored = readSession(db, "XETRA")!;
    const monday = nextCheck(stored, stored.fetchedAt);
    expect(monday).toBe(utc("2026-10-26T08:00:00Z"));
    expect(isQuoted("XETRA", stored, monday)).toBe(false);

    // the source still shows Friday at the open, so an hour later
    recordSession(db, "XETRA", stored, monday);
    stored = readSession(db, "XETRA")!;
    expect(nextCheck(stored, stored.fetchedAt)).toBe(
      utc("2026-10-26T09:00:00Z"),
    );

    const checks: number[] = [];
    let since = stored.fetchedAt;
    for (let i = 0; i < 10; i++) {
      since = nextCheck(stored, since);
      checks.push(since);
    }
    expect(checks.map((t) => new Date(t).toISOString())).toEqual([
      "2026-10-26T09:00:00.000Z",
      "2026-10-26T10:00:00.000Z",
      "2026-10-26T11:00:00.000Z",
      "2026-10-26T12:00:00.000Z",
      "2026-10-26T13:00:00.000Z",
      "2026-10-26T14:00:00.000Z",
      "2026-10-26T15:00:00.000Z",
      "2026-10-26T16:00:00.000Z",
      "2026-10-27T08:00:00.000Z",
      "2026-10-27T09:00:00.000Z",
    ]);

    // quoting restarts once an answer shows Monday's session
    const at10 = utc("2026-10-26T09:00:00Z");
    const mon = sessionFromChartMeta(
      period("Europe/Berlin", "2026-10-26T08:00:00Z", "2026-10-26T16:30:00Z"),
    );
    expect(recordSession(db, "XETRA", mon, at10)).toBe(true);
    stored = readSession(db, "XETRA")!;
    expect(isQuoted("XETRA", stored, at10)).toBe(true);
    expect(isQuoted("XETRA", stored, utc("2026-10-26T16:30:30Z"))).toBe(true);
    expect(isQuoted("XETRA", stored, utc("2026-10-26T16:31:00Z"))).toBe(false);
    db.close();
  });

  test("checks each day after the session, across the European clock change", async () => {
    const s = sessionFromChartMeta((await chart("chart-vvsm-de-5d-1d")).meta);
    // the closing auction's answer came after the end
    let since = utc("2026-10-23T15:35:57Z");
    const firsts: string[] = [];
    for (let i = 0; i < 27; i++) {
      since = nextCheck(s, since);
      if (i % 9 === 0) firsts.push(new Date(since).toISOString());
    }
    expect(firsts).toEqual([
      "2026-10-24T07:00:00.000Z",
      "2026-10-25T08:00:00.000Z",
      "2026-10-26T08:00:00.000Z",
    ]);
  });

  test("checks at each market's local start in the weeks Europe and the US are an hour closer", async () => {
    const us = sessionFromChartMeta((await chart("chart-nvda-5d-1d")).meta);
    const bvb = sessionFromChartMeta((await chart("chart-h2o-ro-5d-1d")).meta);
    const sunday = utc("2026-10-25T19:40:00Z");
    // New York keeps summer time until 2026-11-01
    expect(nextCheck(us, sunday)).toBe(utc("2026-10-26T13:30:00Z"));
    expect(nextCheck(bvb, sunday)).toBe(utc("2026-10-26T08:00:00Z"));

    const lateUs = at(us, "2026-10-30T13:30:00Z", "2026-10-30T20:00:00Z");
    // 09:30 EDT on Friday is 09:30 EST from Sunday on
    expect(nextCheck(lateUs, utc("2026-11-01T12:00:00Z"))).toBe(
      utc("2026-11-01T14:30:00Z"),
    );
    expect(nextCheck(lateUs, utc("2026-11-01T20:30:00Z"))).toBe(
      utc("2026-11-02T14:30:00Z"),
    );
    const lateFutures = sessionFromChartMeta(
      period(
        "America/New_York",
        "2026-10-31T04:00:00Z",
        "2026-11-01T03:59:00Z",
      ),
    );
    const sundayChecks = [nextCheck(lateFutures, utc("2026-11-01T03:59:30Z"))];
    for (let i = 0; i < 3; i++) {
      sundayChecks.push(nextCheck(lateFutures, sundayChecks.at(-1)!));
    }
    // 01:00 happens twice on Sunday; the hour is checked once
    expect(sundayChecks.map((t) => new Date(t).toISOString())).toEqual([
      "2026-11-01T04:00:00.000Z",
      "2026-11-01T05:00:00.000Z",
      "2026-11-01T07:00:00.000Z",
      "2026-11-01T08:00:00.000Z",
    ]);
  });

  test("a check long overdue lands near the time asked, not at the session", async () => {
    const s = sessionFromChartMeta((await chart("chart-vvsm-de-5d-1d")).meta);
    expect(nextCheck(s, utc("2026-12-01T12:00:00Z"))).toBe(
      utc("2026-12-01T13:00:00Z"),
    );
    expect(nextCheck(s, utc("2026-12-01T16:00:00Z"))).toBe(
      utc("2026-12-02T08:00:00Z"),
    );
  });

  test("a session whose local end falls before its start still gets a daily check", () => {
    // 01:50 EDT to 01:10 EST across the US clock change
    const s = session(
      "America/New_York",
      utc("2026-11-01T05:50:00Z"),
      utc("2026-11-01T06:10:00Z"),
    );
    expect(nextCheck(s, utc("2026-11-01T06:20:00Z"))).toBe(
      utc("2026-11-02T06:50:00Z"),
    );
  });

  test("a session still ahead is checked at its start", () => {
    const s = sessionFromChartMeta(
      period("Europe/Berlin", "2026-10-26T08:00:00Z", "2026-10-26T16:30:00Z"),
    );
    expect(nextCheck(s, utc("2026-10-26T07:00:00Z"))).toBe(s.start);
  });
});

describe("bar dates and finality", () => {
  test("dates FX bars by the London day they start", async () => {
    const { meta, stamps } = await chart("chart-eurusd-x-5d-1d");
    const s = sessionFromChartMeta(meta);
    // the last stamp is the live price, not a daily bar
    expect(stamps.at(-1)).toBe(meta.regularMarketTime * 1000);
    expect(stamps.slice(0, -1).map((t) => barDate(s.zone, t))).toEqual([
      "2026-10-19",
      "2026-10-20",
      "2026-10-21",
      "2026-10-22",
      "2026-10-23",
    ]);
    // the answer's own offset is already winter time and would misdate
    expect(meta.gmtoffset).toBe(0);
    expect(barDate(s.zone, utc("2026-10-22T23:00:00Z"))).toBe("2026-10-23");
    expect(barDate(s.zone, utc("2026-10-26T00:00:00Z"))).toBe("2026-10-26");
  });

  test("dates futures bars by the New York day", async () => {
    const { meta, stamps } = await chart("chart-cl-f-5d-1d");
    const s = sessionFromChartMeta(meta);
    expect(stamps.map((t) => barDate(s.zone, t))).toEqual([
      "2026-10-20",
      "2026-10-21",
      "2026-10-22",
      "2026-10-23",
    ]);
    expect(barDate(s.zone, utc("2026-11-02T05:00:00Z"))).toBe("2026-11-02");
    expect(barDate(s.zone, utc("2026-11-02T04:30:00Z"))).toBe("2026-11-01");
  });

  test("dates bars by the exchange's day across a clock change", async () => {
    const { meta, stamps } = await chart("chart-vvsm-de-5d-1d");
    const s = sessionFromChartMeta(meta);
    expect(stamps.map((t) => barDate(s.zone, t))).toEqual([
      "2026-10-19",
      "2026-10-20",
      "2026-10-21",
      "2026-10-22",
      "2026-10-23",
    ]);
    expect(barDate("Europe/Berlin", utc("2026-10-25T22:30:00Z"))).toBe(
      "2026-10-25",
    );
    expect(barDate("Europe/Berlin", utc("2026-10-25T23:00:00Z"))).toBe(
      "2026-10-26",
    );
    expect(barDate("Europe/Berlin", utc("2026-10-24T22:00:00Z"))).toBe(
      "2026-10-25",
    );
    expect(barDate("America/New_York", utc("2026-11-01T03:59:00Z"))).toBe(
      "2026-10-31",
    );
    expect(barDate("America/New_York", utc("2026-11-02T04:59:00Z"))).toBe(
      "2026-11-01",
    );
    expect(barDate("Asia/Tokyo", utc("2026-10-25T15:00:00Z"))).toBe(
      "2026-10-26",
    );
  });

  test("a bar is not final while answers show its session, even after its end", async () => {
    const db = database();
    const { meta, stamps, fetchedAt } = await chart("chart-vvsm-de-5d-1d");
    const s = sessionFromChartMeta(meta);
    const friday = barDate(s.zone, stamps.at(-1)!);
    // the last print, 15:35 UTC, came after the session's 15:30 end
    expect(meta.regularMarketTime * 1000).toBeGreaterThan(s.end);
    recordSession(db, "XETRA", s, fetchedAt);
    let stored = readSession(db, "XETRA")!;
    expect(isBarFinal(friday, stored)).toBe(false);
    expect(isBarFinal("2026-10-22", stored)).toBe(true);

    recordSession(
      db,
      "XETRA",
      at(s, "2026-10-26T08:00:00Z", "2026-10-26T16:30:00Z"),
      utc("2026-10-26T08:00:00Z"),
    );
    stored = readSession(db, "XETRA")!;
    expect(isBarFinal(friday, stored)).toBe(true);
    expect(isBarFinal("2026-10-26", stored)).toBe(false);
    db.close();
  });

  test("FX Friday is not final while its session shows, futures are by Sunday", async () => {
    const fx = sessionFromChartMeta((await chart("chart-eurusd-x-5d-1d")).meta);
    expect(isBarFinal("2026-10-23", fx)).toBe(false);
    expect(isBarFinal("2026-10-22", fx)).toBe(true);
    const futures = sessionFromChartMeta(
      (await chart("chart-cl-f-5d-1d")).meta,
    );
    expect(isBarFinal("2026-10-23", futures)).toBe(true);
  });

  test("rejects a malformed bar date", () => {
    const s = sessionFromChartMeta(
      period("UTC", "2026-10-25T00:00:00Z", "2026-10-25T23:59:00Z"),
    );
    expect(() => isBarFinal("2026-10-2", s)).toThrow("not a date");
    expect(() => isBarFinal("2026-02-30", s)).toThrow("not a date");
  });
});

describe("weeks", () => {
  test("run Monday to Sunday", () => {
    expect(weekOf("2026-10-19")).toBe("2026-10-19");
    expect(weekOf("2026-10-23")).toBe("2026-10-19");
    expect(weekOf("2026-10-25")).toBe("2026-10-19");
    expect(weekOf("2026-10-26")).toBe("2026-10-26");
    expect(weekOf("2027-01-01")).toBe("2026-12-28");
  });

  test("end at Sunday's local midnight in the exchange's zone", () => {
    expect(weekEnd("Europe/Berlin", "2026-10-12")).toBe(
      utc("2026-10-18T22:00:00Z"),
    );
    expect(weekEnd("Europe/Berlin", "2026-10-19")).toBe(
      utc("2026-10-25T23:00:00Z"),
    );
    expect(weekEnd("America/New_York", "2026-10-19")).toBe(
      utc("2026-10-26T04:00:00Z"),
    );
    expect(weekEnd("America/New_York", "2026-10-26")).toBe(
      utc("2026-11-02T05:00:00Z"),
    );
    expect(weekEnd("UTC", "2026-10-19")).toBe(utc("2026-10-26T00:00:00Z"));
    expect(() => weekEnd("UTC", "2026-10-20")).toThrow("not a Monday");
  });

  test("a week is final once its Sunday ended and its last day is final", async () => {
    const { meta } = await chart("chart-vvsm-de-5d-1d");
    const friday = sessionFromChartMeta(meta);
    const monday = at(friday, "2026-10-26T08:00:00Z", "2026-10-26T16:30:00Z");
    const week = "2026-10-19";
    expect(
      isWeekFinal(week, "2026-10-23", friday, utc("2026-10-25T19:40:00Z")),
    ).toBe(false);
    // Sunday ended in Berlin, but Friday's bar is not final yet
    expect(
      isWeekFinal(week, "2026-10-23", friday, utc("2026-10-25T23:00:00Z")),
    ).toBe(false);
    expect(
      isWeekFinal(week, "2026-10-23", monday, utc("2026-10-26T08:00:00Z")),
    ).toBe(true);
    // a later session cannot show before the week ends; the clock still rules
    expect(
      isWeekFinal(week, "2026-10-23", monday, utc("2026-10-25T22:59:59Z")),
    ).toBe(false);
    expect(() =>
      isWeekFinal(week, "2026-10-26", monday, utc("2026-10-27T00:00:00Z")),
    ).toThrow("not in the week");
  });

  test("a crypto week ends with the UTC Sunday", async () => {
    const sunday = sessionFromChartMeta(
      (await chart("chart-sol-usd-5d-1d")).meta,
    );
    const monday = at(sunday, "2026-10-26T00:00:00Z", "2026-10-26T23:59:00Z");
    const week = "2026-10-19";
    expect(
      isWeekFinal(week, "2026-10-25", sunday, utc("2026-10-26T00:00:00Z")),
    ).toBe(false);
    expect(
      isWeekFinal(week, "2026-10-25", monday, utc("2026-10-25T23:59:59Z")),
    ).toBe(false);
    expect(
      isWeekFinal(week, "2026-10-25", monday, utc("2026-10-26T00:00:00Z")),
    ).toBe(true);
  });

  test("weekly bars span the exchange's days", async () => {
    const { stamps } = await chart("chart-vvsm-de-5d-1d");
    const weeks = new Set(
      stamps.map((t) => weekOf(barDate("Europe/Berlin", t))),
    );
    expect([...weeks]).toEqual(["2026-10-19"]);
  });
});
