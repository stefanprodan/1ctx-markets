// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Instruments keyed market:symbol; the source's own symbol is a column,
// so the identity holds when the source changes.

import type { Db } from "./db/index.ts";

export type Instrument = {
  id: string;
  market: string;
  symbol: string;
  source: string;
  sourceSymbol: string;
  exchange: string;
  name: string | null;
  type: string;
  currency: string | null;
  zone: string;
  addedAt: number;
  updatedAt: number;
};

export type InstrumentFields = Omit<Instrument, "id" | "addedAt" | "updatedAt">;

const SELECT = `select id, market, symbol, source,
  source_symbol as sourceSymbol, exchange, name, type, currency, zone,
  added_at as addedAt, updated_at as updatedAt from instruments`;

export function readInstrument(db: Db, id: string): Instrument | null {
  return (
    db.query<Instrument, [string]>(`${SELECT} where id = ?`).get(id) ?? null
  );
}

export function readBySourceSymbol(
  db: Db,
  source: string,
  sourceSymbol: string,
): Instrument | null {
  return (
    db
      .query<Instrument, [string, string]>(
        `${SELECT} where source = ? and source_symbol = ?`,
      )
      .get(source, sourceSymbol) ?? null
  );
}

export function readInstruments(db: Db): Instrument[] {
  return db.query<Instrument, []>(`${SELECT} order by id`).all();
}

// the source's latest answer refreshes the name, type, currency and zone
export function upsertInstrument(
  db: Db,
  fields: InstrumentFields,
  now: number,
): Instrument {
  const id = `${fields.market}:${fields.symbol}`;
  db.query(
    `insert into instruments (id, market, symbol, source, source_symbol,
       exchange, name, type, currency, zone, added_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     on conflict (id) do update set
       source = excluded.source,
       source_symbol = excluded.source_symbol,
       exchange = excluded.exchange,
       name = coalesce(excluded.name, instruments.name),
       type = excluded.type,
       currency = coalesce(excluded.currency, instruments.currency),
       zone = excluded.zone,
       updated_at = excluded.updated_at`,
  ).run(
    id,
    fields.market,
    fields.symbol,
    fields.source,
    fields.sourceSymbol,
    fields.exchange,
    fields.name,
    fields.type,
    fields.currency,
    fields.zone,
    now,
    now,
  );
  return readInstrument(db, id)!;
}
