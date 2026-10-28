// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// every fetch finishes before its write is queued; no write awaits a fetch

import { dailyRange, type Written } from "../../market/bars.ts";
import { readSession, weekOf } from "../../market/calendars.ts";
import {
  checkOwner,
  checkSource,
  type Instrument,
  type InstrumentFields,
  type Unit,
  upsertInstrument,
} from "../../market/instruments.ts";
import type { QuoteRow } from "../../market/quotes.ts";
import { startOfDate } from "../../market/zone.ts";
import type { RuleHooks } from "../../rules/hooks.ts";
import { type Clock, DAY_MS } from "../../runtime/clock.ts";
import { exclusive } from "../../runtime/lock.ts";
import type { Db } from "../../storage/db/index.ts";
import type { Writer } from "../../storage/writer.ts";
import { backfillStart, REFETCH_DAYS } from "../history.ts";
import { expired, Refused, SourceError } from "../source.ts";
import { type Bvb, type History, MARKET, type Meta, SOURCE } from "./client.ts";
import {
  barsAnswered,
  barsOf,
  movedDays,
  rescaleIn,
  storeWhole,
  storeWindow,
} from "./history.ts";
import { detailQuote, indexQuote, storeBvbQuotes } from "./quotes.ts";

// db is for reads; every write goes through writer
export type BvbContext = {
  db: Db;
  clock: Clock;
  bvb: Bvb;
  writer: Writer;
  rules?: RuleHooks;
};

export const NO_DATA =
  "no data from bvb; the server turns it on with --source bvb";
export const ONLY =
  "the Bucharest feed serves shares, fund units, bonds and indices only";
export const AERO =
  "the Bucharest feed serves the regulated market's shares only, not AeRO's";
export const UNLISTED =
  "the Bucharest feed serves the fund units on its fund units list only";

// the feed's types, the ones served; a fund unit trades as a share does
export const KINDS: Readonly<Record<string, { type: string; unit: Unit }>> = {
  Shares: { type: "EQUITY", unit: "per_share" },
  Units: { type: "ETF", unit: "per_share" },
  Bonds: { type: "BOND", unit: "percent_of_par" },
  index: { type: "INDEX", unit: "index_points" },
};

// the same key whichever source serves the market
export const keyOf = (symbol: string): string =>
  `${MARKET}:${symbol.trim().toUpperCase()}`;

export function fieldsOf(meta: Meta): InstrumentFields {
  const kind = KINDS[meta.type];
  if (kind === undefined) throw new Refused(ONLY);
  return {
    market: MARKET,
    symbol: meta.symbol.toUpperCase(),
    source: SOURCE,
    sourceSymbol: meta.symbol,
    exchange: MARKET,
    name: meta.name,
    type: kind.type,
    currency: meta.currency,
    unit: kind.unit,
    zone: meta.zone,
  };
}

// ten years from a Monday, or from the stored first week if older
export async function wholeHistory(
  ctx: BvbContext,
  instrument: Pick<Instrument, "id" | "sourceSymbol" | "currency" | "zone">,
): Promise<{ history: History; since: string }> {
  const range = dailyRange(ctx.db, instrument.id);
  let { monday, from } = backfillStart(ctx.clock.now());
  if (range !== null && range.first < monday) {
    monday = weekOf(range.first);
    from = startOfDate(instrument.zone, monday);
  }
  const history = await ctx.bvb.history(
    instrument.sourceSymbol,
    instrument.currency,
    from,
    ctx.clock.now(),
  );
  return { history, since: monday };
}

type Answered = (db: Db) => Written;

// The 30-day window; a final close that moved there means the feed
// adjusted past prices, so the whole history is asked again, and a
// rescale pauses rules on old price levels before it is.
async function refetchAnswer(
  ctx: BvbContext,
  instrument: Instrument,
  live: () => boolean = () => true,
): Promise<Answered> {
  const { db, clock } = ctx;
  const range = dailyRange(db, instrument.id);
  if (range === null) {
    const { history, since } = await wholeHistory(ctx, instrument);
    return (w) => {
      checkSource(w, instrument);
      return storeWhole(w, clock.now(), instrument, history, since, ctx.rules);
    };
  }
  const now = clock.now();
  const since = range.lastFinal ?? range.first;
  const from = Math.min(
    now - REFETCH_DAYS * DAY_MS,
    startOfDate(instrument.zone, since),
  );
  const window = await ctx.bvb.history(
    instrument.sourceSymbol,
    instrument.currency,
    from,
    now,
  );
  const latest = readSession(db, MARKET);
  const bars = barsOf(window, latest);
  const moved = movedDays(db, instrument.id, bars);
  if (moved.length === 0) {
    return (w) => {
      checkSource(w, instrument);
      return storeWindow(w, clock.now(), instrument, window, ctx.rules);
    };
  }
  if (rescaleIn(db, instrument.id, bars, latest) !== null) {
    await ctx.writer.write((w) => {
      if (!live()) throw expired();
      checkSource(w, instrument);
      ctx.rules?.rescaled(w, instrument.id, clock.now());
    });
  }
  if (!live()) throw expired();
  const { history, since: start } = await wholeHistory(ctx, instrument);
  return (w) => {
    checkSource(w, instrument);
    return storeWhole(w, clock.now(), instrument, history, start, ctx.rules);
  };
}

