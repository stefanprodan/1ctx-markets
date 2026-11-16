// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// Rules run inside the write that moved their inputs, in one transaction.

import {
  barDate,
  closeQuoteAt,
  readSession,
  sessionDate,
  weekOf,
} from "../market/calendars.ts";
import { iso, price, round } from "../market/format.ts";
import { type Instrument, readInstrument } from "../market/instruments.ts";
import { barsStale, JOBS, quoteStale, STALE } from "../market/stale.ts";
import { addDays, localDate, wallOfDate } from "../market/zone.ts";
import { errorFields, type Log, silent } from "../runtime/log.ts";
import type { TriggerOn } from "../shared/when.ts";
import {
  type InstrumentSignals,
  readRelativeReturn,
  readSignals,
} from "../signals/read.ts";
import { selectList } from "../signals/store.ts";
import { liveTarget } from "../signals/target.ts";
import { type EventRow, readEvent } from "../sources/finnhub/read.ts";
import type { EventKey, Hooks } from "../sources/finnhub/store.ts";
import type { Db } from "../storage/db/index.ts";
import { failedRun, lastRun } from "../storage/runs.ts";
import {
  CLOSE_NO_RELATIVE,
  type Comparison,
  comparisons,
  FIELDS,
  type FieldDef,
  hasQuote,
  instrumentsOf,
  isComparison,
  type Node,
  type Op,
  type Operand,
  PRICE_LEVEL,
  publicField,
  type QuoteColumn,
  splitSensitive,
  writeCondition,
} from "./format.ts";
import type { RuleHooks } from "./hooks.ts";
import {
  allRules,
  insertAlert,
  type Result,
  type RuleRow,
  recordResult,
  setPaused,
} from "./store.ts";

export type OperandValue = Operand & {
  value: number | null;
  // a live value's trade time, null for one read from a closed day
  trade_time: string | null;
};

export type ComparisonValue = {
  left: OperandValue;
  op: Op;
  right: number | OperandValue;
  // null while either side is unknown
  holds: boolean | null;
};

export type Evaluation = {
  result: Result;
  values: ComparisonValue[];
  // why the rule is unknown, or what its earnings gate waits for
  reasons: string[];
};

export type Fired = { id: number; firedAt: number; snapshot: Snapshot };

export type Outcome = { evaluation: Evaluation; alert: Fired | null };

export type Snapshot = {
  rule: {
    id: number;
    symbol: string;
    condition: unknown;
    note: string | null;
  };
  // absent from triggers stored before alerts waited for a close
  on?: TriggerOn;
  // the session it fired in: the closed bar's date, a week's Monday
  session?: string | null;
  after_earnings?: GateItem;
  values: ComparisonValue[];
};

export type GateItem = {
  symbol: string;
  fiscal_year: number;
  fiscal_quarter: number;
  date: string | null;
  reported_seen_at: string | null;
};

export const BARS_PENDING =
  "bars of the new session not refetched yet, so a split may be unseen";
export const BARS_FAILED = "its bars refetch failed, so a split may be unseen";
export const WAITING = "waiting for the earnings results";
export const BEFORE_RESULTS = "prices from before the earnings results";
export const UNTIMED =
  "a live price with no trade time may be from before the earnings results";
export const NO_SESSION = "no session date";

export type CloseAt = {
  session: string;
  // the final daily bar read; null reads the close pass's quote and live rows
  bar: string | null;
};

const isFriday = (date: string) => new Date(wallOfDate(date)).getUTCDay() === 5;

type Read = {
  value: number | null;
  // the trade times of the live quotes the value came from
  times: number[];
  // a live quote it came from has no trade time
  untimed?: boolean;
  // why the value cannot be used, empty when it can
  reasons: string[];
};

