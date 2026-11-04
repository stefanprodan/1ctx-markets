// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// A cash row's drawer: its history lines, its step line and the one box,
// from made-up chains.

import { describe, expect, test } from "bun:test";
import {
  balanceChange,
  type ChainRow,
  historyLines,
  pastBalance,
  stepPath,
  steps,
} from "../src/web/views/CashHistory.model.ts";

let next = 1;
const row = (more: Partial<ChainRow>): ChainRow => {
  const id = more.id ?? next++;
  return {
    id,
    name: "Savings",
    currency: "EUR",
    amount: 100,
    as_of: "2026-10-01",
    dry_powder: false,
    broker: "North",
    note: null,
    replaces: null,
    entered_at: `2026-10-01T08:00:0${id % 10}.000Z`,
    removed_at: null,
    ...more,
  };
};

// a chain as the server answers it, newest first; each row replaces the last
function chain(...rows: Partial<ChainRow>[]): ChainRow[] {
  const out: ChainRow[] = [];
  rows.forEach((r, i) => {
    const prev = out[i - 1];
    // an update carries the row forward, changing what it names
    const made = row({
      ...prev,
      removed_at: null,
      id: 100 + i,
      replaces: prev?.id ?? null,
      entered_at: `2026-10-${String(i + 1).padStart(2, "0")}T08:00:00.000Z`,
      ...r,
    });
    if (prev) prev.removed_at = made.entered_at;
    out.push(made);
  });
  return out.reverse();
}

describe("history lines", () => {
  test("amount updates carry their change, newest first", () => {
    const lines = historyLines(
      chain(
        { amount: 100 },
        { amount: 150, as_of: "2026-10-05" },
        { amount: 90, as_of: "2026-10-09" },
      ),
    );
    expect(lines.map((l) => [l.date, l.amount, l.change, l.what])).toEqual([
      ["2026-10-09", 90, -60, null],
      ["2026-10-05", 150, 50, null],
      ["2026-10-01", 100, null, "Added"],
    ]);
  });

  test("an update that left the amount alone says what it changed, dated when made", () => {
    const lines = historyLines(
      chain(
        {},
        { note: "made-up note" },
        { name: "Rainy day" },
        { broker: "South" },
        { dry_powder: true },
        { maturity: "2027-01-15" },
      ),
    );
    expect(lines.map((l) => [l.what, l.change])).toEqual([
      ["Maturity set", null],
      ["Moved to dry powder", null],
      ["Moved to South", null],
      ["Renamed to Rainy day", null],
      // the words, never the note's text
      ["Note changed", null],
      ["Added", null],
    ]);
    expect(lines[0]!.date).toBe("2026-10-06");
  });

  test("a change across currencies has no +/−", () => {
    const lines = historyLines(
      chain({ amount: 100 }, { amount: 500, currency: "RON" }),
    );
    expect(lines[0]).toMatchObject({ change: null, what: "Now in RON" });
  });

  test("a removal and a restore are lines of their own", () => {
    const removed = chain({ amount: 100 }, { amount: 120 });
    removed[0]!.removed_at = "2026-10-07T08:00:00.000Z";
    expect(historyLines(removed)[0]).toMatchObject({
      what: "Removed",
      date: "2026-10-07",
      event: true,
    });
    // the older row brought back after the newer one was taken off
    const restored = chain({ amount: 100 }, { amount: 120 });
    restored[1]!.removed_at = null;
    restored[0]!.removed_at = "2026-10-08T08:00:00.000Z";
    const lines = historyLines(restored);
    expect(lines[0]).toMatchObject({ what: "Restored", amount: 100 });
    expect(lines.filter((l) => l.what === "Removed")).toEqual([]);
  });
});

describe("a restore", () => {
  // 1000, a mistyped 4800 over it, the 1000 restored, then 1200 over it
  const undone = (): ChainRow[] => [
    row({
      id: 3,
      amount: 1200,
      replaces: 1,
      as_of: "2026-10-03",
      entered_at: "2026-10-03T08:00:00.000Z",
    }),
    row({
      id: 2,
      amount: 4800,
      replaces: 1,
      as_of: "2026-10-02",
      entered_at: "2026-10-02T08:00:00.000Z",
      removed_at: "2026-10-02T09:00:00.000Z",
    }),
    row({
      id: 1,
      amount: 1000,
      entered_at: "2026-10-01T08:00:00.000Z",
      removed_at: "2026-10-03T08:00:00.000Z",
    }),
  ];

  test("undoes the mistyped row: no removal, a restore, a change from the row restored", () => {
    const lines = historyLines(undone());
    expect(lines.map((l) => [l.date, l.amount, l.change, l.what])).toEqual([
      ["2026-10-03", 1200, 200, null],
      ["2026-10-02", 1000, -3800, "Restored"],
      ["2026-10-02", 4800, 3800, null],
      ["2026-10-01", 1000, null, "Added"],
    ]);
  });

  test("leaves the undone row off the step line", () => {
    expect(steps(undone())).toEqual([
      { date: "2026-10-01", amount: 1000 },
      { date: "2026-10-03", amount: 1200 },
    ]);
  });
});

