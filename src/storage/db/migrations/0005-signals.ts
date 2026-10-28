// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Migration } from "../migration.ts";

// one row per final bar and at most one live row per instrument and interval;
// checks hold only what the maths guarantees, so an odd bar never fails a write
export const m0005: Migration = {
  id: "0005-signals",
  up(db) {
    db.exec(`
      create table signals (
        instrument text not null references instruments (id),
        interval text not null check (interval in ('1d', '1wk')),
        date text not null check (date glob '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
        kind text not null check (kind in ('final', 'live')),
        sma50 real,
        sma200 real,
        cross integer check (cross in (-1, 0, 1)),
        cross_edge integer check (cross_edge in (-1, 0, 1)),
        ema20 real,
        rsi14 real check (rsi14 between 0 and 100),
        macd real,
        macd_signal real,
        macd_histogram real,
        macd_turn integer check (macd_turn in (-1, 0, 1)),
        atr14 real,
        move_atr real,
        volatility20 real check (volatility20 >= 0),
        bollinger_lower real,
        high52w real,
        low52w real,
        drawdown real,
        from_low real,
        days_since_high integer check (days_since_high >= 0),
        volume_ratio real,
        ema12 real,
        ema26 real,
        rsi_gain real check (rsi_gain >= 0),
        rsi_loss real check (rsi_loss >= 0),
        prev_histogram real,
        quote_time integer,
        computed_at integer not null,
        primary key (instrument, interval, kind, date),
        check ((kind = 'live') = (quote_time is not null)),
        check ((sma50 is null or sma200 is null) = (cross is null)),
        check (interval = '1d' or (ema20 is null and rsi14 is null
          and macd is null and macd_signal is null and macd_histogram is null
          and macd_turn is null and atr14 is null and move_atr is null
          and volatility20 is null and bollinger_lower is null
          and high52w is null and low52w is null and drawdown is null
          and from_low is null and days_since_high is null
          and volume_ratio is null and ema12 is null and ema26 is null
          and rsi_gain is null and rsi_loss is null
          and prev_histogram is null))
      ) strict, without rowid;

      create unique index signals_one_live on signals (instrument, interval)
        where kind = 'live';
    `);
  },
};
