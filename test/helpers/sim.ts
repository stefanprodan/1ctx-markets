// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A made-up Yahoo: a session shows from its start on, as Friday's on Sunday.

import {
  addDays,
  fromWallTime,
  localDate,
  wallOfDate,
} from "../../src/market/zone.ts";
import { MINUTE_MS } from "../../src/runtime/clock.ts";
import type { Recorded } from "./yahoo.ts";

const HOUR_MS = 60 * MINUTE_MS;

export type SimListing = {
  symbol: string;
  exchange: string;
  type: string;
  zone: string;
  // local wall time of the session's start and end, ms after midnight
  open: number;
  close: number;
  // trades every day, crypto's UTC day
  always?: boolean;
};

export const at = (h: number, m = 0) => h * HOUR_MS + m * MINUTE_MS;

export const US = (symbol: string): SimListing => ({
  symbol,
  exchange: "NMS",
  type: "EQUITY",
  zone: "America/New_York",
  open: at(9, 30),
  close: at(16),
});

export const XETRA = (symbol: string): SimListing => ({
  symbol: `${symbol}.DE`,
  exchange: "GER",
  type: "ETF",
  zone: "Europe/Berlin",
  open: at(9),
  close: at(17, 30),
});

export const BVB = (symbol: string): SimListing => ({
  symbol: `${symbol}.RO`,
  exchange: "BVB",
  type: "EQUITY",
  zone: "Europe/Bucharest",
  open: at(10),
  close: at(18),
});

export const CRYPTO = (symbol: string): SimListing => ({
  symbol,
  exchange: "CCC",
  type: "CRYPTOCURRENCY",
  zone: "UTC",
  open: 0,
  close: at(23, 59),
  always: true,
});

const ok = (body: unknown): Recorded => ({
  recordedAt: "",
  status: 200,
  headers: { "content-type": "application/json" },
  body,
});

export function sim(listings: readonly SimListing[]) {
  const bySymbol = new Map(listings.map((l) => [l.symbol, l]));

  const trades = (l: SimListing, date: string) => {
    const day = new Date(wallOfDate(date)).getUTCDay();
    return l.always === true || (day !== 0 && day !== 6);
  };

  const sessionOf = (l: SimListing, date: string) => ({
    date,
    start: fromWallTime(l.zone, wallOfDate(date) + l.open),
    end: fromWallTime(l.zone, wallOfDate(date) + l.close),
  });

  // the latest trading day whose session has begun
  const shown = (l: SimListing, now: number) => {
    for (let d = localDate(l.zone, now), n = 0; n < 10; n++) {
      if (trades(l, d)) {
        const s = sessionOf(l, d);
        if (s.start <= now) return s;
      }
      d = addDays(d, -1);
    }
    throw new Error(`no session for ${l.symbol}`);
  };

  const meta = (l: SimListing, now: number) => {
    const s = shown(l, now);
    return {
      symbol: l.symbol,
      exchangeName: l.exchange,
      instrumentType: l.type,
      currency: "USD",
      exchangeTimezoneName: l.zone,
      regularMarketPrice: 100,
      regularMarketTime: Math.floor(Math.min(now, s.end) / 1000),
      previousClose: 99,
      regularMarketDayHigh: 101,
      regularMarketDayLow: 98,
      regularMarketVolume: 1000,
      currentTradingPeriod: {
        regular: { start: s.start / 1000, end: s.end / 1000 },
      },
    };
  };

  const listing = (symbol: string) => {
    const l = bySymbol.get(symbol);
    if (l === undefined) throw new Error(`unknown symbol ${symbol}`);
    return l;
  };

  return {
    // the daily bars of the last 40 days, today's partial one included
    chart(symbol: string, now: number): Recorded {
      const l = listing(symbol);
      const today = shown(l, now);
      const stamps: number[] = [];
      for (
        let d = addDays(today.date, -40);
        d <= today.date;
        d = addDays(d, 1)
      ) {
        if (trades(l, d)) stamps.push(sessionOf(l, d).start / 1000);
      }
      const n = stamps.length;
      return ok({
        chart: {
          result: [
            {
              meta: meta(l, now),
              timestamp: stamps,
              indicators: {
                quote: [
                  {
                    open: Array(n).fill(99),
                    high: Array(n).fill(101),
                    low: Array(n).fill(98),
                    close: Array(n).fill(100),
                    volume: Array(n).fill(1000),
                  },
                ],
              },
            },
          ],
          error: null,
        },
      });
    },
    spark(symbols: readonly string[], now: number): Recorded {
      return ok({
        spark: {
          result: symbols.map((symbol) => ({
            symbol,
            response: [{ meta: meta(listing(symbol), now) }],
          })),
          error: null,
        },
      });
    },
    route(url: URL, now: number): Recorded | undefined {
      if (url.pathname === "/v7/finance/spark") {
        return this.spark(url.searchParams.get("symbols")!.split(","), now);
      }
      const prefix = "/v8/finance/chart/";
      if (url.pathname.startsWith(prefix)) {
        return this.chart(
          decodeURIComponent(url.pathname.slice(prefix.length)),
          now,
        );
      }
      return undefined;
    },
  };
}
