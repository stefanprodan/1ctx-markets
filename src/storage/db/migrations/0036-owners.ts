// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Migration } from "../migration.ts";

// a person's rows name their owner, and the operator owns every row from
// before; names unique per owner need rebuilt tables, so it runs with
// foreign keys off (children point at a table by name, so a dropped parent
// and its renamed copy keep them) and ends checked. No owner column has a
// default, so a write that names none fails instead of landing on the
// operator. Ids and sqlite_sequence carry over, never reused.
export const m0036: Migration = {
  id: "0036-owners",
  foreignKeys: false,
  up(db) {
    db.exec(`
      create table users (
        id text primary key check (length(id) between 1 and 40),
        name text not null check (length(name) between 1 and 80),
        email text unique check (email is null or email = lower(email)),
        role text not null check (role in ('admin', 'member')),
        created_at integer not null,
        last_sign_in_at integer,
        -- the newest of this person's alert ids retention deleted, so the
        -- feed tells a lost alert of theirs from another person's id
        alerts_pruned integer not null default 0
      ) strict;

      -- the server's first start: no clock reaches a migration
      insert into users (id, name, role, created_at, alerts_pruned)
      values ('operator', 'operator', 'admin',
        coalesce((select min(applied_at) from migrations), 0),
        -- every alert was the operator's, so every id under the oldest kept
        -- one, or every id given when none is kept, was pruned
        coalesce((select min(id) - 1 from alerts),
          (select seq from sqlite_sequence where name = 'alerts'), 0));
    `);
    rebuild(db, "portfolios", {
      create: `
        id integer primary key autoincrement,
        owner text not null references users (id),
        name text not null collate nocase
          check (length(name) between 1 and 40),
        created_at integer not null,
        cash integer not null default 0 check (cash in (0, 1)),
        position integer not null default 0,
        unique (owner, name)`,
      columns: "id, owner, name, created_at, cash, position",
      from: "id, 'operator', name, created_at, cash, position",
      indexes: `create unique index portfolios_one_cash on portfolios (owner)
        where cash = 1;`,
    });
    rebuild(db, "brokers", {
      create: `
        id integer primary key autoincrement,
        owner text not null references users (id),
        name text not null collate nocase
          check (length(name) between 1 and 40),
        created_at integer not null,
        unique (owner, name)`,
      columns: "id, owner, name, created_at",
      from: "id, 'operator', name, created_at",
    });
    // its owner was 'admin', the one name the code wrote
    rebuild(db, "portfolio_settings", {
      create: `
        owner text primary key references users (id),
        display_currency text
          check (display_currency is null
            or display_currency glob '[A-Z][A-Z][A-Z]'),
        updated_at integer not null,
        time_zone text
          check (time_zone is null or length(time_zone) between 1 and 64)`,
      columns: "owner, display_currency, updated_at, time_zone",
      from: "'operator', display_currency, updated_at, time_zone",
      where: "owner = 'admin'",
    });
    rebuild(db, "dashboards", {
      create: `
        owner text primary key references users (id),
        revision integer not null,
        updated_at integer not null`,
      columns: "owner, revision, updated_at",
      from: "owner, revision, updated_at",
    });
    rebuild(db, "rules", {
      create: `
        id integer primary key autoincrement,
        owner text not null references users (id),
        instrument text not null references instruments (id),
        condition text not null check (json_valid(condition)),
        note text check (note is null or length(note) <= 500),
        paused text check (paused in ('manual', 'split')),
        armed integer not null default 1 check (armed in (0, 1)),
        created_at integer not null,
        last_result text check (last_result in ('true', 'false', 'unknown')),
        last_evaluated_at integer,
        check ((last_result is null) = (last_evaluated_at is null))`,
      columns: `id, owner, instrument, condition, note, paused, armed,
        created_at, last_result, last_evaluated_at`,
      from: `id, 'operator', instrument, condition, note, paused, armed,
        created_at, last_result, last_evaluated_at`,
      indexes: "create index rules_by_owner on rules (owner, id);",
    });
    // its own owner, as an alert outlives its rule
    rebuild(db, "alerts", {
      create: `
        id integer primary key autoincrement,
        owner text not null references users (id),
        rule_id integer not null,
        fired_at integer not null,
        snapshot text not null check (json_valid(snapshot))`,
      columns: "id, owner, rule_id, fired_at, snapshot",
      from: "id, 'operator', rule_id, fired_at, snapshot",
      indexes: `create index alerts_by_fired on alerts (fired_at);
        create index alerts_by_owner on alerts (owner, id);`,
    });
    rebuild(db, "keys", {
      create: `
        id text primary key,
        user_id text not null references users (id),
        name text not null unique,
        token_hash text not null unique,
        created_at integer not null,
        expires_at integer,
        last_used_at integer,
        portfolio text not null default 'none'
          check (portfolio in ('none', 'read', 'write')),
        rules text not null default 'none'
          check (rules in ('none', 'read', 'write')),
        profile text not null default 'none'
          check (profile in ('none', 'read', 'write'))`,
      columns: `id, user_id, name, token_hash, created_at, expires_at,
        last_used_at, portfolio, rules, profile`,
      from: `id, 'operator', name, token_hash, created_at, expires_at,
        last_used_at, portfolio, rules, profile`,
      indexes: "create index keys_by_user on keys (user_id);",
    });
    rebuild(db, "profile_versions", {
      create: `
        owner text not null references users (id),
        revision integer not null,
        text text not null,
        bytes integer not null,
        author text not null,
        created_at integer not null,
        primary key (owner, revision)`,
      columns: "owner, revision, text, bytes, author, created_at",
      from: "'operator', revision, text, bytes, author, created_at",
    });
    // prices stay shared: user_id is who entered one, so only they see
    // its author and trade; a buy's price outlives the buy's deletion
    rebuild(db, "fund_prices", {
      create: `
        instrument text not null references funds (instrument),
        date text not null
          check (date glob '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
        price real not null check (price >= 0),
        -- the buy whose price stands for its day; null: one entered by hand,
        -- which no trade ever changes, or a buy since deleted
        trade integer references trades (id) on delete set null,
        user_id text references users (id) on delete set null,
        entered_by text not null,
        entered_at integer not null,
        primary key (instrument, date)`,
      columns: `instrument, date, price, trade, user_id, entered_by,
        entered_at`,
      from: "instrument, date, price, trade, 'operator', entered_by, entered_at",
      withoutRowid: true,
    });
  },
};

function rebuild(
  db: Parameters<Migration["up"]>[0],
  table: string,
  t: {
    create: string;
    columns: string;
    from: string;
    where?: string;
    indexes?: string;
    withoutRowid?: boolean;
  },
): void {
  const next = `${table}_next`;
  db.exec(`
    create table ${next} (${t.create}) strict${t.withoutRowid ? ", without rowid" : ""};
    insert into ${next} (${t.columns})
      select ${t.from} from ${table}${t.where ? ` where ${t.where}` : ""};
    delete from sqlite_sequence where name = '${next}';
    insert into sqlite_sequence (name, seq)
      select '${next}', seq from sqlite_sequence where name = '${table}';
    drop table ${table};
    alter table ${next} rename to ${table};
    ${t.indexes ?? ""}
  `);
}
