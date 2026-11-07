// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Migration } from "../migration.ts";

// a tag names an instruments.id with no reference, so deleting one never
// blocks the delete or reaches a plan's history
export const m0047: Migration = {
  id: "0047-trade-plans",
  up(db) {
    db.exec(`
      create table trade_plans (
        id integer primary key autoincrement,
        owner text not null references users (id),
        revision integer not null,
        removed_at integer,
        removed_by text,
        created_at integer not null,
        updated_at integer not null,
        check ((removed_at is null) = (removed_by is null))
      ) strict;
      create index trade_plans_by_owner on trade_plans (owner, updated_at);
      create table trade_plan_versions (
        plan integer not null references trade_plans (id) on delete cascade,
        revision integer not null,
        name text not null,
        text text not null,
        bytes integer not null,
        status text not null check (status in ('active', 'archived')),
        review_by text,
        symbols text not null,
        author text not null,
        created_at integer not null,
        primary key (plan, revision)
      ) strict;
      create table trade_plan_symbols (
        plan integer not null references trade_plans (id) on delete cascade,
        symbol text not null,
        primary key (plan, symbol)
      ) strict;
      -- the instrument page and quote look plans up by symbol
      create index trade_plan_symbols_by_symbol on trade_plan_symbols
        (symbol, plan);
      alter table keys add column trade_plans text not null default 'none'
        check (trade_plans in ('none', 'read', 'write'));
    `);
  },
};
