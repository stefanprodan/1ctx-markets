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
  isBarFinal,
  readSession,
  type Session,
  session,
  sessionDate,
  weekOf,
} from "../calendars.ts";
import { type Clock, DAY_MS, MINUTE_MS } from "../clock.ts";
import type { Db } from "../db/index.ts";
import { Refused } from "../fred/sync.ts";
import {
  checkOwner,
  checkSource,
  type Instrument,
  type InstrumentFields,
  readInstruments,
  type Unit,
  upsertInstrument,
} from "../instruments.ts";
import { exclusive } from "../lock.ts";
import { type QuoteRow, readQuote, upsertQuote } from "../quotes.ts";
import { NO_RULES, type RuleHooks } from "../rules/hooks.ts";
import { endRun, startRun } from "../runs.ts";
import { pruneLive, refreshLive, signalsAfterBars } from "../signals/store.ts";
import { SourceError } from "../source.ts";
import { JOBS } from "../stale.ts";
import type { Writer } from "../writer.ts";
import {
  backfillStart,
  expired,
  REFETCH_DAYS,
  rescaleOf,
  sameRatio,
} from "../yahoo/sync.ts";
import {
  addDays,
  fromWallTime,
  localDate,
  startOfDate,
  wallTime,
} from "../zone.ts";
import {
  type Bvb,
  type Detail,
  type History,
  type IndexRow,
  type ListRow,
  MARKET,
  type Meta,
  type Schedule,
  SOURCE,
} from "./client.ts";

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
export const ONLY = "the Bucharest feed serves shares, bonds and indices only";
export const AERO =
  "the Bucharest feed serves the regulated market's shares only, not AeRO's";

