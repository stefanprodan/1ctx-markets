// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// every fetch finishes before its write is queued; no write awaits a fetch

import {
  type Bar,
  dailyRange,
  deleteDailyBars,
  earliest,
  rebuildWeeks,
  upsertBars,
  type Written,
} from "../bars.ts";
import {
  barDate,
  isBarFinal,
  readSession,
  recordSession,
  type Session,
  sessionDate,
  weekOf,
} from "../calendars.ts";
import { type Clock, DAY_MS, MINUTE_MS } from "../clock.ts";
import type { Db } from "../db/index.ts";
import {
  checkOwner,
  checkSource,
  type Instrument,
  readBySourceSymbol,
  type Unit,
  upsertInstrument,
} from "../instruments.ts";
import { exclusive } from "../lock.ts";
import { type QuoteRow, upsertQuote } from "../quotes.ts";
import { NO_RULES, type RuleHooks } from "../rules/hooks.ts";
import { endRun, startRun } from "../runs.ts";
import { pruneLive, refreshLive, signalsAfterBars } from "../signals/store.ts";
import { DeadlinePassed, type Phrase, SourceError } from "../source.ts";
import { JOBS } from "../stale.ts";
import type { Writer } from "../writer.ts";
import { addDays, dateOfWall, startOfDate, wallTime } from "../zone.ts";
import {
  type ChartAnswer,
  type ChartMeta,
  type ChartRow,
  SOURCE,
  type SparkAnswer,
  type SplitEvent,
  type Yahoo,
} from "./client.ts";
import { keyOf, marketOf, symbolOf } from "./resolve.ts";

// db is for reads; every write goes through writer
export type YahooContext = {
  db: Db;
  clock: Clock;
  yahoo: Yahoo;
  writer: Writer;
  // told of each write, inside it; none in tests that need no rules
  rules?: RuleHooks;
};

export const BACKFILL_YEARS = 10;
// a failed pass or backfill, or a refused whole history, waits this long
export const RETRY_MS = 60 * MINUTE_MS;
export const REFETCH_DAYS = 30;
// a start this far past the asked one, and past the stored one, is cut short
const SHORT_HISTORY_DAYS = 10;

const timeOfDay = (zone: string, at: number) =>
  ((wallTime(zone, at) % DAY_MS) + DAY_MS) % DAY_MS;

type Read = {
  bars: Bar[];
  // the dates of the source's regular rows, null closes included, which
  // bound the span a write reconciles; only bars are kept in it
  days: Set<string>;
};

// a trailing off-grid row counts only on the session's date: EURUSD=X
// trades on Sunday while its session is Friday's
function read(answer: ChartAnswer, latest: Session | null): Read {
  const zone = answer.session.zone;
  const rows = answer.rows;
  let trailing: ChartRow | null = null;
  let regular = rows;
  const last = rows.at(-1);
  if (last !== undefined) {
    const grid =
      rows.length > 1
        ? timeOfDay(zone, rows.at(-2)!.at)
        : timeOfDay(zone, answer.session.start);
    if (timeOfDay(zone, last.at) !== grid) {
      trailing = last;
      regular = rows.slice(0, -1);
    }
  }
  const byDate = new Map<string, Bar>();
  const days = new Set<string>();
  for (const row of regular) {
    const date = barDate(zone, row.at);
    days.add(date);
    if (row.close === null) continue;
    add(byDate, date, row, latest);
  }
  if (trailing !== null && trailing.close !== null) {
    const date = barDate(zone, trailing.at);
    if (
      date === sessionDate(answer.session) &&
      (byDate.has(date) || ownsToday(answer.type))
    ) {
      add(byDate, date, trailing, latest);
    }
  }
  return { bars: [...byDate.values()], days };
}

// FX answers stamp today's row at the live minute; CL=F's Sunday evening
// trades belong to Monday's bar, though its Sunday session has their date
const ownsToday = (type: string) => type.toUpperCase() === "CURRENCY";

function add(
  byDate: Map<string, Bar>,
  date: string,
  row: ChartRow,
  latest: Session | null,
): void {
  const bar = byDate.get(date);
  if (bar !== undefined) {
    merge(bar, row);
    return;
  }
  byDate.set(date, {
    date,
    open: row.open,
    high: row.high,
    low: row.low,
    close: row.close!,
    volume: row.volume,
    final: latest !== null && isBarFinal(date, latest),
  });
}

