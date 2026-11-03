// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// The hero's quiet line of the holdings' growth over the past year, and
// the fit that keeps the figure whole beside it.

import type { RefObject } from "preact";
import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "preact/hooks";
import type {
  Growth,
  Holdings,
  PortfolioStore,
  TradeRow,
  View,
} from "../data/portfolios.ts";
import { money } from "../lib/format.ts";
import {
  type Drawn,
  FIT_START,
  type Fit,
  growthKey,
  growthPath,
  growthScope,
  growthShown,
  growthWords,
  heroFit,
  lineWidth,
  sameFit,
  shortMoney,
} from "./PortfolioGrowth.model.ts";
import "./portfolio-growth.css";

// as the stylesheets' phone width
const PHONE_WIDTH = "(max-width: 719px)";

// the path's own box, stretched to the slot
const BOX_W = 300;
const BOX_H = 64;

export type ViewGrowth = {
  // null while it is read and nothing of its view is drawn
  series: Growth | null;
  // drawn for the first time: it fades in; a series seen before does not
  fade: boolean;
  // no line and no slot: the read failed or held under two days
  none: boolean;
};

// the series is read from the cache in the render, so a tab picked never
// draws the last tab's line, not even for a frame. A save keeps the view
// and currency: its last line stays drawn until the new one swaps in
export function useGrowth(
  store: PortfolioStore,
  view: View,
  trades: readonly TradeRow[],
  h: Holdings,
  wanted: boolean,
): ViewGrowth {
  const key = growthKey(view, trades, h);
  const scope = growthScope(view, h);
  const got = wanted ? store.growths.value.get(key) : undefined;
  const drawn = useRef<Drawn | null>(null);
  const shown = growthShown(got, drawn.current, scope);
  const seen = useRef<{ key: string; cached: boolean } | null>(null);
  if (seen.current?.key !== key)
    seen.current = { key, cached: got !== undefined || shown.held };
  if (got) drawn.current = { scope, series: got };
  useEffect(() => {
    if (wanted) void store.growth(view, key);
  }, [key, wanted]);
  return {
    series: shown.series,
    fade: !seen.current.cached,
    none: shown.none,
  };
}

// the hero's figure; a short one keeps the full figure in its title
export function HeroFigure({
  value,
  currency,
  short,
}: {
  value: number | null;
  currency: string;
  short: boolean;
}) {
  if (!short) return <>{money(value, null)}</>;
  return <span title={money(value, currency)}>{shortMoney(value)}</span>;
}

// the slot holds the line's place while it is read, so the hero never
// grows when it lands
export function GrowthLine({ growth }: { growth: ViewGrowth }) {
  const id = useId();
  const g = growth.series;
  const path = useMemo(() => (g ? growthPath(g, BOX_W, BOX_H) : null), [g]);
  if (g === null || path === null)
    return <div class="growth" aria-hidden="true" />;
  const words = growthWords(g);
  return (
    <div
      class={`growth${growth.fade ? " growth-fade" : ""}`}
      title={words.title}
    >
      <svg
        viewBox={`0 0 ${BOX_W} ${BOX_H}`}
        preserveAspectRatio="none"
        class={`growth-svg ${path.up ? "growth-up" : "growth-down"}`}
        role="img"
        aria-label={words.title}
      >
        <defs>
          <linearGradient id={id} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" class="growth-top" />
            <stop offset="100%" class="growth-bottom" />
          </linearGradient>
        </defs>
        <path d={path.area} fill={`url(#${id})`} />
        <path d={path.line} class="growth-line" />
      </svg>
      <span class="growth-label">{words.label}</span>
    </div>
  );
}

// measured before the first paint, again once the fonts land (their
// widths, not a fallback's) and on every resize
export function useHeroFit(
  box: RefObject<HTMLElement | null>,
  figure: string,
  brief: string,
  line: boolean,
): Fit {
  const [fit, setFit] = useState<Fit>(FIT_START);
  const last = useRef(fit);
  useLayoutEffect(() => {
    const el = box.current;
    const ctx = document.createElement("canvas").getContext("2d");
    if (!el || !ctx) return;
    let on = true;
    const measure = () => {
      const value = el.querySelector<HTMLElement>(".hero-value");
      if (!on || !value) return;
      const phone = matchMedia(PHONE_WIDTH).matches;
      const display = Number.parseFloat(
        getComputedStyle(document.documentElement).getPropertyValue(
          phone ? "--text-display-phone" : "--text-display",
        ),
      );
      const face = getComputedStyle(value);
      ctx.font = `${face.fontWeight} ${display}px ${face.fontFamily}`;
      // the figure's letter spacing is left out of measureText
      const text = (s: string) => ctx.measureText(s).width * 1.02;
      const ccy = el.querySelector<HTMLElement>(".hero-ccy");
      const currency = ccy
        ? ccy.getBoundingClientRect().width +
          Number.parseFloat(getComputedStyle(ccy).marginLeft || "0")
        : 0;
      const width = el.clientWidth;
      const next = heroFit(
        {
          width,
          figure: text(figure),
          brief: text(brief),
          currency,
          line: line ? lineWidth(width, phone) : 0,
          display,
        },
        last.current,
      );
      if (sameFit(next, last.current)) return;
      last.current = next;
      setFit(next);
    };
    measure();
    void document.fonts?.ready.then(measure);
    const resized = new ResizeObserver(measure);
    resized.observe(el);
    return () => {
      on = false;
      resized.disconnect();
    };
  }, [figure, brief, line]);
  return fit;
}