// one reader per evaluation pass, so rules sharing an input read it once
export function reader(db: Db, now: number, quoteEveryMs: number) {
  const instruments = new Map<string, Instrument | null>();
  const signals = new Map<string, InstrumentSignals | null>();
  const instrument = (id: string) => {
    if (!instruments.has(id)) instruments.set(id, readInstrument(db, id));
    return instruments.get(id)!;
  };
  const signalsOf = (id: string) => {
    if (!signals.has(id)) {
      signals.set(id, readSignals(db, id, now, quoteEveryMs));
    }
    return signals.get(id)!;
  };
  const quote = (id: string) =>
    db
      .query<
        {
          price: number;
          previousClose: number | null;
          changePercent: number | null;
          dayHigh: number | null;
          dayLow: number | null;
          time: number | null;
          fetchedAt: number;
        },
        [string]
      >(
        `select price, previous_close as previousClose,
           change_percent as changePercent, day_high as dayHigh,
           day_low as dayLow, time, fetched_at as fetchedAt
         from quotes where instrument = ?`,
      )
      .get(id);

  const liveReasons = (id: string): string[] => signalsOf(id)?.stale.live ?? [];
  const sessions = new Map<string, string | null>();
  // an untimed quote before the stored session opens is still the last one's
  const lastBar = (id: string) =>
    db
      .query<{ date: string }, [string]>(
        `select date from bars where instrument = ? and interval = '1d'
         order by date desc limit 1`,
      )
      .get(id)?.date ?? null;

  const lastFinal = (
    id: string,
    interval: "1d" | "1wk",
    before: string | null = null,
  ) =>
    db
      .query<{ date: string }, [string, string, string | null]>(
        `select date from bars where instrument = ?1 and interval = ?2
           and final = 1 and (?3 is null or date < ?3)
         order by date desc limit 1`,
      )
      .get(id, interval, before)?.date ?? null;
  const unsettled = (
    id: string,
    interval: "1d" | "1wk",
    after: string | null,
    before: string,
  ) =>
    db
      .query<{ n: number }, [string, string, string | null, string]>(
        `select exists (select 1 from bars where instrument = ?1
           and interval = ?2 and final = 0 and (?3 is null or date > ?3)
           and date < ?4) as n`,
      )
      .get(id, interval, after, before)!.n === 1;
  const finalRows = new Map<string, Record<string, number | null> | null>();
  const finalRow = (id: string, interval: "1d" | "1wk", date: string) => {
    const key = `${id}|${interval}|${date}`;
    if (!finalRows.has(key)) {
      finalRows.set(
        key,
        db
          .query<Record<string, number | null>, [string, string, string]>(
            `select ${selectList(interval)} from signals where instrument = ?
               and interval = ? and kind = 'final' and date = ?`,
          )
          .get(id, interval, date),
      );
    }
    return finalRows.get(key)!;
  };

  // its last trade's date in its exchange's zone, never the clock's
  const session = (id: string): string | null => {
    if (!sessions.has(id)) {
      const i = instrument(id);
      let date: string | null = null;
      if (i !== null && !hasQuote(i)) {
        date = signalsOf(i.id)?.daily.final?.date ?? null;
      } else if (i !== null) {
        const time = quote(i.id)?.time;
        date =
          time === undefined
            ? null
            : time === null
              ? (liveTarget(db, i)?.date ?? lastBar(i.id))
              : barDate(i.zone, time);
      }
      sessions.set(id, date);
    }
    return sessions.get(id)!;
  };

  // a final value, judged by the final rows' own staleness
  const valued = (o: Operand, value: number | null, missing: string): Read => {
    const of = `${publicField(o.field)} of ${o.symbol}`;
    return {
      value,
      times: [],
      reasons: [
        ...(value === null ? [`${of}: ${missing}`] : []),
        ...(signalsOf(o.symbol)?.stale.final ?? []).map((r) => `${of}: ${r}`),
      ],
    };
  };

  const readWeek = (o: Operand, monday: string): Read => {
    const def = FIELDS[o.field] as Extract<FieldDef, { from: "weekly" }>;
    const row = finalRow(o.symbol, "1wk", monday);
    if (row === null) {
      return valued(o, null, `no final weekly row for the week of ${monday}`);
    }
    return valued(o, row[def.key] ?? null, "no value yet");
  };

  return {
    instrument,
    session,
    closeAt(rule: RuleRow): CloseAt | null {
      const i = instrument(rule.instrument);
      if (i === null || !hasQuote(i)) return null;
      const weekly = rule.triggerOn === "weekly_close";
      const open = (at: string) =>
        rule.closedSession === null || at > rule.closedSession;
      const day = session(i.id);
      const latest = readSession(db, i.market);
      const q = quote(i.id);
      if (day !== null && latest !== null && q !== null) {
        const pass = closeQuoteAt(i.market, latest);
        // a session the stored one has moved past reads from final rows only
        if (
          day === sessionDate(latest) &&
          pass !== null &&
          q.fetchedAt >= pass
        ) {
          const at = weekly ? (isFriday(day) ? weekOf(day) : null) : day;
          if (at !== null && open(at)) return { session: at, bar: null };
        }
      }
      // a newer bar that closed but is not final yet is waited for, so an
      // older one is never read in its place
      const today = latest === null ? null : sessionDate(latest);
      const waits = (final: string | null, interval: "1d" | "1wk") =>
        today !== null &&
        unsettled(
          i.id,
          interval,
          final,
          interval === "1d" ? today : weekOf(today),
        );
      if (!weekly) {
        const bar = lastFinal(i.id, "1d");
        if (waits(bar, "1d")) return null;
        return bar !== null && open(bar) ? { session: bar, bar } : null;
      }
      const week = lastFinal(i.id, "1wk");
      if (waits(week, "1wk")) return null;
      if (week === null || !open(week)) return null;
      const bar = lastFinal(i.id, "1d", addDays(week, 7));
      return bar !== null && weekOf(bar) === week
        ? { session: week, bar }
        : null;
    },
    readFinal(o: Operand, bar: string): Read {
      const i = instrument(o.symbol);
      const def = FIELDS[o.field]!;
      if (i === null) return valued(o, null, "not stored");
      if (def.from === "relative") return valued(o, null, CLOSE_NO_RELATIVE);
      if (def.from === "quote") {
        const [b, prev] = db
          .query<
            {
              date: string;
              high: number | null;
              low: number | null;
              close: number;
              final: number;
            },
            [string, string]
          >(
            `select date, high, low, close, final from bars where instrument = ?
               and interval = '1d' and date <= ? order by date desc limit 2`,
          )
          .all(i.id, bar);
        if (b === undefined || b.date !== bar || b.final !== 1) {
          return valued(o, null, `no final bar for ${bar}`);
        }
        const before = prev?.close ?? null;
        const values: Record<QuoteColumn, number | null> = {
          price: b.close,
          dayHigh: b.high,
          dayLow: b.low,
          previousClose: before,
          changePercent: before ? ((b.close - before) / before) * 100 : null,
        };
        return valued(o, values[def.column], "no value");
      }
      if (def.from === "weekly") return readWeek(o, weekOf(bar));
      const row = finalRow(i.id, "1d", bar);
      if (row === null) {
        return valued(o, null, `no final signal row for ${bar}`);
      }
      return valued(o, row[def.key] ?? null, "no value yet");
    },
    readWeek,
    read(o: Operand): Read {
      const i = instrument(o.symbol);
      const def = FIELDS[o.field]!;
      const of = `${publicField(o.field)} of ${o.symbol}`;
      if (i === null)
        return { value: null, times: [], reasons: [`${of}: not stored`] };
      if (def.from === "quote") {
        const q = quote(i.id);
        const stale = quoteStale(db, i, { now, everyMs: quoteEveryMs });
        const value = q?.[def.column] ?? null;
        return {
          value,
          times: q !== null && q.time !== null && def.live ? [q.time] : [],
          untimed: q !== null && q.time === null && def.live,
          reasons: [
            ...(value === null ? [`${of}: no value`] : []),
            ...stale.map((r) => `${of}: ${r}`),
          ],
        };
      }
      if (def.from === "relative") {
        const bench = o.benchmark!;
        const r = readRelativeReturn(db, i.id, bench, def.months);
        const stale = [
          ...liveReasons(i.id).map((r) => `${of}: ${r}`),
          ...liveReasons(bench).map((r) => `${of}: benchmark ${bench}: ${r}`),
        ];
        if (r === null || !r.live) {
          return {
            value: null,
            times: [],
            reasons: [`${of}: no live relative return`, ...stale],
          };
        }
        const quoted = [quote(i.id)?.time, quote(bench)?.time];
        const times = quoted.filter((t): t is number => typeof t === "number");
        return {
          value: r.relative,
          times,
          untimed: quoted.includes(null),
          reasons: stale,
        };
      }
      const s = signalsOf(i.id);
      const rows = def.from === "daily" ? s?.daily : s?.weekly;
      // a series with no quotes has final rows only
      const live = hasQuote(i);
      const row = live ? rows?.live : rows?.final;
      const value =
        row === null || row === undefined
          ? null
          : ((row as unknown as Record<string, number | null>)[def.key] ??
            null);
      const stale = (live ? s?.stale.live : s?.stale.final) ?? [];
      return {
        value,
        times:
          live && row !== null && row !== undefined && "quoteTime" in row
            ? [row.quoteTime as number]
            : [],
        // a live row from an untimed quote is dated by its fetch
        untimed:
          live &&
          row !== null &&
          row !== undefined &&
          quote(i.id)?.time === null,
        reasons: [
          ...(row === null || row === undefined
            ? [`${of}: no ${live ? "live" : "final"} signal row`]
            : value === null
              ? [`${of}: no value yet`]
              : []),
          ...stale.map((r) => `${of}: ${r}`),
        ],
      };
    },
    // its own failed refetch counts too: the market's pass can succeed
    // without this listing's bars, which are what would show a split
    barsUnsettled(id: string): string | null {
      const i = instrument(id);
      if (i === null || !hasQuote(i)) return null;
      if (barsStale(db, i, now).includes(STALE.barsPending)) {
        return BARS_PENDING;
      }
      return failedRun(lastRun(db, i.source, JOBS.bars, i.id))
        ? BARS_FAILED
        : null;
    },
  };
}

