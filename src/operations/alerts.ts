// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// The owner's price alerts, as the tools and the routes answer them: a
// failed create or update changes nothing.

import { iso, price, round } from "../market/format.ts";
import { type Instrument, readInstrument } from "../market/instruments.ts";
import { localDate, wallOfDate } from "../market/zone.ts";
import {
  applyRule,
  type ComparisonValue,
  type Evaluation,
  evaluateRules,
  eventOf,
  type Fired,
  firesNext,
  type Reader,
  reader,
  type Snapshot,
  WAITING,
} from "../rules/evaluate.ts";
import {
  bindCondition,
  checkBound,
  FIELDS,
  type Gate,
  type InputCondition,
  inputSymbols,
  instrumentsOf,
  isComparison,
  MAX_INSTRUMENTS,
  MAX_NOTE,
  type Node,
  PRICE_LEVEL,
  parseWhenCondition,
  publicField,
  RuleError,
  readCondition,
  whenOperand,
  whenText,
  writeCondition,
} from "../rules/format.ts";
import {
  ALERTS_PAGE,
  type AlertRow,
  deleteRule,
  type HistoryFilter,
  insertRule,
  lastFired,
  type RuleRow,
  readHistory,
  readRule,
  readRules,
  setPaused,
  updateRule,
} from "../rules/store.ts";
import { errorFields, type Log } from "../runtime/log.ts";
import { recheck } from "../server/caller.ts";
import { MAX_WHEN, operandText } from "../shared/when.ts";
import { eventStatus, nextEvent } from "../sources/finnhub/read.ts";
import { eligible, NOT_COVERED } from "../sources/finnhub/store.ts";
import {
  cursor,
  errorResult,
  type Failure,
  fitPage,
  fits,
  readCursor,
  type ToolResult,
  textResult,
} from "./answer.ts";
import { ArgError, date, fields, quoted, text, textValues } from "./args.ts";
import type { Markets } from "./markets.ts";
import { researchTargets } from "./research.ts";
import {
  type ItemError,
  readTargets,
  restStored,
  storedInstrument,
  timeout,
} from "./targets.ts";
import { opens, type Who } from "./who.ts";

export const ALERT_EDITS = [
  "create",
  "update",
  "pause",
  "resume",
  "delete",
] as const;
type Edit = (typeof ALERT_EDITS)[number];

// the triggers one alert's read shows
export const LAST_TRIGGERS = 5;

// one message whether Finnhub is off or does not cover the instrument
export const NO_EVENT_SOURCE = "no event source for this instrument";
export const SPLIT_PAUSED =
  "paused by a split: its price levels are from before it; update it with new levels";

const EDIT_ARGS: Record<Edit, readonly string[]> = {
  create: ["action", "symbol", "when", "note", "after_earnings"],
  update: ["action", "id", "when", "note"],
  pause: ["action", "id"],
  resume: ["action", "id"],
  delete: ["action", "id"],
};

export type AlertsEdit =
  | {
      action: "create";
      symbol: string;
      condition: InputCondition;
      note: string | null;
    }
  // note undefined keeps it, null clears it
  | {
      action: "update";
      id: number;
      condition: InputCondition | null;
      note?: string | null;
    }
  | { action: "pause" | "resume" | "delete"; id: number };

export type AlertsRead = {
  id: number | null;
  symbol: string | null;
  history: boolean;
  since: string | null;
  next: string | null;
};

function alertId(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new ArgError("id must be an alert id, a positive integer");
  }
  return value;
}

function nextOf(value: unknown): string | null {
  if (value !== undefined && value !== null && typeof value !== "string") {
    throw new ArgError("next must be a string from an earlier answer");
  }
  return (value as string | undefined) ?? null;
}

function whenOf(value: unknown, gate: string | null): InputCondition {
  const t = text(value, "when", MAX_WHEN);
  try {
    return parseWhenCondition(t, gate);
  } catch (error) {
    if (error instanceof RuleError) throw new ArgError(error.message);
    throw error;
  }
}

const noteOf = (value: unknown): string | null =>
  value === undefined || value === null ? null : text(value, "note", MAX_NOTE);