export function refetch(
  ctx: BvbContext,
  instrument: Instrument,
): Promise<Written> {
  return exclusive(ctx.db, instrument.id, async () => {
    checkSource(ctx.db, instrument);
    const write = await refetchAnswer(ctx, instrument);
    return ctx.writer.write((db) =>
      barsAnswered(db, instrument, write(db), ctx.clock.now()),
    );
  });
}

// the whole history asked again, as after a parser fix
export function backfill(
  ctx: BvbContext,
  instrument: Instrument,
  live: () => boolean = () => true,
): Promise<Written> {
  return exclusive(ctx.db, instrument.id, async () => {
    if (!live()) throw expired();
    checkSource(ctx.db, instrument);
    const { history, since } = await wholeHistory(ctx, instrument);
    return ctx.writer.write((db) => {
      if (!live()) throw expired();
      checkSource(db, instrument);
      const now = ctx.clock.now();
      const written = storeWhole(
        db,
        now,
        instrument,
        history,
        since,
        ctx.rules,
      );
      return barsAnswered(db, instrument, written, now);
    });
  });
}

// a share's or bond's from its instrument page, an index's from the index
// page; bars with no quote would answer an old price as the live one
export async function quoteNow(
  ctx: BvbContext,
  instrument: Instrument,
): Promise<QuoteRow> {
  if (instrument.type === "INDEX") {
    const page = await ctx.bvb.indices();
    const row = page.rows.find(
      (r) => r.symbol.toUpperCase() === instrument.symbol,
    );
    if (row === undefined) {
      throw new SourceError("source error", `no quote for ${instrument.id}`);
    }
    return indexQuote(instrument, row, page.fetchedAt);
  }
  const d = await ctx.bvb.detail(instrument.sourceSymbol);
  const q = detailQuote(instrument, d);
  if (q === null) {
    throw new SourceError("source error", `no quote for ${instrument.id}`);
  }
  return q;
}

// a listing on no list a quote pass reads, an AeRO share, would never be quoted
export async function checkListed(ctx: BvbContext, meta: Meta): Promise<void> {
  const type = KINDS[meta.type]?.type;
  if (type !== "EQUITY" && type !== "ETF") return;
  const page =
    type === "EQUITY" ? await ctx.bvb.shares() : await ctx.bvb.units();
  const symbol = meta.symbol.toUpperCase();
  if (!page.rows.some((r) => r.symbol.toUpperCase() === symbol)) {
    throw new Refused(type === "EQUITY" ? AERO : UNLISTED);
  }
}

// an instrument as the feed's symbol answer names it, before it is stored
export function draft(meta: Meta, now: number): Instrument {
  const f = fieldsOf(meta);
  return { ...f, id: `${f.market}:${f.symbol}`, addedAt: now, updatedAt: now };
}

// one write while live() holds, or nothing
export async function fetchInstrument(
  ctx: BvbContext,
  symbol: string,
  expected: string | null,
  live: () => boolean,
): Promise<Instrument> {
  const meta = await ctx.bvb.meta(symbol);
  if (meta.expired) throw new SourceError("not found");
  const planned = draft(meta, ctx.clock.now());
  if (expected !== null && expected !== planned.id) {
    throw new SourceError(
      "malformed answer",
      `${expected} answered as ${planned.id}`,
    );
  }
  if (!live()) throw expired();
  await checkListed(ctx, meta);
  if (!live()) throw expired();
  const quote = await quoteNow(ctx, planned);
  return exclusive(ctx.db, planned.id, async () => {
    // the lock may have been held past the deadline
    if (!live()) throw expired();
    // stored meanwhile by another read
    if (dailyRange(ctx.db, planned.id) !== null) {
      return ctx.writer.write((db) => {
        if (!live()) throw expired();
        // a Yahoo row flips to the feed only with its history refetched
        checkOwner(db, planned.id, SOURCE);
        const now = ctx.clock.now();
        const instrument = upsertInstrument(db, fieldsOf(meta), now);
        storeBvbQuotes(db, [quote], ctx.rules, now);
        return instrument;
      });
    }
    const { history, since } = await wholeHistory(ctx, planned);
    if (!live()) throw expired();
    return ctx.writer.write((db) => {
      if (!live()) throw expired();
      checkOwner(db, planned.id, SOURCE);
      const now = ctx.clock.now();
      const instrument = upsertInstrument(db, fieldsOf(meta), now);
      barsAnswered(
        db,
        instrument,
        storeWhole(db, now, instrument, history, since, ctx.rules),
        now,
      );
      storeBvbQuotes(db, [quote], ctx.rules, now);
      return instrument;
    });
  });
}

// untracked, so no job kept its bars: refetched like the bar pass, then quoted
export async function catchUp(
  ctx: BvbContext,
  instrument: Instrument,
  live: () => boolean,
): Promise<Instrument> {
  return exclusive(ctx.db, instrument.id, async () => {
    if (!live()) throw expired();
    checkSource(ctx.db, instrument);
    const bars = await refetchAnswer(ctx, instrument, live);
    if (!live()) throw expired();
    const quote = await quoteNow(ctx, instrument);
    return ctx.writer.write((db) => {
      if (!live()) throw expired();
      const now = ctx.clock.now();
      barsAnswered(db, instrument, bars(db), now);
      storeBvbQuotes(db, [quote], ctx.rules, now);
      return instrument;
    });
  });
}
