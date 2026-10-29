// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { migrate, open } from "../src/storage/db/index.ts";
import type { Migration } from "../src/storage/db/migration.ts";
import { m0001 } from "../src/storage/db/migrations/0001-init.ts";
import { MIGRATIONS } from "../src/storage/db/migrations/index.ts";
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
    migrate(db, clock, MIGRATIONS.slice(0, at + 1));
    expect(
      db.query("select id, unit from instruments order by id").all(),
    ).toEqual([
      { id: "CRYPTO:SOL-USD", unit: "per_unit" },
      { id: "CXI:^VIX", unit: "unknown" },
      { id: "US:NVDA", unit: "per_share" },
    ]);
  });

  test("runs stored before it are kept and a deleted id is never reused", () => {
    const db = new Database(":memory:", { strict: true });
    const clock = fakeClock();
    const at = MIGRATIONS.findIndex((m) => m.id === "0014-run-ids");
    migrate(db, clock, MIGRATIONS.slice(0, at));
    const add = db.query(
      `insert into sync_runs (source, job, scope, started_at, ended_at,
         status, rows, error)
       values ('yahoo', 'bars', ?, 1, 2, ?, 3, ?)`,
    );
    add.run("US", "ok", null);
    add.run("US:A", "failed", "not found");
    add.run("US:B", "ok", null);
    db.exec("delete from sync_runs where id = 3");
    migrate(db, clock);
    expect(
      db.query("select id, scope, status, rows, error from sync_runs").all(),
    ).toEqual([
      { id: 1, scope: "US", status: "ok", rows: 3, error: null },
      { id: 2, scope: "US:A", status: "failed", rows: 3, error: "not found" },
    ]);
    db.exec("delete from sync_runs where id = 2");
    add.run("US", "ok", null);
    expect(db.query("select max(id) as id from sync_runs").get()).toEqual({
      id: 3,
    });
  });

  test("a Yahoo index stored with no unit takes index points", () => {
    const db = new Database(":memory:", { strict: true });
    const clock = fakeClock();
    const at = MIGRATIONS.findIndex((m) => m.id === "0013-index-units");
    migrate(db, clock, MIGRATIONS.slice(0, at));
    const add = db.query(
      `insert into instruments (id, market, symbol, source, source_symbol,
         exchange, type, unit, zone, added_at, updated_at)
       values (?, ?, ?, ?, ?, 'X', ?, ?, 'UTC', 0, 0)`,
    );
    add.run("SNP:^GSPC", "SNP", "^GSPC", "yahoo", "^GSPC", "INDEX", "unknown");
    add.run("NYM:CL=F", "NYM", "CL=F", "yahoo", "CL=F", "FUTURE", "unknown");
    add.run("BVB:BET", "BVB", "BET", "bvb", "BET", "INDEX", "index_points");
    add.run(
      "FRED:DGS10",
      "FRED",
      "DGS10",
      "fred",
      "DGS10",
      "SERIES",
      "percent",
    );
    migrate(db, clock);
    expect(
      db.query("select id, unit from instruments order by id").all(),
    ).toEqual([
      { id: "BVB:BET", unit: "index_points" },
      { id: "FRED:DGS10", unit: "percent" },
      { id: "NYM:CL=F", unit: "unknown" },
      { id: "SNP:^GSPC", unit: "index_points" },
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

  test("quotes stored before it are kept and may then lack a trade time", () => {
    const db = new Database(":memory:", { strict: true });
    const clock = fakeClock();
    const at = MIGRATIONS.findIndex((m) => m.id === "0010-bvb");
    migrate(db, clock, MIGRATIONS.slice(0, at));
    db.query(
      `insert into instruments (id, market, symbol, source, source_symbol,
         exchange, type, zone, added_at, updated_at)
       values (?, 'BVB', ?, 'yahoo', ?, 'BVB', 'EQUITY', 'Europe/Bucharest',
         0, 0)`,
    ).run("BVB:TLV", "TLV", "TLV.RO");
    const quote = db.query(
      `insert into quotes (instrument, price, previous_close,
         previous_close_field, change, time, source, fetched_at)
       values (?, 36.18, ?, ?, ?, ?, 'yahoo', 2)`,
    );
    quote.run("BVB:TLV", 36.4, "previousClose", -0.22, 1);
    migrate(db, clock);
    expect(
      db
        .query(
          "select instrument, price, previous_close_field as f, time from quotes",
        )
        .all(),
    ).toEqual([
      { instrument: "BVB:TLV", price: 36.18, f: "previousClose", time: 1 },
    ]);
    db.query(
      `insert into instruments (id, market, symbol, source, source_symbol,
         exchange, type, zone, added_at, updated_at)
       values ('BVB:BET', 'BVB', 'BET', 'bvb', 'BET', 'BVB', 'INDEX',
         'Europe/Bucharest', 0, 0)`,
    ).run();
    quote.run("BVB:BET", 35018.02, "change", -339.79, null);
    expect(() => quote.run("BVB:BET", 1, "guess", 1, null)).toThrow();
    expect(db.query("select count(*) as n from sources").get()).toEqual({
      n: 0,
    });
  });

  test("an FX pair stored with no currency gets its symbol's", () => {
    const db = new Database(":memory:", { strict: true });
    const clock = fakeClock();
    const at = MIGRATIONS.findIndex((m) => m.id === "0011-fx-currency");
    migrate(db, clock, MIGRATIONS.slice(0, at));
    const add = db.query(
      `insert into instruments (id, market, symbol, source, source_symbol,
         exchange, type, currency, zone, added_at, updated_at)
       values (?, 'CCY', ?, 'yahoo', ?, 'CCY', ?, ?, 'Europe/London', 0, 0)`,
    );
    add.run("CCY:EURRON=X", "EURRON=X", "EURRON=X", "CURRENCY", null);
    add.run("CCY:RON=X", "RON=X", "RON=X", "CURRENCY", null);
    add.run("CCY:EURUSD=X", "EURUSD=X", "EURUSD=X", "CURRENCY", "USD");
    add.run("CCY:ABC=F", "ABC=F", "ABC=F", "CURRENCY", null);
    add.run("CCY:ABCDEF=X", "ABCDEF=X", "ABCDEF=X", "INDEX", null);
    migrate(db, clock);
    expect(
      db.query("select id, currency from instruments order by id").all(),
    ).toEqual([
      { id: "CCY:ABC=F", currency: null },
      { id: "CCY:ABCDEF=X", currency: null },
      { id: "CCY:EURRON=X", currency: "RON" },
      { id: "CCY:EURUSD=X", currency: "USD" },
      { id: "CCY:RON=X", currency: "RON" },
    ]);
  });

  test("research and events stored before listings are the share's own", () => {
    const db = new Database(":memory:", { strict: true });
    const clock = fakeClock();
    const at = MIGRATIONS.findIndex((m) => m.id === "0012-listing");
    migrate(db, clock, MIGRATIONS.slice(0, at));
    db.exec(`
      insert into instruments (id, market, symbol, source, source_symbol,
        exchange, type, currency, zone, added_at, updated_at)
      values ('US:TSM', 'US', 'TSM', 'yahoo', 'TSM', 'NYQ', 'EQUITY', 'USD',
        'America/New_York', 0, 0);
      insert into research (instrument, kind, period, pe_ttm, fetched_at)
      values ('US:TSM', 'metric', '2026-10-01', 20, 0);
      insert into research (instrument, kind, period, eps_actual, fetched_at)
      values ('US:TSM', 'earnings', '2026-09-30', 148.9, 0);
      insert into events (instrument, fiscal_year, fiscal_quarter, date, hour,
        eps_actual, reported_seen_at, fetched_at)
      values ('US:TSM', 2026, 3, '2026-10-15', 'bmo', 148.9, 0, 0);
    `);
    migrate(db, clock);
    expect(
      db.query("select kind, listing from research order by kind").all(),
    ).toEqual([
      { kind: "earnings", listing: null },
      { kind: "metric", listing: null },
    ]);
    expect(db.query("select listing from events").all()).toEqual([
      { listing: null },
    ]);
    // another listing keeps no figure per share, and only a symbol's shape
    const research = db.query(
      `insert into research (instrument, kind, period, pe_ttm, listing,
         fetched_at) values ('US:TSM', ?, '2026-08-01', ?, ?, 0)`,
    );
    research.run("analysts", null, "2330.TW");
    expect(() => research.run("metric", 20, "2330.TW")).toThrow();
    expect(() => research.run("earnings", null, "2330.TW")).toThrow();
    expect(() => research.run("insider", null, "2330 TW")).toThrow();
    research.run("insider", null, null);
    expect(() =>
      db
        .query(
          `insert into events (instrument, fiscal_year, fiscal_quarter, date,
             hour, eps_estimate, listing, fetched_at)
           values ('US:TSM', 2026, 4, '2027-01-13', 'bmo', 32.2, '2330.TW', 0)`,
        )
        .run(),
    ).toThrow();
  });

  test("the Bucharest listings start empty and take only a list page's kind", () => {
    const db = new Database(":memory:", { strict: true });
    const clock = fakeClock();
    const at = MIGRATIONS.findIndex((m) => m.id === "0018-bvb-listings");
    migrate(db, clock, MIGRATIONS.slice(0, at));
    expect(
      db
        .query("select name from sqlite_master where name = 'bvb_listings'")
        .all(),
    ).toEqual([]);
    migrate(db, clock);
    expect(db.query("select * from bvb_listings").all()).toEqual([]);
    const insert = db.query(
      `insert into bvb_listings (kind, symbol, isin, name, type, listed_at)
       values (?, ?, null, null, 'EQUITY', 0)`,
    );
    insert.run("shares", "TLV");
    expect(() => insert.run("shares", "TLV")).toThrow();
    expect(() => insert.run("structured", "EBTLV")).toThrow();
    expect(() => insert.run("bonds", "")).toThrow();
    db.close();
  });

  test("open applies the shipped list to a new database", () => {
    const { db, migrations } = open(":memory:", fakeClock());
    expect(migrations).toEqual(MIGRATIONS.map((m) => m.id));
    expect(ids(db)).toEqual(migrations);
    db.close();
  });
});
