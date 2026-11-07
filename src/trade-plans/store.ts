// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// The owner's trade plans: each revision the whole state, so a version
// shows the name, tags, status and review date it had. Each write rechecks
// its caller and every limit inside its one write.

import { applyEdits, type Edit } from "../document/edit.ts";
import type { Revision } from "../document/read.ts";
import {
  checked,
  conflict,
  documentText,
  evict,
  type Kind,
} from "../document/store.ts";
import type { Failure } from "../operations/answer.ts";
import { recheck } from "../server/caller.ts";
import type { Db } from "../storage/db/index.ts";
import type { Writer } from "../storage/writer.ts";

export const PLAN_STATUSES = ["active", "archived"] as const;
export type PlanStatus = (typeof PLAN_STATUSES)[number];
export const LIST_STATUSES = ["active", "archived", "removed", "all"] as const;
export type ListStatus = (typeof LIST_STATUSES)[number];

export const MAX_ACTIVE_PLANS = 100;
export const MAX_PLAN_SYMBOLS = 50;
export const MAX_PLAN_NAME = 120;

export type PlanState = {
  name: string;
  text: string;
  // instruments.id values, in the order given
  symbols: string[];
  status: PlanStatus;
  reviewBy: string | null;
};

export type PlanRevision = Revision & PlanState;

export type Plan = PlanRevision & {
  id: number;
  removedAt: number | null;
  removedBy: string | null;
  madeAt: number;
  updatedAt: number;
};

export type Listed = Omit<Plan, "text">;

type Raw = {
  id: number;
  revision: number;
  removed_at: number | null;
  removed_by: string | null;
  made_at: number;
  updated_at: number;
  name: string;
  text: string;
  bytes: number;
  status: PlanStatus;
  review_by: string | null;
  symbols: string;
  author: string;
  created_at: number;
};

const stateOf = (raw: Omit<Raw, "text"> & { text?: string }) => ({
  revision: raw.revision,
  name: raw.name,
  bytes: raw.bytes,
  status: raw.status,
  reviewBy: raw.review_by,
  symbols: JSON.parse(raw.symbols) as string[],
  author: raw.author,
  createdAt: raw.created_at,
});

const listedOf = (raw: Omit<Raw, "text">): Listed => ({
  id: raw.id,
  removedAt: raw.removed_at,
  removedBy: raw.removed_by,
  madeAt: raw.made_at,
  updatedAt: raw.updated_at,
  ...stateOf(raw),
});

const planOf = (raw: Raw): Plan => ({ ...listedOf(raw), text: raw.text });

const PLAN = `p.id, p.revision, p.removed_at, p.removed_by,
  p.created_at as made_at, p.updated_at, v.name, v.bytes, v.status,
  v.review_by, v.symbols, v.author, v.created_at`;
const LIVE = `trade_plans p join trade_plan_versions v
  on v.plan = p.id and v.revision = p.revision`;

// the owner's own only: no read takes another person's id
export function readPlan(db: Db, owner: string, id: number): Plan | null {
  const raw = db
    .query<Raw, [string, number]>(
      `select ${PLAN}, v.text from ${LIVE} where p.owner = ? and p.id = ?`,
    )
    .get(owner, id);
  return raw === null ? null : planOf(raw);
}

export type ListAt = { updatedAt: number; id: number };

const STATUS_WHERE: Record<ListStatus, string> = {
  active: "p.removed_at is null and v.status = 'active'",
  archived: "p.removed_at is null and v.status = 'archived'",
  removed: "p.removed_at is not null",
  all: "p.removed_at is null",
};

// newest updated first
export const planList = (
  db: Db,
  owner: string,
  filter: { status: ListStatus; symbol: string | null },
  at: ListAt | null,
  limit: number,
): Listed[] =>
  db
    .query<Raw, [string, string | null, number | null, number, number]>(
      `select ${PLAN} from ${LIVE}
       where p.owner = ?1 and ${STATUS_WHERE[filter.status]}
         and (?2 is null or exists (select 1 from trade_plan_symbols s
           where s.plan = p.id and s.symbol = ?2))
         and (?3 is null or p.updated_at < ?3
           or (p.updated_at = ?3 and p.id < ?4))
       order by p.updated_at desc, p.id desc limit ?5`,
    )
    .all(owner, filter.symbol, at?.updatedAt ?? null, at?.id ?? 0, limit)
    .map(listedOf);

// newest first
export type VersionRow = Omit<PlanRevision, "text"> & {
  // null when the revision before it is not kept
  textChanged: boolean | null;
};

