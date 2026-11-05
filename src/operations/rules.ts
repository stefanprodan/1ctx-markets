// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// The only write tool: a failed create leaves no rule.

import { iso } from "../market/format.ts";
import { type Instrument, readInstrument } from "../market/instruments.ts";
import { localDate } from "../market/zone.ts";
import {
  applyRule,
  type Evaluation,
  evaluateRules,
  eventOf,
  type Fired,
  firesNext,
  gateItem,
  type Reader,
  reader,
} from "../rules/evaluate.ts";
import {
  bindCondition,
  checkBound,
  type Gate,
  type InputCondition,
  inputSymbols,
  instrumentsOf,
  MAX_CONDITION_BYTES,
  MAX_INSTRUMENTS,
  MAX_NOTE,
  parseCondition,
  RuleError,
  writeCondition,
} from "../rules/format.ts";
import {
  type AlertRow,
  deleteRule,
  insertRule,
  type RuleRow,
  readRule,
  readRules,
  setPaused,
} from "../rules/store.ts";
import { recheck } from "../server/caller.ts";
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
import {
  ArgError,
  decimalText,
  fields,
  quoted,
  text,
  textValues,
} from "./args.ts";
import type { Markets } from "./markets.ts";
import { researchTargets } from "./research.ts";
import { type ItemError, readTargets, timeout } from "./targets.ts";
import { opens, type Who } from "./who.ts";

export const RULE_ACTIONS = ["create", "list", "pause", "delete"] as const;
type Action = (typeof RULE_ACTIONS)[number];

// one message whether Finnhub is off or does not cover the instrument
export const NO_EVENT_SOURCE = "no event source for this instrument";
export const SPLIT_PAUSED =
  "paused by a split: its price levels are from before it; delete it and recreate it with new levels";

const ARGS: Record<Action, readonly string[]> = {
  create: ["action", "symbol", "condition", "note"],
  list: ["action", "next"],
  pause: ["action", "id", "paused"],
  delete: ["action", "id"],
};

export type RulesArgs =
  | {
      action: "create";
      symbol: string;
      condition: InputCondition;
      note: string | null;
    }
  | { action: "list"; next: string | null }
  | { action: "pause"; id: number; paused: boolean }
  | { action: "delete"; id: number };

// a condition sent as JSON text is that object; a comparison's right
// written as a number's text is the number, since no field name is digits
function conditionOf(value: unknown): unknown {
  let c = value;
  if (typeof c === "string" && c.trim().startsWith("{")) {
    // the size limit before parsing, so deep text never reaches the walk
    if (Buffer.byteLength(c) > MAX_CONDITION_BYTES) {
      throw new ArgError(
        `condition is longer than ${MAX_CONDITION_BYTES} bytes`,
      );
    }
    try {
      c = JSON.parse(c);
    } catch {
      return value;
    }
  }
  return numericRights(c);
}

function numericRights(node: unknown): unknown {
  if (typeof node !== "object" || node === null || Array.isArray(node)) {
    return node;
  }
  const out: Record<string, unknown> = { ...node };
  for (const key of ["all", "any"]) {
    if (Array.isArray(out[key])) out[key] = out[key].map(numericRights);
  }
  if (decimalText(out.right)) out.right = Number(out.right.trim());
  return out;
}

function ruleId(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new ArgError("id must be a rule id, a positive integer");
  }
  return value;
}

export function parseRules(input: unknown): RulesArgs {
  const f = textValues(
    fields(input, [
      "action",
      "symbol",
      "condition",
      "note",
      "next",
      "id",
      "paused",
    ]),
    { ids: ["id"], flags: ["paused"] },
  );
  if (
    typeof f.action !== "string" ||
    !(RULE_ACTIONS as readonly string[]).includes(f.action)
  ) {
    throw new ArgError(`action must be one of ${RULE_ACTIONS.join(", ")}`);
  }
  const action = f.action as Action;
  for (const name of Object.keys(f)) {
    if (!ARGS[action].includes(name)) {
      throw new ArgError(`${quoted(name)} is not an argument of ${action}`);
    }
  }
  switch (action) {
    case "create": {
      const symbol = text(f.symbol, "symbol");
      if (f.condition === undefined) {
        throw new ArgError("create needs a condition");
      }
      let condition: InputCondition;
      try {
        condition = parseCondition(conditionOf(f.condition));
      } catch (error) {
        if (error instanceof RuleError) throw new ArgError(error.message);
        throw error;
      }
      const note =
        f.note === undefined || f.note === null
          ? null
          : text(f.note, "note", MAX_NOTE);
      const named = new Set(
        [symbol, ...inputSymbols(condition)].map((s) => s.toUpperCase()),
      );
      if (named.size > MAX_INSTRUMENTS) {
        throw new ArgError(
          `a rule reads at most ${MAX_INSTRUMENTS} instruments; this one names ${named.size}`,
        );
      }
      return { action, symbol, condition, note };
    }
    case "list":
      if (
        f.next !== undefined &&
        f.next !== null &&
        typeof f.next !== "string"
      ) {
        throw new ArgError("next must be a string from an earlier answer");
      }
      return { action, next: (f.next as string | undefined) ?? null };
    case "pause":
      if (typeof f.paused !== "boolean") {
        throw new ArgError("paused must be true or false");
      }
      return { action, id: ruleId(f.id), paused: f.paused };
    case "delete":
      return { action, id: ruleId(f.id) };
  }
}

