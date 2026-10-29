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
import { volumeText } from "./Chart.model.ts";
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
  if (q.session.state !== "open") return `Closed · ${when}`;
  // until the first live price after the open, the price is yesterday's
  const traded = Date.parse(q.trade_time ?? q.fetched_at ?? "");
  const start = Date.parse(q.session.start ?? "");
  return traded < start ? `Open · previous close · ${when}` : `Open · ${when}`;
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

export const RETURNS: readonly {
  key: keyof Returns;
  label: string;
  short: string;
}[] = [
  { key: "1w", label: "1 week", short: "1W" },
  { key: "1m", label: "1 month", short: "1M" },
  { key: "3m", label: "3 months", short: "3M" },
  { key: "ytd", label: "Year to date", short: "YTD" },
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
        : c.parts.includes(r.part) && c.sections.length === 0,
    )?.label ??
    r.section ??
    r.part
  );
}

export const deleteLine =
  "Its prices, history and research are deleted. It comes back if an agent asks for it.";

// the cards under the chart: plain words over the quote's daily signals
export type Tone = "up" | "down" | null;
export type StatRow = {
  label: string;
  value: string;
  note?: string;
  tone?: Tone;
  phone?: boolean;
};
export type Span = { low: string; high: string; at: number };
export type StatCard = { title: string; span?: Span; rows: StatRow[] };

const pct = (v: number) => `${Math.abs(v).toFixed(2)}%`;
const toneOf = (v: number): Tone => (v > 0 ? "up" : v < 0 ? "down" : null);

// where the price sits between a low and a high, 0 to 1
function span(
  d: Detail,
  low: number | null,
  high: number | null,
  now: number | null,
): Span | undefined {
  if (low === null || high === null || now === null || high <= low)
    return undefined;
  const at = Math.min(1, Math.max(0, (now - low) / (high - low)));
  return { low: priceOf(d, low), high: priceOf(d, high), at };
}

const priceOf = (d: Detail, v: number) => price({ ...d.instrument, price: v });

// a series that is itself a percent (a yield) moves in points, as the
// head's 200-week line says
const inPoints = (d: Detail) => d.instrument.unit === "percent";
const pointsOf = (v: number) => `${Math.abs(v).toFixed(2)} pts`;
const flat = (v: number) => Number(Math.abs(v).toFixed(2)) === 0;

// the price beside an average, said as above or below it
function besideAverage(
  d: Detail,
  label: string,
  avg: number | null,
  now: number | null,
): StatRow | null {
  if (avg === null || avg === 0 || now === null) return null;
  const by = inPoints(d) ? now - avg : ((now - avg) / Math.abs(avg)) * 100;
  const side = flat(by)
    ? "at it"
    : `${inPoints(d) ? pointsOf(by) : pct(by)} ${by > 0 ? "above" : "below"}`;
  return {
    label,
    value: side,
    note: priceOf(d, avg),
    tone: flat(by) ? null : toneOf(by),
  };
}

function rsiWord(v: number): string {
  if (v >= 70) return "overbought";
  if (v <= 30) return "oversold";
  return "neutral";
}

const sessionsAgo = (n: number) =>
  n === 0 ? "today" : `${n} trading ${n === 1 ? "day" : "days"} ago`;

export function stats(d: Detail): StatCard[] {
  const q = d.quote;
  const s = q?.signals?.daily ?? null;
  const now = q?.price ?? q?.observation?.value ?? d.instrument.price;
  const cards: StatCard[] = [];
  if (s !== null) {
    const rows: StatRow[] = [];
    if (s.drawdown !== null) {
      const at = flat(s.drawdown);
      rows.push({
        label: "From the high",
        value: at ? "at the high" : `${pct(s.drawdown)} below`,
        note:
          s.days_since_high === null
            ? undefined
            : sessionsAgo(s.days_since_high),
        tone: at ? null : "down",
      });
    }
    if (s.from_low !== null) {
      const at = flat(s.from_low);
      rows.push({
        label: "From the low",
        value: at ? "at the low" : `${pct(s.from_low)} above`,
        tone: at ? null : "up",
      });
    }
    const y = span(d, s.low52w, s.high52w, now);
    if (y || rows.length > 0)
      cards.push({ title: "52-week range", span: y, rows });
  }
  {
    const rows: StatRow[] = [];
    // at the open, until the first pass lands, the quote is still the
    // last session's
    const traded = Date.parse(q?.trade_time ?? q?.fetched_at ?? "");
    const today =
      q?.session?.state === "open" &&
      !(traded < Date.parse(q.session.start ?? ""));
    if (q?.volume) {
      const ratio = s?.volume_ratio ?? null;
      rows.push({
        label: today ? "Volume so far" : "Volume",
        value: volumeText(q.volume),
        note:
          ratio === null
            ? undefined
            : `${ratio.toFixed(2)}× the 20-day average`,
      });
    }
    if (s?.volatility20 != null) {
      rows.push({
        label: "Typical daily move",
        value: `${s.volatility20.toFixed(2)}%`,
        note: "over 20 days",
      });
    }
    if (s?.atr14 != null) {
      const pts = inPoints(d) || d.instrument.unit === "percent_of_par";
      rows.push({
        label: "Average daily range",
        value: pts ? pointsOf(s.atr14) : priceOf(d, s.atr14),
        note: "over 14 days",
      });
    }
    const t = span(d, q?.day_low ?? null, q?.day_high ?? null, now);
    if (t || rows.length > 0)
      cards.push({ title: today ? "Today" : "Last session", span: t, rows });
  }
  if (s !== null) {
    const rows: StatRow[] = [];
    const a50 = besideAverage(d, "50-day average", s.sma50, now);
    const a200 = besideAverage(d, "200-day average", s.sma200, now);
    if (a50) rows.push(a50);
    if (a200) rows.push(a200);
    const w200 = besideAverage(
      d,
      "200-week average",
      d.quote?.signals?.weekly?.sma200 ?? null,
      now,
    );
    if (w200) rows.push({ ...w200, phone: true });
    if (s.cross !== null && s.cross !== 0) {
      const above = s.cross > 0;
      // the cross is news only on its day; after it, the side says it
      rows.push({
        label: "50-day vs 200-day",
        value: above ? "above" : "below",
        note: s.cross_edge
          ? `${above ? "golden" : "death"} cross today`
          : undefined,
        tone: above ? "up" : "down",
      });
    }
    if (s.rsi14 !== null) {
      rows.push({
        label: "RSI 14",
        value: s.rsi14.toFixed(1),
        note: rsiWord(s.rsi14),
      });
    }
    if (s.macd_histogram !== null) {
      // the side is the histogram's sign; a turn is its direction changing,
      // which can come on either side, so it is only the day's note
      const h = s.macd_histogram;
      const turn = s.macd_turn ?? 0;
      rows.push({
        label: "Momentum",
        value: h > 0 ? "upward" : h < 0 ? "downward" : "flat",
        note:
          turn > 0
            ? "turning up today"
            : turn < 0
              ? "turning down today"
              : undefined,
        tone: h > 0 ? "up" : h < 0 ? "down" : null,
      });
    }
    if (rows.length > 0) cards.push({ title: "Trend", rows });
  }
  return cards;
}
