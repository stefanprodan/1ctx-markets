// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Rules run inside the write that moved their inputs, so the quote,
// signals and rule are read in one transaction.

import type { Db } from "../db/index.ts";
import {
  type EventKey,
  type EventRow,
  type Hooks,
  readEvent,
} from "../finnhub/store.ts";
import { type Instrument, readInstrument } from "../instruments.ts";
import { errorFields, type Log, silent } from "../log.ts";
import { iso, price, round } from "../market/format.ts";
import {
  type InstrumentSignals,
  readRelativeReturn,
  readSignals,
} from "../signals/read.ts";
import { barsStale, quoteStale, STALE } from "../stale.ts";
import {
  type Comparison,
  comparisons,
  FIELDS,
  hasQuote,
  instrumentsOf,
  isComparison,
  type Node,
  type Op,
  type Operand,
  PRICE_LEVEL,
  splitSensitive,
  writeCondition,
} from "./format.ts";
import type { RuleHooks } from "./hooks.ts";
import {
  insertAlert,
  type Result,
  type RuleRow,
  readRules,
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
export const WAITING = "waiting for the earnings results";
export const BEFORE_RESULTS = "prices from before the earnings results";
export const UNTIMED =
  "a live price with no trade time may be from before the earnings results";

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
function reader(db: Db, now: number, quoteEveryMs: number) {
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
        },
        [string]
      >(
        `select price, previous_close as previousClose,
           change_percent as changePercent, day_high as dayHigh,
           day_low as dayLow, time from quotes where instrument = ?`,
      )
      .get(id);

  const liveReasons = (id: string): string[] => signalsOf(id)?.stale.live ?? [];

  return {
    instrument,
    read(o: Operand): Read {
      const i = instrument(o.symbol);
      const def = FIELDS[o.field]!;
      const of = `${o.field} of ${o.symbol}`;
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
    barsPending(id: string): boolean {
      const i = instrument(id);
      return (
        i !== null &&
        hasQuote(i) &&
        barsStale(db, i, now).includes(STALE.barsPending)
      );
    },
  };
}

type Reader = ReturnType<typeof reader>;

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

function evaluateWith(r: Reader, db: Db, rule: RuleRow): Evaluation {
  const reasons: string[] = [];
  const times: number[] = [];
  let untimed = false;
  const values = new Map<Comparison, boolean>();
  const shownValues: ComparisonValue[] = [];
  for (const c of comparisons<Comparison>(rule.condition.node)) {
    const left = r.read(c.left);
    const right = typeof c.right === "number" ? null : r.read(c.right);
    const own = [...left.reasons, ...(right?.reasons ?? [])];
    for (const id of new Set([
      c.left.symbol,
      ...(right ? [(c.right as Operand).symbol] : []),
    ])) {
      if (splitSensitive(c, id) && r.barsPending(id)) {
        own.push(`${id}: ${BARS_PENDING}`);
      }
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

// Evaluates one rule and moves its state, in the caller's transaction.
export function applyRule(
  db: Db,
  rule: RuleRow,
  now: number,
  quoteEveryMs: number,
  r: Reader = reader(db, now, quoteEveryMs),
): Outcome {
  const evaluation = evaluateWith(r, db, rule);
  let alert: Fired | null = null;
  let armed = rule.armed;
  if (evaluation.result === "true" && armed) {
    const gate = gateItem(rule, eventOf(db, rule));
    const snapshot: Snapshot = {
      rule: {
        id: rule.id,
        symbol: rule.instrument,
        condition: JSON.parse(writeCondition(rule.condition)),
        note: rule.note,
      },
      ...(gate === null ? {} : { after_earnings: gate }),
      values: evaluation.values,
    };
    alert = {
      id: insertAlert(db, rule.id, snapshot, now),
      firedAt: now,
      snapshot,
    };
    armed = false;
  } else if (evaluation.result === "false") {
    armed = true;
  }
  recordResult(db, rule.id, evaluation.result, armed, now);
  return { evaluation, alert };
}

const reads = (rule: RuleRow): Set<string> => {
  const ids = instrumentsOf(rule.condition);
  ids.add(rule.instrument);
  return ids;
};

export type Engine = RuleHooks & {
  // what the research jobs and reads ask of the rules
  finnhub: Hooks;
  quoteEveryMs: number;
};

// A failing rule never fails the source write it rides on: it is
// logged, and the write and the other rules go on.
export function ruleEngine(options: {
  quoteEveryMs: number;
  log?: Log;
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
        }
      });
    }
  };
  return {
    quoteEveryMs,
    evaluate(db, instruments, now) {
      guarded("rule evaluation failed", () => {
        const moved = new Set(instruments);
        if (moved.size === 0) return;
        const due = readRules(db, { active: true }).filter((rule) =>
          [...reads(rule)].some((id) => moved.has(id)),
        );
        run(db, due, now);
      });
    },
    rescaled(db, instrument) {
      guarded("rule split check failed", () => {
        for (const rule of readRules(db)) {
          if (rule.paused === "split") continue;
          if (
            comparisons<Comparison>(rule.condition.node).some((c) =>
              splitSensitive(c, instrument),
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
        for (const rule of readRules(db)) {
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
          const due = readRules(db, { active: true }).filter((rule) => {
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