export function parseAlertsEdit(input: unknown): AlertsEdit {
  const f = textValues(
    fields(input, ["action", "symbol", "when", "note", "after_earnings", "id"]),
    { ids: ["id"] },
  );
  if (
    typeof f.action !== "string" ||
    !(ALERT_EDITS as readonly string[]).includes(f.action)
  ) {
    throw new ArgError(`action must be one of ${ALERT_EDITS.join(", ")}`);
  }
  const action = f.action as Edit;
  for (const name of Object.keys(f)) {
    if (!EDIT_ARGS[action].includes(name)) {
      throw new ArgError(`${quoted(name)} is not an argument of ${action}`);
    }
  }
  switch (action) {
    case "create": {
      const symbol = text(f.symbol, "symbol");
      if (f.when === undefined) throw new ArgError("create needs when");
      const gate =
        f.after_earnings === undefined || f.after_earnings === null
          ? null
          : text(f.after_earnings, "after_earnings");
      const condition = whenOf(f.when, gate);
      const named = new Set(
        [symbol, ...inputSymbols(condition)].map((s) => s.toUpperCase()),
      );
      if (named.size > MAX_INSTRUMENTS) {
        throw new ArgError(
          `an alert reads at most ${MAX_INSTRUMENTS} symbols; this one names ${named.size}`,
        );
      }
      return { action, symbol, condition, note: noteOf(f.note) };
    }
    case "update": {
      const id = alertId(f.id);
      if (f.when === undefined && f.note === undefined) {
        throw new ArgError("update needs when, note or both");
      }
      return {
        action,
        id,
        condition: f.when === undefined ? null : whenOf(f.when, null),
        ...(f.note === undefined ? {} : { note: noteOf(f.note) }),
      };
    }
    default:
      return { action, id: alertId(f.id) };
  }
}

export function parseAlertsRead(input: unknown): AlertsRead {
  const f = textValues(
    fields(input ?? {}, ["id", "symbol", "history", "since", "next"]),
    { ids: ["id"], flags: ["history"] },
  );
  if (
    f.history !== undefined &&
    f.history !== null &&
    typeof f.history !== "boolean"
  ) {
    throw new ArgError("history must be true or false");
  }
  const history = f.history === true;
  const id = f.id === undefined || f.id === null ? null : alertId(f.id);
  const symbol =
    f.symbol === undefined || f.symbol === null
      ? null
      : text(f.symbol, "symbol");
  const since = date(f.since, "since");
  const next = nextOf(f.next);
  if (since !== null && !history) {
    throw new ArgError("since goes with history");
  }
  if (!history && id !== null && (symbol !== null || next !== null)) {
    throw new ArgError("id reads one alert; leave out symbol and next");
  }
  return { id, symbol, history, since, next };
}

// one reader per answer, so alerts on one symbol read its session once
const readerOf = (m: Markets) => reader(m.db, m.clock.now(), m.quoteEveryMs);

// a percent away means something between price levels only: MACD and ATR
// share the price's unit but sit near zero
const LEVELS = new Set([
  "price",
  "previousClose",
  "dayHigh",
  "dayLow",
  "sma50",
  "sma200",
  "ema20",
  "bollingerLower",
  "high52w",
  "low52w",
  "weeklySma50",
  "weeklySma200",
]);

const isLevel = (v: ComparisonValue) =>
  LEVELS.has(v.left.field) &&
  (typeof v.right === "number" || LEVELS.has(v.right.field));

const levelOf = (v: ComparisonValue) =>
  typeof v.right === "number" ? v.right : v.right.value;

const percent = (v: number | null) =>
  v === null ? null : Number(v.toFixed(2));

// how far the price is from the level, unsigned, 0 once it holds
function distance(v: ComparisonValue): number | null {
  const value = v.left.value;
  const level = levelOf(v);
  if (
    !isLevel(v) ||
    v.holds === null ||
    value === null ||
    value === 0 ||
    level === null
  ) {
    return null;
  }
  if (v.holds === true) return 0;
  return (Math.abs(level - value) / Math.abs(value)) * 100;
}

// all: the farthest, and only when every comparison is a price level;
// any: the nearest price level; values come in comparisons() order
export function gapPercent(node: Node, ev: Evaluation): number | null {
  if (ev.result === "true") return 0;
  let at = 0;
  const walk = (n: Node): number | null => {
    if (isComparison(n)) {
      const v = ev.values[at++];
      return v === undefined ? null : distance(v);
    }
    const kids = ("all" in n ? n.all : n.any).map(walk);
    if ("any" in n) {
      const known = kids.filter((d): d is number => d !== null);
      return known.length > 0 ? Math.min(...known) : null;
    }
    return kids.some((d) => d === null)
      ? null
      : Math.max(...(kids as number[]));
  };
  return percent(walk(node));
}

