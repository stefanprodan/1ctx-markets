// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// The chart's data from a history answer, apart from the library, so it
// is tested without a canvas.

// three letters always: en-GB says "Sept"
const MONTH = new Intl.DateTimeFormat("en-US", {
  month: "short",
  timeZone: "UTC",
});

export type Interval = "1d" | "1wk";

export type HistoryBar = {
  date: string;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
  volume: number | null;
  final: boolean;
  sma50: number | null;
  sma200: number | null;
};

// the bars' instrument, of the facts the chart reads
export type Facts = { id: string; unit: string };

export type History = {
  instrument: Facts;
  interval: Interval;
  session: { state: "open" | "closed" } | null;
  bars: HistoryBar[];
};

export type Point = {
  at: string;
  session: string;
  close: number;
  final: boolean;
};

export type Intraday = {
  instrument: Facts;
  interval: "5m";
  session: {
    state: "open" | "closed";
    start?: string | null;
    end?: string | null;
  } | null;
  previous_close: number | null;
  points: Point[];
  // pre and post trading, asked for 1D only
  extended_points?: { at: string; session: "pre" | "post"; close: number }[];
};

export const INTRADAY = ["1D", "5D"] as const;
export type IntradayRange = (typeof INTRADAY)[number];

export const DAILY = [
  "1M",
  "3M",
  "6M",
  "YTD",
  "1Y",
  "3Y",
  "5Y",
  "Max",
] as const;
export type DailyRange = (typeof DAILY)[number];

export const RANGES = [...INTRADAY, ...DAILY] as const;
export type Range = (typeof RANGES)[number];
export const DEFAULT_RANGE: Range = "1D";

export const PHONE_RANGES: readonly Range[] = [
  "1D",
  "5D",
  "1M",
  "6M",
  "YTD",
  "1Y",
  "5Y",
  "Max",
];
export const phoneRange = (r: Range): Range =>
  r === "3M" ? "6M" : r === "3Y" ? "5Y" : r;

// one choice for the drawing and the stylesheet, so they never disagree
export type Look = {
  phone: boolean;
  ranges: readonly Range[];
  candles: boolean;
  averages: boolean;
  volume: boolean;
  log: boolean;
  axis: boolean;
  ohlc: boolean;
};
export const DESK: Look = {
  phone: false,
  ranges: RANGES,
  candles: true,
  averages: true,
  volume: true,
  log: true,
  axis: true,
  ohlc: true,
};
export const PHONE: Look = {
  phone: true,
  ranges: PHONE_RANGES,
  candles: false,
  averages: false,
  volume: false,
  log: false,
  axis: false,
  ohlc: false,
};
export const lookOf = (phone: boolean): Look => (phone ? PHONE : DESK);

// the kept range stays as chosen; a look without it draws its neighbour
export const drawnRange = (look: Look, r: Range): Range =>
  look.ranges.includes(r) ? r : phoneRange(r);

export const isIntraday = (r: Range): r is IntradayRange =>
  (INTRADAY as readonly string[]).includes(r);

const MONTHS: Record<Exclude<DailyRange, "YTD" | "Max">, number> = {
  "1M": 1,
  "3M": 3,
  "6M": 6,
  "1Y": 12,
  "3Y": 36,
  "5Y": 60,
};

// past two years a range reads weekly bars: a few hundred pixels never
// need thousands of days
export const intervalOf = (range: DailyRange): Interval =>
  range === "3Y" || range === "5Y" || range === "Max" ? "1wk" : "1d";

const iso = (d: Date) => d.toISOString().slice(0, 10);

// the first day a range asks for, from today's date in UTC; Max is the
// ten years the server keeps
export function fromOf(range: DailyRange, today: string): string {
  if (range === "YTD") return `${today.slice(0, 4)}-01-01`;
  const months = range === "Max" ? 120 : MONTHS[range];
  const [y, m, day] = today.split("-").map(Number) as [number, number, number];
  const at = y * 12 + (m - 1) - months;
  const year = Math.floor(at / 12);
  const month = at % 12;
  // the same day, or the month's last when it is shorter (31 Mar → 28 Feb)
  const last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return iso(new Date(Date.UTC(year, month, Math.min(day, last))));
}

