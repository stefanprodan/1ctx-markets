// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Detail, Fetched, Listed, Part, Section } from "../data/store.ts";
import {
  ago,
  change,
  plain,
  price,
  priceParts,
  type Signed,
} from "../lib/format.ts";

// the quote's figures through the list's own formats, so both read alike
export function headline(d: Detail): {
  price: string;
  // the figure and its currency apart, for the hero
  value: string;
  currency: string | null;
  change: Signed;
  // the move in the price's own unit; none for a series in percent,
  // whose percent change already says it
  move: Signed;
} {
  const q = d.quote;
  // a read that failed leaves the stored row's price
  const row: Listed =
    q === null
      ? d.instrument
      : {
          ...d.instrument,
          price: q.price ?? q.observation?.value ?? null,
          change: q.change,
          change_percent: q.change_percent,
        };
  const p = priceParts(row);
  return {
    price: price(row),
    value: p.value,
    currency: p.currency,
    change: change(row),
    move: moveOf(row),
  };
}

function moveOf(row: Listed): Signed {
  const c = row.change;
  if (c === null || row.unit === "percent" || row.unit === "percent_of_par")
    return { text: "", dir: 0 };
  const v = priceParts({ ...row, price: Math.abs(c) }).value;
  const dir = Number(v.replace(/,/g, "")) === 0 ? 0 : c > 0 ? 1 : -1;
  return { text: `${dir > 0 ? "+" : dir < 0 ? "−" : ""}${v}`, dir };
}

// the word after the day's move, as Yahoo says it; a series' move is
// from its last value and a stored price's from its day, so neither
// gets one
export function moveLabel(d: Detail): string {
  if ((d.quote?.session ?? null) === null) return "";
  return tradesToday(d) ? "today" : "at close";
}

// open, and past the first pass after the open: until then the quote is
// still the last session's
export function tradesToday(d: Detail): boolean {
  const q = d.quote;
  if (q?.session?.state !== "open") return false;
  const traded = Date.parse(q.trade_time ?? q.fetched_at ?? "");
  return !(traded < Date.parse(q.session.start ?? ""));
}

// pre or post trading beside the close, in the viewer's clock
export function afterHours(d: Detail): {
  word: string;
  at: string;
  value: string;
  change: Signed;
} | null {
  const x = d.quote?.extended;
  if (!x || x.price === null) return null;
  const row: Listed = {
    ...d.instrument,
    price: x.price,
    change: x.change,
    change_percent: x.change_percent,
  };
  const at = CLOCK.format(new Date(x.time));
  const word = x.session === "pre" ? "Pre-market" : "After hours";
  return {
    word,
    at,
    value: priceParts(row).value,
    change: change(row),
  };
}

const CLOCK = new Intl.DateTimeFormat("en-GB", {
  hour: "2-digit",
  minute: "2-digit",
});

const DAY = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  timeZone: "UTC",
});

export function priceState(d: Detail, now: number): string {
  const q = d.quote;
  if (q === null) return `Stored price · ${ago(d.instrument.fetched_at, now)}`;
  const when = ago(q.fetched_at, now);
  if (q.session === null) {
    const on = q.observation?.date;
    return on
      ? `Latest value, ${DAY.format(new Date(`${on}T00:00:00Z`))} · ${when}`
      : `Latest value · ${when}`;
  }
  // a close does not age; the move line says "at close"
  if (q.session.state !== "open") return "Closed";
  // until the first pass after the open, the price is the last close and
  // its fetch time (often last night) says nothing useful; a thin listing
  // fetched since with no trade yet still shows the price is being read
  const traded = Date.parse(q.trade_time ?? q.fetched_at ?? "");
  const start = Date.parse(q.session.start ?? "");
  if (!(traded < start)) return `Open · ${when}`;
  return Date.parse(q.fetched_at ?? "") >= start
    ? `Open · no trade yet · ${when}`
    : "Opening · last close";
}

// a failed read's own words are for agents; the page says it plainly
export const UNREAD = "Couldn't get a new price. Showing the last one stored.";

export type Choice = {
  label: string;
  parts: Part[];
  sections: Section[];
};

const part = (label: string, p: Part): Choice => ({
  label,
  parts: [p],
  sections: [],
});
const section = (label: string, s: Section): Choice => ({
  label,
  parts: ["research"],
  sections: [s],
});

// the refetch menu: everything first, then each part a source holds for
// it; research and earnings dates cover US shares, news US shares and ETFs
export function choices(row: Listed): Choice[] {
  const each: Choice[] = [
    part("Price", "quotes"),
    part("Daily history", "bars"),
  ];
  if (row.market === "US" && row.kind === "EQUITY") {
    each.push(
      section("Key figures", "metric"),
      section("Analyst ratings", "analysts"),
      section("Earnings", "earnings"),
      section("Insider trades", "insider"),
      part("Next earnings", "calendar"),
    );
  }
  if (row.market === "US" && (row.kind === "EQUITY" || row.kind === "ETF")) {
    each.push(part("News", "news"));
  }
  if (isFund(row)) each.push(part("Top holdings", "top_holdings"));
  const everything: Choice = {
    label: "Everything",
    parts: [...new Set(each.flatMap((c) => c.parts))],
    sections: each.flatMap((c) => c.sections),
  };
  return [everything, ...each];
}

const why = (r: Fetched) => plain(r.error ?? "failed");

// what a refetch answered: a failure in words, by its label, else the
// button's own short word; a part no source holds is no failure
export function summary(
  results: readonly Fetched[],
  all: readonly Choice[],
  symbol: string,
): { text: string; bad: boolean } {
  if (results.some((r) => r.status === "not found")) {
    return { text: `${symbol} is no longer stored.`, bad: true };
  }
  const failed = results.filter((r) => r.status === "failed");
  if (failed.length > 0) {
    const said = failed.map((r) => `${labelOf(r, all)} failed: ${why(r)}.`);
    return { text: said.join(" "), bad: true };
  }
  if (results.length > 0 && results.every((r) => r.status === "source off")) {
    return { text: "Its source is off.", bad: true };
  }
  if (!results.some((r) => r.status === "fetched")) {
    return { text: "Not available", bad: false };
  }
  return { text: "Updated", bad: false };
}

// a result under the label its part has in the menu
export function labelOf(r: Fetched, all: readonly Choice[]): string {
  const one = all.slice(1);
  return (
    one.find((c) =>
      r.section
        ? c.sections.includes(r.section)
        : c.parts.includes(r.part) && c.sections.length === 0,
    )?.label ??
    r.section ??
    r.part
  );
}

export const deleteLine =
  "Its prices, history and research are deleted. It comes back if an agent asks for it.";

export const isFund = (row: Pick<Listed, "kind">): boolean =>
  row.kind === "ETF" || row.kind === "MUTUALFUND";
