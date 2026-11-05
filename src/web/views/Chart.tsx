// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// The price chart: TradingView's Lightweight Charts, run only when a
// chart is drawn (the binary ships it in the page's bundle), coloured
// from the page's tokens and again on a theme flip. The licence's link is the page's footer (CHART_CREDIT), so the
// logo, which sat on the volume, is off.
//
// TradingView Lightweight Charts™
// Copyright (c) 2026 TradingView, Inc. https://www.tradingview.com/

import { batch, useSignal } from "@preact/signals";
import type {
  AutoscaleInfo,
  IChartApi,
  ISeriesApi,
  MouseEventParams,
  SeriesType,
  Time,
  UTCTimestamp,
} from "lightweight-charts";
import type { ComponentChildren, Ref } from "preact";
import { useEffect, useLayoutEffect, useMemo, useRef } from "preact/hooks";
import { onPhone } from "../app/shell.ts";
import { theme } from "../app/theme.ts";
import { says } from "../data/api.ts";
import { markets } from "../data/store.ts";
import {
  briefQuantity,
  figure,
  quantity,
  signedChange,
  volumeText,
} from "../lib/format.ts";
import { useRefresh } from "../lib/refresh.ts";
import { slowFlag } from "../lib/slow.ts";
import { Card } from "../ui/Card.tsx";
import { Placeholder, WaitWords } from "../ui/Placeholder.tsx";
import { Segmented } from "../ui/Segmented.tsx";
import {
  averageLabel,
  averages,
  axisPrice,
  candles,
  clearOfTags,
  closes,
  DESK,
  dayOf,
  drawnFor,
  extendedLines,
  fromOf,
  type History,
  hasCandles,
  hasVolume,
  type Intraday,
  intervalOf,
  isIntraday,
  isLive,
  type Legend,
  type Levels,
  type Look,
  legendOf,
  levelsOf,
  localTime,
  lookOf,
  MONTHLY_SHARES,
  monthlyShares,
  pointerAt,
  pointLegendOf,
  pointLine,
  type Range,
  type Rest,
  rangesOf,
  readRange,
  readSettings,
  type Settings,
  sessionSlots,
  type TradeMark,
  tick,
  timeLabel,
  tradeMarks,
  volumes,
} from "./Chart.model.ts";
import "./chart.css";

type Lib = typeof import("lightweight-charts");

const token = (name: string) =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim();

