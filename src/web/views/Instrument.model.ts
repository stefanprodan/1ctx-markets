// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type {
  Detail,
  Fetched,
  Listed,
  Part,
  Returns,
  Section,
} from "../data/store.ts";
import { change, price } from "./Instruments.model.ts";
import { ago, plain } from "./Status.model.ts";

// the quote's figures through the list's own formats, so both read alike
export function headline(d: Detail): {
  price: string;
  change: { text: string; dir: -1 | 0 | 1 };
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
  return { price: price(row), change: change(row) };
}

// pre or post trading beside the close, in the viewer's clock
export function afterHours(d: Detail): {
  label: string;
  price: string;
  change: { text: string; dir: -1 | 0 | 1 };
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
  return {
    label: `${x.session === "pre" ? "Pre-market" : "After hours"} · ${at}`,
    price: price(row),
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

// live or the close, said plainly, then when it was fetched
export function priceState(d: Detail, now: number): string {
  const q = d.quote;
  if (q === null) {
    return `Stored price · updated ${ago(d.instrument.fetched_at, now)}`;
  }
  const when = `updated ${ago(q.fetched_at, now)}`;
  if (q.session === null) {
    const on = q.observation?.date;
    return on
      ? `Latest value, ${DAY.format(new Date(`${on}T00:00:00Z`))} · ${when}`
      : `Latest value · ${when}`;
  }
  return q.session.state === "open"
    ? `Live · market open · ${when}`
    : `Close · market closed · ${when}`;
}

// a failed read's own words are for agents; the page says it plainly
export const UNREAD = "Couldn't get a new price. Showing the last one stored.";

// how far the price is from the quote's 200-week average: in percent, or
// in points for a series that is itself a percent (a yield); null when
// the listing is too young for one
export function weekly200(d: Detail): { text: string; dir: -1 | 0 | 1 } | null {
  const avg = d.quote?.signals?.weekly?.sma200 ?? null;
  const now =
    d.quote?.price ?? d.quote?.observation?.value ?? d.instrument.price;
  if (avg === null || avg === 0 || now === null) return null;
  const points = d.instrument.unit === "percent";
  const by = points ? now - avg : ((now - avg) / Math.abs(avg)) * 100;
  const n = Math.abs(by).toFixed(2);
  const dir = Number(n) === 0 ? 0 : by > 0 ? 1 : -1;
  const side = dir > 0 ? " above" : dir < 0 ? " below" : "";
  return { text: `${n}${points ? " pts" : "%"}${side}`, dir };
}

export const RETURNS: readonly { key: keyof Returns; label: string }[] = [
  { key: "1w", label: "1 week" },
  { key: "1m", label: "1 month" },
  { key: "3m", label: "3 months" },
  { key: "ytd", label: "Year to date" },
];

// a series that is itself a percent (a yield) returns in points
export function returnCell(
  value: number | null,
  points = false,
): {
  text: string;
  dir: -1 | 0 | 1;
} {
  if (value === null) return { text: "—", dir: 0 };
  const n = Math.abs(value).toFixed(2);
  const dir = Number(n) === 0 ? 0 : value > 0 ? 1 : -1;
  const sign = dir > 0 ? "+" : dir < 0 ? "−" : "";
  return { text: `${sign}${n}${points ? " pts" : "%"}`, dir };
}

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
        : c.parts.includes(r.part!) && c.sections.length === 0,
    )?.label ??
    r.section ??
    r.part ??
    r.symbol
  );
}

export const deleteLine =
  "Its prices, history and research are deleted. It comes back if an agent asks for it.";
