// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Migration } from "../migration.ts";

// earnings events keyed by fiscal quarter, so a moved date updates the event;
// reported_seen_at is when actuals were first seen, never cleared
export const m0007: Migration = {
  id: "0007-research",
  up(db) {
    db.exec(`
      create table research (
        instrument text not null references instruments (id),
        kind text not null check (kind in ('analysts', 'earnings', 'insider', 'metric')),
        period text not null check (period glob '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
        strong_buy integer check (strong_buy >= 0),
        buy integer check (buy >= 0),
        hold integer check (hold >= 0),
        sell integer check (sell >= 0),
        strong_sell integer check (strong_sell >= 0),
        eps_estimate real,
        eps_actual real,
        surprise real,
        surprise_percent real,
        insider_change real,
        mspr real,
        forward_pe real,
        forward_peg real,
        pe_ttm real,
        ps_ttm real,
        pb real,
        eps_growth_ttm_yoy real,
        revenue_growth_ttm_yoy real,
        net_margin_ttm real,
        roe_ttm real,
        current_ratio_quarterly real,
        debt_to_equity_quarterly real,
        dividend_yield_ttm real,
        beta real,
        fetched_at integer not null,
        primary key (instrument, kind, period),
        check (kind = 'analysts' or (strong_buy is null and buy is null
          and hold is null and sell is null and strong_sell is null)),
        check (kind = 'earnings' or (eps_estimate is null
          and eps_actual is null and surprise is null
          and surprise_percent is null)),
        check (kind = 'insider' or (insider_change is null and mspr is null)),
        check (kind = 'metric' or (forward_pe is null and forward_peg is null
          and pe_ttm is null and ps_ttm is null and pb is null
          and eps_growth_ttm_yoy is null and revenue_growth_ttm_yoy is null
          and net_margin_ttm is null and roe_ttm is null
          and current_ratio_quarterly is null
          and debt_to_equity_quarterly is null
          and dividend_yield_ttm is null and beta is null))
      ) strict, without rowid;

      create unique index research_one_metric on research (instrument)
        where kind = 'metric';

      create table events (
        instrument text not null references instruments (id),
        fiscal_year integer not null check (fiscal_year between 1900 and 2200),
        fiscal_quarter integer not null check (fiscal_quarter between 1 and 4),
        date text not null check (date glob '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
        hour text not null check (length(hour) <= 8),
        eps_estimate real,
        eps_actual real,
        revenue_estimate real,
        revenue_actual real,
        reported_seen_at integer,
        fetched_at integer not null,
        primary key (instrument, fiscal_year, fiscal_quarter),
        check ((eps_actual is null and revenue_actual is null)
          or reported_seen_at is not null)
      ) strict, without rowid;

      create index events_by_date on events (date);
    `);
  },
};