// newest first; texts are compared in the query, so the list loads none
export const planVersions = (db: Db, owner: string, id: number): VersionRow[] =>
  db
    .query<
      Omit<Raw, "text"> & { text_changed: number | null },
      [string, number]
    >(
      `select v.revision, v.name, v.bytes, v.status, v.review_by, v.symbols,
         v.author, v.created_at,
         case when lag(v.revision) over w = v.revision - 1
           then v.text <> lag(v.text) over w end as text_changed
       from trade_plan_versions v join trade_plans p on p.id = v.plan
       where p.owner = ? and v.plan = ?
       window w as (order by v.revision)
       order by v.revision desc`,
    )
    .all(owner, id)
    .map((raw) => ({
      ...stateOf(raw),
      textChanged: raw.text_changed === null ? null : raw.text_changed === 1,
    }));

export function planVersion(
  db: Db,
  owner: string,
  id: number,
  revision: number,
): PlanRevision | null {
  const raw = db
    .query<Raw, [string, number, number]>(
      `select v.revision, v.name, v.text, v.bytes, v.status, v.review_by,
         v.symbols, v.author, v.created_at
       from trade_plan_versions v join trade_plans p on p.id = v.plan
       where p.owner = ? and v.plan = ? and v.revision = ?`,
    )
    .get(owner, id, revision);
  return raw === null ? null : { ...stateOf(raw), text: raw.text };
}

export type Pointer = { id: number; name: string; updatedAt: number };

// the owner's active plans tagged with the instrument, newest first
export const plansFor = (db: Db, owner: string, symbol: string): Pointer[] =>
  db
    .query<Pointer, [string, string]>(
      `select p.id, v.name, p.updated_at as updatedAt
       from ${LIVE} join trade_plan_symbols s on s.plan = p.id
       where s.symbol = ? and p.owner = ? and p.removed_at is null
         and v.status = 'active'
       order by p.updated_at desc, p.id desc`,
    )
    .all(symbol, owner);

// Unicode lowercasing and NFC: SQLite's nocase folds ASCII only, and one
// letter can be one code point or a base and a combining mark
const folded = (s: string) => s.toLowerCase().normalize("NFC");
const sameName = (a: string, b: string) => folded(a) === folded(b);

function activeOthers(
  db: Db,
  owner: string,
  except: number | null,
): { id: number; name: string }[] {
  return db
    .query<{ id: number; name: string }, [string, number]>(
      `select p.id, v.name from ${LIVE}
       where p.owner = ? and p.removed_at is null and v.status = 'active'
         and p.id <> ?`,
    )
    .all(owner, except ?? 0);
}

// an active plan's name and the count, against every other active plan
function activeCheck(
  db: Db,
  owner: string,
  name: string,
  except: number | null,
  counts: boolean,
): Failure | null {
  const others = activeOthers(db, owner, except);
  const taken = others.find((o) => sameName(o.name, name));
  if (taken !== undefined) {
    return {
      error: "conflict",
      message: `active trade plan ${taken.id} is named ${JSON.stringify(taken.name)}; rename or archive one`,
    };
  }
  if (counts && others.length >= MAX_ACTIVE_PLANS) {
    return {
      error: "conflict",
      message: `there are already ${MAX_ACTIVE_PLANS} active trade plans; archive or delete one`,
    };
  }
  return null;
}

export type PlanChange =
  | { action: "edit"; edits: Edit[] }
  | { action: "replace"; text: string }
  | {
      action: "set";
      name?: string;
      symbols?: string[];
      status?: PlanStatus;
      reviewBy?: string | null;
    };

export type PlanSaved = { plan: Listed; unchanged: boolean };

const sameState = (a: PlanState, b: PlanState) =>
  a.name === b.name &&
  a.text === b.text &&
  a.status === b.status &&
  a.reviewBy === b.reviewBy &&
  JSON.stringify(a.symbols) === JSON.stringify(b.symbols);