function merge(bar: Bar, row: ChartRow): void {
  bar.open ??= row.open;
  bar.high = maxOf(bar.high, row.high);
  bar.low = minOf(bar.low, row.low);
  bar.close = row.close!;
  // both are the day's volume, one later than the other
  bar.volume = maxOf(bar.volume, row.volume);
}

export function dailyBars(answer: ChartAnswer, latest: Session | null): Bar[] {
  return read(answer, latest).bars;
}

const maxOf = (a: number | null, b: number | null) =>
  a === null ? b : b === null ? a : Math.max(a, b);
const minOf = (a: number | null, b: number | null) =>
  a === null ? b : b === null ? a : Math.min(a, b);

// a Monday so the first week is whole; from the UTC day before, for any zone
export function backfillStart(now: number): { monday: string; from: number } {
  const today = dateOfWall(now);
  const back = `${Number(today.slice(0, 4)) - BACKFILL_YEARS}${today.slice(4)}`;
  // ten years before a 29 February is no leap year
  const monday = weekOf(
    back.endsWith("-02-29") ? `${back.slice(0, 8)}28` : back,
  );
  return { monday, from: Date.parse(`${monday}T00:00:00Z`) - DAY_MS };
}

function checkAnswer(instrument: Instrument, answer: ChartMeta): void {
  const id = keyOf(answer.exchange, answer.symbol);
  if (id !== instrument.id) {
    throw new SourceError(
      "malformed answer",
      `${instrument.id} answered as ${id}`,
    );
  }
}

// Yahoo's INDEX holds both ^VIX's points and ^TNX's percent, and
// FUTURE both per-barrel and per-bond prices, so neither is guessed.
export function unitOf(type: string): Unit {
  switch (type.toUpperCase()) {
    case "EQUITY":
    case "ETF":
    case "MUTUALFUND":
      return "per_share";
    case "CRYPTOCURRENCY":
    case "CURRENCY":
      return "per_unit";
    default:
      return "unknown";
  }
}

function fields(answer: ChartMeta) {
  return {
    market: marketOf(answer.exchange),
    symbol: symbolOf(answer.symbol),
    source: SOURCE,
    sourceSymbol: answer.symbol,
    exchange: answer.exchange,
    name: answer.name,
    type: answer.type,
    currency: answer.currency,
    unit: unitOf(answer.type),
    zone: answer.session.zone,
  };
}

type Split = SplitEvent & { date: string };

// a corrected ratio rescales like a new split; per date, a later answer wins
function unapplied(
  db: Db,
  instrument: Instrument,
  answers: readonly ChartAnswer[],
): Split[] {
  const stored = new Map(
    db
      .query<
        { date: string; numerator: number; denominator: number },
        [string]
      >("select date, numerator, denominator from splits where instrument = ?")
      .all(instrument.id)
      .map((r) => [r.date, r]),
  );
  const merged = new Map<string, Split>();
  for (const answer of answers) {
    for (const s of answer.splits) {
      const date = barDate(instrument.zone, s.at);
      merged.set(date, { ...s, date });
    }
  }
  return [...merged.values()].filter((s) => {
    const old = stored.get(s.date);
    return (
      old === undefined ||
      old.numerator !== s.numerator ||
      old.denominator !== s.denominator
    );
  });
}

function recordSplits(
  db: Db,
  instrument: Instrument,
  splits: Split[],
  now: number,
): void {
  const upsert = db.query(
    `insert into splits (instrument, date, numerator, denominator, ratio,
       applied_at)
     values (?, ?, ?, ?, ?, ?)
     on conflict (instrument, date) do update set
       numerator = excluded.numerator,
       denominator = excluded.denominator,
       ratio = excluded.ratio,
       applied_at = excluded.applied_at`,
  );
  for (const s of splits) {
    upsert.run(instrument.id, s.date, s.numerator, s.denominator, s.ratio, now);
  }
}

// with no first trade date a late start cannot be told from a recent listing
function startsShort(answer: ChartAnswer, since: string): boolean {
  if (answer.firstTrade === null) return false;
  const first = read(answer, null).bars.find((b) => b.date >= since)?.date;
  if (first === undefined) return false;
  const listed = barDate(answer.session.zone, answer.firstTrade);
  const floor = listed > since ? listed : since;
  return first > addDays(floor, SHORT_HISTORY_DAYS);
}

