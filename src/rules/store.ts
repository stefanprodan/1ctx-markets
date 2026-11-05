// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// Free of the engine's imports: tracking reads rule instruments from here.

import { DAY_MS } from "../runtime/clock.ts";
import type { Db } from "../storage/db/index.ts";
import { type Condition, instrumentsOf, readCondition } from "./format.ts";

export const ALERTS_KEPT_DAYS = 90;
// a page of alerts or of their history; the feed pages by bytes
export const ALERTS_PAGE = 50;

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
  // the session date of its symbol it last fired in
  firedSession: string | null;
  createdAt: number;
  lastResult: Result | null;
  lastEvaluatedAt: number | null;
};

type Raw = Omit<RuleRow, "condition" | "armed"> & {
  condition: string;
  armed: number;
};

const SELECT = `select id, owner, instrument, condition, note, paused, armed,
  fired_session as firedSession, created_at as createdAt, last_result as lastResult,
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

type RulesFilter = {
  from?: number;
  limit?: number;
  active?: boolean;
  instrument?: string;
};

const rulesQuery = (owned: boolean, f: RulesFilter) =>
  `${SELECT} where id >= ?1 ${owned ? "and owner = ?3" : ""}
   ${f.instrument === undefined ? "" : "and instrument = ?4"}
   ${f.active ? "and paused is null" : ""} order by id limit ?2`;

// the owner's rules
export function readRules(
  db: Db,
  owner: string,
  options: RulesFilter = {},
): RuleRow[] {
  const args: [number, number, string, ...string[]] = [
    options.from ?? 0,
    options.limit ?? -1,
    owner,
  ];
  if (options.instrument !== undefined) args.push(options.instrument);
  return db
    .query<Raw, typeof args>(rulesQuery(true, options))
    .all(...args)
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

// a new condition is a new question: armed, never fired, no split pause
export function updateRule(
  db: Db,
  id: number,
  change: { condition?: string; note?: string | null },
): void {
  if (change.condition !== undefined) {
    db.query(
      `update rules set condition = ?, armed = 1, fired_session = null,
         last_result = null, last_evaluated_at = null,
         paused = nullif(paused, 'split') where id = ?`,
    ).run(change.condition, id);
  }
  if (change.note !== undefined) {
    db.query("update rules set note = ? where id = ?").run(change.note, id);
  }
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
  firedSession: string | null,
  now: number,
): void {
  db.query(
    `update rules set last_result = ?, last_evaluated_at = ?, armed = ?,
       fired_session = ? where id = ?`,
  ).run(result, now, armed ? 1 : 0, firedSession, id);
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

export type HistoryFilter = {
  before?: number | null;
  rule?: number | null;
  // the alert's own symbol, as its snapshot holds it, so a deleted
  // alert's history still reads by it
  instrument?: string | null;
  since?: number | null;
};

// newest first; the feed reads oldest first behind its cursor
export function readHistory(
  db: Db,
  owner: string,
  limit: number,
  f: HistoryFilter = {},
): AlertRow[] {
  return db
    .query<
      AlertRow,
      [
        string,
        number | null,
        number,
        number | null,
        string | null,
        number | null,
      ]
    >(
      `select id, owner, rule_id as ruleId, fired_at as firedAt, snapshot
       from alerts where owner = ?1 and (?2 is null or id < ?2)
         and (?4 is null or rule_id = ?4)
         and (?5 is null or json_extract(snapshot, '$.rule.symbol') = ?5)
         and (?6 is null or fired_at >= ?6)
       order by id desc limit ?3`,
    )
    .all(
      owner,
      f.before ?? null,
      limit,
      f.rule ?? null,
      f.instrument ?? null,
      f.since ?? null,
    );
}

// when each of the owner's rules last fired, among the kept alerts
export function lastFired(db: Db, owner: string): Map<number, number> {
  return new Map(
    db
      .query<{ rule: number; at: number }, [string]>(
        "select rule_id as rule, max(fired_at) as at from alerts where owner = ? group by rule_id",
      )
      .all(owner)
      .map((r) => [r.rule, r.at]),
  );
}

// the last alert the person's browser showed, and how many came after it
export function readSeen(
  db: Db,
  owner: string,
): { seen: number; unseen: number } {
  return (
    db
      .query<{ seen: number; unseen: number }, [string]>(
        `select u.alerts_seen as seen,
         (select count(*) from alerts a
          where a.owner = u.id and a.id > u.alerts_seen) as unseen
       from users u where u.id = ?`,
      )
      .get(owner) ?? { seen: 0, unseen: 0 }
  );
}

// forward only, and never past the person's own last alert
export function markSeen(db: Db, owner: string, id: number): void {
  db.query(
    `update users set alerts_seen = max(alerts_seen,
       min(?2, coalesce((select max(id) from alerts where owner = ?1), 0)))
     where id = ?1`,
  ).run(owner, id);
}
