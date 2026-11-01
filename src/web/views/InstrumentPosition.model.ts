// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Holding } from "../data/portfolios.ts";
import {
  amount,
  briefQuantity,
  day,
  money,
  percent,
  type Signed,
  signedMoney,
} from "../lib/format.ts";

export type Position = {
  value: string;
  currency: string;
  moves: { money: Signed; percent: Signed; label: string }[];
  facts: { label: string; value: string; amount: boolean }[];
  parts: { key: string; where: string; held: string; value: string }[];
};

// cash has no instrument; a hand-priced fund's id is no instrument's
export const heldOf = (
  holdings: readonly Holding[],
  id: string,
): Holding | null =>
  holdings.find((h) => h.kind !== "cash" && h.id === id) ?? null;

const averageOf = (h: Holding): string =>
  h.average_cost === null
    ? "—"
    : h.unit === "percent_of_par"
      ? `${amount(h.average_cost)}%`
      : amount(h.average_cost, h.currency);

export function positionOf(h: Holding, now = Date.now()): Position {
  const c = h.currency;
  // a bond is held by its face amount, not a count of units
  const bond = h.kind === "bond";
  const facts = bond
    ? [
        {
          label: "Face value",
          value: money(
            h.parts.reduce((t, p) => t + (p.amount ?? 0), 0),
            c,
          ),
          amount: true,
        },
        {
          label: "Coupon",
          value: h.coupon != null ? `${h.coupon}%` : "—",
          amount: false,
        },
        {
          label: "Matures",
          value: h.maturity ? day(h.maturity, now) : "—",
          amount: false,
        },
        {
          label: "Bought",
          value: h.as_of ? day(h.as_of, now) : "—",
          amount: false,
        },
      ]
    : [
        { label: "Quantity", value: briefQuantity(h.quantity), amount: true },
        { label: "Average price", value: averageOf(h), amount: true },
      ];
  return {
    value: money(h.value),
    currency: c,
    moves: [
      {
        money: signedMoney(h.pl, c),
        percent: percent(h.pl_percent),
        label: "all time",
      },
      {
        money: signedMoney(h.day_change, c),
        percent: percent(h.change_percent),
        label: "today",
      },
    ],
    facts,
    parts:
      h.parts.length < 2
        ? []
        : h.parts.map((p) => ({
            key: `${p.portfolio}/${p.broker ?? ""}`,
            where: p.broker ? `${p.portfolio} · ${p.broker}` : p.portfolio,
            held: bond ? money(p.amount ?? null, c) : briefQuantity(p.quantity),
            value: money(p.value, c),
          })),
  };
}
