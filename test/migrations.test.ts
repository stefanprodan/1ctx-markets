// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { OPERATOR } from "../src/operations/who.ts";
import { listPortfolios } from "../src/portfolios/store.ts";
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
      values ('US:TSM', 'earnings', '2026-09-30', 148.9, 1792108800000);
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

  test("keys made before rules access keep writing rules, new ones none", () => {
    const db = new Database(":memory:", { strict: true });
    const clock = fakeClock();
    const at = MIGRATIONS.findIndex((m) => m.id === "0023-key-rules");
    migrate(db, clock, MIGRATIONS.slice(0, at));
    db.exec(
      `insert into keys (id, name, token_hash, created_at)
       values ('oldkey000000', 'old', 'h1', 0)`,
    );
    migrate(db, clock, MIGRATIONS.slice(0, at + 1));
    db.exec(
      `insert into keys (id, name, token_hash, created_at)
       values ('newkey000000', 'new', 'h2', 0)`,
    );
    expect(
      db.query("select name, rules from keys order by name").all(),
    ).toEqual([
      { name: "new", rules: "none" },
      { name: "old", rules: "write" },
    ]);
    expect(() => db.exec("update keys set rules = 'all'")).toThrow();
    db.close();
  });

  test("keys made before profile access open no profile, new ones none", () => {
    const db = new Database(":memory:", { strict: true });
    const clock = fakeClock();
    const at = MIGRATIONS.findIndex((m) => m.id === "0033-profile");
    migrate(db, clock, MIGRATIONS.slice(0, at));
    db.exec(
      `insert into keys (id, name, token_hash, created_at, portfolio, rules)
       values ('oldkey000000', 'old', 'h1', 0, 'write', 'write')`,
    );
    migrate(db, clock, MIGRATIONS.slice(0, at + 1));
    db.exec(
      `insert into keys (id, name, token_hash, created_at)
       values ('newkey000000', 'new', 'h2', 0)`,
    );
    expect(
      db.query("select name, profile from keys order by name").all(),
    ).toEqual([
      { name: "new", profile: "none" },
      { name: "old", profile: "none" },
    ]);
    expect(() => db.exec("update keys set profile = 'all'")).toThrow();
    expect(db.query("select * from profile_versions").all()).toEqual([]);
    db.close();
  });

  test("keys made before analysis access open no analysis, new ones none", () => {
    const db = new Database(":memory:", { strict: true });
    const clock = fakeClock();
    const at = MIGRATIONS.findIndex((m) => m.id === "0041-analysis");
    migrate(db, clock, MIGRATIONS.slice(0, at));
    db.exec(
      `insert into keys (id, user_id, name, token_hash, created_at, portfolio,
         rules, profile)
       values ('oldkey000000', 'operator', 'old', 'h1', 0, 'write', 'write',
         'write')`,
    );
    migrate(db, clock, MIGRATIONS.slice(0, at + 1));
    db.exec(
      `insert into keys (id, user_id, name, token_hash, created_at)
       values ('newkey000000', 'operator', 'new', 'h2', 0)`,
    );
    expect(
      db.query("select name, analysis from keys order by name").all(),
    ).toEqual([
      { name: "new", analysis: "none" },
      { name: "old", analysis: "none" },
    ]);
    expect(() => db.exec("update keys set analysis = 'all'")).toThrow();
    expect(db.query("select * from analysis_versions").all()).toEqual([]);
    db.close();
  });

  test("the owner's settings gain a time zone, none until named", () => {
    const db = new Database(":memory:", { strict: true });
    const clock = fakeClock();
    const at = MIGRATIONS.findIndex((m) => m.id === "0024-time-zone");
    migrate(db, clock, MIGRATIONS.slice(0, at));
    db.exec(
      `insert into portfolio_settings (owner, display_currency, updated_at)
       values ('admin', 'EUR', 0)`,
    );
    migrate(db, clock, MIGRATIONS.slice(0, at + 1));
    expect(
      db
        .query("select display_currency, time_zone from portfolio_settings")
        .all(),
    ).toEqual([{ display_currency: "EUR", time_zone: null }]);
    expect(() =>
      db.exec("update portfolio_settings set time_zone = ''"),
    ).toThrow();
    db.close();
  });

  test("positions gain a market, none on the rows kept", () => {
    const db = new Database(":memory:", { strict: true });
    const clock = fakeClock();
    const at = MIGRATIONS.findIndex((m) => m.id === "0025-position-market");
    migrate(db, clock, MIGRATIONS.slice(0, at));
    db.exec(
      `insert into portfolios (name, created_at) values ('Made Up', 0);
       insert into positions (portfolio, kind, name, currency, amount, as_of,
         entered_by, entered_at)
       values (1, 'cash', 'Made Up Cash', 'EUR', 10, '2026-01-02', 'web', 0)`,
    );
    migrate(db, clock, MIGRATIONS.slice(0, at + 1));
    expect(db.query("select market from positions").all()).toEqual([
      { market: null },
    ]);
    expect(() => db.exec("update positions set market = ''")).toThrow();
    db.close();
  });

  test("a position's market is cleared, a fund's kept", () => {
    const db = new Database(":memory:", { strict: true });
    const clock = fakeClock();
    const at = MIGRATIONS.findIndex((m) => m.id === "0031-cash-no-market");
    migrate(db, clock, MIGRATIONS.slice(0, at));
    db.exec(
      `insert into portfolios (name, created_at) values ('Made Up', 0);
       insert into positions (portfolio, kind, name, currency, amount, as_of,
         market, entered_by, entered_at)
       values (1, 'cash', 'Made Up Cash', 'EUR', 10, '2026-01-02', 'US',
         'web', 0);
       insert into instruments (id, market, symbol, source, source_symbol,
         exchange, type, currency, zone, added_at, updated_at)
       values ('fund:XX0000000000', 'fund', 'XX0000000000', 'owner',
         'XX0000000000', 'fund', 'FUND', 'EUR', 'UTC', 0, 0);
       insert into funds (instrument, market, entered_by, entered_at)
       values ('fund:XX0000000000', 'US', 'web', 0)`,
    );
    migrate(db, clock, MIGRATIONS.slice(0, at + 1));
    expect(db.query("select market from positions").all()).toEqual([
      { market: null },
    ]);
    expect(db.query("select market from funds").all()).toEqual([
      { market: "US" },
    ]);
    db.close();
  });

  test("earnings rows of a quarter ending after their fetch day are deleted", () => {
    const db = new Database(":memory:", { strict: true });
    const clock = fakeClock();
    const at = MIGRATIONS.findIndex((m) => m.id === "0027-earnings-ahead");
    migrate(db, clock, MIGRATIONS.slice(0, at));
    const fetched = Date.UTC(2026, 9, 28, 23, 1);
    db.exec(`
      insert into instruments (id, market, symbol, source, source_symbol,
        exchange, type, currency, zone, added_at, updated_at)
      values ('US:ZZZ', 'US', 'ZZZ', 'yahoo', 'ZZZ', 'NMS', 'EQUITY', 'USD',
        'America/New_York', 0, 0);
    `);
    const insert = db.query(
      `insert into research (instrument, kind, period, eps_actual, mspr,
         strong_buy, fetched_at) values ('US:ZZZ', ?, ?, ?, ?, ?, ?)`,
    );
    insert.run("earnings", "2027-03-31", 4.1, null, null, fetched);
    insert.run("earnings", "2026-10-28", 4.1, null, null, fetched);
    insert.run("earnings", "2026-06-30", 3.6, null, null, fetched);
    insert.run("insider", "2027-01-01", null, -10, null, fetched);
    insert.run("analysts", "2027-01-01", null, null, 3, fetched);
    migrate(db, clock, MIGRATIONS.slice(0, at + 1));
    expect(
      db.query("select kind, period from research order by kind, period").all(),
    ).toEqual([
      { kind: "analysts", period: "2027-01-01" },
      { kind: "earnings", period: "2026-06-30" },
      { kind: "earnings", period: "2026-10-28" },
      { kind: "insider", period: "2027-01-01" },
    ]);
    db.close();
  });

  test("a share class listing keeps per-share figures, a dotted one none", () => {
    const db = new Database(":memory:", { strict: true });
    const clock = fakeClock();
    const at = MIGRATIONS.findIndex((m) => m.id === "0028-share-class-listing");
    migrate(db, clock, MIGRATIONS.slice(0, at));
    db.exec(`
      insert into instruments (id, market, symbol, source, source_symbol,
        exchange, type, currency, zone, added_at, updated_at)
      values ('US:TSM', 'US', 'TSM', 'yahoo', 'TSM', 'NYQ', 'EQUITY', 'USD',
        'America/New_York', 0, 0);
      insert into research (instrument, kind, period, roe_ttm, listing,
        fetched_at) values ('US:TSM', 'metric', '2026-10-01', 41.2, '2330.TW', 5);
      insert into research (instrument, kind, period, buy, listing, fetched_at)
      values ('US:TSM', 'analysts', '2026-10-01', 28, '2330.TW', 5);
      insert into research (instrument, kind, period, eps_actual, surprise,
        fetched_at) values ('US:TSM', 'earnings', '2026-09-30', 2.1, 0.2, 6);
      insert into research (instrument, kind, period, insider_change, mspr,
        fetched_at) values ('US:TSM', 'insider', '2026-09-01', -10, -50, 7);
      insert into events (instrument, fiscal_year, fiscal_quarter, date, hour,
        reported_seen_at, listing, fetched_at)
      values ('US:TSM', 2026, 3, '2026-10-21', 'bmo', 8, '2330.TW', 8);
      insert into events (instrument, fiscal_year, fiscal_quarter, date, hour,
        eps_estimate, eps_actual, revenue_actual, reported_seen_at, fetched_at)
      values ('US:TSM', 2025, 3, '2025-10-22', 'bmo', 1.9, 2.0, 3e10, 9, 9);
    `);
    const shape = () => ({
      schema: db
        .query(
          `select type, name, tbl_name, sql from sqlite_master
           where tbl_name in ('research', 'events') and type = 'index'
           order by name`,
        )
        .all(),
      columns: ["research", "events"].map((t) =>
        db.query(`select * from pragma_table_info('${t}')`).all(),
      ),
      keys: ["research", "events"].map((t) =>
        db.query(`select * from pragma_foreign_key_list('${t}')`).all(),
      ),
      options: db
        .query(
          `select name, strict, wr from pragma_table_list
           where name in ('research', 'events') order by name`,
        )
        .all(),
    });
    const rows = () => ({
      research: db.query("select * from research order by kind").all(),
      events: db.query("select * from events order by fiscal_year").all(),
    });
    const before = { shape: shape(), rows: rows() };
    migrate(db, clock, MIGRATIONS.slice(0, at + 1));
    expect(shape()).toEqual(before.shape);
    expect(rows()).toEqual(before.rows);
    expect(
      db.query("select name from sqlite_master where name like '%_next'").all(),
    ).toEqual([]);

    const research = db.query(
      `insert into research (instrument, kind, period, pe_ttm, listing,
         fetched_at) values ('US:TSM', ?, ?, ?, ?, 0)`,
    );
    expect(() =>
      research.run("analysts", "2026-11-01", 20, "2330.TW"),
    ).toThrow();
    db.exec("delete from research where kind = 'metric'");
    expect(() => research.run("metric", "2026-11-01", 20, "2330.TW")).toThrow();
    research.run("metric", "2026-11-01", 20, "GOOGL");
    expect(() =>
      research.run("insider", "2026-11-01", null, "GOOGL"),
    ).toThrow();
    expect(() => research.run("analysts", "2026-11-01", null, "A B")).toThrow();
    const earnings = db.query(
      `insert into research (instrument, kind, period, eps_actual, listing,
         fetched_at) values ('US:TSM', 'earnings', ?, 2.2, ?, 0)`,
    );
    expect(() => earnings.run("2026-06-30", "2330.TW")).toThrow();
    earnings.run("2026-06-30", "GOOGL");
    const event = db.query(
      `insert into events (instrument, fiscal_year, fiscal_quarter, date,
         hour, eps_estimate, listing, fetched_at)
       values ('US:TSM', 2027, ?, '2027-01-13', 'bmo', 32.2, ?, 0)`,
    );
    expect(() => event.run(1, "2330.TW")).toThrow();
    event.run(1, "GOOGL");
    db.close();
  });

  test("people stored before it have seen no alert", () => {
    const db = new Database(":memory:", { strict: true });
    const clock = fakeClock();
    const at = MIGRATIONS.findIndex((m) => m.id === "0044-alerts-seen");
    migrate(db, clock, MIGRATIONS.slice(0, at));
    db.exec(
      `insert into users (id, name, role, created_at)
       values ('ana', 'Ana', 'member', 0)`,
    );
    migrate(db, clock, MIGRATIONS.slice(0, at + 1));
    expect(
      db.query("select id, alerts_seen from users order by id").all(),
    ).toEqual([
      { id: "ana", alerts_seen: 0 },
      { id: OPERATOR, alerts_seen: 0 },
    ]);
    expect(() => db.exec("update users set alerts_seen = null")).toThrow();
    db.close();
  });

  test("rules stored before it have fired in no session", () => {
    const db = new Database(":memory:", { strict: true });
    const clock = fakeClock();
    const at = MIGRATIONS.findIndex((m) => m.id === "0045-rules-fired-session");
    migrate(db, clock, MIGRATIONS.slice(0, at));
    db.exec(`
      insert into instruments (id, market, symbol, source, source_symbol,
        exchange, type, currency, zone, added_at, updated_at)
      values ('US:ZZZ', 'US', 'ZZZ', 'yahoo', 'ZZZ', 'NMS', 'EQUITY', 'USD',
        'America/New_York', 0, 0);
      insert into rules (owner, instrument, condition, created_at, armed)
      values ('${OPERATOR}', 'US:ZZZ', '{}', 0, 0);
    `);
    migrate(db, clock, MIGRATIONS.slice(0, at + 1));
    expect(db.query("select armed, fired_session from rules").all()).toEqual([
      { armed: 0, fired_session: null },
    ]);
    expect(() =>
      db.exec("update rules set fired_session = '5 Nov 2026'"),
    ).toThrow();
    db.exec("update rules set fired_session = '2026-11-05'");
    db.close();
  });

  test("open applies the shipped list to a new database", () => {
    const { db, migrations } = open(":memory:", fakeClock());
    expect(migrations).toEqual(MIGRATIONS.map((m) => m.id));
    expect(ids(db)).toEqual(migrations);
    db.close();
  });
});

