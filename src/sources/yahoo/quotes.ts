// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { recordSession, type Session } from "../../market/calendars.ts";
import { readBySourceSymbol } from "../../market/instruments.ts";
import { storeIntraday } from "../../market/intraday.ts";
import { type QuoteRow, upsertQuote } from "../../market/quotes.ts";
import { NO_RULES, type RuleHooks } from "../../rules/hooks.ts";
import { pruneLive, refreshLive } from "../../signals/store.ts";
import type { Db } from "../../storage/db/index.ts";
import {
  type ChartMeta,
  SOURCE,
  type SparkAnswer,
  type SparkQuote,
} from "./client.ts";
import { keyOf, marketOf } from "./resolve.ts";

// The day change is worked out from price and previous close, never
// Yahoo's own change field, which disagreed with both for SOL-USD.
export function quoteOf(
  instrument: string,
  meta: ChartMeta,
  fetchedAt: number,
): QuoteRow {
  const field =
    meta.previousClose !== null
      ? "previousClose"
      : meta.chartPreviousClose !== null
        ? "chartPreviousClose"
        : null;
  const previousClose = meta.previousClose ?? meta.chartPreviousClose;
  const change = previousClose === null ? null : meta.price - previousClose;
  return {
    instrument,
    price: meta.price,
    previousClose,
    previousCloseField: field,
    change,
    changePercent:
      change === null || previousClose === 0
        ? null
        : (change / previousClose!) * 100,
    dayHigh: meta.dayHigh,
    dayLow: meta.dayLow,
    volume: meta.volume === null ? null : Math.round(meta.volume),
    time: meta.time,
    source: SOURCE,
    fetchedAt,
  };
}

// A symbol can move listing on Yahoo's side; an answer naming another
// key than the stored one is that other listing's price, never ours.
export function refuseForeign(db: Db, answer: SparkAnswer): SparkAnswer {
  const quotes: SparkQuote[] = [];
  const skipped = [...answer.skipped];
  for (const meta of answer.quotes) {
    const instrument = readBySourceSymbol(db, SOURCE, meta.symbol);
    if (
      instrument !== null &&
      keyOf(meta.exchange, meta.symbol) !== instrument.id
    ) {
      skipped.push({ symbol: meta.symbol, phrase: "malformed answer" });
    } else quotes.push(meta);
  }
  return { ...answer, quotes, skipped };
}

// sessions are recorded before quotes, so live rows never depend on order
export function storeQuotes(
  db: Db,
  checked: SparkAnswer,
  rules: RuleHooks = NO_RULES,
  now: number = checked.fetchedAt,
): QuoteRow[] {
  const answer = refuseForeign(db, checked);
  const written: QuoteRow[] = [];
  // one session per market and answer, the latest its listings show,
  // since before the open some still show the previous day's
  const sessions = new Map<string, Session>();
  for (const meta of answer.quotes) {
    const market = marketOf(meta.exchange);
    const seen = sessions.get(market);
    if (seen === undefined || meta.session.start > seen.start) {
      sessions.set(market, meta.session);
    }
  }
  for (const [market, s] of sessions) {
    recordSession(db, market, s, answer.fetchedAt);
  }
  const markets = new Set(sessions.keys());
  const moved = new Set<string>();
  for (const meta of answer.quotes) {
    const instrument = readBySourceSymbol(db, SOURCE, meta.symbol);
    if (instrument === null) continue;
    const q = quoteOf(instrument.id, meta, answer.fetchedAt);
    // the points go with the quote, so an older answer stores none
    if (upsertQuote(db, q)) {
      written.push(q);
      storeIntraday(
        db,
        instrument.id,
        instrument.zone,
        meta.points,
        answer.fetchedAt,
      );
      refreshLive(db, instrument, answer.fetchedAt);
      moved.add(instrument.id);
    }
  }
  const others = db.query<{ id: string; market: string }, [string]>(
    "select id, market from instruments where market = ?",
  );
  for (const market of markets) {
    for (const i of others.all(market)) {
      if (!moved.has(i.id)) pruneLive(db, i, answer.fetchedAt);
    }
  }
  rules.evaluate(db, moved, now);
  return written;
}
