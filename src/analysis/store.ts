// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// A symbol's analysis, shared by everyone; each revision keeps the stored
// quote, so a read measures the move since without a fetch.

import type { Revision } from "../document/read.ts";
import {
  type Kind,
  type RevisionInfo,
  type Save,
  type Saved,
  saveIn,
} from "../document/store.ts";
import { readInstrument } from "../market/instruments.ts";
import { readQuote } from "../market/quotes.ts";
import type { Failure } from "../operations/answer.ts";
import type { Who } from "../operations/who.ts";
import { seenWhere } from "../portfolios/funds.ts";
import { recheck } from "../server/caller.ts";
import { FUND_MARKET } from "../sources/ids.ts";
import type { Db } from "../storage/db/index.ts";
import type { Writer } from "../storage/writer.ts";
import { analysisRead } from "./read.ts";

export type Note = Revision & {
  symbol: string;
  // the stored quote at the save; null when there was none
  price: number | null;
  currency: string | null;
  pricedAt: number | null;
};

export type Listed = RevisionInfo & { symbol: string };

type Raw = {
  symbol: string;
  revision: number;
  text: string;
  bytes: number;
  author: string;
  price: number | null;
  currency: string | null;
  priced_at: number | null;
  created_at: number;
};

const COLUMNS =
  "symbol, revision, text, bytes, author, price, currency, priced_at, created_at";

const noteOf = (raw: Raw): Note => ({
  symbol: raw.symbol,
  revision: raw.revision,
  text: raw.text,
  bytes: raw.bytes,
  author: raw.author,
  price: raw.price,
  currency: raw.currency,
  pricedAt: raw.priced_at,
  createdAt: raw.created_at,
});

type ListedRaw = Pick<
  Raw,
  "symbol" | "revision" | "bytes" | "author" | "created_at"
>;

const listedOf = (raw: ListedRaw): Listed => ({
  symbol: raw.symbol,
  revision: raw.revision,
  bytes: raw.bytes,
  author: raw.author,
  createdAt: raw.created_at,
});

export function readAnalysis(db: Db, symbol: string): Note | null {
  const raw = db
    .query<Raw, [string]>(
      `select ${COLUMNS} from analysis_versions where symbol = ?
       order by revision desc limit 1`,
    )
    .get(symbol);
  return raw === null ? null : noteOf(raw);
}

// newest first
export const analysisVersions = (db: Db, symbol: string): Listed[] =>
  db
    .query<ListedRaw, [string]>(
      `select symbol, revision, bytes, author, created_at
       from analysis_versions where symbol = ? order by revision desc`,
    )
    .all(symbol)
    .map(listedOf);

export function analysisVersion(
  db: Db,
  symbol: string,
  revision: number,
): Note | null {
  const raw = db
    .query<Raw, [string, number]>(
      `select ${COLUMNS} from analysis_versions
       where symbol = ? and revision = ?`,
    )
    .get(symbol, revision);
  return raw === null ? null : noteOf(raw);
}

export function analysisPointer(
  db: Db,
  symbol: string,
): { revision: number; createdAt: number } | null {
  return db
    .query<{ revision: number; createdAt: number }, [string]>(
      `select revision, created_at as createdAt from analysis_versions
       where symbol = ? order by revision desc limit 1`,
    )
    .get(symbol);
}

export type ListAt = { createdAt: number; symbol: string };

const FUND_PREFIX = `${FUND_MARKET}:`;

// funds filtered before the limit, so no page or cursor names a hidden one
export const analysisList = (
  db: Db,
  viewer: { user: string; funds: boolean },
  at: ListAt | null,
  limit: number,
): Listed[] =>
  db
    .query<ListedRaw, [string, number, number | null, string, number]>(
      `select symbol, revision, bytes, author, created_at from (
         select symbol, max(revision) as revision, bytes, author, created_at
         from analysis_versions group by symbol)
       where (substr(symbol, 1, ${FUND_PREFIX.length}) <> '${FUND_PREFIX}'
           or (?2 and ${seenWhere("symbol")}))
         and (?3 is null or created_at < ?3
           or (created_at = ?3 and symbol > ?4))
       order by created_at desc, symbol limit ?5`,
    )
    .all(
      viewer.user,
      viewer.funds ? 1 : 0,
      at?.createdAt ?? null,
      at?.symbol ?? "",
      limit,
    )
    .map(listedOf);

// room for the read's since_written line; events are kept two years
export const SINCE_RESERVE = 2048;

const ANALYSIS = (symbol: string): Kind => ({
  noun: "analysis",
  notHere:
    "an analysis holds the symbol's trend, earnings, news, valuation and risks; holdings, quantities, cost, gains and the owner's profile never belong in it",
  read: (r) => analysisRead(symbol, r),
  reserve: SINCE_RESERVE,
});

// the person and the key, so a shared note says whose agent wrote it
function authorOf(db: Db, who: Who): string {
  if (who.credential.kind !== "key") return who.name;
  const person = db
    .query<{ name: string }, [string]>("select name from users where id = ?")
    .get(who.user)?.name;
  return person === undefined ? who.name : `${person} (${who.name})`;
}

export function saveAnalysis(
  writer: Writer,
  symbol: string,
  save: Save,
  who: Who,
  now: number,
): Promise<Saved | Failure> {
  return writer.write((db): Saved | Failure => {
    recheck(db);
    // the stored quote only: a write never fetches
    const q = readQuote(db, symbol);
    const currency = readInstrument(db, symbol)?.currency ?? null;
    return saveIn(
      db,
      ANALYSIS(symbol),
      {
        table: "analysis_versions",
        column: "symbol",
        value: symbol,
        live: (db) => readAnalysis(db, symbol),
        insert: (db, next) => {
          db.query(
            `insert into analysis_versions (symbol, revision, text, bytes,
               author, user_id, price, currency, priced_at, created_at)
             values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ).run(
            symbol,
            next.revision,
            next.text,
            next.bytes,
            next.author,
            who.user,
            q?.price ?? null,
            q === null ? null : currency,
            q?.fetchedAt ?? null,
            next.createdAt,
          );
        },
      },
      save,
      authorOf(db, who),
      now,
    );
  });
}
