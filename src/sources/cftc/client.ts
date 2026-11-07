// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// keyless: nothing to scrub, and only checked codes, names, dates and
// whole numbers of an answer are kept

import { wallOfDate } from "../../market/zone.ts";
import type { Clock } from "../../runtime/clock.ts";
import { CFTC } from "../ids.ts";
import {
  type Backoff,
  type Fetch,
  limiter,
  type RunOptions,
  SourceError,
  Unreadable,
} from "../source.ts";

export const SOURCE = CFTC;
export const HOST = "https://publicreporting.cftc.gov";
// no limit is published for calls without an app token; this keeps a
// burst polite, and sits on a read's path
export const SPACING_MS = 500;
const TIMEOUT_MS = 30_000;
// a grouped list answers a few hundred markets; one filling it may be cut
export const LIST_LIMIT = 2000;

// futures only: every market is in exactly one of the two
export const REPORTS = ["disaggregated", "financial"] as const;
export type Report = (typeof REPORTS)[number];
export const DATASETS: Record<Report, string> = {
  disaggregated: "72hh-3qpy",
  financial: "gpe5-46if",
};

export const CODE = /^[0-9A-Z+]{6}$/;

type Columns = {
  long: string;
  short: string;
  spread: string | null;
  tradersLong: string | null;
  tradersShort: string | null;
};

// the datasets' own names, irregular as they are: a missing _all, a
// doubled underscore
const OTHER: Columns = {
  long: "other_rept_positions_long",
  short: "other_rept_positions_short",
  spread: "other_rept_positions_spread",
  tradersLong: "traders_other_rept_long_all",
  tradersShort: "traders_other_rept_short",
};
const NON_REPORTABLE: Columns = {
  long: "nonrept_positions_long_all",
  short: "nonrept_positions_short_all",
  spread: null,
  tradersLong: null,
  tradersShort: null,
};

export const FIELDS: Record<Report, Record<string, Columns>> = {
  disaggregated: {
    producer_merchant: {
      long: "prod_merc_positions_long",
      short: "prod_merc_positions_short",
      spread: null,
      tradersLong: "traders_prod_merc_long_all",
      tradersShort: "traders_prod_merc_short_all",
    },
    swap_dealer: {
      long: "swap_positions_long_all",
      short: "swap__positions_short_all",
      spread: "swap__positions_spread_all",
      tradersLong: "traders_swap_long_all",
      tradersShort: "traders_swap_short_all",
    },
    managed_money: {
      long: "m_money_positions_long_all",
      short: "m_money_positions_short_all",
      spread: "m_money_positions_spread",
      tradersLong: "traders_m_money_long_all",
      tradersShort: "traders_m_money_short_all",
    },
    other_reportable: OTHER,
    non_reportable: NON_REPORTABLE,
  },
  financial: {
    dealer: {
      long: "dealer_positions_long_all",
      short: "dealer_positions_short_all",
      spread: "dealer_positions_spread_all",
      tradersLong: "traders_dealer_long_all",
      tradersShort: "traders_dealer_short_all",
    },
    asset_manager: {
      long: "asset_mgr_positions_long",
      short: "asset_mgr_positions_short",
      spread: "asset_mgr_positions_spread",
      tradersLong: "traders_asset_mgr_long_all",
      tradersShort: "traders_asset_mgr_short_all",
    },
    leveraged_funds: {
      long: "lev_money_positions_long",
      short: "lev_money_positions_short",
      spread: "lev_money_positions_spread",
      tradersLong: "traders_lev_money_long_all",
      tradersShort: "traders_lev_money_short_all",
    },
    other_reportable: OTHER,
    non_reportable: NON_REPORTABLE,
  },
};

const DATE_COLUMN = "report_date_as_yyyy_mm_dd";
const CODE_COLUMN = "cftc_contract_market_code";
const OI_COLUMN = "open_interest_all";

// the field map's columns only: a whole row is eight times the bytes
export const columns = (report: Report): string[] => [
  DATE_COLUMN,
  CODE_COLUMN,
  OI_COLUMN,
  ...Object.values(FIELDS[report]).flatMap((c) =>
    [c.long, c.short, c.spread, c.tradersLong, c.tradersShort].filter(
      (v): v is string => v !== null,
    ),
  ),
];

export type Market = {
  code: string;
  // the CFTC's own, market and exchange: "GOLD - COMMODITY EXCHANGE INC."
  name: string;
  // the market's newest report date in the list's span
  latest: string;
};

export type Markets = { report: Report; markets: Market[]; fetchedAt: number };

export type Group = {
  long: number;
  short: number;
  spread: number | null;
  tradersLong: number | null;
  tradersShort: number | null;
};

export type Week = {
  // the Tuesday the positions are as of
  date: string;
  openInterest: number;
  groups: Record<string, Group>;
};

// newest first
export type Weeks = {
  code: string;
  report: Report;
  weeks: Week[];
  fetchedAt: number;
};

export type Cftc = {
  // every market with a report since that date
  markets(report: Report, since: string): Promise<Markets>;
  // its newest weeks, at most limit
  weeks(report: Report, code: string, limit: number): Promise<Weeks>;
  failFast(): Cftc;
  within(live: () => boolean): Cftc;
  close(): void;
  due(): number | null;
  backoff(): Backoff | null;
};

export type CftcOptions = { clock: Clock; fetch?: Fetch; host?: string };

const malformed = (detail: string) =>
  new SourceError("malformed answer", detail);

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj =>
  typeof v === "object" && v !== null && !Array.isArray(v);

// Socrata writes a date as a floating timestamp at midnight
const STAMP = /^(\d{4}-\d{2}-\d{2})T00:00:00\.000$/;

