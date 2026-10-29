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
import { useEffect, useLayoutEffect, useRef } from "preact/hooks";
import { theme } from "../app/theme.ts";
import { says } from "../data/api.ts";
import { markets } from "../data/store.ts";
import { useRefresh } from "../lib/refresh.ts";
import {
  averageLabel,
  averages,
  axisPrice,
  candles,
  changeText,
  closes,
  dayOf,
  extendedLines,
  figure,
  fromOf,
  type History,
  hasCandles,
  hasVolume,
  type Intraday,
  intervalOf,
  isIntraday,
  isLive,
  type Legend,
  legendOf,
  localTime,
  pointLegendOf,
  pointLine,
  RANGES,
  type Range,
  readSettings,
  type Settings,
  sessionSlots,
  tick,
  timeLabel,
  volumes,
  volumeText,
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

function colors() {
  return {
    card: token("--card"),
    fg: token("--fg"),
    faint: token("--faint"),
    line: token("--line"),
    up: token("--done"),
    down: token("--failed"),
    sma50: token("--chart-sma50"),
    sma200: token("--chart-sma200"),
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
) {
  return {
    layout: {
      background: { type: l.ColorType.Solid, color: k.card },
      textColor: k.faint,
      fontFamily: k.font,
      fontSize: 11,
      attributionLogo: false,
      panes: { separatorColor: k.line, separatorHoverColor: k.line },
    },
    grid: {
      vertLines: { visible: false },
      horzLines: { color: alpha(k.line, 0.7) },
    },
    rightPriceScale: {
      borderVisible: false,
      scaleMargins: { top: 0.1, bottom: 0.04 },
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
  show,
}: {
  legend: Legend;
  interval: History["interval"] | Intraday["interval"];
  range: Range;
  show: { sma50: boolean; sma200: boolean };
}) {
  const dir =
    legend.change === null || Math.abs(legend.change) < 0.005
      ? ""
      : legend.change > 0
        ? " chart-up"
        : " chart-down";
  return (
    <div class="chart-legend">
      <span class="chart-legend-row">
        <span class="chart-date">
          {dayOf(legend.date)}
          {legend.time !== undefined && ` ${legend.time}`}
        </span>
        {legend.live && <span class="chart-live">Live</span>}
        {legend.open !== null && (
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
          <i>C</i> {figure(legend.close)}
        </span>
        {legend.volume !== null && (
          <span>
            <i>Vol</i> {volumeText(legend.volume)}
          </span>
        )}
        {legend.change !== null && (
          <span class={`chart-change${dir}`}>
            <i>{range}</i> {changeText(legend.change, legend.points)}
          </span>
        )}
      </span>
      {interval !== "5m" && (
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

export function Chart({ id }: { id: string }) {
  const box = useRef<HTMLDivElement>(null);
  const legendBox = useRef<HTMLDivElement>(null);
  const tallest = useRef({ shape: "", px: 0 });
  const kept = useRef(loadSettings()).current;
  const range = useSignal<Range>(kept.range);
  const data = useSignal<History | Intraday | null>(null);
  const error = useSignal<string | null>(null);
  const line = useSignal(kept.line);
  const log = useSignal(kept.log);
  const sma50 = useSignal(kept.sma50);
  const sma200 = useSignal(kept.sma200);
  useEffect(() => {
    saveSettings({
      range: range.value,
      line: line.value,
      log: log.value,
      sma50: sma50.value,
      sma200: sma200.value,
    });
  }, [range.value, line.value, log.value, sma50.value, sma200.value]);
  const hover = useSignal<string | number | null>(null);
  const lib = useRef<Lib | null>(null);
  const chart = useRef<IChartApi | null>(null);
  const series = useRef<ISeriesApi<SeriesType>[]>([]);
  // the range a load was asked for, so an older answer never lands
  const asked = useRef(0);

  // the range the bars on screen were read for, which the legend names
  const shown = useSignal<Range>(kept.range);

  const load = async () => {
    const mine = ++asked.current;
    const r = range.value;
    try {
      const h = isIntraday(r)
        ? await markets.intraday(id, r, fromOf("Max", today()))
        : await markets.history(id, fromOf(r, today()), intervalOf(r));
      if (mine !== asked.current) return;
      batch(() => {
        data.value = h;
        shown.value = r;
      });
      error.value = null;
      draw();
    } catch (e) {
      if (mine !== asked.current) return;
      error.value = says(e);
      // a refresh that fails keeps its bars; another range's never stand in
      if (r !== shown.value) {
        batch(() => {
          data.value = null;
          shown.value = r;
        });
        const c = chart.current;
        if (c !== null) for (const s of series.current) c.removeSeries(s);
        series.current = [];
      }
    }
  };

  // the library runs with the first chart; a page without one never starts it
  useEffect(() => {
    let gone = false;
    void import("lightweight-charts").then((l) => {
      if (gone || box.current === null) return;
      lib.current = l;
      const paint = paintOptions(l, colors(), log.value);
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
          p.time === undefined || p.point === undefined
            ? null
            : typeof p.time === "number"
              ? p.time
              : dateOf(p.time);
      });
      // a resize keeps the bar spacing, which would cut the newest bars off
      c.timeScale().subscribeSizeChange(() => c.timeScale().fitContent());
      chart.current = c;
      draw();
    });
    return () => {
      gone = true;
      chart.current?.remove();
      chart.current = null;
      series.current = [];
    };
  }, []);

  useEffect(() => {
    void load();
  }, [id, range.value]);
  useRefresh(() => load());

  // a theme flip, a toggle: the same bars drawn again
  useEffect(() => {
    draw();
  }, [theme.value, line.value, log.value, sma50.value, sma200.value]);

  function draw() {
    const l = lib.current;
    const c = chart.current;
    if (l === null || c === null) return;
    const k = colors();
    // a range with no bars (a series on 5D) keeps the page's colours too
    c.applyOptions(paintOptions(l, k, log.value));
    const h = data.value;
    if (h === null) return;
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
    const fit = () => c.timeScale().fitContent();

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
        priceFormat: PRICE,
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
      if (base === null) return;
      // 5D reads as one move, as the daily ranges do
      if (shown.value !== "1D") {
        series.current.push(area(values, base));
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
          priceFormat: PRICE,
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
    const asCandles = !line.value && hasCandles(h.bars);
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
        priceFormat: PRICE,
      });
      price.setData(data);
    } else {
      const values = closes(h.bars);
      price = area(values, values[0]?.value ?? null);
    }
    series.current.push(price);

    const avg = (key: "sma50" | "sma200", color: string) => {
      const s = c.addSeries(l.LineSeries, {
        color,
        lineWidth: 2,
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerVisible: false,
        priceFormat: PRICE,
      });
      s.setData(averages(h.bars, key));
      series.current.push(s);
    };
    if (sma50.value) avg("sma50", k.sma50);
    if (sma200.value) avg("sma200", k.sma200);

    if (hasVolume(h.bars)) {
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
        : `${sma50.value}${sma200.value}${hasCandles(h.bars)}`;
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
  const intraday = isIntraday(range.value);
  const candlesOk =
    !intraday && h !== null && h.interval !== "5m" && hasCandles(h.bars);
  return (
    <section class="card chart-card" aria-label="Chart">
      <div class="chart-head">
        <fieldset class="seg seg-small chart-ranges" aria-label="Range">
          {RANGES.map((r) => (
            <button
              key={r}
              type="button"
              class={`seg-option${range.value === r ? " seg-on" : ""}`}
              aria-pressed={range.value === r}
              onClick={() => {
                range.value = r;
              }}
            >
              {r}
            </button>
          ))}
        </fieldset>
        <div class="chart-tools">
          {candlesOk && (
            <fieldset class="seg seg-small" aria-label="Style">
              <button
                type="button"
                class={`seg-option${line.value ? " seg-on" : ""}`}
                aria-pressed={line.value}
                onClick={() => {
                  line.value = true;
                }}
              >
                Line
              </button>
              <button
                type="button"
                class={`seg-option${!line.value ? " seg-on" : ""}`}
                aria-pressed={!line.value}
                onClick={() => {
                  line.value = false;
                }}
              >
                Candles
              </button>
            </fieldset>
          )}
          <fieldset class="seg seg-small" aria-label="Lines">
            {!intraday && (
              <>
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
              </>
            )}
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
        </div>
      </div>
      <div class="chart-body">
        {/* a read that failed says so over the bars still shown */}
        {error.value !== null && <p class="chart-note">{error.value}</p>}
        {/* holds the tallest the legend has been, so the plot never
            moves as the crosshair changes its rows */}
        <div class="chart-legend-box" ref={legendBox}>
          {legend !== null && h !== null ? (
            <LegendLine
              legend={legend}
              interval={h.interval}
              range={shown.value}
              show={{ sma50: sma50.value, sma200: sma200.value }}
            />
          ) : (
            // a first guess at its room before the first answer
            <div class="chart-legend chart-legend-wait" aria-hidden="true" />
          )}
        </div>
        <div class="chart-canvas" ref={box} />
      </div>
    </section>
  );
}