// candles need an open; a series with none (FRED, an index given as
// closes) is a line
export const hasCandles = (bars: readonly HistoryBar[]): boolean =>
  bars.some((b) => b.open != null && b.high != null && b.low != null);

export const hasVolume = (bars: readonly HistoryBar[]): boolean =>
  bars.some((b) => b.volume != null && b.volume > 0);

export type Candle = {
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
};

// a bar the live quote made has no open yet: the last close stands in,
// and its high and low take in the close
export function candles(bars: readonly HistoryBar[]): Candle[] {
  const out: Candle[] = [];
  let prev: number | null = null;
  for (const b of bars) {
    if (b.close === null) continue;
    const open = b.open ?? prev ?? b.close;
    out.push({
      time: b.date,
      open,
      high: Math.max(b.high ?? b.close, open, b.close),
      low: Math.min(b.low ?? b.close, open, b.close),
      close: b.close,
    });
    prev = b.close;
  }
  return out;
}

export type Levels = { ref: number | null; high: number; low: number };
export function levelsOf(
  ref: number | null,
  highs: readonly number[],
  lows: readonly number[] = highs,
): Levels | null {
  if (highs.length === 0 || lows.length === 0) return null;
  let high = -Infinity;
  let low = Infinity;
  for (const v of highs) if (v > high) high = v;
  for (const v of lows) if (v < low) low = v;
  return { ref, high, low };
}

export const closes = (bars: readonly HistoryBar[]) =>
  bars.flatMap((b) =>
    b.close === null ? [] : [{ time: b.date, value: b.close }],
  );

export const averages = (
  bars: readonly HistoryBar[],
  key: "sma50" | "sma200",
) =>
  bars.flatMap((b) => {
    const v = b[key];
    return v === null ? [] : [{ time: b.date, value: v }];
  });

// each bar's volume, up or down by its own close against the one before
export function volumes(bars: readonly HistoryBar[]) {
  const out: { time: string; value: number; up: boolean }[] = [];
  let prev: number | null = null;
  for (const b of bars) {
    if (b.close === null) continue;
    if (b.volume != null) {
      out.push({
        time: b.date,
        value: b.volume,
        up: prev === null || b.close >= prev,
      });
    }
    prev = b.close;
  }
  return out;
}

// real UTC seconds, so a clock change never reorders or drops a point
export const pointLine = (points: readonly { at: string; close: number }[]) =>
  points.map((p) => ({ time: Date.parse(p.at) / 1000, value: p.close }));

const SLOT_S = 300;

// empty 5-minute slots to the session's end, so a day spans its whole
// session as the home cards draw it and a morning fills only the morning
export function sessionSlots(
  times: readonly number[],
  session: Intraday["session"],
): number[] {
  const first = times[0];
  const last = times.at(-1);
  const start = Date.parse(session?.start ?? "") / 1000;
  const end = Date.parse(session?.end ?? "") / 1000;
  if (first === undefined || last === undefined) return [];
  if (!(start <= first && last < end)) return [];
  const slots: number[] = [];
  for (let t = start + SLOT_S; t <= end; t += SLOT_S) {
    if (t > last) slots.push(t);
  }
  return slots;
}

const clocks = new Map<string, Intl.DateTimeFormat>();

// no zone is the viewer's; the library would label every time in UTC
export function localTime(
  seconds: number,
  zone?: string,
): { date: string; time: string } {
  const key = zone ?? "";
  let f = clocks.get(key);
  if (f === undefined) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
    clocks.set(key, f);
  }
  const p: Record<string, string> = {};
  for (const part of f.formatToParts(seconds * 1000)) p[part.type] = part.value;
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    time: `${p.hour}:${p.minute}`,
  };
}

