// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// every fetch finishes before its write is queued; no write awaits a fetch

import { dailyRange, type Written } from "../../market/bars.ts";
import { weekOf } from "../../market/calendars.ts";
import {
  checkOwner,
  checkSource,
  type Instrument,
  upsertInstrument,
} from "../../market/instruments.ts";
import type { QuoteRow } from "../../market/quotes.ts";
import { startOfDate } from "../../market/zone.ts";
import { NO_RULES, type RuleHooks } from "../../rules/hooks.ts";
import { type Clock, DAY_MS } from "../../runtime/clock.ts";
import { exclusive } from "../../runtime/lock.ts";
import type { Db } from "../../storage/db/index.ts";
import type { Writer } from "../../storage/writer.ts";
import {
  backfillStart,
  REFETCH_DAYS,
  RETRY_MS,
  type Rescale,
  rescaleOf,
} from "../history.ts";
import { expired, type Phrase, SourceError } from "../source.ts";
import {
  type ChartAnswer,
  SOURCE,
  type SparkAnswer,
  type Yahoo,
} from "./client.ts";
import {
  barsAnswered,
  checkAnswer,
  cutShort,
  fields,
  type Landed,
  read,
  startsShort,
  store,
  unapplied,
} from "./history.ts";
import { storeQuotes } from "./quotes.ts";
import { keyOf } from "./resolve.ts";

// db is for reads; every write goes through writer
export type YahooContext = {
  db: Db;
  clock: Clock;
  yahoo: Yahoo;
  writer: Writer;
  // told of each write, inside it; none in tests that need no rules
  rules?: RuleHooks;
};

// when each instrument's whole history was last refused, per database
const refused = new WeakMap<Db, Map<string, number>>();
const refusedOf = (db: Db) => {
  let m = refused.get(db);
  if (m === undefined) {
    m = new Map();
    refused.set(db, m);
  }
  return m;
};

// a history cut short adds the instrument alone, for backfill to retry
export async function addInstrument(
  ctx: YahooContext,
  sourceSymbol: string,
  expected: string | null = null,
): Promise<{ instrument: Instrument } & Written> {
  const { monday, from } = backfillStart(ctx.clock.now());
  const answer = await ctx.yahoo.chart(sourceSymbol, from, ctx.clock.now());
  const id = keyOf(answer.exchange, answer.symbol);
  if (expected !== null && expected !== id) {
    throw new SourceError("malformed answer", `${expected} answered as ${id}`);
  }
  return exclusive(ctx.db, id, async () => {
    // stored bars may be newer than this answer, so they are fetched
    // again under the lock
    if (dailyRange(ctx.db, id) !== null) {
      const instrument = await ctx.writer.write((db) => {
        checkOwner(db, id, SOURCE);
        return upsertInstrument(db, fields(answer), ctx.clock.now());
      });
      return { instrument, ...(await backfillHeld(ctx, instrument)) };
    }
    const short = startsShort(answer, monday);
    // the instrument and its bars land together, or neither does
    return ctx.writer.write((db) => {
      checkOwner(db, id, SOURCE);
      const now = ctx.clock.now();
      const instrument = upsertInstrument(db, fields(answer), now);
      if (short) return { instrument, rows: 0, changedFrom: null };
      const written = store(
        db,
        now,
        instrument,
        answer,
        { since: monday, splits: [answer] },
        ctx.rules,
      );
      return { instrument, ...written };
    });
  });
}

// A market moved to Yahoo from another source: its stored days are gone
// and this whole history and quote replace them in the caller's write.
export function storeSwitched(
  db: Db,
  now: number,
  answer: ChartAnswer,
  quote: SparkAnswer,
  since: string,
  rules: RuleHooks = NO_RULES,
): Instrument {
  if (startsShort(answer, since)) throw cutShort();
  const instrument = upsertInstrument(db, fields(answer), now);
  const { owed } = store(
    db,
    now,
    instrument,
    answer,
    { since, splits: [answer] },
    rules,
  );
  barsAnswered(db, instrument, { rows: 0, changedFrom: null, owed }, now);
  storeQuotes(db, quote, rules, now);
  return instrument;
}