const cutShort = () =>
  new SourceError("malformed answer", "a history cut short");

// a shared ratio this far from 1 is a rescale, not numerical noise
const RESCALE = 0.001;
// ratios this close to each other are one ratio
const SAME_RATIO = 0.0001;
// fewer days moved by one ratio are corrections
const RESCALE_DAYS = 3;

// the ratio past prices moved by and the stored days that show it
export type Rescale = { ratio: number; dates: string[] };

export const sameRatio = (a: number, b: number) =>
  Math.abs(a / b - 1) <= SAME_RATIO;

// Stored final days the answer prices again, moved by one ratio though
// the answer has no split: past prices adjusted in place. An adjustment
// moves every day before its date, so the oldest days show it; a run of
// unmoved days means none came before them.
export function rescaleOf(
  db: Db,
  instrument: Pick<Instrument, "id">,
  bars: readonly Bar[],
): Rescale | null {
  const stored = db.query<{ close: number }, [string, string]>(
    `select close from bars where instrument = ? and interval = '1d'
     and date = ? and final = 1`,
  );
  let ratio = 0;
  let dates: string[] = [];
  for (const b of [...bars].sort((x, y) => (x.date < y.date ? -1 : 1))) {
    const s = stored.get(instrument.id, b.date);
    if (s === null || s.close <= 0) continue;
    const r = b.close / s.close;
    if (dates.length > 0 && sameRatio(r, ratio)) dates.push(b.date);
    else if (dates.length >= RESCALE_DAYS) break;
    else {
      ratio = r;
      dates = [b.date];
    }
    if (dates.length === RESCALE_DAYS && Math.abs(ratio - 1) <= RESCALE) {
      return null;
    }
  }
  if (dates.length < RESCALE_DAYS) return null;
  return { ratio, dates };
}

// A whole history confirms a window's rescale when its own oldest days
// moved by the window's ratio and so did every day the window showed it on.
function confirms(
  found: Rescale | null,
  window: Rescale,
  db: Db,
  instrument: Instrument,
  bars: readonly Bar[],
): boolean {
  if (found === null || !sameRatio(found.ratio, window.ratio)) return false;
  const byDate = new Map(bars.map((b) => [b.date, b]));
  const stored = db.query<{ close: number }, [string, string]>(
    `select close from bars where instrument = ? and interval = '1d'
     and date = ? and final = 1`,
  );
  return window.dates.every((d) => {
    const b = byDate.get(d);
    const s = stored.get(instrument.id, d);
    return (
      b !== undefined &&
      s !== null &&
      s.close > 0 &&
      sameRatio(b.close / s.close, window.ratio)
    );
  });
}

// a whole history and the answers whose splits it applies, and the
// rescale a window showed, which it must confirm
type Whole = {
  since: string;
  splits: readonly ChartAnswer[];
  rescale?: Rescale;
};

const unconfirmed = () =>
  new SourceError(
    "malformed answer",
    "a whole history that does not confirm its window's rescale",
  );

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

// owed: the newest finished day the answer gave no close for, none final stored
export type Landed = Written & { owed: string | null };

const hasDaily = (db: Db, i: Pick<Instrument, "id">) =>
  dailyRange(db, i.id) !== null;

// A chart can leave the session before the latest one without its close
// for a while after the next opens, so that day is owed, not dropped.
function unclosed(
  db: Db,
  instrument: Instrument,
  latest: Session | null,
  { bars, days }: Read,
): string | null {
  // backfill owns an instrument with no bars, so it is never owed
  if (latest === null || (bars.length === 0 && !hasDaily(db, instrument))) {
    return null;
  }
  const today = sessionDate(latest);
  const stored = db
    .query<{ date: string; final: number }, [string, string]>(
      `select date, final from bars where instrument = ? and interval = '1d'
       and date < ? order by date desc limit 1`,
    )
    .get(instrument.id, today);
  let newest = stored?.date ?? null;
  for (const d of days) {
    if (d < today && (newest === null || d > newest)) newest = d;
  }
  if (newest === null || bars.some((b) => b.date === newest)) return null;
  return stored?.date === newest && stored.final === 1 ? null : newest;
}