// one reader per answer, so rules on one symbol read its session once
const readerOf = (m: Markets) => reader(m.db, m.clock.now(), m.quoteEveryMs);

export function ruleItem(m: Markets, rule: RuleRow, r: Reader = readerOf(m)) {
  const event = eventOf(m.db, rule);
  const gate = gateItem(rule, event);
  const company =
    gate === null
      ? null
      : m.db
          .query<{ zone: string }, [string]>(
            "select zone from instruments where id = ?",
          )
          .get(gate.symbol);
  return {
    id: rule.id,
    symbol: rule.instrument,
    condition: JSON.parse(writeCondition(rule.condition)),
    note: rule.note,
    paused: rule.paused,
    ...(rule.paused === "split" ? { message: SPLIT_PAUSED } : {}),
    armed: firesNext(r, rule),
    fired_session: rule.firedSession,
    created_at: iso(rule.createdAt),
    last_result: rule.lastResult,
    last_evaluated_at: iso(rule.lastEvaluatedAt),
    ...(gate === null
      ? {}
      : {
          after_earnings: {
            ...gate,
            status:
              event === null || company === null
                ? null
                : eventStatus(event, localDate(company.zone, m.clock.now())),
          },
        }),
  };
}

export const alertItem = (a: Fired) => ({
  id: a.id,
  rule_id: a.snapshot.rule.id,
  fired_at: iso(a.firedAt),
  symbol: a.snapshot.rule.symbol,
  note: a.snapshot.rule.note,
  condition: a.snapshot.rule.condition,
  ...(a.snapshot.after_earnings === undefined
    ? {}
    : { after_earnings: a.snapshot.after_earnings }),
  values: a.snapshot.values,
});

const failedTarget = (input: string, error: ItemError): Failure => ({
  ...error,
  message: `${quoted(input)}: ${error.message}`,
});

export type Created = {
  rule: ReturnType<typeof ruleItem>;
  evaluation: Evaluation;
  alert: ReturnType<typeof alertItem> | null;
};