const shownIn = (field: string, v: number | null) =>
  FIELDS[field]!.unit === PRICE_LEVEL ? price(v) : round(v);

// one comparison now: gap is the move left to the level, signed
function nowItem(own: string, v: ComparisonValue) {
  const value = v.left.value;
  const level = levelOf(v);
  const gap = value === null || level === null ? null : level - value;
  return {
    field: publicField(v.left.field),
    ...(v.left.symbol === own ? {} : { symbol: v.left.symbol }),
    ...(v.left.benchmark === undefined ? {} : { benchmark: v.left.benchmark }),
    value,
    level,
    gap: shownIn(v.left.field, gap),
    ...(isLevel(v)
      ? {
          gap_percent:
            gap === null || value === null || value === 0
              ? null
              : percent((gap / Math.abs(value)) * 100),
        }
      : {}),
    holds: v.holds,
  };
}

export type AlertState =
  | "watching"
  | "triggered"
  | "waiting_for_earnings"
  | "paused"
  | "split_paused"
  | "unknown";

function stateOf(
  r: Reader,
  rule: RuleRow,
  ev: Evaluation,
): { state: AlertState; reasons?: string[] } {
  if (rule.paused === "split") return { state: "split_paused" };
  if (rule.paused === "manual") return { state: "paused" };
  if (ev.result === "unknown") return { state: "unknown", reasons: ev.reasons };
  if (ev.reasons.includes(WAITING)) {
    return { state: "waiting_for_earnings", reasons: ev.reasons };
  }
  return { state: firesNext(r, rule) ? "watching" : "triggered" };
}

function gateOf(m: Markets, rule: RuleRow) {
  const g = rule.condition.afterEarnings;
  if (g === null) return null;
  const event = eventOf(m.db, rule);
  const company = readInstrument(m.db, g.symbol);
  return {
    symbol: g.symbol,
    fiscal_year: g.fiscalYear,
    fiscal_quarter: g.fiscalQuarter,
    date: event?.date ?? null,
    status:
      event === null || company === null
        ? null
        : eventStatus(event, localDate(company.zone, m.clock.now())),
  };
}

export function alertItem(
  m: Markets,
  rule: RuleRow,
  ev: Evaluation,
  r: Reader,
  last: number | null,
) {
  const gate = gateOf(m, rule);
  return {
    id: rule.id,
    symbol: rule.instrument,
    when: whenText(rule.condition.node, rule.instrument),
    note: rule.note,
    ...(gate === null ? {} : { after_earnings: gate }),
    ...stateOf(r, rule, ev),
    last_triggered_at: iso(last),
    gap_percent: gapPercent(rule.condition.node, ev),
    now: ev.values.map((v) => nowItem(rule.instrument, v)),
  };
}

export type AlertItem = ReturnType<typeof alertItem>;

// a trigger in the words of when, from its snapshot, old ones included
export function triggerItem(a: Fired) {
  return readTrigger(a).item;
}

function readTrigger(a: Fired) {
  const own = a.snapshot.rule.symbol;
  const condition = readCondition(JSON.stringify(a.snapshot.rule.condition));
  const values: Record<string, number | null> = {};
  for (const v of a.snapshot.values) {
    values[operandText(whenOperand(v.left, own))] = v.left.value;
    if (typeof v.right !== "number") {
      values[operandText(whenOperand(v.right, own))] = v.right.value;
    }
  }
  const item = {
    id: a.id,
    alert_id: a.snapshot.rule.id,
    symbol: own,
    when: whenText(condition.node, own),
    note: a.snapshot.rule.note,
    triggered_at: iso(a.firedAt),
    values,
    ...(a.snapshot.after_earnings === undefined
      ? {}
      : { after_earnings: a.snapshot.after_earnings }),
  };
  return {
    item,
    reads: readsOf(own, condition.node, condition.afterEarnings),
  };
}

export type TriggerItem = ReturnType<typeof triggerItem>;

type StoredTrigger = Pick<AlertRow, "id" | "ruleId" | "firedAt" | "snapshot">;

// the feed's shape for a trigger it cannot send whole
export const truncatedItem = (row: StoredTrigger) => ({
  id: row.id,
  alert_id: row.ruleId,
  triggered_at: iso(row.firedAt),
  truncated: true as const,
});

