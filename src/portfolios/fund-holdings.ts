// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// A hand-priced fund's holdings, entered from its own reports into the
// tables Yahoo's ETF holdings use, so both read alike. The top rows and
// asset split are replaced together, sectors only when given; each part
// keeps the day it is as of.

import { readInstrument } from "../market/instruments.ts";
import {
  readTopHoldings,
  type StoredTopHoldings,
} from "../sources/yahoo/top-holdings.ts";
import type { Db } from "../storage/db/index.ts";

// Yahoo's sector keys, the ones an ETF's sectors are stored under
export const SECTOR_KEYS = [
  "basic_materials",
  "communication_services",
  "consumer_cyclical",
  "consumer_defensive",
  "energy",
  "financial_services",
  "healthcare",
  "industrials",
  "realestate",
  "technology",
  "utilities",
] as const;

export const ASSET_KEYS = [
  "stock",
  "bond",
  "cash",
  "other",
  "preferred",
  "convertible",
] as const;
export type AssetKey = (typeof ASSET_KEYS)[number];

// weights in percent, as entered; stored as Yahoo's fractions
export type HandHolding = {
  // a stored instrument's id, checked before the write
  symbol: string | null;
  name: string;
  weight: number;
};

export type HoldingsEntry = {
  asOf: string;
  top?: {
    // largest first
    rows: HandHolding[];
    assets: Partial<Record<AssetKey, number>>;
  };
  sectors?: { key: string; weight: number }[];
};

export type HoldingsDays = { asOf: string | null; sectorsAsOf: string | null };

export function holdingsDays(db: Db, id: string): HoldingsDays | null {
  return (
    db
      .query<HoldingsDays, [string]>(
        `select as_of as asOf, sectors_as_of as sectorsAsOf
         from fund_top_holdings where instrument = ?`,
      )
      .get(id) ?? null
  );
}

export type StoredFundHoldings = StoredTopHoldings & HoldingsDays;

export function readFundHoldings(
  db: Db,
  id: string,
): StoredFundHoldings | null {
  const stored = readTopHoldings(db, id);
  const days = holdingsDays(db, id);
  if (stored === null || days === null) return null;
  return {
    ...stored,
    ...days,
    // a hand row keeps the instrument's id, not a Yahoo symbol
    holdings: stored.holdings.map((h) => ({
      ...h,
      id: h.symbol === null ? null : (readInstrument(db, h.symbol)?.id ?? null),
    })),
  };
}

const fraction = (percent: number | undefined): number | null =>
  percent === undefined ? null : percent / 100;

// in the caller's write, after every check
export function writeFundHoldings(
  db: Db,
  id: string,
  entry: HoldingsEntry,
  now: number,
): void {
  db.query(
    `insert into fund_top_holdings (instrument, fetched_at)
     values (?, ?) on conflict (instrument) do update set
       fetched_at = excluded.fetched_at`,
  ).run(id, now);
  const top = entry.top;
  if (top !== undefined) {
    const a = top.assets;
    db.query(
      `update fund_top_holdings set as_of = ?, stock = ?, bond = ?, cash = ?,
         other = ?, preferred = ?, convertible = ?
       where instrument = ?`,
    ).run(
      entry.asOf,
      fraction(a.stock),
      fraction(a.bond),
      fraction(a.cash),
      fraction(a.other),
      fraction(a.preferred),
      fraction(a.convertible),
      id,
    );
    db.query("delete from fund_top_holding_rows where instrument = ?").run(id);
    const row = db.query(
      `insert into fund_top_holding_rows (instrument, rank, symbol, name, weight)
       values (?, ?, ?, ?, ?)`,
    );
    for (const [k, h] of top.rows.entries()) {
      row.run(id, k + 1, h.symbol, h.name, h.weight / 100);
    }
  }
  if (entry.sectors !== undefined) {
    db.query(
      "update fund_top_holdings set sectors_as_of = ? where instrument = ?",
    ).run(entry.asOf, id);
    db.query(
      "delete from fund_weights where instrument = ? and kind = 'sector'",
    ).run(id);
    const weight = db.query(
      `insert into fund_weights (instrument, kind, key, weight)
       values (?, 'sector', ?, ?)`,
    );
    for (const s of entry.sectors) weight.run(id, s.key, s.weight / 100);
  }
}
