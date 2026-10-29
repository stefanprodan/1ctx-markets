// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Db } from "../../storage/db/index.ts";
import type { ListKind } from "./client.ts";
import { KINDS } from "./sync.ts";

export type Listed = {
  symbol: string;
  isin: string | null;
  name: string | null;
};

// the type a listing's instrument takes when fetched
export const LIST_TYPES: Readonly<Record<ListKind, string>> = {
  shares: KINDS.Shares!.type,
  units: KINDS.Units!.type,
  bonds: KINDS.Bonds!.type,
  indices: KINDS.index!.type,
};

// a page read again replaces its kind, so a delisted symbol goes
export function storeListings(
  db: Db,
  kind: ListKind,
  rows: readonly Listed[],
  at: number,
): void {
  db.query("delete from bvb_listings where kind = ?").run(kind);
  const insert = db.query(
    `insert or replace into bvb_listings
       (kind, symbol, isin, name, type, listed_at)
     values (?, ?, ?, ?, ?, ?)`,
  );
  for (const r of rows) {
    insert.run(kind, r.symbol, r.isin, r.name, LIST_TYPES[kind], at);
  }
}

// the site's search matched symbol, name and ISIN anywhere in them; an
// exact symbol, then a symbol's start, rank first
export function findListings(
  db: Db,
  query: string,
  limit: number,
): (Listed & { type: string })[] {
  return db
    .query<Listed & { type: string }, [string, number]>(
      `select symbol, isin, name, type from bvb_listings
       where instr(upper(symbol), ?1) > 0
         or instr(upper(coalesce(name, '')), ?1) > 0
         or instr(upper(coalesce(isin, '')), ?1) > 0
       order by upper(symbol) <> ?1, instr(upper(symbol), ?1) <> 1,
         upper(symbol), kind
       limit ?2`,
    )
    .all(query.trim().toUpperCase(), limit);
}
