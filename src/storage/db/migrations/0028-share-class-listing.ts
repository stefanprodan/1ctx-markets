// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Migration } from "../migration.ts";

const SHAPE = `length(listing) between 1 and 20
  and listing not glob '*[^A-Za-z0-9.-]*'`;

// a dotless listing is another US share class of the company (GOOGL for
// GOOG): same EPS in the same currency, so its per-share figures are kept;
// a dotted one (an ADR's home, 2330.TW) still holds none. No table points
// at research or events, so both are rebuilt inside the transaction.
export const m0028: Migration = {
  id: "0028-share-class-listing",
  up(db) {
    db.exec(`
      create table research_next (
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
        listing text check (listing is null
          or (${SHAPE} and kind <> 'insider'
            and (instr(listing, '.') = 0
              or (kind in ('analysts', 'metric')
                and forward_pe is null and forward_peg is null
                and pe_ttm is null and ps_ttm is null and pb is null
                and dividend_yield_ttm is null and beta is null)))),
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

      insert into research_next (instrument, kind, period, strong_buy, buy,
        hold, sell, strong_sell, eps_estimate, eps_actual, surprise,
        surprise_percent, insider_change, mspr, forward_pe, forward_peg,
        pe_ttm, ps_ttm, pb, eps_growth_ttm_yoy, revenue_growth_ttm_yoy,
        net_margin_ttm, roe_ttm, current_ratio_quarterly,
        debt_to_equity_quarterly, dividend_yield_ttm, beta, fetched_at,
        listing)
      select instrument, kind, period, strong_buy, buy, hold, sell,
        strong_sell, eps_estimate, eps_actual, surprise, surprise_percent,
        insider_change, mspr, forward_pe, forward_peg, pe_ttm, ps_ttm, pb,
        eps_growth_ttm_yoy, revenue_growth_ttm_yoy, net_margin_ttm, roe_ttm,
        current_ratio_quarterly, debt_to_equity_quarterly,
        dividend_yield_ttm, beta, fetched_at, listing
      from research;

      drop table research;
      alter table research_next rename to research;
      create unique index research_one_metric on research (instrument)
        where kind = 'metric';

      create table events_next (
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
        listing text check (listing is null
          or (${SHAPE} and (instr(listing, '.') = 0
            or (eps_estimate is null and eps_actual is null
              and revenue_estimate is null and revenue_actual is null)))),
        primary key (instrument, fiscal_year, fiscal_quarter),
        check ((eps_actual is null and revenue_actual is null)
          or reported_seen_at is not null)
      ) strict, without rowid;

      insert into events_next (instrument, fiscal_year, fiscal_quarter, date,
        hour, eps_estimate, eps_actual, revenue_estimate, revenue_actual,
        reported_seen_at, fetched_at, listing)
      select instrument, fiscal_year, fiscal_quarter, date, hour,
        eps_estimate, eps_actual, revenue_estimate, revenue_actual,
        reported_seen_at, fetched_at, listing
      from events;

      drop table events;
      alter table events_next rename to events;
      create index events_by_date on events (date);
    `);
  },
};
