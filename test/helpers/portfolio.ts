// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Markets } from "../../src/operations/markets.ts";
import type { Who } from "../../src/operations/who.ts";
import { ensureCash, insertPortfolio } from "../../src/portfolios/store.ts";
import { call, tools } from "../../src/tools/index.ts";

// a portfolio as an install from before the display currency was
// required holds it, so its answers stay per currency
export const portfolioBefore = (m: Markets, name: string) =>
  m.writer.write((db) => insertPortfolio(db, name, m.clock.now()));

// Cash as the migration makes it for such an install that kept cash
export const cashBefore = (m: Markets) =>
  m.writer.write((db) => ensureCash(db, m.clock.now()));

// a portfolio tool called as an agent calls it, its answer parsed
export async function ask(
  m: Markets,
  who: Who,
  name: string,
  args: object,
): Promise<{ error: boolean; body: any }> {
  const tool = tools(m).find((t) => t.name === name);
  if (tool === undefined) throw new Error(`no tool ${name}`);
  const r = await call(m, tool, args, who);
  return { error: r.isError === true, body: JSON.parse(r.content[0]!.text) };
}
