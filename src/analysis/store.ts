// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// A symbol's analysis, shared by everyone; each revision keeps the stored
// quote, so a read measures the move since without a fetch.

import type { Revision } from "../document/read.ts";
import {
  authorOf,
  type Kind,
  type RevisionInfo,
  type Save,
  saveIn,
  type Words,
} from "../document/store.ts";
import { readInstrument } from "../market/instruments.ts";
import { readQuote } from "../market/quotes.ts";
import type { Failure } from "../operations/answer.ts";
import type { Who } from "../operations/who.ts";
import { isFundKey, seenWhere } from "../portfolios/funds.ts";
import { recheck } from "../server/caller.ts";
import { FUND_MARKET } from "../sources/ids.ts";
import type { Db } from "../storage/db/index.ts";
import type { Writer } from "../storage/writer.ts";
import { analysisRead } from "./read.ts";

// user is the writer's users.id, null once that person is removed
export type Note = Revision & {
  symbol: string;
  user: string | null;
  // the stored quote at the save; null when there was none
  price: number | null;
  currency: string | null;
  pricedAt: number | null;
};

export type Listed = RevisionInfo & { symbol: string; user: string | null };

export type AnalysisSaved = {
  saved: RevisionInfo & { user: string | null };
  unchanged: boolean;
};

type Raw = {
  symbol: string;
  revision: number;
  text: string;
  bytes: number;
  author: string;
  user_id: string | null;
  price: number | null;
  currency: string | null;
  priced_at: number | null;
  created_at: number;
};

const COLUMNS =
  "symbol, revision, text, bytes, author, user_id, price, currency, priced_at, created_at";

const noteOf = (raw: Raw): Note => ({
  symbol: raw.symbol,
  revision: raw.revision,
  text: raw.text,
  bytes: raw.bytes,
  author: raw.author,
  user: raw.user_id,
  price: raw.price,
  currency: raw.currency,
  pricedAt: raw.priced_at,
  createdAt: raw.created_at,
});

type ListedRaw = Pick<
  Raw,
  "symbol" | "revision" | "bytes" | "author" | "user_id" | "created_at"
>;

const listedOf = (raw: ListedRaw): Listed => ({
  symbol: raw.symbol,
  revision: raw.revision,
  bytes: raw.bytes,
  author: raw.author,
  user: raw.user_id,
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

// newest first; the writer is read for a fund only, whose author is
// shown to that writer alone, so a share's revisions stay on the index
export const analysisVersions = (db: Db, symbol: string): Listed[] =>
  db
    .query<ListedRaw, [string]>(
      `select symbol, revision, bytes, author,
         ${isFundKey(symbol) ? "user_id" : "null as user_id"}, created_at
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
const FUND_ONLY = `(substr(symbol, 1, ${FUND_PREFIX.length}) = '${FUND_PREFIX}')`;

// funds filtered before the limit, so no page or cursor names a hidden one
export const analysisList = (
  db: Db,
  viewer: { user: string; funds: boolean },
  at: ListAt | null,
  limit: number,
): Listed[] =>
  db
    .query<ListedRaw, [string, number, number | null, string, number]>(
      `select symbol, revision, bytes, author, created_at,
         case when ${FUND_ONLY} then (select v.user_id from analysis_versions v
           where v.symbol = x.symbol and v.revision = x.revision) end
           as user_id
       from (
         select symbol, max(revision) as revision, bytes, author, created_at
         from analysis_versions group by symbol) x
       where (not ${FUND_ONLY}
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

export const ANALYSIS_WORDS: Words = {
  noun: "analysis",
  notHere:
    "an analysis holds the symbol's trend, earnings, news, valuation and risks; holdings, quantities, cost, gains and the owner's profile never belong in it",
};

const ANALYSIS = (symbol: string): Kind => ({
  ...ANALYSIS_WORDS,
  read: (r) => analysisRead(symbol, r),
  reserve: SINCE_RESERVE,
});

export function saveAnalysis(
  writer: Writer,
  symbol: string,
  save: Save,
  who: Who,
  now: number,
): Promise<AnalysisSaved | Failure> {
  return writer.write((db): AnalysisSaved | Failure => {
    recheck(db);
    // the stored quote only: a write never fetches
    const q = readQuote(db, symbol);
    const currency = readInstrument(db, symbol)?.currency ?? null;
    const done = saveIn(
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
            // the trade's time says which side of a split the price is on
            q === null ? null : (q.time ?? q.fetchedAt),
            next.createdAt,
          );
        },
      },
      save,
      authorOf(db, who),
      now,
    );
    if ("error" in done) return done;
    // an unchanged save answers the live revision, which another may own
    const user = done.unchanged ? readAnalysis(db, symbol)!.user : who.user;
    return { ...done, saved: { ...done.saved, user } };
  });
}
