// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The only tool with write annotations; a failed create leaves no rule.

import {
  eligible,
  eventStatus,
  NOT_COVERED,
  nextEvent,
} from "../finnhub/store.ts";
import type { Instrument } from "../instruments.ts";
import { applyRule, eventOf, type Fired, gateItem } from "../rules/evaluate.ts";
import {
  bindCondition,
  checkBound,
  type Gate,
  type InputCondition,
  inputSymbols,
  MAX_INSTRUMENTS,
  MAX_NOTE,
  parseCondition,
  RuleError,
  writeCondition,
} from "../rules/format.ts";
import {
  deleteRule,
  insertRule,
  type RuleRow,
  readRule,
  readRules,
  setPaused,
} from "../rules/store.ts";
import { localDate } from "../zone.ts";
import {
  cursor,
  errorResult,
  fitPage,
  fits,
  iso,
  readCursor,
  type ToolResult,
  textResult,
} from "./answer.ts";
import { ArgError, fields, quoted, text } from "./args.ts";
import { researchTargets } from "./research.ts";
import {
  type ItemError,
  type Markets,
  readTargets,
  timeout,
} from "./targets.ts";

export const RULE_ACTIONS = ["create", "list", "pause", "delete"] as const;
type Action = (typeof RULE_ACTIONS)[number];

// what a refused gate says, whether Finnhub is off or does not cover it
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

function ruleId(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new ArgError("id must be a rule id, a positive integer");
  }
  return value;
}

export function parseRules(input: unknown): RulesArgs {
  const f = fields(input, [
    "action",
    "symbol",
    "condition",
    "note",
    "next",
    "id",
    "paused",
  ]);
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
        condition = parseCondition(f.condition);
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

export function ruleItem(m: Markets, rule: RuleRow) {
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
    armed: rule.armed,
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

const failedTarget = (input: string, error: ItemError) =>
  errorResult({ ...error, message: `${quoted(input)}: ${error.message}` });

async function create(
  m: Markets,
  args: Extract<RulesArgs, { action: "create" }>,
): Promise<ToolResult> {
  const gate = args.condition.afterEarnings;
  if (gate !== null && m.finnhub === null) {
    return errorResult({ error: "no_event_source", message: NO_EVENT_SOURCE });
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
      return errorResult({
        error: "no_event_source",
        message: `${company.id}: ${NO_EVENT_SOURCE}; ${NOT_COVERED}`,
      });
    }
    if (state.kind === "failed") {
      return errorResult({
        ...state.error,
        message: `${company.id}: ${state.error.message}`,
      });
    }
    const event = nextEvent(m.db, company, m.clock.now(), true);
    if (event === null) {
      return errorResult({
        error: "no_event",
        message: `${company.id} has no upcoming earnings event to wait for`,
      });
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
  const done = await m.writer.write((db) => {
    const now = m.clock.now();
    // a write queued past the call's deadline stores no rule
    if (now >= deadline) return null;
    const id = insertRule(
      db,
      {
        instrument: own,
        condition: writeCondition(condition),
        note: args.note,
      },
      now,
    );
    const outcome = applyRule(db, readRule(db, id)!, now, m.quoteEveryMs);
    return { rule: readRule(db, id)!, outcome };
  });
  if (done === null) return errorResult(timeout(m));
  const body = {
    rule: ruleItem(m, done.rule),
    evaluation: done.outcome.evaluation,
    alert: done.outcome.alert === null ? null : alertItem(done.outcome.alert),
  };
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

function list(m: Markets, args: Extract<RulesArgs, { action: "list" }>) {
  let from = 0;
  if (args.next !== null) {
    const at = readCursor(args.next, { action: "list" });
    if (at === null || !/^[1-9]\d{0,15}$/.test(at)) {
      throw new ArgError("next does not continue this list");
    }
    from = Number(at);
  }
  const rules = readRules(m.db, { from });
  const page = fitPage(
    rules.map((r) => ruleItem(m, r)),
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

const notFound = (id: number) =>
  errorResult({ error: "not_found", message: `no rule ${id}` });

async function pause(
  m: Markets,
  args: Extract<RulesArgs, { action: "pause" }>,
): Promise<ToolResult> {
  const out = await m.writer.write((db) => {
    const rule = readRule(db, args.id);
    if (rule === null) return null;
    if (rule.paused === "split") {
      return args.paused ? { rule } : { split: rule };
    }
    setPaused(db, rule.id, args.paused ? "manual" : null);
    return { rule: readRule(db, rule.id)! };
  });
  if (out === null) return notFound(args.id);
  if ("split" in out) {
    return errorResult({
      error: "split_paused",
      message: `rule ${args.id} was ${SPLIT_PAUSED}`,
    });
  }
  return textResult(JSON.stringify({ rule: ruleItem(m, out.rule) }));
}

async function remove(
  m: Markets,
  args: Extract<RulesArgs, { action: "delete" }>,
): Promise<ToolResult> {
  const deleted = await m.writer.write((db) => deleteRule(db, args.id));
  if (!deleted) return notFound(args.id);
  return textResult(JSON.stringify({ deleted: args.id, alerts: "kept" }));
}

export async function rulesAnswer(
  m: Markets,
  args: RulesArgs,
): Promise<ToolResult> {
  switch (args.action) {
    case "create":
      return create(m, args);
    case "list":
      return list(m, args);
    case "pause":
      return pause(m, args);
    case "delete":
      return remove(m, args);
  }
}