export type Reader = ReturnType<typeof reader>;

const holds = (l: number, op: Op, r: number): boolean => {
  switch (op) {
    case "<":
      return l < r;
    case "<=":
      return l <= r;
    case ">":
      return l > r;
    case ">=":
      return l >= r;
  }
};

const shown = (o: Operand, value: number | null): number | null =>
  FIELDS[o.field]!.unit === PRICE_LEVEL ? price(value) : round(value);

export function gateItem(rule: RuleRow, e: EventRow | null): GateItem | null {
  const g = rule.condition.afterEarnings;
  if (g === null) return null;
  return {
    symbol: g.symbol,
    fiscal_year: g.fiscalYear,
    fiscal_quarter: g.fiscalQuarter,
    date: e?.date ?? null,
    reported_seen_at: iso(e?.reportedSeenAt ?? null),
  };
}

export const eventOf = (db: Db, rule: RuleRow): EventRow | null => {
  const g = rule.condition.afterEarnings;
  return g === null
    ? null
    : readEvent(db, {
        instrument: g.symbol,
        fiscalYear: g.fiscalYear,
        fiscalQuarter: g.fiscalQuarter,
      });
};

const MACD = new Set(["macd", "macdSignal", "macdHistogram"]);

// MACD's sign survives a split, since its averages scale together; only
// the split's own session mixes scales, so splitSensitive() still holds it
function splitPauses(c: Comparison, instrument: string): boolean {
  if (c.right === 0 && MACD.has(c.left.field)) return false;
  return splitSensitive(c, instrument);
}