export type TruncatedItem = ReturnType<typeof truncatedItem>;

const warned = new WeakMap<Log, Set<number>>();

// a snapshot this version cannot read goes out by its id, so one bad row
// never stops the feed or a history page
export function storedTrigger(
  row: StoredTrigger,
  log: Log,
): { item: TriggerItem | TruncatedItem; reads: string[] } {
  try {
    return readTrigger(firedOf(row));
  } catch (error) {
    const seen = warned.get(log) ?? new Set<number>();
    warned.set(log, seen);
    if (!seen.has(row.id)) {
      seen.add(row.id);
      log.warn("unreadable trigger", { id: row.id, ...errorFields(error) });
    }
    return { item: truncatedItem(row), reads: [] };
  }
}

export const firedOf = (
  row: Pick<AlertRow, "id" | "firedAt" | "snapshot">,
): Fired => ({
  id: row.id,
  firedAt: row.firedAt,
  snapshot: JSON.parse(row.snapshot) as Snapshot,
});

// the listings an answer names, so a reader names them without another call
function listings(m: Markets, ids: Iterable<string>) {
  const out: Record<
    string,
    { name: string | null; type: string; currency: string | null; unit: string }
  > = {};
  for (const id of [...new Set(ids)].sort()) {
    const i = readInstrument(m.db, id);
    if (i !== null) {
      out[id] = {
        name: i.name,
        type: i.type,
        currency: i.currency,
        unit: i.unit,
      };
    }
  }
  return out;
}

const readsOf = (symbol: string, node: Node, gate: Gate | null) => [
  symbol,
  ...instrumentsOf({ node, afterEarnings: gate }),
];

// the listings of the first count items only, as a page sends no more
function listingsOf(m: Markets, reads: readonly string[][]) {
  const all = listings(m, reads.flat());
  return (count = reads.length) => {
    const ids = new Set(reads.slice(0, count).flat());
    return Object.fromEntries(
      Object.entries(all).filter(([id]) => ids.has(id)),
    );
  };
}

// each alert evaluated now on one reader, stored nowhere
export function alertViews(m: Markets, owner: string, rules: RuleRow[]) {
  const r = readerOf(m);
  const evs = evaluateRules(m.db, rules, m.clock.now(), m.quoteEveryMs, r);
  const last = lastFired(m.db, owner);
  const of = listingsOf(
    m,
    rules.map((rule) =>
      readsOf(
        rule.instrument,
        rule.condition.node,
        rule.condition.afterEarnings,
      ),
    ),
  );
  return {
    alerts: rules.map((rule, k) =>
      alertItem(m, rule, evs[k]!, r, last.get(rule.id) ?? null),
    ),
    instruments: of(),
    instrumentsOf: of,
  };
}

export function triggerViews(m: Markets, rows: readonly AlertRow[]) {
  const read = rows.map((row) => storedTrigger(row, m.log));
  const of = listingsOf(
    m,
    read.map((t) => t.reads),
  );
  return {
    triggers: read.map((t) => t.item),
    instruments: of(),
    instrumentsOf: of,
  };
}

// a symbol filter reads stored listings only: an alert's symbol is stored;
// a deleted listing's triggers keep its id, so history takes an id as given
function storedId(
  m: Markets,
  symbol: string | null,
  asGiven = false,
): string | null {
  if (symbol === null) return null;
  const bvb = m.bvb !== null;
  const i = m.yahooFirst
    ? restStored(m.db, symbol, bvb, false)
    : storedInstrument(m.db, symbol, bvb);
  if (i !== null) return i.id;
  if (asGiven && symbol.includes(":")) return symbol;
  // no listing: a symbol no alert can name
  return `?${symbol}`;
}

// a page of the owner's alerts by id, from an id, and the id after it
export function alertList(
  m: Markets,
  owner: string,
  args: { symbol: string | null; from: number },
) {
  const instrument = storedId(m, args.symbol);
  const rules = readRules(m.db, owner, {
    from: args.from,
    limit: ALERTS_PAGE + 1,
    ...(instrument === null ? {} : { instrument }),
  });
  const page = rules.slice(0, ALERTS_PAGE);
  return {
    ...alertViews(m, owner, page),
    after: rules.length > ALERTS_PAGE ? rules[ALERTS_PAGE]!.id : null,
  };
}

