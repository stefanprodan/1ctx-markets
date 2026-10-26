// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Instruments keyed market:symbol; the source's own symbol is a column,
// so the identity holds when the source changes.

import type { Db } from "./db/index.ts";
import { SourceError } from "./source.ts";

// what a price means; unknown rather than a guess, since Yahoo's INDEX
// covers both ^VIX's points and ^TNX's percent
export const UNITS = [
  "per_share",
  "percent_of_par",
  "index_points",
  "percent",
  "per_unit",
  "unknown",
] as const;

export type Unit = (typeof UNITS)[number];

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
  unit: Unit;
  zone: string;
  addedAt: number;
  updatedAt: number;
};

export type InstrumentFields = Omit<Instrument, "id" | "addedAt" | "updatedAt">;

const SELECT = `select id, market, symbol, source,
  source_symbol as sourceSymbol, exchange, name, type, currency, unit, zone,
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

// a source switch moved the instrument while work from its old source ran
export class Moved extends SourceError {
  constructor(id: string) {
    super("source error", `${id} moved to another source`);
  }
}

// read again under the instrument's lock and in each write, so work begun
// before a switch never writes into the instrument it moved
export function checkSource(
  db: Db,
  instrument: Pick<Instrument, "id" | "source" | "sourceSymbol">,
): void {
  const now = readInstrument(db, instrument.id);
  if (
    now === null ||
    now.source !== instrument.source ||
    now.sourceSymbol !== instrument.sourceSymbol
  ) {
    throw new Moved(instrument.id);
  }
}

// a key stored from another source is the switch's to move, never a fetch's
export function checkOwner(db: Db, id: string, source: string): void {
  const stored = readInstrument(db, id);
  if (stored !== null && stored.source !== source) throw new Moved(id);
}

export function readInstruments(db: Db): Instrument[] {
  return db.query<Instrument, []>(`${SELECT} order by id`).all();
}

// a source symbol under another key moved market; a migration re-keys it
export function upsertInstrument(
  db: Db,
  fields: InstrumentFields,
  now: number,
): Instrument {
  const id = `${fields.market}:${fields.symbol}`;
  const other = readBySourceSymbol(db, fields.source, fields.sourceSymbol);
  if (other !== null && other.id !== id) {
    throw new SourceError(
      "malformed answer",
      `${fields.sourceSymbol} is stored as ${other.id}, answered as ${id}`,
    );
  }
  db.query(
    `insert into instruments (id, market, symbol, source, source_symbol,
       exchange, name, type, currency, unit, zone, added_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     on conflict (id) do update set
       source = excluded.source,
       source_symbol = excluded.source_symbol,
       exchange = excluded.exchange,
       name = coalesce(excluded.name, instruments.name),
       type = excluded.type,
       currency = coalesce(excluded.currency, instruments.currency),
       unit = excluded.unit,
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
    fields.unit,
    fields.zone,
    now,
    now,
  );
  return readInstrument(db, id)!;
}
