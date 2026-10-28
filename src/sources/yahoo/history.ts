// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import {
  type Bar,
  dailyRange,
  deleteDailyBars,
  earliest,
  rebuildWeeks,
  upsertBars,
  type Written,
} from "../../market/bars.ts";
import {
  barDate,
  isBarFinal,
  readSession,
  recordSession,
  type Session,
  sessionDate,
} from "../../market/calendars.ts";
import {
  type Instrument,
  readInstrument,
  type Unit,
} from "../../market/instruments.ts";
import { clearIntraday } from "../../market/intraday.ts";
import { JOBS } from "../../market/stale.ts";
import { addDays, wallTime } from "../../market/zone.ts";
import { NO_RULES, type RuleHooks } from "../../rules/hooks.ts";
import { DAY_MS } from "../../runtime/clock.ts";
import { signalsAfterBars } from "../../signals/store.ts";
import type { Db } from "../../storage/db/index.ts";
import { endRun, startRun } from "../../storage/runs.ts";
import { type Rescale, rescaleOf, sameRatio } from "../history.ts";
import { SourceError } from "../source.ts";
import {
  type ChartAnswer,
  type ChartMeta,
  type ChartRow,
  SOURCE,
  type SplitEvent,
} from "./client.ts";
import { keyOf, marketOf, symbolOf } from "./resolve.ts";

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
export function read(answer: ChartAnswer, latest: Session | null): Read {
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
      (byDate.has(date) || isCurrency(answer.type))
    ) {
      // an FX day held only by this row is still a day the answer covers
      days.add(date);
      add(byDate, date, trailing, latest);
    }
  }
  return { bars: [...byDate.values()], days };
}

// FX answers stamp today's row at the live minute; CL=F's Sunday evening
// trades belong to Monday's bar, though its Sunday session has their date
const isCurrency = (type: string) => type.toUpperCase() === "CURRENCY";

type Settled = { bars: Bar[]; pointCloses: Set<string> };

// Yahoo closes a currency pair's day at about its open, so a final day
// closes at its session's last 5-minute close, else at the next day's
// open; untrusted, after a rescale, stored and point closes are old-scale
export function settle(
  db: Db,
  instrument: Pick<Instrument, "id" | "type">,
  bars: readonly Bar[],
  trusted = true,
): Settled {
  const pointCloses = new Set<string>();
  if (!isCurrency(instrument.type)) return { bars: [...bars], pointCloses };
  const closes = new Map<string, number>();
  if (trusted) {
    // a stored point close outlives its pruned points
    for (const r of db
      .query<{ date: string; close: number }, [string]>(
        `select date, close from bars where instrument = ?
         and interval = '1d' and point_close = 1`,
      )
      .all(instrument.id)) {
      closes.set(r.date, r.close);
    }
    for (const r of db
      .query<{ session: string; close: number }, [string]>(
        `select session, close from intraday i where instrument = ?1
         and at = (select max(at) from intraday
           where instrument = ?1 and session = i.session)`,
      )
      .all(instrument.id)) {
      closes.set(r.session, r.close);
    }
  }
  const last = bars.at(-1);
  const after =
    last === undefined
      ? null
      : (db
          .query<{ open: number | null }, [string, string]>(
            `select open from bars where instrument = ? and interval = '1d'
             and date > ? order by date limit 1`,
          )
          .get(instrument.id, last.date)?.open ?? null);
  const out = bars.map((b, k) => {
    if (!b.final) return b;
    const point = closes.get(b.date);
    if (point !== undefined) {
      pointCloses.add(b.date);
      return { ...b, close: point };
    }
    const next = k + 1 < bars.length ? bars[k + 1]!.open : after;
    return next === null ? b : { ...b, close: next };
  });
  return { bars: out, pointCloses };
}

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

export function checkAnswer(instrument: Instrument, answer: ChartMeta): void {
  const id = keyOf(answer.exchange, answer.symbol);
  if (id !== instrument.id) {
    throw new SourceError(
      "malformed answer",
      `${instrument.id} answered as ${id}`,
    );
  }
}

