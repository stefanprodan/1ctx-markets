// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Period starts shared by the server's returns and the page's chart, so
// the two measure a period from the same day.

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

const iso = (y: number, m: number, d: number) =>
  new Date(Date.UTC(y, m, d)).toISOString().slice(0, 10);

// the same calendar day m months back, clamped to that month's end
export function monthsBack(date: string, months: number): string {
  const p = DATE.exec(date);
  const [y, m, d] = p ? [+p[1]!, +p[2]! - 1, +p[3]!] : [0, 0, 0];
  if (p === null || iso(y, m, d) !== date) {
    throw new Error(`not a date: ${date}`);
  }
  const monthEnd = new Date(Date.UTC(y, m - months + 1, 0)).getUTCDate();
  return iso(y, m - months, Math.min(d, monthEnd));
}

// a year to date runs from the year before's last close
export const yearStart = (date: string): string =>
  `${Number(date.slice(0, 4)) - 1}-12-31`;
