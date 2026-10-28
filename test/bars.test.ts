// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import {
  type Bar,
  readBars,
  rebuildWeeks,
  upsertBars,
  weeksOf,
} from "../src/market/bars.ts";
import { session } from "../src/market/calendars.ts";
import { upsertInstrument } from "../src/market/instruments.ts";
import { parseChart } from "../src/sources/yahoo/client.ts";
import { dailyBars } from "../src/sources/yahoo/history.ts";
import { open } from "../src/storage/db/index.ts";
import { fakeClock } from "./helpers/clock.ts";
import { recorded } from "./helpers/yahoo.ts";

const utc = (iso: string) => Date.parse(iso);

const day = (date: string, close: number, final = true): Bar => ({
  date,
  open: close - 1,
  high: close + 1,
  low: close - 2,
  close,
  volume: 10,
  final,
});

describe("weekly bars", () => {
  test("are built Monday to Sunday from the daily bars", async () => {
    // crypto's open week runs to Sunday, which Yahoo's own weeks cut at Saturday
    const fx = await recorded("chart-sol-usd-1mo-1d");
    const a = parseChart(fx.body, utc(fx.recordedAt));
    const days = dailyBars(a, a.session);
    const weeks = weeksOf(days, a.session, utc(fx.recordedAt));
    const last = weeks.at(-1)!;
    const week = days.filter((d) => d.date >= "2026-10-19");
    expect(week.map((d) => d.date)).toEqual([
      "2026-10-19",
      "2026-10-20",
      "2026-10-21",
      "2026-10-22",
      "2026-10-23",
      "2026-10-24",
      "2026-10-25",
    ]);
    expect(last).toEqual({
      date: "2026-10-19",
      open: week[0]!.open,
      high: Math.max(...week.map((d) => d.high!)),
      low: Math.min(...week.map((d) => d.low!)),
      close: week[6]!.close,
      volume: week.reduce((s, d) => s + d.volume!, 0),
      final: false,
    });
    expect(weeks.at(-2)).toMatchObject({ date: "2026-10-12", final: true });
    for (const w of weeks) {
      expect(new Date(`${w.date}T12:00:00Z`).getUTCDay()).toBe(1);
    }
  });

  test("are final once Sunday has ended in the zone and the last day is final", () => {
    const days = [day("2026-10-19", 10), day("2026-10-23", 12, false)];
    const friday = session(
      "America/New_York",
      utc("2026-10-23T13:30:00Z"),
      utc("2026-10-23T20:00:00Z"),
    );
    const monday = session(
      "America/New_York",
      utc("2026-10-26T13:30:00Z"),
      utc("2026-10-26T20:00:00Z"),
    );
    // Sunday has ended in New York, but no later session showed yet
    expect(weeksOf(days, friday, utc("2026-10-26T05:00:00Z"))[0]!.final).toBe(
      false,
    );
    // a later session, before Sunday ended in New York
    const done = [day("2026-10-19", 10), day("2026-10-23", 12)];
    expect(weeksOf(done, monday, utc("2026-10-26T03:59:00Z"))[0]!.final).toBe(
      false,
    );
    expect(weeksOf(done, monday, utc("2026-10-26T14:00:00Z"))[0]!.final).toBe(
      true,
    );
  });

  test("a rebuild drops a week whose days are gone", () => {
    const clock = fakeClock();
    const { db } = open(":memory:", clock);
    upsertInstrument(
      db,
      {
        market: "US",
        symbol: "X",
        source: "yahoo",
        sourceSymbol: "X",
        exchange: "NMS",
        name: null,
        type: "EQUITY",
        currency: "USD",
        unit: "per_share",
        zone: "America/New_York",
      },
      clock.now(),
    );
    upsertBars(
      db,
      "US:X",
      "1d",
      [day("2026-10-12", 9), day("2026-10-19", 10)],
      0,
    );
    rebuildWeeks(db, "US:X", null, clock.now());
    expect(readBars(db, "US:X", "1wk").map((w) => w.date)).toEqual([
      "2026-10-12",
      "2026-10-19",
    ]);
    db.query("delete from bars where date = '2026-10-19'").run();
    rebuildWeeks(db, "US:X", null, clock.now(), "2026-10-21");
    expect(readBars(db, "US:X", "1wk").map((w) => w.date)).toEqual([
      "2026-10-12",
    ]);
  });
});