// a day as the library writes one (dd MMM 'yy), since a formatter replaces it
export function timeLabel(
  time: unknown,
  zone?: string,
  locale?: string,
): string {
  if (typeof time === "number") {
    const t = localTime(time, zone);
    return `${dayOf(t.date)} ${t.time}`;
  }
  const date =
    typeof time === "string"
      ? time
      : (() => {
          const d = time as { year: number; month: number; day: number };
          const two = (n: number) => String(n).padStart(2, "0");
          return `${d.year}-${two(d.month)}-${two(d.day)}`;
        })();
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const month = new Date(y, m - 1, 1).toLocaleString(locale, {
    month: "short",
  });
  return `${String(d).padStart(2, "0")} ${month} '${String(y % 100).padStart(2, "0")}`;
}

// the last bar is still trading while its market is open
export const isLive = (h: History): boolean =>
  h.session?.state === "open" && h.bars.at(-1)?.final === false;

export const averageLabel = (interval: Interval, days: 50 | 200): string =>
  `${days}-${interval === "1d" ? "day" : "week"} average`;

export function dayOf(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  return `${d.getUTCDate()} ${MONTH.format(d)} ${d.getUTCFullYear()}`;
}

export type Legend = {
  date: string;
  time?: string;
  live: boolean;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
  volume: number | null;
  // from the range's first close: in percent, or in points for a series
  // that is itself a percent (a yield moves in points)
  change: number | null;
  points: boolean;
  sma50: number | null;
  sma200: number | null;
  // C is the regular session's alone
  session?: "pre" | "post";
};

const lastOf = (bars: readonly HistoryBar[], key: "sma50" | "sma200") =>
  bars.findLast((b) => b[key] !== null)?.[key] ?? null;

// what the legend says of one bar: under the crosshair, else the latest
export function legendOf(h: History, date: string | null): Legend | null {
  const bar =
    date === null ? h.bars.at(-1) : h.bars.find((b) => b.date === date);
  if (bar === undefined) return null;
  const first = h.bars.find((b) => b.close !== null)?.close ?? null;
  const live = isLive(h) && bar === h.bars.at(-1);
  const points = h.instrument.unit === "percent";
  return {
    date: bar.date,
    live,
    open: bar.open ?? null,
    high: bar.high ?? null,
    low: bar.low ?? null,
    close: bar.close,
    volume: bar.volume ?? null,
    change:
      first === null || bar.close === null
        ? null
        : points
          ? bar.close - first
          : first === 0
            ? null
            : ((bar.close - first) / first) * 100,
    points,
    // at rest a week still open has no average yet: the last one stands
    sma50: bar.sma50 ?? (date === null ? lastOf(h.bars, "sma50") : null),
    sma200: bar.sma200 ?? (date === null ? lastOf(h.bars, "sma200") : null),
  };
}

export function pointLegendOf(
  h: Intraday,
  time: number | null,
  zone?: string,
): Legend | null {
  const near = (p: { at: string }) => Date.parse(p.at) / 1000 === time;
  const outside =
    time === null ? undefined : h.extended_points?.find((p) => near(p));
  // at rest the newest price, an after-hours one when it is later
  const newest = h.points.at(-1);
  const after = h.extended_points?.findLast(
    (p) =>
      p.session === "post" &&
      newest !== undefined &&
      Date.parse(p.at) > Date.parse(newest.at),
  );
  const rest = after ? { ...after, final: true } : newest;
  const regular = time === null ? undefined : h.points.find(near);
  // the session's empty slots ahead hold no price: the newest stands
  const point = regular ?? (outside && { ...outside, final: true }) ?? rest;
  if (point === undefined) return null;
  const session =
    regular !== undefined
      ? undefined
      : outside !== undefined
        ? outside.session
        : after?.session;
  const first = h.previous_close ?? h.points[0]?.close ?? null;
  const points = h.instrument.unit === "percent";
  const local = localTime(Date.parse(point.at) / 1000, zone);
  return {
    date: local.date,
    time: local.time,
    live:
      h.session?.state === "open" && !point.final && point === h.points.at(-1),
    open: null,
    high: null,
    low: null,
    close: point.close,
    volume: null,
    change:
      first === null
        ? null
        : points
          ? point.close - first
          : first === 0
            ? null
            : ((point.close - first) / first) * 100,
    points,
    sma50: null,
    sma200: null,
    session,
  };
}