function insertRevision(db: Db, id: number, next: PlanRevision): void {
  db.query(
    `insert into trade_plan_versions (plan, revision, name, text, bytes,
       status, review_by, symbols, author, created_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    next.revision,
    next.name,
    next.text,
    next.bytes,
    next.status,
    next.reviewBy,
    JSON.stringify(next.symbols),
    next.author,
    next.createdAt,
  );
  db.query("delete from trade_plan_symbols where plan = ?").run(id);
  const tag = db.query(
    "insert into trade_plan_symbols (plan, symbol) values (?, ?)",
  );
  for (const symbol of next.symbols) tag.run(id, symbol);
  evict(
    db,
    { table: "trade_plan_versions", column: "plan", value: id },
    next.revision,
  );
}

const revisionOf = (
  state: PlanState,
  revision: number,
  author: string,
  now: number,
): PlanRevision => ({
  ...state,
  revision,
  bytes: Buffer.byteLength(state.text),
  author,
  createdAt: now,
});

export type KindOf = (next: PlanRevision) => Kind;

export function createPlan(
  writer: Writer,
  owner: string,
  state: PlanState,
  kind: KindOf,
  author: string,
  now: number,
): Promise<PlanSaved | Failure> {
  return writer.write((db): PlanSaved | Failure => {
    recheck(db);
    const s = { ...state, text: documentText(state.text) };
    if (s.status === "active") {
      const refused = activeCheck(db, owner, s.name, null, true);
      if (refused !== null) return refused;
    }
    const next = revisionOf(s, 1, author, now);
    checked(kind(next), next);
    const { id } = db
      .query<{ id: number }, [string, number, number]>(
        `insert into trade_plans (owner, revision, created_at, updated_at)
         values (?, 1, ?, ?) returning id`,
      )
      .get(owner, now, now)!;
    insertRevision(db, id, next);
    return { plan: listedOf(rawListed(db, owner, id)!), unchanged: false };
  });
}

const rawListed = (db: Db, owner: string, id: number) =>
  db
    .query<Raw, [string, number]>(
      `select ${PLAN} from ${LIVE} where p.owner = ? and p.id = ?`,
    )
    .get(owner, id);

const noPlan = (id: number): Failure => ({
  error: "not_found",
  message: `no trade plan ${id}`,
});

const removedPlan = (id: number): Failure => ({
  error: "not_found",
  message: `trade plan ${id} is deleted; restore it first`,
});

// one live revision read: an edit's old is matched against it
export function savePlan(
  writer: Writer,
  owner: string,
  id: number,
  revision: number,
  change: PlanChange,
  kind: KindOf,
  author: string,
  now: number,
): Promise<PlanSaved | Failure> {
  return writer.write((db): PlanSaved | Failure => {
    recheck(db);
    const live = readPlan(db, owner, id);
    if (live === null) return noPlan(id);
    if (live.removedAt !== null) return removedPlan(id);
    if (live.revision !== revision) {
      return conflict(`trade plan ${id}`, live.revision);
    }
    const state: PlanState = {
      name: live.name,
      text: live.text,
      symbols: live.symbols,
      status: live.status,
      reviewBy: live.reviewBy,
    };
    if (change.action === "edit") {
      state.text = documentText(applyEdits(live.text, change.edits));
    } else if (change.action === "replace") {
      state.text = documentText(change.text);
    } else {
      if (change.name !== undefined) state.name = change.name;
      if (change.symbols !== undefined) state.symbols = change.symbols;
      if (change.status !== undefined) state.status = change.status;
      if (change.reviewBy !== undefined) state.reviewBy = change.reviewBy;
    }
    // an unchanged save never uses one of the kept revisions
    if (sameState(state, live)) {
      const { text: _, ...listed } = live;
      return { plan: listed, unchanged: true };
    }
    if (state.status === "active") {
      const counts = live.status !== "active";
      const named = counts || !sameName(state.name, live.name);
      if (named) {
        const refused = activeCheck(db, owner, state.name, id, counts);
        if (refused !== null) return refused;
      }
    }
    const next = revisionOf(state, live.revision + 1, author, now);
    checked(kind(next), next);
    insertRevision(db, id, next);
    db.query(
      "update trade_plans set revision = ?, updated_at = ? where id = ?",
    ).run(next.revision, now, id);
    return { plan: listedOf(rawListed(db, owner, id)!), unchanged: false };
  });
}

// not a revision: the plan keeps the one it had, to restore at
export function removePlan(
  writer: Writer,
  owner: string,
  id: number,
  revision: number,
  by: string,
  now: number,
): Promise<Listed | Failure> {
  return writer.write((db): Listed | Failure => {
    recheck(db);
    const live = rawListed(db, owner, id);
    if (live === null) return noPlan(id);
    if (live.removed_at !== null) return removedPlan(id);
    if (live.revision !== revision) {
      return conflict(`trade plan ${id}`, live.revision);
    }
    db.query(
      "update trade_plans set removed_at = ?, removed_by = ? where id = ?",
    ).run(now, by, id);
    return listedOf(rawListed(db, owner, id)!);
  });
}

// with no time limit, as a removed trade; an active one holds its name and
// counts again
export function restorePlan(
  writer: Writer,
  owner: string,
  id: number,
): Promise<Listed | Failure> {
  return writer.write((db): Listed | Failure => {
    recheck(db);
    const live = rawListed(db, owner, id);
    if (live === null) return noPlan(id);
    if (live.removed_at === null) {
      return {
        error: "conflict",
        message: `trade plan ${id} is not deleted`,
      };
    }
    if (live.status === "active") {
      const refused = activeCheck(db, owner, live.name, id, true);
      if (refused !== null) return refused;
    }
    db.query(
      "update trade_plans set removed_at = null, removed_by = null where id = ?",
    ).run(id);
    return listedOf(rawListed(db, owner, id)!);
  });
}

// what a live revision still names, so an evicted one says why it is gone
export function liveRevision(db: Db, owner: string, id: number): number | null {
  return (
    db
      .query<{ revision: number }, [string, number]>(
        "select revision from trade_plans where owner = ? and id = ?",
      )
      .get(owner, id)?.revision ?? null
  );
}