// newest first, before an id; a deleted alert's history reads by its id
export function historyList(
  m: Markets,
  owner: string,
  args: {
    before: number | null;
    alert: number | null;
    symbol: string | null;
    since: string | null;
  },
) {
  const f: HistoryFilter = {
    before: args.before,
    rule: args.alert,
    instrument: storedId(m, args.symbol, true),
    since: args.since === null ? null : wallOfDate(args.since),
  };
  const rows = readHistory(m.db, owner, ALERTS_PAGE + 1, f);
  const page = rows.slice(0, ALERTS_PAGE);
  return { ...triggerViews(m, page), more: rows.length > ALERTS_PAGE };
}

const notFound = (id: number): Failure => ({
  error: "not_found",
  message: `no alert ${id}`,
});

// one alert with its last triggers
export function oneAlert(m: Markets, owner: string, id: number) {
  const rule = readRule(m.db, owner, id);
  if (rule === null) return notFound(id);
  const view = alertViews(m, owner, [rule]);
  const history = triggerViews(
    m,
    readHistory(m.db, owner, LAST_TRIGGERS, { rule: id }),
  );
  return {
    alert: view.alerts[0]!,
    history: history.triggers,
    instruments: { ...view.instruments, ...history.instruments },
  };
}

const failedTarget = (input: string, error: ItemError): Failure => ({
  ...error,
  message: `${quoted(input)}: ${error.message}`,
});

// a stored when is sent back as is, so it fits the limit with full ids
export function storedWhen(node: Node, own: string): string {
  const when = whenText(node, own);
  if (when.length > MAX_WHEN) {
    throw new ArgError(
      `when with its symbols as stored is ${when.length} characters, over ${MAX_WHEN}; shorten it`,
    );
  }
  return when;
}

type Prepared = {
  own: string;
  condition: { node: Node; afterEarnings: Gate | null };
  instruments: Map<string, Instrument>;
  deadline: number;
};

// every symbol resolved, fetched when new, and the earnings gate bound
async function prepare(
  m: Markets,
  symbol: string,
  input: InputCondition,
  kept: Gate | null,
): Promise<Prepared | Failure> {
  const gate = input.afterEarnings;
  if (gate !== null && m.finnhub === null) {
    return { error: "no_event_source", message: NO_EVENT_SOURCE };
  }
  const deadline = m.clock.now() + m.callMs;
  const plain = [
    ...new Set([symbol, ...inputSymbols(input).filter((s) => s !== gate)]),
  ];
  // one start, so both reads end by the same deadline
  const [targets, research] = await Promise.all([
    readTargets(m, plain),
    gate === null
      ? null
      : researchTargets(m, [gate], { sections: ["calendar"] }),
  ]);
  const all = [...targets, ...(research?.targets ?? [])];
  for (const t of all) {
    if ("error" in t) return failedTarget(t.input, t.error);
  }
  const ids = new Map<string, string>();
  const instruments = new Map<string, Instrument>();
  for (const t of all) {
    if ("instrument" in t) {
      ids.set(t.input, t.instrument.id);
      instruments.set(t.instrument.id, t.instrument);
    }
  }
  let bound: Gate | null = kept;
  if (gate !== null) {
    const company = instruments.get(ids.get(gate)!)!;
    const state = research!.inline.get(company.id);
    if (
      state === undefined ||
      state.kind === "off" ||
      state.kind === "not covered" ||
      !eligible(company)
    ) {
      return {
        error: "no_event_source",
        message: `${company.id}: ${NO_EVENT_SOURCE}; ${NOT_COVERED}`,
      };
    }
    if (state.kind === "failed") {
      return {
        ...state.error,
        message: `${company.id}: ${state.error.message}`,
      };
    }
    const event = nextEvent(m.db, company, m.clock.now(), true);
    if (event === null) {
      return {
        error: "no_event",
        message: `${company.id} has no upcoming earnings event to wait for`,
      };
    }
    bound = {
      symbol: company.id,
      fiscalYear: event.fiscalYear,
      fiscalQuarter: event.fiscalQuarter,
    };
  }
  const own = ids.get(symbol)!;
  const condition = bindCondition(input, own, (s) => ids.get(s)!, bound);
  storedWhen(condition.node, own);
  try {
    checkBound(condition, own, instruments);
  } catch (error) {
    if (error instanceof RuleError) throw new ArgError(error.message);
    throw error;
  }
  return { own, condition, instruments, deadline };
}