function evaluateWith(
  r: Reader,
  db: Db,
  rule: RuleRow,
  at: CloseAt | null = null,
): Evaluation {
  const bar = at?.bar ?? null;
  // a daily close reads weekly fields as of the last completed week, so
  // the close pass and a final bar read the same row
  const week =
    at !== null && rule.triggerOn === "close"
      ? addDays(weekOf(at.session), -7)
      : null;
  const read = (o: Operand) =>
    week !== null && FIELDS[o.field]!.from === "weekly"
      ? r.readWeek(o, week)
      : bar === null
        ? r.read(o)
        : r.readFinal(o, bar);
  const reasons: string[] = [];
  const times: number[] = [];
  let untimed = false;
  const values = new Map<Comparison, boolean>();
  const shownValues: ComparisonValue[] = [];
  for (const c of comparisons<Comparison>(rule.condition.node)) {
    const left = read(c.left);
    const right = typeof c.right === "number" ? null : read(c.right);
    const own = [...left.reasons, ...(right?.reasons ?? [])];
    for (const id of new Set([
      c.left.symbol,
      ...(right ? [(c.right as Operand).symbol] : []),
    ])) {
      const unsettled = splitSensitive(c, id) ? r.barsUnsettled(id) : null;
      if (unsettled !== null) own.push(`${id}: ${unsettled}`);
    }
    const rv = typeof c.right === "number" ? c.right : right!.value;
    const ok = own.length === 0 && left.value !== null && rv !== null;
    if (ok) {
      values.set(c, holds(left.value!, c.op, rv!));
      times.push(...left.times, ...(right?.times ?? []));
      untimed ||= left.untimed === true || right?.untimed === true;
    }
    reasons.push(...own);
    shownValues.push({
      left: {
        ...c.left,
        value: shown(c.left, left.value),
        trade_time: iso(left.times.length > 0 ? Math.min(...left.times) : null),
      },
      op: c.op,
      right:
        typeof c.right === "number"
          ? c.right
          : {
              ...c.right,
              value: shown(c.right, right!.value),
              trade_time: iso(
                right!.times.length > 0 ? Math.min(...right!.times) : null,
              ),
            },
      holds: ok ? values.get(c)! : null,
    });
  }
  // with no date a true could not tell a new session from the fired one
  if (bar === null && r.session(rule.instrument) === null) {
    reasons.push(`${rule.instrument}: ${NO_SESSION}`);
  }
  const unique = [...new Set(reasons)];
  if (unique.length > 0) {
    return { result: "unknown", values: shownValues, reasons: unique };
  }
  if (rule.condition.afterEarnings !== null) {
    const e = eventOf(db, rule);
    if (e === null) {
      return {
        result: "unknown",
        values: shownValues,
        reasons: ["the earnings event is no longer stored"],
      };
    }
    if (e.reportedSeenAt === null) {
      return { result: "false", values: shownValues, reasons: [WAITING] };
    }
    // a final bar has no trade time to tell a report before its open
    // from one after its close, so its own day never counts
    if (bar !== null) {
      const zone = r.instrument(rule.instrument)?.zone ?? "UTC";
      if (bar <= localDate(zone, e.reportedSeenAt)) {
        return {
          result: "unknown",
          values: shownValues,
          reasons: [BEFORE_RESULTS],
        };
      }
    }
    if (untimed) {
      return { result: "unknown", values: shownValues, reasons: [UNTIMED] };
    }
    // a price traded before the results were seen says nothing of them
    if (times.some((t) => t <= e.reportedSeenAt!)) {
      return {
        result: "unknown",
        values: shownValues,
        reasons: [BEFORE_RESULTS],
      };
    }
  }
  const walk = (n: Node): boolean =>
    isComparison(n)
      ? values.get(n)!
      : "all" in n
        ? n.all.every(walk)
        : n.any.some(walk);
  return {
    result: walk(rule.condition.node) ? "true" : "false",
    values: shownValues,
    reasons: [],
  };
}

