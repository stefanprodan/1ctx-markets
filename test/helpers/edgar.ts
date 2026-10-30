// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { join } from "node:path";
import {
  type InstrumentFields,
  upsertInstrument,
} from "../../src/market/instruments.ts";
import type { Db } from "../../src/storage/db/index.ts";
import type { Recorded } from "./yahoo.ts";

const DIR = join(import.meta.dir, "..", "fixtures", "edgar");

// made up, in the shape SEC asks for; no real contact is ever read by a test
export const EDGAR_CONTACT = "Test Operator test-operator@example.invalid";

// the recordings were made at 23:57 UTC on Thursday 29 October
export const RECORDED = Date.parse("2026-10-29T23:58:00Z");

export const CIKS: Record<string, number> = {
  AAPL: 320193,
  NVDA: 1045810,
  JPM: 19617,
  TSM: 1046179,
  SURG: 1392694,
  OPTU: 1702780,
};

export const edgarFixture = (name: string): Promise<Recorded> =>
  Bun.file(join(DIR, `${name}.json`)).json();

// the answer for an SEC URL, or undefined for another host
export async function edgarAnswer(url: URL): Promise<Recorded | undefined> {
  if (
    url.hostname === "www.sec.gov" &&
    url.pathname === "/files/company_tickers.json"
  ) {
    return edgarFixture("company-tickers");
  }
  if (url.hostname !== "data.sec.gov") return undefined;
  const m = /^\/submissions\/CIK(\d{10})\.json$/.exec(url.pathname);
  const cik = m === null ? null : Number(m[1]);
  const name = Object.entries(CIKS).find(([, c]) => c === cik)?.[0];
  return edgarFixture(
    name === undefined
      ? "submissions-unknown"
      : `submissions-${name.toLowerCase()}`,
  );
}

// a US share of a source no job syncs, so a read takes it as stored
export function share(
  db: Db,
  symbol: string,
  now: number,
  fields: Partial<InstrumentFields> = {},
) {
  return upsertInstrument(
    db,
    {
      market: "US",
      symbol,
      source: "other",
      sourceSymbol: symbol,
      exchange: "NMS",
      name: symbol,
      type: "EQUITY",
      currency: "USD",
      unit: "per_share",
      zone: "America/New_York",
      ...fields,
    },
    now,
  );
}