// one write while live() holds, or nothing
export async function fetchInstrument(
  ctx: YahooContext,
  sourceSymbol: string,
  expected: string | null,
  live: () => boolean,
): Promise<Instrument> {
  const { monday, from } = backfillStart(ctx.clock.now());
  const answer = await ctx.yahoo.chart(sourceSymbol, from, ctx.clock.now());
  const id = keyOf(answer.exchange, answer.symbol);
  if (expected !== null && expected !== id) {
    throw new SourceError("malformed answer", `${expected} answered as ${id}`);
  }
  if (!live()) throw expired();
  // a chart's previous close is the one before its range, ten years back
  const quote = await ctx.yahoo.spark([answer.symbol]);
  // bars with no quote would answer an old price as the live one
  if (
    !quote.quotes.some(
      (q) => q.symbol.toUpperCase() === answer.symbol.toUpperCase(),
    )
  ) {
    throw new SourceError("source error", `no quote for ${answer.symbol}`);
  }
  return exclusive(ctx.db, id, async () => {
    // the lock may have been held past the deadline
    if (!live()) throw expired();
    // stored meanwhile by another read or the backfill
    if (dailyRange(ctx.db, id) !== null) {
      return ctx.writer.write((db) => {
        if (!live()) throw expired();
        checkOwner(db, id, SOURCE);
        const instrument = upsertInstrument(
          db,
          fields(answer),
          ctx.clock.now(),
        );
        storeQuotes(db, quote, ctx.rules, ctx.clock.now());
        return instrument;
      });
    }
    if (startsShort(answer, monday)) throw cutShort();
    return ctx.writer.write((db) => {
      if (!live()) throw expired();
      checkOwner(db, id, SOURCE);
      const now = ctx.clock.now();
      const instrument = upsertInstrument(db, fields(answer), now);
      store(
        db,
        now,
        instrument,
        answer,
        { since: monday, splits: [answer] },
        ctx.rules,
      );
      storeQuotes(db, quote, ctx.rules, now);
      return instrument;
    });
  });
}

// untracked, so no job kept its bars: refetched like the bar pass, then quoted
export async function catchUp(
  ctx: YahooContext,
  instrument: Instrument,
  live: () => boolean,
): Promise<Instrument> {
  return exclusive(ctx.db, instrument.id, async () => {
    // the lock may have been held past the deadline
    if (!live()) throw expired();
    checkSource(ctx.db, instrument);
    const bars = await refetchAnswer(ctx, instrument, live);
    if (!live()) throw expired();
    const quote = await ctx.yahoo.spark([instrument.sourceSymbol]);
    return ctx.writer.write((db) => {
      if (!live()) throw expired();
      barsAnswered(db, instrument, bars(db), ctx.clock.now());
      storeQuotes(db, quote, ctx.rules, ctx.clock.now());
      return instrument;
    });
  });
}

// from the first stored bar if older, so no bar keeps a pre-split scale
export function backfill(
  ctx: YahooContext,
  instrument: Instrument,
  live: () => boolean = () => true,
): Promise<Landed> {
  return exclusive(ctx.db, instrument.id, () => {
    if (!live()) throw expired();
    checkSource(ctx.db, instrument);
    return backfillHeld(ctx, instrument, [], live);
  });
}

// fetched in full before anything is written
type Answered = (db: Db) => Landed;

async function backfillHeld(
  ctx: YahooContext,
  instrument: Instrument,
  triggers: readonly ChartAnswer[] = [],
  live: () => boolean = () => true,
): Promise<Landed> {
  const write = await backfillAnswer(ctx, instrument, triggers);
  return ctx.writer.write((db) => {
    if (!live()) throw expired();
    return barsAnswered(db, instrument, write(db), ctx.clock.now());
  });
}