// a cut-short whole history writes nothing, so no day keeps an old scale
function storeBars(
  db: Db,
  now: number,
  instrument: Instrument,
  answer: ChartAnswer,
  whole: Whole | null,
): Landed & { rescaled: boolean } {
  recordSession(db, instrument.market, answer.session, answer.fetchedAt);
  const latest = readSession(db, instrument.market);
  const answered = read(answer, latest);
  const { bars, days } = answered;
  const owed = unclosed(db, instrument, latest, answered);
  if (whole) {
    const kept = bars.filter((b) => b.date >= whole.since);
    const span = [...days].filter((d) => d >= whole.since).sort();
    const splits = unapplied(db, instrument, whole.splits);
    const found = rescaleOf(db, instrument, kept);
    if (
      whole.rescale !== undefined &&
      !confirms(found, whole.rescale, db, instrument, kept)
    ) {
      throw unconfirmed();
    }
    const rescaled = splits.length > 0 || found !== null;
    const range = dailyRange(db, instrument.id);
    if (range === null) {
      if (startsShort(answer, whole.since)) throw cutShort();
    } else {
      const first = kept[0]?.date;
      const last = kept.at(-1)?.date;
      if (
        first === undefined ||
        last === undefined ||
        (first > addDays(whole.since, SHORT_HISTORY_DAYS) &&
          range.first < addDays(first, -SHORT_HISTORY_DAYS)) ||
        last < addDays(range.last, -SHORT_HISTORY_DAYS) ||
        (rescaled && (span[0]! > range.first || span.at(-1)! < range.last))
      ) {
        throw cutShort();
      }
    }
    const keep = new Set(kept.map((b) => b.date));
    const deleted =
      span.length === 0
        ? null
        : deleteDailyBars(db, instrument.id, span[0]!, span.at(-1)!, keep);
    const written = upsertBars(db, instrument.id, "1d", kept, answer.fetchedAt);
    recordSplits(db, instrument, splits, now);
    rebuildWeeks(db, instrument.id, latest, now);
    return {
      rows: written.rows,
      changedFrom: earliest(deleted, written.changedFrom),
      owed,
      rescaled,
    };
  }
  const written = upsertBars(db, instrument.id, "1d", bars, answer.fetchedAt);
  const span = [...days].sort();
  let deleted: string | null = null;
  if (span.length > 0) {
    const keep = new Set(bars.map((b) => b.date));
    if (owed !== null) keep.add(owed);
    deleted = deleteDailyBars(db, instrument.id, span[0]!, span.at(-1)!, keep);
    rebuildWeeks(db, instrument.id, latest, now, span[0]!);
  }
  return {
    rows: written.rows,
    changedFrom: earliest(deleted, written.changedFrom),
    owed,
    // a window is stored only when refetchAnswer found no rescale in it
    rescaled: false,
  };
}

// bars and signals in one write; a rescale pauses rules before they evaluate
function store(
  db: Db,
  now: number,
  instrument: Instrument,
  answer: ChartAnswer,
  whole: Whole | null,
  rules: RuleHooks = NO_RULES,
): Landed {
  const { rescaled, ...written } = storeBars(
    db,
    now,
    instrument,
    answer,
    whole,
  );
  if (rescaled) rules.rescaled(db, instrument.id, now);
  signalsAfterBars(db, instrument, written.changedFrom, now);
  rules.evaluate(db, [instrument.id], now);
  return written;
}

// an ok run in the instrument's scope clears only its own failed refetch;
// one that left a day owed says so, for the bar job to ask again
function barsAnswered(
  db: Db,
  instrument: Instrument,
  written: Landed,
  now: number,
): Landed {
  endRun(
    db,
    startRun(db, SOURCE, JOBS.bars, now, instrument.id),
    now,
    written.rows,
  );
  if (written.owed !== null) {
    endRun(db, startRun(db, SOURCE, JOBS.owed, now, instrument.id), now, 0);
  }
  return written;
}

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

export const expired = () => new DeadlinePassed();

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

// sessions are recorded before quotes, so live rows never depend on order
export function storeQuotes(
  db: Db,
  answer: SparkAnswer,
  rules: RuleHooks = NO_RULES,
  now: number = answer.fetchedAt,
): QuoteRow[] {
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
    if (upsertQuote(db, q)) {
      written.push(q);
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