// what the engine would answer now, stored nowhere: one reader for them all
export function evaluateRules(
  db: Db,
  rules: readonly RuleRow[],
  now: number,
  quoteEveryMs: number,
  r: Reader = reader(db, now, quoteEveryMs),
): Evaluation[] {
  return rules.map((rule) => evaluateWith(r, db, rule));
}

// its next true result fires: armed, and in a session it has not fired in
export function firesNext(r: Reader, rule: RuleRow): boolean {
  const s = r.session(rule.instrument);
  const at = s !== null && rule.triggerOn === "weekly_close" ? weekOf(s) : s;
  return rule.armed && later(at, rule.firedSession);
}

// later, never just other: a fallback date can be older than the fired one
const later = (session: string | null, fired: string | null): boolean =>
  session !== null && (fired === null || session > fired);

// in the caller's transaction
export function applyRule(
  db: Db,
  rule: RuleRow,
  now: number,
  quoteEveryMs: number,
  r: Reader = reader(db, now, quoteEveryMs),
): Outcome {
  if (rule.triggerOn !== "touch") return applyClose(db, rule, now, r);
  const evaluation = evaluateWith(r, db, rule);
  return record(
    db,
    rule,
    evaluation,
    r.session(rule.instrument),
    now,
    rule.closedSession,
  );
}

// once per closed bar: a revised close neither retriggers nor retracts
function applyClose(db: Db, rule: RuleRow, now: number, r: Reader): Outcome {
  const at = r.closeAt(rule);
  if (at === null) {
    return { evaluation: evaluateWith(r, db, rule), alert: null };
  }
  const evaluation = evaluateWith(r, db, rule, at);
  const spent =
    evaluation.result !== "unknown" ||
    (evaluation.reasons.length === 1 &&
      evaluation.reasons[0] === BEFORE_RESULTS);
  if (!spent) return { evaluation, alert: null };
  return record(db, rule, evaluation, at.session, now, at.session);
}

