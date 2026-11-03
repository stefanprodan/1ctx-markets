// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// Free of the engine's imports: tracking reads rule instruments from here.

import { DAY_MS } from "../runtime/clock.ts";
import type { Db } from "../storage/db/index.ts";
import { type Condition, instrumentsOf, readCondition } from "./format.ts";

export const ALERTS_KEPT_DAYS = 90;

export type Result = "true" | "false" | "unknown";
export type PauseReason = "manual" | "split";

export type RuleRow = {
  id: number;
  // users.id: rules and their alerts are one person's
  owner: string;
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

const SELECT = `select id, owner, instrument, condition, note, paused, armed,
  created_at as createdAt, last_result as lastResult,
  last_evaluated_at as lastEvaluatedAt from rules`;

const row = (r: Raw): RuleRow => ({
  ...r,
  condition: readCondition(r.condition),
  armed: r.armed === 1,
});

// another person's rule reads as no rule
export function readRule(db: Db, owner: string, id: number): RuleRow | null {
  const r = db
    .query<Raw, [number, string]>(`${SELECT} where id = ? and owner = ?`)
    .get(id, owner);
  return r === null ? null : row(r);
}

type RulesFilter = { from?: number; limit?: number; active?: boolean };

const rulesQuery = (owned: boolean, f: RulesFilter) =>
  `${SELECT} where id >= ?1 ${owned ? "and owner = ?3" : ""}
   ${f.active ? "and paused is null" : ""} order by id limit ?2`;

// the owner's rules
export function readRules(
  db: Db,
  owner: string,
  options: RulesFilter = {},
): RuleRow[] {
  return db
    .query<Raw, [number, number, string]>(rulesQuery(true, options))
    .all(options.from ?? 0, options.limit ?? -1, owner)
    .map(row);
}

// every person's, for the engine, which evaluates and pauses them all
export function allRules(db: Db, options: RulesFilter = {}): RuleRow[] {
  return db
    .query<Raw, [number, number]>(rulesQuery(false, options))
    .all(options.from ?? 0, options.limit ?? -1)
    .map(row);
}

// every person's
export function countRules(db: Db): number {
  return db.query<{ n: number }, []>("select count(*) as n from rules").get()!
    .n;
}

export function insertRule(
  db: Db,
  owner: string,
  rule: { instrument: string; condition: string; note: string | null },
  now: number,
): number {
  return Number(
    db
      .query(
        `insert into rules (owner, instrument, condition, note, created_at)
         values (?, ?, ?, ?, ?)`,
      )
      .run(owner, rule.instrument, rule.condition, rule.note, now)
      .lastInsertRowid,
  );
}

export function deleteRule(db: Db, owner: string, id: number): boolean {
  return (
    db.query("delete from rules where id = ? and owner = ?").run(id, owner)
      .changes > 0
  );
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

// paused or not, so the jobs keep each one synced while its rule exists;
// every person's, or one owner's
export function ruleInstruments(db: Db, owner?: string): Set<string> {
  const out = new Set<string>();
  for (const r of db
    .query<{ instrument: string; condition: string }, [string | null]>(
      "select instrument, condition from rules where ?1 is null or owner = ?1",
    )
    .all(owner ?? null)) {
    out.add(r.instrument);
    for (const id of instrumentsOf(readCondition(r.condition))) out.add(id);
  }
  return out;
}

export type AlertRow = {
  id: number;
  owner: string;
  ruleId: number;
  firedAt: number;
  snapshot: string;
};

// the rule's owner, copied, since an alert outlives its rule
export function insertAlert(
  db: Db,
  rule: Pick<RuleRow, "id" | "owner">,
  snapshot: object,
  now: number,
): number {
  return Number(
    db
      .query(
        "insert into alerts (owner, rule_id, fired_at, snapshot) values (?, ?, ?, ?)",
      )
      .run(rule.owner, rule.id, now, JSON.stringify(snapshot)).lastInsertRowid,
  );
}

export function readAlertsAfter(
  db: Db,
  owner: string,
  after: number,
  limit: number,
): AlertRow[] {
  return db
    .query<AlertRow, [string, number, number]>(
      `select id, owner, rule_id as ruleId, fired_at as firedAt, snapshot
       from alerts where owner = ? and id > ? order by id limit ?`,
    )
    .all(owner, after, limit);
}

// the newest of the owner's alert ids retention deleted
export function prunedAlertId(db: Db, owner: string): number {
  return (
    db
      .query<{ n: number }, [string]>(
        "select alerts_pruned as n from users where id = ?",
      )
      .get(owner)?.n ?? 0
  );
}

// the last id given to the owner, alerts retention deleted included;
// never the server's, which would tell how many alerts others got
export function issuedAlertId(db: Db, owner: string): number {
  return (
    db
      .query<{ n: number | null }, [string]>(
        `select max(coalesce((select max(id) from alerts where owner = ?1), 0),
           coalesce((select alerts_pruned from users where id = ?1), 0)) as n`,
      )
      .get(owner)?.n ?? 0
  );
}

// each owner's newest pruned id is kept first, so their feed sees the loss
export function pruneAlerts(db: Db, now: number): number {
  const before = now - ALERTS_KEPT_DAYS * DAY_MS;
  db.query(
    `update users set alerts_pruned = max(alerts_pruned,
       (select max(id) from alerts where owner = users.id and fired_at < ?1))
     where exists (select 1 from alerts
       where owner = users.id and fired_at < ?1)`,
  ).run(before);
  return db.query("delete from alerts where fired_at < ?").run(before).changes;
}
