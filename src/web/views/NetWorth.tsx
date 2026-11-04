// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// Home's Wealth tab: the Portfolios hero over every holding and all cash,
// its figure, moves, split bar and a line of net worth itself.

import { useLayoutEffect, useMemo, useRef } from "preact/hooks";
import { PORTFOLIOS_PAGE, type Total, type Worth } from "../data/portfolios.ts";
import { markets } from "../data/store.ts";
import { money, percent, signedMoney } from "../lib/format.ts";
import { useRefresh } from "../lib/refresh.ts";
import { Hero, type Move } from "../ui/Figures.tsx";
import { Placeholder } from "../ui/Placeholder.tsx";
import {
  cashHref,
  dayPercent,
  keptSeries,
  linePoints,
  pointsOf,
  SHAPE_KEY,
  shapeOf,
  totalOf,
  worthWords,
} from "./NetWorth.model.ts";
import { shortMoney, WORTH_PAD } from "./PortfolioGrowth.model.ts";
import { HeroFigure, HeroLine, useHeroFit } from "./PortfolioGrowth.tsx";
import { barOf } from "./Portfolios.model.ts";
import "./portfolios.css";
import "./net-worth.css";

function readShape(): readonly number[] {
  try {
    return shapeOf(localStorage.getItem(SHAPE_KEY));
  } catch {
    return shapeOf(null);
  }
}
function keepShape(widths: number[]) {
  try {
    localStorage.setItem(SHAPE_KEY, JSON.stringify(widths));
  } catch {}
}

function Band({ w, t }: { w: Worth; t: Total }) {
  const value = t.net_worth ?? null;
  const points = useMemo(
    () => linePoints(pointsOf(w.series, t)),
    [w.series, t],
  );
  const line = points.length >= 2;
  const box = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const items = box.current?.querySelectorAll(".pf-ivc-legend > span");
    if (items && items.length > 0)
      keepShape(
        [...items].map((e) => Math.ceil(e.getBoundingClientRect().width)),
      );
  });
  const fit = useHeroFit(box, money(value, null), shortMoney(value), line);
  const moves: Move[] = [
    {
      money: signedMoney(t.day_change, t.currency),
      percent: percent(dayPercent(t)),
      label: "today",
      moneyClass: "amount",
    },
    {
      money: signedMoney(t.pl, t.currency),
      percent: percent(t.pl_percent),
      label: "all time",
      moneyClass: "amount",
    },
  ];
  // net worth's split: what is invested against all cash, reserve too
  const bar = barOf(t, false);
  const cash = cashHref(w);
  const href = (key: string) => (key === "cash" ? cash : PORTFOLIOS_PAGE);
  return (
    <div
      ref={box}
      class={[
        "pf-hero nw-hero",
        line && fit.line === "beside" ? "pf-hero-beside" : "",
        fit.line === "under" ? "pf-hero-under" : "",
        fit.size !== null ? "pf-hero-fitted" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      style={fit.size !== null ? { "--hero-size": `${fit.size}px` } : undefined}
    >
      <Hero
        value={
          <a href={PORTFOLIOS_PAGE} class="nw-link">
            <HeroFigure value={value} currency={t.currency} short={fit.short} />
          </a>
        }
        valueClass="amount"
        currency={t.currency}
        moves={moves}
      >
        {line && (
          <HeroLine
            points={points}
            words={worthWords(points)}
            fade={true}
            pad={WORTH_PAD}
          />
        )}
        {bar && (
          <div class="pf-ivc">
            <div
              class="pf-ivc-bar"
              role="img"
              aria-label={bar.map((x) => `${x.label} ${x.pct}%`).join(", ")}
            >
              {bar.map((x) => (
                <span
                  key={x.key}
                  class={`pf-ivc-${x.key}`}
                  style={{ flexGrow: x.value }}
                />
              ))}
            </div>
            <div class="small pf-ivc-legend">
              {bar.map((x) => (
                <span key={x.key}>
                  <a href={href(x.key)} class="nw-link">
                    <i class={`pf-ivc-${x.key}`} />
                    <span class="faint">{x.label}</span>{" "}
                    <span class="num amount">{money(x.value, t.currency)}</span>{" "}
                    <span class="num faint">{x.pct}%</span>
                  </a>
                </span>
              ))}
            </div>
          </div>
        )}
      </Hero>
    </div>
  );
}

// laid out as the loaded band, item for item and at each item's width, so
// it wraps where the band wraps and nothing moves when the band lands
const zw = <span class="num">{"\u200b"}</span>;
export function WorthWaiting() {
  return (
    <div class="pf-hero nw-hero pf-hero-beside">
      <Hero
        value={
          <>
            {"\u200b"}
            <Placeholder chars={7} />
          </>
        }
        currency={"\u200b"}
        lines={[
          <div key="moves" class="hero-moves nw-wait-moves">
            <span>
              {zw}
              <Placeholder chars={23} />
            </span>
            <span>
              {zw}
              <Placeholder chars={28} />
            </span>
          </div>,
        ]}
      >
        <div class="growth" aria-hidden="true" />
        <div class="pf-ivc">
          <div class="pf-ivc-bar nw-bar-waiting" />
          <div class="small pf-ivc-legend">
            {readShape().map((w, i) => (
              <span key={i} style={{ width: `${w}px` }}>
                {zw}
                <span class="placeholder" style={{ width: "100%" }} />
              </span>
            ))}
          </div>
        </div>
      </Hero>
    </div>
  );
}

// read again only while Wealth is the tab shown
const refresh = () => markets.portfolios.loadWorth(keptSeries);

export function NetWorthPanel() {
  const store = markets.portfolios;
  useRefresh(refresh, true);
  const w = store.worth.value;
  if (w === null && store.worthFailed.value)
    return <p class="nw-failed faint">Could not load net worth.</p>;
  const t = w === null ? null : totalOf(w);
  return (
    <div class="nw-panel">
      {w === null || t === null ? <WorthWaiting /> : <Band w={w} t={t} />}
    </div>
  );
}