function reportDate(v: unknown): string {
  const m = typeof v === "string" ? STAMP.exec(v) : null;
  if (m === null) throw malformed("report date");
  try {
    wallOfDate(m[1]!);
  } catch {
    throw malformed("report date");
  }
  return m[1]!;
}

// Socrata answers numbers as text; Number() would read "" as 0
function count(v: unknown, what: string): number {
  if (typeof v !== "string" || !/^\d{1,15}$/.test(v)) throw malformed(what);
  return Number(v);
}

export function marketCode(v: unknown): string {
  const code = typeof v === "string" ? v.trim().toUpperCase() : "";
  if (!CODE.test(code)) throw malformed("market code");
  return code;
}

export function parseMarkets(body: unknown, limit: number): Market[] {
  if (!Array.isArray(body)) throw malformed("no markets");
  if (body.length >= limit) throw malformed("a list cut short");
  const seen = new Set<string>();
  const out: Market[] = [];
  for (const entry of body) {
    if (!isObj(entry)) throw malformed("no market");
    const code = marketCode(entry[CODE_COLUMN]);
    if (seen.has(code)) throw malformed("a market listed twice");
    seen.add(code);
    const name = entry.name;
    if (typeof name !== "string" || name.trim() === "") {
      throw malformed("no market name");
    }
    out.push({ code, name: name.trim(), latest: reportDate(entry.latest) });
  }
  if (out.length === 0) throw malformed("no markets");
  return out.sort((a, b) => a.code.localeCompare(b.code));
}

export function parseWeeks(
  body: unknown,
  report: Report,
  code: string,
): Week[] {
  if (!Array.isArray(body)) throw malformed("no weeks");
  const fields = Object.entries(FIELDS[report]);
  const seen = new Set<string>();
  const weeks: Week[] = [];
  for (const entry of body) {
    if (!isObj(entry)) throw malformed("no week");
    if (entry[CODE_COLUMN] !== code) throw malformed("another market's week");
    const date = reportDate(entry[DATE_COLUMN]);
    if (seen.has(date)) throw malformed("a week answered twice");
    seen.add(date);
    const groups: Record<string, Group> = {};
    for (const [group, c] of fields) {
      const optional = (column: string | null) =>
        column === null ? null : count(entry[column], column);
      groups[group] = {
        long: count(entry[c.long], c.long),
        short: count(entry[c.short], c.short),
        spread: optional(c.spread),
        tradersLong: optional(c.tradersLong),
        tradersShort: optional(c.tradersShort),
      };
    }
    weeks.push({
      date,
      openInterest: count(entry[OI_COLUMN], OI_COLUMN),
      groups,
    });
  }
  return weeks.sort((a, b) => b.date.localeCompare(a.date));
}

const quoted = (v: string) => `'${v.replaceAll("'", "''")}'`;

export function marketsQuery(since: string): Record<string, string> {
  return {
    $select: `${CODE_COLUMN},max(market_and_exchange_names) as name,max(${DATE_COLUMN}) as latest`,
    $where: `${DATE_COLUMN} >= ${quoted(`${since}T00:00:00.000`)}`,
    $group: CODE_COLUMN,
    $limit: String(LIST_LIMIT),
  };
}

export function weeksQuery(
  report: Report,
  code: string,
  limit: number,
): Record<string, string> {
  return {
    $select: columns(report).join(","),
    $where: `${CODE_COLUMN} = ${quoted(code)}`,
    $order: `${DATE_COLUMN} DESC`,
    $limit: String(limit),
  };
}

export function cftc(options: CftcOptions): Cftc {
  const { clock } = options;
  const host = options.host ?? HOST;
  const doFetch: Fetch = options.fetch ?? ((url, init) => fetch(url, init));
  const calls = limiter(clock, SPACING_MS);

  const get = <T>(
    report: Report,
    query: Record<string, string>,
    run: RunOptions,
    parse: (body: unknown, fetchedAt: number) => T,
  ): Promise<T> =>
    calls.run(async () => {
      const abort = new AbortController();
      let timedOut = false;
      const cancel = clock.at(clock.now() + TIMEOUT_MS, () => {
        timedOut = true;
        abort.abort();
      });
      try {
        let res: Response;
        let raw: string;
        try {
          res = await doFetch(
            `${host}/resource/${DATASETS[report]}.json?${new URLSearchParams(query)}`,
            { headers: { Accept: "application/json" }, signal: abort.signal },
          );
          raw = await res.text();
        } catch {
          throw new SourceError(timedOut ? "timed out" : "network error");
        }
        const fetchedAt = clock.now();
        if (res.status === 429) throw new SourceError("rate limited");
        if (res.status === 404) throw new SourceError("not found");
        if (res.status === 400) throw new SourceError("bad request");
        if (!res.ok) {
          throw new SourceError("source error", `HTTP ${res.status}`);
        }
        let body: unknown;
        try {
          body = JSON.parse(raw);
        } catch {
          throw new Unreadable();
        }
        return parse(body, fetchedAt);
      } finally {
        cancel();
      }
    }, run);

  const client = (run: RunOptions): Cftc => ({
    markets: (report, since) =>
      get(report, marketsQuery(since), run, (body, fetchedAt) => ({
        report,
        markets: parseMarkets(body, LIST_LIMIT),
        fetchedAt,
      })),
    weeks: (report, code, limit) =>
      get(report, weeksQuery(report, code, limit), run, (body, fetchedAt) => ({
        code,
        report,
        weeks: parseWeeks(body, report, code),
        fetchedAt,
      })),
    failFast: () => client({ failFast: true }),
    within: (live) => client({ failFast: true, live }),
    close: () => calls.close(),
    due: () => calls.due(),
    backoff: () => calls.backoff(),
  });
  return client({});
}
