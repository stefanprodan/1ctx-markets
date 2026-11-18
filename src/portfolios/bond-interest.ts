// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Position } from "./store.ts";

export const COUPONS_PER_YEAR = [1, 2, 4] as const;

// a bond with either field unset has no interest figures, never a guess
export const NO_SCHEDULE = "no coupon schedule";

export type Schedule = {
  face: number;
  coupon: number;
  perYear: number;
  maturity: string;
  issued: string;
  // only coupons after the purchase were the owner's
  asOf: string;
};

export type Payout = { date: string; amount: number };

export type Interest = {
  accrued: number;
  coupons: number;
  // the face is added on maturity's day
  next: Payout | null;
};

const ms = (day: string) => Date.parse(`${day}T00:00:00Z`);
const pad = (n: number) => String(n).padStart(2, "0");
const monthIndex = (day: string) =>
  Number(day.slice(0, 4)) * 12 + Number(day.slice(5, 7)) - 1;

export function scheduleOf(
  p: Pick<
    Position,
    "amount" | "coupon" | "maturity" | "couponsPerYear" | "issued" | "asOf"
  >,
): Schedule | null {
  if (
    p.amount === null ||
    p.coupon === null ||
    p.maturity === null ||
    p.couponsPerYear === null ||
    p.issued === null
  ) {
    return null;
  }
  return {
    face: p.amount,
    coupon: p.coupon,
    perYear: p.couponsPerYear,
    maturity: p.maturity,
    issued: p.issued,
    asOf: p.asOf,
  };
}

// from maturity's day each time, so a month-end never drifts
export function couponDay(
  maturity: string,
  perYear: number,
  k: number,
): string {
  const at = monthIndex(maturity) - k * (12 / perYear);
  const y = Math.floor(at / 12);
  const m = at - y * 12;
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  const d = Math.min(Number(maturity.slice(8, 10)), last);
  return `${y}-${pad(m + 1)}-${pad(d)}`;
}

function lastIndex(maturity: string, perYear: number, day: string): number {
  const months = monthIndex(maturity) - monthIndex(day);
  let k = Math.max(0, Math.floor(months / (12 / perYear)) - 1);
  while (couponDay(maturity, perYear, k) > day) k++;
  while (k > 0 && couponDay(maturity, perYear, k - 1) <= day) k--;
  return k;
}

const later = (a: string, b: string) => (a > b ? a : b);

// accrued as actual days over the coupon period's (ACT/ACT), as brokers count
export function interestOn(s: Schedule, day: string): Interest {
  const each = (s.face * s.coupon) / 100 / s.perYear;
  let accrued = 0;
  if (day < s.maturity && day > s.issued) {
    const k = lastIndex(s.maturity, s.perYear, day);
    const prev = couponDay(s.maturity, s.perYear, k);
    const next = couponDay(s.maturity, s.perYear, k - 1);
    // an exchange buy owns the whole period: its cost paid the seller
    const from = later(prev, s.issued);
    accrued = (each * (ms(day) - ms(from))) / (ms(next) - ms(prev));
  }
  // the issue day is no coupon, even on a coupon day
  const after = later(s.asOf, s.issued);
  const end = day < s.maturity ? day : s.maturity;
  const paid =
    end > after
      ? lastIndex(s.maturity, s.perYear, after) -
        lastIndex(s.maturity, s.perYear, end)
      : 0;
  const from = later(day, s.issued);
  let next: Payout | null = null;
  if (from < s.maturity) {
    const k = lastIndex(s.maturity, s.perYear, from) - 1;
    next = {
      date: couponDay(s.maturity, s.perYear, k),
      amount: each + (k === 0 ? s.face : 0),
    };
  }
  return { accrued, coupons: paid * each, next };
}

// a merged bond's next payout: the earliest day, those due on it summed
export function soonest(
  list: readonly (Payout | null | undefined)[],
): Payout | null {
  let out: Payout | null = null;
  for (const p of list) {
    if (p == null) continue;
    if (out === null || p.date < out.date) out = { ...p };
    else if (p.date === out.date) out.amount += p.amount;
  }
  return out;
}
