// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { migrate, open } from "../src/db/index.ts";
import type { Migration } from "../src/db/migration.ts";
import { m0001 } from "../src/db/migrations/0001-init.ts";
import { MIGRATIONS } from "../src/db/migrations/index.ts";
import { fakeClock, START } from "./helpers/clock.ts";

const first: Migration = {
  id: "0002-first",
  up: (db) => db.exec("create table first (id integer primary key)"),
};
// fails unless first ran before it
const second: Migration = {
  id: "0003-second",
  up: (db) => db.exec("insert into first (id) values (1)"),
};

const ids = (db: Database) =>
  db
    .query<{ id: string }, []>("select id from migrations order by rowid")
    .all()
    .map((row) => row.id);

describe("migrations", () => {
  test("applies each in order, once", () => {
    const db = new Database(":memory:", { strict: true });
    const clock = fakeClock();
    const list = [m0001, first, second];
    expect(migrate(db, clock, list)).toEqual([
      "0001-init",
      "0002-first",
      "0003-second",
    ]);
    expect(migrate(db, clock, list)).toEqual([]);
    expect(ids(db)).toEqual(["0001-init", "0002-first", "0003-second"]);
    const rows = db.query("select count(*) as n from first").get();
    expect(rows).toEqual({ n: 1 });
    const at = db
      .query("select distinct applied_at as at from migrations")
      .all();
    expect(at).toEqual([{ at: START }]);
  });

  test("applies only what was appended since the last start", () => {
    const db = new Database(":memory:", { strict: true });
    const clock = fakeClock();
    expect(migrate(db, clock, [m0001, first])).toEqual([
      "0001-init",
      "0002-first",
    ]);
    expect(migrate(db, clock, [m0001, first, second])).toEqual(["0003-second"]);
    expect(ids(db)).toEqual(["0001-init", "0002-first", "0003-second"]);
  });

  test("a migration that throws leaves no change and no record", () => {
    const db = new Database(":memory:", { strict: true });
    const clock = fakeClock();
    const broken: Migration = {
      id: "0002-broken",
      up(db) {
        db.exec("create table half (id integer)");
        throw new Error("broken");
      },
    };
    expect(() => migrate(db, clock, [m0001, broken])).toThrow("broken");
    expect(ids(db)).toEqual(["0001-init"]);
    const half = db
      .query("select name from sqlite_master where name = 'half'")
      .get();
    expect(half).toBeNull();
  });

  test("a unit is set on the instruments stored before it", () => {
    const db = new Database(":memory:", { strict: true });
    const clock = fakeClock();
    const at = MIGRATIONS.findIndex((m) => m.id === "0004-scopes-units");
    migrate(db, clock, MIGRATIONS.slice(0, at));
    const add = db.query(
      `insert into instruments (id, market, symbol, source, source_symbol,
         exchange, type, zone, added_at, updated_at)
       values (?, ?, ?, 'yahoo', ?, 'X', ?, 'UTC', 0, 0)`,
    );
    add.run("US:NVDA", "US", "NVDA", "NVDA", "ETF");
    add.run("CRYPTO:SOL-USD", "CRYPTO", "SOL-USD", "SOL-USD", "CRYPTOCURRENCY");
    add.run("CXI:^VIX", "CXI", "^VIX", "^VIX", "INDEX");
    migrate(db, clock);
    expect(
      db.query("select id, unit from instruments order by id").all(),
    ).toEqual([
      { id: "CRYPTO:SOL-USD", unit: "per_unit" },
      { id: "CXI:^VIX", unit: "unknown" },
      { id: "US:NVDA", unit: "per_share" },
    ]);
  });

  test("instruments stored before tracking start one window from their update", () => {
    const db = new Database(":memory:", { strict: true });
    const clock = fakeClock();
    const at = MIGRATIONS.findIndex((m) => m.id === "0006-tracking");
    migrate(db, clock, MIGRATIONS.slice(0, at));
    db.query(
      `insert into instruments (id, market, symbol, source, source_symbol,
         exchange, type, zone, added_at, updated_at)
       values ('US:NVDA', 'US', 'NVDA', 'yahoo', 'NVDA', 'NMS', 'EQUITY',
         'America/New_York', 1, 2)`,
    ).run();
    migrate(db, clock);
    expect(
      db.query("select last_read_at as at from instruments").get(),
    ).toEqual({ at: 2 });
  });

  test("open applies the shipped list to a new database", () => {
    const { db, migrations } = open(":memory:", fakeClock());
    expect(migrations).toEqual(MIGRATIONS.map((m) => m.id));
    expect(ids(db)).toEqual(migrations);
    db.close();
  });
});