// an operand deleted while another was fetched would leave the alert
// unknown for good, since no job adds an instrument back
function gone(db: Markets["db"], p: Prepared): Failure | null {
  for (const id of p.instruments.keys()) {
    if (readInstrument(db, id) === null) {
      return {
        error: "not_found",
        message: `${id}: deleted while the alert was written`,
      };
    }
  }
  return null;
}

type Written = { rule: RuleRow; outcome: ReturnType<typeof applyRule> | null };

// what a create or an update answers: the alert, and its trigger if true
function written(m: Markets, owner: string, w: Written) {
  const r = readerOf(m);
  const ev =
    w.outcome?.evaluation ??
    evaluateRules(m.db, [w.rule], m.clock.now(), m.quoteEveryMs, r)[0]!;
  const last = lastFired(m.db, owner).get(w.rule.id) ?? null;
  return {
    alert: alertItem(m, w.rule, ev, r, last),
    triggered: w.outcome?.alert == null ? null : triggerItem(w.outcome.alert),
  };
}

export type Changed = ReturnType<typeof written>;

export async function createAlert(
  m: Markets,
  owner: string,
  args: Extract<AlertsEdit, { action: "create" }>,
): Promise<Changed | Failure> {
  const p = await prepare(m, args.symbol, args.condition, null);
  if ("error" in p) return p;
  const done = await m.writer.write<Failure | Written | null>((db) => {
    recheck(db);
    const now = m.clock.now();
    // a write queued past the call's deadline stores no alert
    if (now >= p.deadline) return null;
    const lost = gone(db, p);
    if (lost !== null) return lost;
    const id = insertRule(
      db,
      owner,
      {
        instrument: p.own,
        condition: writeCondition(p.condition),
        note: args.note,
      },
      now,
    );
    const outcome = applyRule(
      db,
      readRule(db, owner, id)!,
      now,
      m.quoteEveryMs,
    );
    return { rule: readRule(db, owner, id)!, outcome };
  });
  if (done === null) return timeout(m);
  if ("error" in done) return done;
  return written(m, owner, done);
}

// a new when is a new question: rearmed and checked in the same write
export async function updateAlert(
  m: Markets,
  owner: string,
  args: Extract<AlertsEdit, { action: "update" }>,
): Promise<Changed | Failure> {
  const before = readRule(m.db, owner, args.id);
  if (before === null) return notFound(args.id);
  let p: Prepared | null = null;
  if (args.condition !== null) {
    const own = before.instrument;
    const bare = own.slice(own.indexOf(":") + 1).toUpperCase();
    const named = new Set(
      [
        own.toUpperCase(),
        ...inputSymbols(args.condition).map((s) => s.toUpperCase()),
      ].map((s) => (s === bare ? own.toUpperCase() : s)),
    );
    if (named.size > MAX_INSTRUMENTS) {
      throw new ArgError(
        `an alert reads at most ${MAX_INSTRUMENTS} symbols; this one names ${named.size}`,
      );
    }
    const got = await prepare(
      m,
      before.instrument,
      args.condition,
      before.condition.afterEarnings,
    );
    if ("error" in got) return got;
    p = got;
  }
  const done = await m.writer.write<Failure | Written | null>((db) => {
    recheck(db);
    const now = m.clock.now();
    if (p !== null && now >= p.deadline) return null;
    const rule = readRule(db, owner, args.id);
    if (rule === null) return notFound(args.id);
    if (p !== null) {
      const lost = gone(db, p);
      if (lost !== null) return lost;
    }
    updateRule(db, rule.id, {
      ...(p === null ? {} : { condition: writeCondition(p.condition) }),
      ...(args.note === undefined ? {} : { note: args.note }),
    });
    const changed = readRule(db, owner, rule.id)!;
    if (p === null || changed.paused !== null) {
      return { rule: changed, outcome: null };
    }
    const outcome = applyRule(db, changed, now, m.quoteEveryMs);
    return { rule: readRule(db, owner, rule.id)!, outcome };
  });
  if (done === null) return timeout(m);
  if ("error" in done) return done;
  return written(m, owner, done);
}