export function figure(v: number | null): string {
  if (v === null) return "—";
  const a = Math.abs(v);
  const d = a >= 10 ? 2 : a >= 1 ? 3 : 4;
  return v.toLocaleString("en-US", {
    minimumFractionDigits: Math.min(d, 2),
    maximumFractionDigits: d,
  });
}

// the price axis and its labels: separators, and no cents where a
// price runs to five figures, so a phone's axis stays narrow
export function axisPrice(v: number): string {
  if (Math.abs(v) >= 10_000) {
    return v.toLocaleString("en-US", { maximumFractionDigits: 0 });
  }
  return figure(v);
}

export function volumeText(v: number | null): string {
  if (v === null) return "—";
  if (v >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
  return String(v);
}

// the axis's ticks: a year, a month's name, or a day with its month,
// never a bare day number
export function tick(date: string, kind: "year" | "month" | "day"): string {
  const d = new Date(`${date}T00:00:00Z`);
  if (kind === "year") return date.slice(0, 4);
  const month = MONTH.format(d);
  return kind === "month" ? month : `${d.getUTCDate()} ${month}`;
}

export function changeText(v: number | null, points = false): string {
  if (v === null) return "";
  const n = Math.abs(v).toFixed(2);
  const flat = Number(n) === 0;
  return `${flat ? "" : v > 0 ? "+" : "−"}${n}${points ? " pts" : "%"}`;
}

// the chart's choices, kept for the next chart this browser draws
export type Settings = {
  range: Range;
  line: boolean;
  log: boolean;
  sma50: boolean;
  sma200: boolean;
};

export const DEFAULT_SETTINGS: Settings = {
  range: DEFAULT_RANGE,
  line: true,
  log: false,
  sma50: true,
  sma200: true,
};

// a kept value that is not one of ours falls back, field by field
export function readSettings(raw: string | null): Settings {
  let v: Record<string, unknown> = {};
  try {
    const parsed: unknown = raw === null ? null : JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null) {
      v = parsed as Record<string, unknown>;
    }
  } catch {
    // a broken value reads as none
  }
  const flag = (k: keyof Settings) =>
    typeof v[k] === "boolean"
      ? (v[k] as boolean)
      : (DEFAULT_SETTINGS[k] as boolean);
  return {
    range: RANGES.includes(v.range as Range)
      ? (v.range as Range)
      : DEFAULT_RANGE,
    line: flag("line"),
    log: flag("log"),
    sma50: flag("sma50"),
    sma200: flag("sma200"),
  };
}

type Value<T> = { time: T; value: number };

// each joined to the session's nearest close; the closing trade can share
// the first post bar's minute, which the library refuses twice
export function extendedLines<T extends number>(
  session: readonly Value<T>[],
  outside: readonly (Value<T> & { session: "pre" | "post" })[],
): { pre: Value<T>[]; post: Value<T>[] } {
  const first = session[0];
  const last = session.at(-1);
  if (first === undefined || last === undefined) return { pre: [], post: [] };
  const plain = ({ time, value }: Value<T>) => ({ time, value });
  const before = outside
    .filter((p) => p.session === "pre" && p.time < first.time)
    .map(plain);
  const after = outside
    .filter((p) => p.session === "post" && p.time > last.time)
    .map(plain);
  return {
    pre: before.length > 0 ? [...before, first] : [],
    post: after.length > 0 ? [last, ...after] : [],
  };
}
