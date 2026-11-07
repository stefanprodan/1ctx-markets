// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// A cash row's history over chains built through the tools, restores and
// removals among them: the web lines, the step line and the tool's
// answer agree. Made-up amounts only.

import { describe, expect, test } from "bun:test";
import {
  createBroker,
  historyOf,
  rowHistory,
  saveSettings,
} from "../src/operations/portfolio.ts";
import { OPERATOR, type Who } from "../src/operations/who.ts";
import {
  type ChainRow,
  historyLines,
  steps,
} from "../src/web/views/CashHistory.model.ts";
import { ask } from "./helpers/portfolio.ts";
import { world } from "./helpers/world.ts";

const CASEY: Who = {
  name: "casey-agent",
  user: OPERATOR,
  credential: { kind: "key", id: "casey-agent" },
  portfolio: "write",
  alerts: "none",
  profile: "none",
  analysis: "none",
  tradePlans: "none",
};
const HOUR = 3_600_000;

async function setup() {
  const w = world();
  await saveSettings(w.m, OPERATOR, { display_currency: "EUR" });
  await createBroker(w.m, OPERATOR, { name: "North" });
  const cash = (args: object) => ask(w.m, CASEY, "portfolio_cash", args);
  const at = (body: { position?: { position: number } }) => {
    if (!body.position) throw new Error(JSON.stringify(body));
    return body.position.position;
  };
  return {
    add: async (amount: number) =>
      at(
        (
          await cash({
            action: "add",
            name: "Savings",
            amount,
            currency: "EUR",
            broker: "North",
          })
        ).body,
      ),
    up: async (position: number, amount: number) => {
      await w.clock.advance(HOUR);
      return at((await cash({ action: "update", position, amount })).body);
    },
    restore: async (position: number) => {
      await w.clock.advance(HOUR);
      at((await cash({ action: "restore", position })).body);
    },
    remove: async (position: number) => {
      await w.clock.advance(HOUR);
      at((await cash({ action: "remove", position })).body);
    },
    // newest first: what each line says, then the step line's balances,
    // then the tool's rows oldest first
    read: (position: number) => {
      const chain = (
        historyOf(w.m, OPERATOR, position) as {
          history: ChainRow[];
        }
      ).history;
      const tool = rowHistory(w.m, OPERATOR, position) as {
        history: { amount: number; removed: boolean; undone?: true }[];
      };
      return {
        lines: historyLines(chain).map((l) =>
          [l.what ?? "", l.amount, l.change].join(" "),
        ),
        steps: steps(chain).map((s) => s.amount),
        tool: tool.history.map(
          (r) =>
            `${r.amount}${r.removed ? " removed" : ""}${r.undone ? " undone" : ""}`,
        ),
      };
    },
  };
}

type Steps = Awaited<ReturnType<typeof setup>>;

// each: what is done, the line each history line says newest first
// (what, balance, change), the step line, the tool's rows oldest first
const CASES: [
  string,
  (s: Steps) => Promise<number>,
  { lines: string[]; steps: number[]; tool: string[] },
][] = [
  [
    "updates",
    async (s) => s.up(await s.up(await s.add(100), 150), 120),
    {
      lines: [" 120 -30", " 150 50", "Added 100 "],
      steps: [120],
      tool: ["100", "150", "120"],
    },
  ],
  [
    "a removal by hand",
    async (s) => {
      const b = await s.up(await s.add(100), 150);
      await s.remove(b);
      return b;
    },
    {
      lines: ["Removed  ", " 150 50", "Added 100 "],
      steps: [150],
      tool: ["100", "150 removed"],
    },
  ],
  [
    // the removal is cleared by the restore: nothing is left to show
    "a removal undone by its restore",
    async (s) => {
      const b = await s.up(await s.add(100), 150);
      await s.remove(b);
      await s.restore(b);
      return b;
    },
    { lines: [" 150 50", "Added 100 "], steps: [150], tool: ["100", "150"] },
  ],
  [
    "a restore of the row before",
    async (s) => {
      const a = await s.add(100);
      await s.up(a, 150);
      await s.restore(a);
      return a;
    },
    {
      lines: ["Restored 100 -50", " 150 50", "Added 100 "],
      steps: [100],
      tool: ["100", "150 undone"],
    },
  ],
  [
    "an update after a restore changes from the row restored",
    async (s) => {
      const a = await s.add(100);
      await s.up(a, 150);
      await s.restore(a);
      return s.up(a, 130);
    },
    {
      lines: [" 130 30", "Restored 100 -50", " 150 50", "Added 100 "],
      steps: [130],
      tool: ["100", "150 undone", "130"],
    },
  ],
  [
    "a restore across two updates",
    async (s) => {
      const a = await s.add(100);
      await s.up(await s.up(a, 150), 120);
      await s.restore(a);
      return a;
    },
    {
      lines: ["Restored 100 -20", " 120 -30", " 150 50", "Added 100 "],
      steps: [100],
      tool: ["100", "150 undone", "120 undone"],
    },
  ],
  [
    "two restores, each back one row",
    async (s) => {
      const a = await s.add(100);
      const b = await s.up(a, 150);
      await s.up(b, 120);
      await s.restore(b);
      await s.restore(a);
      return a;
    },
    {
      lines: [
        "Restored 100 -50",
        "Restored 150 30",
        " 120 -30",
        " 150 50",
        "Added 100 ",
      ],
      steps: [100],
      tool: ["100", "150 undone", "120 undone"],
    },
  ],
  [
    // the first restore's set-aside is cleared by the second
    "a restore undone by restoring the newest",
    async (s) => {
      const a = await s.add(100);
      const c = await s.up(await s.up(a, 150), 120);
      await s.restore(a);
      await s.restore(c);
      return c;
    },
    {
      lines: ["Restored 120 20", " 120 -30", " 150 50", "Added 100 "],
      steps: [120],
      tool: ["100", "150", "120"],
    },
  ],
  [
    "a restore, then a removal by hand",
    async (s) => {
      const a = await s.add(100);
      await s.up(a, 150);
      await s.restore(a);
      await s.remove(a);
      return a;
    },
    {
      lines: ["Removed  ", "Restored 100 -50", " 150 50", "Added 100 "],
      steps: [100],
      tool: ["100 removed", "150 undone"],
    },
  ],
  [
    "a restore of a later row over an update",
    async (s) => {
      const a = await s.add(100);
      const c = await s.up(await s.up(a, 150), 120);
      await s.restore(a);
      await s.up(a, 90);
      await s.restore(c);
      return c;
    },
    {
      lines: [
        "Restored 120 30",
        " 90 -10",
        " 120 -30",
        " 150 50",
        "Added 100 ",
      ],
      steps: [120],
      tool: ["100", "150", "120", "90 undone"],
    },
  ],
];

describe("a cash row's history over restores and removals", () => {
  for (const [name, run, want] of CASES) {
    test(name, async () => {
      const s = await setup();
      expect(s.read(await run(s))).toEqual(want);
    });
  }
});