function record(
  db: Db,
  rule: RuleRow,
  evaluation: Evaluation,
  session: string | null,
  now: number,
  closedSession: string | null,
): Outcome {
  let alert: Fired | null = null;
  let armed = rule.armed;
  let firedSession = rule.firedSession;
  // still true in the session it fired in: no alert, and it stays armed
  if (evaluation.result === "true" && armed && later(session, firedSession)) {
    const gate = gateItem(rule, eventOf(db, rule));
    const snapshot: Snapshot = {
      rule: {
        id: rule.id,
        symbol: rule.instrument,
        condition: JSON.parse(writeCondition(rule.condition)),
        note: rule.note,
      },
      on: rule.triggerOn,
      session,
      ...(gate === null ? {} : { after_earnings: gate }),
      values: evaluation.values,
    };
    alert = {
      id: insertAlert(db, rule, snapshot, now),
      firedAt: now,
      snapshot,
    };
    armed = false;
    firedSession = session;
  } else if (evaluation.result === "false") {
    armed = true;
  }
  recordResult(
    db,
    rule.id,
    { result: evaluation.result, armed, firedSession, closedSession },
    now,
  );
  return { evaluation, alert };
}

const reads = (rule: RuleRow): Set<string> => {
  const ids = instrumentsOf(rule.condition);
  ids.add(rule.instrument);
  return ids;
};

export type Engine = RuleHooks & {
  finnhub: Hooks;
  quoteEveryMs: number;
};

// A failing rule never fails the source write it rides on: it is
// logged, and the write and the other rules go on.
export function ruleEngine(options: {
  quoteEveryMs: number;
  log?: Log;
  fired?: () => void;
}): Engine {
  const { quoteEveryMs } = options;
  const log = options.log ?? silent;
  const guarded = (what: string, fn: () => void) => {
    try {
      fn();
    } catch (error) {
      log.error(what, errorFields(error));
    }
  };
  const run = (db: Db, rules: RuleRow[], now: number) => {
    const r = reader(db, now, quoteEveryMs);
    for (const rule of rules) {
      guarded("rule evaluation failed", () => {
        const { alert } = applyRule(db, rule, now, quoteEveryMs, r);
        if (alert !== null) {
          log.info("rule fired", { rule: rule.id, alert: alert.id });
          options.fired?.();
        }
      });
    }
  };
  return {
    quoteEveryMs,
    fired: () => options.fired?.(),
    evaluate(db, instruments, now) {
      guarded("rule evaluation failed", () => {
        const moved = new Set(instruments);
        if (moved.size === 0) return;
        const due = allRules(db, { active: true }).filter((rule) =>
          [...reads(rule)].some((id) => moved.has(id)),
        );
        run(db, due, now);
      });
    },
    rescaled(db, instrument) {
      guarded("rule split check failed", () => {
        for (const rule of allRules(db)) {
          if (rule.paused === "split") continue;
          if (
            comparisons<Comparison>(rule.condition.node).some((c) =>
              splitPauses(c, instrument),
            )
          ) {
            setPaused(db, rule.id, "split");
            log.info("rule paused by a split", { rule: rule.id, instrument });
          }
        }
      });
    },
    finnhub: {
      waited(db) {
        const keys = new Map<string, EventKey>();
        for (const rule of allRules(db)) {
          const g = rule.condition.afterEarnings;
          if (g === null) continue;
          keys.set(`${g.symbol}|${g.fiscalYear}|${g.fiscalQuarter}`, {
            instrument: g.symbol,
            fiscalYear: g.fiscalYear,
            fiscalQuarter: g.fiscalQuarter,
          });
        }
        return [...keys.values()];
      },
      reported(db, events, now) {
        guarded("rule evaluation failed", () => {
          const seen = new Set(
            events.map(
              (e) => `${e.instrument}|${e.fiscalYear}|${e.fiscalQuarter}`,
            ),
          );
          const due = allRules(db, { active: true }).filter((rule) => {
            const g = rule.condition.afterEarnings;
            return (
              g !== null &&
              seen.has(`${g.symbol}|${g.fiscalYear}|${g.fiscalQuarter}`)
            );
          });
          run(db, due, now);
        });
      },
    },
  };
}
