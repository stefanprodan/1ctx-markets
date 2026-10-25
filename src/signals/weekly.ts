// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { weekOf } from "../calendars.ts";
import {
  baseRows,
  type Close,
  type Cross,
  checkLastRow,
  checkOrder,
  smaCross,
} from "./common.ts";

// date is the week's Monday
export type WeeklyRow = { date: string } & Cross;

export function weeklySeries(weeks: readonly Close[]): WeeklyRow[] {
  checkOrder(weeks);
  const rows: WeeklyRow[] = [];
  for (let i = 0; i < weeks.length; i++) {
    rows.push({ date: weeks[i]!.date, ...smaCross(weeks, i, rows[i - 1]) });
  }
  return rows;
}

// The current week's close replaced by the price. replacesLast says
// the week is the last stored one; last is the final row of the week
// before it.
export function liveWeekly(
  weeks: readonly Close[],
  last: WeeklyRow | null,
  price: number,
  week: { date: string; replacesLast: boolean },
): WeeklyRow {
  if (weekOf(week.date) !== week.date) {
    throw new Error(`not a Monday: ${week.date}`);
  }
  const base = baseRows(weeks, week.date, week.replacesLast);
  checkLastRow(base, last);
  const all = [...base, { date: week.date, close: price }];
  return { date: week.date, ...smaCross(all, all.length - 1, last) };
}
