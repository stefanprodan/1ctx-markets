// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { open } from "../src/storage/db/index.ts";
import { writer } from "../src/storage/writer.ts";
import { fakeClock } from "./helpers/clock.ts";

function table() {
  const { db } = open(":memory:", fakeClock());
  db.exec("create table t (n integer not null)");
  const rows = () =>
    db
      .query<{ n: number }, []>("select n from t order by rowid")
      .all()
      .map((r) => r.n);
  return { db, rows };
}

describe("the writer", () => {
  test("runs closures in the order they were queued", async () => {
    const { db, rows } = table();
    const w = writer(db);
    const done = await Promise.all(
      [1, 2, 3, 4].map((n) =>
        w.write((db) => {
          db.query("insert into t (n) values (?)").run(n);
          return n * 10;
        }),
      ),
    );
    expect(done).toEqual([10, 20, 30, 40]);
    expect(rows()).toEqual([1, 2, 3, 4]);
  });

  test("a failed closure rolls back, rejects its caller and the next still runs", async () => {
    const { db, rows } = table();
    const w = writer(db);
    const first = w.write((db) => {
      db.query("insert into t (n) values (1)").run();
      throw new Error("broken");
    });
    const second = w.write((db) =>
      db.query("insert into t (n) values (2)").run(),
    );
    await expect(first).rejects.toThrow("broken");
    await second;
    expect(rows()).toEqual([2]);
  });

  test("a closure that returns a promise is refused and rolled back", async () => {
    const { db, rows } = table();
    const w = writer(db);
    await expect(
      w.write((db) => {
        db.query("insert into t (n) values (1)").run();
        return Promise.resolve(1);
      }),
    ).rejects.toThrow("must not return a promise");
    expect(rows()).toEqual([]);
  });

  test("close drains what is queued and refuses what comes after", async () => {
    const { db, rows } = table();
    const w = writer(db);
    const queued = [1, 2, 3].map((n) =>
      w.write((db) => db.query("insert into t (n) values (?)").run(n)),
    );
    const closed = w.close();
    await expect(w.write(() => 1)).rejects.toThrow("the writer is closed");
    await closed;
    expect(rows()).toEqual([1, 2, 3]);
    await Promise.all(queued);
  });
});