// the feed's types, the ones served
const KINDS: Readonly<Record<string, { type: string; unit: Unit }>> = {
  Shares: { type: "EQUITY", unit: "per_share" },
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

// a close this far from the stored one has moved
const MOVED = 0.0001;
// a whole history this far short of the stored one is cut short
const SHORT_HISTORY_DAYS = 10;

// the schedule's times on now's local date
export function sessionOf(zone: string, s: Schedule, now: number): Session {
  const day = Math.floor(wallTime(zone, now) / DAY_MS) * DAY_MS;
  return session(
    zone,
    fromWallTime(zone, day + s.start),
    fromWallTime(zone, day + s.end),
  );
}

function quoteRow(
  instrument: Instrument,
  price: number,
  previousClose: number | null,
  field: "reference" | "change",
  range: { high: number | null; low: number | null },
  time: number | null,
  fetchedAt: number,
): QuoteRow {
  const change = previousClose === null ? null : price - previousClose;
  return {
    instrument: instrument.id,
    price,
    previousClose,
    previousCloseField: previousClose === null ? null : field,
    change,
    changePercent:
      change === null || previousClose === 0
        ? null
        : (change / previousClose!) * 100,
    dayHigh: range.high,
    dayLow: range.low,
    volume: null,
    time,
    source: SOURCE,
    fetchedAt,
  };
}

// the instrument page's reference price is the previous close, never one
// worked back from a rounded change percent
export function detailQuote(
  instrument: Instrument,
  d: Detail,
): QuoteRow | null {
  if (d.price === null || d.at === null) return null;
  return quoteRow(
    instrument,
    d.price,
    d.reference,
    "reference",
    { high: d.high, low: d.low },
    fromWallTime(instrument.zone, d.at),
    d.fetchedAt,
  );
}

// the index page gives the exact change and no trade time
export function indexQuote(
  instrument: Instrument,
  row: IndexRow,
  fetchedAt: number,
): QuoteRow {
  return quoteRow(
    instrument,
    row.value,
    row.value - row.change,
    "change",
    { high: null, low: null },
    null,
    fetchedAt,
  );
}

// A traded list row of the stored quote's trading day keeps its previous
// close, and its day range widens by each price seen; one of a later day
// needs the instrument page (null).
export function listQuote(
  db: Db,
  instrument: Instrument,
  row: ListRow & { price: number; at: number },
  fetchedAt: number,
): QuoteRow | null {
  const listed = fromWallTime(instrument.zone, row.at);
  const stored = readQuote(db, instrument.id);
  if (
    stored === null ||
    stored.time === null ||
    stored.previousClose === null ||
    localDate(instrument.zone, stored.time) !==
      localDate(instrument.zone, listed)
  ) {
    return null;
  }
  // the list writes minutes, the instrument page seconds: the same trade
  const time =
    stored.time >= listed && stored.time < listed + MINUTE_MS
      ? stored.time
      : listed;
  const widen = (v: number | null, f: (a: number, b: number) => number) =>
    v === null ? null : f(v, row.price);
  return quoteRow(
    instrument,
    row.price,
    stored.previousClose,
    "reference",
    {
      high: widen(stored.dayHigh, Math.max),
      low: widen(stored.dayLow, Math.min),
    },
    time,
    fetchedAt,
  );
}

// live rows follow the quotes; a market's others lose a live row its
// session moved past
export function storeBvbQuotes(
  db: Db,
  quotes: readonly QuoteRow[],
  rules: RuleHooks = NO_RULES,
  now: number,
): QuoteRow[] {
  const written: QuoteRow[] = [];
  const moved = new Set<string>();
  const instruments = readInstruments(db).filter((i) => i.market === MARKET);
  const byId = new Map(instruments.map((i) => [i.id, i]));
  for (const q of quotes) {
    const instrument = byId.get(q.instrument);
    if (instrument === undefined || !upsertQuote(db, q)) continue;
    written.push(q);
    refreshLive(db, instrument, q.fetchedAt);
    moved.add(instrument.id);
  }
  for (const i of instruments) {
    if (!moved.has(i.id)) pruneLive(db, i, now);
  }
  rules.evaluate(db, moved, now);
  return written;
}

function barsOf(history: History, latest: Session | null): Bar[] {
  return history.bars.map((b) => ({
    ...b,
    final: latest !== null && isBarFinal(b.date, latest),
  }));
}

export const cutShort = () =>
  new SourceError("malformed answer", "a history cut short");

// A whole history replacing the stored days reaches the stored last day
// and starts near the asked start or the stored first day; every: it
// covers each stored day, as one that rescales them must.
export function checkCovers(
  db: Db,
  id: string,
  dates: readonly string[],
  since: string,
  every: boolean,
): void {
  const range = dailyRange(db, id);
  if (range === null) return;
  const first = dates[0];
  const last = dates.at(-1);
  if (
    first === undefined ||
    last === undefined ||
    last < addDays(range.last, -SHORT_HISTORY_DAYS) ||
    (every && (first > range.first || last < range.last)) ||
    (first > addDays(since, SHORT_HISTORY_DAYS) &&
      range.first < addDays(first, -SHORT_HISTORY_DAYS))
  ) {
    throw cutShort();
  }
}

type Stored = { close: number };

// stored final days the answer prices again with a close that moved
function movedDays(
  db: Db,
  id: string,
  bars: readonly Bar[],
): { date: string; ratio: number }[] {
  const stored = db.query<Stored, [string, string]>(
    `select close from bars where instrument = ? and interval = '1d'
     and date = ? and final = 1`,
  );
  const out: { date: string; ratio: number }[] = [];
  for (const b of bars) {
    const s = stored.get(id, b.date);
    if (s === null || s.close <= 0) continue;
    const ratio = b.close / s.close;
    if (Math.abs(ratio - 1) > MOVED) out.push({ date: b.date, ratio });
  }
  return out;
}

// Yahoo's rule finds the ratio on final days; the corporate action is
// the first day after the last stored one on the old scale, final or not:
// the next answered bar, or the session's day before its first bar.
function rescaleIn(
  db: Db,
  id: string,
  bars: readonly Bar[],
  latest: Session | null,
): { date: string | null; ratio: number } | null {
  const found = rescaleOf(db, { id }, bars);
  if (found === null) return null;
  const stored = db.query<Stored, [string, string]>(
    "select close from bars where instrument = ? and interval = '1d' and date = ?",
  );
  const sorted = [...bars].sort((x, y) => (x.date < y.date ? -1 : 1));
  let last = found.dates.at(-1)!;
  for (const b of sorted) {
    if (b.date <= last) continue;
    const s = stored.get(id, b.date);
    if (
      s === null ||
      s.close <= 0 ||
      !sameRatio(b.close / s.close, found.ratio)
    )
      break;
    last = b.date;
  }
  const next = sorted.find((b) => b.date > last)?.date;
  const today = latest === null ? null : sessionDate(latest);
  return {
    date: next ?? (today !== null && today > last ? today : null),
    ratio: found.ratio,
  };
}

export function storeWindow(
  db: Db,
  now: number,
  instrument: Instrument,
  history: History,
  rules: RuleHooks = NO_RULES,
): Written {
  const latest = readSession(db, MARKET);
  const bars = barsOf(history, latest);
  const written = upsertBars(db, instrument.id, "1d", bars, history.fetchedAt);
  let deleted: string | null = null;
  if (bars.length > 0) {
    const keep = new Set(bars.map((b) => b.date));
    deleted = deleteDailyBars(
      db,
      instrument.id,
      bars[0]!.date,
      bars.at(-1)!.date,
      keep,
    );
    rebuildWeeks(db, instrument.id, latest, now, bars[0]!.date);
  }
  const changedFrom = earliest(deleted, written.changedFrom);
  signalsAfterBars(db, instrument, changedFrom, now);
  rules.evaluate(db, [instrument.id], now);
  return { rows: written.rows, changedFrom };
}

// A whole history replaces every stored day; one that would leave a
// stored day on the old scale is refused and nothing is written. A
// rescale is kept as a split, which keeps volume ratios from spanning it:
// the feed's volumes stay raw beside adjusted prices.
export function storeWhole(
  db: Db,
  now: number,
  instrument: Instrument,
  history: History,
  since: string,
  rules: RuleHooks = NO_RULES,
): Written {
  const latest = readSession(db, MARKET);
  const bars = barsOf(history, latest).filter((b) => b.date >= since);
  const range = dailyRange(db, instrument.id);
  const moved = movedDays(db, instrument.id, bars);
  const rescale = rescaleIn(db, instrument.id, bars, latest);
  checkCovers(
    db,
    instrument.id,
    bars.map((b) => b.date),
    since,
    moved.length > 0,
  );
  let deleted: string | null = null;
  if (bars.length > 0) {
    const keep = new Set(bars.map((b) => b.date));
    const from =
      range !== null && range.first < bars[0]!.date
        ? range.first
        : bars[0]!.date;
    deleted = deleteDailyBars(db, instrument.id, from, bars.at(-1)!.date, keep);
  }
  const written = upsertBars(db, instrument.id, "1d", bars, history.fetchedAt);
  if (rescale?.date != null) {
    const factor = 1 / rescale.ratio;
    db.query(
      `insert into splits (instrument, date, numerator, denominator, ratio,
         applied_at)
       values (?, ?, ?, 1, ?, ?)
       on conflict (instrument, date) do update set
         numerator = excluded.numerator, denominator = 1,
         ratio = excluded.ratio, applied_at = excluded.applied_at`,
    ).run(
      instrument.id,
      rescale.date,
      factor,
      `${Number(factor.toPrecision(6))}:1`,
      now,
    );
  }
  if (rescale !== null) rules.rescaled(db, instrument.id, now);
  rebuildWeeks(db, instrument.id, latest, now);
  const changedFrom = earliest(deleted, written.changedFrom);
  signalsAfterBars(db, instrument, changedFrom, now);
  rules.evaluate(db, [instrument.id], now);
  return { rows: written.rows, changedFrom };
}

// an ok run in the instrument's scope clears only its own failed refetch
export function barsAnswered(
  db: Db,
  instrument: Instrument,
  written: Written,
  now: number,
): Written {
  endRun(
    db,
    startRun(db, SOURCE, JOBS.bars, now, instrument.id),
    now,
    written.rows,
  );
  return written;
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

// an AeRO share is on no list a quote pass reads, so it would never be quoted
export async function checkListed(ctx: BvbContext, meta: Meta): Promise<void> {
  if (KINDS[meta.type]?.type !== "EQUITY") return;
  const page = await ctx.bvb.shares();
  const symbol = meta.symbol.toUpperCase();
  if (!page.rows.some((r) => r.symbol.toUpperCase() === symbol)) {
    throw new Refused(AERO);
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