describe("days", () => {
  test("an instant is dated on the owner's calendar", () => {
    const late = chain(
      {},
      { note: "made-up note", entered_at: "2026-10-03T23:30:00.000Z" },
    );
    expect(historyLines(late, "Europe/Bucharest")[0]!.date).toBe("2026-10-04");
    expect(historyLines(late, "America/New_York")[0]!.date).toBe("2026-10-03");
  });

  test("a note changed or taken off is said beside an amount change", () => {
    const lines = historyLines(
      chain({ note: "made-up note" }, { note: null, amount: 150 }),
    );
    expect(lines[0]).toMatchObject({ change: 50, what: "Note taken off" });
    const changed = historyLines(
      chain({ note: "made-up note" }, { note: "another note", amount: 90 }),
    );
    expect(changed[0]).toMatchObject({ change: -10, what: "Note changed" });
  });
});

describe("the step line", () => {
  test("one point per day, the day's last balance, in the newest currency", () => {
    const c = chain(
      { amount: 500, currency: "RON" },
      { amount: 100 },
      { amount: 110, as_of: "2026-10-03" },
      { amount: 120, as_of: "2026-10-03" },
    );
    expect(steps(c)).toEqual([
      { date: "2026-10-01", amount: 100 },
      { date: "2026-10-03", amount: 120 },
    ]);
  });

  test("none for a row never updated; a small change stays a small step", () => {
    expect(
      stepPath([{ date: "2026-10-01", amount: 100 }], "2026-10-09", 300, 72),
    ).toBeNull();
    const p = stepPath(
      [
        { date: "2026-10-01", amount: 10_000 },
        { date: "2026-10-05", amount: 9_900 },
      ],
      "2026-10-09",
      300,
      72,
    )!;
    const ys = [...p.line.matchAll(/V([\d.]+)/g)].map((m) => Number(m[1]));
    const y0 = Number(/^M0,([\d.]+)/.exec(p.line)![1]);
    // 1% of the balance moves the line by under a tenth of the box
    expect(Math.abs(ys[0]! - y0)).toBeLessThan(72 / 10);
    expect(p.line.endsWith("H300")).toBe(true);
  });
});

describe("the box", () => {
  test("a figure sets the balance, a sign moves it", () => {
    expect(balanceChange("12400", 100)).toEqual({ change: { amount: 12400 } });
    // as the head writes it, never twelve point four
    expect(balanceChange("12,400", 100)).toEqual({ change: { amount: 12400 } });
    expect(balanceChange("+1,250,000", 100)).toEqual({
      change: { by: 1250000 },
    });
    expect(balanceChange("12,5", 100)).toEqual({ change: { amount: 12.5 } });
    expect(balanceChange("12,400.50", 100)).toEqual({
      change: { amount: 12400.5 },
    });
    expect(balanceChange("+500", 100)).toEqual({ change: { by: 500 } });
    expect(balanceChange("-600", 100)).toEqual({ change: { by: -600 } });
    expect(balanceChange("−600", 100)).toEqual({ change: { by: -600 } });
  });

  test("nothing to save for an empty box, the same balance or a zero move", () => {
    expect(balanceChange("  ", 100)).toEqual({ none: true });
    expect(balanceChange("100", 100)).toEqual({ none: true });
    expect(balanceChange("+0", 100)).toEqual({ none: true });
    expect(balanceChange("ten", 100)).toEqual({ error: "Not a number." });
  });
});

describe("past balances", () => {
  // 100 on 1 Oct, 150 on 5 Oct; then balances for 20 and 28 Sep entered
  const withPast = (): ChainRow[] => [
    row({
      id: 300,
      amount: 60,
      as_of: "2026-09-28",
      past: true,
      replaces: null,
      entered_at: "2026-10-07T08:00:00.000Z",
    }),
    row({
      id: 301,
      amount: 40,
      as_of: "2026-09-20",
      past: true,
      replaces: null,
      entered_at: "2026-10-06T08:00:00.000Z",
    }),
    ...chain({ amount: 100 }, { amount: 150, as_of: "2026-10-05" }),
  ];

  test("are listed at their day, newest day first", () => {
    expect(
      historyLines(withPast()).map((l) => [l.date, l.amount, l.change, l.what]),
    ).toEqual([
      ["2026-10-05", 150, 50, null],
      ["2026-10-01", 100, null, "Added"],
      ["2026-09-28", 60, null, "Past balance"],
      ["2026-09-20", 40, null, "Past balance"],
    ]);
  });

  test("draw the step line from the first", () => {
    expect(steps(withPast()).map((p) => [p.date, p.amount])).toEqual([
      ["2026-09-20", 40],
      ["2026-09-28", 60],
      ["2026-10-01", 100],
      ["2026-10-05", 150],
    ]);
  });

  test("a removed one leaves the line and says so", () => {
    const rows = withPast();
    rows[0]!.removed_at = "2026-10-08T08:00:00.000Z";
    expect(steps(rows).map((p) => p.date)).toEqual([
      "2026-09-20",
      "2026-10-01",
      "2026-10-05",
    ]);
    expect(historyLines(rows)[0]).toMatchObject({
      date: "2026-10-08",
      what: "Past balance removed",
      event: true,
    });
  });

  test("the form takes a day before the row's and a balance", () => {
    expect(pastBalance("2026-09-30", "12,400", "2026-10-05")).toEqual({
      change: { amount: 12400, date: "2026-09-30" },
    });
    expect(pastBalance("", "10", "2026-10-05")).toEqual({
      error: "Pick a day.",
    });
    const late = pastBalance("2026-10-05", "10", "2026-10-05");
    expect("error" in late && late.error.startsWith("Pick a day before")).toBe(
      true,
    );
    expect(pastBalance("2026-09-30", " ", "2026-10-05")).toEqual({
      error: "Give the balance.",
    });
    expect(pastBalance("2026-09-30", "-5", "2026-10-05")).toEqual({
      error: "Not a number.",
    });
  });
});