// an index is in points, a yield index's (^TNX) its yield in percent; FUTURE
// holds both per-barrel and per-bond prices, so is not guessed
export function unitOf(type: string): Unit {
  switch (type.toUpperCase()) {
    case "EQUITY":
    case "ETF":
    case "MUTUALFUND":
      return "per_share";
    case "CRYPTOCURRENCY":
    case "CURRENCY":
      return "per_unit";
    case "INDEX":
      return "index_points";
    default:
      return "unknown";
  }
}

export function fields(answer: ChartMeta) {
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
export function unapplied(
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
export function startsShort(answer: ChartAnswer, since: string): boolean {
  if (answer.firstTrade === null) return false;
  const first = read(answer, null).bars.find((b) => b.date >= since)?.date;
  if (first === undefined) return false;
  const listed = barDate(answer.session.zone, answer.firstTrade);
  const floor = listed > since ? listed : since;
  return first > addDays(floor, SHORT_HISTORY_DAYS);
}

export const cutShort = () =>
  new SourceError("malformed answer", "a history cut short");

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
  const { days } = answered;
  const owed = unclosed(db, instrument, latest, answered);
  const { bars, pointCloses } = settle(db, instrument, answered.bars);
  if (whole) {
    const since = (b: Bar) => b.date >= whole.since;
    const span = [...days].filter((d) => d >= whole.since).sort();
    const splits = unapplied(db, instrument, whole.splits);
    const found = rescaleOf(db, instrument, bars.filter(since));
    if (
      whole.rescale !== undefined &&
      !confirms(found, whole.rescale, db, instrument, bars.filter(since))
    ) {
      throw unconfirmed();
    }
    const rescaled = splits.length > 0 || found !== null;
    const settled = rescaled
      ? settle(db, instrument, answered.bars, false)
      : { bars, pointCloses };
    const kept = settled.bars.filter(since);
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
    const written = upsertBars(
      db,
      instrument.id,
      "1d",
      kept,
      answer.fetchedAt,
      settled.pointCloses,
    );
    recordSplits(db, instrument, splits, now);
    rebuildWeeks(db, instrument.id, latest, now);
    return {
      rows: written.rows,
      changedFrom: earliest(deleted, written.changedFrom),
      owed,
      rescaled,
    };
  }
  const written = upsertBars(
    db,
    instrument.id,
    "1d",
    bars,
    answer.fetchedAt,
    pointCloses,
  );
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
export function store(
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
  if (rescaled) {
    rules.rescaled(db, instrument.id, now);
    // no ratio is guessed: the next quote pass refills the session
    clearIntraday(db, instrument.id);
  }
  signalsAfterBars(db, instrument, written.changedFrom, now);
  rules.evaluate(db, [instrument.id], now);
  return written;
}

// at start, so stored pairs follow settle() with no manual step
export function settleStored(db: Db, now: number): void {
  const pairs = db
    .query<{ id: string }, [string]>(
      `select id from instruments where source = ?
       and upper(type) = 'CURRENCY' order by id`,
    )
    .all(SOURCE);
  const update = db.query(
    `update bars set close = ?, point_close = ?
     where instrument = ? and interval = '1d' and date = ?`,
  );
  for (const { id } of pairs) {
    const instrument = readInstrument(db, id)!;
    const stored = db
      .query<
        Omit<Bar, "final"> & { final: number; pointClose: number },
        [string]
      >(
        `select date, open, high, low, close, volume, final,
           point_close as pointClose
         from bars where instrument = ? and interval = '1d' order by date`,
      )
      .all(id);
    const { bars, pointCloses } = settle(
      db,
      instrument,
      stored.map((b) => ({ ...b, final: b.final === 1 })),
    );
    let changedFrom: string | null = null;
    bars.forEach((b, k) => {
      const s = stored[k]!;
      const point = pointCloses.has(b.date) ? 1 : 0;
      if (b.close === s.close && point === s.pointClose) return;
      update.run(b.close, point, id, b.date);
      if (b.close !== s.close) changedFrom ??= b.date;
    });
    if (changedFrom === null) continue;
    const latest = readSession(db, instrument.market);
    rebuildWeeks(db, id, latest, now, changedFrom);
    signalsAfterBars(db, instrument, changedFrom, now);
  }
}

// an ok run in the instrument's scope clears only its own failed refetch;
// one that left a day owed says so, for the bar job to ask again
export function barsAnswered(
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
