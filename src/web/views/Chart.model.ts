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
  open?: number | null;
  high?: number | null;
  low?: number | null;
  close: number | null;
  volume?: number | null;
  final: boolean;
  sma50: number | null;
  sma200: number | null;
};

export type History = {
  id: string;
  unit: string;
  interval: Interval;
  session: { state: "open" | "closed" } | null;
  bars: HistoryBar[];
};

// a 5-minute close; at in UTC
export type Point = {
  at: string;
  session: string;
  close: number;
  final: boolean;
};

export type Intraday = {
  id: string;
  unit: string;
  interval: "5m";
  session: { state: "open" | "closed" } | null;
  points: Point[];
};

// the stored 5-minute closes: the newest session, or all five kept
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
export const DEFAULT_RANGE: DailyRange = "1Y";

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

// the viewer's offset from UTC at an instant, in ms
export const localOffset = (at: number): number =>
  -new Date(at).getTimezoneOffset() * 60_000;

// The library draws a time as UTC, so each point is shifted to the viewer's
// wall time, in seconds; a repeated hour at a clock change would step back,
// so its points are left out. No gap is drawn for a night or a weekend.
export function pointLine(
  points: readonly Point[],
  offset: (at: number) => number = localOffset,
): { time: number; value: number; point: Point }[] {
  const out: { time: number; value: number; point: Point }[] = [];
  for (const p of points) {
    const at = Date.parse(p.at);
    const time = (at + offset(at)) / 1000;
    const last = out.at(-1);
    if (last !== undefined && time <= last.time) continue;
    out.push({ time, value: p.close, point: p });
  }
  return out;
}

// a shifted time's wall clock, HH:MM
export const clockOf = (time: number): string =>
  new Date(time * 1000).toISOString().slice(11, 16);

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
  // a 5-minute close's local time
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
  const points = h.unit === "percent";
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

// the point under the crosshair (a shifted time), else the latest
export function pointLegendOf(
  h: Intraday,
  time: number | null,
  offset: (at: number) => number = localOffset,
): Legend | null {
  const line = pointLine(h.points, offset);
  const shown = time === null ? line.at(-1) : line.find((l) => l.time === time);
  if (shown === undefined) return null;
  const { point } = shown;
  const first = h.points[0]?.close ?? null;
  const points = h.unit === "percent";
  return {
    date: new Date(shown.time * 1000).toISOString().slice(0, 10),
    time: clockOf(shown.time),
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

// the chart's choices, kept for the next chart this browser draws; 1D and
// 5D are never kept, so the daily chart's settings stay as they were
export type Settings = {
  range: DailyRange;
  line: boolean;
  log: boolean;
  sma50: boolean;
  sma200: boolean;
};

export const DEFAULT_SETTINGS: Settings = {
  range: DEFAULT_RANGE,
  line: false,
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
    range: DAILY.includes(v.range as DailyRange)
      ? (v.range as DailyRange)
      : DEFAULT_RANGE,
    line: flag("line"),
    log: flag("log"),
    sma50: flag("sma50"),
    sma200: flag("sma200"),
  };
}
