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
  isBarFinal,
  readSession,
  type Session,
  sessionDate,
} from "../../market/calendars.ts";
import type { Instrument } from "../../market/instruments.ts";
import { JOBS } from "../../market/stale.ts";
import { addDays } from "../../market/zone.ts";
import { NO_RULES, type RuleHooks } from "../../rules/hooks.ts";
import { signalsAfterBars } from "../../signals/store.ts";
import type { Db } from "../../storage/db/index.ts";
import { endRun, startRun } from "../../storage/runs.ts";
import { rescaleOf, sameRatio } from "../history.ts";
import { SourceError } from "../source.ts";
import { MARKET, SOURCE } from "./client.ts";
import type { History } from "./parse.ts";

// a close this far from the stored one has moved
const MOVED = 0.0001;
// a whole history this far short of the stored one is cut short
const SHORT_HISTORY_DAYS = 10;

export function barsOf(history: History, latest: Session | null): Bar[] {
  return history.bars.map((b) => ({
    ...b,
    final: latest !== null && isBarFinal(b.date, latest),
  }));
}

// a whole history that would leave stored days uncovered
export class CutShort extends SourceError {
  constructor() {
    super("malformed answer", "a history cut short");
  }
}

export const cutShort = () => new CutShort();

// a whole history must reach the stored last day and start near the asked or
// stored first day; every: it covers each stored day, as a rescale needs
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
export function movedDays(
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

// the ratio from final days, by Yahoo's rule; the action is the day after the
// last on the old scale, final or not: next bar, or the session's day before it
export function rescaleIn(
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

// a day left on the old scale refuses the whole history, writing nothing;
// a rescale is kept as a split so volume ratios never span it: volumes stay raw
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