export async function createRule(
  m: Markets,
  owner: string,
  args: Extract<RulesArgs, { action: "create" }>,
): Promise<Created | Failure> {
  const gate = args.condition.afterEarnings;
  if (gate !== null && m.finnhub === null) {
    return { error: "no_event_source", message: NO_EVENT_SOURCE };
  }
  const deadline = m.clock.now() + m.callMs;
  const plain = [
    ...new Set([
      args.symbol,
      ...inputSymbols(args.condition).filter((s) => s !== gate),
    ]),
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
  let bound: Gate | null = null;
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
  const own = ids.get(args.symbol)!;
  const condition = bindCondition(
    args.condition,
    own,
    (s) => ids.get(s)!,
    bound,
  );
  try {
    checkBound(condition, own, instruments);
  } catch (error) {
    if (error instanceof RuleError) throw new ArgError(error.message);
    throw error;
  }
  const done = await m.writer.write<
    Failure | { rule: RuleRow; outcome: ReturnType<typeof applyRule> } | null
  >((db) => {
    recheck(db);
    const now = m.clock.now();
    // a write queued past the call's deadline stores no rule
    if (now >= deadline) return null;
    // an operand deleted while another was fetched would leave the rule
    // unknown for good, since no job adds an instrument back
    for (const id of instruments.keys()) {
      if (readInstrument(db, id) === null) {
        const gone: Failure = {
          error: "not_found",
          message: `${id}: deleted while the rule was created`,
        };
        return gone;
      }
    }
    const id = insertRule(
      db,
      owner,
      {
        instrument: own,
        condition: writeCondition(condition),
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
  return {
    rule: ruleItem(m, done.rule),
    evaluation: done.outcome.evaluation,
    alert: done.outcome.alert === null ? null : alertItem(done.outcome.alert),
  };
}

async function create(
  m: Markets,
  owner: string,
  args: Extract<RulesArgs, { action: "create" }>,
): Promise<ToolResult> {
  const body = await createRule(m, owner, args);
  if ("error" in body) return errorResult(body);
  const full = JSON.stringify(body);
  if (fits(full)) return textResult(full);
  // the reasons can repeat per operand; the rule and its result cannot
  return textResult(
    JSON.stringify({
      ...body,
      evaluation: {
        result: body.evaluation.result,
        reasons: body.evaluation.reasons.slice(0, 8),
      },
    }),
  );
}

function list(
  m: Markets,
  owner: string,
  args: Extract<RulesArgs, { action: "list" }>,
) {
  let from = 0;
  if (args.next !== null) {
    const at = readCursor(args.next, { action: "list" });
    if (at === null || !/^[1-9]\d{0,15}$/.test(at)) {
      throw new ArgError("next does not continue this list");
    }
    from = Number(at);
  }
  const rules = readRules(m.db, owner, { from });
  const r = readerOf(m);
  const page = fitPage(
    rules.map((rule) => ruleItem(m, rule, r)),
    (count) => ({
      next:
        count < rules.length
          ? cursor(String(rules[count]!.id), { action: "list" })
          : null,
    }),
    "rules",
  );
  return textResult(page.text);
}

const notFound = (id: number): Failure => ({
  error: "not_found",
  message: `no rule ${id}`,
});

export async function pauseRule(
  m: Markets,
  owner: string,
  args: Extract<RulesArgs, { action: "pause" }>,
): Promise<{ rule: ReturnType<typeof ruleItem> } | Failure> {
  const out = await m.writer.write((db) => {
    recheck(db);
    const rule = readRule(db, owner, args.id);
    if (rule === null) return null;
    if (rule.paused === "split") {
      return args.paused ? { rule } : { split: rule };
    }
    setPaused(db, rule.id, args.paused ? "manual" : null);
    return { rule: readRule(db, owner, rule.id)! };
  });
  if (out === null) return notFound(args.id);
  if ("split" in out) {
    return {
      error: "split_paused",
      message: `rule ${args.id} was ${SPLIT_PAUSED}`,
    };
  }
  return { rule: ruleItem(m, out.rule) };
}

// its alerts stay, as alerts outlive their rules
export async function deleteRuleById(
  m: Markets,
  owner: string,
  id: number,
): Promise<{ deleted: number; alerts: "kept" } | Failure> {
  const deleted = await m.writer.write((db) => {
    recheck(db);
    return deleteRule(db, owner, id);
  });
  if (!deleted) return notFound(id);
  return { deleted: id, alerts: "kept" };
}

const answered = (body: object | Failure): ToolResult =>
  "error" in body
    ? errorResult(body as Failure)
    : textResult(JSON.stringify(body));

const NO_READ = "this key has no rules access; its owner grants it";
const NO_WRITE = "this key reads rules only; its owner grants write";

const forbidden = (write: boolean): Failure => ({
  error: "forbidden",
  message: write ? NO_WRITE : NO_READ,
});

export async function rulesAnswer(
  m: Markets,
  who: Who,
  args: RulesArgs,
): Promise<ToolResult> {
  const writes = args.action !== "list";
  if (!opens(who.rules, writes)) return errorResult(forbidden(writes));
  switch (args.action) {
    case "create":
      return create(m, who.user, args);
    case "list":
      return list(m, who.user, args);
    case "pause":
      return answered(await pauseRule(m, who.user, args));
    case "delete":
      return answered(await deleteRuleById(m, who.user, args.id));
  }
}

// the listings a page names, so it draws a row without another read
function listings(m: Markets, ids: Iterable<string>) {
  const out: Record<
    string,
    { name: string | null; type: string; currency: string | null; unit: string }
  > = {};
  for (const id of ids) {
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

// the routes' rules: each as the tool lists it, with the engine's answer now
export function ruleViews(m: Markets, rules: readonly RuleRow[]) {
  const r = readerOf(m);
  const now = evaluateRules(m.db, rules, m.clock.now(), m.quoteEveryMs, r);
  const ids = new Set<string>();
  for (const r of rules) {
    ids.add(r.instrument);
    for (const id of instrumentsOf(r.condition)) ids.add(id);
  }
  return {
    rules: rules.map((rule, i) => ({ ...ruleItem(m, rule, r), now: now[i]! })),
    instruments: listings(m, ids),
  };
}

export function alertViews(m: Markets, rows: readonly AlertRow[]) {
  const alerts = rows.map((r) =>
    alertItem({
      id: r.id,
      firedAt: r.firedAt,
      snapshot: JSON.parse(r.snapshot) as Fired["snapshot"],
    }),
  );
  const ids = new Set<string>();
  for (const a of alerts) {
    ids.add(a.symbol);
    for (const v of a.values) {
      ids.add(v.left.symbol);
      if (typeof v.right !== "number") ids.add(v.right.symbol);
    }
  }
  return { alerts, instruments: listings(m, ids) };
}