export async function pauseAlert(
  m: Markets,
  owner: string,
  id: number,
  paused: boolean,
): Promise<{ alert: AlertItem } | Failure> {
  const out = await m.writer.write((db) => {
    recheck(db);
    const rule = readRule(db, owner, id);
    if (rule === null) return null;
    if (rule.paused === "split") return paused ? rule : "split";
    setPaused(db, rule.id, paused ? "manual" : null);
    return readRule(db, owner, rule.id)!;
  });
  if (out === null) return notFound(id);
  if (out === "split") {
    return {
      error: "split_paused",
      message: `alert ${id} was ${SPLIT_PAUSED}`,
    };
  }
  return { alert: alertViews(m, owner, [out]).alerts[0]! };
}

// its history stays, as triggers outlive their alerts
export async function deleteAlert(
  m: Markets,
  owner: string,
  id: number,
): Promise<{ deleted: number } | Failure> {
  const deleted = await m.writer.write((db) => {
    recheck(db);
    return deleteRule(db, owner, id);
  });
  if (!deleted) return notFound(id);
  return { deleted: id };
}

const answered = (body: object | Failure): ToolResult =>
  "error" in body
    ? errorResult(body as Failure)
    : textResult(JSON.stringify(body));

const NO_READ = "this key has no alerts access; its owner grants it";
const NO_WRITE = "this key reads alerts only; its owner grants write";

const forbidden = (write: boolean): Failure => ({
  error: "forbidden",
  message: write ? NO_WRITE : NO_READ,
});

const position = (next: string, key: object, what: string): number => {
  const at = readCursor(next, key);
  if (at === null || !/^[1-9]\d{0,15}$/.test(at)) {
    throw new ArgError(`next does not continue ${what}`);
  }
  return Number(at);
};

function listPage(m: Markets, owner: string, args: AlertsRead) {
  const key = { symbol: args.symbol };
  const from =
    args.next === null ? 0 : position(args.next, key, "these alerts");
  const { alerts, instrumentsOf, after } = alertList(m, owner, {
    symbol: args.symbol,
    from,
  });
  const page = fitPage(
    alerts,
    (count) => {
      const at = count < alerts.length ? alerts[count]!.id : after;
      return {
        next: at === null ? null : cursor(String(at), key),
        instruments: instrumentsOf(count),
      };
    },
    "alerts",
  );
  return textResult(page.text);
}

function historyPage(m: Markets, owner: string, args: AlertsRead) {
  const key = {
    history: true,
    id: args.id,
    symbol: args.symbol,
    since: args.since,
  };
  const before =
    args.next === null ? null : position(args.next, key, "this history");
  const { triggers, instrumentsOf, more } = historyList(m, owner, {
    before,
    alert: args.id,
    symbol: args.symbol,
    since: args.since,
  });
  const page = fitPage(
    triggers,
    (count) => ({
      next:
        count > 0 && (count < triggers.length || more)
          ? cursor(String(triggers[count - 1]!.id), key)
          : null,
      instruments: instrumentsOf(count),
    }),
    "triggers",
  );
  return textResult(page.text);
}

export async function alertsRead(
  m: Markets,
  who: Who,
  args: AlertsRead,
): Promise<ToolResult> {
  if (!opens(who.alerts, false)) return errorResult(forbidden(false));
  if (args.history) return historyPage(m, who.user, args);
  if (args.id !== null) return answered(oneAlert(m, who.user, args.id));
  return listPage(m, who.user, args);
}

// the reasons can repeat per operand; the alert and its state cannot
function changedResult(body: Changed | Failure): ToolResult {
  if ("error" in body) return errorResult(body);
  const full = JSON.stringify(body);
  if (fits(full) || body.alert.reasons === undefined) return textResult(full);
  return textResult(
    JSON.stringify({
      ...body,
      alert: { ...body.alert, reasons: body.alert.reasons.slice(0, 8) },
    }),
  );
}

export async function alertsEdit(
  m: Markets,
  who: Who,
  args: AlertsEdit,
): Promise<ToolResult> {
  if (!opens(who.alerts, true)) return errorResult(forbidden(true));
  switch (args.action) {
    case "create":
      return changedResult(await createAlert(m, who.user, args));
    case "update":
      return changedResult(await updateAlert(m, who.user, args));
    case "pause":
    case "resume":
      return answered(
        await pauseAlert(m, who.user, args.id, args.action === "pause"),
      );
    case "delete":
      return answered(await deleteAlert(m, who.user, args.id));
  }
}