async function backfillAnswer(
  ctx: YahooContext,
  instrument: Instrument,
  triggers: readonly ChartAnswer[] = [],
  rescale?: Rescale,
): Promise<Answered> {
  const range = dailyRange(ctx.db, instrument.id);
  let { monday, from } = backfillStart(ctx.clock.now());
  if (range !== null && range.first < monday) {
    monday = weekOf(range.first);
    from = startOfDate(instrument.zone, monday);
  }
  const answer = await ctx.yahoo.chart(
    instrument.sourceSymbol,
    from,
    ctx.clock.now(),
  );
  checkAnswer(instrument, answer);
  return (db) => {
    checkSource(db, instrument);
    return store(
      db,
      ctx.clock.now(),
      instrument,
      answer,
      { since: monday, splits: [...triggers, answer], rescale },
      ctx.rules,
    );
  };
}

// a split or rescale asks the whole history once, so no day keeps an old scale
export function refetch(
  ctx: YahooContext,
  instrument: Instrument,
): Promise<Landed> {
  return exclusive(ctx.db, instrument.id, () => {
    checkSource(ctx.db, instrument);
    return refetchHeld(ctx, instrument);
  });
}

async function refetchHeld(
  ctx: YahooContext,
  instrument: Instrument,
): Promise<Landed> {
  const write = await refetchAnswer(ctx, instrument);
  return ctx.writer.write((db) =>
    barsAnswered(db, instrument, write(db), ctx.clock.now()),
  );
}

async function refetchAnswer(
  ctx: YahooContext,
  instrument: Instrument,
  live: () => boolean = () => true,
): Promise<Answered> {
  const { db, clock } = ctx;
  const range = dailyRange(db, instrument.id);
  if (range === null) return backfillAnswer(ctx, instrument);
  const now = clock.now();
  const since = range.lastFinal ?? range.first;
  const from = Math.min(
    now - REFETCH_DAYS * DAY_MS,
    startOfDate(instrument.zone, since),
  );
  const answer = await ctx.yahoo.chart(instrument.sourceSymbol, from, now);
  checkAnswer(instrument, answer);
  const split = unapplied(db, instrument, [answer]).length > 0;
  const rescale = split
    ? null
    : rescaleOf(db, instrument, read(answer, null).bars);
  if (split || rescale !== null) {
    // old price levels stop now, since the whole history may be refused
    await ctx.writer.write((w) => {
      if (!live()) throw expired();
      checkSource(w, instrument);
      ctx.rules?.rescaled(w, instrument.id, ctx.clock.now());
    });
    const marks = refusedOf(db);
    const last = marks.get(instrument.id);
    if (last !== undefined && now - last < RETRY_MS) {
      throw new SourceError(
        "malformed answer",
        "a whole history refused within the retry period",
      );
    }
    const write = await backfillAnswer(
      ctx,
      instrument,
      [answer],
      rescale ?? undefined,
    );
    return (w) => {
      try {
        const written = write(w);
        marks.delete(instrument.id);
        return written;
      } catch (e) {
        if (e instanceof SourceError) marks.set(instrument.id, ctx.clock.now());
        throw e;
      }
    };
  }
  return (db) => {
    checkSource(db, instrument);
    return store(db, ctx.clock.now(), instrument, answer, null, ctx.rules);
  };
}

export async function fetchQuotes(
  ctx: YahooContext,
  instruments: readonly Instrument[],
): Promise<{
  quotes: QuoteRow[];
  skipped: { symbol: string | null; phrase: Phrase }[];
  errors: unknown[];
}> {
  const batches = await ctx.yahoo.sparkAll(
    instruments.map((i) => i.sourceSymbol),
  );
  const skipped: { symbol: string | null; phrase: Phrase }[] = [];
  const errors: unknown[] = [];
  const answers: SparkAnswer[] = [];
  for (const batch of batches) {
    if (batch.answer) {
      answers.push(batch.answer);
      skipped.push(...batch.answer.skipped);
    } else {
      errors.push(batch.error);
    }
  }
  const quotes = await ctx.writer.write((db) => {
    const stored = answers.flatMap((answer) => storeQuotes(db, answer));
    ctx.rules?.evaluate(
      db,
      stored.map((q) => q.instrument),
      ctx.clock.now(),
    );
    return stored;
  });
  return { quotes, skipped, errors };
}
