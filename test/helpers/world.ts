// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { fred } from "../../src/fred/client.ts";
import { upsertInstrument } from "../../src/instruments.ts";
import { silent } from "../../src/runtime/log.ts";
import { type Db, open } from "../../src/storage/db/index.ts";
import { writer } from "../../src/storage/writer.ts";
import { type Markets, markets } from "../../src/tools/markets.ts";
import { yahoo } from "../../src/yahoo/client.ts";
import { fakeClock } from "./clock.ts";

export const NOW = Date.parse("2026-10-23T18:00:00Z");
// the live day and the final day before it
export const LIVE = "2026-10-23";
export const FINAL = "2026-10-22";

export type Values = Record<string, number | null>;

// Instruments of a source no job syncs, so a read finds them ready and
// fetches nothing; every stored row is written here by hand.
export function world() {
  const clock = fakeClock(NOW);
  const { db } = open(":memory:", clock);
  const noNetwork = async (url: string): Promise<Response> => {
    throw new Error(`no network in tests: ${url}`);
  };
  const m: Markets = markets({
    db,
    clock,
    writer: writer(db),
    yahoo: yahoo({ clock, fetch: noNetwork }),
    fred: fred({ clock, key: "0".repeat(32), fetch: noNetwork }),
    log: silent,
  });
  return { clock, db, m };
}

export function instrument(
  db: Db,
  id: string,
  options: { currency?: string | null; unit?: string; name?: string } = {},
) {
  const [market, symbol] = id.split(":") as [string, string];
  const isFred = market === "FRED";
  upsertInstrument(
    db,
    {
      market,
      symbol,
      source: isFred ? "fred" : "other",
      sourceSymbol: symbol,
      exchange: market,
      name: options.name ?? symbol,
      type: isFred ? "SERIES" : "EQUITY",
      currency:
        options.currency === undefined
          ? isFred
            ? null
            : "USD"
          : options.currency,
      unit: (options.unit ?? (isFred ? "percent" : "per_share")) as never,
      zone: "UTC",
    },
    NOW,
  );
}

export function bar(
  db: Db,
  id: string,
  interval: "1d" | "1wk",
  date: string,
  close: number,
  final: boolean,
) {
  db.query(
    `insert into bars (instrument, interval, date, open, high, low, close,
       volume, final, fetched_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    interval,
    date,
    close,
    close,
    close,
    close,
    1000,
    final ? 1 : 0,
    NOW,
  );
}

// a signal row; sma50 and sma200 default so the cross check holds
export function row(
  db: Db,
  id: string,
  interval: "1d" | "1wk",
  date: string,
  kind: "final" | "live",
  values: Values = {},
) {
  const v: Values = { sma50: 100, sma200: 90, ...values };
  if (!("cross" in values)) {
    v.cross =
      v.sma50 == null || v.sma200 == null
        ? null
        : Math.sign(v.sma50 - v.sma200);
  }
  const cols = Object.keys(v);
  db.query(
    `insert into signals (instrument, interval, date, kind, ${cols.join(", ")},
       quote_time, computed_at)
     values (?, ?, ?, ?, ${cols.map(() => "?").join(", ")}, ?, ?)`,
  ).run(
    id,
    interval,
    date,
    kind,
    ...cols.map((c) => v[c]!),
    kind === "live" ? NOW : null,
    NOW,
  );
}

export function quote(
  db: Db,
  id: string,
  price: number,
  previousClose: number,
) {
  const change = price - previousClose;
  db.query(
    `insert into quotes (instrument, price, previous_close,
       previous_close_field, change, change_percent, day_high, day_low,
       volume, time, source, fetched_at)
     values (?, ?, ?, 'previousClose', ?, ?, null, null, null, ?, 'other', ?)`,
  ).run(
    id,
    price,
    previousClose,
    change,
    (change / previousClose) * 100,
    NOW,
    NOW,
  );
}

// A listing with a final day, a live day and its quote: the daily rows
// take the values given, the final close is previousClose.
export function listing(
  db: Db,
  id: string,
  options: {
    price?: number;
    previousClose?: number;
    live?: Values;
    final?: Values;
    currency?: string | null;
    name?: string;
  } = {},
) {
  instrument(db, id, { currency: options.currency, name: options.name });
  const prev = options.previousClose ?? 100;
  bar(db, id, "1d", FINAL, prev, true);
  row(db, id, "1d", FINAL, "final", options.final);
  bar(db, id, "1d", LIVE, options.price ?? 100, false);
  row(db, id, "1d", LIVE, "live", options.live);
  quote(db, id, options.price ?? 100, prev);
}