// a colour at an alpha, from a token in #rrggbb
function alpha(hex: string, a: number): string {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (m === null) return hex;
  const n = Number.parseInt(m[1]!, 16);
  return `rgba(${n >> 16}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

export type Colors = ReturnType<typeof colors>;

type Mark = {
  role: "ref" | "high" | "low";
  side: "left" | "right";
  y: number;
  text: string;
};

// how far apart a buy and a sell on one bar sit
const SPLIT_PX = 5;

// a trade mark placed on the plot, in the plot's pixels
type Dot = TradeMark & { x: number; y: number; month: boolean };

// a month reads as its total, a day as its price
const tradeText = (d: Dot) => {
  const did = d.side === "buy" ? "Bought" : "Sold";
  return d.month
    ? `${did} ${quantity(d.quantity)} for ${figure(d.quantity * d.price)}`
    : `${did} ${quantity(d.quantity)} at ${figure(d.price)}`;
};

function colors() {
  return {
    card: token("--card"),
    page: token("--page"),
    fg: token("--fg"),
    faint: token("--faint"),
    line: token("--line"),
    up: token("--chart-up"),
    down: token("--chart-down"),
    sma50: token("--chart-sma50"),
    sma200: token("--chart-sma200"),
    buy: token("--chart-buy"),
    font: token("--mono"),
  };
}

// the library hands a day back as given, or as its own business day
function dateOf(time: unknown): string {
  if (typeof time === "string") return time;
  if (typeof time === "number")
    return new Date(time * 1000).toISOString().slice(0, 10);
  const t = time as { year: number; month: number; day: number };
  const two = (n: number) => String(n).padStart(2, "0");
  return `${t.year}-${two(t.month)}-${two(t.day)}`;
}

export const CHART_CREDIT = "https://www.tradingview.com/";

// apart from the bars, so no frame shows the library's white
export function paintOptions(
  l: Pick<Lib, "ColorType" | "PriceScaleMode">,
  k: Colors,
  log: boolean,
  look: Look = DESK,
) {
  const bare = !look.axis;
  return {
    layout: {
      background: { type: l.ColorType.Solid, color: bare ? k.page : k.card },
      textColor: k.faint,
      fontFamily: k.font,
      fontSize: 11,
      attributionLogo: false,
      panes: { separatorColor: k.line, separatorHoverColor: k.line },
    },
    grid: {
      vertLines: { visible: false },
      horzLines: { visible: !bare, color: alpha(k.line, 0.7) },
    },
    rightPriceScale: {
      visible: !bare,
      borderVisible: false,
      scaleMargins: bare
        ? { top: 0.12, bottom: 0.12 }
        : { top: 0.1, bottom: 0.04 },
      mode: log ? l.PriceScaleMode.Logarithmic : l.PriceScaleMode.Normal,
    },
    crosshair: {
      vertLine: { color: k.faint, labelBackgroundColor: k.faint },
      horzLine: { color: k.faint, labelBackgroundColor: k.faint },
    },
  };
}

// the price pane's own format; volume keeps the library's
const PRICE = {
  type: "custom" as const,
  formatter: axisPrice,
  minMove: 0.0001,
};

const SETTINGS_KEY = "chart";

// storage may be blocked or full: the chart then starts from the defaults
function loadSettings(): Settings {
  try {
    return readSettings(localStorage.getItem(SETTINGS_KEY));
  } catch {
    return readSettings(null);
  }
}

function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  } catch {
    // kept for this page only
  }
}

const today = () => new Date().toISOString().slice(0, 10);

export function LegendLine({
  legend,
  interval,
  range,
  since,
  show,
}: {
  legend: Legend;
  interval: History["interval"] | Intraday["interval"];
  range: Range;
  // in place of the range's name when the range starts before the bars
  since?: string | null;
  show: { sma50: boolean; sma200: boolean; ohlc?: boolean };
}) {
  const ohlc = show.ohlc !== false;
  const dir =
    legend.change === null || Math.abs(legend.change) < 0.005
      ? ""
      : legend.change > 0
        ? " up"
        : " down";
  return (
    <div class="chart-legend">
      <span class="chart-legend-row">
        <span class="chart-date">
          {dayOf(legend.date)}
          {legend.time !== undefined && ` ${legend.time}`}
        </span>
        {legend.live && <span class="chart-live">Live</span>}
        {ohlc && legend.open !== null && (
          <>
            <span>
              <i>O</i> {figure(legend.open)}
            </span>
            <span>
              <i>H</i> {figure(legend.high)}
            </span>
            <span>
              <i>L</i> {figure(legend.low)}
            </span>
          </>
        )}
        <span>
          {/* short, as the C it replaces */}
          <i>
            {legend.session === "post"
              ? "Post"
              : legend.session === "pre"
                ? "Pre"
                : "C"}
          </i>{" "}
          {figure(legend.close)}
        </span>
        {ohlc && legend.volume !== null && (
          <span>
            <i>Vol</i> {volumeText(legend.volume)}
          </span>
        )}
        {legend.change !== null && (
          <span class={`chart-change${dir}`}>
            <i>{since ?? range}</i>{" "}
            {signedChange(legend.change, { points: legend.points }).text}
          </span>
        )}
      </span>
      {interval !== "5m" && (show.sma50 || show.sma200) && (
        <span class="chart-legend-row">
          {show.sma50 && legend.sma50 !== null && (
            <span class="chart-avg chart-avg-50">
              {averageLabel(interval, 50)} {figure(legend.sma50)}
            </span>
          )}
          {show.sma200 && legend.sma200 !== null && (
            <span class="chart-avg chart-avg-200">
              {averageLabel(interval, 200)} {figure(legend.sma200)}
            </span>
          )}
        </span>
      )}
    </div>
  );
}

function ChartFrame({
  head,
  note,
  legend,
  legendRef,
  canvasRef,
  wait,
  children,
}: {
  head: ComponentChildren;
  note?: ComponentChildren;
  legend?: ComponentChildren;
  legendRef?: Ref<HTMLDivElement>;
  canvasRef?: Ref<HTMLDivElement>;
  wait?: ComponentChildren;
  children?: ComponentChildren;
}) {
  return (
    <Card
      flush
      label="Chart"
      class={`chart-card${lookOf(onPhone.value).phone ? " chart-phone" : ""}`}
    >
      <div class="card-head chart-head">{head}</div>
      <div class="chart-body">
        {note}
        {/* holds the tallest the legend has been, so the plot never
            moves as the crosshair changes its rows */}
        <div ref={legendRef}>
          {legend || (
            // a first guess at its room before the first answer
            <div class="chart-legend chart-legend-wait" aria-hidden="true" />
          )}
        </div>
        <div class={`chart-plot${wait ? " chart-plot-wait" : ""}`}>
          <div class="chart-canvas" ref={canvasRef} />
          {wait && <p class="chart-wait">{wait}</p>}
          {children}
        </div>
      </div>
    </Card>
  );
}

export function ChartWaiting({ children }: { children: ComponentChildren }) {
  return (
    <ChartFrame
      head={
        <div class="chart-ranges">
          <Placeholder chars={28} />
        </div>
      }
      wait={children}
    />
  );
}

export function Chart({
  id,
  intraday,
  hand = false,
  saved = 0,
}: {
  id: string;
  intraday: boolean;
  // prices entered by hand, a month apart: no averages over them
  hand?: boolean;
  // the page's saves: a trade or price saved there draws at once
  saved?: number;
}) {
  const box = useRef<HTMLDivElement>(null);
  const legendBox = useRef<HTMLDivElement>(null);
  const tallest = useRef({ shape: "", px: 0 });
  const kept = useRef(loadSettings()).current;
  // a fund's prices are a month apart: it opens on a year
  const range = useSignal<Range>(hand ? "1Y" : kept.range);
  const data = useSignal<History | Intraday | null>(null);
  const error = useSignal<string | null>(null);
  const line = useSignal(kept.line);
  const log = useSignal(kept.log);
  const sma50 = useSignal(kept.sma50);
  const sma200 = useSignal(kept.sma200);
  // the caller's trades of this instrument, marked on its line
  const trades = useSignal<
    readonly {
      date: string;
      side: "buy" | "sell";
      quantity: number;
      price: number;
    }[]
  >([]);
  useEffect(() => {
    let live = true;
    void markets.portfolios.tradesOf(id).then((got) => {
      if (!live || got === null) return;
      const kept = got.filter((t) => t.removed_at === null);
      // an empty answer for an empty list would redraw the chart for nothing
      if (kept.length > 0 || trades.value.length > 0) trades.value = kept;
    });
    return () => {
      live = false;
    };
  }, [id, saved]);
  useEffect(() => {
    // a fund's own range and style are not the ones a share opens with
    if (hand) return;
    saveSettings({
      range: range.value,
      line: line.value,
      log: log.value,
      sma50: sma50.value,
      sma200: sma200.value,
    });
  }, [range.value, line.value, log.value, sma50.value, sma200.value]);
  // a kept toggle the look has no button for draws as off, never stuck on
  const look = () => {
    const lk = lookOf(onPhone.value);
    return hand ? { ...lk, averages: false, candles: false } : lk;
  };
  const logScale = () => log.value && look().log;
  const show50 = () => sma50.value && look().averages;
  const show200 = () => sma200.value && look().averages;
  const candlesOn = () => !line.value && look().candles;
  const marks = useSignal<Mark[]>([]);
  const dots = useSignal<Dot[]>([]);
  // the price pane's plot, so a mark never sits on the scale
  const plot = useSignal<{ w: number; h: number } | null>(null);
  // a trade sits on its bar's close, on the line; its own price is in its label
  const dotsAt = useRef<{
    s: ISeriesApi<SeriesType>;
    at: TradeMark[];
    // a year or more: each month's trades as one
    month: boolean;
    close: Map<string, number>;
  } | null>(null);
  const levels = useRef<{ s: ISeriesApi<SeriesType>; at: Levels } | null>(null);
  const active = () => drawnFor(look(), range.value, intraday);
  const hover = useSignal<string | number | null>(null);
  const rest = useRef<Rest>(null);
  const reading = useSignal(true);
  const wait = useMemo(() => slowFlag(), []);
  const lib = useRef<Lib | null>(null);
  const chart = useRef<IChartApi | null>(null);
  const series = useRef<ISeriesApi<SeriesType>[]>([]);
  // read at paint, so the tags are the ones on screen then
  const priceFormat = useRef({
    ...PRICE,
    tickmarksFormatter: (ticks: readonly number[]) => {
      const own = series.current.filter(
        (s) => s.options().priceFormat.type === "custom",
      );
      const tags: number[] = [];
      for (const s of own) {
        if (s.options().lastValueVisible) {
          const last = s.lastValueData(false);
          if (!last.noData) tags.push(last.price);
        }
        for (const p of s.priceLines()) {
          if (p.options().axisLabelVisible) tags.push(p.options().price);
        }
      }
      const first = own[0];
      return first
        ? clearOfTags(ticks, tags, (p) => first.priceToCoordinate(p))
        : ticks.map(axisPrice);
    },
  }).current;
  // the range a load was asked for, so an older answer never lands
  const asked = useRef(0);

  // the range the bars on screen were read for, which the legend names
  const shown = useSignal<Range>(kept.range);
  const since = useSignal<string | null>(null);

  const load = async () => {
    const mine = ++asked.current;
    const r = active();
    const fresh = data.value === null || r !== shown.value;
    if (fresh) reading.value = true;
    const ask: Promise<{
      history: History | Intraday;
      since: string | null;
    }> = isIntraday(r)
      ? markets
          .intraday(id, r, fromOf("Max", today()))
          .then((history) => ({ history, since: null }))
      : readRange(
          (from) => markets.history(id, from, intervalOf(r)),
          r,
          today(),
        );
    try {
      const read = await (fresh ? wait.track(ask) : ask);
      if (mine !== asked.current) return;
      batch(() => {
        data.value = read.history;
        shown.value = r;
        since.value = read.since;
        reading.value = false;
      });
      error.value = null;
      draw();
    } catch (e) {
      if (mine !== asked.current) return;
      reading.value = false;
      error.value = says(e);
      // a refresh that fails keeps its bars; another range's never stand in
      if (r !== shown.value) {
        batch(() => {
          data.value = null;
          shown.value = r;
          since.value = null;
        });
        const c = chart.current;
        if (c !== null) for (const s of series.current) c.removeSeries(s);
        series.current = [];
        levels.current = null;
        marks.value = [];
        dotsAt.current = null;
        dots.value = [];
      }
    }
  };

  // the library runs with the first chart; a page without one never starts it
  useEffect(() => {
    let gone = false;
    const el = box.current;
    // before the library's own handlers, so a move counts on its first event
    const moved = (e: PointerEvent) => {
      rest.current =
        e.type === "pointerdown"
          ? "moved"
          : pointerAt(rest.current, e.clientX, e.clientY);
    };
    const left = () => {
      rest.current = null;
    };
    el?.addEventListener("pointermove", moved, { capture: true });
    el?.addEventListener("pointerdown", moved, { capture: true });
    el?.addEventListener("pointerleave", left);
    // the canvas takes the mono face at its first draw, so it waits for it
    void Promise.all([
      import("lightweight-charts"),
      document.fonts?.load(`11px ${token("--mono")}`).catch(() => {}),
    ]).then(([l]) => {
      if (gone || box.current === null) return;
      lib.current = l;
      const paint = paintOptions(l, colors(), logScale(), look());
      const c = l.createChart(box.current, {
        ...paint,
        autoSize: true,
        crosshair: { ...paint.crosshair, mode: l.CrosshairMode.Normal },
        // the range buttons choose what shows; nothing pans or zooms it
        handleScroll: false,
        handleScale: false,
      });
      c.subscribeCrosshairMove((p: MouseEventParams) => {
        hover.value =
          rest.current !== "moved" ||
          p.time === undefined ||
          p.point === undefined
            ? null
            : typeof p.time === "number"
              ? p.time
              : dateOf(p.time);
      });
      // a resize keeps the bar spacing, which would cut the newest bars off
      c.timeScale().subscribeSizeChange(() => {
        c.timeScale().fitContent();
        placeMarks();
      });
      chart.current = c;
      draw();
    });
    return () => {
      gone = true;
      el?.removeEventListener("pointermove", moved, { capture: true });
      el?.removeEventListener("pointerdown", moved, { capture: true });
      el?.removeEventListener("pointerleave", left);
      chart.current?.remove();
      chart.current = null;
      series.current = [];
    };
  }, []);

  useEffect(() => {
    void load();
  }, [id, intraday, range.value, onPhone.value, saved]);
  // the instrument's own read pulses the menu for the page
  useRefresh(() => load(), true);

  // a theme flip, a toggle: the same bars drawn again
  useEffect(() => {
    draw();
  }, [
    theme.value,
    line.value,
    log.value,
    onPhone.value,
    sma50.value,
    sma200.value,
    trades.value,
  ]);

  function placeMarks() {
    placeDots();
    const lv = levels.current;
    if (look().axis || chart.current === null || lv === null) {
      if (marks.value.length > 0) marks.value = [];
      return;
    }
    const out: Mark[] = [];
    const put = (role: Mark["role"], v: number | null) => {
      if (v === null) return;
      const y = lv.s.priceToCoordinate(v);
      const side = role === "ref" ? "left" : "right";
      if (y !== null) out.push({ role, side, y, text: axisPrice(v) });
    };
    put("ref", lv.at.ref);
    put("high", lv.at.high);
    if (lv.at.low !== lv.at.high) put("low", lv.at.low);
    marks.value = out;
  }

  // the line's own hover marker, in the line's colour, would cover a trade's dot
  useEffect(() => {
    const d = dotsAt.current;
    if (d === null) return;
    d.s.applyOptions({
      crosshairMarkerVisible: !d.at.some((m) => m.time === hover.value),
    });
  }, [hover.value]);

  function placeDots() {
    const d = dotsAt.current;
    const c = chart.current;
    if (d === null || c === null) {
      if (dots.value.length > 0) dots.value = [];
      return;
    }
    plot.value = { w: c.timeScale().width(), h: c.paneSize(0).height };
    const out: Dot[] = [];
    for (const m of d.at) {
      const x = c.timeScale().timeToCoordinate(m.time as Time);
      const close = d.close.get(m.time);
      const y = close === undefined ? null : d.s.priceToCoordinate(close);
      if (x === null || y === null) continue;
      // a buy and a sell on one bar sit apart, the sell above
      const both = d.at.some((o) => o.time === m.time && o.side !== m.side);
      const nudge = both ? (m.side === "sell" ? -SPLIT_PX : SPLIT_PX) : 0;
      out.push({ ...m, x, y: y + nudge, month: d.month });
    }
    dots.value = out;
  }

  function draw() {
    const l = lib.current;
    const c = chart.current;
    if (l === null || c === null) return;
    const k = colors();
    // a range with no bars (a series on 5D) keeps the page's colours too
    c.applyOptions(paintOptions(l, k, logScale(), look()));
    marks.value = [];
    // the dots on screen stay until placeDots replaces them, so a redraw
    // never blinks them
    dotsAt.current = null;
    const h = data.value;
    if (h === null) {
      dots.value = [];
      return;
    }
    c.applyOptions({
      timeScale: {
        borderVisible: false,
        fixLeftEdge: true,
        fixRightEdge: true,
        rightOffset: 0,
        timeVisible: h.interval === "5m",
        tickMarkFormatter: (time: unknown, type: number) => {
          const at = typeof time === "number" ? localTime(time) : null;
          if (at !== null && type >= l.TickMarkType.Time) return at.time;
          return tick(
            at?.date ?? dateOf(time),
            type === l.TickMarkType.Year
              ? "year"
              : type === l.TickMarkType.Month
                ? "month"
                : "day",
          );
        },
      },
      localization: {
        timeFormatter: (time: unknown) =>
          timeLabel(time, undefined, navigator.language),
      },
    });
    for (const s of series.current) c.removeSeries(s);
    series.current = [];
    // every draw shows its whole range, a day its whole session
    levels.current = null;
    // coordinates settle a frame after the fit
    const fit = () => {
      c.timeScale().fitContent();
      requestAnimationFrame(placeMarks);
    };
    const refLine = (s: ISeriesApi<SeriesType>, at: Levels | null) => {
      if (look().axis || at?.ref == null) return;
      s.createPriceLine({
        price: at.ref,
        color: k.faint,
        lineWidth: 1,
        lineStyle: l.LineStyle.Dotted,
        axisLabelVisible: false,
        title: "",
      });
    };

    // up or down from where the range starts, as Yahoo colours a line
    const area = (
      values: { time: Time; value: number }[],
      base: number | null,
    ) => {
      const last = values.at(-1)?.value;
      const tone =
        base === null || last === undefined || last >= base ? k.up : k.down;
      const s = c.addSeries(l.AreaSeries, {
        lineColor: tone,
        lineWidth: 2,
        topColor: alpha(tone, 0.28),
        bottomColor: alpha(tone, 0.02),
        priceLineColor: k.faint,
        crosshairMarkerRadius: 4,
        priceFormat,
      });
      s.setData(values);
      return s;
    };

    if (h.interval === "5m") {
      const line5 = (p: readonly { at: string; close: number }[]) =>
        pointLine(p).map((v) => ({
          time: v.time as UTCTimestamp,
          value: v.value,
        }));
      const values = line5(h.points);
      const base = h.previous_close ?? values[0]?.value ?? null;
      if (base === null) {
        dots.value = [];
        return;
      }
      // 5D reads as one move, as the daily ranges do
      if (shown.value !== "1D") {
        const s = area(values, base);
        const at = levelsOf(
          base,
          values.map((v) => v.value),
        );
        if (at) levels.current = { s, at };
        refLine(s, at);
        series.current.push(s);
        fit();
        return;
      }
      // green above the previous close and red below, as a chart site draws a day
      const day = (data: typeof values, faded: boolean, latest: boolean) => {
        const f = faded ? 0.5 : 1;
        const s = c.addSeries(l.BaselineSeries, {
          baseValue: { type: "price", price: base },
          topLineColor: alpha(k.up, f),
          topFillColor1: alpha(k.up, 0.28 * f),
          topFillColor2: alpha(k.up, 0.02),
          bottomLineColor: alpha(k.down, f),
          bottomFillColor1: alpha(k.down, 0.02),
          bottomFillColor2: alpha(k.down, 0.28 * f),
          lineWidth: 2,
          priceLineVisible: latest,
          lastValueVisible: latest,
          priceLineColor: k.faint,
          crosshairMarkerRadius: 4,
          priceFormat,
          // the previous close stays in view, as its line is the base
          autoscaleInfoProvider: (own: () => AutoscaleInfo | null) => {
            const r = own();
            if (r?.priceRange == null) return r;
            return {
              ...r,
              priceRange: {
                minValue: Math.min(r.priceRange.minValue, base),
                maxValue: Math.max(r.priceRange.maxValue, base),
              },
            };
          },
        });
        s.setData(data);
        series.current.push(s);
        return s;
      };
      const { pre, post } = extendedLines(
        values,
        line5(h.extended_points ?? []).map((v, i) => ({
          ...v,
          session: h.extended_points![i]!.session,
        })),
      );
      const slots = sessionSlots(
        values.map((v) => v.time),
        h.session,
      ).map((t) => ({ time: t as UTCTimestamp }));
      const s = day(values, false, post.length === 0);
      const at = levelsOf(
        base,
        [...values, ...pre, ...post].map((v) => v.value),
      );
      if (at) levels.current = { s, at };
      if (slots.length > 0) {
        s.setData([...values, ...slots]);
        // a fixed right edge pins the last price there, pushing the slots out
        // and a little room keeps the close's label whole
        c.applyOptions({ timeScale: { fixRightEdge: false, rightOffset: 3 } });
      }
      // the day's reference only: 5D starts days before it
      if (h.previous_close !== null && shown.value === "1D") {
        s.createPriceLine({
          price: h.previous_close,
          color: k.faint,
          lineWidth: 1,
          lineStyle: l.LineStyle.Dashed,
          axisLabelVisible: true,
          axisLabelColor: k.faint,
          title: "",
        });
      }
      // pre and post trading, faded
      if (pre.length > 0) day(pre, true, false);
      if (post.length > 0) day(post, true, true);
      fit();
      return;
    }

    const live = isLive(h);
    const asCandles = candlesOn() && hasCandles(h.bars);
    let price: ISeriesApi<SeriesType>;
    if (asCandles) {
      const data = candles(h.bars).map((b, i, all) =>
        // the bar still trading is drawn hollow-light, as not final
        live && i === all.length - 1
          ? {
              ...b,
              color: alpha(b.close >= b.open ? k.up : k.down, 0.45),
              wickColor: alpha(b.close >= b.open ? k.up : k.down, 0.45),
            }
          : b,
      );
      price = c.addSeries(l.CandlestickSeries, {
        upColor: k.up,
        downColor: k.down,
        wickUpColor: k.up,
        wickDownColor: k.down,
        borderVisible: false,
        priceLineColor: k.faint,
        priceFormat,
      });
      price.setData(data);
      const at = levelsOf(
        data[0]?.close ?? null,
        data.map((b) => b.high),
        data.map((b) => b.low),
      );
      if (at) levels.current = { s: price, at };
    } else {
      const values = closes(h.bars);
      price = area(values, values[0]?.value ?? null);
      const at = levelsOf(
        values[0]?.value ?? null,
        values.map((v) => v.value),
      );
      if (at) levels.current = { s: price, at };
    }
    refLine(price, levels.current?.at ?? null);
    series.current.push(price);
    // a line shows the owner's trades and candles the volume; a line
    // with no trades keeps the volume
    const times = h.bars.map((b) => b.date);
    const month = MONTHLY_SHARES.includes(shown.value);
    const at = asCandles
      ? []
      : month
        ? monthlyShares(times, trades.value)
        : tradeMarks(times, trades.value);
    // a range with none of the owner's trades keeps its volume
    const withTrades = at.length > 0;
    if (withTrades) {
      dotsAt.current = {
        s: price,
        month,
        at,
        close: new Map(
          closes(h.bars).map((v) => [String(v.time), v.value] as const),
        ),
      };
      // a redraw under a resting pointer keeps the dot clear too
      price.applyOptions({
        crosshairMarkerVisible: !at.some((m) => m.time === hover.value),
      });
    }

    const avg = (key: "sma50" | "sma200", color: string) => {
      const s = c.addSeries(l.LineSeries, {
        color,
        lineWidth: 2,
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerVisible: false,
        priceFormat,
      });
      s.setData(averages(h.bars, key));
      series.current.push(s);
    };
    if (show50()) avg("sma50", k.sma50);
    if (show200()) avg("sma200", k.sma200);

    // under a line: the shares bought up and sold down, where the volume was
    if (withTrades && look().volume && dotsAt.current !== null) {
      const sized = {
        type: "custom" as const,
        minMove: 0.0001,
        formatter: (v: number) =>
          v > 0
            ? `+${briefQuantity(v)}`
            : v < 0
              ? `−${briefQuantity(-v)}`
              : "0",
      };
      const bars = dotsAt.current.at;
      const sold = bars.some((m) => m.side === "sell");
      const bought = bars.some((m) => m.side === "buy");
      for (const side of ["buy", "sell"] as const) {
        const at = bars.filter((m) => m.side === side);
        if (at.length === 0) continue;
        const q = c.addSeries(
          l.HistogramSeries,
          {
            priceFormat: sized,
            priceLineVisible: false,
            lastValueVisible: false,
            color: side === "buy" ? k.buy : k.down,
          },
          1,
        );
        q.setData(
          at.map((m) => ({
            time: m.time as Time,
            value: side === "buy" ? m.quantity : -m.quantity,
          })),
        );
        // room past the longest bar, so the scale's end label is whole
        q.priceScale().applyOptions({
          scaleMargins: {
            top: bought ? 0.3 : 0.1,
            bottom: sold ? 0.3 : 0.1,
          },
        });
        series.current.push(q);
      }
      c.panes()[0]?.setStretchFactor(4);
      c.panes()[1]?.setStretchFactor(1);
    }
    if (hasVolume(h.bars) && look().volume && !withTrades) {
      const v = c.addSeries(
        l.HistogramSeries,
        {
          priceFormat: { type: "volume" },
          priceLineVisible: false,
          lastValueVisible: false,
        },
        1,
      );
      v.setData(
        volumes(h.bars).map((b) => ({
          time: b.time,
          value: b.value,
          color: alpha(b.up ? k.up : k.down, 0.5),
        })),
      );
      // room over the tallest bar, so the scale's top label is whole
      v.priceScale().applyOptions({ scaleMargins: { top: 0.25, bottom: 0 } });
      series.current.push(v);
      // a redraw makes the pane anew: the share holds where a height
      // would reset
      c.panes()[0]?.setStretchFactor(4);
      c.panes()[1]?.setStretchFactor(1);
    }
    fit();
  }

  const h = data.value;
  const legend =
    h === null
      ? null
      : h.interval === "5m"
        ? pointLegendOf(h, typeof hover.value === "number" ? hover.value : null)
        : legendOf(h, typeof hover.value === "string" ? hover.value : null);
  // what the legend can hold changes with the averages shown and the
  // bars' kind: then the held height starts again
  const shape =
    h === null
      ? "loading"
      : h.interval === "5m"
        ? "points"
        : `${show50()}${show200()}${look().ohlc && hasCandles(h.bars)}`;
  useLayoutEffect(() => {
    const box = legendBox.current;
    if (box === null) return;
    if (tallest.current.shape !== shape) {
      tallest.current = { shape, px: 0 };
      box.style.minHeight = "";
    }
    const px = box.offsetHeight;
    if (px > tallest.current.px) {
      tallest.current.px = px;
      box.style.minHeight = `${px}px`;
    }
  });
  const minutes = isIntraday(active());
  const lk = look();
  const candlesOk =
    lk.candles &&
    !minutes &&
    h !== null &&
    h.interval !== "5m" &&
    hasCandles(h.bars);
  const linesOk = lk.log || (lk.averages && !minutes);
  return (
    <ChartFrame
      head={
        <>
          <div class="chart-ranges">
            <Segmented
              small
              label="Range"
              options={rangesOf(lk, intraday).map((r) => ({
                value: r,
                text: r,
              }))}
              value={active()}
              onPick={(r) => {
                range.value = r;
              }}
            />
          </div>
          {(candlesOk || linesOk) && (
            <div class="chart-tools">
              {candlesOk && (
                <Segmented
                  small
                  label="Style"
                  options={[
                    { value: "line", text: "Line" },
                    { value: "candles", text: "Candles" },
                  ]}
                  value={line.value ? "line" : "candles"}
                  onPick={(v) => {
                    line.value = v === "line";
                  }}
                />
              )}
              {lk.averages && !minutes && (
                <fieldset class="seg seg-small" aria-label="Averages">
                  <button
                    type="button"
                    class={`seg-option chart-toggle-50${sma50.value ? " seg-on" : ""}`}
                    aria-pressed={sma50.value}
                    onClick={() => {
                      sma50.value = !sma50.value;
                    }}
                  >
                    50
                  </button>
                  <button
                    type="button"
                    class={`seg-option chart-toggle-200${sma200.value ? " seg-on" : ""}`}
                    aria-pressed={sma200.value}
                    onClick={() => {
                      sma200.value = !sma200.value;
                    }}
                  >
                    200
                  </button>
                </fieldset>
              )}
              {lk.log && (
                <fieldset class="seg seg-small" aria-label="Scale">
                  <button
                    type="button"
                    class={`seg-option${log.value ? " seg-on" : ""}`}
                    aria-pressed={log.value}
                    onClick={() => {
                      log.value = !log.value;
                    }}
                  >
                    Log
                  </button>
                </fieldset>
              )}
            </div>
          )}
        </>
      }
      // a read that failed says so over the bars still shown
      note={error.value !== null && <p class="chart-note">{error.value}</p>}
      legendRef={legendBox}
      legend={
        legend !== null &&
        h !== null &&
        !reading.value && (
          <LegendLine
            legend={legend}
            interval={h.interval}
            range={shown.value}
            since={since.value}
            show={{
              sma50: show50(),
              sma200: show200(),
              ohlc: look().ohlc,
            }}
          />
        )
      }
      canvasRef={box}
      wait={
        reading.value && (
          <WaitWords show={wait.slow.value}>Loading the chart</WaitWords>
        )
      }
    >
      {!reading.value &&
        marks.value.map((m) => (
          <span
            key={m.role}
            class={`chart-mark chart-mark-${m.side}`}
            style={{ top: `${m.y}px` }}
          >
            {m.text}
          </span>
        ))}
      {!reading.value && dots.value.length > 0 && plot.value !== null && (
        <div
          class="chart-trades"
          style={{ width: `${plot.value.w}px`, height: `${plot.value.h}px` }}
        >
          {dots.value.map((d) => (
            <span
              key={`${d.time} ${d.side}`}
              class={`chart-trade chart-trade-${d.side}`}
              style={{ left: `${d.x}px`, top: `${d.y}px` }}
              role="img"
              aria-label={tradeText(d)}
            />
          ))}
        </div>
      )}
      {/* the hovered bar's trades, beside their marks */}
      {!reading.value &&
        plot.value !== null &&
        (() => {
          const on = dots.value.filter((d) => d.time === hover.value);
          const top = on.reduce<Dot | null>(
            (a, d) => (a === null || d.y < a.y ? d : a),
            null,
          );
          if (top === null) return null;
          return (
            <span
              class={`chart-trade-tip${top.x > plot.value.w / 2 ? " chart-trade-tip-left" : ""}`}
              style={{ left: `${top.x}px`, top: `${top.y}px` }}
            >
              {on.map((d) => (
                <span key={d.side}>{tradeText(d)}</span>
              ))}
            </span>
          );
        })()}
    </ChartFrame>
  );
}
