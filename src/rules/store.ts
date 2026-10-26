// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The rules and alerts tables. Kept free of the engine's imports, since
// tracking reads the instruments every rule depends on from here.

import { DAY_MS } from "../clock.ts";
import type { Db } from "../db/index.ts";
import { type Condition, instrumentsOf, readCondition } from "./format.ts";

export const ALERTS_KEPT_DAYS = 90;

export type Result = "true" | "false" | "unknown";
export type PauseReason = "manual" | "split";

export type RuleRow = {
  id: number;
  instrument: string;
  condition: Condition;
  note: string | null;
  paused: PauseReason | null;
  armed: boolean;
  createdAt: number;
  lastResult: Result | null;
  lastEvaluatedAt: number | null;
};

type Raw = Omit<RuleRow, "condition" | "armed"> & {
  condition: string;
  armed: number;
};

const SELECT = `select id, instrument, condition, note, paused, armed,
  created_at as createdAt, last_result as lastResult,
  last_evaluated_at as lastEvaluatedAt from rules`;

const row = (r: Raw): RuleRow => ({
  ...r,
  condition: readCondition(r.condition),
  armed: r.armed === 1,
});

export function readRule(db: Db, id: number): RuleRow | null {
  const r = db.query<Raw, [number]>(`${SELECT} where id = ?`).get(id);
  return r === null ? null : row(r);
}

// by id; from the id given, at most limit
export function readRules(
  db: Db,
  options: { from?: number; limit?: number; active?: boolean } = {},
): RuleRow[] {
  return db
    .query<Raw, [number, number]>(
      `${SELECT} where id >= ? ${options.active ? "and paused is null" : ""}
       order by id limit ?`,
    )
    .all(options.from ?? 0, options.limit ?? -1)
    .map(row);
}

export function countRules(db: Db): number {
  return db.query<{ n: number }, []>("select count(*) as n from rules").get()!
    .n;
}

export function insertRule(
  db: Db,
  rule: { instrument: string; condition: string; note: string | null },
  now: number,
): number {
  return Number(
    db
      .query(
        `insert into rules (instrument, condition, note, created_at)
         values (?, ?, ?, ?)`,
      )
      .run(rule.instrument, rule.condition, rule.note, now).lastInsertRowid,
  );
}

export function deleteRule(db: Db, id: number): boolean {
  return db.query("delete from rules where id = ?").run(id).changes > 0;
}

export function setPaused(
  db: Db,
  id: number,
  paused: PauseReason | null,
): void {
  db.query("update rules set paused = ? where id = ?").run(paused, id);
}

export function recordResult(
  db: Db,
  id: number,
  result: Result,
  armed: boolean,
  now: number,
): void {
  db.query(
    `update rules set last_result = ?, last_evaluated_at = ?, armed = ?
     where id = ?`,
  ).run(result, now, armed ? 1 : 0, id);
}

// Every instrument a rule reads, paused or not, so the jobs keep each
// one synced while its rule exists.
export function ruleInstruments(db: Db): Set<string> {
  const out = new Set<string>();
  for (const r of db
    .query<{ instrument: string; condition: string }, []>(
      "select instrument, condition from rules",
    )
    .all()) {
    out.add(r.instrument);
    for (const id of instrumentsOf(readCondition(r.condition))) out.add(id);
  }
  return out;
}

export type AlertRow = {
  id: number;
  ruleId: number;
  firedAt: number;
  snapshot: string;
};

export function insertAlert(
  db: Db,
  ruleId: number,
  snapshot: object,
  now: number,
): number {
  return Number(
    db
      .query(
        "insert into alerts (rule_id, fired_at, snapshot) values (?, ?, ?)",
      )
      .run(ruleId, now, JSON.stringify(snapshot)).lastInsertRowid,
  );
}

// oldest first, after the id given
export function readAlertsAfter(
  db: Db,
  after: number,
  limit: number,
): AlertRow[] {
  return db
    .query<AlertRow, [number, number]>(
      `select id, rule_id as ruleId, fired_at as firedAt, snapshot
       from alerts where id > ? order by id limit ?`,
    )
    .all(after, limit);
}

// the last id ever given, alerts since deleted included
export function lastAlertId(db: Db): number {
  return (
    db
      .query<{ seq: number }, []>(
        "select seq from sqlite_sequence where name = 'alerts'",
      )
      .get()?.seq ?? 0
  );
}

export function pruneAlerts(db: Db, now: number): number {
  return db
    .query("delete from alerts where fired_at < ?")
    .run(now - ALERTS_KEPT_DAYS * DAY_MS).changes;
}