describe("the Cash portfolio's migration", () => {
  const at = MIGRATIONS.findIndex((m) => m.id === "0032-cash-portfolio");
  const before = (sql: string) => {
    const db = new Database(":memory:", { strict: true });
    const clock = fakeClock();
    migrate(db, clock, MIGRATIONS.slice(0, at));
    db.exec(`
      insert into instruments (id, market, symbol, source, source_symbol,
        exchange, type, currency, zone, added_at, updated_at)
      values ('US:ZZZ', 'US', 'ZZZ', 'yahoo', 'ZZZ', 'NMS', 'EQUITY', 'USD',
        'America/New_York', 0, 0);
      insert into brokers (name, created_at) values ('North', 0);
      ${sql}
    `);
    migrate(db, clock, MIGRATIONS.slice(0, at + 1));
    return db;
  };
  const cash = (
    id: number,
    portfolio: number,
    name: string,
    more: { broker?: number; removed?: boolean; replaces?: number } = {},
  ) =>
    `insert into positions (id, portfolio, kind, name, currency, amount,
       as_of, broker, replaces, entered_by, entered_at, removed_at, removed_by)
     values (${id}, ${portfolio}, 'cash', '${name}', 'EUR', 10, '2026-01-02',
       ${more.broker ?? "null"}, ${more.replaces ?? "null"}, 'web', 0,
       ${more.removed ? "1, 'web'" : "null, null"});`;
  const portfolios = (db: Database) =>
    db.query("select id, name, cash from portfolios order by id").all() as {
      id: number;
      name: string;
      cash: number;
    }[];
  const rows = (db: Database) =>
    db.query("select id, portfolio, name from positions order by id").all() as {
      id: number;
      portfolio: number;
      name: string;
    }[];

  test("a cash portfolio of cash only is marked, its name set right", () => {
    const db = before(`
      insert into portfolios (name, created_at) values ('cash', 0);
      insert into portfolios (name, created_at) values ('Stocks', 0);
      ${cash(1, 1, "Spare")}
    `);
    expect(portfolios(db)).toEqual([
      { id: 1, name: "Cash", cash: 1 },
      { id: 2, name: "Stocks", cash: 0 },
    ]);
    expect(rows(db)).toEqual([{ id: 1, portfolio: 1, name: "Spare" }]);
    expect(() =>
      db.exec("update portfolios set cash = 1 where id = 2"),
    ).toThrow();
    db.close();
  });

  test("a Cash holding a trade is renamed, and every cash row moves to a new one", () => {
    const db = before(`
      insert into portfolio_settings (owner, display_currency, updated_at)
        values ('admin', 'EUR', 5);
      insert into portfolios (name, created_at) values ('Cash', 0);
      insert into portfolios (name, created_at) values ('Stocks', 0);
      insert into trades (portfolio, instrument, side, date, quantity, price,
        currency, entered_by, entered_at)
      values (1, 'US:ZZZ', 'buy', '2026-01-02', 1, 10, 'USD', 'web', 0);
      ${cash(1, 1, "Spare", { broker: 1 })}
      ${cash(2, 2, "Spare", { broker: 1, removed: true })}
      ${cash(3, 2, "Spare", { broker: 1, replaces: 2 })}
      ${cash(4, 2, "Kept")}
    `);
    expect(portfolios(db)).toEqual([
      { id: 1, name: "Cash (before)", cash: 0 },
      { id: 2, name: "Stocks", cash: 0 },
      { id: 3, name: "Cash", cash: 1 },
    ]);
    // the live clash takes its old portfolio's name, its chain's rows too
    expect(rows(db)).toEqual([
      { id: 1, portfolio: 3, name: "Spare" },
      { id: 2, portfolio: 3, name: "Spare (Stocks)" },
      { id: 3, portfolio: 3, name: "Spare (Stocks)" },
      { id: 4, portfolio: 3, name: "Kept" },
    ]);
    expect(
      db.query("select replaces from positions where id = 3").get(),
    ).toEqual({ replaces: 2 });
    expect(
      db.query("select count(*) as n from trades where portfolio = 1").get(),
    ).toEqual({ n: 1 });
    db.close();
  });

  test("a moved name already taken in Cash takes the next free one, within 80 characters", () => {
    const long = "L".repeat(80);
    const db = before(`
      insert into portfolios (name, created_at) values ('Cash', 0);
      insert into portfolios (name, created_at) values ('Stocks', 0);
      ${cash(1, 1, "Spare")}
      ${cash(2, 1, "Spare (Stocks)")}
      ${cash(3, 2, "Spare")}
      ${cash(4, 1, long)}
      ${cash(5, 2, long)}
    `);
    expect(rows(db).map((r) => [r.id, r.portfolio, r.name])).toEqual([
      [1, 1, "Spare"],
      [2, 1, "Spare (Stocks)"],
      [3, 1, "Spare (Stocks 2)"],
      [4, 1, long],
      [5, 1, `${"L".repeat(71)} (Stocks)`],
    ]);
    db.close();
  });

  test("a long portfolio name is cut in the suffix, so the row keeps its own", () => {
    const from = "P".repeat(40);
    const db = before(`
      insert into portfolios (name, created_at) values ('Cash', 0);
      insert into portfolios (name, created_at) values ('${from}', 0);
      ${cash(1, 1, "Spare")}
      ${cash(2, 2, "Spare")}
      ${cash(3, 1, "L".repeat(80))}
      ${cash(4, 2, "L".repeat(80))}
    `);
    const names = rows(db).map((r) => r.name);
    expect(names[1]).toBe(`Spare (${"P".repeat(30)})`);
    expect(names[3]).toBe(`${"L".repeat(47)} (${"P".repeat(30)})`);
    expect(names[3]!.length).toBe(80);
    db.close();
  });

  test("none is made before the display currency is set", () => {
    const db = before(
      "insert into portfolios (name, created_at) values ('Stocks', 0);",
    );
    expect(portfolios(db)).toEqual([{ id: 1, name: "Stocks", cash: 0 }]);
    db.close();
  });

  test("portfolios keep their name order as places, Cash included", () => {
    const db = new Database(":memory:", { strict: true });
    const clock = fakeClock();
    const at = MIGRATIONS.findIndex((m) => m.id === "0034-portfolio-order");
    migrate(db, clock, MIGRATIONS.slice(0, at));
    const add = db.query(
      "insert into portfolios (name, cash, created_at) values (?, ?, 0)",
    );
    for (const [name, cash] of [
      ["zeta", 0],
      ["Cash", 1],
      ["Alpha", 0],
      ["beta", 0],
    ] as const) {
      add.run(name, cash);
    }
    migrate(db, clock);
    expect(
      db.query("select name, position from portfolios order by id").all(),
    ).toEqual([
      { name: "zeta", position: 4 },
      { name: "Cash", position: 3 },
      { name: "Alpha", position: 1 },
      { name: "beta", position: 2 },
    ]);
    expect(listPortfolios(db, OPERATOR).map((p) => p.name)).toEqual([
      "Cash",
      "Alpha",
      "beta",
      "zeta",
    ]);
    db.close();
  });
});
